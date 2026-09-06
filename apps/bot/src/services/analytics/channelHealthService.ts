import { type Client, ChannelType, type TextChannel, type CategoryChannel } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getDateKey } from './analyticsService.js';
import { BucketZoner } from './zonedBuckets.js';
import { resolveGuildTimezone } from '../../utils/timezone.js';
import { isModuleEnabled } from '../core/moduleGate.js';

// ============================================================================
// TYPES
// ============================================================================

export type ChannelHealthStatus = 'HEALTHY' | 'OVERLOADED' | 'UNDERUSED' | 'DEAD';

export interface ChannelHealthReport {
  channelId: string;
  channelName: string;
  status: ChannelHealthStatus;
  avgMsgPerHour: number;
  avgMsgPerDay: number;
  uniqueUsersAvg: number;
  totalMessages: number;
  peakHour: number | null;
  confidence: number;
  trend: 'UP' | 'DOWN' | 'STABLE';
}

export interface GuildHealthSummary {
  guildId: string;
  analysisDate: string;
  periodDays: number;
  channels: ChannelHealthReport[];
  overloaded: ChannelHealthReport[];
  underused: ChannelHealthReport[];
  dead: ChannelHealthReport[];
  healthy: ChannelHealthReport[];
}

// ============================================================================
// ANALYSIS
// ============================================================================

export async function analyzeGuildChannelHealth(
  client: Client,
  guildId: string,
): Promise<GuildHealthSummary | null> {
  const config = await prismaRead.channelHealthConfig.findUnique({
    where: { guildId },
  });

  if (!config?.enabled) return null;

  const periodDays = config.analysisPeriodDays;
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - periodDays);
  const startDateKey = getDateKey(startDate);

  const channelStats = await prismaRead.channelDailyStat.findMany({
    where: {
      guildId,
      dateKey: { gte: startDateKey },
    },
    orderBy: { dateKey: 'asc' },
  });

  if (channelStats.length === 0) return null;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const excludedIds = new Set(config.excludedChannelIds);

  const channelMap = new Map<string, { messages: number; authors: Set<number>; dailyCounts: number[]; name: string }>();

  for (const stat of channelStats) {
    if (excludedIds.has(stat.channelId)) continue;

    let entry = channelMap.get(stat.channelId);
    if (!entry) {
      const channel = guild.channels.cache.get(stat.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) continue;
      entry = { messages: 0, authors: new Set(), dailyCounts: [], name: channel.name };
      channelMap.set(stat.channelId, entry);
    }

    entry.messages += stat.messagesCount;
    entry.dailyCounts.push(stat.messagesCount);
    if (stat.uniqueAuthors > 0) entry.authors.add(stat.uniqueAuthors);
  }

  const hourlyStats = await prismaRead.guildHourlyStat.findMany({
    where: { guildId, dateKey: { gte: startDateKey } },
    select: { dateKey: true, hour: true, messagesCount: true },
  });

  // L'heure de pointe est destinee a un humain : elle est calculee dans le
  // fuseau du serveur, pas en UTC ou les creneaux sont stockes. Sans ca,
  // « pic a 12h » designait en realite 14h pour un serveur a Paris.
  const zoner = new BucketZoner(await resolveGuildTimezone(guildId));
  const hourlyTotals = new Array(24).fill(0);
  for (const h of hourlyStats) {
    hourlyTotals[zoner.fromKeyHour(h.dateKey, h.hour).hour] += h.messagesCount;
  }
  const globalPeakHour = hourlyTotals.indexOf(Math.max(...hourlyTotals));

  const channels: ChannelHealthReport[] = [];

  for (const [channelId, data] of channelMap) {
    const avgMsgPerDay = data.messages / periodDays;
    const avgMsgPerHour = avgMsgPerDay / 24;
    const uniqueUsersAvg = data.authors.size > 0
      ? [...data.authors].reduce((a, b) => a + b, 0) / data.authors.size
      : 0;

    const halfPoint = Math.floor(data.dailyCounts.length / 2);
    const firstHalf = data.dailyCounts.slice(0, halfPoint);
    const secondHalf = data.dailyCounts.slice(halfPoint);
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;

    let trend: 'UP' | 'DOWN' | 'STABLE' = 'STABLE';
    if (secondAvg > firstAvg * 1.2) trend = 'UP';
    else if (secondAvg < firstAvg * 0.8) trend = 'DOWN';

    let status: ChannelHealthStatus = 'HEALTHY';
    let confidence = 50;

    if (avgMsgPerHour >= config.overloadMsgPerHour / 24 && uniqueUsersAvg >= config.overloadUniqueUsers) {
      status = 'OVERLOADED';
      confidence = Math.min(95, 60 + Math.round((avgMsgPerHour / (config.overloadMsgPerHour / 24)) * 15));
    } else if (avgMsgPerDay <= config.deadMsgPerWeek / 7) {
      status = 'DEAD';
      confidence = Math.min(95, 70 + Math.round((1 - avgMsgPerDay / (config.deadMsgPerWeek / 7)) * 20));
    } else if (avgMsgPerDay <= config.underusedMsgPerDay && uniqueUsersAvg <= config.underusedUniqueUsers) {
      status = 'UNDERUSED';
      confidence = Math.min(90, 50 + Math.round((1 - avgMsgPerDay / config.underusedMsgPerDay) * 30));
    }

    channels.push({
      channelId,
      channelName: data.name,
      status,
      avgMsgPerHour: Math.round(avgMsgPerHour * 100) / 100,
      avgMsgPerDay: Math.round(avgMsgPerDay * 100) / 100,
      uniqueUsersAvg: Math.round(uniqueUsersAvg * 100) / 100,
      totalMessages: data.messages,
      peakHour: globalPeakHour,
      confidence,
      trend,
    });
  }

  channels.sort((a, b) => b.totalMessages - a.totalMessages);

  return {
    guildId,
    analysisDate: getDateKey(),
    periodDays,
    channels,
    overloaded: channels.filter(c => c.status === 'OVERLOADED'),
    underused: channels.filter(c => c.status === 'UNDERUSED'),
    dead: channels.filter(c => c.status === 'DEAD'),
    healthy: channels.filter(c => c.status === 'HEALTHY'),
  };
}

