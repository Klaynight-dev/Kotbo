/**
 * Drops aléatoires : un cadeau que le bot pose de lui-même dans un salon, à une
 * heure imprévisible, et que les membres ramassent en cliquant.
 *
 * Quatre ressources (XP de progression, XP RPG, points de clan, pièces), chacune
 * avec son salon, sa fréquence et ses fourchettes. Trois façons de ramasser -
 * premier arrivé, les N premiers, ouvert à tous pendant un moment - réglables
 * séparément : la course au clic peut rapporter davantage que la fenêtre
 * ouverte à tous, ce qui est tout l'intérêt de les distinguer.
 *
 * Les décisions d'équilibrage (quand, combien, quel mode) vivent dans
 * `@kotbo/shared` pour rester testables ; ce service ne fait que les appliquer,
 * publier les messages et créditer les gains.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ButtonInteraction, type Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import {
  DROP_ITEM_WEIGHT_RANGE,
  DROP_TYPES,
  defaultDropTypeSettings,
  drawDropAmount,
  dropExpiresAt,
  dropMaxClaims,
  enabledDropModes,
  nextAllowedPublicationAt,
  normalizeDropItems,
  normalizeDropTypeSettings,
  pickDropMode,
  pickWeightedDropItem,
  planNextDropAt,
  type DropItemChance,
  type DropMode,
  type DropType,
  type DropTypeSettings,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isShopItemUnlocked } from './economyPolicy.js';
import { COLORS } from '../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { addXp } from '../progression/levelingService.js';
import { checkLevelUp, getOrCreateRpgProfile, getShopModuleState } from './economyService.js';
import { awardClanPointsToMembers } from '../community/clanService.js';
import { isModuleEnabled } from '../core/moduleGate.js';

export const DROP_CLAIM_PREFIX = 'drop_claim:';

/** Gagnants nommés dans le récapitulatif de clôture ; au-delà, ils sont comptés. */
const RECAP_WINNERS_LIMIT = 20;

type DropConfigRow = Awaited<ReturnType<typeof prisma.dropConfig.findFirst>>;
type DropRow = NonNullable<Awaited<ReturnType<typeof prisma.drop.findFirst>>>;

interface DropGuildContext {
  id: string;
  dropChannelId: string | null;
  dropMentionRoleId: string | null;
  dropLifetimeMinutes: number;
}

/** Colonnes plates de la base vers l'objet de réglages de `@kotbo/shared`. */
export function dropSettingsFromRow(row: NonNullable<DropConfigRow>): DropTypeSettings {
  return normalizeDropTypeSettings(row.type as DropType, {
    enabled: row.enabled,
    items: normalizeDropItems(row.items),
    channelId: row.channelId,
    intervalMinutes: row.intervalMinutes,
    first: { enabled: row.firstEnabled, minAmount: row.firstMinAmount, maxAmount: row.firstMaxAmount },
    race: {
      enabled: row.raceEnabled,
      winnerCount: row.raceWinnerCount,
      minAmount: row.raceMinAmount,
      maxAmount: row.raceMaxAmount,
    },
    window: {
      enabled: row.windowEnabled,
      durationMinutes: row.windowDurationMinutes,
      minAmount: row.windowMinAmount,
      maxAmount: row.windowMaxAmount,
    },
  });
}

/** Colonnes plates à écrire en base pour des réglages normalisés. */
export function dropSettingsToRow(settings: DropTypeSettings) {
  return {
    enabled: settings.enabled,
    items: settings.items as unknown as Prisma.InputJsonValue,
    channelId: settings.channelId,
    intervalMinutes: settings.intervalMinutes,
    firstEnabled: settings.first.enabled,
    firstMinAmount: settings.first.minAmount,
    firstMaxAmount: settings.first.maxAmount,
    raceEnabled: settings.race.enabled,
    raceWinnerCount: settings.race.winnerCount,
    raceMinAmount: settings.race.minAmount,
    raceMaxAmount: settings.race.maxAmount,
    windowEnabled: settings.window.enabled,
    windowDurationMinutes: settings.window.durationMinutes,
    windowMinAmount: settings.window.minAmount,
    windowMaxAmount: settings.window.maxAmount,
  };
}

/**
 * Les quatre lignes de réglages du serveur, créées au barème par défaut si elles
 * manquent. Appelée par le dashboard : la page doit pouvoir afficher les quatre
 * onglets avant qu'un seul drop n'ait été configuré.
 */
