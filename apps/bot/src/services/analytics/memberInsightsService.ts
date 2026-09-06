import { SanctionType } from '@prisma/client';
import { normalizeTimezone } from '@kotbo/contracts';
import prisma, { prismaRead } from '../../utils/db.js';
import { BucketZoner } from './zonedBuckets.js';
import { getWarnScore, countWarns } from '../moderation/sanctionService.js';
import * as altAccountService from '../moderation/altAccountService.js';

/**
 * Statistiques de la fiche membre du dashboard (onglet Statistiques).
 *
 * Quatre blocs indépendants, calculés en parallèle :
 *   - activity : quand le membre parle (heatmap heure × jour, tendance, régularité)
 *   - risk     : score de warn pondéré, historique et récidive
 *   - social   : où il parle et avec qui
 *   - ranking  : sa position par rapport au reste du serveur
 *
 * Les messages viennent de MessageLog (contenu réel, nécessite le logging activé) ;
 * les totaux et le classement viennent de MemberProfile / MemberDailyStat, qui sont
 * toujours alimentés même sans logging.
 */

export type MemberActivityInsights = {
  /** 7 lignes (lundi=0) × 24 colonnes, nombre de messages par créneau. */
  heatmap: number[][];
  heatmapTotal: number;
  peakHour: number | null;
  peakWeekday: number | null;
  dailyTrend: Array<{ dateKey: string; messages: number; voiceMinutes: number }>;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  totalMessages: number;
  totalVoiceMinutes: number;
};

export type MemberRiskInsights = {
  warnCount: number;
  warnScore: number;
  weightingEnabled: boolean;
  /** Score de risque 0-100, dérivé du score de warn et des sanctions lourdes. */
  riskLevel: number;
  riskLabel: 'faible' | 'modéré' | 'élevé' | 'critique';
  guildAverageWarnScore: number;
  sanctionsByType: Record<string, number>;
  /** Sanctions par mois sur 12 mois, pour la courbe de récidive. */
  timeline: Array<{ monthKey: string; count: number }>;
  daysSinceLastSanction: number | null;
  isRepeatOffender: boolean;
};

export type MemberSocialInsights = {
  topChannels: Array<{ channelId: string; channelName: string; count: number; share: number }>;
  topInterlocutors: Array<{
    userId: string;
    userTag: string | null;
    avatarUrl: string | null;
    mentions: number;
    replies: number;
    total: number;
  }>;
  mentionsSent: number;
  repliesSent: number;
};

export type MemberRankingInsights = {
  totalRankedMembers: number;
  messages: MemberRankEntry;
  voice: MemberRankEntry;
};

export type MemberRankEntry = {
  value: number;
  rank: number | null;
  percentile: number | null;
  guildAverage: number;
  /** Variation en % entre la première et la seconde moitié de la période. */
  trend: number | null;
};

