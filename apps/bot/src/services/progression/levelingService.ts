import { Client, GuildMember } from 'discord.js';
import { createCanvas, loadImage, GlobalFonts, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import type { LevelConfig } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import {
  getRankCardBackground,
  getRankCardFont,
  rankCardEmojiCodePoint,
  rankCardFontStack,
  RANK_CARD_FONTS,
  RANK_CARD_HEIGHT,
  RANK_CARD_WIDTH,
  DEFAULT_LEVEL_CURVE,
  MAX_XP,
  clampXp,
  computeClanLevelUpPoints,
  grantedWithinDailyCap,
  levelFromXp,
  normalizeLevelCurve,
  xpForLevel,
  type LevelCurve,
  type RankCardCustomization,
} from '@kotbo/shared';
import { ensureCanvasFonts } from '../../utils/canvasFonts.js';
import { getRankCardCustomization } from './rankCardService.js';
import { creditRpFromXp } from './ranked/rankedService.js';
import { visiblePresenceStatus } from '../core/presencePrivacyService.js';
import { kotboEventBus } from '@kotbo/core';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { cache, getCachedGuild } from '../../utils/cache.js';
import { type BotLocale, resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

// Cooldown map: key is "guildId:userId", value is timestamp when cooldown expires
const xpCooldowns = new Map<string, number>();
const MAX_XP_COOLDOWNS = 100_000;
let xpCooldownChecks = 0;

function maintainXpCooldowns(now: number): void {
  xpCooldownChecks++;
  if (xpCooldownChecks % 2_048 !== 0 && xpCooldowns.size < MAX_XP_COOLDOWNS) return;

  for (const [key, cooldownEnd] of xpCooldowns) {
    if (cooldownEnd <= now) xpCooldowns.delete(key);
  }
  while (xpCooldowns.size >= MAX_XP_COOLDOWNS) {
    const oldest = xpCooldowns.keys().next().value as string | undefined;
    if (!oldest) break;
    xpCooldowns.delete(oldest);
  }
}

/**
 * Calcul l'XP nécessaire pour atteindre un niveau donné.
 *
 * La courbe est propre à chaque guilde : tout appel qui connaît la guilde doit
 * lui passer sa courbe (`getGuildLevelCurve`). Sans courbe, on retombe sur la
 * formule historique, qui reste le défaut de `LevelConfig`.
 */
export function getXpForLevel(level: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  return xpForLevel(level, curve);
}

/**
 * Dérive le niveau à partir de l'XP totale.
 * L'XP est la source de vérité : le niveau en est toujours déduit, ce qui
 * permet d'auto-réparer les lignes incohérentes (ex. données importées d'un
 * autre bot avec une courbe différente).
 */
export function getLevelFromXp(xp: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  return levelFromXp(xp, curve);
}

export function levelCurveFromConfig(config: Pick<LevelConfig, 'curveBaseXp' | 'curveLinearXp' | 'curveExponent' | 'maxLevel'>): LevelCurve {
  return normalizeLevelCurve({
    baseXp: config.curveBaseXp,
    linearXp: config.curveLinearXp,
    exponent: config.curveExponent,
    maxLevel: config.maxLevel,
  });
}

/**
 * Courbe d'une guilde, tolérante à l'échec : un module qui n'arrive pas à lire
 * la config doit afficher un niveau plausible plutôt que planter.
 */
export async function getGuildLevelCurve(guildId: string): Promise<LevelCurve> {
  const config = await getOrCreateLevelConfig(guildId).catch(() => null);
  return config ? levelCurveFromConfig(config) : DEFAULT_LEVEL_CURVE;
}

/**
 * Message compose par le bot quand l'admin n'en a pas ecrit. Expose plutot
 * qu'ecrit deux fois : la mise en route le depose dans la configuration pour
 * qu'il soit visible et modifiable, et l'envoi s'en sert quand le champ est
 * reste vide.
 *
 * `{user}` et `{level}` traversent la traduction tels quels, ils sont
 * remplaces au moment de l'envoi.
 */
export function defaultLevelUpMessage(locale: BotLocale): string {
  return m.leveling_levelup_default_message({ user: '{user}', level: '{level}' }, { locale });
}

export async function getOrCreateLevelConfig(guildId: string) {
  const cacheKey = `guild:${guildId}:level_config`;
  let config = await cache.get<LevelConfig>(cacheKey);

  if (config) return config;

  config = await prisma.levelConfig.findUnique({
    where: { guildId },
  });

  if (!config) {
    // Ensure the Guild row exists before creating the FK-dependent LevelConfig
    await prisma.guild.upsert({
      where: { id: guildId },
      update: {},
      create: { id: guildId },
    });

    config = await prisma.levelConfig.create({
      data: {
        guildId,
        enabled: false,
        xpMin: 15,
        xpMax: 25,
        cooldownSeconds: 60,
        vocalXpPerMin: 5,
        // Vide, et non un texte fige : le message par defaut est compose a
        // l'envoi, dans la langue du serveur a ce moment-la. Un texte ecrit ici
        // resterait dans la langue du jour de la creation, meme apres un
        // passage du bot en anglais.
        levelUpMessage: '',
        stackRewards: false,
        ignoredChannels: [],
        ignoredRoles: [],
        xpMultipliers: {},
        lengthBonusEnabled: false,
        lengthBonusThreshold: 200,
        lengthBonusMaxMultiplier: 2.0,
        curveBaseXp: DEFAULT_LEVEL_CURVE.baseXp,
        curveLinearXp: DEFAULT_LEVEL_CURVE.linearXp,
        curveExponent: DEFAULT_LEVEL_CURVE.exponent,
        maxLevel: DEFAULT_LEVEL_CURVE.maxLevel,
        voiceRequireUnmuted: true,
        voiceRequireUndeafened: true,
        voiceIgnoreAfkChannel: true,
        voiceMinMembers: 1,
        dailyXpCap: 0,
      },
    });
  }

  await cache.set(cacheKey, config, 60);
  return config;
}

/**
 * Réaligne la colonne `level` sur l'XP totale après un changement de courbe.
 *
 * Le niveau est normalement auto-réparé, mais seulement quand le membre regagne
 * de l'XP ou consulte son rang. Sans ce rattrapage, tout ce qui lit la colonne
 * telle quelle - les archives de fin de saison en particulier - resterait sur
 * l'ancienne courbe pour les membres devenus inactifs.
 */
export async function resyncGuildLevels(
  guildId: string,
  curve: LevelCurve,
  options: { client?: Client } = {},
): Promise<number> {
  const bands = await guildLevelBands(guildId, curve);
  const moves: Array<{ userId: string; from: number; to: number }> = [];
  // Sans récompense configurée, aucun rôle ne dépend du niveau : rien à relever.
  const tracksRoles = options.client
    ? (await prisma.levelRoleReward.count({ where: { guildId } })) > 0
    : false;
  let updated = 0;

  for (const band of bands) {
    // Qui bouge, relevé avant l'écriture : après, l'ancien niveau a disparu et
    // il n'y a plus moyen de savoir quels rôles de récompense sont à revoir.
    if (tracksRoles && moves.length < ROLE_RESYNC_MEMBER_LIMIT) {
      const movers = await prisma.memberLevel.findMany({
        where: { guildId, level: { not: band.level }, xp: band.xp },
        select: { userId: true, level: true },
        take: ROLE_RESYNC_MEMBER_LIMIT - moves.length,
      });
      for (const mover of movers) {
        moves.push({ userId: mover.userId, from: mover.level, to: band.level });
      }
    }

    const result = await prisma.memberLevel.updateMany({
      where: { guildId, level: { not: band.level }, xp: band.xp },
      data: { level: band.level },
    });
    updated += result.count;
  }

  if (tracksRoles && moves.length > 0) {
    if (moves.length >= ROLE_RESYNC_MEMBER_LIMIT) {
      logger.warn('LevelingService', `Plus de ${ROLE_RESYNC_MEMBER_LIMIT} membres déplacés sur ${guildId} : les rôles au-delà suivront au prochain gain d'XP.`);
    }
    // Préparé seulement : appliquer d'office ferait basculer des milliers de
    // rôles à la seconde où un curseur est enregistré.
    await prepareRoleResync(guildId, moves).catch((err) => {
      logger.error('LevelingService', `Relevé des rôles à ranger impossible sur ${guildId}:`, err);
      return 0;
    });
  }

  return updated;
}

/**
 * Remet les rôles de récompense d'un membre en accord avec son niveau, à
 * l'occasion d'un gain d'XP.
 *
 * Le rattrapage historique ne se déclenchait qu'au *changement* de niveau. Après
 * un réalignement de courbe, la colonne est déjà juste : le membre garde donc
 * les rôles de son ancien niveau jusqu'à ce qu'il franchisse un palier, ce qui
 * peut prendre des semaines. Ici la comparaison se fait à chaque gain, mais
 * uniquement en mémoire - les rôles du membre sont déjà dans le cache de la
 * guilde - et ne coûte un appel à Discord que s'il y a vraiment un écart.
 */
async function reconcileRewardRoles(
  guildId: string,
  userId: string,
  level: number,
  client: Client,
): Promise<void> {
  const cacheKey = `guild:${guildId}:level_rewards`;
  let rewards = await cache.get<Array<{ level: number; roleId: string }>>(cacheKey);
  if (!rewards) {
    rewards = await prisma.levelRoleReward.findMany({
      where: { guildId },
      orderBy: { level: 'asc' },
      select: { level: true, roleId: true },
    });
    await cache.set(cacheKey, rewards, 60);
  }
  if (rewards.length === 0) return;

  // Cache seulement : aller chercher le membre à chaque message coûterait un
  // appel réseau par message, pour un écart qui n'arrive presque jamais.
  const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
  if (!member) return;

  const config = await getOrCreateLevelConfig(guildId).catch(() => null);
  const earned = rewards.filter((reward) => reward.level <= level);
  const expected = new Set(
    earned.length === 0
      ? []
      : config?.stackRewards ? earned.map((reward) => reward.roleId) : [earned[earned.length - 1].roleId],
  );

  const wrong = rewards.some((reward) => expected.has(reward.roleId) !== member.roles.cache.has(reward.roleId));
  if (wrong) await updateMemberLevelRoles(guildId, userId, level, client).catch(() => null);
}

/**
 * Tranches d'XP de la guilde, une par niveau occupé : `[seuil du niveau, seuil
 * du suivant[`. Sert de plan de travail aux passes qui doivent traiter tous les
 * membres sans en charger un seul - une guilde de 50 000 membres tient dans une
 * requête par niveau occupé, l'index `(guildId, xp)` faisant le reste.
 */
async function guildLevelBands(
  guildId: string,
  curve: LevelCurve,
  db = prisma,
): Promise<Array<{ level: number; xp: { gte: number; lt?: number } }>> {
  const top = await db.memberLevel.findFirst({
    where: { guildId },
    orderBy: { xp: 'desc' },
    select: { xp: true },
  });
  if (!top) return [];

  const highestLevel = getLevelFromXp(top.xp, curve);
  const bands: Array<{ level: number; xp: { gte: number; lt?: number } }> = [];

  for (let level = 1; level <= highestLevel; level++) {
    // La dernière tranche reste ouverte : au niveau maximum d'une guilde
    // plafonnée, l'XP continue de monter sans borne supérieure.
    bands.push({
      level,
      xp: level === highestLevel
        ? { gte: getXpForLevel(level - 1, curve) }
        : { gte: getXpForLevel(level - 1, curve), lt: getXpForLevel(level, curve) },
    });
  }

  return bands;
}

/** Plafond de membres suivis par une passe de rôles, pour la borner. */
const ROLE_RESYNC_MEMBER_LIMIT = 5000;
/** Pause entre deux membres : l'API Discord n'aime pas les rafales de rôles. */
const ROLE_RESYNC_PAUSE_MS = 250;
/** Au-delà, un relevé oublié n'a plus de rapport avec l'état de la guilde. */
const ROLE_RESYNC_TTL_MS = 60 * 60 * 1000;

type RoleMove = { userId: string; roles: string[] };

type RoleResyncJob = {
  moves: RoleMove[];
  managedRoleIds: string[];
  preparedAt: number;
  done: number;
  running: boolean;
  stopping: boolean;
};

const roleResyncJobs = new Map<string, RoleResyncJob>();

/**
 * Prépare - sans rien appliquer - le rangement des rôles de récompense après un
 * changement de courbe.
 *
 * Le réalignement ne touche que la colonne `level` ; les rôles, eux, ne sont
 * revus qu'au gain d'XP suivant, donc jamais pour un membre inactif. Mais les
 * réaccorder d'office ferait basculer des milliers de rôles d'un coup sur un
 * gros serveur, à la seconde où un curseur est enregistré : trop de conséquences
 * pour une action aussi anodine. Le relevé est donc gardé de côté et attend une
 * demande explicite.
 */
async function prepareRoleResync(
  guildId: string,
  moves: Array<{ userId: string; from: number; to: number }>,
): Promise<number> {
  // Une passe en cours ne doit jamais être effacée de la table : elle deviendrait
  // impossible à suivre et surtout à arrêter, alors qu'elle continue à modifier
  // des rôles.
  const running = roleResyncJobs.get(guildId)?.running === true;
  const forget = () => {
    if (!running) roleResyncJobs.delete(guildId);
  };

  const rewards = await prisma.levelRoleReward.findMany({
    where: { guildId },
    orderBy: { level: 'asc' },
  });
  if (rewards.length === 0) {
    forget();
    return 0;
  }

  const stackRewards = (await getOrCreateLevelConfig(guildId).catch(() => null))?.stackRewards === true;
  const rolesByLevel = new Map<number, string[]>();
  const rolesAtLevel = (level: number): string[] => {
    const known = rolesByLevel.get(level);
    if (known) return known;
    const earned = rewards.filter((reward) => reward.level <= level);
    const roles = earned.length === 0
      ? []
      : stackRewards ? earned.map((reward) => reward.roleId) : [earned[earned.length - 1].roleId];
    rolesByLevel.set(level, roles);
    return roles;
  };

  // Un membre qui change de niveau sans changer de rôle n'a rien à faire ici :
  // c'est le gros du lot dès que les paliers sont espacés.
  const affected: RoleMove[] = [];
  for (const move of moves) {
    const after = rolesAtLevel(move.to);
    if (rolesAtLevel(move.from).join(',') === after.join(',')) continue;
    affected.push({ userId: move.userId, roles: after });
  }

  if (affected.length === 0) {
    forget();
    return 0;
  }

  if (running) {
    logger.warn('LevelingService', `Rangement de rôles en cours sur ${guildId} : les membres deplaces cette fois-ci suivront a leur prochain gain d'XP.`);
    return affected.length;
  }

  roleResyncJobs.set(guildId, {
    moves: affected,
    managedRoleIds: rewards.map((reward) => reward.roleId),
    preparedAt: Date.now(),
    done: 0,
    running: false,
    stopping: false,
  });
  return affected.length;
}

/** Ce qui attend d'être rangé sur cette guilde, et où en est la passe. */
export function getRoleResyncStatus(guildId: string) {
  const job = roleResyncJobs.get(guildId);
  if (!job) return { pending: 0, done: 0, running: false };
  // Un relevé périmé est jeté ici : sans lecture, il resterait en mémoire.
  if (!job.running && Date.now() - job.preparedAt > ROLE_RESYNC_TTL_MS) {
    roleResyncJobs.delete(guildId);
    return { pending: 0, done: 0, running: false };
  }
  return { pending: job.moves.length, done: job.done, running: job.running };
}

/** Interrompt la passe en cours : elle s'arrête au membre suivant. */
export function stopRoleResync(guildId: string): boolean {
  const job = roleResyncJobs.get(guildId);
  if (!job?.running) return false;
  job.stopping = true;
  return true;
}

/**
 * Applique le rangement préparé, à la demande. Détaché de la requête : ranger
 * quelques milliers de membres prend des minutes, au rythme imposé par l'API
 * Discord.
 */
export function startRoleResync(guildId: string, client: Client): { started: boolean; pending: number } {
  const job = roleResyncJobs.get(guildId);
  if (!job || job.moves.length === 0) return { started: false, pending: 0 };
  if (job.running) return { started: false, pending: job.moves.length };
  if (Date.now() - job.preparedAt > ROLE_RESYNC_TTL_MS) {
    roleResyncJobs.delete(guildId);
    return { started: false, pending: 0 };
  }

  job.running = true;
  job.stopping = false;
  // `done` est conservé : un rangement arrêté puis relancé reprend où il en
  // était plutôt que de revisiter des membres déjà en règle.
  void runRoleResync(guildId, client, job);
  return { started: true, pending: job.moves.length };
}

async function runRoleResync(guildId: string, client: Client, job: RoleResyncJob): Promise<void> {
  try {
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    logger.info('LevelingService', `Rangement des rôles de récompense sur ${guildId} : ${job.moves.length} membres.`);

    for (let index = job.done; index < job.moves.length; index++) {
      const move = job.moves[index];
      if (job.stopping) {
        logger.info('LevelingService', `Rangement des rôles interrompu sur ${guildId} après ${job.done} membres.`);
        break;
      }

      const member = await discordGuild.members.fetch(move.userId).catch(() => null);
      if (member) {
        const target = new Set(move.roles);
        const toAdd = move.roles.filter((roleId) => !member.roles.cache.has(roleId));
        const toRemove = job.managedRoleIds.filter((roleId) => !target.has(roleId) && member.roles.cache.has(roleId));
        if (toRemove.length > 0) await member.roles.remove(toRemove).catch(() => null);
        if (toAdd.length > 0) await member.roles.add(toAdd).catch(() => null);
      }

      job.done++;
      await new Promise((resolve) => setTimeout(resolve, ROLE_RESYNC_PAUSE_MS));
    }

    if (!job.stopping) {
      logger.info('LevelingService', `Rangement des rôles terminé sur ${guildId} : ${job.done} membres visités.`);
    }
  } catch (err) {
    logger.error('LevelingService', `Rangement des rôles interrompu sur ${guildId}:`, err);
  } finally {
    job.running = false;
    job.stopping = false;
    if (job.done >= job.moves.length) roleResyncJobs.delete(guildId);
  }
}

export interface CurveImpact {
  total: number;
  changed: number;
  lowered: number;
  /** Nombre de membres par niveau, index 0 pour le niveau 1. */
  distribution: number[];
  /** Membres au-delà de la fenêtre couverte par `distribution`. */
  beyond: number;
  /** Rôles de récompense qui changent de main, du plus mouvementé au moins. */
  rewardMoves: Array<{ roleId: string; gained: number; lost: number }>;
}

/**
 * Ce que donnerait `resyncGuildLevels` avec cette courbe, sans rien réécrire :
 * combien de membres changent de niveau, combien en perdent, et où ils se
 * répartissent. Le dashboard peut ainsi annoncer l'effet d'un réglage avant
 * l'enregistrement même quand il n'a pas la liste des membres sous la main.
 *
 * Le comptage se fait par tranche, comme le réalignement : `groupBy` donne la
 * répartition des niveaux enregistrés à l'intérieur d'une tranche, donc de quoi
 * comparer l'ancien niveau au nouveau sans sortir une ligne de la base.
 */
export async function countCurveImpact(
  guildId: string,
  curve: LevelCurve,
  windowSize = 30,
): Promise<CurveImpact> {
  // Lecture pure, déclenchée par un curseur du dashboard : elle part sur la
  // réplique de lecture quand il y en a une, pour ne pas peser sur la base qui
  // encaisse les gains d'XP.
  const bands = await guildLevelBands(guildId, curve, prismaRead);
  // Mêmes colonnes que l'aperçu de la courbe côté dashboard, sinon les deux
  // graphiques ne s'alignent plus : la fenêtre suit le plafond, pas la
  // population.
  const columns = curve.maxLevel > 0 ? Math.min(windowSize, curve.maxLevel) : windowSize;
  const impact: CurveImpact = {
    total: 0,
    changed: 0,
    lowered: 0,
    distribution: new Array<number>(columns).fill(0),
    beyond: 0,
    rewardMoves: [],
  };

  // Le nombre de niveaux qui bougent ne dit pas ce que les membres verront :
  // ce sont les rôles qui changent de main. Les récompenses et le cumul sont
  // lus ici plutôt que transmis, la base les tient déjà.
  const rewards = await prismaRead.levelRoleReward.findMany({
    where: { guildId },
    orderBy: { level: 'asc' },
  });
  const stackRewards = (await getOrCreateLevelConfig(guildId).catch(() => null))?.stackRewards === true;
  const rolesByLevel = new Map<number, string[]>();
  const rolesAtLevel = (level: number): string[] => {
    const known = rolesByLevel.get(level);
    if (known) return known;
    const earned = rewards.filter((reward) => reward.level <= level);
    // Sans cumul, seul le palier le plus haut est porté - `rewards` est trié.
    const roles = earned.length === 0
      ? []
      : stackRewards ? earned.map((reward) => reward.roleId) : [earned[earned.length - 1].roleId];
    rolesByLevel.set(level, roles);
    return roles;
  };
  const gained = new Map<string, number>();
  const lost = new Map<string, number>();

  // Par paquets plutôt qu'une tranche après l'autre : une guilde dont le
  // meilleur membre est très haut en compte des centaines, et les enchaîner
  // ferait attendre le dashboard bien plus longtemps que la base ne travaille.
  const BATCH_SIZE = 8;
  for (let start = 0; start < bands.length; start += BATCH_SIZE) {
    const batch = bands.slice(start, start + BATCH_SIZE);
    const results = await Promise.all(batch.map((band) => prismaRead.memberLevel.groupBy({
      by: ['level'],
      where: { guildId, xp: band.xp },
      _count: { _all: true },
    })));

    batch.forEach((band, index) => {
      let inBand = 0;
      for (const group of results[index]) {
        const count = group._count._all;
        inBand += count;
        if (group.level === band.level) continue;
        impact.changed += count;
        if (group.level > band.level) impact.lowered += count;

        if (rewards.length > 0) {
          const before = rolesAtLevel(group.level);
          const after = rolesAtLevel(band.level);
          for (const roleId of after) {
            if (!before.includes(roleId)) gained.set(roleId, (gained.get(roleId) ?? 0) + count);
          }
          for (const roleId of before) {
            if (!after.includes(roleId)) lost.set(roleId, (lost.get(roleId) ?? 0) + count);
          }
        }
      }

      impact.total += inBand;
      if (band.level <= impact.distribution.length) {
        impact.distribution[band.level - 1] = inBand;
      } else {
        impact.beyond += inBand;
      }
    });
  }

  impact.rewardMoves = [...new Set([...gained.keys(), ...lost.keys()])]
    .map((roleId) => ({ roleId, gained: gained.get(roleId) ?? 0, lost: lost.get(roleId) ?? 0 }))
    .sort((a, b) => (b.gained + b.lost) - (a.gained + a.lost));

  return impact;
}

/** À appeler après toute écriture de `LevelRoleReward`. */
export async function invalidateLevelRewardsCache(guildId: string): Promise<void> {
  await cache.delete(`guild:${guildId}:level_rewards`);
}

/**
 * À appeler après toute écriture de `LevelConfig` : la courbe et le plafond
 * quotidien sont lus à chaque gain d'XP, laisser expirer le TTL ferait tourner
 * la guilde sur ses anciens réglages pendant une minute.
 */
export async function invalidateLevelConfigCache(guildId: string): Promise<void> {
  await cache.delete(`guild:${guildId}:level_config`);
}

/**
 * Calcule le facteur multiplicateur d'XP en fonction de la longueur du message.
 * Progression linéaire de 1.0 (message vide/court) jusqu'à `maxMultiplier`
 * atteint à `threshold` caractères, puis plafonné.
 */
export function computeLengthBonusFactor(
  messageLength: number,
  enabled: boolean,
  threshold: number,
  maxMultiplier: number,
): number {
  if (!enabled) return 1;
  if (!threshold || threshold <= 0) return 1;
  if (!maxMultiplier || maxMultiplier <= 1) return 1;
  const ratio = Math.min(1, Math.max(0, messageLength / threshold));
  return 1 + ratio * (maxMultiplier - 1);
}

/**
 * Ajoute de l'XP à un utilisateur (Textuel)
 */
export async function handleTextXp(guildId: string, userId: string, client: Client, channelId: string, messageLength = 0) {
  try {
    const config = await getOrCreateLevelConfig(guildId);
    if (!config.enabled) return;

    // Vérifier si le salon est exclu
    if (config.ignoredChannels && config.ignoredChannels.includes(channelId)) {
      return;
    }

    const cooldownKey = `${guildId}:${userId}`;
    const now = Date.now();
    maintainXpCooldowns(now);
    const cooldownEnd = xpCooldowns.get(cooldownKey) || 0;
    if (now < cooldownEnd) return;

    // Récupérer le membre Discord pour valider ses rôles
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;
    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (!member) return;

    // Vérifier si le membre possède un rôle exclu
    if (config.ignoredRoles && (config.ignoredRoles as string[]).some(roleId => member.roles.cache.has(roleId))) {
      return;
    }

    // Définir le nouveau cooldown
    xpCooldowns.delete(cooldownKey);
    xpCooldowns.set(cooldownKey, now + (config.cooldownSeconds * 1000));

    // Calculer le multiplicateur d'XP par rôle
    let multiplier = 1.0;
    if (config.xpMultipliers && typeof config.xpMultipliers === 'object') {
      const multipliers = config.xpMultipliers as Record<string, number>;
      for (const [roleId, multValue] of Object.entries(multipliers)) {
        if (member.roles.cache.has(roleId)) {
          if (multValue > multiplier) {
            multiplier = multValue;
          }
        }
      }
    }

    // Bonus selon la longueur du message (plus le message est long, plus le gain est élevé)
    const lengthFactor = computeLengthBonusFactor(
      messageLength,
      Boolean(config.lengthBonusEnabled),
      Number(config.lengthBonusThreshold ?? 0),
      Number(config.lengthBonusMaxMultiplier ?? 1),
    );

    // Assigner l'XP en appliquant le multiplicateur de rôle puis le bonus de longueur
    const baseGain = Math.floor(Math.random() * (config.xpMax - config.xpMin + 1)) + config.xpMin;
    const xpGain = Math.floor(baseGain * multiplier * lengthFactor);

    if (xpGain > 0) {
      await addXp(guildId, userId, xpGain, client, channelId, { applyDailyCap: true, rankedSource: 'text' });
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de l'ajout d'XP texte pour ${userId} sur ${guildId}:`, err);
  }
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Décompte `amount` du quota quotidien et renvoie la part réellement accordée.
 *
 * Le compteur vit sur la ligne du membre : elle est déjà écrite à chaque gain,
 * et une table dédiée aurait eu la même cardinalité tout en demandant sa propre
 * purge. Le compteur d'un autre jour est remis à zéro avant l'incrément, puis
 * le total est ramené au plafond en cas de dépassement : deux gains concurrents
 * ne peuvent donc pas le franchir ensemble, là où un `read then write` le
 * permettrait.
 */
async function consumeDailyXpAllowance(guildId: string, userId: string, amount: number, cap: number): Promise<number> {
  if (cap <= 0) return amount;

  const dateKey = utcDateKey(new Date());
  const where = { guildId_userId: { guildId, userId } };

  // `not` seul ne retiendrait pas les lignes à NULL : en SQL, `NULL <> 'x'`
  // ne vaut pas vrai. Les deux cas sont donc listés explicitement.
  await prisma.memberLevel.updateMany({
    where: { guildId, userId, OR: [{ dailyXpDate: null }, { dailyXpDate: { not: dateKey } }] },
    data: { dailyXp: 0, dailyXpDate: dateKey },
  });

  const counter = await prisma.memberLevel.upsert({
    where,
    update: { dailyXp: { increment: amount } },
    create: { guildId, userId, xp: 0, level: 0, dailyXp: amount, dailyXpDate: dateKey },
  });

  if (counter.dailyXp <= cap) return amount;

  await prisma.memberLevel.update({ where, data: { dailyXp: cap } }).catch(() => null);
  return grantedWithinDailyCap(counter.dailyXp, amount, cap);
}

/**
 * Ajoute de l'XP brute à un utilisateur et gère le passage de niveau.
 *
 * `applyDailyCap` n'est activé que pour les gains d'activité (texte, vocal) :
 * un octroi manuel de staff ou une récompense de quête ne doit pas être rogné
 * par le plafond quotidien.
 *
 * `rankedSource` branche le RP compétitif sur ce même gain. Il n'est renseigné
 * que par les sources d'activité, pour la même raison : un ajustement de staff
 * ne doit pas faire grimper un membre dans le classement.
 */
export async function addXp(
  guildId: string,
  userId: string,
  amount: number,
  client: Client,
  channelId?: string,
  options: { applyDailyCap?: boolean; rankedSource?: 'text' | 'voice' } = {},
) {
  if (amount <= 0) return;

  const config = await getOrCreateLevelConfig(guildId).catch(() => null);
  const curve = config ? levelCurveFromConfig(config) : DEFAULT_LEVEL_CURVE;

  let finalAmount = amount;
  try {
    // Lecture mise en cache : `addXp` est appelée à chaque message, et le clan
    // vainqueur comme son bonus ne changent qu'à la clôture d'une saison.
    const guildSettings = await getCachedGuild(guildId);

    if (guildSettings?.clanRewardXpBoost && guildSettings.lastWinningClanId) {
      const winnerIds = guildSettings.lastWinningClanId.split(',');
      const winningClans = await prisma.clan.findMany({
        where: { id: { in: winnerIds } },
        select: { roleId: true },
      });

      if (winningClans.length > 0) {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const member = discordGuild.members.cache.get(userId) || await discordGuild.members.fetch(userId).catch(() => null);
          if (member && winningClans.some((c) => member.roles.cache.has(c.roleId))) {
            finalAmount = Math.round(amount * guildSettings.clanRewardXpBoostRate);
          }
        }
      }
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de l'application du multiplicateur d'XP de clan pour ${userId}:`, err);
  }

  // Le plafond se décompte après le boost de clan : il porte sur l'XP réellement
  // créditée, sinon un membre boosté le dépasserait de son propre multiplicateur.
  if (options.applyDailyCap && config && config.dailyXpCap > 0) {
    finalAmount = await consumeDailyXpAllowance(guildId, userId, finalAmount, config.dailyXpCap);
    if (finalAmount <= 0) return;
  }

  const memberLevel = await prisma.memberLevel.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: {
      xp: { increment: finalAmount },
      lastXpGain: new Date(),
    },
    create: {
      guildId,
      userId,
      xp: finalAmount,
      level: 0,
    },
  });

  // Le RP compétitif se greffe ici, sur l'XP *réellement* accordée : il hérite
  // ainsi du cooldown, des exclusions de salons/rôles et du plafond quotidien
  // sans les redéclarer. `creditRpFromXp` avale ses propres erreurs, une panne
  // du classement ne doit pas faire échouer le gain d'XP.
  if (options.rankedSource) {
    await creditRpFromXp(guildId, userId, finalAmount, client, options.rankedSource);
  }

  const previousLevel = memberLevel.level;

  // L'incrément est atomique, donc non borné : on ramène au plafond après coup,
  // comme `removeXp` ramène les négatifs à zéro. Sans ça, une ligne poussée
  // près du maximum de la colonne finirait par faire échouer chaque message.
  let totalXp = memberLevel.xp;
  if (totalXp > MAX_XP) {
    totalXp = MAX_XP;
    await prisma.memberLevel.update({
      where: { guildId_userId: { guildId, userId } },
      data: { xp: MAX_XP },
    });
  }

  // Le niveau est toujours recalculé depuis l'XP totale : ça gère les montées
  // de niveau et auto-répare les lignes dont le niveau était incohérent.
  const newLevel = getLevelFromXp(totalXp, curve);

  if (newLevel !== previousLevel) {
    if (newLevel > previousLevel) {
      // Le niveau et la récompense en KotboCoins doivent être commis ensemble : sinon un
      // échec du crédit (module économie momentanément indisponible, etc.) laisserait le
      // niveau monté sans aucune compensation.
      const coinReward = await getLevelUpCoinReward(guildId, newLevel);
      await prisma.$transaction(async (tx) => {
        await tx.memberLevel.update({
          where: { guildId_userId: { guildId, userId } },
          data: { level: newLevel },
        });
        if (coinReward) {
          await tx.rpgProfile.upsert({
            where: { guildId_userId: { guildId, userId } },
            update: { balance: { increment: coinReward.amount } },
            create: {
              guildId,
              userId,
              balance: coinReward.amount,
              level: 1,
              xp: 0,
              health: 100,
              maxHealth: 100,
              energy: 100,
              attack: 10,
              defense: 10,
              speed: 10,
            },
          });
        }
      });

      // Notification + récompenses annexes (rôles, points de clan) : best-effort, le
      // niveau et les pièces sont déjà garantis commis à ce stade.
      await processLevelUp(guildId, userId, previousLevel, newLevel, curve, client, { fallbackChannelId: channelId, coinReward });
    } else {
      await prisma.memberLevel.update({
        where: { guildId_userId: { guildId, userId } },
        data: { level: newLevel },
      });
      // Correction vers le bas : on retire les rôles attribués en trop, sans message
      await updateMemberLevelRoles(guildId, userId, newLevel, client).catch(() => null);
    }
    return;
  }

  // Niveau inchangé, mais les rôles peuvent l'être : c'est le cas de tous les
  // membres après un changement de courbe, dont la colonne a déjà été réalignée.
  await reconcileRewardRoles(guildId, userId, newLevel, client);
}