export async function getOrCreateDropConfigs(guildId: string) {
  const existing = await prisma.dropConfig.findMany({ where: { guildId } });
  const missing = DROP_TYPES.filter((type) => !existing.some((row) => row.type === type));

  if (missing.length > 0) {
    await prisma.dropConfig.createMany({
      data: missing.map((type) => ({ guildId, type, ...dropSettingsToRow(defaultDropTypeSettings(type)) })),
      skipDuplicates: true,
    });
    return prisma.dropConfig.findMany({ where: { guildId } });
  }

  return existing;
}

/**
 * Ce que le drop annonce.
 *
 * Un drop d'objet nomme la pièce tirée plutôt qu'une ressource : « 1 objet » n'attire
 * personne, « 1 Lame du Crépuscule » si. Le nom est passé par l'appelant, qui vient de le
 * lire, plutôt que relu ici à chaque affichage.
 */
function resourceLabel(type: DropType, locale: BotLocale, itemLabel?: string | null): string {
  if (type === 'RPG_ITEM') return itemLabel ?? m.drop_resource_rpg_item({}, { locale });
  if (type === 'RPG_XP') return m.drop_resource_rpg_xp({}, { locale });
  if (type === 'CLAN_POINTS') return m.drop_resource_clan_points({}, { locale });
  if (type === 'COINS') return m.drop_resource_coins({}, { locale });
  return m.drop_resource_xp({}, { locale });
}

function buildDropEmbed(drop: DropRow, locale: BotLocale, itemLabel?: string | null): EmbedBuilder {
  const resource = resourceLabel(drop.type as DropType, locale, itemLabel);
  const amount = drop.amount.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');

  let description: string;
  if (drop.mode === 'RACE') {
    description = m.drop_announce_desc_race({ amount, resource, winners: drop.maxClaims }, { locale });
  } else if (drop.mode === 'WINDOW') {
    description = m.drop_announce_desc_window(
      { amount, resource, closes: `<t:${Math.floor(drop.expiresAt.getTime() / 1000)}:R>` },
      { locale },
    );
  } else {
    description = m.drop_announce_desc_first({ amount, resource }, { locale });
  }

  return new EmbedBuilder()
    .setTitle(m.drop_announce_title({}, { locale }))
    .setDescription(description)
    .setColor(COLORS.primary);
}

