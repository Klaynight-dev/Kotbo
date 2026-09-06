/**
 * Affichage Discord du raid : annonce, barre de progression et bilan.
 *
 * Le message d'annonce est réécrit par le cycle, une fois par minute, et non à chaque
 * assaut : une équipe de vingt personnes qui frappent ensemble produirait autant d'éditions
 * en quelques secondes, et Discord finirait par les refuser. Une minute de retard sur une
 * barre de progression ne se voit pas ; un message figé par une limite de débit, si.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  type Client,
} from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS, joinFieldEntries } from '../../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';
import { getOrCreateEconomyConfig } from '../economyService.js';
import type { RaidAttackOutcome } from './rpgRaidService.js';

export const RAID_ATTACK_BUTTON = 'rpg_raid_attack';

const BAR_WIDTH = 14;

/** La liste des vainqueurs part dans la description, qui doit rester loin de sa limite. */
const WINNERS_MAX = 1500;

/** « Unknown Message » : le message n'existe plus, aucun nouvel essai ne le ramènera. */
const UNKNOWN_MESSAGE = 10008;

/** Durée après l'ouverture pendant laquelle une annonce manquée est retentée. */
const ANNOUNCE_RETRY_MS = 10 * 60 * 1000;

/** Ce que l'affichage a besoin de savoir d'une équipe engagée. */
export type RpgRaidTeamLike = {
  teamName: string;
  remainingHealth: number;
  totalHealth: number;
};

type RaidLike = {
  id: string;
  guildId: string;
  bossName: string;
  bossEmoji: string;
  bossLevel: number;
  opensAt: Date;
  closesAt: Date;
  assaultsPerMember: number;
  energyCost: number;
  announceChannelId: string | null;
  announceMessageId: string | null;
};