/**
 * Retire de l'XP à un membre, sans jamais descendre sous zéro.
 *
 * `addXp` refuse les montants négatifs et c'est très bien ainsi : elle tourne à
 * chaque message, un signe inversé y viderait des comptes. Le retrait a donc sa
 * propre porte, où le décrément reste atomique - le plancher et le niveau sont
 * réécrits juste après, sur la valeur effectivement obtenue.
 */
export async function removeXp(guildId: string, userId: string, amount: number, client: Client) {
  if (amount <= 0) return;

  const updated = await prisma.memberLevel.update({
    where: { guildId_userId: { guildId, userId } },
    data: { xp: { decrement: Math.floor(amount) } },
  }).catch((err: { code?: string }) => {
    // P2025 : pas de ligne, donc rien à retirer - le membre n'a jamais gagné
    // d'XP. Tout le reste est une panne et n'a rien à faire dans le silence.
    if (err?.code !== 'P2025') {
      logger.error('LevelingService', `Retrait d'XP impossible pour ${userId} sur ${guildId}:`, err);
    }
    return null;
  });
  if (!updated) return;

  const curve = await getGuildLevelCurve(guildId);
  const xp = Math.max(0, updated.xp);
  const newLevel = getLevelFromXp(xp, curve);
  if (xp === updated.xp && newLevel === updated.level) return;

  await prisma.memberLevel.update({
    where: { guildId_userId: { guildId, userId } },
    data: { xp, level: newLevel },
  });

  // Descente de niveau : les rôles de récompense acquis au-dessus repartent,
  // sans message - personne n'a besoin d'être prévenu qu'il a perdu un niveau.
  if (newLevel < updated.level) {
    await updateMemberLevelRoles(guildId, userId, newLevel, client).catch(() => null);
  }
}

