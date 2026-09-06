/**
 * Configuration du module Ranked (RP compétitif).
 *
 * La config est lue à chaque gain d'XP : elle est donc mise en cache comme
 * `LevelConfig`, avec la même invalidation explicite après écriture. Laisser
 * expirer le TTL ferait tourner la guilde une minute sur ses anciens réglages.
 */

import type { RankedConfig } from '@prisma/client';
import {
  DEFAULT_STREAK_CONFIG,
  LADDER_CURVE_LIMITS,
  generateRankedLadder,
  normalizeLadderCurve,
  normalizeRankedLadder,
  rankedFloorRp,
  type DecayConfig,
  type LadderCurve,
  type RankedLadder,
  type StreakConfig,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';

const CONFIG_TTL_SECONDS = 60;

function configCacheKey(guildId: string): string {
  return `guild:${guildId}:ranked_config`;
}

function ladderCacheKey(guildId: string): string {
  return `guild:${guildId}:ranked_ladder`;
}

export async function getOrCreateRankedConfig(guildId: string): Promise<RankedConfig> {
  const key = configCacheKey(guildId);
  const cached = await cache.get<RankedConfig>(key);
  if (cached) return cached;

  let config = await prismaRead.rankedConfig.findUnique({ where: { guildId } });

  if (!config) {
    // La guilde doit exister avant la config, qui en dépend par clé étrangère.
    await prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });
    config = await prisma.rankedConfig.create({ data: { guildId } });
  }

  await cache.set(key, config, CONFIG_TTL_SECONDS);
  return config;
}

/**
 * Lecture tolérante à l'échec, pour tout ce qui se greffe sur un chemin chaud
 * (gain d'XP, réaction) : une base momentanément indisponible doit désactiver
 * le RP, pas faire échouer le message.
 */
export async function getRankedConfigSafe(guildId: string): Promise<RankedConfig | null> {
  return getOrCreateRankedConfig(guildId).catch(() => null);
}

export async function invalidateRankedConfigCache(guildId: string): Promise<void> {
  await cache.delete(configCacheKey(guildId));
  await cache.delete(ladderCacheKey(guildId));
}

/** Colonnes réellement modifiables depuis le dashboard ou les commandes. */
export type RankedConfigPatch = Partial<Pick<RankedConfig,
  | 'enabled'
  | 'rpPerXp'
  | 'reactionRp'
  | 'reactionDailyCap'
  | 'dailyRpCap'
  | 'streakEnabled'
  | 'streakBonusPerDay'
  | 'streakMaxBonus'
  | 'streakGraceDays'
  | 'streakWeeklyFreezes'
  | 'streakMaxFreezes'
  | 'decayEnabled'
  | 'decayGraceDays'
  | 'decayRpPerDay'
  | 'decayPercentPerDay'
  | 'decayFloorTierKey'
  | 'tierRolesEnabled'
  | 'tierRolesExclusive'
  | 'ladderTierCount'
  | 'ladderBaseRp'
  | 'ladderExponent'
  | 'ladderDivisions'
  | 'announceChannelId'
  | 'announcePromotions'
  | 'announceDemotions'
  | 'announcePromotionMessage'
  | 'announceDemotionMessage'
  | 'globalLeaderboard'
>> & { ladder?: unknown };

/** Longueur d'un message d'annonce : au-delà, Discord refuse l'envoi. */
const ANNOUNCE_MESSAGE_MAX = 1_800;

const NUMERIC_LIMITS: Record<string, { min: number; max: number; integer: boolean }> = {
  rpPerXp: { min: 0, max: 10, integer: false },
  reactionRp: { min: 0, max: 100, integer: true },
  reactionDailyCap: { min: 0, max: 500, integer: true },
  dailyRpCap: { min: 0, max: 1_000_000, integer: true },
  streakBonusPerDay: { min: 0, max: 1, integer: false },
  streakMaxBonus: { min: 0, max: 5, integer: false },
  streakGraceDays: { min: 0, max: 7, integer: true },
  streakWeeklyFreezes: { min: 0, max: 7, integer: true },
  streakMaxFreezes: { min: 0, max: 14, integer: true },
  decayGraceDays: { min: 0, max: 60, integer: true },
  decayRpPerDay: { min: 0, max: 10_000, integer: true },
  decayPercentPerDay: { min: 0, max: 0.5, integer: false },
  ladderTierCount: { min: LADDER_CURVE_LIMITS.tierCount.min, max: LADDER_CURVE_LIMITS.tierCount.max, integer: true },
  ladderBaseRp: { min: LADDER_CURVE_LIMITS.baseRp.min, max: LADDER_CURVE_LIMITS.baseRp.max, integer: true },
  ladderExponent: { min: LADDER_CURVE_LIMITS.exponent.min, max: LADDER_CURVE_LIMITS.exponent.max, integer: false },
  ladderDivisions: { min: LADDER_CURVE_LIMITS.divisions.min, max: LADDER_CURVE_LIMITS.divisions.max, integer: true },
};

const LADDER_CURVE_KEYS = ['ladderTierCount', 'ladderBaseRp', 'ladderExponent', 'ladderDivisions'] as const;

/**
 * Borne les réglages numériques avant écriture.
 *
 * Les bornes ne sont pas cosmétiques : un `decayPercentPerDay` supérieur à 1
 * viderait un compte en un jour, et un `rpPerXp` démesuré ferait franchir toute
 * l'échelle en un message. La validation vit ici plutôt que dans la route pour
 * couvrir aussi les commandes Discord et le MCP.
 */