// ============================================================================
// ACTIONS - SPLIT / ARCHIVE
// ============================================================================

export async function createSplitChannel(
  client: Client,
  guildId: string,
  sourceChannelId: string,
): Promise<string | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const source = guild.channels.cache.get(sourceChannelId) as TextChannel | undefined;
  if (!source || source.type !== ChannelType.GuildText) return null;

  const config = await prisma.channelHealthConfig.findUnique({ where: { guildId } });
  if (!config) return null;

  const existingSplits = guild.channels.cache.filter(
    c => c.type === ChannelType.GuildText && c.name.startsWith(`${source.name}-`),
  );
  const nextNumber = existingSplits.size + 2;

  const name = config.splitNameTemplate
    .replace('{name}', source.name)
    .replace('{number}', String(nextNumber));

  try {
    const newChannel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: source.parent,
      permissionOverwrites: source.permissionOverwrites.cache.map(o => ({
        id: o.id,
        allow: o.allow,
        deny: o.deny,
        type: o.type,
      })),
      topic: `Salon additionnel de #${source.name} - créé automatiquement par Kotbo`,
      reason: `Channel Health Monitor: salon surchargé (split automatique)`,
    });

    return newChannel.id;
  } catch (error) {
    logger.error('ChannelHealth', `Erreur lors du split de ${source.name}:`, error);
    return null;
  }
}

export async function archiveChannel(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel || channel.type !== ChannelType.GuildText) return false;

  const config = await prisma.channelHealthConfig.findUnique({ where: { guildId } });
  if (!config) return false;

  try {
    let archiveCategory: CategoryChannel | null = null;
    if (config.archiveCategoryId) {
      archiveCategory = guild.channels.cache.get(config.archiveCategoryId) as CategoryChannel | undefined ?? null;
    }

    if (!archiveCategory) {
      const existing = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('archives'),
      ) as CategoryChannel | undefined;

      if (existing) {
        archiveCategory = existing;
      } else {
        archiveCategory = await guild.channels.create({
          name: '📦 Archives',
          type: ChannelType.GuildCategory,
          reason: 'Channel Health Monitor: catégorie d\'archivage automatique',
        });
        await prisma.channelHealthConfig.update({
          where: { guildId },
          data: { archiveCategoryId: archiveCategory.id },
        });
      }
    }

    await channel.setParent(archiveCategory.id, { reason: 'Channel Health Monitor: archivage automatique' });

    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
    });

    await channel.send({
      content: `🗄️ Ce salon a été archivé automatiquement par **Kotbo** car il était inactif depuis trop longtemps.\nL'historique des messages reste accessible en lecture.`,
    });

    return true;
  } catch (error) {
    logger.error('ChannelHealth', `Erreur lors de l'archivage de ${channel.name}:`, error);
    return false;
  }
}