/** KotboCoins accordés pour la montée au niveau `level`. */
export function levelUpCoinReward(level: number): number {
  return level * 20;
}

/**
 * Somme des récompenses de montée de niveau reçues par un membre arrivé au niveau `level`,
 * soit `20 * (1 + 2 + ... + level)`. Sert à restituer ces pièces après une remise à zéro
 * des profils RPG : elles ont été gagnées par l'activité sur le serveur, pas dans le RPG.
 */
export function totalLevelUpCoins(level: number): number {
  if (level <= 0) return 0;
  return 10 * level * (level + 1);
}

/**
 * Calcule (sans l'appliquer) la récompense en KotboCoins due pour une montée de niveau.
 */
async function getLevelUpCoinReward(guildId: string, newLevel: number): Promise<{ amount: number; currencyEmoji: string; currencyName: string } | null> {
  try {
    const { getOrCreateEconomyConfig } = await import('../features/economyService.js');
    const econConfig = await getOrCreateEconomyConfig(guildId).catch(() => null);
    if (!econConfig || !econConfig.enabled) return null;
    return {
      amount: levelUpCoinReward(newLevel),
      currencyEmoji: econConfig.currencyEmoji,
      currencyName: econConfig.currencyName,
    };
  } catch (err) {
    logger.error('LevelingService', "Erreur lors du calcul du bonus d'économie pour le level up :", err);
    return null;
  }
}