function buildClaimRow(dropId: string, locale: BotLocale, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DROP_CLAIM_PREFIX}${dropId}`)
      .setLabel(disabled ? m.drop_claimed_button({}, { locale }) : m.drop_claim_button({}, { locale }))
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

/**
 * Objets d'un serveur réellement susceptibles de tomber.
 *
 * Le filtre est volontairement strict, et il est repassé au ramassage : entre le message
 * et le clic, un objet peut avoir été supprimé, un module éteint, et le gagnant se
 * retrouverait avec une ligne d'inventaire qui ne vaut rien.
 *
 * Sont écartés : ce que le serveur n'a pas listé, ce qui appartient à un autre serveur, ce
 * qui n'existe plus, et ce dont la récompense de module est éteinte - un objet qui vend de
 * l'XP de niveaux sur un serveur sans niveaux ne vaut pas mieux qu'un objet absent.
 */
async function eligibleDropItems(guildId: string, chances: DropItemChance[]) {
  if (chances.length === 0) return [];

  const config = await prisma.economyConfig.findUnique({
    where: { guildId },
    select: { enabled: true, rpgEnabled: true },
  });
  // Sans RPG, il n'y a pas d'inventaire où déposer quoi que ce soit.
  if (!config?.enabled || !config.rpgEnabled) return [];

  const [items, modules] = await Promise.all([
    prisma.rpgItem.findMany({
      where: { id: { in: chances.map((entry) => entry.itemId) }, OR: [{ guildId: null }, { guildId }] },
    }),
    getShopModuleState(guildId),
  ]);

  const weightOf = new Map(chances.map((entry) => [entry.itemId, entry.weight]));
  // Le taux voyage avec l'objet : écarter une pièce inéligible ne doit pas décaler les
  // parts des autres, seulement les renormaliser entre elles.
  return items
    .filter((item) => isShopItemUnlocked(item, modules))
    .map((item) => ({ item, weight: weightOf.get(item.id) ?? DROP_ITEM_WEIGHT_RANGE.min }));
}

async function publishDrop(
  client: Client,
  guild: DropGuildContext,
  config: NonNullable<DropConfigRow>,
  settings: DropTypeSettings,
  mode: DropMode,
): Promise<void> {
  const channelId = settings.channelId ?? guild.dropChannelId;
  if (!channelId) {
    logger.warn('Drops', `Aucun salon configuré pour le drop ${config.type} sur ${guild.id}.`);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('Drops', `Salon ${channelId} injoignable pour le drop ${config.type} sur ${guild.id}.`);
    return;
  }

  // L'objet est tiré maintenant et recopié sur le drop : le message annonce une pièce
  // précise, elle ne peut pas changer entre l'annonce et le clic.
  let itemId: string | null = null;
  let itemLabel: string | null = null;
  if (config.type === 'RPG_ITEM') {
    const eligible = await eligibleDropItems(guild.id, settings.items);
    if (eligible.length === 0) {
      logger.warn('Drops', `Aucun objet éligible pour le drop d'objet sur ${guild.id}.`);
      return;
    }

    const drawnId = pickWeightedDropItem(eligible.map((entry) => ({ itemId: entry.item.id, weight: entry.weight })));
    const drawn = eligible.find((entry) => entry.item.id === drawnId)?.item;
    if (!drawn) return;

    itemId = drawn.id;
    itemLabel = `${drawn.emoji} ${drawn.name}`;
  }

  const now = new Date();
  const drop = await prisma.drop.create({
    data: {
      guildId: guild.id,
      configId: config.id,
      type: config.type,
      mode,
      channelId,
      itemId,
      amount: drawDropAmount(settings, mode),
      maxClaims: dropMaxClaims(settings, mode),
      expiresAt: dropExpiresAt(now, settings, mode, guild.dropLifetimeMinutes),
    },
  });

  const locale = await resolveGuildLocale(guild.id);
  const mention = guild.dropMentionRoleId ? `<@&${guild.dropMentionRoleId}>` : undefined;

  const message = await channel.send({
    content: mention,
    embeds: [buildDropEmbed(drop, locale, itemLabel)],
    components: [buildClaimRow(drop.id, locale, false)],
    allowedMentions: mention ? { roles: [guild.dropMentionRoleId!] } : { parse: [] },
  }).catch((error: unknown) => {
    logger.error('Drops', `Publication impossible du drop ${config.type} sur ${guild.id}:`, error);
    return null;
  });

  if (!message) {
    // Sans message, le drop n'est cliquable par personne : le laisser ouvert
    // ferait traîner une ligne que le balayage clôturerait pour rien.
    await prisma.drop.delete({ where: { id: drop.id } }).catch(() => null);
    return;
  }

  await prisma.drop.update({ where: { id: drop.id }, data: { messageId: message.id } }).catch(() => null);
  logger.info('Drops', `Drop ${config.type}/${mode} de ${drop.amount} publié sur ${guild.id}.`);
}

