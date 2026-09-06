/** Un point de la serie temporelle, a la journee ou a la demi-heure. */
type DailyStatBucket = {
  dateKey: string;
  messagesCount: number;
  voiceMinutes: number;
  membersJoined: number;
  membersLeft: number;
  activeMembers: number;
  totalMembers: number;
  onlineMembers: number;
  // Presents seulement sur les points a la journee (pas sur les buckets horaires).
  sanctionsCount?: number;
  peakOnline?: number;
};

/** Cumul par membre sur la periode. */
type MemberTotals = {
  userId: string;
  name: string;
  username: string;
  avatarUrl?: string | null;
  messageCount: number;
  voiceTimeSeconds: number;
};

import { DEFAULT_TIMEZONE, toWallClockUtcMs, zonedTimeToInstant } from '@kotbo/contracts';
import { prismaRead as prisma } from '../../utils/db.js';
import { findPresenceOptOuts } from '../core/presencePrivacyService.js';
import { BucketZoner, ZONE_MARGIN_DAYS, shiftKey } from './zonedBuckets.js';

/** Instant reel auquel commence le jour `dateKey` dans un fuseau donne. */
function zonedDayStart(dateKey: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const wallClock = toWallClockUtcMs(year, (month ?? 1) - 1, day ?? 1);
  if (wallClock === null) return new Date(`${dateKey}T00:00:00.000Z`);
  return zonedTimeToInstant(wallClock, timezone);
}