/**
 * Fixe l'XP totale d'un utilisateur à une valeur donnée (au lieu de l'incrémenter)
 * et gère le passage/la perte de niveau qui en découle.
 */
export async function setXp(guildId: string, userId: string, newXp: number, client: Client, channelId?: string) {
  const clampedXp = clampXp(newXp);

  const memberLevel = await prisma.memberLevel.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: { xp: clampedXp },
    create: {
      guildId,
      userId,
      xp: clampedXp,
      level: 0,
    },
  });

  const previousLevel = memberLevel.level;
  const curve = await getGuildLevelCurve(guildId);
  const newLevel = getLevelFromXp(clampedXp, curve);

  if (newLevel !== previousLevel) {
    if (newLevel > previousLevel) {
      // Voir addXp() : niveau et récompense en KotboCoins doivent être commis ensemble.
      const coinReward = await getLevelUpCoinReward(guildId, newLevel);
      await prisma.$transaction(async (tx) => {
        await tx.memberLevel.update({
          where: { guildId_userId: { guildId, userId } },
          data: { level: newLevel },
        });
        if (coinReward) {
          await tx.rpgProfile.upsert({
            where: { guildId_userId: { guildId, userId } },
            update: { balance: { increment: coinReward.amount } },
            create: {
              guildId,
              userId,
              balance: coinReward.amount,
              level: 1,
              xp: 0,
              health: 100,
              maxHealth: 100,
              energy: 100,
              attack: 10,
              defense: 10,
              speed: 10,
            },
          });
        }
      });
      await processLevelUp(guildId, userId, previousLevel, newLevel, curve, client, { fallbackChannelId: channelId, coinReward, creditClanPoints: false });
    } else {
      await prisma.memberLevel.update({
        where: { guildId_userId: { guildId, userId } },
        data: { level: newLevel },
      });
      await updateMemberLevelRoles(guildId, userId, newLevel, client).catch(() => null);
    }
  }

  return { xp: clampedXp, level: newLevel };
}