export type MemberInsights = {
  userId: string;
  period: number;
  /** Fuseau dans lequel la heatmap et l'heure de pointe ont ete calculees. */
  timezone: string;
  loggingEnabled: boolean;
  activity: MemberActivityInsights;
  risk: MemberRiskInsights;
  social: MemberSocialInsights;
  ranking: MemberRankingInsights;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Lundi = 0 … dimanche = 6, pour une heatmap qui se lit comme un calendrier FR. */
function percentChange(recent: number, older: number): number | null {
  if (older === 0) return recent > 0 ? 100 : null;
  return Math.round(((recent - older) / older) * 100);
}

/**
 * Séries de jours consécutifs actifs. `dateKeys` doit être trié par ordre croissant.
 * Le streak courant n'est retenu que s'il touche aujourd'hui ou hier - sinon le
 * membre a décroché et son streak est nul.
 */
function computeStreaks(dateKeys: string[]): { current: number; longest: number } {
  if (dateKeys.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let running = 1;
  let currentRun = 1;

  for (let i = 1; i < dateKeys.length; i += 1) {
    const previous = new Date(`${dateKeys[i - 1]}T00:00:00Z`).getTime();
    const current = new Date(`${dateKeys[i]}T00:00:00Z`).getTime();
    const isConsecutive = current - previous === MS_PER_DAY;

    running = isConsecutive ? running + 1 : 1;
    longest = Math.max(longest, running);
    currentRun = running;
  }

  const lastKey = dateKeys[dateKeys.length - 1];
  const lastDay = new Date(`${lastKey}T00:00:00Z`).getTime();
  const todayKey = toDateKey(new Date());
  const today = new Date(`${todayKey}T00:00:00Z`).getTime();
  const gapDays = Math.round((today - lastDay) / MS_PER_DAY);

  return { current: gapDays <= 1 ? currentRun : 0, longest };
}

function riskLabelFor(level: number): MemberRiskInsights['riskLabel'] {
  if (level >= 75) return 'critique';
  if (level >= 50) return 'élevé';
  if (level >= 25) return 'modéré';
  return 'faible';
}

async function computeActivity(
  guildId: string,
  userIds: string[],
  periodDays: number,
  zoner: BucketZoner,
): Promise<MemberActivityInsights> {
  const since = new Date(Date.now() - periodDays * MS_PER_DAY);
  const sinceKey = toDateKey(since);

  const [dailyStats, messages] = await Promise.all([
    prismaRead.memberDailyStat.findMany({
      where: { guildId, userId: { in: userIds }, dateKey: { gte: sinceKey } },
      orderBy: { dateKey: 'asc' },
    }),
    prismaRead.messageLog.findMany({
      where: { guildId, authorId: { in: userIds }, createdAt: { gte: since } },
      select: { createdAt: true },
      take: 20000,
    }),
  ]);

  // Plusieurs comptes liés peuvent partager un même jour : on agrège par dateKey.
  const perDay = new Map<string, { messages: number; voiceMinutes: number }>();
  for (const stat of dailyStats) {
    const entry = perDay.get(stat.dateKey) ?? { messages: 0, voiceMinutes: 0 };
    entry.messages += stat.messagesCount;
    entry.voiceMinutes += stat.voiceMinutes;
    perDay.set(stat.dateKey, entry);
  }

  const dailyTrend = [...perDay.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([dateKey, value]) => ({ dateKey, messages: value.messages, voiceMinutes: value.voiceMinutes }));

  const heatmap: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let peakCount = 0;
  let peakHour: number | null = null;
  let peakWeekday: number | null = null;

  for (const message of messages) {
    // Heure murale du fuseau de lecture : le processus tourne en UTC, et
    // `getHours()` y rendait donc l'heure UTC, decalee de celle du lecteur.
    const bucket = zoner.fromDate(message.createdAt);
    const weekday = (bucket.weekday + 6) % 7; // lundi = 0
    const hour = bucket.hour;
    heatmap[weekday][hour] += 1;
    if (heatmap[weekday][hour] > peakCount) {
      peakCount = heatmap[weekday][hour];
      peakHour = hour;
      peakWeekday = weekday;
    }
  }

  const activeKeys = dailyTrend.filter((day) => day.messages > 0 || day.voiceMinutes > 0).map((day) => day.dateKey);
  const streaks = computeStreaks(activeKeys);

  return {
    heatmap,
    heatmapTotal: messages.length,
    peakHour,
    peakWeekday,
    dailyTrend,
    activeDays: activeKeys.length,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    totalMessages: dailyTrend.reduce((sum, day) => sum + day.messages, 0),
    totalVoiceMinutes: dailyTrend.reduce((sum, day) => sum + day.voiceMinutes, 0),
  };
}

async function computeRisk(guildId: string, userId: string, userIds: string[]): Promise<MemberRiskInsights> {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const [guildConfig, warnCount, warnScore, sanctions, guildWarnAggregate, guildSanctionedMembers] = await Promise.all([
    prismaRead.guild.findUnique({ where: { id: guildId }, select: { warnWeightingEnabled: true } }),
    countWarns(guildId, userId, userIds),
    getWarnScore(guildId, userId, userIds),
    prismaRead.sanction.findMany({
      where: { guildId, targetUserId: { in: userIds } },
      select: { type: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prismaRead.sanction.aggregate({
      where: { guildId, type: SanctionType.WARN },
      _sum: { weight: true },
    }),
    prismaRead.sanction.findMany({
      where: { guildId, type: SanctionType.WARN },
      select: { targetUserId: true },
      distinct: ['targetUserId'],
    }),
  ]);

  const sanctionsByType: Record<string, number> = {};
  for (const sanction of sanctions) {
    sanctionsByType[sanction.type] = (sanctionsByType[sanction.type] ?? 0) + 1;
  }

  const monthCounts = new Map<string, number>();
  for (let i = 0; i < 12; i += 1) {
    const month = new Date(twelveMonthsAgo);
    month.setMonth(month.getMonth() + i);
    monthCounts.set(`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`, 0);
  }
  for (const sanction of sanctions) {
    if (sanction.createdAt < twelveMonthsAgo) continue;
    const key = `${sanction.createdAt.getFullYear()}-${String(sanction.createdAt.getMonth() + 1).padStart(2, '0')}`;
    if (monthCounts.has(key)) monthCounts.set(key, (monthCounts.get(key) ?? 0) + 1);
  }

  const lastSanction = sanctions[0];
  const daysSinceLastSanction = lastSanction
    ? Math.floor((Date.now() - lastSanction.createdAt.getTime()) / MS_PER_DAY)
    : null;

  // Un warn vaut 12 points, une sanction lourde 25. Plafonné à 100 : au-delà, la
  // nuance n'apporte plus rien au modérateur, c'est déjà un dossier critique.
  const heavySanctions =
    (sanctionsByType[SanctionType.BAN] ?? 0) +
    (sanctionsByType[SanctionType.TEMP_BAN] ?? 0) +
    (sanctionsByType[SanctionType.KICK] ?? 0);
  const riskLevel = Math.min(100, Math.round(warnScore * 12 + heavySanctions * 25));

  const distinctWarned = guildSanctionedMembers.length;
  const guildAverageWarnScore = distinctWarned > 0
    ? Math.round(((guildWarnAggregate._sum.weight ?? 0) / distinctWarned) * 10) / 10
    : 0;

  return {
    warnCount,
    warnScore,
    weightingEnabled: guildConfig?.warnWeightingEnabled ?? false,
    riskLevel,
    riskLabel: riskLabelFor(riskLevel),
    guildAverageWarnScore,
    sanctionsByType,
    timeline: [...monthCounts.entries()].map(([monthKey, count]) => ({ monthKey, count })),
    daysSinceLastSanction,
    isRepeatOffender: sanctions.length >= 3,
  };
}

async function computeSocial(
  guildId: string,
  userIds: string[],
  periodDays: number,
): Promise<MemberSocialInsights> {
  const since = new Date(Date.now() - periodDays * MS_PER_DAY);

  const [channelRows, messages] = await Promise.all([
    prismaRead.messageLog.groupBy({
      by: ['channelId', 'channelName'],
      where: { guildId, authorId: { in: userIds }, createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { channelId: 'desc' } },
      take: 10,
    }),
    prismaRead.messageLog.findMany({
      where: { guildId, authorId: { in: userIds }, createdAt: { gte: since } },
      select: { mentionedUserIds: true, repliedToAuthorId: true },
      take: 20000,
    }),
  ]);

  const totalInTopChannels = channelRows.reduce((sum, row) => sum + row._count._all, 0);
  const topChannels = channelRows.map((row) => ({
    channelId: row.channelId,
    channelName: row.channelName,
    count: row._count._all,
    share: totalInTopChannels > 0 ? Math.round((row._count._all / totalInTopChannels) * 100) : 0,
  }));

  const counters = new Map<string, { mentions: number; replies: number }>();
  let mentionsSent = 0;
  let repliesSent = 0;

  const bump = (targetId: string, kind: 'mentions' | 'replies') => {
    // On ne se compte pas soi-même, ni les comptes liés du même membre.
    if (userIds.includes(targetId)) return;
    const entry = counters.get(targetId) ?? { mentions: 0, replies: 0 };
    entry[kind] += 1;
    counters.set(targetId, entry);
  };

  for (const message of messages) {
    for (const mentioned of message.mentionedUserIds) {
      mentionsSent += 1;
      bump(mentioned, 'mentions');
    }
    if (message.repliedToAuthorId) {
      repliesSent += 1;
      bump(message.repliedToAuthorId, 'replies');
    }
  }

  const ranked = [...counters.entries()]
    .map(([targetId, value]) => ({ userId: targetId, ...value, total: value.mentions + value.replies }))
    .sort((left, right) => right.total - left.total)
    .slice(0, 8);

  const profiles = ranked.length
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: ranked.map((entry) => entry.userId) } },
        select: { userId: true, userTag: true, username: true, displayName: true, avatarUrl: true },
      })
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.userId, profile]));

  return {
    topChannels,
    topInterlocutors: ranked.map((entry) => {
      const profile = profileById.get(entry.userId);
      return {
        userId: entry.userId,
        userTag: profile?.displayName || profile?.userTag || profile?.username || null,
        avatarUrl: profile?.avatarUrl ?? null,
        mentions: entry.mentions,
        replies: entry.replies,
        total: entry.total,
      };
    }),
    mentionsSent,
    repliesSent,
  };
}

