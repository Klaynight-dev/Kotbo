import { IncomingMessage, ServerResponse } from 'node:http';
import { Client, Routes } from 'discord.js';
import { prismaRead } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { cache } from '../../../utils/cache.js';
import { memberDisplaysGuildTag } from '../../../services/moderation/tagRoleService.js';
import {
  json,
  readJsonBody,
  getGuildMembers,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import {
  getHourlyHeatmapData,
  getWeekOverWeekComparison,
  getGrowthAndRetention,
  getDailyAlgoAnalytics,
  getGlobalInteractions,
  getCommandUsageAnalytics,
  getStaffPerformanceAnalytics,
} from '../../../services/analytics/dashboardAnalyticsService.js';
import { BucketZoner, ZONE_MARGIN_DAYS, shiftKey } from '../../../services/analytics/zonedBuckets.js';
import { resolveViewTimezone } from '../../../utils/timezone.js';

export async function handleAnalyticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'analytics') {
    return false;
  }

  // POST /api/dashboard/guilds/:guildId/analytics/rescan-members
  if (parts.length === 6 && parts[5] === 'rescan-members' && method === 'POST') {
    try {
      const body = await readJsonBody<{ force?: boolean }>(req);
      const force = !!body?.force;

      const { startMemberScraping } = await import('../../../services/analytics/memberScraperService.js');
      const result = await startMemberScraping(client, guildId, force);
      if (result.status === 'ALREADY_RUNNING') {
        json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
      } else {
        json(res, 200, {
          ok: true,
          message: result.status === 'ALREADY_COMPLETED'
            ? 'Les membres sont déjà synchronisés.'
            : 'Scraping des membres lancé avec succès.',
        });
      }
    } catch (err) {
      logger.error('AnalyticsAPI', 'POST rescan-members error:', err);
      json(res, 500, { error: 'Erreur lors du lancement du scraping membres' });
    }
    return true;
  }

  if (method !== 'GET') {
    return false;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/advanced?section=<retention|activity|churn|channels|social|words|moderation>
  if (parts.length === 6 && parts[5] === 'advanced') {
    const section = url.searchParams.get('section') ?? '';
    const { ADVANCED_SECTIONS, getAdvancedAnalytics } = await import('../../../services/analytics/advancedAnalyticsService.js');
    if (!(ADVANCED_SECTIONS as string[]).includes(section)) {
      json(res, 400, { error: `Section invalide. Attendu: ${ADVANCED_SECTIONS.join(', ')}` });
      return true;
    }
    try {
      // Préfixe `guild:<id>:` obligatoire : c'est ce que cache.invalidateGuild()
      // purge quand la config change (ex. activation des stats de mots).
      const timezone = await resolveViewTimezone(url.searchParams.get('tz'), guildId);
      const cacheKey = `guild:${guildId}:analytics:advanced:${section}:${timezone}`;
      const cached = await cache.get<Record<string, unknown>>(cacheKey);
      if (cached) {
        json(res, 200, cached);
        return true;
      }
      const data = await getAdvancedAnalytics(guildId, section as never, timezone);
      await cache.set(cacheKey, data, 300); // 5 min - calculs lourds
      json(res, 200, data);
    } catch (err) {
      logger.error('AnalyticsAPI', `Erreur analytics avancées (${section}):`, err);
      json(res, 500, { error: 'Erreur lors du calcul des statistiques avancées' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/channels/:channelId - Vue détaillée d'un salon
  if (parts.length === 7 && parts[5] === 'channels') {
    const channelId = parts[6];
    if (!/^\d{17,20}$/.test(channelId)) {
      json(res, 400, { error: 'Identifiant de salon invalide' });
      return true;
    }
    try {
      const days = Math.min(90, Math.max(7, parseInt(url.searchParams.get('days') || '30', 10) || 30));
      const timezone = await resolveViewTimezone(url.searchParams.get('tz'), guildId);
      const cacheKey = `guild:${guildId}:analytics:channel:${channelId}:${days}:${timezone}`;
      const cached = await cache.get<Record<string, unknown>>(cacheKey);
      if (cached) {
        json(res, 200, cached);
        return true;
      }
      const { getChannelDetail } = await import('../../../services/analytics/channelDetailService.js');
      const data = await getChannelDetail(client, guildId, channelId, days, timezone);
      await cache.set(cacheKey, data, 120); // 2 min - agrégats + lectures Discord
      json(res, 200, data);
    } catch (err) {
      logger.error('AnalyticsAPI', `Erreur détail salon ${channelId}:`, err);
      json(res, 500, { error: 'Erreur lors de la récupération des détails du salon' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/members/:userId - Member detailed analytics
  if (parts.length === 6 && parts[5] === 'members') {
    const userId = url.searchParams.get('userId');
    if (!userId) {
      json(res, 400, { error: 'userId requis' });
      return true;
    }
    try {
      const periodDays = Math.min(90, Math.max(7, parseInt(url.searchParams.get('period') || '30', 10)));
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - periodDays);
      const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

      const dailyStats = await prismaRead.memberDailyStat.findMany({
        where: { guildId, userId, dateKey: { gte: startDateKey } },
        orderBy: { dateKey: 'asc' },
      });

      const totalMessages = dailyStats.reduce((s, d) => s + d.messagesCount, 0);
      const totalVoice = dailyStats.reduce((s, d) => s + d.voiceMinutes, 0);
      const activeDays = dailyStats.length;

      json(res, 200, {
        userId,
        period: periodDays,
        totalMessages,
        totalVoiceMinutes: totalVoice,
        activeDays,
        dailyTrend: dailyStats.map(d => ({
          dateKey: d.dateKey,
          messages: d.messagesCount,
          voiceMinutes: d.voiceMinutes,
        })),
      });
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing member analytics:', err);
      json(res, 500, { error: 'Erreur analytics membre' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/correlation - Messages vs Voice correlation
  if (parts.length === 6 && parts[5] === 'correlation') {
    try {
      const periodDays = parseInt(url.searchParams.get('period') || '30', 10);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - periodDays);
      const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

      const memberStats = await prismaRead.memberDailyStat.groupBy({
        by: ['userId'],
        where: { guildId, dateKey: { gte: startDateKey } },
        _sum: { messagesCount: true, voiceMinutes: true },
      });

      const scatterData = memberStats
        .filter(m => (m._sum.messagesCount ?? 0) > 0 || (m._sum.voiceMinutes ?? 0) > 0)
        .map(m => ({
          userId: m.userId,
          messages: m._sum.messagesCount ?? 0,
          voice: m._sum.voiceMinutes ?? 0,
        }));

      json(res, 200, { data: scatterData });
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing correlation:', err);
      json(res, 500, { error: 'Erreur analytics correlation' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/invites - Active invitation codes
  if (parts.length === 6 && parts[5] === 'invites') {
    try {
      const discordGuild = client.guilds.cache.get(guildId);
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur Discord introuvable' });
        return true;
      }

      const activeInvites = await discordGuild.invites.fetch().catch(() => new Map());
      const invitesArray = [...activeInvites.values()];

      const periodDays = parseInt(url.searchParams.get('days') || url.searchParams.get('period') || '30', 10);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - periodDays + 1);

      const memberJoins = await prismaRead.memberInvite.findMany({
        where: {
          guildId,
          joinedAt: { gte: startDate },
          inviteCode: { not: null }
        },
        select: { inviteCode: true, joinedAt: true }
      });

      const labels: string[] = [];
      for (let i = 0; i < periodDays; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        labels.push(key);
      }

      const joinMap = new Map<string, Map<string, number>>();
      for (const j of memberJoins) {
        const code = j.inviteCode ?? 'unknown';
        const d = new Date(j.joinedAt);
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!joinMap.has(code)) joinMap.set(code, new Map());
        const dm = joinMap.get(code)!;
        dm.set(dateKey, (dm.get(dateKey) ?? 0) + 1);
      }

      // Batch-fetch all unique inviter members to avoid N+1 API calls
      const inviterIds = new Set<string>();
      for (const inv of invitesArray) {
        if (inv.inviter?.id && !discordGuild.members.cache.has(inv.inviter.id)) {
          inviterIds.add(inv.inviter.id);
        }
      }
      if (inviterIds.size > 0) {
        await discordGuild.members.fetch({ user: [...inviterIds] }).catch(() => null);
      }

      const formattedInvites: Array<{ code: string; inviterId: string | null; inviterTag: string; inviterAvatarUrl: string | null; createdBy: string; uses: number; maxUses: number | null; expiresAt: string | null; createdAt: string | null; trend: { labels: string[]; counts: number[]; totalJoined: number } }> = [];
      for (const inv of invitesArray) {
        const inviterId = inv.inviter?.id ?? null;
        let createdBy = inv.inviter?.tag || 'Inconnu';
        if (inviterId) {
          const member = discordGuild.members.cache.get(inviterId);
          if (member) createdBy = member.displayName || member.user?.tag || createdBy;
        }

        const code = inv.code ?? 'unknown';
        const dm = joinMap.get(code) ?? new Map();
        const counts = labels.map(l => dm.get(l) ?? 0);
        const totalJoined = counts.reduce((s, v) => s + v, 0);

        formattedInvites.push({
          code: inv.code,
          inviterId,
          inviterTag: inv.inviter?.tag || 'Inconnu',
          inviterAvatarUrl: inv.inviter?.displayAvatarURL ? inv.inviter.displayAvatarURL({ size: 64 }) : null,
          createdBy,
          uses: inv.uses || 0,
          maxUses: inv.maxUses,
          expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
          createdAt: inv.createdAt ? inv.createdAt.toISOString() : null,
          trend: {
            labels,
            counts,
            totalJoined,
          }
        });
      }

      for (const [code, dm] of joinMap.entries()) {
        if (formattedInvites.find(f => f.code === code)) continue;
        const counts = labels.map(l => dm.get(l) ?? 0);
        const totalJoined = counts.reduce((s, v) => s + v, 0);
        formattedInvites.push({
          code,
          inviterId: null,
          inviterTag: 'Inconnu',
          inviterAvatarUrl: null,
          createdBy: 'Inconnu',
          uses: 0,
          maxUses: null,
          expiresAt: null,
          createdAt: null,
          trend: { labels, counts, totalJoined }
        });
      }

      formattedInvites.sort((a, b) => (b.uses || 0) - (a.uses || 0));
      json(res, 200, formattedInvites);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing invites analytics:', err);
      json(res, 500, { error: 'Erreur analytics invites' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/heatmap - Hourly activity heatmap
  if (parts.length === 6 && parts[5] === 'heatmap') {
    try {
      const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');
      const timezone = await resolveViewTimezone(url.searchParams.get('tz'), guildId);
      const heatmapData = await getHourlyHeatmapData(guildId, { days, startDate, endDate, timezone });
      json(res, 200, heatmapData);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing heatmap:', err);
      json(res, 500, { error: 'Erreur heatmap analytics' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/weekly-comparison - Week over week comparison
  if (parts.length === 6 && parts[5] === 'weekly-comparison') {
    try {
      const offset = Math.min(12, Math.max(1, parseInt(url.searchParams.get('offset') || '1', 10)));
      const rawMode = url.searchParams.get('mode') || 'week';
      const mode = (rawMode === 'month' ? 'month' : 'week') as 'week' | 'month';
      const comparisonData = await getWeekOverWeekComparison(guildId, { offset, mode });
      json(res, 200, comparisonData);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing weekly comparison:', err);
      json(res, 500, { error: 'Erreur comparaison semaine/semaine' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/growth-retention - Growth and retention metrics
  if (parts.length === 6 && parts[5] === 'growth-retention') {
    try {
      const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') || '90', 10)));
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');
      const growthData = await getGrowthAndRetention(guildId, { days, startDate, endDate });
      json(res, 200, growthData);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing growth/retention:', err);
      json(res, 500, { error: 'Erreur growth/retention analytics' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/daily-algo - Daily Algo analytics
  if (parts.length === 6 && parts[5] === 'daily-algo') {
    try {
      const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');
      const algoData = await getDailyAlgoAnalytics(guildId, { days, startDate, endDate });
      json(res, 200, algoData);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing daily algo analytics:', err);
      json(res, 500, { error: 'Erreur daily algo analytics' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics/interactions
  if (parts.length === 6 && parts[5] === 'interactions') {
    try {
      const days = parseInt(url.searchParams.get('period') || '30', 10);
      const startDate = url.searchParams.get('startDate') || undefined;
      const endDate = url.searchParams.get('endDate') || undefined;

      const cacheKey = `guild:${guildId}:analytics:interactions:${days}:${startDate || ''}:${endDate || ''}`;
      const cached = await cache.get<Record<string, unknown>>(cacheKey);
      if (cached) {
        json(res, 200, cached);
        return true;
      }

      const data = await getGlobalInteractions(client, guildId, { days, startDate, endDate });
      await cache.set(cacheKey, data, 60); // 1 min - parsing complet des logs d'audit
      json(res, 200, data);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error getting global interactions:', err);
      json(res, 500, { error: 'Erreur récupération interactions' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/analytics - Full analytics data
  if (parts.length === 5) {
    try {
      const queryStartDate = url.searchParams.get('startDate');
      const queryEndDate = url.searchParams.get('endDate');
      const now = new Date();
      let startDate: Date;
      let endDate: Date;
      let periodDays: number;

      if (queryStartDate) {
        startDate = new Date(queryStartDate);
        endDate = queryEndDate ? new Date(queryEndDate) : new Date();
        const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
        periodDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      } else {
        periodDays = Math.min(365, Math.max(1, parseInt(url.searchParams.get('period') || '30', 10)));
        endDate = new Date();
        startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - periodDays);
      }

      // Fuseau de lecture : les creneaux horaires sont stockes en UTC, les
      // libelles doivent sortir a l'heure murale du lecteur. Il entre dans la
      // cle de cache, sans quoi deux lecteurs de fuseaux differents se
      // renvoyaient mutuellement des courbes decalees.
      const viewTimezone = await resolveViewTimezone(url.searchParams.get('tz'), guildId);

      // Check cache (30s TTL - live data stays fresh enough, avoids hammering DB on refreshes)
      const cacheKey = `analytics:${guildId}:${periodDays}:${queryStartDate || ''}:${queryEndDate || ''}:${url.searchParams.get('granularity') || ''}:${viewTimezone}`;
      const cached = await cache.get<Record<string, unknown>>(cacheKey);
      if (cached) {
        json(res, 200, cached);
        return true;
      }

      const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
      const endDateKey = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

      const granularity = url.searchParams.get('granularity');
      const use30Min = periodDays === 1 || granularity === '30';
      const useWeeklyAggregation = periodDays > 90 && !use30Min;

      const discordGuild = client.guilds.cache.get(guildId);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const sevenDaysAgo = new Date(endDate);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // ── Wave 1: All independent DB queries in parallel ──
      const [
        dailyStatsRaw,
        channelStats,
        voiceChannelStats,
        topMessageMembers,
        topVoiceMembers,
        sanctions,
        activeSanctions,
        staffActivities,
        activeAbsences,
        totalStaff,
        meetings,
        candidatures,
        algoRuns,
        DBInvites,
        memberProfiles,
        inactiveMembers,
        avgTenureResult,
        recentSanctionsList,
        joinedInRange,
        stayedInRange,
        recentJoinsList,
        recentLeavesList,
      ] = await Promise.all([
        // Daily stats
        use30Min
          ? prismaRead.guildHourlyStat.findMany({
              // Fenetre elargie d'un jour de chaque cote : le fuseau du lecteur
              // fait entrer dans sa journee locale des creneaux UTC de la veille
              // ou du lendemain. Le tri sur les cles locales vient apres.
              where: {
                guildId,
                dateKey: {
                  gte: shiftKey(startDateKey, -ZONE_MARGIN_DAYS),
                  lte: shiftKey(endDateKey, ZONE_MARGIN_DAYS),
                },
              },
              orderBy: [{ dateKey: 'desc' }, { hour: 'desc' }],
              // 48 creneaux utiles, plus la marge des deux jours elargis.
              take: 48 + 48,
            }).then(hourlyStats => {
              hourlyStats.reverse();
              const zoner = new BucketZoner(viewTimezone);
              const inRange = hourlyStats
                .map(h => ({ stat: h, bucket: zoner.fromKeyHour(h.dateKey, h.hour) }))
                .filter(({ bucket }) => bucket.dateKey >= startDateKey && bucket.dateKey <= endDateKey)
                .slice(-48);

              const result: any[] = [];
              for (const { stat: h, bucket } of inRange) {
                const hourStr = String(bucket.hour).padStart(2, '0');
                result.push({
                  dateKey: `${bucket.dateKey} ${hourStr}h00`,
                  messagesCount: Math.round(h.messagesCount / 2),
                  voiceMinutes: Math.round(h.voiceMinutes / 2),
                  voiceSessionsCount: 0,
                  membersJoined: Math.round(h.joinsCount / 2),
                  membersLeft: Math.round(h.leavesCount / 2),
                  totalMembers: 0,
                  onlineMembers: h.onlineMembers,
                  peakOnline: h.onlineMembers,
                  peakVoice: h.voiceMembers,
                  sanctionsCount: 0,
                });
                result.push({
                  dateKey: `${bucket.dateKey} ${hourStr}h30`,
                  messagesCount: Math.floor(h.messagesCount / 2),
                  voiceMinutes: Math.floor(h.voiceMinutes / 2),
                  voiceSessionsCount: 0,
                  membersJoined: Math.floor(h.joinsCount / 2),
                  membersLeft: Math.floor(h.leavesCount / 2),
                  totalMembers: 0,
                  onlineMembers: h.onlineMembers,
                  peakOnline: h.onlineMembers,
                  peakVoice: h.voiceMembers,
                  sanctionsCount: 0,
                });
              }
              return result;
            })
          : prismaRead.guildDailyStat.findMany({
              where: { guildId, dateKey: { gte: startDateKey, lte: endDateKey } },
              orderBy: { dateKey: 'asc' },
            }),
        // Channel stats (messages)
        prismaRead.channelDailyStat.groupBy({
          by: ['channelId'],
          where: { guildId, dateKey: { gte: startDateKey, lte: endDateKey } },
          _sum: { messagesCount: true },
          orderBy: { _sum: { messagesCount: 'desc' } },
          take: 15,
        }),
        // Channel stats (voice)
        prismaRead.channelDailyStat.groupBy({
          by: ['channelId'],
          where: { guildId, dateKey: { gte: startDateKey, lte: endDateKey }, voiceMinutes: { gt: 0 } },
          _sum: { voiceMinutes: true },
          orderBy: { _sum: { voiceMinutes: 'desc' } },
          take: 15,
        }),
        // Top message members
        prismaRead.memberProfile.findMany({
          where: { guildId, isBot: false, messageCount: { gt: 0 } },
          orderBy: { messageCount: 'desc' },
          take: 100,
          select: {
            userId: true, displayName: true, username: true, globalName: true,
            avatarUrl: true, messageCount: true, lastMessageAt: true,
          },
        }),
        // Top voice members
        prismaRead.memberProfile.findMany({
          where: { guildId, isBot: false, voiceTimeSeconds: { gt: 0 } },
          orderBy: { voiceTimeSeconds: 'desc' },
          take: 100,
          select: {
            userId: true, displayName: true, username: true, globalName: true,
            avatarUrl: true, voiceTimeSeconds: true, voiceSessionCount: true,
          },
        }),
        // Sanctions
        prismaRead.sanction.findMany({
          where: { guildId, createdAt: { gte: startDate, lte: endDate } },
          select: { type: true, status: true, moderatorUserId: true, moderatorTag: true, targetUserId: true, targetTag: true, createdAt: true },
        }),
        // Active sanctions count
        prismaRead.sanction.count({ where: { guildId, status: 'ACTIVE' } }),
        // Staff activities
        prismaRead.staffActivity.findMany({
          where: { guildId, activityDate: { gte: startDate, lte: endDate } },
          include: { staffMember: { select: { userId: true, displayName: true, username: true, avatarUrl: true, grade: true } } },
        }),
        // Active absences
        prismaRead.staffAbsence.count({ where: { guildId, status: { in: ['PENDING', 'APPROVED', 'ACKNOWLEDGED'] } } }),
        // Total staff
        prismaRead.staffMember.count({ where: { guildId } }),
        // Meetings
        prismaRead.staffMeeting.findMany({
          where: { guildId, scheduledAt: { gte: startDate, lte: endDate } },
          include: { _count: { select: { presences: true } }, presences: { where: { status: 'PRESENT' }, select: { id: true } } },
        }),
        // Candidatures
        prismaRead.recruitmentCandidature.groupBy({
          by: ['status'],
          where: { guildId },
          _count: true,
        }),
        // Algo runs
        prismaRead.dailyAlgoRun.findMany({
          where: { guildId, createdAt: { gte: startDate, lte: endDate } },
          include: { _count: { select: { submissions: true } } },
        }),
        // Top inviters
        prismaRead.memberInvite.groupBy({
          by: ['inviterId'],
          where: { guildId, inviterId: { not: null }, joinedAt: { gte: startDate, lte: endDate } },
          _count: true,
          orderBy: { _count: { inviterId: 'desc' } },
          take: 10,
        }),
        // Role distribution (only fetch roleIds, not full profiles)
        prismaRead.memberProfile.findMany({
          where: { guildId, isBot: false, guildLeftAt: null },
          select: { rolesSnapshot: true },
        }),
        // Inactive members
        prismaRead.memberProfile.count({
          where: {
            guildId,
            isBot: false,
            guildLeftAt: null,
            OR: [
              { lastMessageAt: null },
              { lastMessageAt: { lt: thirtyDaysAgo } },
            ],
          },
        }),
        // Avg tenure
        prismaRead.memberProfile.findMany({
          where: { guildId, isBot: false, guildLeftAt: null, guildJoinedAt: { not: null } },
          select: { guildJoinedAt: true },
        }).then((members) => {
          if (members.length === 0) return 0;
          return Math.round(members.reduce((sum, m) => sum + (now.getTime() - (m.guildJoinedAt?.getTime() ?? now.getTime())) / 86400000, 0) / members.length);
        }),
        // Recent sanctions
        prismaRead.sanction.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        // Retention: joined in range
        prismaRead.memberProfile.count({
          where: { guildId, isBot: false, guildJoinedAt: { gte: startDate, lte: sevenDaysAgo } },
        }),
        // Retention: stayed in range
        prismaRead.memberProfile.count({
          where: {
            guildId,
            isBot: false,
            guildJoinedAt: { gte: startDate, lte: sevenDaysAgo },
            OR: [{ guildLeftAt: null }, { guildLeftAt: { gt: endDate } }],
          },
        }),
        // Recent joins
        prismaRead.memberProfile.findMany({
          where: { guildId, guildJoinedAt: { not: null } },
          orderBy: { guildJoinedAt: 'desc' },
          take: 20,
          select: { userId: true, displayName: true, username: true, globalName: true, avatarUrl: true, guildJoinedAt: true },
        }),
        // Recent leaves
        prismaRead.memberProfile.findMany({
          where: { guildId, guildLeftAt: { not: null } },
          orderBy: { guildLeftAt: 'desc' },
          take: 20,
          select: { userId: true, displayName: true, username: true, globalName: true, avatarUrl: true, guildLeftAt: true },
        }),
      ]);

      const [commandUsage, staffPerformance] = await Promise.all([
        getCommandUsageAnalytics(guildId, { startDate: startDate.toISOString(), endDate: endDate.toISOString() }),
        getStaffPerformanceAnalytics(guildId, { startDate: startDate.toISOString(), endDate: endDate.toISOString() }),
      ]);

      // ── Process daily stats for weekly aggregation if needed ──
      let dailyStats: any[] = dailyStatsRaw as any[];
      if (useWeeklyAggregation && !use30Min) {
        const weekMap = new Map<string, any>();
        for (const d of dailyStats) {
          const date = new Date(d.dateKey + 'T12:00:00Z');
          const dayOfWeek = date.getUTCDay();
          const monday = new Date(date);
          monday.setUTCDate(date.getUTCDate() - ((dayOfWeek + 6) % 7));
          const weekKey = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
          if (!weekMap.has(weekKey)) {
            weekMap.set(weekKey, {
              dateKey: weekKey, messagesCount: 0, voiceMinutes: 0, voiceSessionsCount: 0,
              membersJoined: 0, membersLeft: 0, totalMembers: d.totalMembers,
              onlineMembers: 0, peakOnline: 0, peakVoice: 0, sanctionsCount: 0, _dayCount: 0,
            });
          }
          const w = weekMap.get(weekKey)!;
          w.messagesCount += d.messagesCount;
          w.voiceMinutes += d.voiceMinutes;
          w.voiceSessionsCount += d.voiceSessionsCount;
          w.membersJoined += d.membersJoined;
          w.membersLeft += d.membersLeft;
          w.totalMembers = d.totalMembers;
          w.onlineMembers = Math.max(w.onlineMembers, d.onlineMembers);
          w.peakOnline = Math.max(w.peakOnline, d.peakOnline);
          w.peakVoice = Math.max(w.peakVoice, d.peakVoice);
          w.sanctionsCount += d.sanctionsCount;
          w._dayCount++;
        }
        dailyStats = [...weekMap.values()].sort((a: any, b: any) => a.dateKey.localeCompare(b.dateKey));
      }

      // ── Wave 2: Queries that depend on Wave 1 results (in parallel) ──
      // Collect all user IDs that need avatar lookups to batch them
      const avatarUserIds = new Set<string>();
      const modCounts = new Map<string, { count: number; tag: string }>();
      for (const s of sanctions) {
        const existing = modCounts.get(s.moderatorUserId) ?? { count: 0, tag: s.moderatorTag ?? 'Inconnu' };
        existing.count++;
        modCounts.set(s.moderatorUserId, existing);
        avatarUserIds.add(s.moderatorUserId);
      }
      const targetCounts = new Map<string, { count: number; tag: string }>();
      for (const s of sanctions) {
        const existing = targetCounts.get(s.targetUserId) ?? { count: 0, tag: s.targetTag ?? 'Inconnu' };
        existing.count++;
        targetCounts.set(s.targetUserId, existing);
        avatarUserIds.add(s.targetUserId);
      }
      for (const s of recentSanctionsList) {
        avatarUserIds.add(s.targetUserId);
        avatarUserIds.add(s.moderatorUserId);
      }
      const inviterUserIds = DBInvites.filter(i => i.inviterId).map(i => i.inviterId!);
      for (const id of inviterUserIds) avatarUserIds.add(id);

      // Batch-fetch all needed profiles in one query
      const [allProfiles, clanData] = await Promise.all([
        avatarUserIds.size > 0
          ? prismaRead.memberProfile.findMany({
              where: { guildId, userId: { in: [...avatarUserIds] } },
              select: { userId: true, avatarUrl: true, displayName: true, username: true },
            })
          : Promise.resolve([]),
        // Tag du serveur (en parallèle du fetch des profils).
        // La détection s'appuie uniquement sur `user.primary_guild`, l'API
        // officielle : un membre porte le tag ou non. Chercher « [TAG] » dans
        // les pseudos comptait comme porteurs des membres qui écrivent juste le
        // nom du serveur dans leur pseudo, et ratait ceux qui portent le vrai
        // tag sans le mentionner.
        (async () => {
          if (!discordGuild) return { clanTag: null as string | null, clanTaggedMembersCount: 0, taggedMembersList: [] as any[] };
          let clanTag: string | null = null;
          try {
            const rawGuild = await client.rest.get(Routes.guild(guildId)) as any;
            if (rawGuild.clan?.tag) clanTag = rawGuild.clan.tag;
          } catch (err) {
            logger.debug('AnalyticsAPI', 'Error fetching raw guild clan info (non-critical): ' + String(err));
          }
          if (!clanTag) clanTag = (discordGuild as any).clan?.tag || (discordGuild as any).clanTag;

          let clanTaggedMembersCount = 0;
          let taggedMembersList: any[] = [];
          try {
            const allMembers = await getGuildMembers(discordGuild);
            if (!clanTag) {
              for (const [_, m] of allMembers) {
                const primaryGuild = (m.user as any).primaryGuild;
                if (primaryGuild && primaryGuild.identityGuildId === guildId && primaryGuild.tag) {
                  clanTag = primaryGuild.tag;
                  break;
                }
              }
            }
            if (clanTag) {
              const taggedMembers = allMembers.filter((m) => memberDisplaysGuildTag(m));
              clanTaggedMembersCount = taggedMembers.size;
              taggedMembersList = Array.from(taggedMembers.values());
            }
          } catch (fetchErr) {
            logger.error('AnalyticsAPI', 'Error fetching guild members for tag analytics:', fetchErr);
          }
          return { clanTag, clanTaggedMembersCount, taggedMembersList };
        })(),
      ]);

      // Build profile lookup map
      const profileMap = new Map(allProfiles.map(p => [p.userId, p]));

      const topChannels = channelStats.map(ch => {
        const discordChannel = discordGuild?.channels.cache.get(ch.channelId);
        return {
          channelId: ch.channelId,
          channelName: discordChannel?.name ?? `canal-${ch.channelId.slice(-4)}`,
          messagesCount: ch._sum.messagesCount ?? 0,
        };
      });

      const topVoiceChannels = voiceChannelStats.map(ch => {
        const discordChannel = discordGuild?.channels.cache.get(ch.channelId);
        return {
          channelId: ch.channelId,
          channelName: discordChannel?.name ?? `vocal-${ch.channelId.slice(-4)}`,
          voiceMinutes: ch._sum.voiceMinutes ?? 0,
        };
      });

      const sanctionsByType = {
        WARN: sanctions.filter(s => s.type === 'WARN').length,
        KICK: sanctions.filter(s => s.type === 'KICK').length,
        TIMEOUT: sanctions.filter(s => s.type === 'TIMEOUT').length,
        TEMP_BAN: sanctions.filter(s => s.type === 'TEMP_BAN').length,
        BAN: sanctions.filter(s => s.type === 'BAN').length,
      };

      const topModerators = [...modCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([userId, data]) => ({
          userId,
          moderatorTag: data.tag,
          count: data.count,
          avatarUrl: profileMap.get(userId)?.avatarUrl ?? null,
        }));

      const mostSanctioned = [...targetCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([userId, data]) => ({
          userId,
          tag: data.tag,
          count: data.count,
          avatarUrl: profileMap.get(userId)?.avatarUrl ?? null,
        }));

      const recentSanctions = recentSanctionsList.map(s => ({
        id: s.id,
        type: s.type,
        targetUserId: s.targetUserId,
        targetTag: s.targetTag ?? 'Inconnu',
        targetAvatarUrl: profileMap.get(s.targetUserId)?.avatarUrl ?? null,
        moderatorUserId: s.moderatorUserId,
        moderatorTag: s.moderatorTag ?? 'Inconnu',
        moderatorAvatarUrl: profileMap.get(s.moderatorUserId)?.avatarUrl ?? null,
        reason: s.reason,
        createdAt: s.createdAt.toISOString(),
      }));

      const topInviters = DBInvites.map(inv => {
        const p = inv.inviterId ? profileMap.get(inv.inviterId) : null;
        return {
          inviterId: inv.inviterId,
          tag: p?.displayName ?? p?.username ?? 'Inconnu',
          count: inv._count,
        };
      });

      const staffAgg = new Map<string, { messages: number; voiceMinutes: number; name: string; grade: string; avatarUrl: string | null }>();
      for (const a of staffActivities) {
        const key = a.staffUserId;
        const existing = staffAgg.get(key) ?? { messages: 0, voiceMinutes: 0, name: a.staffMember.displayName ?? a.staffMember.username ?? 'Inconnu', grade: a.staffMember.grade, avatarUrl: a.staffMember.avatarUrl };
        existing.messages += a.messageCount;
        existing.voiceMinutes += a.voiceMinutes;
        staffAgg.set(key, existing);
      }
      const staffLeaderboard = [...staffAgg.entries()]
        .map(([id, data]) => ({ staffId: id, ...data, score: data.messages + data.voiceMinutes * 2 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);

      const avgMeetingAttendance = meetings.length > 0
        ? Math.round(meetings.reduce((sum, m) => sum + m.presences.length, 0) / meetings.length * 10) / 10
        : 0;

      const recruitmentPipeline = candidatures.map(c => ({ status: c.status, count: c._count }));

      const algoAvgParticipation = algoRuns.length > 0
        ? Math.round(algoRuns.reduce((sum, r) => sum + r._count.submissions, 0) / algoRuns.length * 10) / 10
        : 0;

      const roleCounts = new Map<string, number>();
      for (const mp of memberProfiles) {
        for (const roleId of mp.rolesSnapshot) {
          roleCounts.set(roleId, (roleCounts.get(roleId) ?? 0) + 1);
        }
      }
      const roleDistribution = [...roleCounts.entries()]
        .map(([roleId, count]) => {
          const discordRole = discordGuild?.roles.cache.get(roleId);
          return {
            roleId,
            roleName: discordRole?.name ?? `Rôle ${roleId.slice(-4)}`,
            color: discordRole?.hexColor ?? '#99AAB5',
            count,
          };
        })
        .filter(r => r.roleName !== '@everyone')
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      const retentionRate = joinedInRange > 0 ? Math.round((stayedInRange / joinedInRange) * 100) : 0;
      const avgTenureDays = avgTenureResult;

      const totalMembers = discordGuild?.memberCount ?? 0;
      const onlineNow = discordGuild?.members.cache.filter(m => m.presence?.status === 'online').size ?? 0;
      const idleNow = discordGuild?.members.cache.filter(m => m.presence?.status === 'idle').size ?? 0;
      const dndNow = discordGuild?.members.cache.filter(m => m.presence?.status === 'dnd').size ?? 0;
      const voiceNow = discordGuild?.members.cache.filter(m => !!m.voice?.channelId).size ?? 0;
      const botsCount = discordGuild?.members.cache.filter(m => m.user.bot).size ?? 0;

      // ── Join/Leave detail for daily trends ──
      let dailyJoinsLeaves: Array<{ dateKey: string; joins: unknown[]; leaves: unknown[]; invites: unknown[] }> = [];
      if (!useWeeklyAggregation) {
        const [allJoins, allLeaves, allInviteJoins] = await Promise.all([
          prismaRead.memberProfile.findMany({
            where: { guildId, isBot: false, guildJoinedAt: { gte: startDate, lte: endDate } },
            select: { userId: true, displayName: true, username: true, globalName: true, avatarUrl: true, guildJoinedAt: true },
            take: 2000,
          }),
          prismaRead.memberProfile.findMany({
            where: { guildId, isBot: false, guildLeftAt: { gte: startDate, lte: endDate } },
            select: { userId: true, displayName: true, username: true, globalName: true, avatarUrl: true, guildLeftAt: true },
            take: 2000,
          }),
          prismaRead.memberInvite.findMany({
            where: { guildId, joinedAt: { gte: startDate, lte: endDate } },
            select: { userId: true, inviteCode: true, inviterId: true, inviterTag: true, joinedAt: true, leftAt: true },
            take: 2000,
          }),
        ]);

        const joinsMap = new Map<string, unknown[]>();
        for (const j of allJoins) {
          if (!j.guildJoinedAt) continue;
          const d = j.guildJoinedAt;
          const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          if (!joinsMap.has(key)) joinsMap.set(key, []);
          joinsMap.get(key)!.push({ userId: j.userId, name: j.displayName ?? j.globalName ?? j.username ?? 'Inconnu', avatarUrl: j.avatarUrl, joinedAt: j.guildJoinedAt?.toISOString() });
        }
        const leavesMap = new Map<string, unknown[]>();
        for (const l of allLeaves) {
          if (!l.guildLeftAt) continue;
          const d = l.guildLeftAt;
          const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          if (!leavesMap.has(key)) leavesMap.set(key, []);
          leavesMap.get(key)!.push({ userId: l.userId, name: l.displayName ?? l.globalName ?? l.username ?? 'Inconnu', avatarUrl: l.avatarUrl, leftAt: l.guildLeftAt?.toISOString() });
        }
        const invitesMap = new Map<string, unknown[]>();
        for (const i of allInviteJoins) {
          if (!i.joinedAt) continue;
          const d = i.joinedAt as Date;
          const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          if (!invitesMap.has(key)) invitesMap.set(key, []);
          invitesMap.get(key)!.push({ userId: i.userId, inviteCode: i.inviteCode, inviterId: i.inviterId, inviterTag: i.inviterTag, joinedAt: (i.joinedAt as Date)?.toISOString(), leftAt: (i.leftAt as Date | null)?.toISOString() ?? null });
        }

        dailyJoinsLeaves = dailyStats.map((d: any) => ({
          dateKey: d.dateKey,
          joins: joinsMap.get(d.dateKey.split(' ')[0]) ?? [],
          leaves: leavesMap.get(d.dateKey.split(' ')[0]) ?? [],
          invites: invitesMap.get(d.dateKey.split(' ')[0]) ?? [],
        }));
      } else {
        dailyJoinsLeaves = dailyStats.map((d: any) => ({ dateKey: d.dateKey, joins: [], leaves: [], invites: [] }));
      }

      const totalMessages = dailyStats.reduce((sum: number, d: any) => sum + d.messagesCount, 0);
      const totalVoiceMinutes = dailyStats.reduce((sum: number, d: any) => sum + d.voiceMinutes, 0);
      const totalJoins = dailyStats.reduce((sum: number, d: any) => sum + d.membersJoined, 0);
      const totalLeaves = dailyStats.reduce((sum: number, d: any) => sum + d.membersLeft, 0);

      const halfPeriod = Math.floor(periodDays / 2);
      const midDate = new Date(endDate);
      midDate.setDate(midDate.getDate() - halfPeriod);
      const midDateKey = `${midDate.getFullYear()}-${String(midDate.getMonth() + 1).padStart(2, '0')}-${String(midDate.getDate()).padStart(2, '0')}`;
      const recentStats = dailyStats.filter((d: any) => d.dateKey >= midDateKey);
      const olderStats = dailyStats.filter((d: any) => d.dateKey < midDateKey);
      const recentMessages = recentStats.reduce((s: number, d: any) => s + d.messagesCount, 0);
      const olderMessages = olderStats.reduce((s: number, d: any) => s + d.messagesCount, 0);
      const messagesTrend = olderMessages > 0 ? Math.round((recentMessages - olderMessages) / olderMessages * 100) : 0;

      const { clanTag, clanTaggedMembersCount, taggedMembersList } = clanData;

      const analyticsPayload = {
        period: periodDays,
        // Fuseau dans lequel les libelles horaires ont ete calcules : le
        // dashboard l'affiche, pour qu'un pic annonce a 14h ne laisse aucun
        // doute sur l'horloge qui le mesure.
        timezone: viewTimezone,
        clanTag,
        clanTaggedMembersCount,
        live: {
          totalMembers,
          onlineMembers: onlineNow,
          idleMembers: idleNow,
          dndMembers: dndNow,
          offlineMembers: totalMembers - onlineNow - idleNow - dndNow - botsCount,
          voiceConnected: voiceNow,
          botsCount,
          humansCount: totalMembers - botsCount,
        },
        totals: {
          messages: totalMessages,
          voiceMinutes: totalVoiceMinutes,
          joins: totalJoins,
          leaves: totalLeaves,
          netGrowth: totalJoins - totalLeaves,
          activeDays: dailyStats.length,
          sanctions: sanctions.length,
          warns: sanctionsByType.WARN,
          kicks: sanctionsByType.KICK,
          bans: sanctionsByType.BAN + sanctionsByType.TEMP_BAN,
          timeouts: sanctionsByType.TIMEOUT,
          retentionRate,
          activeAbsences,
          totalStaff,
          inactiveMembers,
          avgTenureDays,
          algoAvgParticipation,
          avgMeetingAttendance,
          messagesTrend,
        },
        summary: {
          totalMessages,
          totalVoiceMinutes,
          totalJoins,
          totalLeaves,
          messagesTrend,
        },
        dailyTrend: dailyStats.map((d: any) => {
          const datePart = d.dateKey.split(' ')[0];
          const trendDate = new Date(datePart + 'T23:59:59.999Z');
          const count = clanTag
            ? taggedMembersList.filter((m: any) => m.joinedAt && m.joinedAt <= trendDate).length
            : 0;
          const dayData = dailyJoinsLeaves.find(jl => jl.dateKey === d.dateKey);
          return {
            dateKey: d.dateKey,
            messages: d.messagesCount,
            voiceMinutes: d.voiceMinutes,
            voiceSessions: d.voiceSessionsCount,
            membersJoined: d.membersJoined,
            membersLeft: d.membersLeft,
            totalMembers: d.totalMembers,
            onlineMembers: d.onlineMembers,
            peakOnline: d.peakOnline,
            peakVoice: d.peakVoice,
            sanctions: d.sanctionsCount,
            taggedMembersCount: count,
            memberJoins: dayData?.joins || [],
            memberLeaves: dayData?.leaves || [],
            invites: dayData?.invites || [],
          };
        }),
        topChannels,
        topVoiceChannels,
        topMessageMembers: topMessageMembers.map(m => ({
          userId: m.userId,
          name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
          avatarUrl: m.avatarUrl,
          messageCount: m.messageCount,
          lastMessageAt: m.lastMessageAt?.toISOString() ?? null,
        })),
        topVoiceMembers: topVoiceMembers.map(m => ({
          userId: m.userId,
          name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
          avatarUrl: m.avatarUrl,
          voiceTimeSeconds: m.voiceTimeSeconds,
          voiceSessionCount: m.voiceSessionCount,
        })),
        topInviters,
        topModerators,
        topSanctionedMembers: mostSanctioned.map(s => ({
          userId: s.userId,
          targetUserId: s.userId,
          targetTag: s.tag,
          count: s.count,
          avatarUrl: s.avatarUrl,
        })),
        recentSanctions,
        moderation: {
          totals: {
            warns: sanctionsByType.WARN,
            kicks: sanctionsByType.KICK,
            bans: sanctionsByType.BAN + sanctionsByType.TEMP_BAN,
            timeouts: sanctionsByType.TIMEOUT,
          },
          topModerators: topModerators,
          topSanctionedMembers: mostSanctioned.map(s => ({
            userId: s.userId,
            targetUserId: s.userId,
            targetTag: s.tag,
            count: s.count,
            avatarUrl: s.avatarUrl,
          })),
          recentSanctions,
          activeSanctions,
        },
        staff: {
          leaderboard: staffLeaderboard,
          activeAbsences,
          totalStaff,
          meetings: meetings.length,
          avgMeetingAttendance,
        },
        recruitmentPipeline,
        roleDistribution,
        commandUsage,
        staffPerformance,
        recentJoins: recentJoinsList.map(m => ({
          userId: m.userId,
          name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
          avatarUrl: m.avatarUrl,
          date: m.guildJoinedAt?.toISOString(),
        })),
        recentLeaves: recentLeavesList.map(m => ({
          userId: m.userId,
          name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
          avatarUrl: m.avatarUrl,
          date: m.guildLeftAt?.toISOString(),
        })),
      };

      await cache.set(cacheKey, analyticsPayload, 30);
      json(res, 200, analyticsPayload);
    } catch (err) {
      logger.error('AnalyticsAPI', 'Error computing analytics:', err);
      json(res, 500, { error: 'Erreur lors du calcul des analytics' });
    }
    return true;
  }

  return false;
}