async function tickDropConfig(client: Client, guild: DropGuildContext, config: NonNullable<DropConfigRow>): Promise<void> {
  const settings = dropSettingsFromRow(config);

  // Tous les modes éteints : le drop n'aurait aucune façon d'être ramassé.
  if (enabledDropModes(settings).length === 0) return;

  // Liste vide : rien à tirer. Le contrôle est fait ici, avant de consommer le créneau,
  // parce qu'il ne coûte aucune requête - la vérification complète des objets, elle, reste
  // à la publication. Sans ça, un type mal réglé se replanifie et prévient toutes les
  // six heures pour rien.
  if (config.type === 'RPG_ITEM' && settings.items.length === 0) return;

  const now = new Date();

  if (!config.nextDropAt) {
    await prisma.dropConfig.update({
      where: { id: config.id },
      data: { nextDropAt: planNextDropAt(now, settings.intervalMinutes) },
    });
    return;
  }

  if (config.nextDropAt > now) return;

  // Garde-fou anti-spam, tous types confondus : quatre ressources qui tombent
  // coup sur coup font un bot qui inonde un salon, ce qui lui vaut d'être
  // signalé et restreint par Discord. Le type en avance est reporté juste après
  // l'écart minimal plutôt que de sauter son tour.
  const lastPublished = await prisma.drop.findFirst({
    where: { guildId: guild.id },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const allowedFrom = nextAllowedPublicationAt(lastPublished?.createdAt);
  if (allowedFrom && allowedFrom > now) {
    await prisma.dropConfig.updateMany({
      where: { id: config.id, nextDropAt: config.nextDropAt },
      data: { nextDropAt: allowedFrom },
    });
    return;
  }

  // Réservation avant publication : la date planifiée sert de jeton. Deux
  // processus qui tickent en même temps ne peuvent pas poser deux drops, le
  // second ne retrouve plus la date qu'il avait lue.
  const reserved = await prisma.dropConfig.updateMany({
    where: { id: config.id, nextDropAt: config.nextDropAt },
    data: { nextDropAt: planNextDropAt(now, settings.intervalMinutes) },
  });
  if (reserved.count === 0) return;

  const mode = pickDropMode(settings);
  if (!mode) return;

  await publishDrop(client, guild, config, settings, mode);
}

/**
 * Tick de cron : planifie, publie, puis clôt les drops arrivés à échéance.
 *
 * Deux lectures pour tout le monde, et non une par serveur : ce cycle tourne à
 * la minute, une requête par serveur configuré ferait grossir la charge avec le
 * nombre de serveurs pour, la plupart du temps, ne rien trouver à publier.
 */
export async function runDropCycle(client: Client): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { dropsEnabled: true },
    select: { id: true, dropChannelId: true, dropMentionRoleId: true, dropLifetimeMinutes: true },
  });
  if (guilds.length === 0) {
    await closeExpiredDrops(client);
    return;
  }

  const guildById = new Map(guilds.map((guild) => [guild.id, guild]));

  // Seuls les types dont l'heure est passée, ou qui n'ont pas encore d'heure.
  const due = await prisma.dropConfig.findMany({
    where: {
      guildId: { in: [...guildById.keys()] },
      enabled: true,
      OR: [{ nextDropAt: null }, { nextDropAt: { lte: new Date() } }],
    },
  });

  // Traitement en série, volontairement : l'écart minimal entre deux
  // publications se lit sur le dernier drop enregistré, ce qu'un parcours
  // parallèle rendrait faux - deux types liraient la même base d'avant.
  for (const config of due) {
    const guild = guildById.get(config.guildId);
    if (!guild) continue;

    try {
      // La colonne dit que les drops sont allumés, la garde dit s'ils le sont
      // vraiment (bascule de module, cascade de dépendances). Lecture en cache.
      if (!(await isModuleEnabled(guild.id, 'drops'))) continue;

      await tickDropConfig(client, guild, config);
    } catch (error) {
      logger.error('Drops', `Cycle en échec pour ${guild.id} (${config.type}):`, error);
    }
  }

  await closeExpiredDrops(client);
}

