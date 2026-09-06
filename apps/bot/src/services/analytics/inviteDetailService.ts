/**
 * inviteDetailService.ts
 *
 * Blocs enrichis de la vue détaillée d'un code d'invitation :
 *  - retention : survie J1/J7/J30 des membres entrés par ce code, durée de vie moyenne
 *  - quality   : activité, niveau, statut fantôme et sanctions des invités, comparés au serveur
 *  - timing    : répartition horaire / hebdomadaire des arrivées + cumul sur la période
 *  - ranking   : place de ce code parmi tous les codes de la guilde
 *
 * Séparé de la route pour rester testable et pour ne pas alourdir members.ts.
 * Toutes les lectures passent par prismaRead (réplica si configuré).
 */

import { normalizeTimezone } from '@kotbo/contracts';
import { prismaRead } from '../../utils/db.js';
import { BucketZoner } from './zonedBuckets.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Au-delà, les requêtes `IN (...)` deviennent le goulot : on échantillonne les arrivées les plus récentes. */
const MAX_ANALYZED_JOINS = 2000;

export interface InviteJoinRow {
  userId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number | null, digits = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Survie à J+n : part des arrivées assez anciennes pour être jugées qui sont
 * restées au moins n jours. Les arrivées trop récentes sont exclues du
 * dénominateur, sinon un code créé hier afficherait 0 % de survie à 30 jours.
 */
function survivalAt(joins: InviteJoinRow[], days: number): { rate: number | null; eligible: number } {
  const threshold = days * DAY_MS;
  const now = Date.now();
  const eligible = joins.filter((j) => now - j.joinedAt.getTime() >= threshold);
  if (eligible.length === 0) return { rate: null, eligible: 0 };
  const survived = eligible.filter(
    (j) => !j.leftAt || j.leftAt.getTime() - j.joinedAt.getTime() >= threshold,
  ).length;
  return { rate: Math.round((survived / eligible.length) * 1000) / 10, eligible: eligible.length };
}

function buildRetention(joins: InviteJoinRow[]) {
  const total = joins.length;
  const left = joins.filter((j) => j.leftAt !== null);
  const stayed = total - left.length;

  const lifetimes = left
    .map((j) => (j.leftAt!.getTime() - j.joinedAt.getTime()) / DAY_MS)
    .filter((d) => d >= 0);

  const sameDayLeavers = lifetimes.filter((d) => d < 1).length;

  return {
    total,
    stayed,
    left: left.length,
    retentionPct: total > 0 ? Math.round((stayed / total) * 1000) / 10 : null,
    survival: {
      d1: survivalAt(joins, 1),
      d7: survivalAt(joins, 7),
      d30: survivalAt(joins, 30),
    },
    avgLifetimeDays: lifetimes.length ? round(lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length) : null,
    medianLifetimeDays: round(median(lifetimes)),
    // Départs le jour même : signal de trafic de mauvaise qualité (bots, raids, faux comptes).
    sameDayLeavers,
    sameDayLeaversPct: total > 0 ? Math.round((sameDayLeavers / total) * 1000) / 10 : null,
  };
}

async function buildQuality(guildId: string, joins: InviteJoinRow[]) {
  const userIds = joins.map((j) => j.userId);
  if (userIds.length === 0) {
    return {
      analyzed: 0,
      avgMessages: null, guildAvgMessages: null,
      avgLevel: null, guildAvgLevel: null,
      ghost: { ACTIVE: 0, SPECTATOR: 0, INACTIVE: 0, NEW: 0, UNKNOWN: 0 },
      bots: 0, youngAccounts: 0, youngAccountsPct: null,
      sanctionedMembers: 0, sanctionsCount: 0, topSanctioned: [],
    };
  }

  const [profiles, levels, sanctions, guildAverages] = await Promise.all([
    prismaRead.memberProfile.findMany({
      where: { guildId, userId: { in: userIds } },
      select: { userId: true, userTag: true, username: true, messageCount: true, isBot: true, ghostStatus: true, accountCreatedAt: true },
    }),
    prismaRead.memberLevel.findMany({
      where: { guildId, userId: { in: userIds } },
      select: { userId: true, level: true },
    }),
    prismaRead.sanction.groupBy({
      by: ['targetUserId'],
      where: { guildId, targetUserId: { in: userIds } },
      _count: { _all: true },
    }),
    prismaRead.$queryRaw<Array<{ avgMessages: number | null; avgLevel: number | null }>>`
      SELECT
        (SELECT AVG("messageCount")::float FROM "member_profiles"
          WHERE "guildId" = ${guildId} AND "isBot" = false AND "guildLeftAt" IS NULL) AS "avgMessages",
        (SELECT AVG("level")::float FROM "member_levels" WHERE "guildId" = ${guildId}) AS "avgLevel"
    `,
  ]);

  const joinedAtByUser = new Map(joins.map((j) => [j.userId, j.joinedAt]));
  const humans = profiles.filter((p) => !p.isBot);

  const ghost = { ACTIVE: 0, SPECTATOR: 0, INACTIVE: 0, NEW: 0, UNKNOWN: 0 } as Record<string, number>;
  let youngAccounts = 0;
  for (const p of humans) {
    const status = p.ghostStatus && status2Known(p.ghostStatus) ? p.ghostStatus : 'UNKNOWN';
    ghost[status] = (ghost[status] ?? 0) + 1;
    const joinedAt = joinedAtByUser.get(p.userId);
    if (p.accountCreatedAt && joinedAt && joinedAt.getTime() - p.accountCreatedAt.getTime() < 7 * DAY_MS) {
      youngAccounts++;
    }
  }

  const avgMessages = humans.length
    ? humans.reduce((acc, p) => acc + p.messageCount, 0) / humans.length
    : null;
  const avgLevel = levels.length ? levels.reduce((acc, l) => acc + l.level, 0) / levels.length : null;

  const tagByUser = new Map(profiles.map((p) => [p.userId, p.userTag || p.username || p.userId]));
  const topSanctioned = sanctions
    .map((s) => ({ userId: s.targetUserId, userTag: tagByUser.get(s.targetUserId) ?? s.targetUserId, count: s._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    analyzed: humans.length,
    avgMessages: round(avgMessages),
    guildAvgMessages: round(guildAverages[0]?.avgMessages ?? null),
    avgLevel: round(avgLevel),
    guildAvgLevel: round(guildAverages[0]?.avgLevel ?? null),
    ghost,
    bots: profiles.length - humans.length,
    youngAccounts,
    youngAccountsPct: humans.length ? Math.round((youngAccounts / humans.length) * 1000) / 10 : null,
    sanctionedMembers: sanctions.length,
    sanctionsCount: sanctions.reduce((acc, s) => acc + s._count._all, 0),
    topSanctioned,
  };
}

function status2Known(status: string): boolean {
  return status === 'ACTIVE' || status === 'SPECTATOR' || status === 'INACTIVE' || status === 'NEW';
}

/**
 * Répartitions temporelles des arrivées, à l'heure murale du fuseau demandé.
 *
 * Les instants sont stockés en UTC ; les lire tels quels annonçait « pic
 * d'arrivées à 20h » pour un pic réellement observé à 22h à Paris.
 */
function buildTiming(joins: InviteJoinRow[], labels: string[], counts: number[], zoner: BucketZoner) {
  const hourly = new Array(24).fill(0);
  const weekday = new Array(7).fill(0);

  for (const join of joins) {
    const bucket = zoner.fromDate(join.joinedAt);
    hourly[bucket.hour]++;
    weekday[(bucket.weekday + 6) % 7]++; // lundi = 0
  }

  let running = 0;
  const cumulative = counts.map((c) => (running += c));

  const peakHour = hourly.indexOf(Math.max(...hourly));
  const peakWeekday = weekday.indexOf(Math.max(...weekday));

  return {
    hourly,
    weekday,
    cumulative,
    labels,
    peakHour: hourly[peakHour] > 0 ? peakHour : null,
    peakWeekday: weekday[peakWeekday] > 0 ? peakWeekday : null,
  };
}

async function buildRanking(guildId: string, code: string) {
  const rows = await prismaRead.memberInvite.groupBy({
    by: ['inviteCode'],
    where: { guildId, inviteCode: { not: null } },
    _count: { _all: true },
  });

  const ranked = rows
    .map((r) => ({ code: r.inviteCode as string, joins: r._count._all }))
    .sort((a, b) => b.joins - a.joins);

  const totalJoins = ranked.reduce((acc, r) => acc + r.joins, 0);
  const index = ranked.findIndex((r) => r.code === code);
  const own = index >= 0 ? ranked[index] : null;

  return {
    rank: index >= 0 ? index + 1 : null,
    totalCodes: ranked.length,
    sharePct: own && totalJoins > 0 ? Math.round((own.joins / totalJoins) * 1000) / 10 : null,
    topCodes: ranked.slice(0, 5),
  };
}

/**
 * Blocs additionnels de la vue détaillée d'un code.
 * `joins` est la liste complète des arrivées du code (historique, pas la période),
 * `labels`/`counts` la série journalière déjà calculée pour la période affichée.
 */
export async function getInviteInsights(
  guildId: string,
  code: string,
  joins: InviteJoinRow[],
  labels: string[],
  counts: number[],
  timezone?: string,
) {
  const zoner = new BucketZoner(normalizeTimezone(timezone));
  const analyzed = joins.length > MAX_ANALYZED_JOINS
    ? [...joins].sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime()).slice(0, MAX_ANALYZED_JOINS)
    : joins;

  const [quality, ranking] = await Promise.all([
    buildQuality(guildId, analyzed),
    buildRanking(guildId, code),
  ]);

  return {
    retention: buildRetention(joins),
    quality: { ...quality, sampled: analyzed.length < joins.length },
    timing: buildTiming(joins, labels, counts, zoner),
    ranking,
  };
}