/** Barre de progression en caractères pleins : lisible partout, sans emoji à charger. */
export function healthBar(remaining: number, total: number): string {
  const share = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const filled = Math.round(share * BAR_WIDTH);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

/** Une ligne par équipe, sans jamais dépasser la valeur d'un champ. */
function teamLines(teams: RpgRaidTeamLike[], locale: BotLocale): string {
  const lines = teams.map((team) => {
    if (team.remainingHealth <= 0) {
      return m.rpg_raid_team_defeated({ name: team.teamName }, { locale });
    }
    return m.rpg_raid_team_line({
      name: team.teamName,
      bar: healthBar(team.remainingHealth, team.totalHealth),
      remaining: team.remainingHealth.toLocaleString('fr-FR'),
      total: team.totalHealth.toLocaleString('fr-FR'),
    }, { locale });
  });

  // Un serveur à vingt clans dépassait la limite du champ, et l'annonce n'était alors plus
  // rafraîchie du tout : Discord refuse le message entier, pas seulement le champ.
  return joinFieldEntries(lines, { more: (count) => m.rpg_raid_teams_more({ count }, { locale }) });
}

export function buildRaidEmbed(raid: RaidLike, teams: RpgRaidTeamLike[], locale: BotLocale): EmbedBuilder {
  const closesUnix = Math.floor(raid.closesAt.getTime() / 1000);

  return new EmbedBuilder()
    .setTitle(m.rpg_raid_announce_title({}, { locale }))
    .setDescription(m.rpg_raid_announce_desc({
      emoji: raid.bossEmoji,
      boss: raid.bossName,
      level: raid.bossLevel,
      closes: `<t:${closesUnix}:R>`,
    }, { locale }))
    .addFields(
      {
        name: m.rpg_raid_field_teams({}, { locale }),
        value: teams.length > 0 ? teamLines(teams, locale) : m.rpg_raid_no_teams({}, { locale }),
      },
      {
        name: m.rpg_raid_field_rules({}, { locale }),
        value: m.rpg_raid_rules({ assaults: raid.assaultsPerMember, energy: raid.energyCost }, { locale }),
      },
    )
    .setColor(COLORS.danger);
}

function attackRow(locale: BotLocale): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(RAID_ATTACK_BUTTON)
      .setLabel(m.rpg_raid_button_attack({}, { locale }))
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Rouvre le droit d'annoncer après un envoi manqué, mais pas indéfiniment.
 *
 * Le marquage précède l'envoi pour qu'un salon définitivement fermé ne fasse pas tenter une
 * publication par minute pendant toute la fenêtre. Une panne passagère - Discord qui tousse,
 * le bot qui redémarre au mauvais moment - ne doit pas pour autant coûter le raid de la
 * semaine : on retente le temps du rattrapage, puis on renonce pour de bon.
 */
async function allowAnnounceRetry(raid: RaidLike): Promise<void> {
  if (Date.now() - raid.opensAt.getTime() >= ANNOUNCE_RETRY_MS) return;

  await prisma.rpgRaid.updateMany({
    where: { id: raid.id, status: 'OPEN', announceMessageId: null },
    data: { announcedAt: null },
  });
}

/**
 * Publie l'annonce d'ouverture.
 *
 * Le marquage précède l'envoi, pour ne jamais republier à chaque minute si l'envoi échoue
 * en boucle ; `allowAnnounceRetry` rouvre ce marquage le temps d'un rattrapage, l'annonce
 * portant le seul bouton d'assaut du raid.
 */
export async function announceOpenRaid(client: Client, raid: RaidLike, announce: string, roleId: string | null): Promise<void> {
  if (announce === 'NONE' || !raid.announceChannelId) return;

  const marked = await prisma.rpgRaid.updateMany({
    where: { id: raid.id, announcedAt: null },
    data: { announcedAt: new Date() },
  });
  if (marked.count === 0) return;

  const channel = await client.channels.fetch(raid.announceChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('RpgRaid', `Salon d'annonce injoignable pour ${raid.guildId}.`);
    await allowAnnounceRetry(raid);
    return;
  }

  const locale: BotLocale = await resolveGuildLocale(raid.guildId);
  const mention = announce === 'CHANNEL_ROLE' && roleId ? `<@&${roleId}>` : undefined;

  const message = await channel.send({
    content: mention,
    embeds: [buildRaidEmbed(raid, [], locale)],
    components: [attackRow(locale)],
    allowedMentions: mention && roleId ? { roles: [roleId] } : { parse: [] },
  }).catch((error: unknown) => {
    logger.error('RpgRaid', `Annonce impossible pour ${raid.guildId}:`, error);
    return null;
  });

  if (!message) {
    await allowAnnounceRetry(raid);
    return;
  }

  await prisma.rpgRaid.update({ where: { id: raid.id }, data: { announceMessageId: message.id } });
}

/** Réécrit le message d'annonce avec l'avancement des équipes. */
export async function refreshRaidMessage(client: Client, raid: RaidLike, teams: RpgRaidTeamLike[]): Promise<void> {
  if (!raid.announceChannelId || !raid.announceMessageId) return;

  const channel = await client.channels.fetch(raid.announceChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  // Seul « message inconnu » atteste d'une suppression. Sur une erreur passagère, republier
  // laisserait deux annonces dans le salon, dont une au bouton mort.
  let deleted = false;
  const message = await channel.messages.fetch(raid.announceMessageId).catch((error: unknown) => {
    deleted = error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE;
    return null;
  });

  if (deleted) {
    // Le bouton d'assaut ne vit que sur ce message : sans republication, le raid resterait
    // ouvert jusqu'au bout sans que personne ne puisse plus frapper. Effacer les marqueurs
    // suffit, le tour suivant du cycle réannonce et les équipes gardent leur avancement.
    logger.warn('RpgRaid', `Annonce du raid supprimée sur ${raid.guildId} : republication.`);
    await prisma.rpgRaid.updateMany({
      where: { id: raid.id, status: 'OPEN' },
      data: { announcedAt: null, announceMessageId: null },
    });
    return;
  }
  if (!message) return;

  const locale: BotLocale = await resolveGuildLocale(raid.guildId);
  await message.edit({
    embeds: [buildRaidEmbed(raid, teams, locale)],
    components: [attackRow(locale)],
  }).catch((error: unknown) => {
    logger.error('RpgRaid', `Rafraîchissement impossible pour ${raid.guildId}:`, error);
  });
}

/** Publie le bilan de fin et retire le bouton, le raid n'acceptant plus d'assaut. */
export async function publishRaidSummary(
  client: Client,
  raid: RaidLike,
  teams: RpgRaidTeamLike[],
  earlyReason: 'SEASON' | null = null,
): Promise<void> {
  if (!raid.announceChannelId) return;

  const channel = await client.channels.fetch(raid.announceChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) return;

  const locale: BotLocale = await resolveGuildLocale(raid.guildId);
  const winners = teams.filter((team) => team.remainingHealth <= 0);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_raid_closed_title({ emoji: raid.bossEmoji, boss: raid.bossName }, { locale }))
    .setDescription(winners.length > 0
      ? m.rpg_raid_closed_winners({
        teams: joinFieldEntries(winners.map((team) => team.teamName), {
          separator: ', ',
          max: WINNERS_MAX,
          more: (count) => m.rpg_raid_teams_more({ count }, { locale }),
        }),
      }, { locale })
      : m.rpg_raid_closed_survivor({ emoji: raid.bossEmoji, boss: raid.bossName }, { locale }))
    .setColor(winners.length > 0 ? COLORS.success : COLORS.dark);

  if (teams.length > 0) {
    embed.addFields({ name: m.rpg_raid_field_teams({}, { locale }), value: teamLines(teams, locale) });
  }

  // Une fenêtre écourtée doit dire pourquoi : sans un mot, le raid s'arrête des heures
  // avant l'heure annoncée et personne ne comprend ce qui s'est passé.
  if (earlyReason === 'SEASON') {
    embed.addFields({
      name: m.rpg_raid_closed_early_title({}, { locale }),
      value: m.rpg_raid_closed_early_season({}, { locale }),
    });
  }

  if (raid.announceMessageId) {
    const previous = await channel.messages.fetch(raid.announceMessageId).catch(() => null);
    await previous?.edit({ components: [] }).catch(() => null);
  }

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error: unknown) => {
    logger.error('RpgRaid', `Bilan impossible pour ${raid.guildId}:`, error);
  });
}