/** Grise le bouton d'un drop terminé et récapitule ce qui a été ramassé. */
async function closeDropMessage(client: Client, drop: DropRow): Promise<void> {
  if (!drop.messageId) return;

  const channel = await client.channels.fetch(drop.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(drop.messageId).catch(() => null);
  if (!message) return;

  // Une fenêtre ouverte à tous peut réunir des dizaines de membres : la liste
  // est bornée pour ne pas dépasser la taille d'un message, et le reste est
  // compté plutôt que passé sous silence.
  const [claims, claimCount] = await Promise.all([
    prisma.dropClaim.findMany({
      where: { dropId: drop.id },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
      take: RECAP_WINNERS_LIMIT,
    }),
    prisma.dropClaim.count({ where: { dropId: drop.id } }),
  ]);

  const locale = await resolveGuildLocale(drop.guildId);
  // Le bilan nomme la pièce comme le faisait l'annonce : « 3 objet » à la fermeture d'un
  // drop qui annonçait une épée laisserait croire à un autre lot.
  const droppedItem = drop.itemId
    ? await prisma.rpgItem.findUnique({ where: { id: drop.itemId }, select: { name: true, emoji: true } })
    : null;
  const resource = resourceLabel(
    drop.type as DropType,
    locale,
    droppedItem ? `${droppedItem.emoji} ${droppedItem.name}` : null,
  );
  const amount = drop.amount.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');

  const mentions = claims.map((claim) => `<@${claim.userId}>`).join(', ');
  const hidden = claimCount - claims.length;
  const winners = hidden > 0
    ? `${mentions} ${m.drop_closed_more({ count: hidden }, { locale })}`
    : mentions;

  const embed = new EmbedBuilder()
    .setTitle(m.drop_announce_title({}, { locale }))
    .setColor(claimCount > 0 ? COLORS.success : COLORS.dark)
    .setDescription(
      claimCount === 0
        ? m.drop_closed_desc_empty({ amount, resource }, { locale })
        : m.drop_closed_desc({ amount, resource, winners }, { locale }),
    );

  // Le message est en Components V2 (voir utils/patchV2.ts) : l'embed est
  // reconstruit à chaque édition, `message.embeds` y est toujours vide.
  await message.edit({
    embeds: [embed],
    components: [buildClaimRow(drop.id, locale, true)],
  }).catch(() => null);
}

async function closeExpiredDrops(client: Client): Promise<void> {
  const expired = await prisma.drop.findMany({
    where: { closedAt: null, expiresAt: { lte: new Date() } },
    // Les plus anciens d'abord : en cas d'arriéré, le lot suivant reprend là
    // où celui-ci s'arrête au lieu de retomber sur un tirage arbitraire.
    orderBy: { expiresAt: 'asc' },
    take: 50,
  });

  for (const drop of expired) {
    const closed = await prisma.drop.updateMany({
      where: { id: drop.id, closedAt: null },
      data: { closedAt: new Date() },
    });
    if (closed.count === 0) continue;

    await closeDropMessage(client, drop).catch((error: unknown) => {
      logger.error('Drops', `Clôture du message du drop ${drop.id} impossible:`, error);
    });
  }
}

type ClaimOutcome =
  | { ok: true; amount: number; full: boolean }
  | { ok: false; reason: 'already' | 'full' | 'error' };

/**
 * Verse la récompense d'un drop.
 *
 * Renvoie ce qui a réellement été crédité : les points de clan d'un membre sans
 * clan ne vont nulle part, et le drop doit alors rester ouvert pour quelqu'un
 * d'autre plutôt que de disparaître dans le vide.
 */
async function creditDrop(client: Client, drop: DropRow, userId: string): Promise<number> {
  switch (drop.type as DropType) {
    case 'XP': {
      await addXp(drop.guildId, userId, drop.amount, client, drop.channelId);
      return drop.amount;
    }
    case 'RPG_XP': {
      const profile = await getOrCreateRpgProfile(drop.guildId, userId);
      await prisma.rpgProfile.update({ where: { id: profile.id }, data: { xp: { increment: drop.amount } } });
      // Comme tout gain d'XP RPG : sans ce passage, l'XP s'empile sans jamais
      // faire monter de niveau tant qu'aucune autre action ne le déclenche.
      await checkLevelUp(drop.guildId, userId);
      return drop.amount;
    }
    case 'COINS': {
      const profile = await getOrCreateRpgProfile(drop.guildId, userId);
      await prisma.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: drop.amount } } });
      return drop.amount;
    }
    case 'RPG_ITEM': {
      if (!drop.itemId) return 0;

      // Le module a pu être éteint et l'objet supprimé depuis la publication : les mêmes
      // contrôles sont repassés. Rendre 0 laisse le drop ouvert plutôt que de le consommer
      // pour rien - c'est déjà ce que fait un drop de points sans clan.
      //
      // La liste du serveur n'est volontairement pas relue : elle décide de ce qui *peut
      // être publié*, et un objet retiré après coup ne doit pas reprendre ce que le salon
      // a déjà promis nommément.
      const eligible = await eligibleDropItems(drop.guildId, [{ itemId: drop.itemId, weight: DROP_ITEM_WEIGHT_RANGE.min }]);
      if (eligible.length === 0) return 0;

      const profile = await getOrCreateRpgProfile(drop.guildId, userId);
      await prisma.rpgInventoryItem.upsert({
        where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: drop.itemId } },
        create: { rpgProfileId: profile.id, itemId: drop.itemId, quantity: drop.amount },
        update: { quantity: { increment: drop.amount } },
      });
      return drop.amount;
    }
    case 'CLAN_POINTS': {
      const granted = await awardClanPointsToMembers({
        guildId: drop.guildId,
        client,
        source: 'DROP',
        awards: [{ userId, amount: drop.amount }],
        reason: 'drop',
      });
      return granted.get(userId) ?? 0;
    }
    default:
      return 0;
  }
}

/**
 * Réserve une place sur un drop pour un membre.
 *
 * La contrainte d'unicité `(dropId, userId)` bloque le double clic, et
 * l'incrément conditionnel sur `claimCount` empêche deux clics simultanés de
 * dépasser le nombre de gagnants : un contrôle applicatif « compter puis
 * écrire » laisserait passer les deux.
 */
