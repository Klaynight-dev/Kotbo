/**
 * channelDetailService.ts
 *
 * Vue détaillée d'un salon, servie à la modale ChannelDetailsModal du dashboard.
 * Regroupe en une seule réponse ce qui est éclaté ailleurs :
 *  - activity   : série journalière ChannelDailyStat + comparaison période précédente + part du serveur
 *  - people     : top contributeurs et heatmap horaire (MessageLog, opt-in par guilde)
 *  - health     : statut calculé avec les seuils ChannelHealthConfig + alertes ouvertes
 *  - moderation : messages supprimés / édités et leurs auteurs (MessageLog)
 *  - content    : derniers messages, épinglés, threads (Discord) + liens de salons
 *  - config     : métadonnées Discord et historique des changements (AuditEvent)
 *
 * Les blocs dépendant de MessageLog renvoient `available: false` quand la
 * journalisation est désactivée, plutôt qu'un bloc vide indistinguable d'un
 * salon sans activité.
 */

import { ChannelType, type Client, type GuildBasedChannel } from 'discord.js';
import { normalizeTimezone } from '@kotbo/contracts';
import { prismaRead } from '../../utils/db.js';
import { getDateKey } from './analyticsService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ChannelHealthVerdict = 'HEALTHY' | 'OVERLOADED' | 'UNDERUSED' | 'DEAD' | 'UNKNOWN';

function dateKeyDaysAgo(days: number): string {
  return getDateKey(new Date(Date.now() - days * DAY_MS));
}

function changePct(recent: number, previous: number): number | null {
  if (previous > 0) return Math.round(((recent - previous) / previous) * 100);
  return recent > 0 ? 100 : null;
}

function channelTypeLabel(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildAnnouncement: return 'announcement';
    case ChannelType.GuildVoice: return 'voice';
    case ChannelType.GuildStageVoice: return 'stage';
    case ChannelType.GuildForum: return 'forum';
    case ChannelType.GuildMedia: return 'media';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return 'thread';
    case ChannelType.GuildCategory: return 'category';
    default: return 'text';
  }
}