// ============================================================================
// CRON JOB - ANALYSE PÉRIODIQUE
// ============================================================================

export async function runChannelHealthAnalysis(client: Client): Promise<void> {
  const configs = await prismaRead.channelHealthConfig.findMany({
    where: { enabled: true },
    select: { guildId: true },
  });

  for (const { guildId } of configs) {
    try {
      if (!(await isModuleEnabled(guildId, 'channel_health'))) continue;

      const summary = await analyzeGuildChannelHealth(client, guildId);
      if (!summary) continue;

      const config = await prismaRead.channelHealthConfig.findUnique({ where: { guildId } });
      if (!config) continue;

      for (const ch of summary.overloaded) {
        const existing = await prismaRead.channelHealthAlert.findFirst({
          where: {
            guildId,
            channelId: ch.channelId,
            type: { in: ['SPLIT_SUGGESTED', 'SPLIT_AUTO'] },
            status: 'PENDING',
          },
        });
        if (existing) continue;

        const alertType = config.splitMode === 'AUTO' ? 'SPLIT_AUTO' : 'SPLIT_SUGGESTED';

        let resultChannelId: string | null = null;
        if (alertType === 'SPLIT_AUTO') {
          resultChannelId = await createSplitChannel(client, guildId, ch.channelId);
        }

        await prisma.channelHealthAlert.create({
          data: {
            guildId,
            channelId: ch.channelId,
            channelName: ch.channelName,
            type: alertType,
            status: resultChannelId ? 'APPLIED' : 'PENDING',
            avgMsgPerHour: ch.avgMsgPerHour,
            avgMsgPerDay: ch.avgMsgPerDay,
            uniqueUsersAvg: ch.uniqueUsersAvg,
            peakHour: ch.peakHour,
            analysisPeriod: summary.periodDays,
            confidence: ch.confidence,
            reason: `Salon surchargé: ${ch.avgMsgPerDay.toFixed(0)} msg/jour, ${ch.uniqueUsersAvg.toFixed(0)} utilisateurs actifs`,
            resultChannelId,
            resolvedAt: resultChannelId ? new Date() : undefined,
          },
        });
      }

      for (const ch of [...summary.dead, ...summary.underused]) {
        const existing = await prismaRead.channelHealthAlert.findFirst({
          where: {
            guildId,
            channelId: ch.channelId,
            type: { in: ['ARCHIVE_SUGGESTED', 'ARCHIVE_AUTO', 'MERGE_SUGGESTED'] },
            status: 'PENDING',
          },
        });
        if (existing) continue;

        const isDead = ch.status === 'DEAD';
        const alertType = isDead && config.archiveMode === 'AUTO' ? 'ARCHIVE_AUTO' : 'ARCHIVE_SUGGESTED';

        let applied = false;
        if (alertType === 'ARCHIVE_AUTO') {
          applied = await archiveChannel(client, guildId, ch.channelId);
        }

        await prisma.channelHealthAlert.create({
          data: {
            guildId,
            channelId: ch.channelId,
            channelName: ch.channelName,
            type: alertType,
            status: applied ? 'APPLIED' : 'PENDING',
            avgMsgPerHour: ch.avgMsgPerHour,
            avgMsgPerDay: ch.avgMsgPerDay,
            uniqueUsersAvg: ch.uniqueUsersAvg,
            peakHour: ch.peakHour,
            analysisPeriod: summary.periodDays,
            confidence: ch.confidence,
            reason: isDead
              ? `Salon mort: ${ch.avgMsgPerDay.toFixed(1)} msg/jour sur ${summary.periodDays}j`
              : `Salon sous-utilisé: ${ch.avgMsgPerDay.toFixed(1)} msg/jour, ${ch.uniqueUsersAvg.toFixed(0)} utilisateurs`,
            resolvedAt: applied ? new Date() : undefined,
          },
        });
      }

      // Notification digest
      if (config.alertChannelId) {
        await sendHealthDigest(client, guildId, summary, config.alertChannelId);
      }

      logger.info('ChannelHealth', `Analyse terminée pour ${guildId}: ${summary.overloaded.length} surchargés, ${summary.underused.length} sous-utilisés, ${summary.dead.length} morts`);
    } catch (error) {
      logger.error('ChannelHealth', `Erreur analyse pour guild ${guildId}:`, error);
    }
  }
}