export const getDashboardAnalytics = async (guildId: string, options: { days?: number, startDate?: string, endDate?: string } = {}) => {
  const days = options.days || 30;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  const finalEndKey = endKey.split('T')[0];
  if (!startKey) {
    const startDate = new Date(finalEndKey);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }
  const finalStartKey = startKey.split('T')[0];

  let dailyStats: DailyStatBucket[] = [];
  
  // Check if we should use hourly resolution (days=1 OR custom range < 72h)
  let useHourly = days === 1 && !options.startDate;
  if (options.startDate && options.endDate) {
    const start = new Date(options.startDate);
    const end = new Date(options.endDate);
    const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    if (diffHours > 0 && diffHours <= 72) {
      useHourly = true;
    }
  }

  if (useHourly) {
    // Hourly resolution
    const hourlyWhere: Record<string, unknown> = { guildId };
    
    if (options.startDate && options.endDate) {
      const sDate = options.startDate.split('T')[0];
      const eDate = options.endDate.split('T')[0];
      hourlyWhere.dateKey = { gte: sDate, lte: eDate };
    }

    const hourlyStats = await prisma.guildHourlyStat.findMany({
      where: hourlyWhere,
      orderBy: [
        { dateKey: 'asc' },
        { hour: 'asc' }
      ],
      take: options.startDate ? 200 : 24 
    });
    
    const stats: DailyStatBucket[] = [];
    for (const h of hourlyStats) {
      const hourStr = String(h.hour).padStart(2, '0');
      
      // Bucket 1: :00
      stats.push({
        dateKey: `${h.dateKey} ${hourStr}h00`,
        messagesCount: Math.round(h.messagesCount / 2),
        voiceMinutes: Math.round(h.voiceMinutes / 2),
        membersJoined: Math.round(h.joinsCount / 2),
        membersLeft: Math.round(h.leavesCount / 2),
        activeMembers: h.activeMembers,
        totalMembers: 0,
        onlineMembers: h.onlineMembers,
      });
      
      // Bucket 2: :30
      stats.push({
        dateKey: `${h.dateKey} ${hourStr}h30`,
        messagesCount: Math.floor(h.messagesCount / 2),
        voiceMinutes: Math.floor(h.voiceMinutes / 2),
        membersJoined: Math.floor(h.joinsCount / 2),
        membersLeft: Math.floor(h.leavesCount / 2),
        activeMembers: h.activeMembers,
        totalMembers: 0,
        onlineMembers: h.onlineMembers,
      });
    }
    dailyStats = stats;
  } else {
    // Daily resolution
    dailyStats = await prisma.guildDailyStat.findMany({
      where: {
        guildId,
        dateKey: {
          gte: finalStartKey,
          lte: finalEndKey
        }
      },
      orderBy: { dateKey: 'asc' }
    });
  }

  const channelStats = await prisma.channelDailyStat.findMany({
    where: {
      guildId,
      dateKey: {
        gte: finalStartKey,
        lte: finalEndKey
      }
    }
  });

  // Group channel stats to find popular channels
  const channelTotals = channelStats.reduce((acc, curr) => {
    if (!acc[curr.channelId]) {
      acc[curr.channelId] = 0;
    }
    acc[curr.channelId] += curr.messagesCount;
    return acc;
  }, {} as Record<string, number>);

  const popularChannels = Object.entries(channelTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([channelId, messagesCount]) => ({ channelId, messagesCount }));

  const memberStats = await prisma.memberDailyStat.findMany({
    where: {
      guildId,
      dateKey: {
        gte: startKey,
        lte: endKey
      }
    }
  });

  const uniqueUserIds = [...new Set(memberStats.map(s => s.userId))];

  const memberProfiles = await prisma.memberProfile.findMany({
    where: {
      guildId,
      userId: { in: uniqueUserIds }
    },
    select: {
      userId: true,
      userTag: true,
      username: true,
      displayName: true,
      avatarUrl: true
    }
  });

  const memberProfileMap = new Map(memberProfiles.map(p => [p.userId, p]));

  const memberTotals = memberStats.reduce((acc, curr) => {
    if (!acc[curr.userId]) {
      const profile = memberProfileMap.get(curr.userId);
      acc[curr.userId] = {
        userId: curr.userId,
        name: profile?.displayName || profile?.username || profile?.userTag || 'Inconnu',
        username: profile?.username || profile?.userTag || 'Inconnu',
        avatarUrl: profile?.avatarUrl,
        messageCount: 0,
        voiceTimeSeconds: 0
      };
    }
    acc[curr.userId].messageCount += curr.messagesCount;
    acc[curr.userId].voiceTimeSeconds += curr.voiceMinutes * 60;
    return acc;
  }, {} as Record<string, MemberTotals>);

  const memberTotalsArray = Object.values(memberTotals);
  
  const topMessageMembers = [...memberTotalsArray]
    .sort((a, b) => b.messageCount - a.messageCount);
    
  const topVoiceMembers = [...memberTotalsArray]
    .sort((a, b) => b.voiceTimeSeconds - a.voiceTimeSeconds);

  const startISO = new Date(finalStartKey + 'T00:00:00.000Z').toISOString();
  const endISO = new Date(finalEndKey + 'T23:59:59.999Z').toISOString();

  const sanctions = await prisma.sanction.findMany({
    where: {
      guildId,
      createdAt: {
        gte: startISO,
        lte: endISO
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 100
  });

  const recentSanctions = sanctions;

  const modTotals = sanctions.reduce((acc, curr) => {
    if (!acc[curr.moderatorUserId]) {
      acc[curr.moderatorUserId] = { userId: curr.moderatorUserId, moderatorTag: curr.moderatorTag, avatarUrl: null, count: 0 };
    }
    acc[curr.moderatorUserId].count++;
    return acc;
  }, {} as Record<string, { userId: string; moderatorTag: string | null; avatarUrl: string | null; count: number }>);
  
  const topModerators = Object.values(modTotals).sort((a, b) => b.count - a.count);

  const targetTotals = sanctions.reduce((acc, curr) => {
    if (!acc[curr.targetUserId]) {
      acc[curr.targetUserId] = { targetUserId: curr.targetUserId, targetTag: curr.targetTag, avatarUrl: null, count: 0 };
    }
    acc[curr.targetUserId].count++;
    return acc;
  }, {} as Record<string, { targetUserId: string; targetTag: string | null; avatarUrl: string | null; count: number }>);
  
  const topSanctionedMembers = Object.values(targetTotals).sort((a, b) => b.count - a.count);

  const staffMembers = await prisma.staffMember.findMany({
    where: { guildId }
  });

  const activeAbsences = await prisma.staffAbsence.count({
    where: { guildId, status: 'APPROVED', endDate: { gte: new Date() } }
  });

  const recentMeetings = await prisma.staffMeeting.findMany({
    where: { guildId, scheduledAt: { gte: startISO, lte: endISO } },
    include: { presences: true }
  });

  let totalPresences = 0;
  let possiblePresences = 0;
  for (const m of recentMeetings) {
    totalPresences += m.presences.filter(p => p.status === 'PRESENT').length;
    possiblePresences += staffMembers.length;
  }
  const avgMeetingAttendance = possiblePresences > 0 ? Math.round((totalPresences / possiblePresences) * 100) : 0;

  // Enrichir les tags avec les noms actuels si possible
  const allUserIds = new Set([
    ...topModerators.map(m => m.userId),
    ...topSanctionedMembers.map(m => m.targetUserId),
    ...sanctions.map(s => s.targetUserId),
    ...sanctions.map(s => s.moderatorUserId)
  ]);

  const enrichmentProfiles = await prisma.memberProfile.findMany({
    where: { userId: { in: Array.from(allUserIds) }, guildId },
    select: { userId: true, displayName: true, username: true, userTag: true, avatarUrl: true }
  });

  const enrichmentProfileMap = new Map(enrichmentProfiles.map(p => [p.userId, p]));

  const enrichedTopModerators = topModerators.map(m => {
    const p = enrichmentProfileMap.get(m.userId);
    return {
      ...m,
      moderatorTag: p?.displayName || p?.userTag || p?.username || m.moderatorTag || 'Inconnu',
      avatarUrl: p?.avatarUrl || m.avatarUrl
    };
  });

  const enrichedTopSanctioned = topSanctionedMembers.map(m => {
    const p = enrichmentProfileMap.get(m.targetUserId);
    return {
      ...m,
      targetTag: p?.displayName || p?.userTag || p?.username || m.targetTag || 'Inconnu',
      avatarUrl: p?.avatarUrl || m.avatarUrl
    };
  });

  const staffLeaderboard = staffMembers.map(staff => {
    const memData = memberTotals[staff.userId] || { messageCount: 0, voiceTimeSeconds: 0 };
    const score = memData.messageCount + Math.round(memData.voiceTimeSeconds / 60);
    const p = enrichmentProfileMap.get(staff.userId);
    return {
      userId: staff.userId,
      name: staff.displayName || p?.displayName || staff.username || p?.username || staff.userTag || p?.userTag || 'Inconnu',
      avatarUrl: staff.avatarUrl || p?.avatarUrl,
      grade: staff.grade,
      messages: memData.messageCount,
      voiceMinutes: Math.round(memData.voiceTimeSeconds / 60),
      score
    };
  }).sort((a, b) => b.score - a.score);

  return {
    dailyTrend: dailyStats.map(stat => ({
      dateKey: stat.dateKey,
      messages: stat.messagesCount,
      voiceMinutes: stat.voiceMinutes,
      membersJoined: stat.membersJoined,
      membersLeft: stat.membersLeft,
      sanctions: stat.sanctionsCount || 0,
      onlineMembers: stat.onlineMembers || 0,
      peakOnline: stat.peakOnline || 0
    })),
    topChannels: popularChannels,
    topMessageMembers,
    topVoiceMembers,
    recentSanctions: recentSanctions.map(s => {
       const targetP = enrichmentProfileMap.get(s.targetUserId);
       const modP = enrichmentProfileMap.get(s.moderatorUserId);
       return {
         ...s,
         targetTag: targetP?.displayName || targetP?.userTag || s.targetTag,
         targetAvatarUrl: targetP?.avatarUrl || null,
         moderatorTag: modP?.displayName || modP?.userTag || s.moderatorTag,
         moderatorAvatarUrl: modP?.avatarUrl || null
       };
    }),
    topModerators: enrichedTopModerators,
    topSanctionedMembers: enrichedTopSanctioned,
    staff: {
      totalStaff: staffMembers.length,
      activeAbsences,
      meetings: recentMeetings.length,
      avgMeetingAttendance,
      leaderboard: staffLeaderboard
    },
    totals: {
      totalMessages: dailyStats.reduce((sum, stat) => sum + stat.messagesCount, 0),
      totalVoiceMinutes: dailyStats.reduce((sum, stat) => sum + stat.voiceMinutes, 0),
      totalJoins: dailyStats.reduce((sum, stat) => sum + stat.membersJoined, 0),
      totalLeaves: dailyStats.reduce((sum, stat) => sum + stat.membersLeft, 0),
      warns: sanctions.filter(s => s.type === 'WARN').length,
      kicks: sanctions.filter(s => s.type === 'KICK').length,
      bans: sanctions.filter(s => s.type === 'BAN' || s.type === 'TEMP_BAN').length,
      timeouts: sanctions.filter(s => s.type === 'TIMEOUT').length,
    },
    commandUsage: await getCommandUsageAnalytics(guildId, { startDate: startISO, endDate: endISO }),
    staffPerformance: await getStaffPerformanceAnalytics(guildId, { startDate: startISO, endDate: endISO }),
    channelCategoryActivity: await getChannelCategoryActivity(guildId, { startDate: finalStartKey, endDate: finalEndKey })
  };
};

/**
 * Get command usage analytics
 */
export const getCommandUsageAnalytics = async (guildId: string, options: { startDate?: string, endDate?: string } = {}) => {
  const gte = options.startDate ? new Date(options.startDate) : undefined;
  const lte = options.endDate ? new Date(options.endDate) : undefined;
  const usages = await prisma.dashboardCommandUsage.findMany({
    where: {
      guildId,
      lastUsedAt: {
        gte,
        lte
      }
    },
    orderBy: { count: 'desc' }
  });

  // Aggregate by command name
  const totals: Record<string, number> = {};
  usages.forEach(u => {
    totals[u.commandName] = (totals[u.commandName] || 0) + u.count;
  });

  return Object.entries(totals)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

/**
 * Get detailed staff performance metrics
 */
export const getStaffPerformanceAnalytics = async (guildId: string, options: { startDate?: string, endDate?: string } = {}) => {
  const staffMembers = await prisma.staffMember.findMany({
    where: { guildId }
  });

  const gte = options.startDate ? new Date(options.startDate) : undefined;
  const lte = options.endDate ? new Date(options.endDate) : undefined;
  const sanctions = await prisma.sanction.findMany({
    where: {
      guildId,
      createdAt: {
        gte,
        lte
      }
    }
  });

  const reports = await prisma.sanctionReport.findMany({
    where: {
      guildId,
      createdAt: {
        gte,
        lte
      }
    }
  });

  const performance = staffMembers.map(staff => {
    const staffSanctions = sanctions.filter(s => s.moderatorUserId === staff.userId);
    const staffReports = reports.filter(r => r.createdByUserId === staff.userId);
    
    return {
      userId: staff.userId,
      username: staff.username,
      displayName: staff.displayName,
      avatarUrl: staff.avatarUrl,
      sanctionsCount: staffSanctions.length,
      reportsCount: staffReports.length,
      reportRate: staffSanctions.length > 0 ? Math.round((staffReports.length / staffSanctions.length) * 100) : 0,
      warns: staffSanctions.filter(s => s.type === 'WARN').length,
      bans: staffSanctions.filter(s => s.type === 'BAN' || s.type === 'TEMP_BAN').length
    };
  }).sort((a, b) => (b.sanctionsCount + b.reportsCount) - (a.sanctionsCount + a.reportsCount));

  return performance;
};

/**
 * Get activity grouped by channel categories
 */
export const getChannelCategoryActivity = async (guildId: string, options: { startDate?: string, endDate?: string } = {}) => {
  const channelStats = await prisma.channelDailyStat.findMany({
    where: {
      guildId,
      dateKey: {
        gte: options.startDate,
        lte: options.endDate
      }
    }
  });

  // This would ideally require category information from Discord or a mapping
  // For now, we aggregate by channel and the caller can enrich with categories if they have the guild object
  const channelTotals: Record<string, number> = {};
  channelStats.forEach(s => {
    channelTotals[s.channelId] = (channelTotals[s.channelId] || 0) + s.messagesCount;
  });

  return Object.entries(channelTotals).map(([channelId, messages]) => ({ channelId, messages }));
};

function countCalendarDaysPerWeekday(startKey: string, endKey: string): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const cursor = new Date(`${startKey}T12:00:00.000Z`);
  const end = new Date(`${endKey}T12:00:00.000Z`);
  while (cursor <= end) {
    counts[cursor.getUTCDay()]++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return counts;
}

function createEmptyHeatmapGrid() {
  const grid: Record<number, Record<number, { messages: number; voice: number; active: number; joins: number; leaves: number }>> = {};
  for (let dow = 0; dow < 7; dow++) {
    grid[dow] = {};
    for (let hour = 0; hour < 24; hour++) {
      grid[dow][hour] = { messages: 0, voice: 0, active: 0, joins: 0, leaves: 0 };
    }
  }
  return grid;
}

/**
 * Get hourly heatmap data (for visualization)
 *
 * `timezone` est le fuseau de lecture : les creneaux sont stockes en UTC, mais
 * une grille jour x heure ne veut rien dire tant qu'elle n'est pas ramenee a
 * l'heure murale de celui qui la regarde.
 */
export const getHourlyHeatmapData = async (guildId: string, options: { days?: number, startDate?: string|null, endDate?: string|null, timezone?: string } = {}) => {
  const days = options.days || 30;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  const finalEndKey = endKey.split('T')[0];
  if (!startKey) {
    const startDate = new Date(finalEndKey);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }
  const finalStartKey = startKey.split('T')[0];
  const zoner = new BucketZoner(options.timezone ?? DEFAULT_TIMEZONE);
  // Bornes de la plage **locale**, converties en instants reels : a Paris, le
  // 1er mars commence a 23h UTC le 28 fevrier.
  const rangeStart = zonedDayStart(finalStartKey, zoner.timezone);
  const rangeEnd = new Date(zonedDayStart(shiftKey(finalEndKey, 1), zoner.timezone).getTime() - 1);
  const daysPerWeekday = countCalendarDaysPerWeekday(finalStartKey, finalEndKey);

  const hourlyStats = await prisma.guildHourlyStat.findMany({
    where: {
      guildId,
      // Elargi d'un jour de chaque cote : le decalage fait entrer dans la
      // plage locale des creneaux UTC de la veille ou du lendemain. Le tri
      // final se fait sur les cles converties.
      dateKey: {
        gte: shiftKey(finalStartKey, -ZONE_MARGIN_DAYS),
        lte: shiftKey(finalEndKey, ZONE_MARGIN_DAYS)
      }
    },
    orderBy: [{ dateKey: 'asc' }, { hour: 'asc' }]
  });

  /** Creneaux ramenes au fuseau de lecture, hors plage exclus. */
  const zonedStats = hourlyStats.flatMap(stat => {
    const bucket = zoner.fromKeyHour(stat.dateKey, stat.hour);
    if (bucket.dateKey < finalStartKey || bucket.dateKey > finalEndKey) return [];
    return [{ stat, bucket }];
  });

  const heatmapData = createEmptyHeatmapGrid();

  zonedStats.forEach(({ stat, bucket }) => {
    heatmapData[bucket.weekday][bucket.hour].messages += stat.messagesCount;
    heatmapData[bucket.weekday][bucket.hour].voice += stat.voiceMinutes;
    heatmapData[bucket.weekday][bucket.hour].active += stat.activeMembers;
  });

  const [joinProfiles, leaveProfiles] = await Promise.all([
    prisma.memberProfile.findMany({
      where: {
        guildId,
        isBot: false,
        guildJoinedAt: { gte: rangeStart, lte: rangeEnd },
      },
      select: { guildJoinedAt: true },
    }),
    prisma.memberProfile.findMany({
      where: {
        guildId,
        isBot: false,
        guildLeftAt: { gte: rangeStart, lte: rangeEnd },
      },
      select: { guildLeftAt: true },
    }),
  ]);

  let fluxEvents = joinProfiles.length + leaveProfiles.length;

  if (fluxEvents > 0) {
    for (const profile of joinProfiles) {
      if (!profile.guildJoinedAt) continue;
      const { weekday, hour } = zoner.fromDate(profile.guildJoinedAt);
      heatmapData[weekday][hour].joins += 1;
    }

    for (const profile of leaveProfiles) {
      if (!profile.guildLeftAt) continue;
      const { weekday, hour } = zoner.fromDate(profile.guildLeftAt);
      heatmapData[weekday][hour].leaves += 1;
    }
  } else {
    zonedStats.forEach(({ stat, bucket }) => {
      heatmapData[bucket.weekday][bucket.hour].joins += stat.joinsCount;
      heatmapData[bucket.weekday][bucket.hour].leaves += stat.leavesCount;
    });
    fluxEvents = zonedStats.reduce((sum, { stat }) => sum + stat.joinsCount + stat.leavesCount, 0);
  }

  // Dernier recours : stats journalières membersJoined / membersLeft réparties sur la journée
  if (fluxEvents === 0) {
    const dailyStats = await prisma.guildDailyStat.findMany({
      where: {
        guildId,
        dateKey: { gte: finalStartKey, lte: finalEndKey },
        OR: [{ membersJoined: { gt: 0 } }, { membersLeft: { gt: 0 } }],
      },
      select: { dateKey: true, membersJoined: true, membersLeft: true },
    });

    for (const day of dailyStats) {
      const date = new Date(day.dateKey + 'T00:00:00Z');
      const dow = date.getUTCDay();
      const joinsPerHour = day.membersJoined / 24;
      const leavesPerHour = day.membersLeft / 24;
      for (let hour = 0; hour < 24; hour++) {
        heatmapData[dow][hour].joins += joinsPerHour;
        heatmapData[dow][hour].leaves += leavesPerHour;
      }
    }
  }

  const normalized: Record<number, Record<number, { messages: number; voice: number; active: number; joins: number; leaves: number; net: number }>> = {};
  for (let dow = 0; dow < 7; dow++) {
    normalized[dow] = {};
    const weekdayCount = daysPerWeekday[dow] || 1;
    for (let hour = 0; hour < 24; hour++) {
      const joins = Math.round((heatmapData[dow][hour].joins / weekdayCount) * 10) / 10;
      const leaves = Math.round((heatmapData[dow][hour].leaves / weekdayCount) * 10) / 10;
      normalized[dow][hour] = {
        messages: Math.round(heatmapData[dow][hour].messages / weekdayCount),
        voice: Math.round(heatmapData[dow][hour].voice / weekdayCount),
        active: Math.round(heatmapData[dow][hour].active / weekdayCount),
        joins,
        leaves,
        net: Math.round((joins - leaves) * 10) / 10,
      };
    }
  }

  return normalized;
};

/**
 * Get week-over-week comparison
 */
export const getWeekOverWeekComparison = async (guildId: string, options: { offset?: number, mode?: 'week' | 'month' } = {}) => {
  const { offset = 1, mode = 'week' } = options;
  const now = new Date();
  
  let currentStart = new Date(now);
  let currentEnd = new Date(now);
  let previousStart = new Date(now);
  let previousEnd = new Date(now);

  if (mode === 'month') {
    // Current month
    currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    currentEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    
    // Previous month (offset)
    previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    previousEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 0, 23, 59, 59, 999));
  } else {
    // Current week (starting Sunday)
    currentStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
    currentStart.setUTCHours(0, 0, 0, 0);
    currentEnd = new Date(currentStart);
    currentEnd.setUTCDate(currentStart.getUTCDate() + 6);
    currentEnd.setUTCHours(23, 59, 59, 999);
    
    // Previous week (offset)
    previousStart = new Date(currentStart);
    previousStart.setUTCDate(currentStart.getUTCDate() - (7 * offset));
    previousEnd = new Date(previousStart);
    previousEnd.setUTCDate(previousStart.getUTCDate() + 6);
    previousEnd.setUTCHours(23, 59, 59, 999);
  }

  const currentKeyStart = currentStart.toISOString().split('T')[0];
  const currentKeyEnd = currentEnd.toISOString().split('T')[0];
  const previousKeyStart = previousStart.toISOString().split('T')[0];
  const previousKeyEnd = previousEnd.toISOString().split('T')[0];

  const currentStats = await prisma.guildDailyStat.findMany({
    where: {
      guildId,
      dateKey: { gte: currentKeyStart, lte: currentKeyEnd }
    }
  });

  const previousStats = await prisma.guildDailyStat.findMany({
    where: {
      guildId,
      dateKey: { gte: previousKeyStart, lte: previousKeyEnd }
    }
  });

  const sumStats = (stats: typeof currentStats) => ({
    messages: stats.reduce((sum, s) => sum + s.messagesCount, 0),
    voiceMinutes: stats.reduce((sum, s) => sum + s.voiceMinutes, 0),
    joins: stats.reduce((sum, s) => sum + s.membersJoined, 0),
    leaves: stats.reduce((sum, s) => sum + s.membersLeft, 0),
    sanctions: stats.reduce((sum, s) => sum + (s.sanctionsCount || 0), 0)
  });

  const thisPeriod = sumStats(currentStats);
  const lastPeriod = sumStats(previousStats);

  const getChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };

  return {
    thisWeek: thisPeriod, // keeping keys same for compatibility
    lastWeek: lastPeriod,
    changes: {
      messagesChange: getChange(thisPeriod.messages, lastPeriod.messages),
      voiceChange: getChange(thisPeriod.voiceMinutes, lastPeriod.voiceMinutes),
      joinsChange: getChange(thisPeriod.joins, lastPeriod.joins),
      leavesChange: getChange(thisPeriod.leaves, lastPeriod.leaves),
      sanctionsChange: getChange(thisPeriod.sanctions, lastPeriod.sanctions)
    }
  };
};