async function computeRanking(
  guildId: string,
  userIds: string[],
  dailyTrend: MemberActivityInsights['dailyTrend'],
  periodDays: number,
): Promise<MemberRankingInsights> {
  const [profiles, aggregate, totalRankedMembers] = await Promise.all([
    prismaRead.memberProfile.findMany({
      where: { guildId, userId: { in: userIds } },
      select: { messageCount: true, voiceTimeSeconds: true },
    }),
    prismaRead.memberProfile.aggregate({
      where: { guildId, isBot: false, guildLeftAt: null },
      _avg: { messageCount: true, voiceTimeSeconds: true },
    }),
    prismaRead.memberProfile.count({ where: { guildId, isBot: false, guildLeftAt: null } }),
  ]);

  const messageCount = profiles.reduce((sum, profile) => sum + profile.messageCount, 0);
  const voiceMinutes = Math.round(profiles.reduce((sum, profile) => sum + profile.voiceTimeSeconds, 0) / 60);

  // Le rang se déduit du nombre de membres strictement devant, sans trier tout le serveur.
  const [membersAheadOnMessages, membersAheadOnVoice] = await Promise.all([
    prismaRead.memberProfile.count({
      where: { guildId, isBot: false, guildLeftAt: null, messageCount: { gt: messageCount } },
    }),
    prismaRead.memberProfile.count({
      where: { guildId, isBot: false, guildLeftAt: null, voiceTimeSeconds: { gt: voiceMinutes * 60 } },
    }),
  ]);

  const half = Math.floor(periodDays / 2);
  const cutoff = toDateKey(new Date(Date.now() - half * MS_PER_DAY));
  const recent = dailyTrend.filter((day) => day.dateKey >= cutoff);
  const older = dailyTrend.filter((day) => day.dateKey < cutoff);
  const sum = (days: typeof dailyTrend, key: 'messages' | 'voiceMinutes') =>
    days.reduce((total, day) => total + day[key], 0);

  const toEntry = (
    value: number,
    membersAhead: number,
    guildAverage: number,
    trend: number | null,
  ): MemberRankEntry => {
    const rank = totalRankedMembers > 0 ? membersAhead + 1 : null;
    return {
      value,
      rank,
      percentile:
        rank !== null && totalRankedMembers > 0
          ? Math.max(1, Math.round(((totalRankedMembers - rank + 1) / totalRankedMembers) * 100))
          : null,
      guildAverage,
      trend,
    };
  };

  return {
    totalRankedMembers,
    messages: toEntry(
      messageCount,
      membersAheadOnMessages,
      Math.round(aggregate._avg.messageCount ?? 0),
      percentChange(sum(recent, 'messages'), sum(older, 'messages')),
    ),
    voice: toEntry(
      voiceMinutes,
      membersAheadOnVoice,
      Math.round((aggregate._avg.voiceTimeSeconds ?? 0) / 60),
      percentChange(sum(recent, 'voiceMinutes'), sum(older, 'voiceMinutes')),
    ),
  };
}

export async function getMemberInsights(
  guildId: string,
  userId: string,
  periodDays = 30,
  timezone?: string,
): Promise<MemberInsights> {
  const period = Math.min(90, Math.max(7, periodDays));
  const zoner = new BucketZoner(normalizeTimezone(timezone));

  // Les comptes liés comptent comme un seul membre : un multicompte ne doit pas
  // diluer son score de risque ni son activité en se répartissant sur deux profils.
  const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, userId).catch(() => [] as string[]);
  const userIds = [...new Set([userId, ...linkedUserIds])];

  const [guildConfig, activity, risk, social] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId }, select: { messageLoggingEnabled: true } }),
    computeActivity(guildId, userIds, period, zoner),
    computeRisk(guildId, userId, userIds),
    computeSocial(guildId, userIds, period),
  ]);

  const ranking = await computeRanking(guildId, userIds, activity.dailyTrend, period);

  return {
    userId,
    period,
    timezone: zoner.timezone,
    loggingEnabled: guildConfig?.messageLoggingEnabled ?? false,
    activity,
    risk,
    social,
    ranking,
  };
}
