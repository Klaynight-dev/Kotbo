/**
 * advancedAnalyticsService.ts
 *
 * Calculs des statistiques avancées du dashboard, par section :
 *  - retention  : cohortes d'arrivée, membres de retour, rétention par source d'invitation
 *  - activity   : DAU/WAU/MAU, assiduité, profondeur d'engagement, records, période vs période
 *  - churn      : départs par ancienneté, membres à risque, onboarding
 *  - channels   : canaux en croissance/déclin, matrice de co-activation
 *  - social     : centralité (réponses/mentions reçues), temps de réaction au ping
 *  - words      : mots les plus fréquents
 *  - moderation : pression, récidive, charge par modo, heures chaudes,
 *                 ancienneté du compte × infractions, source × sanctions
 *
 * Toutes les lectures passent par prismaRead (réplica si configuré).
 * Les sections dépendant de MessageLog (social, co-activation) renvoient
 * `available: false` si la journalisation des messages n'est pas activée.
 */

import { DEFAULT_TIMEZONE, normalizeTimezone } from '@kotbo/contracts';
import { prismaRead } from '../../utils/db.js';
import { getTopWords } from './wordStatsService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// RÉTENTION
// ─────────────────────────────────────────────────────────────────────────────

export async function getRetentionAnalytics(guildId: string) {
  const twelveWeeksAgo = new Date(Date.now() - 84 * DAY_MS);

  // Cohortes hebdomadaires : arrivées de la semaine → % encore présents à J+1/J+7/J+30
  const cohortRows = await prismaRead.$queryRaw<Array<{
    week: Date;
    joined: bigint;
    stayed1d: bigint;
    stayed7d: bigint;
    stayed30d: bigint;
  }>>`
    SELECT
      date_trunc('week', "guildJoinedAt") AS week,
      COUNT(*) AS joined,
      COUNT(*) FILTER (WHERE "guildLeftAt" IS NULL OR "guildLeftAt" > "guildJoinedAt" + interval '1 day')  AS stayed1d,
      COUNT(*) FILTER (WHERE ("guildLeftAt" IS NULL OR "guildLeftAt" > "guildJoinedAt" + interval '7 days')
                        AND "guildJoinedAt" <= now() - interval '7 days')  AS stayed7d,
      COUNT(*) FILTER (WHERE ("guildLeftAt" IS NULL OR "guildLeftAt" > "guildJoinedAt" + interval '30 days')
                        AND "guildJoinedAt" <= now() - interval '30 days') AS stayed30d
    FROM "member_profiles"
    WHERE "guildId" = ${guildId}
      AND "guildJoinedAt" IS NOT NULL
      AND "guildJoinedAt" >= ${twelveWeeksAgo}
      AND "isBot" = false
    GROUP BY 1
    ORDER BY 1
  `;

  const cohorts = cohortRows.map((r) => {
    const joined = Number(r.joined);
    const eligible7d = r.week.getTime() <= Date.now() - 7 * DAY_MS;
    const eligible30d = r.week.getTime() <= Date.now() - 30 * DAY_MS;
    return {
      week: r.week.toISOString().slice(0, 10),
      joined,
      d1: joined > 0 ? Math.round((Number(r.stayed1d) / joined) * 100) : null,
      d7: eligible7d && joined > 0 ? Math.round((Number(r.stayed7d) / joined) * 100) : null,
      d30: eligible30d && joined > 0 ? Math.round((Number(r.stayed30d) / joined) * 100) : null,
    };
  });

  // Membres de retour : actifs ces 7 derniers jours après ≥ 30 jours de silence
  const returningRows = await prismaRead.$queryRaw<Array<{ count: bigint }>>`
    WITH recent AS (
      SELECT "userId", MIN("dateKey") AS return_day
      FROM "member_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${dateKeyDaysAgo(7)}
      GROUP BY "userId"
    )
    SELECT COUNT(*) AS count
    FROM recent r
    WHERE EXISTS (
      SELECT 1 FROM "member_daily_stats" m
      WHERE m."guildId" = ${guildId} AND m."userId" = r."userId"
        AND m."dateKey" < r.return_day
      HAVING MAX(m."dateKey") < to_char(to_date(r.return_day, 'YYYY-MM-DD') - interval '30 days', 'YYYY-MM-DD')
    )
  `;
  const returningMembers = Number(returningRows[0]?.count ?? 0);

  // Rétention par source d'invitation (top 10 codes des 90 derniers jours)
  const bySource = await prismaRead.$queryRaw<Array<{
    inviteCode: string | null;
    inviterTag: string | null;
    joined: bigint;
    stayed: bigint;
  }>>`
    SELECT "inviteCode", MAX("inviterTag") AS "inviterTag",
           COUNT(*) AS joined,
           COUNT(*) FILTER (WHERE "leftAt" IS NULL) AS stayed
    FROM "member_invites"
    WHERE "guildId" = ${guildId} AND "joinedAt" >= ${new Date(Date.now() - 90 * DAY_MS)}
    GROUP BY "inviteCode"
    ORDER BY joined DESC
    LIMIT 10
  `;

  return {
    cohorts,
    returningMembers,
    retentionBySource: bySource.map((s) => ({
      inviteCode: s.inviteCode ?? 'inconnu',
      inviterTag: s.inviterTag,
      joined: Number(s.joined),
      retentionRate: Number(s.joined) > 0 ? Math.round((Number(s.stayed) / Number(s.joined)) * 100) : 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITÉ
// ─────────────────────────────────────────────────────────────────────────────

export async function getActivityAnalytics(guildId: string) {
  const [dau, wau, mau] = await Promise.all([
    prismaRead.memberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: dateKeyDaysAgo(1) } },
    }).then((r) => r.length),
    prismaRead.memberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: dateKeyDaysAgo(7) } },
    }).then((r) => r.length),
    prismaRead.memberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: dateKeyDaysAgo(30) } },
    }).then((r) => r.length),
  ]);

  // Période vs période : 30 derniers jours vs 30 précédents
  const [current, previous] = await Promise.all([
    prismaRead.guildDailyStat.aggregate({
      where: { guildId, dateKey: { gte: dateKeyDaysAgo(30) } },
      _sum: { messagesCount: true, voiceMinutes: true, membersJoined: true, membersLeft: true, reactionsCount: true },
      _avg: { activeMembers: true },
    }),
    prismaRead.guildDailyStat.aggregate({
      where: { guildId, dateKey: { gte: dateKeyDaysAgo(60), lt: dateKeyDaysAgo(30) } },
      _sum: { messagesCount: true, voiceMinutes: true, membersJoined: true, membersLeft: true, reactionsCount: true },
      _avg: { activeMembers: true },
    }),
  ]);

  const pct = (cur: number, prev: number) =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0;

  const curMessages = current._sum.messagesCount ?? 0;
  const prevMessages = previous._sum.messagesCount ?? 0;
  const curVoice = current._sum.voiceMinutes ?? 0;
  const prevVoice = previous._sum.voiceMinutes ?? 0;

  // Records historiques
  const [recordMessages, recordVoice, recordOnline] = await Promise.all([
    prismaRead.guildDailyStat.findFirst({
      where: { guildId }, orderBy: { messagesCount: 'desc' },
      select: { dateKey: true, messagesCount: true },
    }),
    prismaRead.guildDailyStat.findFirst({
      where: { guildId }, orderBy: { peakVoice: 'desc' },
      select: { dateKey: true, peakVoice: true },
    }),
    prismaRead.guildDailyStat.findFirst({
      where: { guildId }, orderBy: { peakOnline: 'desc' },
      select: { dateKey: true, peakOnline: true },
    }),
  ]);

  return {
    dau, wau, mau,
    stickiness: mau > 0 ? Math.round((dau / mau) * 100) : 0,
    engagement: {
      messagesPerActive: mau > 0 ? Math.round(curMessages / mau) : 0,
      voiceShare: curMessages + curVoice > 0 ? Math.round((curVoice / (curMessages + curVoice)) * 100) : 0,
    },
    comparison: {
      messages: { current: curMessages, previous: prevMessages, changePct: pct(curMessages, prevMessages) },
      voiceMinutes: { current: curVoice, previous: prevVoice, changePct: pct(curVoice, prevVoice) },
      joins: {
        current: current._sum.membersJoined ?? 0,
        previous: previous._sum.membersJoined ?? 0,
        changePct: pct(current._sum.membersJoined ?? 0, previous._sum.membersJoined ?? 0),
      },
      leaves: {
        current: current._sum.membersLeft ?? 0,
        previous: previous._sum.membersLeft ?? 0,
        changePct: pct(current._sum.membersLeft ?? 0, previous._sum.membersLeft ?? 0),
      },
      reactions: {
        current: current._sum.reactionsCount ?? 0,
        previous: previous._sum.reactionsCount ?? 0,
        changePct: pct(current._sum.reactionsCount ?? 0, previous._sum.reactionsCount ?? 0),
      },
      avgActiveMembers: {
        current: Math.round(current._avg.activeMembers ?? 0),
        previous: Math.round(previous._avg.activeMembers ?? 0),
        changePct: pct(current._avg.activeMembers ?? 0, previous._avg.activeMembers ?? 0),
      },
    },
    records: {
      messages: recordMessages ? { date: recordMessages.dateKey, value: recordMessages.messagesCount } : null,
      peakVoice: recordVoice ? { date: recordVoice.dateKey, value: recordVoice.peakVoice } : null,
      peakOnline: recordOnline ? { date: recordOnline.dateKey, value: recordOnline.peakOnline } : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHURN & ONBOARDING
// ─────────────────────────────────────────────────────────────────────────────

export async function getChurnAnalytics(guildId: string) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * DAY_MS);

  // Départs des 90 derniers jours, par ancienneté au moment du départ
  const tenureRows = await prismaRead.$queryRaw<Array<{ bucket: string; count: bigint }>>`
    SELECT
      CASE
        WHEN "guildLeftAt" - "guildJoinedAt" < interval '7 days'  THEN '<7j'
        WHEN "guildLeftAt" - "guildJoinedAt" < interval '30 days' THEN '7-30j'
        WHEN "guildLeftAt" - "guildJoinedAt" < interval '90 days' THEN '30-90j'
        ELSE '90j+'
      END AS bucket,
      COUNT(*) AS count
    FROM "member_profiles"
    WHERE "guildId" = ${guildId}
      AND "guildLeftAt" >= ${ninetyDaysAgo}
      AND "guildJoinedAt" IS NOT NULL
      AND "isBot" = false
    GROUP BY 1
  `;
  const buckets: Record<string, number> = { '<7j': 0, '7-30j': 0, '30-90j': 0, '90j+': 0 };
  for (const r of tenureRows) buckets[r.bucket] = Number(r.count);

  // Membres à risque : ≥ 5 jours actifs sur les 30 derniers, mais rien depuis 7 jours
  const atRiskRows = await prismaRead.$queryRaw<Array<{
    userId: string;
    activeDays: bigint;
    lastActive: string;
  }>>`
    SELECT "userId", COUNT(*) AS "activeDays", MAX("dateKey") AS "lastActive"
    FROM "member_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${dateKeyDaysAgo(30)}
    GROUP BY "userId"
    HAVING COUNT(*) >= 5 AND MAX("dateKey") < ${dateKeyDaysAgo(7)}
    ORDER BY COUNT(*) DESC
    LIMIT 25
  `;

  const atRiskIds = atRiskRows.map((r) => r.userId);
  const profiles = atRiskIds.length > 0
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: atRiskIds }, guildLeftAt: null },
        select: { userId: true, username: true, displayName: true, avatarUrl: true },
      })
    : [];
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));

  // Onboarding : délai médian avant le premier message (arrivées des 30 derniers jours)
  const firstMessageRows = await prismaRead.$queryRaw<Array<{ delayHours: number }>>`
    SELECT EXTRACT(EPOCH FROM (to_date(first_day, 'YYYY-MM-DD') + interval '12 hours' - "guildJoinedAt")) / 3600 AS "delayHours"
    FROM (
      SELECT m."userId", MIN(m."dateKey") AS first_day
      FROM "member_daily_stats" m
      WHERE m."guildId" = ${guildId}
      GROUP BY m."userId"
    ) fm
    JOIN "member_profiles" p ON p."guildId" = ${guildId} AND p."userId" = fm."userId"
    WHERE p."guildJoinedAt" >= ${new Date(Date.now() - 30 * DAY_MS)}
      AND p."isBot" = false
      AND to_date(fm.first_day, 'YYYY-MM-DD') >= p."guildJoinedAt"::date
  `;

  // Taux de complétion de l'onboarding Discord (arrivées des 30 derniers jours)
  const [joined30d, completed30d] = await Promise.all([
    prismaRead.memberProfile.count({
      where: { guildId, isBot: false, guildJoinedAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
    }),
    prismaRead.memberProfile.count({
      where: {
        guildId, isBot: false,
        guildJoinedAt: { gte: new Date(Date.now() - 30 * DAY_MS) },
        onboardingCompletedAt: { not: null },
      },
    }),
  ]);

  return {
    churnByTenure: buckets,
    atRisk: atRiskRows.map((r) => {
      const p = profileMap.get(r.userId);
      return {
        userId: r.userId,
        name: p?.displayName ?? p?.username ?? r.userId,
        avatarUrl: p?.avatarUrl ?? null,
        activeDays30: Number(r.activeDays),
        lastActive: r.lastActive,
      };
    }).filter((r) => profileMap.has(r.userId)),
    onboarding: {
      medianFirstMessageHours: median(firstMessageRows.map((r) => Math.max(0, Math.round(r.delayHours)))),
      joined30d,
      completed30d,
      completionRate: joined30d > 0 ? Math.round((completed30d / joined30d) * 100) : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANAUX
// ─────────────────────────────────────────────────────────────────────────────

export async function getChannelAnalytics(guildId: string) {
  // Croissance/déclin : 15 derniers jours vs 15 précédents
  const trendRows = await prismaRead.$queryRaw<Array<{
    channelId: string;
    recent: bigint;
    previous: bigint;
  }>>`
    SELECT "channelId",
      COALESCE(SUM("messagesCount") FILTER (WHERE "dateKey" >= ${dateKeyDaysAgo(15)}), 0) AS recent,
      COALESCE(SUM("messagesCount") FILTER (WHERE "dateKey" < ${dateKeyDaysAgo(15)}), 0) AS previous
    FROM "channel_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${dateKeyDaysAgo(30)}
    GROUP BY "channelId"
    HAVING SUM("messagesCount") > 20
  `;

  const trends = trendRows
    .map((r) => {
      const recent = Number(r.recent);
      const previous = Number(r.previous);
      return {
        channelId: r.channelId,
        recent,
        previous,
        changePct: previous > 0 ? Math.round(((recent - previous) / previous) * 100) : recent > 0 ? 100 : 0,
      };
    })
    .sort((a, b) => b.changePct - a.changePct);

  // Matrice de co-activation : paires de salons partageant les mêmes auteurs (30j).
  // Basée sur MessageLog (opt-in). Limité aux 12 salons les plus actifs.
  const guildConfig = await prismaRead.guild.findUnique({
    where: { id: guildId },
    select: { messageLoggingEnabled: true },
  });

  let coActivation: { available: boolean; channels: string[]; matrix: number[][] } = {
    available: false, channels: [], matrix: [],
  };

  if (guildConfig?.messageLoggingEnabled) {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const pairRows = await prismaRead.$queryRaw<Array<{
      channel_a: string;
      channel_b: string;
      shared: bigint;
    }>>`
      WITH top_channels AS (
        SELECT "channelId"
        FROM "message_logs"
        WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} AND "isBot" = false
        GROUP BY "channelId"
        ORDER BY COUNT(*) DESC
        LIMIT 12
      ),
      author_channels AS (
        SELECT DISTINCT "authorId", "channelId"
        FROM "message_logs"
        WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} AND "isBot" = false
          AND "channelId" IN (SELECT "channelId" FROM top_channels)
      )
      SELECT a."channelId" AS channel_a, b."channelId" AS channel_b, COUNT(*) AS shared
      FROM author_channels a
      JOIN author_channels b ON a."authorId" = b."authorId" AND a."channelId" < b."channelId"
      GROUP BY 1, 2
    `;

    const channelSet = new Set<string>();
    for (const p of pairRows) {
      channelSet.add(p.channel_a);
      channelSet.add(p.channel_b);
    }
    const channels = [...channelSet];
    const index = new Map(channels.map((c, i) => [c, i]));
    const matrix = channels.map(() => channels.map(() => 0));
    for (const p of pairRows) {
      const i = index.get(p.channel_a)!;
      const j = index.get(p.channel_b)!;
      matrix[i][j] = Number(p.shared);
      matrix[j][i] = Number(p.shared);
    }
    coActivation = { available: true, channels, matrix };
  }

  return { trends: { rising: trends.slice(0, 5), falling: trends.slice(-5).reverse() }, coActivation };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL
// ─────────────────────────────────────────────────────────────────────────────

export async function getSocialAnalytics(guildId: string) {
  const guildConfig = await prismaRead.guild.findUnique({
    where: { id: guildId },
    select: { messageLoggingEnabled: true },
  });
  if (!guildConfig?.messageLoggingEnabled) {
    return { available: false as const };
  }

  const since = new Date(Date.now() - 30 * DAY_MS);

  // Centralité : réponses et mentions reçues par membre (top 15)
  const centralityRows = await prismaRead.$queryRaw<Array<{
    userId: string;
    replies: bigint;
    mentions: bigint;
  }>>`
    WITH replies AS (
      SELECT "repliedToAuthorId" AS uid, COUNT(*) AS n
      FROM "message_logs"
      WHERE "guildId" = ${guildId} AND "createdAt" >= ${since}
        AND "repliedToAuthorId" IS NOT NULL AND "isBot" = false
      GROUP BY 1
    ),
    mentions AS (
      SELECT unnest("mentionedUserIds") AS uid, COUNT(*) AS n
      FROM "message_logs"
      WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} AND "isBot" = false
      GROUP BY 1
    )
    SELECT COALESCE(r.uid, m.uid) AS "userId",
           COALESCE(r.n, 0) AS replies,
           COALESCE(m.n, 0) AS mentions
    FROM replies r
    FULL OUTER JOIN mentions m ON r.uid = m.uid
    ORDER BY COALESCE(r.n, 0) + COALESCE(m.n, 0) DESC
    LIMIT 15
  `;

  // Temps de réaction au ping : délai médian entre une mention et le message
  // suivant du membre mentionné dans le même salon (fenêtre de 24 h, 30 jours).
  const pingRows = await prismaRead.$queryRaw<Array<{ delaySeconds: number }>>`
    SELECT EXTRACT(EPOCH FROM (reply."createdAt" - ping."createdAt")) AS "delaySeconds"
    FROM (
      SELECT "channelId", "createdAt", unnest("mentionedUserIds") AS mentioned
      FROM "message_logs"
      WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} AND "isBot" = false
    ) ping
    JOIN LATERAL (
      SELECT ml."createdAt"
      FROM "message_logs" ml
      WHERE ml."guildId" = ${guildId}
        AND ml."authorId" = ping.mentioned
        AND ml."channelId" = ping."channelId"
        AND ml."createdAt" > ping."createdAt"
        AND ml."createdAt" < ping."createdAt" + interval '24 hours'
      ORDER BY ml."createdAt"
      LIMIT 1
    ) reply ON true
    LIMIT 5000
  `;

  const delays = pingRows.map((r) => Math.round(r.delaySeconds));
  const profiles = centralityRows.length > 0
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: centralityRows.map((r) => r.userId) } },
        select: { userId: true, username: true, displayName: true, avatarUrl: true },
      })
    : [];
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));

  return {
    available: true as const,
    centrality: centralityRows.map((r) => {
      const p = profileMap.get(r.userId);
      return {
        userId: r.userId,
        name: p?.displayName ?? p?.username ?? r.userId,
        avatarUrl: p?.avatarUrl ?? null,
        repliesReceived: Number(r.replies),
        mentionsReceived: Number(r.mentions),
      };
    }),
    pingReaction: {
      medianSeconds: median(delays),
      samples: delays.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTS
// ─────────────────────────────────────────────────────────────────────────────

export async function getWordAnalytics(guildId: string, days = 30) {
  const guildConfig = await prismaRead.guild.findUnique({
    where: { id: guildId },
    select: { wordStatsEnabled: true, wordStatsBackfillStatus: true, messageLoggingEnabled: true },
  });
  const topWords = await getTopWords(guildId, days, 60);
  return {
    enabled: guildConfig?.wordStatsEnabled ?? false,
    messageLoggingEnabled: guildConfig?.messageLoggingEnabled ?? false,
    // Progression de l'indexation des messages déjà journalisés
    backfill: (guildConfig?.wordStatsBackfillStatus as {
      status?: string; processedMessages?: number; totalMessages?: number; error?: string | null;
    } | null) ?? { status: 'NOT_STARTED' },
    topWords,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODÉRATION
// ─────────────────────────────────────────────────────────────────────────────

export async function getModerationAnalytics(guildId: string, timezone = DEFAULT_TIMEZONE) {
  // Les « heures chaudes » sont une grille jour x heure : lue en UTC, elle
  // annoncait a un lecteur parisien des pics decales d'une a deux heures.
  const zone = normalizeTimezone(timezone);
  const since90 = new Date(Date.now() - 90 * DAY_MS);

  // Pression : sanctions pour 1000 messages, par semaine (12 semaines)
  const pressureRows = await prismaRead.$queryRaw<Array<{
    week: string;
    sanctions: bigint;
    messages: bigint;
  }>>`
    SELECT to_char(to_date("dateKey", 'YYYY-MM-DD'), 'IYYY-IW') AS week,
           SUM("sanctionsCount") AS sanctions,
           SUM("messagesCount") AS messages
    FROM "guild_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${dateKeyDaysAgo(84)}
    GROUP BY 1
    ORDER BY 1
  `;

  // Récidive : parmi les membres dont le 1er warn date de 30-90j, % re-sanctionnés ensuite
  const recidivismRows = await prismaRead.$queryRaw<Array<{
    total: bigint;
    recidivists: bigint;
    avg_days: number | null;
  }>>`
    WITH first_warns AS (
      SELECT "targetUserId", MIN("createdAt") AS first_warn
      FROM "sanctions"
      WHERE "guildId" = ${guildId} AND "type" = 'WARN'
      GROUP BY "targetUserId"
      HAVING MIN("createdAt") BETWEEN ${new Date(Date.now() - 90 * DAY_MS)} AND ${new Date(Date.now() - 30 * DAY_MS)}
    ),
    next_offense AS (
      SELECT f."targetUserId", f.first_warn, MIN(s."createdAt") AS next_at
      FROM first_warns f
      LEFT JOIN "sanctions" s
        ON s."guildId" = ${guildId}
        AND s."targetUserId" = f."targetUserId"
        AND s."createdAt" > f.first_warn
      GROUP BY f."targetUserId", f.first_warn
    )
    SELECT COUNT(*) AS total,
           COUNT(next_at) AS recidivists,
           AVG(EXTRACT(EPOCH FROM (next_at - first_warn)) / 86400) AS avg_days
    FROM next_offense
  `;
  const rec = recidivismRows[0];

  // Charge par modérateur (90j)
  const moderatorLoad = await prismaRead.sanction.groupBy({
    by: ['moderatorUserId', 'moderatorTag'],
    where: { guildId, createdAt: { gte: since90 } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 15,
  });

  // Heures chaudes : sanctions par (jour de semaine × heure), 90j
  const hotHours = await prismaRead.$queryRaw<Array<{ dow: number; hour: number; count: bigint }>>`
    SELECT EXTRACT(ISODOW FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone})::int AS dow,
           EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone})::int AS hour,
           COUNT(*) AS count
    FROM "sanctions"
    WHERE "guildId" = ${guildId} AND "createdAt" >= ${since90}
    GROUP BY 1, 2
  `;

  // Ancienneté du compte Discord × infractions (comptes sanctionnés, 90j)
  const accountAgeRows = await prismaRead.$queryRaw<Array<{ bucket: string; count: bigint }>>`
    SELECT
      CASE
        WHEN p."accountCreatedAt" > s."createdAt" - interval '30 days'  THEN '<30j'
        WHEN p."accountCreatedAt" > s."createdAt" - interval '180 days' THEN '30-180j'
        WHEN p."accountCreatedAt" > s."createdAt" - interval '365 days' THEN '180j-1an'
        ELSE '1an+'
      END AS bucket,
      COUNT(*) AS count
    FROM "sanctions" s
    JOIN "member_profiles" p ON p."guildId" = s."guildId" AND p."userId" = s."targetUserId"
    WHERE s."guildId" = ${guildId} AND s."createdAt" >= ${since90}
      AND p."accountCreatedAt" IS NOT NULL
    GROUP BY 1
  `;
  const ageBuckets: Record<string, number> = { '<30j': 0, '30-180j': 0, '180j-1an': 0, '1an+': 0 };
  for (const r of accountAgeRows) ageBuckets[r.bucket] = Number(r.count);

  // Source d'invitation × sanctions : les invitations qui amènent des membres sanctionnés (90j)
  const toxicSourceRows = await prismaRead.$queryRaw<Array<{
    inviteCode: string | null;
    invited: bigint;
    sanctioned: bigint;
  }>>`
    SELECT mi."inviteCode",
           COUNT(DISTINCT mi."userId") AS invited,
           COUNT(DISTINCT s."targetUserId") AS sanctioned
    FROM "member_invites" mi
    LEFT JOIN "sanctions" s
      ON s."guildId" = mi."guildId" AND s."targetUserId" = mi."userId" AND s."createdAt" >= mi."joinedAt"
    WHERE mi."guildId" = ${guildId} AND mi."joinedAt" >= ${since90}
    GROUP BY mi."inviteCode"
    HAVING COUNT(DISTINCT mi."userId") >= 3
    ORDER BY COUNT(DISTINCT s."targetUserId")::float / COUNT(DISTINCT mi."userId") DESC
    LIMIT 10
  `;

  // Hygiène des bans : compteur de comptes supprimés nettoyables
  const cleanableBans = await prismaRead.banHygieneRecord.count({
    where: { guildId, unbannedAt: null },
  });

  return {
    pressure: pressureRows.map((r) => ({
      week: r.week,
      per1000: Number(r.messages) > 0 ? Math.round((Number(r.sanctions) / Number(r.messages)) * 100000) / 100 : 0,
      sanctions: Number(r.sanctions),
    })),
    recidivism: {
      firstWarned: Number(rec?.total ?? 0),
      recidivists: Number(rec?.recidivists ?? 0),
      rate: Number(rec?.total ?? 0) > 0 ? Math.round((Number(rec?.recidivists ?? 0) / Number(rec?.total ?? 1)) * 100) : null,
      avgDaysToNext: rec?.avg_days != null ? Math.round(Number(rec.avg_days)) : null,
    },
    moderatorLoad: moderatorLoad.map((m) => ({
      userId: m.moderatorUserId,
      tag: m.moderatorTag,
      count: m._count.id,
    })),
    hotHours: hotHours.map((h) => ({ dow: h.dow, hour: h.hour, count: Number(h.count) })),
    accountAgeBuckets: ageBuckets,
    toxicSources: toxicSourceRows.map((t) => ({
      inviteCode: t.inviteCode ?? 'inconnu',
      invited: Number(t.invited),
      sanctioned: Number(t.sanctioned),
      ratePct: Number(t.invited) > 0 ? Math.round((Number(t.sanctioned) / Number(t.invited)) * 100) : 0,
    })),
    cleanableBans,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

export type AdvancedSection =
  | 'retention' | 'activity' | 'churn' | 'channels' | 'social' | 'words' | 'moderation';

export const ADVANCED_SECTIONS: AdvancedSection[] = [
  'retention', 'activity', 'churn', 'channels', 'social', 'words', 'moderation',
];

export async function getAdvancedAnalytics(guildId: string, section: AdvancedSection, timezone = DEFAULT_TIMEZONE) {
  switch (section) {
    case 'retention': return getRetentionAnalytics(guildId);
    case 'activity': return getActivityAnalytics(guildId);
    case 'churn': return getChurnAnalytics(guildId);
    case 'channels': return getChannelAnalytics(guildId);
    case 'social': return getSocialAnalytics(guildId);
    case 'words': return getWordAnalytics(guildId);
    case 'moderation': return getModerationAnalytics(guildId, timezone);
  }
}