/**
 * Get growth and retention metrics
 */
export const getGrowthAndRetention = async (guildId: string, options: { days?: number, startDate?: string | null, endDate?: string | null } = {}) => {
  const days = options.days || 90;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  if (!startKey) {
    const startDate = new Date(endKey);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }

  const dailyStats = await prisma.guildDailyStat.findMany({
    where: {
      guildId,
      dateKey: { gte: startKey, lte: endKey }
    },
    orderBy: { dateKey: 'asc' }
  });

  // Calculate cumulative net growth (joins - leaves)
  let cumulativeMembers = 0;
  const growthTrend = dailyStats.map(stat => {
    cumulativeMembers += stat.membersJoined - stat.membersLeft;
    return {
      dateKey: stat.dateKey,
      netGrowth: stat.membersJoined - stat.membersLeft,
      cumulativeGrowth: cumulativeMembers,
      activeMembers: stat.activeMembers,
      totalMembers: stat.totalMembers,
      retentionRate: stat.totalMembers > 0 ? Math.round((stat.activeMembers / stat.totalMembers) * 100) : 0
    };
  });

  // Get overall metrics
  const totalJoins = dailyStats.reduce((sum, s) => sum + s.membersJoined, 0);
  const totalLeaves = dailyStats.reduce((sum, s) => sum + s.membersLeft, 0);
  const avgActiveMembers = Math.round(
    dailyStats.reduce((sum, s) => sum + s.activeMembers, 0) / (dailyStats.length || 1)
  );
  const lastDayStats = dailyStats[dailyStats.length - 1];
  const currentRetention = lastDayStats 
    ? Math.round((lastDayStats.activeMembers / (lastDayStats.totalMembers || 1)) * 100)
    : 0;

  return {
    growthTrend,
    metrics: {
      totalJoins,
      totalLeaves,
      netGrowth: totalJoins - totalLeaves,
      avgActiveMembers,
      currentRetention
    }
  };
};

