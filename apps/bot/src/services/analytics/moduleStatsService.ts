import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isAnalyticsCollectionEnabled } from './analyticsConsent.js';

// Liste de tous les modules Kotbo
export const KOTBO_MODULES = [
  'dailyAlgo',
  'sanction',
  'ticket',
  'staffManagement',
  'staffLeadership',
  'recruitment',
  'event',
  'giveaway',
  'leveling',
  'autoMod',
  'codePolice',
  'bannedWords',
  'nicknameModeration',
  'translation',
  'news',
  'welcomeGoodbye',
  'autoResponse',
  'reactionRole',
  'suggestion',
  'profile',
  'invite',
  'dcDetection',
  'altAccount',
  'memberCase',
  'image',
  'transcript',
  'youtube',
  'twitch',
  'githubRelease',
  'tutoring',
  'digest',
  'tempVoice',
  'honeypot',
  'autoThread',
  'fun',
  'analytics',
  'dashboard',
] as const;

export type KotboModule = typeof KOTBO_MODULES[number];

interface UsageIncrementOptions {
  guildId: string;
  moduleName: KotboModule;
  actionType?: 'command' | 'api' | 'event';
  actionName?: string;
  userId?: string;
}

interface PerformanceRecordOptions {
  guildId: string;
  moduleName: KotboModule;
  executionTimeMs: number;
  success: boolean;
  errorType?: string;
}

/**
 * Active ou désactive un module pour un serveur
 */
export async function setModuleActivation(
  guildId: string,
  moduleName: KotboModule,
  enabled: boolean,
  config?: Record<string, unknown>
): Promise<void> {
  const now = new Date();
  
  await prisma.moduleActivationStat.upsert({
    where: {
      guildId_moduleName: {
        guildId,
        moduleName,
      },
    },
    update: {
      enabled,
      config: (config ?? undefined) as Prisma.InputJsonValue | undefined,
      activatedAt: enabled ? (await prisma.moduleActivationStat.findUnique({
        where: { guildId_moduleName: { guildId, moduleName } },
        select: { activatedAt: true },
      }))?.activatedAt || now : undefined,
      deactivatedAt: enabled ? null : now,
      updatedAt: now,
    },
    create: {
      guildId,
      moduleName,
      enabled,
      config: (config ?? undefined) as Prisma.InputJsonValue | undefined,
      activatedAt: enabled ? now : null,
      deactivatedAt: enabled ? null : now,
    },
  });

  logger.info('ModuleStats', `Module ${moduleName} ${enabled ? 'activated' : 'deactivated'} for guild ${guildId}`);
}

/**
 * Incrémente les stats d'utilisation d'un module
 */
export async function incrementModuleUsage(options: UsageIncrementOptions): Promise<void> {
  const { guildId, moduleName, actionType = 'command', actionName, userId } = options;

  // Ces compteurs retiennent un classement des membres les plus actifs par
  // module (`topUsers`) : c'est de la mesure d'activité, donc soumis au même
  // interrupteur que le reste. `recordModulePerformance`, purement technique
  // (durées, erreurs, sans identité), continue lui de tourner.
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const updateData: Record<string, unknown> = {};

  if (actionType === 'command') {
    updateData.commandExecutions = { increment: 1 };
  } else if (actionType === 'api') {
    updateData.apiCalls = { increment: 1 };
  } else if (actionType === 'event') {
    updateData.eventTriggers = { increment: 1 };
  }

  // Upsert usage stat
  const usageStat = await prisma.moduleUsageStat.upsert({
    where: {
      guildId_moduleName_dateKey: {
        guildId,
        moduleName,
        dateKey: today,
      },
    },
    update: updateData,
    create: {
      guildId,
      moduleName,
      dateKey: today,
      commandExecutions: actionType === 'command' ? 1 : 0,
      apiCalls: actionType === 'api' ? 1 : 0,
      eventTriggers: actionType === 'event' ? 1 : 0,
    },
  });

  // Mettre à jour lastUsedAt dans ModuleActivationStat.
  // `updateMany` plutôt qu'`update` : le module n'a pas forcément de ligne
  // d'activation (elle n'est créée que par `setModuleActivation`). Avec
  // `update`, Prisma lève - et journalise en `prisma:error` - un P2025 à chaque
  // commande d'un module jamais activé explicitement ; `updateMany` se contente
  // de ne toucher aucune ligne.
  if (guildId) {
    await prisma.moduleActivationStat.updateMany({
      where: {
        guildId,
        moduleName,
      },
      data: {
        lastUsedAt: new Date(),
      },
    });
  }

  // Track unique users if userId provided
  if (userId) {
    const currentActionBreakdown = usageStat.actionBreakdown as Record<string, number> || {};
    if (actionName) {
      currentActionBreakdown[actionName] = (currentActionBreakdown[actionName] || 0) + 1;
    }

    const currentTopUsers = (usageStat.topUsers as Array<{ userId: string; count: number }>) || [];
    const userIndex = currentTopUsers.findIndex(u => u.userId === userId);
    if (userIndex >= 0) {
      currentTopUsers[userIndex].count++;
    } else {
      currentTopUsers.push({ userId, count: 1 });
    }

    await prisma.moduleUsageStat.update({
      where: { id: usageStat.id },
      data: {
        uniqueUsers: { increment: 1 },
        actionBreakdown: currentActionBreakdown,
        topUsers: currentTopUsers.sort((a, b) => b.count - a.count).slice(0, 10),
      },
    });
  }
}

