/**
 * Bilan hebdomadaire d'un clan, publié dans son QG.
 *
 * Le salon de QG ne recevait rien du bot entre deux saisons - donc pendant des mois - alors
 * que le journal des contributions a de quoi raconter chaque semaine : qui a porté le clan,
 * d'où viennent les points, et si la place au classement a bougé.
 *
 * C'est un salon de discussion, pas un tableau de bord. Le bilan y est donc publié une fois
 * par semaine et jamais réécrit : un message qui se met à jour se perdrait dans la
 * conversation, et republier après un redémarrage y laisserait deux rapports à la suite.
 */

import { EmbedBuilder, type Client, type Guild as DiscordGuild } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildTimezone } from '../../utils/timezone.js';
import { joinFieldEntries } from '../../utils/embeds.js';
import {
  summarizeClanWeek,
  weekPosition,
  DIGEST_WINDOW_DAYS,
  type ClanWeekStats,
} from './clanDigestPolicy.js';

const SOURCE_LABELS: Record<string, string> = {
  XP: 'Progression',
  ADMIN: 'Attribué par le staff',
  DROP: 'Drops',
  RPG: 'RPG',
};

/**
 * Lit le journal de la période et le total de saison, puis délègue le calcul aux règles.
 *
 * Les deux lectures sont séparées à dessein : les points de la semaine viennent du journal
 * des mouvements, le classement du total agrégé par membre - c'est celui que le reste du
 * module affiche, et le bilan ne doit pas raconter un autre classement que la page.
 */
async function readClanWeek(guildId: string, season: number, clanIds: string[], since: Date) {
  const [weekEvents, seasonTotals] = await Promise.all([
    prisma.clanContributionEvent.findMany({
      where: { guildId, season, clanId: { in: clanIds }, createdAt: { gte: since } },
      select: { clanId: true, userId: true, amount: true, source: true },
    }),
    prisma.clanMemberContribution.groupBy({
      by: ['clanId'],
      where: { guildId, season, clanId: { in: clanIds } },
      _sum: { xp: true },
    }),
  ]);

  const totals = new Map(seasonTotals.map((row) => [row.clanId, row._sum.xp ?? 0]));
  return summarizeClanWeek(clanIds, weekEvents, totals);
}

/** Flèche de progression au classement, ou rien quand la place n'a pas bougé. */
function rankMove(stats: ClanWeekStats): string {
  const gained = stats.previousRank - stats.rank;
  if (gained === 0) return '';
  return gained > 0 ? ` (▲ ${gained})` : ` (▼ ${Math.abs(gained)})`;
}