/** Liste des dateKeys de `startDate` (inclus) jusqu'à aujourd'hui, en UTC. */
function buildDateKeys(days: number): string[] {
  const keys: string[] = [];
  const start = new Date(Date.now() - (days - 1) * DAY_MS);
  for (let i = 0; i < days; i++) {
    keys.push(getDateKey(new Date(start.getTime() + i * DAY_MS)));
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// MÉTADONNÉES DISCORD
// ─────────────────────────────────────────────────────────────────────────────

async function buildChannelMeta(client: Client, guildId: string, channelId: string) {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { channel: null, discordChannel: null };

  let discordChannel = guild.channels.cache.get(channelId) as GuildBasedChannel | undefined;
  if (!discordChannel) {
    discordChannel = (await guild.channels.fetch(channelId).catch(() => null)) as GuildBasedChannel | undefined ?? undefined;
  }
  if (!discordChannel) return { channel: null, discordChannel: null };

  const parent = 'parent' in discordChannel ? discordChannel.parent : null;
  const overwrites = 'permissionOverwrites' in discordChannel
    ? [...discordChannel.permissionOverwrites.cache.values()]
    : [];

  const roleOverwrites = overwrites
    .filter((o) => o.type === 0)
    .map((o) => ({
      id: o.id,
      name: guild.roles.cache.get(o.id)?.name ?? o.id,
      color: guild.roles.cache.get(o.id)?.hexColor ?? null,
      allow: o.allow.toArray().length,
      deny: o.deny.toArray().length,
      isEveryone: o.id === guild.id,
    }));

  return {
    discordChannel,
    channel: {
      id: discordChannel.id,
      name: discordChannel.name,
      type: channelTypeLabel(discordChannel.type),
      mention: `<#${discordChannel.id}>`,
      topic: 'topic' in discordChannel ? discordChannel.topic ?? null : null,
      nsfw: 'nsfw' in discordChannel ? !!discordChannel.nsfw : false,
      rateLimitPerUser: 'rateLimitPerUser' in discordChannel ? discordChannel.rateLimitPerUser ?? 0 : 0,
      position: 'rawPosition' in discordChannel ? discordChannel.rawPosition : 0,
      createdAt: discordChannel.createdAt,
      categoryId: parent?.id ?? null,
      categoryName: parent?.name ?? null,
      bitrate: 'bitrate' in discordChannel ? discordChannel.bitrate : null,
      userLimit: 'userLimit' in discordChannel ? discordChannel.userLimit : null,
      connectedNow: 'members' in discordChannel && discordChannel.type === ChannelType.GuildVoice
        ? discordChannel.members.size
        : null,
      defaultAutoArchiveDuration: 'defaultAutoArchiveDuration' in discordChannel
        ? discordChannel.defaultAutoArchiveDuration ?? null
        : null,
      isPrivate: roleOverwrites.some((o) => o.isEveryone && o.deny > 0),
      roleOverwrites,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITÉ (ChannelDailyStat)
// ─────────────────────────────────────────────────────────────────────────────

async function buildActivity(guildId: string, channelId: string, days: number) {
  const startKey = dateKeyDaysAgo(days - 1);
  const previousStartKey = dateKeyDaysAgo(days * 2 - 1);

  const [rows, guildRows] = await Promise.all([
    prismaRead.channelDailyStat.findMany({
      where: { guildId, channelId, dateKey: { gte: previousStartKey } },
      orderBy: { dateKey: 'asc' },
    }),
    prismaRead.channelDailyStat.groupBy({
      by: ['channelId'],
      where: { guildId, dateKey: { gte: startKey } },
      _sum: { messagesCount: true, voiceMinutes: true },
    }),
  ]);

  const current = rows.filter((r) => r.dateKey >= startKey);
  const previous = rows.filter((r) => r.dateKey < startKey);

  const byDate = new Map(current.map((r) => [r.dateKey, r]));
  const daily = buildDateKeys(days).map((dateKey) => {
    const row = byDate.get(dateKey);
    return {
      dateKey,
      messages: row?.messagesCount ?? 0,
      uniqueAuthors: row?.uniqueAuthors ?? 0,
      voiceMinutes: row?.voiceMinutes ?? 0,
    };
  });

  const sum = (list: typeof current, field: 'messagesCount' | 'voiceMinutes') =>
    list.reduce((acc, r) => acc + r[field], 0);

  const messages = sum(current, 'messagesCount');
  const voiceMinutes = sum(current, 'voiceMinutes');
  const previousMessages = sum(previous, 'messagesCount');
  const previousVoiceMinutes = sum(previous, 'voiceMinutes');

  const activeDays = current.filter((r) => r.messagesCount > 0 || r.voiceMinutes > 0).length;
  const authorSamples = current.filter((r) => r.uniqueAuthors > 0).map((r) => r.uniqueAuthors);
  const uniqueAuthorsAvg = authorSamples.length
    ? Math.round((authorSamples.reduce((a, b) => a + b, 0) / authorSamples.length) * 10) / 10
    : 0;

  const peak = daily.reduce(
    (best, d) => (d.messages > best.messages ? d : best),
    { dateKey: null as string | null, messages: 0 } as { dateKey: string | null; messages: number },
  );

  // Part du serveur et rang parmi les salons sur la même période.
  const guildMessages = guildRows.reduce((acc, r) => acc + (r._sum.messagesCount ?? 0), 0);
  const guildVoice = guildRows.reduce((acc, r) => acc + (r._sum.voiceMinutes ?? 0), 0);
  const rankedByMessages = [...guildRows].sort((a, b) => (b._sum.messagesCount ?? 0) - (a._sum.messagesCount ?? 0));
  const rank = rankedByMessages.findIndex((r) => r.channelId === channelId);

  return {
    daily,
    totals: {
      messages,
      voiceMinutes,
      activeDays,
      uniqueAuthorsAvg,
      avgMessagesPerDay: Math.round((messages / days) * 10) / 10,
      peakDateKey: peak.messages > 0 ? peak.dateKey : null,
      peakMessages: peak.messages,
    },
    previous: {
      messages: previousMessages,
      voiceMinutes: previousVoiceMinutes,
    },
    change: {
      messages: changePct(messages, previousMessages),
      voiceMinutes: changePct(voiceMinutes, previousVoiceMinutes),
    },
    share: {
      messagesPct: guildMessages > 0 ? Math.round((messages / guildMessages) * 1000) / 10 : 0,
      voicePct: guildVoice > 0 ? Math.round((voiceMinutes / guildVoice) * 1000) / 10 : 0,
      rank: rank >= 0 ? rank + 1 : null,
      channelCount: guildRows.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRIBUTEURS + HEATMAP (MessageLog)
// ─────────────────────────────────────────────────────────────────────────────

async function buildPeople(guildId: string, channelId: string, days: number, loggingEnabled: boolean, timezone: string) {
  if (!loggingEnabled) {
    return {
      contributors: { available: false as const, items: [] as never[], total: 0 },
      heatmap: { available: false as const, matrix: [] as number[][], peak: null },
    };
  }

  const since = new Date(Date.now() - days * DAY_MS);

  const [authorRows, hourRows] = await Promise.all([
    prismaRead.$queryRaw<Array<{ authorId: string; authorName: string; authorAvatar: string | null; total: bigint; lastAt: Date }>>`
      SELECT "authorId", MAX("authorName") AS "authorName", MAX("authorAvatar") AS "authorAvatar",
             COUNT(*) AS total, MAX("createdAt") AS "lastAt"
      FROM "message_logs"
      WHERE "guildId" = ${guildId} AND "channelId" = ${channelId}
        AND "createdAt" >= ${since} AND "isBot" = false
      GROUP BY "authorId"
      ORDER BY total DESC
      LIMIT 25
    `,
    prismaRead.$queryRaw<Array<{ dow: number; hour: number; total: bigint }>>`
      SELECT EXTRACT(DOW FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::int AS dow,
             EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::int AS hour,
             COUNT(*) AS total
      FROM "message_logs"
      WHERE "guildId" = ${guildId} AND "channelId" = ${channelId}
        AND "createdAt" >= ${since} AND "isBot" = false
      GROUP BY 1, 2
    `,
  ]);

  const totalLogged = authorRows.reduce((acc, r) => acc + Number(r.total), 0);

  // Lundi en première ligne : EXTRACT(DOW) renvoie 0 pour dimanche.
  const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let peak: { day: number; hour: number; count: number } | null = null;
  for (const row of hourRows) {
    const day = (row.dow + 6) % 7;
    const count = Number(row.total);
    matrix[day][row.hour] = count;
    if (!peak || count > peak.count) peak = { day, hour: row.hour, count };
  }

  return {
    contributors: {
      available: true as const,
      total: totalLogged,
      items: authorRows.map((r) => ({
        userId: r.authorId,
        userTag: r.authorName,
        avatarUrl: r.authorAvatar,
        messages: Number(r.total),
        lastMessageAt: r.lastAt,
        sharePct: totalLogged > 0 ? Math.round((Number(r.total) / totalLogged) * 1000) / 10 : 0,
      })),
    },
    heatmap: { available: true as const, matrix, peak },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SANTÉ + MODÉRATION
// ─────────────────────────────────────────────────────────────────────────────

async function buildHealth(
  guildId: string,
  channelId: string,
  totals: { messages: number; uniqueAuthorsAvg: number },
  days: number,
) {
  const [config, alerts] = await Promise.all([
    prismaRead.channelHealthConfig.findUnique({ where: { guildId } }),
    prismaRead.channelHealthAlert.findMany({
      where: { guildId, channelId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const avgMsgPerDay = totals.messages / days;
  const avgMsgPerHour = avgMsgPerDay / 24;

  let status: ChannelHealthVerdict = 'UNKNOWN';
  if (config) {
    // Mêmes seuils que channelHealthService pour éviter deux verdicts divergents.
    if (avgMsgPerHour >= config.overloadMsgPerHour / 24 && totals.uniqueAuthorsAvg >= config.overloadUniqueUsers) {
      status = 'OVERLOADED';
    } else if (avgMsgPerDay <= config.deadMsgPerWeek / 7) {
      status = 'DEAD';
    } else if (avgMsgPerDay <= config.underusedMsgPerDay && totals.uniqueAuthorsAvg <= config.underusedUniqueUsers) {
      status = 'UNDERUSED';
    } else {
      status = 'HEALTHY';
    }
  }

  return {
    configured: !!config?.enabled,
    excluded: !!config?.excludedChannelIds.includes(channelId),
    status,
    metrics: {
      avgMsgPerDay: Math.round(avgMsgPerDay * 100) / 100,
      avgMsgPerHour: Math.round(avgMsgPerHour * 100) / 100,
      uniqueAuthorsAvg: totals.uniqueAuthorsAvg,
    },
    thresholds: config
      ? {
          overloadMsgPerHour: config.overloadMsgPerHour,
          overloadUniqueUsers: config.overloadUniqueUsers,
          underusedMsgPerDay: config.underusedMsgPerDay,
          underusedUniqueUsers: config.underusedUniqueUsers,
          deadMsgPerWeek: config.deadMsgPerWeek,
        }
      : null,
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      confidence: a.confidence,
      reason: a.reason,
      createdAt: a.createdAt,
      resolvedAt: a.resolvedAt,
      resolvedBy: a.resolvedBy,
    })),
  };
}

async function buildModeration(guildId: string, channelId: string, days: number, loggingEnabled: boolean) {
  if (!loggingEnabled) {
    return { available: false as const, deleted: 0, edited: 0, topDeleted: [], recentDeleted: [] };
  }

  const since = new Date(Date.now() - days * DAY_MS);

  const [deleted, edited, topDeleted, recentDeleted] = await Promise.all([
    prismaRead.messageLog.count({
      where: { guildId, channelId, createdAt: { gte: since }, deletedAt: { not: null } },
    }),
    prismaRead.messageLog.count({
      where: { guildId, channelId, createdAt: { gte: since }, editedAt: { not: null } },
    }),
    prismaRead.$queryRaw<Array<{ authorId: string; authorName: string; total: bigint }>>`
      SELECT "authorId", MAX("authorName") AS "authorName", COUNT(*) AS total
      FROM "message_logs"
      WHERE "guildId" = ${guildId} AND "channelId" = ${channelId}
        AND "createdAt" >= ${since} AND "deletedAt" IS NOT NULL
      GROUP BY "authorId"
      ORDER BY total DESC
      LIMIT 5
    `,
    prismaRead.messageLog.findMany({
      where: { guildId, channelId, createdAt: { gte: since }, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      take: 15,
      select: {
        messageId: true, authorId: true, authorName: true, authorAvatar: true,
        content: true, createdAt: true, deletedAt: true, hasAttachment: true,
      },
    }),
  ]);

  return {
    available: true as const,
    deleted,
    edited,
    topDeleted: topDeleted.map((r) => ({ userId: r.authorId, userTag: r.authorName, count: Number(r.total) })),
    recentDeleted,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENU + CONFIG
// ─────────────────────────────────────────────────────────────────────────────

async function buildContent(
  client: Client,
  guildId: string,
  channelId: string,
  days: number,
  loggingEnabled: boolean,
  discordChannel: GuildBasedChannel | null,
) {
  const since = new Date(Date.now() - days * DAY_MS);

  let recentMessages: unknown[] = [];
  let attachments = 0;
  let botMessages = 0;
  let replies = 0;
  if (loggingEnabled) {
    const [recent, attachmentCount, botCount, replyCount] = await Promise.all([
      prismaRead.messageLog.findMany({
        where: { guildId, channelId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          messageId: true, authorId: true, authorName: true, authorAvatar: true,
          content: true, createdAt: true, editedAt: true, hasAttachment: true,
          attachments: true, embedCount: true, isBot: true,
        },
      }),
      prismaRead.messageLog.count({ where: { guildId, channelId, createdAt: { gte: since }, hasAttachment: true } }),
      prismaRead.messageLog.count({ where: { guildId, channelId, createdAt: { gte: since }, isBot: true } }),
      prismaRead.messageLog.count({ where: { guildId, channelId, createdAt: { gte: since }, repliedToAuthorId: { not: null } } }),
    ]);
    recentMessages = recent;
    attachments = attachmentCount;
    botMessages = botCount;
    replies = replyCount;
  }

  // Épinglés et threads : lecture Discord, best-effort (permissions manquantes = liste vide).
  let pinned: Array<{ id: string; authorName: string; content: string; createdAt: Date | null }> = [];
  let threads: Array<{ id: string; name: string; archived: boolean; locked: boolean; messageCount: number | null; memberCount: number | null; createdAt: Date | null }> = [];

  if (discordChannel && 'messages' in discordChannel) {
    const pinnedMessages = await discordChannel.messages.fetchPinned().catch(() => null);
    if (pinnedMessages) {
      pinned = [...pinnedMessages.values()].slice(0, 15).map((msg) => ({
        id: msg.id,
        authorName: msg.author?.tag ?? msg.author?.username ?? 'Inconnu',
        content: msg.content.slice(0, 200),
        createdAt: msg.createdAt,
      }));
    }
  }

  if (discordChannel && 'threads' in discordChannel) {
    const fetched = await discordChannel.threads.fetchActive().catch(() => null);
    if (fetched) {
      threads = [...fetched.threads.values()].slice(0, 20).map((t) => ({
        id: t.id,
        name: t.name,
        archived: !!t.archived,
        locked: !!t.locked,
        messageCount: t.messageCount ?? null,
        memberCount: t.memberCount ?? null,
        createdAt: t.createdAt,
      }));
    }
  }

  const linkGroups = await prismaRead.channelLinkGroup.findMany({
    where: { members: { some: { guildId, channelId } } },
    include: { members: true },
    take: 10,
  });

  return {
    logging: { available: loggingEnabled },
    recentMessages,
    counters: { attachments, botMessages, replies },
    pinned,
    threads,
    // Un pont relie N salons : ce panneau en liste une ligne par salon d'en face.
    links: linkGroups.flatMap((group) => {
      const local = group.members.find((mb) => mb.guildId === guildId && mb.channelId === channelId);
      return group.members
        .filter((mb) => mb.id !== local?.id)
        .map((other) => ({
          id: group.id,
          enabled: group.enabled && other.enabled && (local?.enabled ?? false),
          direction: local?.mode ?? 'BOTH',
          otherGuildId: other.guildId,
          otherChannelId: other.channelId,
          otherGuildName: client.guilds.cache.get(other.guildId)?.name ?? null,
          otherChannelName: client.guilds.cache.get(other.guildId)?.channels.cache.get(other.channelId)?.name ?? null,
        }));
    }),
  };
}

async function buildAuditTrail(guildId: string, channelId: string) {
  const events = await prismaRead.auditEvent.findMany({
    where: { guildId, OR: [{ channelId }, { targetId: channelId, targetType: 'CHANNEL' }] },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      id: true, eventType: true, executorId: true, executorName: true,
      changedFields: true, changes: true, reason: true, createdAt: true,
    },
  });
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRÉE PUBLIQUE
// ─────────────────────────────────────────────────────────────────────────────

export async function getChannelDetail(
  client: Client,
  guildId: string,
  channelId: string,
  days = 30,
  timezone?: string,
) {
  const period = Math.min(90, Math.max(7, days));
  // La heatmap est une grille jour x heure : lue en UTC, elle decalait les
  // creneaux d'autant d'heures que le fuseau du lecteur.
  const viewTimezone = normalizeTimezone(timezone);

  const [{ channel, discordChannel }, guildConfig] = await Promise.all([
    buildChannelMeta(client, guildId, channelId),
    prismaRead.guild.findUnique({ where: { id: guildId }, select: { messageLoggingEnabled: true } }),
  ]);

  const loggingEnabled = !!guildConfig?.messageLoggingEnabled;
  const activity = await buildActivity(guildId, channelId, period);

  const [people, health, moderation, content, auditTrail] = await Promise.all([
    buildPeople(guildId, channelId, period, loggingEnabled, viewTimezone),
    buildHealth(guildId, channelId, activity.totals, period),
    buildModeration(guildId, channelId, period, loggingEnabled),
    buildContent(client, guildId, channelId, period, loggingEnabled, discordChannel ?? null),
    buildAuditTrail(guildId, channelId),
  ]);

  return {
    channelId,
    period,
    timezone: viewTimezone,
    // `channel` est nul quand le salon a été supprimé côté Discord : le
    // dashboard affiche alors l'historique statistique sans les métadonnées.
    channel,
    activity,
    contributors: people.contributors,
    heatmap: people.heatmap,
    health,
    moderation,
    content,
    auditTrail,
  };
}