/**
 * Enregistre les performances d'un module
 */
export async function recordModulePerformance(options: PerformanceRecordOptions): Promise<void> {
  const { guildId, moduleName, executionTimeMs, success, errorType } = options;
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const currentStat = await prisma.modulePerformanceStat.findUnique({
    where: {
      guildId_moduleName_dateKey: {
        guildId,
        moduleName,
        dateKey: today,
      },
    },
  });

  const totalExecutions = (currentStat?.totalExecutions || 0) + 1;
  const successCount = success ? (currentStat?.successCount || 0) + 1 : (currentStat?.successCount || 0);
  const errorCount = !success ? (currentStat?.errorCount || 0) + 1 : (currentStat?.errorCount || 0);

  const avgExecutionTimeMs = currentStat
    ? (currentStat.avgExecutionTimeMs * currentStat.totalExecutions + executionTimeMs) / totalExecutions
    : executionTimeMs;

  const maxExecutionTimeMs = currentStat
    ? Math.max(currentStat.maxExecutionTimeMs, executionTimeMs)
    : executionTimeMs;

  const minExecutionTimeMs = currentStat
    ? Math.min(currentStat.minExecutionTimeMs, executionTimeMs)
    : executionTimeMs;

  const errorTypes = (currentStat?.errorTypes as Record<string, number>) || {};
  if (!success && errorType) {
    errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
  }

  await prisma.modulePerformanceStat.upsert({
    where: {
      guildId_moduleName_dateKey: {
        guildId,
        moduleName,
        dateKey: today,
      },
    },
    update: {
      totalExecutions,
      avgExecutionTimeMs,
      maxExecutionTimeMs,
      minExecutionTimeMs,
      errorCount,
      errorRate: (errorCount / totalExecutions) * 100,
      errorTypes,
      successCount,
      successRate: (successCount / totalExecutions) * 100,
    },
    create: {
      guildId,
      moduleName,
      dateKey: today,
      totalExecutions: 1,
      avgExecutionTimeMs: executionTimeMs,
      maxExecutionTimeMs: executionTimeMs,
      minExecutionTimeMs: executionTimeMs,
      errorCount: success ? 0 : 1,
      errorRate: success ? 0 : 100,
      errorTypes: !success && errorType ? { [errorType]: 1 } : {},
      successCount: success ? 1 : 0,
      successRate: success ? 100 : 0,
    },
  });
}

/**
 * Récupère les stats d'activation des modules
 */
export async function getModuleActivationStats(guildId?: string) {
  const where = guildId ? { guildId } : { guildId: null };
  
  const stats = await prisma.moduleActivationStat.findMany({
    where,
    orderBy: { moduleName: 'asc' },
  });

  return stats.map(s => ({
    moduleName: s.moduleName,
    enabled: s.enabled,
    activatedAt: s.activatedAt,
    deactivatedAt: s.deactivatedAt,
    lastUsedAt: s.lastUsedAt,
    config: s.config,
  }));
}

/**
 * Récupère les stats d'utilisation des modules avec filtres temporels
 */
export async function getModuleUsageStats(options: {
  guildId?: string;
  moduleName?: KotboModule;
  startDate?: string;
  endDate?: string;
  periodDays?: number;
}) {
  const { guildId, moduleName, startDate, endDate, periodDays = 30 } = options;

  let dateKeyFilter: Record<string, unknown> = {};
  if (startDate && endDate) {
    dateKeyFilter = { gte: startDate, lte: endDate };
  } else if (periodDays) {
    const start = new Date();
    start.setDate(start.getDate() - periodDays);
    const startDateKey = start.toISOString().split('T')[0];
    dateKeyFilter = { gte: startDateKey };
  }

  const where: Record<string, unknown> = {};
  if (Object.keys(dateKeyFilter).length > 0) {
    where.dateKey = dateKeyFilter;
  }

  if (guildId) where.guildId = guildId;
  if (moduleName) where.moduleName = moduleName;

  const stats = await prisma.moduleUsageStat.findMany({
    where,
    orderBy: [{ dateKey: 'desc' }, { moduleName: 'asc' }],
  });

  return stats.map(s => ({
    guildId: s.guildId,
    moduleName: s.moduleName,
    dateKey: s.dateKey,
    commandExecutions: s.commandExecutions,
    apiCalls: s.apiCalls,
    eventTriggers: s.eventTriggers,
    totalUsage: s.commandExecutions + s.apiCalls + s.eventTriggers,
    uniqueUsers: s.uniqueUsers,
    actionBreakdown: s.actionBreakdown,
    topUsers: s.topUsers,
  }));
}