// ============================================================================
// NOTIFICATION
// ============================================================================

async function sendHealthDigest(
  client: Client,
  guildId: string,
  summary: GuildHealthSummary,
  channelId: string,
): Promise<void> {
  if (summary.overloaded.length === 0 && summary.underused.length === 0 && summary.dead.length === 0) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  const { EmbedBuilder } = await import('discord.js');

  const embed = new EmbedBuilder()
    .setTitle('📊 Rapport de Santé des Salons')
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: `Analyse sur ${summary.periodDays} jours` });

  if (summary.overloaded.length > 0) {
    embed.addFields({
      name: `🔴 Salons surchargés (${summary.overloaded.length})`,
      value: summary.overloaded
        .slice(0, 5)
        .map(c => `**#${c.channelName}** - ${c.avgMsgPerDay.toFixed(0)} msg/jour, ${c.uniqueUsersAvg.toFixed(0)} users (${c.confidence}% confiance)`)
        .join('\n'),
    });
  }

  if (summary.underused.length > 0) {
    embed.addFields({
      name: `🟡 Salons sous-utilisés (${summary.underused.length})`,
      value: summary.underused
        .slice(0, 5)
        .map(c => `**#${c.channelName}** - ${c.avgMsgPerDay.toFixed(1)} msg/jour, ${c.uniqueUsersAvg.toFixed(0)} users`)
        .join('\n'),
    });
  }

  if (summary.dead.length > 0) {
    embed.addFields({
      name: `⚫ Salons morts (${summary.dead.length})`,
      value: summary.dead
        .slice(0, 5)
        .map(c => `**#${c.channelName}** - ${c.avgMsgPerDay.toFixed(2)} msg/jour`)
        .join('\n'),
    });
  }

  embed.addFields({
    name: '✅ Salons sains',
    value: `${summary.healthy.length} salon(s) en bonne santé`,
    inline: true,
  });

  try {
    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.error('ChannelHealth', 'Erreur envoi digest:', error);
  }
}

// ============================================================================
// DASHBOARD DATA
// ============================================================================

export async function getChannelHealthDashboardData(guildId: string) {
  const [config, alerts, recentAlerts] = await Promise.all([
    prismaRead.channelHealthConfig.findUnique({ where: { guildId } }),
    prismaRead.channelHealthAlert.findMany({
      where: { guildId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prismaRead.channelHealthAlert.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  return { config, pendingAlerts: alerts, history: recentAlerts };
}

export async function resolveHealthAlert(
  alertId: string,
  action: 'APPLIED' | 'DISMISSED',
  userId: string,
  note?: string,
): Promise<boolean> {
  try {
    await prisma.channelHealthAlert.update({
      where: { id: alertId },
      data: {
        status: action,
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolvedNote: note,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function upsertChannelHealthConfig(
  guildId: string,
  data: Record<string, unknown>,
) {
  const create: Record<string, unknown> = { guildId, ...data };

  if (!Array.isArray(create.excludedChannelIds)) {
    // Le honeypot est volontairement désert : sans exclusion il ressortirait
    // toujours en DEAD. L'admin peut le retirer de la liste s'il le souhaite.
    const honeypotChannelId = (await prismaRead.guild.findUnique({
      where: { id: guildId },
      select: { honeypotChannelId: true },
    }))?.honeypotChannelId;
    if (honeypotChannelId) create.excludedChannelIds = [honeypotChannelId];
  }

  return prisma.channelHealthConfig.upsert({
    where: { guildId },
    create: create as Prisma.ChannelHealthConfigUncheckedCreateInput,
    update: data as Prisma.ChannelHealthConfigUncheckedUpdateInput,
  });
}