/**
 * Gère les notifications de level up et l'attribution des rôles récompenses
 */
async function processLevelUp(
  guildId: string,
  userId: string,
  previousLevel: number,
  newLevel: number,
  curve: LevelCurve,
  client: Client,
  options: {
    fallbackChannelId?: string;
    coinReward?: { amount: number; currencyEmoji: string; currencyName: string } | null;
    /**
     * Les points de clan récompensent l'activité. Un ajustement manuel du staff
     * fait franchir des dizaines de niveaux d'un coup : en mode proportionnel,
     * les verser reviendrait à offrir au clan du membre des milliers de points
     * pour une correction administrative.
     */
    creditClanPoints?: boolean;
  } = {},
) {
  const { fallbackChannelId, coinReward, creditClanPoints = true } = options;

  // Avant toute résolution Discord : un membre parti entre-temps annule les
  // notifications et les rôles, pas le fait qu'il ait monté de niveau.
  kotboEventBus.publish('level:up', {
    guildId,
    userId,
    previousLevel,
    level: newLevel,
    timestamp: Date.now(),
  });

  try {
    const config = await getOrCreateLevelConfig(guildId);
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (!member) return;

    // 0. Attribution des points de clan pour la montée de niveau si activé
    try {
      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          clansEnabled: true,
          currentClanSeason: true,
          clanXpFromLevelUp: true,
          clanXpPerLevelUp: true,
          clanXpLevelUpProportional: true,
          clanXpReferenceLevel: true,
        }
      });
      const clanPoints = guildConfig
        ? computeClanLevelUpPoints(previousLevel, newLevel, {
            flatPerLevelUp: guildConfig.clanXpPerLevelUp,
            proportional: guildConfig.clanXpLevelUpProportional === true,
            referenceLevel: guildConfig.clanXpReferenceLevel ?? 25,
          }, curve)
        : 0;
      if (creditClanPoints && guildConfig?.clansEnabled && guildConfig?.clanXpFromLevelUp && clanPoints > 0) {
        const clans = await prisma.clan.findMany({
          where: { guildId },
          select: { id: true, roleId: true }
        });
        if (clans.length > 0) {
          const clanRoleIds = clans.map(c => c.roleId);
          const memberClanRole = member.roles.cache.find(r => clanRoleIds.includes(r.id));
          if (memberClanRole) {
            const clan = clans.find(c => c.roleId === memberClanRole.id);
            if (clan) {
              const { getAllLinkedUserIds } = await import('../moderation/altAccountService.js');
              const linkedIds = await getAllLinkedUserIds(guildId, userId).catch(() => [userId]);
              const canonicalUserId = linkedIds.sort()[0];

              const { creditClanContribution, logClanContribution } = await import('../community/clanService.js');
              const { granted, debtRepaid } = await creditClanContribution({
                guildId,
                clanId: clan.id,
                userId: canonicalUserId,
                season: guildConfig.currentClanSeason,
                amount: clanPoints,
              });

              // Le flux public reçoit le gain brut : la part partie en
              // remboursement d'une dette y est déjà journalisée à part, en
              // négatif. Loguer le net ferait deux lignes qui ne s'additionnent
              // pas au gain annoncé au membre.
              const earned = granted + debtRepaid;
              if (earned > 0) {
                await logClanContribution(guildId, clan.id, canonicalUserId, earned, 'XP', guildConfig.currentClanSeason);
              }

              logger.info('LevelingService', `Points de clan (${earned}) attribués à ${member.user.tag} pour son passage au niveau ${newLevel} dans le clan "${clan.id}"`);
            }
          }
        }
      }
    } catch (clanErr) {
      logger.error('LevelingService', `Erreur lors de l'attribution des points de clan pour le level up de ${userId}:`, clanErr);
    }

    // 1. Attribution des rôles de récompense
    const rewards = await prisma.levelRoleReward.findMany({
      where: { guildId },
      orderBy: { level: 'asc' },
    });

    if (rewards.length > 0) {
      const rolesToAdd: string[] = [];
      const rolesToRemove: string[] = [];

      for (const reward of rewards) {
        if (newLevel >= reward.level) {
          if (!member.roles.cache.has(reward.roleId)) {
            rolesToAdd.push(reward.roleId);
          }
        } else {
          // Si configuration de cumul de rôles désactivée, on pourrait enlever les rôles supérieurs.
          // Mais dans tous les cas, si le membre a perdu des niveaux, on retire.
          if (member.roles.cache.has(reward.roleId)) {
            rolesToRemove.push(reward.roleId);
          }
        }
      }

      // Optionnel: Garder uniquement la récompense la plus élevée si le cumul est désactivé
      if (!config.stackRewards) {
        const eligibleRewards = rewards.filter(r => newLevel >= r.level);
        if (eligibleRewards.length > 1) {
          const _highestReward = eligibleRewards[eligibleRewards.length - 1];
          // Retirer tous les autres rôles récompenses plus bas
          for (const prevReward of eligibleRewards.slice(0, -1)) {
            if (member.roles.cache.has(prevReward.roleId) && !rolesToRemove.includes(prevReward.roleId)) {
              rolesToRemove.push(prevReward.roleId);
            }
            const addIdx = rolesToAdd.indexOf(prevReward.roleId);
            if (addIdx !== -1) rolesToAdd.splice(addIdx, 1);
          }
        }
      }

      // Appliquer les changements de rôles
      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove).catch(e => logger.warn('LevelingService', `Impossible de retirer les rôles récompenses à ${userId}:`, e));
      }
      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd).catch(e => logger.warn('LevelingService', `Impossible d'ajouter les rôles récompenses à ${userId}:`, e));
      }
    }

    // 1.5. Le crédit des KotboCoins a déjà été commis atomiquement avec le niveau (voir
    // addXp/setXp) ; on ne fait ici que construire le texte de notification.
    //
    // Cette phrase est collée au modèle de l'admin sans qu'il puisse la
    // toucher : elle suit donc la langue du serveur, sinon un serveur
    // anglophone qui traduit son message garde une phrase française au bout.
    const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
    const coinRewardText = coinReward
      ? ` ${m.leveling_coin_reward({
          amount: coinReward.amount,
          emoji: coinReward.currencyEmoji,
          currency: coinReward.currencyName,
        }, { locale })}`
      : '';

    // 2. Envoi du message de félicitations
    //
    // Un message vide veut dire « celui par defaut », jamais « n'annonce
    // rien » : il est alors compose maintenant, dans la langue du serveur, et
    // suit donc le bot si celui-ci change de langue plus tard.
    const msgTemplate = config.levelUpMessage?.trim() || defaultLevelUpMessage(locale);
    const msg = msgTemplate
      .replace(/{user}/g, `<@${userId}>`)
      .replace(/{username}/g, member.user.username)
      .replace(/{level}/g, String(newLevel)) + coinRewardText;

    if (config.levelUpChannelId === 'DM') {
      const dmChannel = await member.createDM().catch(() => null);
      if (dmChannel) {
        await dmChannel.send(msg).catch(() => null);
      }
    } else if (config.levelUpChannelId && config.levelUpChannelId !== 'current') {
      const targetChannel = discordGuild.channels.cache.get(config.levelUpChannelId);
      if (targetChannel?.isTextBased()) {
        await targetChannel.send(msg).catch(() => null);
      }
    } else if (fallbackChannelId) {
      const currentChannel = discordGuild.channels.cache.get(fallbackChannelId);
      if (currentChannel?.isTextBased()) {
        await currentChannel.send(msg).catch(() => null);
      }
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de la gestion du level up pour ${userId}:`, err);
  }
}

/**
 * Récupère le rang, l'XP et le niveau d'un membre
 */
export async function getMemberRankData(guildId: string, userId: string) {
  const levels = await prisma.memberLevel.findMany({
    where: { guildId },
    orderBy: { xp: 'desc' },
  });

  const rankIndex = levels.findIndex(l => l.userId === userId);
  const rank = rankIndex === -1 ? levels.length + 1 : rankIndex + 1;

  const memberLevel = levels.find(l => l.userId === userId) ?? null;
  const xp = memberLevel?.xp ?? 0;

  // L'XP est la source de vérité : on recalcule le niveau et on auto-répare la
  // ligne si elle est incohérente (ex. niveau importé d'un autre bot). Sans
  // ligne du tout, le membre reste au niveau 0 : il n'a jamais gagné d'XP, et
  // le niveau 1 que 0 XP vaut sur la courbe se lirait comme une progression.
  const curve = await getGuildLevelCurve(guildId);
  const level = memberLevel ? getLevelFromXp(memberLevel.xp, curve) : 0;
  if (memberLevel && level !== memberLevel.level) {
    prisma.memberLevel
      .update({
        where: { guildId_userId: { guildId, userId } },
        data: { level },
      })
      .catch(err => logger.error('LevelingService', `Auto-réparation du niveau échouée pour ${userId}:`, err));
  }

  const currentLevelXp = getXpForLevel(level - 1, curve);
  const nextLevelXp = getXpForLevel(level, curve);

  const xpRequiredForNextLevel = nextLevelXp - currentLevelXp;
  // Au niveau maximum l'XP continue de monter sans palier suivant : borner la
  // part du niveau en cours évite que les barres de progression construites
  // depuis ce ratio dépassent 100 %.
  const xpInCurrentLevel = Math.min(Math.max(0, xp - currentLevelXp), xpRequiredForNextLevel);

  return {
    level,
    xp,
    xpInCurrentLevel,
    xpRequiredForNextLevel,
    rank,
    totalXp: xp,
  };
}

export type RankCardSubject = {
  userId: string;
  displayName: string;
  username: string;
  discriminator: string;
  avatarUrl: string;
  status: string;
};

export async function generateRankCard(
  member: GuildMember,
  level: number,
  xp: number,
  rank: number,
  customization?: RankCardCustomization,
  curve?: LevelCurve,
): Promise<Buffer> {
  return renderRankCard(
    {
      userId: member.id,
      displayName: member.displayName,
      username: member.user.username,
      discriminator: member.user.discriminator,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
      // La pastille de statut suit le refus de suivi de présence du membre :
      // coupé, la carte le rend hors-ligne pour tout le monde.
      status: (await visiblePresenceStatus(member.guild.id, member.id, member.presence?.status ?? null)) ?? 'offline',
    },
    level,
    xp,
    rank,
    customization,
    curve ?? await getGuildLevelCurve(member.guild.id),
  );
}

/**
 * Rendu détaché de discord.js : le dashboard prévisualise la même carte sans
 * qu'un `GuildMember` soit disponible.
 */
export async function renderRankCard(
  subject: RankCardSubject,
  level: number,
  xp: number,
  rank: number,
  customization?: RankCardCustomization,
  curve: LevelCurve = DEFAULT_LEVEL_CURVE,
): Promise<Buffer> {
  const W = RANK_CARD_WIDTH, H = RANK_CARD_HEIGHT;
  const custom = customization ?? await getRankCardCustomization(subject.userId);
  const preset = getRankCardBackground(custom.backgroundId);
  const accentStart = preset.accentBar[0].color;
  const accentEnd = preset.accentBar[preset.accentBar.length - 1].color;
  ensureCanvasFonts();
  ensureRankCardFonts();
  const fontStack = rankCardFontStack(getRankCardFont(custom.fontId));
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  for (const stop of preset.gradient) bg.addColorStop(stop.offset, stop.color);
  roundRect(ctx, 0, 0, W, H, 22, bg);

  // Accent bar (top)
  const topBar = ctx.createLinearGradient(0, 0, W, 0);
  for (const stop of preset.accentBar) topBar.addColorStop(stop.offset, stop.color);
  ctx.fillStyle = topBar;
  ctx.fillRect(0, 0, W, 3);

  // Glows
  for (const glow of preset.glows) {
    const cx = W * glow.x, cy = H * glow.y;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow.radius);
    gradient.addColorStop(0, glow.color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  }

  // Avatar
  const avatarUrl = subject.avatarUrl;
  const avatarCX = 115, avatarCY = 130, avatarR = 62;

  // Avatar ring
  const ringGrad = ctx.createLinearGradient(avatarCX - avatarR, avatarCY - avatarR, avatarCX + avatarR, avatarCY + avatarR);
  ringGrad.addColorStop(0, accentStart);
  ringGrad.addColorStop(1, accentEnd);
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR + 4, 0, Math.PI * 2);
  ctx.fillStyle = ringGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR + 1, 0, Math.PI * 2);
  ctx.fillStyle = preset.avatarBackdrop;
  ctx.fill();

  try {
    const avatarImg = await loadRankCardAvatar(avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, avatarCX - avatarR, avatarCY - avatarR, avatarR * 2, avatarR * 2);
    ctx.restore();
  } catch {
    ctx.fillStyle = accentStart;
    ctx.beginPath();
    ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Status indicator
  const status = subject.status;
  const statusColor = status === 'online' ? '#3ba55d' : status === 'idle' ? '#faa81a' : status === 'dnd' ? '#ed4245' : '#747f8d';
  ctx.beginPath();
  ctx.arc(avatarCX + 45, avatarCY + 45, 14, 0, Math.PI * 2);
  ctx.fillStyle = preset.avatarBackdrop;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(avatarCX + 45, avatarCY + 45, 10, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  ctx.fill();

  // Bloc RANG / NIVEAU : mesuré avant d'être tracé, car sa bordure gauche borne
  // la place du pseudo. Les deux partagent la même ligne, et la police du pseudo
  // étant au choix du membre, sa largeur ne peut plus être devinée.
  const rankVal = `#${rank}`;
  const levelVal = `${level}`;
  ctx.font = 'bold 38px sans-serif';
  const rankValW = ctx.measureText(rankVal).width;
  const levelValW = ctx.measureText(levelVal).width;
  ctx.font = 'bold 14px sans-serif';
  const rankLabelW = ctx.measureText('RANG ').width;
  const levelLabelW = ctx.measureText('NIVEAU ').width;
  const levelX = W - 45 - rankValW - rankLabelW - 28;
  const rightBlockLeft = levelX - levelValW - levelLabelW;

  // Name & tag
  const nameX = 210;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 30px ${fontStack}`;
  ctx.fillText(fitText(ctx, subject.displayName, rightBlockLeft - nameX - 24), nameX, 80);

  // Le tag garde la police neutre : seule la graisse Bold des familles du
  // catalogue est embarquee, et un 17px normal retomberait de toute facon sur
  // le repli. C est aussi la ligne secondaire, elle n a pas a etre decoree.
  const tagText = subject.discriminator !== '0' ? `#${subject.discriminator}` : `@${subject.username}`;
  ctx.fillStyle = '#6e7681';
  ctx.font = '17px sans-serif';
  const emojiBandW = rankCardEmojiBandWidth(custom.emojis.length);
  const fittedTag = fitText(ctx, tagText, W - 45 - nameX - emojiBandW);
  ctx.fillText(fittedTag, nameX, 106);
  const tagWidth = ctx.measureText(fittedTag).width;

  await drawRankCardEmojis(ctx, custom.emojis, nameX + tagWidth + 16, 99);

  // Rank & Level (right side)
  ctx.textAlign = 'right';

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(rankVal, W - 45, 72);

  ctx.fillStyle = accentStart;
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('RANG ', W - 45 - rankValW, 72);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(levelVal, levelX, 72);

  ctx.fillStyle = accentEnd;
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('NIVEAU ', levelX - levelValW, 72);

  ctx.textAlign = 'left';

  // XP text
  const safeLevel = getLevelFromXp(xp, curve);
  const prevXpNeeded = getXpForLevel(safeLevel - 1, curve);
  const nextXpNeeded = getXpForLevel(safeLevel, curve);
  const xpRequiredForNextLevel = Math.max(1, nextXpNeeded - prevXpNeeded);
  // Bornée au palier : au niveau maximum l'XP continue de monter alors que le
  // palier suivant n'existe plus, et la carte afficherait « 150 000 / 30 000 ».
  const xpInCurrentLevel = Math.min(Math.max(0, xp - prevXpNeeded), xpRequiredForNextLevel);
  const progressPercent = Math.min(1, Math.max(0, xpInCurrentLevel / xpRequiredForNextLevel));

  ctx.fillStyle = '#6e7681';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${xpInCurrentLevel.toLocaleString('fr-FR')} / ${xpRequiredForNextLevel.toLocaleString('fr-FR')} XP`, W - 45, 155);
  ctx.textAlign = 'left';

  // Progress bar
  const barX = nameX, barY = 175, barW = W - nameX - 45, barH = 22, barR = 11;
  roundRect(ctx, barX, barY, barW, barH, barR, 'rgba(255,255,255,0.06)');

  if (progressPercent > 0) {
    const filledW = Math.max(barH, barW * progressPercent);
    const grad = ctx.createLinearGradient(barX, 0, barX + filledW, 0);
    grad.addColorStop(0, accentStart);
    grad.addColorStop(1, accentEnd);
    roundRect(ctx, barX, barY, filledW, barH, barR, grad);
  }

  // Bottom text
  ctx.fillStyle = '#3b4048';
  ctx.font = '11px sans-serif';
  ctx.fillText('Kotbo · Progression', nameX, barY + barH + 28);

  ctx.textAlign = 'right';
  const totalXpText = `${xp.toLocaleString('fr-FR')} XP total`;
  ctx.fillText(totalXpText, W - 45, barY + barH + 28);
  ctx.textAlign = 'left';

  // Bottom accent bar
  const bottomBar = ctx.createLinearGradient(0, 0, W, 0);
  for (const stop of preset.accentBar) bottomBar.addColorStop(stop.offset, stop.color);
  ctx.save();
  // Le liseré du bas s'estompe sur les bords : on reprend le dégradé du haut
  // avec un masque d'opacité plutôt que de dupliquer les couleurs en rgba.
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = bottomBar;
  ctx.fillRect(0, H - 2, W, 2);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

// L URL porte deja le hash d avatar : un changement de photo produit une autre
// cle, le TTL ne sert qu a borner la taille du cache. L apercu du dashboard
// rerend a chaque frappe, sans quoi chaque rendu repayait un aller-retour CDN.
const AVATAR_CACHE_TTL_MS = 10 * 60 * 1000;
const AVATAR_CACHE_MAX = 200;
const avatarImageCache = new Map<string, { image: Image; expiresAt: number }>();

async function loadRankCardAvatar(url: string): Promise<Image> {
  const now = Date.now();
  const cached = avatarImageCache.get(url);
  if (cached && cached.expiresAt > now) return cached.image;

  const image = await loadImage(url);

  if (avatarImageCache.size >= AVATAR_CACHE_MAX) {
    for (const [key, entry] of avatarImageCache) {
      if (entry.expiresAt <= now) avatarImageCache.delete(key);
    }
    // Insertion ordonnee : a defaut d entrees expirees, on evince la plus ancienne.
    if (avatarImageCache.size >= AVATAR_CACHE_MAX) {
      const oldest = avatarImageCache.keys().next().value;
      if (oldest !== undefined) avatarImageCache.delete(oldest);
    }
  }

  avatarImageCache.set(url, { image, expiresAt: now + AVATAR_CACHE_TTL_MS });
  return image;
}

const RANK_FONT_DIR = fileURLToPath(new URL('../../../assets/rank-fonts/', import.meta.url));

let rankFontsRegistered = false;

/**
 * Enregistre les polices du catalogue auprès du canvas. Une police absente ou
 * illisible est seulement journalisée : la pile de familles retombe alors sur
 * DejaVu, ce qui donne une carte moins jolie mais jamais une carte cassée.
 */
function ensureRankCardFonts(): void {
  if (rankFontsRegistered) return;
  rankFontsRegistered = true;

  for (const font of RANK_CARD_FONTS) {
    if (!font.family) continue;
    const file = `${RANK_FONT_DIR}${font.id}.ttf`;
    try {
      if (!GlobalFonts.registerFromPath(file, font.family)) {
        logger.warn('RankCard', `Police ${font.id} refusée par le canvas (${file})`);
      }
    } catch (error) {
      logger.warn('RankCard', `Police ${font.id} illisible:`, error);
    }
  }
}

const RANK_EMOJI_SIZE = 26, RANK_EMOJI_GAP = 8;

function rankCardEmojiBandWidth(count: number): number {
  if (count <= 0) return 0;
  // Le decalage de 16 px qui separe le tag de la bande est compte ici, pour que
  // l appelant n ait qu une seule largeur a reserver.
  return 16 + count * RANK_EMOJI_SIZE + (count - 1) * RANK_EMOJI_GAP;
}

/**
 * Tronque au caractère près pour tenir dans `maxWidth`, ellipse comprise.
 *
 * Le découpage passe par les points de code et non par `slice` : un pseudo peut
 * contenir des emojis, et couper au milieu d'une paire de substitution
 * afficherait un caractère de remplacement. `ctx.font` doit être positionné
 * avant l'appel, la mesure en dépend.
 */
function fitText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;

  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const candidate = `${chars.join('')}…`;
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  return '…';
}

const RANK_EMOJI_DIR = fileURLToPath(new URL('../../../assets/rank-emojis/', import.meta.url));

// `null` memorise un asset manquant : sans lui, un fichier absent relancait un
// acces disque a chaque carte rendue.
const emojiImageCache = new Map<string, Image | null>();

async function loadRankCardEmoji(emoji: string): Promise<Image | null> {
  const codePoint = rankCardEmojiCodePoint(emoji);
  if (!codePoint) return null;

  const cached = emojiImageCache.get(codePoint);
  if (cached !== undefined) return cached;

  try {
    const image = await loadImage(`${RANK_EMOJI_DIR}${codePoint}.png`);
    emojiImageCache.set(codePoint, image);
    return image;
  } catch (error) {
    logger.warn('RankCard', `Asset emoji ${codePoint}.png illisible:`, error);
    emojiImageCache.set(codePoint, null);
    return null;
  }
}

async function drawRankCardEmojis(
  ctx: SKRSContext2D,
  emojis: string[],
  startX: number,
  centerY: number,
): Promise<void> {
  let x = startX;

  for (const emoji of emojis) {
    const image = await loadRankCardEmoji(emoji);
    if (!image) continue;

    ctx.drawImage(image, x, centerY - RANK_EMOJI_SIZE / 2, RANK_EMOJI_SIZE, RANK_EMOJI_SIZE);
    x += RANK_EMOJI_SIZE + RANK_EMOJI_GAP;
  }
}

// Helper pour dessiner des rectangles arrondis
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Met à jour les rôles de récompense pour un utilisateur en fonction de son niveau,
 * sans envoyer de message dans le chat (utile pour les imports).
 */
export async function updateMemberLevelRoles(guildId: string, userId: string, level: number, client: Client) {
  try {
    const config = await getOrCreateLevelConfig(guildId);
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const rewards = await prisma.levelRoleReward.findMany({
      where: { guildId },
      orderBy: { level: 'asc' },
    });

    if (rewards.length > 0) {
      const rolesToAdd: string[] = [];
      const rolesToRemove: string[] = [];

      for (const reward of rewards) {
        if (level >= reward.level) {
          if (!member.roles.cache.has(reward.roleId)) {
            rolesToAdd.push(reward.roleId);
          }
        } else {
          if (member.roles.cache.has(reward.roleId)) {
            rolesToRemove.push(reward.roleId);
          }
        }
      }

      if (!config.stackRewards) {
        const eligibleRewards = rewards.filter(r => level >= r.level);
        if (eligibleRewards.length > 1) {
          const _highestReward = eligibleRewards[eligibleRewards.length - 1];
          for (const prevReward of eligibleRewards.slice(0, -1)) {
            if (member.roles.cache.has(prevReward.roleId) && !rolesToRemove.includes(prevReward.roleId)) {
              rolesToRemove.push(prevReward.roleId);
            }
            const addIdx = rolesToAdd.indexOf(prevReward.roleId);
            if (addIdx !== -1) rolesToAdd.splice(addIdx, 1);
          }
        }
      }

      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove).catch(e => logger.warn('LevelingService', `Impossible de retirer les rôles récompenses à ${userId}:`, e));
      }
      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd).catch(e => logger.warn('LevelingService', `Impossible d'ajouter les rôles récompenses à ${userId}:`, e));
      }
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de la mise à jour des rôles de niveau pour ${userId}:`, err);
  }
}