/**
 * Récupère les stats de performance des modules avec filtres temporels
 */
export async function getModulePerformanceStats(options: {
  guildId?: string;
  moduleName?: KotboModule;
  startDate?: string;
  endDate?: string;
  periodDays?: number;
}) {
  const { guildId, moduleName, startDate, endDate, periodDays = 30 } = options;

  let dateKeyFilter: Record<string, unknown> = {};
  if (startDate && endDate) {
    dateKeyFilter = { gte: startDate, lte: endDate };
  } else if (periodDays) {
    const start = new Date();
    start.setDate(start.getDate() - periodDays);
    const startDateKey = start.toISOString().split('T')[0];
    dateKeyFilter = { gte: startDateKey };
  }

  const where: Record<string, unknown> = {};
  if (Object.keys(dateKeyFilter).length > 0) {
    where.dateKey = dateKeyFilter;
  }

  if (guildId) where.guildId = guildId;
  if (moduleName) where.moduleName = moduleName;

  const stats = await prisma.modulePerformanceStat.findMany({
    where,
    orderBy: [{ dateKey: 'desc' }, { moduleName: 'asc' }],
  });

  return stats.map(s => ({
    guildId: s.guildId,
    moduleName: s.moduleName,
    dateKey: s.dateKey,
    avgExecutionTimeMs: s.avgExecutionTimeMs,
    maxExecutionTimeMs: s.maxExecutionTimeMs,
    minExecutionTimeMs: s.minExecutionTimeMs,
    totalExecutions: s.totalExecutions,
    errorCount: s.errorCount,
    errorRate: s.errorRate,
    errorTypes: s.errorTypes,
    successCount: s.successCount,
    successRate: s.successRate,
  }));
}

/**
 * Récupère un résumé global des stats de modules
 */
export async function getModuleStatsSummary(options: {
  guildId?: string;
  periodDays?: number;
}): Promise<{
  activation: unknown[];
  usage: unknown[];
  performance: unknown[];
  topModules: Array<{
    moduleName: string;
    totalUsage: number;
    avgExecutionTimeMs: number;
    errorRate: number;
  }>;
}> {
  const { guildId, periodDays = 30 } = options;

  const [activation, usage, performance] = await Promise.all([
    getModuleActivationStats(guildId),
    getModuleUsageStats({ guildId, periodDays }),
    getModulePerformanceStats({ guildId, periodDays }),
  ]);

  // Calculer les top modules
  const moduleUsageMap = new Map<string, { totalUsage: number; totalExecutions: number; totalErrors: number; totalTime: number }>();
  
  for (const u of usage) {
    const existing = moduleUsageMap.get(u.moduleName) || { totalUsage: 0, totalExecutions: 0, totalErrors: 0, totalTime: 0 };
    existing.totalUsage += u.totalUsage;
    moduleUsageMap.set(u.moduleName, existing);
  }

  for (const p of performance) {
    const existing = moduleUsageMap.get(p.moduleName) || { totalUsage: 0, totalExecutions: 0, totalErrors: 0, totalTime: 0 };
    existing.totalExecutions += p.totalExecutions;
    existing.totalErrors += p.errorCount;
    existing.totalTime += p.avgExecutionTimeMs * p.totalExecutions;
    moduleUsageMap.set(p.moduleName, existing);
  }

  const topModules = Array.from(moduleUsageMap.entries())
    .map(([moduleName, stats]) => ({
      moduleName,
      totalUsage: stats.totalUsage,
      avgExecutionTimeMs: stats.totalExecutions > 0 ? stats.totalTime / stats.totalExecutions : 0,
      errorRate: stats.totalExecutions > 0 ? (stats.totalErrors / stats.totalExecutions) * 100 : 0,
    }))
    .sort((a, b) => b.totalUsage - a.totalUsage)
    .slice(0, 10);

  return {
    activation,
    usage,
    performance,
    topModules,
  };
}