/**
 * Compte rendu d'un assaut, montré au seul joueur qui vient de frapper.
 *
 * Seuls les derniers échanges sont repris : un assaut peut durer trente tours, dont la
 * lecture intégrale n'apprend rien de plus que les six derniers et la réserve qui reste.
 */
export async function buildAssaultEmbed(guildId: string, outcome: RaidAttackOutcome): Promise<EmbedBuilder> {
  const locale: BotLocale = await resolveGuildLocale(guildId);
  const config = await getOrCreateEconomyConfig(guildId);
  const raid = outcome.raid;
  const team = outcome.team;

  const turns = outcome.result.turns.slice(-6).map((turn) => {
    if (turn.attacker === 'player') {
      return turn.damage === 0
        ? m.rpg_raid_turn_stunned({}, { locale })
        : m.rpg_raid_turn_player({ dmg: turn.damage }, { locale });
    }
    if (!turn.spellName) return m.rpg_raid_turn_boss({ dmg: turn.damage }, { locale });

    // Carapace, rugissement, écailles : ces sorts ne frappent pas. Annoncer « pour 0 »
    // laisserait croire à un coup manqué plutôt qu'à un effet posé.
    return turn.damage > 0
      ? m.rpg_raid_turn_spell({ emoji: turn.spellEmoji ?? '✨', spell: turn.spellName, dmg: turn.damage }, { locale })
      : m.rpg_raid_turn_spell_effect({ emoji: turn.spellEmoji ?? '✨', spell: turn.spellName }, { locale });
  });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_raid_assault_title({ emoji: raid?.bossEmoji ?? '🐲', boss: raid?.bossName ?? '' }, { locale }))
    .setDescription([
      m.rpg_raid_assault_damage({ damage: outcome.result.damageDealt.toLocaleString('fr-FR') }, { locale }),
      m.rpg_raid_assault_progress({
        team: team.name,
        bar: healthBar(team.remainingHealth, team.totalHealth),
        remaining: team.remainingHealth.toLocaleString('fr-FR'),
        total: team.totalHealth.toLocaleString('fr-FR'),
      }, { locale }),
      outcome.result.survived ? '' : m.rpg_raid_assault_ko({}, { locale }),
    ].filter(Boolean).join('\n'))
    .setColor(outcome.killingBlow ? COLORS.success : COLORS.danger);

  if (turns.length > 0) {
    embed.addFields({ name: m.rpg_raid_field_turns({}, { locale }), value: turns.join('\n') });
  }

  if (outcome.killingBlow) {
    embed.addFields({
      name: m.rpg_raid_killed_title({}, { locale }),
      value: m.rpg_raid_killed_desc({ emoji: raid?.bossEmoji ?? '🐲', boss: raid?.bossName ?? '', team: team.name }, { locale }),
    });
  }

  if (outcome.rewards) {
    const lines = [m.rpg_raid_rewards_line({
      xp: outcome.rewards.xp,
      coins: outcome.rewards.coins,
      currency: config.currencyEmoji,
    }, { locale })];
    if (outcome.rewards.teamPoints > 0) {
      // Le même réglage crédite un clan ou une guilde du jeu selon le mode : annoncer des
      // « points de clan » à un serveur qui joue en guildes RPG désignerait un compteur
      // que le joueur ne trouverait nulle part.
      lines.push(raid?.teamMode === 'RPG_GUILD'
        ? m.rpg_raid_rewards_guild_xp({ points: outcome.rewards.teamPoints }, { locale })
        : m.rpg_raid_rewards_points({ points: outcome.rewards.teamPoints }, { locale }));
    }
    embed.addFields({ name: m.rpg_raid_field_rewards({}, { locale }), value: lines.join('\n') });
  }

  embed.setFooter({ text: m.rpg_raid_assault_left({ left: outcome.assaultsLeft }, { locale }) });
  return embed;
}