export function sanitizeRankedConfigPatch(patch: RankedConfigPatch): RankedConfigPatch {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const limit = NUMERIC_LIMITS[key];
    if (limit) {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      const bounded = Math.min(limit.max, Math.max(limit.min, num));
      clean[key] = limit.integer ? Math.round(bounded) : bounded;
      continue;
    }

    if (typeof value === 'boolean') {
      clean[key] = value;
      continue;
    }

    if (key === 'ladder') {
      // `null` remet l'échelle par défaut ; toute autre valeur est normalisée.
      clean.ladder = value === null ? null : normalizeRankedLadder(value);
      continue;
    }

    if (key === 'announceChannelId' || key === 'decayFloorTierKey') {
      clean[key] = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
      continue;
    }

    // Un message vidé revient au texte traduit par défaut : c'est le seul moyen
    // de revenir en arrière depuis le dashboard, où l'on ne peut que vider un
    // champ. La coupure protège l'envoi Discord, pas la base.
    if (key === 'announcePromotionMessage' || key === 'announceDemotionMessage') {
      const text = typeof value === 'string' ? value.trim() : '';
      clean[key] = text.length > 0 ? text.slice(0, ANNOUNCE_MESSAGE_MAX) : null;
      continue;
    }
  }

  return clean as RankedConfigPatch;
}

export async function updateRankedConfig(guildId: string, patch: RankedConfigPatch): Promise<RankedConfig> {
  const data = sanitizeRankedConfigPatch(patch) as Record<string, unknown>;
  const current = await getOrCreateRankedConfig(guildId);

  // Une courbe reçue redéfinit l'échelle : laisser les deux diverger ferait
  // décrire aux curseurs des paliers que le bot n'applique pas. Une échelle
  // envoyée explicitement l'emporte : c'est une retouche palier par palier, qui
  // ne correspond alors plus à aucune courbe - le dashboard le signale.
  const curveTouched = LADDER_CURVE_KEYS.some((key) => data[key] !== undefined);
  if (curveTouched && data.ladder === undefined) {
    data.ladder = generateRankedLadder(ladderCurveFromConfig({ ...current, ...data } as RankedConfig));
  }

  const config = await prisma.rankedConfig.update({
    where: { guildId },
    data: data as never,
  });

  await invalidateRankedConfigCache(guildId);

  // L'allumage doit remonter au registre de modules, sinon la page Modules
  // affiche « inactif » pendant que la page et le bot fonctionnent. La bascule
  // du registre redescend ici de son côté (`moduleActivationService`) : les deux
  // sens sont couverts, et l'écriture est idempotente donc le renvoi ne boucle
  // pas. Import différé : le registre importe déjà ce fichier.
  if (typeof data.enabled === 'boolean') {
    const { setDashboardModuleStatus } = await import('../../core/moduleActivationService.js');
    await setDashboardModuleStatus(guildId, 'prestige', data.enabled).catch(() => null);
  }

  return config;
}

/** Réglages du générateur d'échelle tels qu'ils sont enregistrés. */
export function ladderCurveFromConfig(config: RankedConfig): LadderCurve {
  return normalizeLadderCurve({
    tierCount: config.ladderTierCount,
    baseRp: config.ladderBaseRp,
    exponent: config.ladderExponent,
    divisions: config.ladderDivisions,
  });
}

/** Échelle effective de la guilde : la sienne si elle en a une, sinon celle par défaut. */
export async function getGuildLadder(guildId: string): Promise<RankedLadder> {
  const key = ladderCacheKey(guildId);
  const cached = await cache.get<RankedLadder>(key);
  if (cached) return cached;

  const config = await getRankedConfigSafe(guildId);
  const ladder = normalizeRankedLadder(config?.ladder ?? null);

  await cache.set(key, ladder, CONFIG_TTL_SECONDS);
  return ladder;
}

export function streakConfigFromRankedConfig(config: RankedConfig | null): StreakConfig {
  if (!config) return DEFAULT_STREAK_CONFIG;
  return {
    graceDays: config.streakGraceDays,
    bonusPerDay: config.streakEnabled ? config.streakBonusPerDay : 0,
    maxBonus: config.streakEnabled ? config.streakMaxBonus : 0,
  };
}

export function decayConfigFromRankedConfig(config: RankedConfig, ladder: RankedLadder): DecayConfig {
  return {
    enabled: config.decayEnabled,
    graceDays: config.decayGraceDays,
    rpPerDay: config.decayRpPerDay,
    percentPerDay: config.decayPercentPerDay,
    floorRp: rankedFloorRp(config.decayFloorTierKey, ladder),
  };
}

// ---------------------------------------------------------------------------
// Rôles de palier
// ---------------------------------------------------------------------------

export async function getTierRoles(guildId: string) {
  return prismaRead.rankedTierRole.findMany({ where: { guildId } });
}

export async function setTierRole(guildId: string, tierKey: string, roleId: string) {
  await prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });
  return prisma.rankedTierRole.upsert({
    where: { guildId_tierKey: { guildId, tierKey } },
    update: { roleId },
    create: { guildId, tierKey, roleId },
  });
}

export async function removeTierRole(guildId: string, tierKey: string): Promise<boolean> {
  const deleted = await prisma.rankedTierRole.deleteMany({ where: { guildId, tierKey } });
  return deleted.count > 0;
}