async function reserveClaim(drop: DropRow, userId: string): Promise<ClaimOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.dropClaim.create({
        data: { dropId: drop.id, guildId: drop.guildId, userId, amount: drop.amount },
      });

      const taken = await tx.drop.updateMany({
        where: {
          id: drop.id,
          closedAt: null,
          expiresAt: { gt: new Date() },
          ...(drop.maxClaims > 0 ? { claimCount: { lt: drop.maxClaims } } : {}),
        },
        data: { claimCount: { increment: 1 } },
      });

      if (taken.count === 0) throw new Error('DROP_FULL');

      const updated = await tx.drop.findUnique({ where: { id: drop.id }, select: { claimCount: true } });
      const full = drop.maxClaims > 0 && (updated?.claimCount ?? 0) >= drop.maxClaims;
      return { ok: true as const, amount: drop.amount, full };
    });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'P2002') return { ok: false, reason: 'already' };
    if (error instanceof Error && error.message === 'DROP_FULL') return { ok: false, reason: 'full' };
    throw error;
  }
}

/** Annule une réservation dont la récompense n'a finalement pas été versée. */
async function releaseClaim(drop: DropRow, userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.dropClaim.deleteMany({ where: { dropId: drop.id, userId } }),
    prisma.drop.update({ where: { id: drop.id }, data: { claimCount: { decrement: 1 } } }),
  ]).catch((error: unknown) => {
    logger.error('Drops', `Libération de la place de ${userId} sur le drop ${drop.id} impossible:`, error);
  });
}

/** Bouton « Ramasser » : réserve la place, verse le gain, ferme si le drop est complet. */
export async function handleDropClaim(interaction: ButtonInteraction, dropId: string): Promise<void> {
  // Réponse différée d'entrée : un versement de points de clan va chercher le
  // membre et ses comptes liés, ce qui dépasse largement les trois secondes
  // laissées par Discord pour accuser réception d'un clic.
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);

  const locale = await resolveGuildLocale(interaction.guildId ?? '');
  const drop = await prisma.drop.findUnique({ where: { id: dropId } });

  const refuse = async (message: string): Promise<void> => {
    await interaction.editReply({ content: message }).catch(() => null);
  };

  if (!drop) {
    await refuse(m.drop_claim_gone({}, { locale }));
    return;
  }
  if (drop.closedAt || drop.expiresAt <= new Date()) {
    await refuse(m.drop_claim_closed({}, { locale }));
    return;
  }

  const reserved = await reserveClaim(drop, interaction.user.id).catch((error: unknown) => {
    // Une contention sur le drop peut faire expirer la transaction : le drop
    // existe toujours, dire le contraire enverrait le membre chercher un
    // problème qui n'existe pas.
    logger.error('Drops', `Réservation du drop ${dropId} impossible pour ${interaction.user.id}:`, error);
    return { ok: false as const, reason: 'error' as const };
  });

  if (!reserved.ok) {
    if (reserved.reason === 'already') await refuse(m.drop_claim_already({}, { locale }));
    else if (reserved.reason === 'full') await refuse(m.drop_claim_full({}, { locale }));
    else await refuse(m.drop_claim_failed({}, { locale }));
    return;
  }

  const credited = await creditDrop(interaction.client, drop, interaction.user.id).catch((error: unknown) => {
    logger.error('Drops', `Versement du drop ${dropId} à ${interaction.user.id} impossible:`, error);
    return 0;
  });

  if (credited <= 0) {
    await releaseClaim(drop, interaction.user.id);
    await refuse(
      drop.type === 'CLAN_POINTS'
        ? m.drop_claim_no_clan({}, { locale })
        : drop.type === 'RPG_ITEM'
          ? m.drop_claim_item_gone({}, { locale })
          : m.drop_claim_failed({}, { locale }),
    );
    return;
  }

  const claimedItem = drop.itemId
    ? await prisma.rpgItem.findUnique({ where: { id: drop.itemId }, select: { name: true, emoji: true } })
    : null;
  const resource = resourceLabel(
    drop.type as DropType,
    locale,
    claimedItem ? `${claimedItem.emoji} ${claimedItem.name}` : null,
  );
  const amount = credited.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');
  await interaction.editReply({
    content: m.drop_claim_success({ amount, resource }, { locale }),
  }).catch(() => null);

  if (reserved.full) {
    const closed = await prisma.drop.updateMany({
      where: { id: drop.id, closedAt: null },
      data: { closedAt: new Date() },
    });
    if (closed.count > 0) {
      const refreshed = await prisma.drop.findUnique({ where: { id: drop.id } });
      if (refreshed) await closeDropMessage(interaction.client, refreshed);
    }
  }
}