function buildDigestEmbed(clanName: string, stats: ClanWeekStats, weekKey: string, total: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Bilan de la semaine - ${clanName}`)
    .setDescription(`Semaine du ${weekKey} · solde de **${stats.points.toLocaleString('fr-FR')}** points`)
    .setColor(0x6366F1)
    .addFields({
      name: 'Classement',
      value: `**${stats.rank}${stats.rank === 1 ? 'er' : 'e'}** sur ${total}${rankMove(stats)}`,
      inline: true,
    })
    .setTimestamp();

  if (stats.contributors.length > 0) {
    embed.addFields({
      name: 'Ils ont porté le clan',
      value: joinFieldEntries(
        stats.contributors.map((entry, index) => `**${index + 1}.** <@${entry.userId}> · ${entry.points.toLocaleString('fr-FR')}`),
        { more: (count) => `… et ${count} autres` },
      ),
    });
  }

  if (stats.bySource.length > 0) {
    embed.addFields({
      name: 'D\'où viennent les points',
      value: stats.bySource
        .map((entry) => `${SOURCE_LABELS[entry.source] ?? entry.source} · ${entry.points.toLocaleString('fr-FR')}`)
        .join('\n'),
    });
  }

  return embed;
}

/**
 * Publie le bilan d'un clan, et rend faux si le QG n'a rien reçu.
 *
 * Le marquage précède l'envoi : au pire le bilan d'une semaine manque, jamais deux ne se
 * suivent dans la conversation après une reprise du cycle.
 */
async function publishClanDigest(
  discordGuild: DiscordGuild,
  clan: { id: string; guildId: string; name: string; generalChannelId: string | null },
  stats: ClanWeekStats,
  weekKey: string,
  total: number,
): Promise<boolean> {
  if (!clan.generalChannelId) return false;

  // Le salon est résolu avant le marquage, à l'inverse de l'annonce du raid : là-bas une
  // tentative perdue coûte une minute, ici elle coûterait la semaine. Un QG injoignable ce
  // matin repassera donc à l'heure suivante, sans avoir consommé son bilan.
  const channel = discordGuild.channels.cache.get(clan.generalChannelId)
    ?? await discordGuild.channels.fetch(clan.generalChannelId).catch(() => null);

  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('ClanDigest', `QG injoignable pour le clan ${clan.name} (${clan.guildId}).`);
    return false;
  }

  // Une fois le salon joignable, le marquage précède l'envoi : au pire un bilan manque,
  // jamais deux ne se suivent dans la conversation après une reprise du cycle.
  //
  // `createMany` plutôt que `create` : deux cycles qui se chevauchent se départagent ici, et
  // le perdant repart sans avoir fait remonter une violation d'unicité dans les logs.
  const marked = await prisma.clanWeeklyDigest.createMany({
    data: [{ guildId: clan.guildId, clanId: clan.id, weekKey }],
    skipDuplicates: true,
  });
  // Unicité `clanId + weekKey` : le bilan est déjà parti cette semaine.
  if (marked.count === 0) return false;

  // Aucune mention : le bilan arrive au milieu d'une conversation, il s'y ajoute sans
  // interrompre personne.
  await channel.send({
    embeds: [buildDigestEmbed(clan.name, stats, weekKey, total)],
    allowedMentions: { parse: [] },
  });

  return true;
}

async function publishGuildDigest(client: Client, guildId: string, season: number): Promise<void> {
  const timezone = await resolveGuildTimezone(guildId);
  const { weekKey, tooEarly } = weekPosition(timezone, new Date());
  if (tooEarly) return;

  const clans = await prisma.clan.findMany({
    where: { guildId },
    select: { id: true, guildId: true, name: true, generalChannelId: true },
    orderBy: { name: 'asc' },
  });
  if (clans.length === 0) return;

  // Les clans déjà servis sont écartés nommément plutôt que comptés : un clan sans activité
  // ne reçoit pas de bilan, donc le compte restait sous le nombre de QG toute la semaine et
  // le cycle horaire repassait sur les clans déjà servis pour s'y faire refuser l'insertion.
  const published = new Set(
    (await prisma.clanWeeklyDigest.findMany({
      where: { guildId, weekKey },
      select: { clanId: true },
    })).map((row) => row.clanId),
  );
  // Rien à publier si la semaine est déjà couverte partout : on s'arrête avant de compter.
  if (clans.every((clan) => !clan.generalChannelId || published.has(clan.id))) return;

  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const stats = await readClanWeek(guildId, season, clans.map((clan) => clan.id), since);

  for (const clan of clans) {
    if (published.has(clan.id)) continue;

    const clanStats = stats.get(clan.id);
    if (!clanStats) continue;

    // Un clan sans le moindre mouvement n'a rien à lire : `bySource` est vide quand aucun
    // événement n'a été enregistré. Publier « solde de 0 » chaque lundi dans un salon de
    // discussion est le meilleur moyen de faire couper les notifications du bot. Le bilan
    // partira dès qu'il y aura quelque chose à dire, cette semaine-là.
    if (clanStats.bySource.length === 0) continue;

    await publishClanDigest(discordGuild, clan, clanStats, weekKey, clans.length)
      .catch((error: unknown) => {
        logger.error('ClanDigest', `Bilan non publié pour le clan ${clan.name}:`, error);
        return false;
      });
  }
}

/**
 * Publie le bilan de la semaine sur tous les serveurs qui l'ont activé.
 *
 * Le cycle tourne toutes les heures et non une fois par semaine : un serveur dont le bot
 * dormait le lundi matin recevrait sinon un bilan de moins, et l'heure de parution suit le
 * fuseau de chaque serveur plutôt qu'un lundi commun en UTC.
 */
export async function runClanWeeklyDigests(client: Client): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { clansEnabled: true, clanWeeklyDigest: true },
    select: { id: true, currentClanSeason: true },
  });

  for (const guild of guilds) {
    try {
      await publishGuildDigest(client, guild.id, guild.currentClanSeason);
    } catch (error) {
      logger.error('ClanDigest', `Bilan hebdomadaire en échec pour ${guild.id}:`, error);
    }
  }
}