/**
 * Get Daily Algo analytics
 */
export const getDailyAlgoAnalytics = async (guildId: string, options: { days?: number, startDate?: string|null, endDate?: string|null } = {}) => {
  const days = options.days || 30;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  const finalEndKey = endKey.split('T')[0];
  if (!startKey) {
    const startDate = new Date(finalEndKey);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }
  const finalStartKey = startKey.split('T')[0];

  const startISO = new Date(finalStartKey + 'T00:00:00.000Z').toISOString();
  const endISO = new Date(finalEndKey + 'T23:59:59.999Z').toISOString();

  // Get recent daily algo runs
  const runs = await prisma.dailyAlgoRun.findMany({
    where: {
      guildId,
      createdAt: { gte: new Date(startISO), lte: new Date(endISO) }
    },
    include: {
      problem: true,
      submissions: true
    },
    orderBy: { createdAt: 'desc' }
  });

  // Get submission data
  const submissions = await prisma.dailyAlgoSubmission.findMany({
    where: {
      run: {
        guildId,
        createdAt: { gte: startISO, lte: endISO }
      }
    },
    include: {
      run: true
    }
  });

  // Calculate metrics
  const totalRuns = runs.length;
  const totalSubmissions = submissions.length;
  const completedSubmissions = submissions.filter(s => s.status === 'APPROVED').length;
  const avgSubmissionsPerRun = totalRuns > 0 ? Math.round(totalSubmissions / totalRuns) : 0;
  const completionRate = totalSubmissions > 0 ? Math.round((completedSubmissions / totalSubmissions) * 100) : 0;

  // Get top performers
  interface Performer {
    userId: string;
    name: string;
    submissions: number;
    validated: number;
    avgScore: number;
    scores: number[];
  }
  const performerMap: Record<string, Performer> = {};
  submissions.forEach(sub => {
    if (!performerMap[sub.authorId]) {
      performerMap[sub.authorId] = {
        userId: sub.authorId,
        name: sub.authorName,
        submissions: 0,
        validated: 0,
        avgScore: 0,
        scores: []
      };
    }
    performerMap[sub.authorId].submissions++;
    if (sub.status === 'APPROVED') {
      performerMap[sub.authorId].validated++;
      if (sub.scoreFinal !== null) {
        performerMap[sub.authorId].scores.push(sub.scoreFinal);
      }
    }
  });

  const topPerformers = Object.values(performerMap)
    .map(p => ({
      ...p,
      avgScore: p.scores.length > 0 ? Math.round((p.scores.reduce((a, b) => a + b, 0) / p.scores.length) * 100) / 100 : 0
    }))
    .sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0))
    .slice(0, 10);

  // Get difficulty distribution
  const difficultyMap: Record<string, number> = {};
  runs.forEach(run => {
    const diff = run.problem?.difficulty || 'inconnu';
    difficultyMap[diff] = (difficultyMap[diff] || 0) + 1;
  });

  // Get trend (runs per day)
  const trendMap: Record<string, number> = {};
  runs.forEach(run => {
    const dateKey = run.createdAt.toISOString().split('T')[0];
    trendMap[dateKey] = (trendMap[dateKey] || 0) + 1;
  });

  const trend = Object.entries(trendMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateKey, count]) => ({ dateKey, count }));

  return {
    metrics: {
      totalRuns,
      totalSubmissions,
      completedSubmissions,
      avgSubmissionsPerRun,
      completionRate
    },
    topPerformers,
    difficultyDistribution: Object.entries(difficultyMap).map(([difficulty, count]) => ({ difficulty, count })),
    trend
  };
};

/**
 * Get global member-to-member interaction graph
 */
export const getGlobalInteractions = async (client: any, guildId: string, options: { days?: number, startDate?: string, endDate?: string } = {}) => {
  const days = options.days || 30;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  const endKeyOnly = endKey.split('T')[0];
  if (!startKey) {
    const startDate = new Date(endKeyOnly);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }
  const startKeyOnly = startKey.split('T')[0];

  const finalEndKey = new Date(endKeyOnly + 'T23:59:59.999Z');
  const finalStartKey = new Date(startKeyOnly + 'T00:00:00.000Z');

  // Fetch audit logs in the timeframe
  const logs = await prisma.dashboardAuditLog.findMany({
    where: {
      guildId,
      dateIso: {
        gte: finalStartKey,
        lte: finalEndKey
      },
      module: { in: ['Messages', 'Interactions'] },
      action: { in: ['Message envoyé', 'Réaction ajoutée'] }
    },
    select: {
      user: true,
      action: true,
      details: true
    }
  });

  const extractIdFromUserStr = (str: string | null | undefined): string | null => {
    if (!str) return null;
    const match = str.match(/\(<@(\d+)>\)/);
    if (match) return match[1];
    const rawIdMatch = str.match(/^(\d+)$/);
    return rawIdMatch ? rawIdMatch[1] : null;
  };

  // Maps to aggregate counts
  const userActivity = new Map<string, number>();
  const edgeMap = new Map<string, { from: string; to: string; mention: number; reply: number; reaction: number }>();

  const addEdge = (from: string, to: string, type: 'mention' | 'reply' | 'reaction') => {
    if (from === to) return; // ignore self-interactions
    const key = from < to ? `${from}-${to}` : `${to}-${from}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, mention: 0, reply: 0, reaction: 0 };
      edgeMap.set(key, edge);
    }
    edge[type] += 1;

    userActivity.set(from, (userActivity.get(from) || 0) + 1);
    userActivity.set(to, (userActivity.get(to) || 0) + 1);
  };

  for (const log of logs) {
    const logUserId = extractIdFromUserStr(log.user);
    if (!logUserId) continue;

    if (log.action === 'Message envoyé') {
      const details = log.details || '';
      
      // Parse mentions
      const mentionRegex = /<@!?(\d+)>/g;
      let match;
      const processedMentions = new Set<string>();
      while ((match = mentionRegex.exec(details)) !== null) {
        const targetId = match[1];
        if (processedMentions.has(targetId)) continue;
        processedMentions.add(targetId);
        addEdge(logUserId, targetId, 'mention');
      }

      // Parse replies
      const replyMatch = details.match(/Réponse à:\s*<@!?(\d+)>/i);
      if (replyMatch) {
        const targetId = replyMatch[1];
        addEdge(logUserId, targetId, 'reply');
      }
    } else if (log.action === 'Réaction ajoutée') {
      const details = log.details || '';
      const targetMatch = details.match(/Cible:\s*.*?\(<@!?(\d+)>\)/i);
      if (targetMatch) {
        const targetId = targetMatch[1];
        addEdge(logUserId, targetId, 'reaction');
      }
    }
  }

  // Au-dela de cette taille le graphe n'est plus lisible et sa simulation de
  // forces, quadratique, sature le navigateur : on ne renvoie que les membres
  // les plus actifs et le client affiche le reste sous forme de compteur.
  const MAX_GRAPH_NODES = 300;

  const rankedUsers = [...userActivity.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  // On elargit la fenetre avant filtrage des bots pour ne pas descendre sous le plafond
  const candidates = rankedUsers.slice(0, MAX_GRAPH_NODES * 2);

  const candidateProfiles = await prisma.memberProfile.findMany({
    where: {
      guildId,
      userId: { in: candidates }
    },
    select: {
      userId: true,
      displayName: true,
      username: true,
      globalName: true,
      avatarUrl: true,
      isBot: true
    }
  });

  const profileMap = new Map(candidateProfiles.map(p => [p.userId, p]));

  const humanCandidates = candidates.filter(userId => {
    const p = profileMap.get(userId);
    return p ? !p.isBot : true; // filter out bots
  });

  const topUsers = humanCandidates.slice(0, MAX_GRAPH_NODES);
  const topUserSet = new Set(topUsers);

  const knownBots = candidates.length - humanCandidates.length;
  const hiddenMembersCount = Math.max(0, rankedUsers.length - knownBots - topUsers.length);

  // Filter edges to only include top users
  const filteredEdges: unknown[] = [];
  for (const edge of edgeMap.values()) {
    if (topUserSet.has(edge.from) && topUserSet.has(edge.to)) {
      if (edge.mention > 0) {
        filteredEdges.push({ from: edge.from, to: edge.to, type: 'mention', count: edge.mention });
      }
      if (edge.reply > 0) {
        filteredEdges.push({ from: edge.from, to: edge.to, type: 'reply', count: edge.reply });
      }
      if (edge.reaction > 0) {
        filteredEdges.push({ from: edge.from, to: edge.to, type: 'reaction', count: edge.reaction });
      }
    }
  }

  // Fetch member presences from Discord
  const statusMap = new Map<string, string>();
  const guild = client?.guilds?.cache?.get(guildId);
  if (guild && topUsers.length > 0) {
    // Un membre ayant coupé le suivi de sa présence reste dans le graphe, mais
    // son statut n'y est plus lisible : il est rendu comme hors-ligne.
    const presenceOptOuts = await findPresenceOptOuts(guildId, topUsers);
    const resolveStatus = (userId: string, status: string | undefined | null): string =>
      presenceOptOuts.has(userId) ? 'offline' : status || 'offline';

    try {
      const memberList = await guild.members.fetch({
        user: topUsers,
        withPresences: true
      });
      memberList.forEach((member: any) => {
        statusMap.set(member.id, resolveStatus(member.id, member.presence?.status));
      });
    } catch (fetchErr) {
      for (const userId of topUsers) {
        const member = guild.members.cache.get(userId);
        statusMap.set(userId, resolveStatus(userId, member?.presence?.status));
      }
    }
  } else {
    for (const userId of topUsers) {
      statusMap.set(userId, 'offline');
    }
  }

  const nodes = topUsers.map(userId => {
    const p = profileMap.get(userId);
    return {
      id: userId,
      label: p?.displayName || p?.globalName || p?.username || `User ${userId}`,
      avatar: p?.avatarUrl || null,
      activityCount: userActivity.get(userId) || 0,
      status: statusMap.get(userId) || 'offline'
    };
  });

  return { nodes, edges: filteredEdges, hiddenMembersCount, totalActiveMembers: userActivity.size };
};
