import type { GuildLogEventConfig } from '@prisma/client';
import {
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  Events,
  Guild,
  StickerFormatType,
  type Client,
  type GuildBasedChannel,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type PartialMessage,
  type Role,
  type VoiceState,
} from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { queueAuditLog } from '../utils/auditLogger.js';
import { cache, getCachedGuild } from '../utils/cache.js';
import { recordStaffActivity, syncStaffHierarchyMembership } from '../services/staff/staffManagementService.js';
import { resolveOnlineMembersCount } from '../services/core/presenceDetectionService.js';
import { syncGuildInvites, markInviteAsDeleted, recordInvitedMemberLeave } from '../services/analytics/inviteService.js';
import {
  buildMemberCaseActionRow,
  touchMemberJoin,
  touchMemberLeave,
  touchMemberMessageActivity,
  touchMemberProfileFromMember,
  touchMemberVoiceJoin,
  touchMemberVoiceLeave,
  touchSanctionTargetIdentity,
} from '../services/moderation/memberCaseService.js';
import * as dcDetectionService from '../services/moderation/dcDetectionService.js';

type MessageSnapshot = {
  guildId: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  content: string;
  attachments: string[];
  stickers: StickerSnapshot[];
  createdAt: number;
};

/**
 * Un autocollant n'est ni du texte ni une piece jointe : sans lui, la
 * suppression d'un message qui n'en contient qu'un se journalise entierement
 * vide (issue #266).
 */
type StickerSnapshot = {
  name: string;
  url: string;
  /** Les autocollants Lottie servent du JSON, que Discord ne peut pas afficher. */
  renderable: boolean;
};

type VoiceSession = {
  joinedAt: number;
  channelId: string;
};

type CachedLogChannel = {
  channelId: string | null;
  expiresAt: number;
};

type InviteSnapshot = {
  code: string;
  uses: number;
  inviterId: string | null;
  inviterTag: string | null;
};

type MemberInviteUsage = {
  code: string;
  inviterId: string | null;
  inviterTag: string | null;
  joinedAt: number;
};

const messageSnapshotStore = new Map<string, MessageSnapshot>();
const voiceSessionStore = new Map<string, VoiceSession>();
const logChannelCache = new Map<string, CachedLogChannel>();
const inviteUsageCache = new Map<string, Map<string, InviteSnapshot>>();
const memberInviteUsageCache = new Map<string, MemberInviteUsage>();

const LOG_CHANNEL_CACHE_TTL_MS = 60_000;
const MESSAGE_SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;
const MESSAGE_SNAPSHOT_MAX_SIZE = Number.parseInt(process.env.MESSAGE_SNAPSHOT_MAX_SIZE ?? '30000', 10);
const AUDIT_LOOKBACK_MS = 12_000;
const MAX_BULK_AUTHOR_PREVIEW = 8;
const advancedLogsRegisteredClients = new WeakSet<Client>();

function getDateKey(date = new Date()): string {
  // Use UTC to be consistent with dashboard analytics which uses .toISOString().split('T')[0]
  return date.toISOString().split('T')[0];
}



async function incrementGuildDailyJoin(guildId: string): Promise<void> {
  const dateKey = getDateKey();
  await prisma.guildDailyStat.upsert({
    where: { guildId_dateKey: { guildId, dateKey } },
    create: { guildId, dateKey, membersJoined: 1 },
    update: { membersJoined: { increment: 1 } },
  }).catch((error) => {
    logger.debug('Analytics', `Guild daily stat join error: ${String(error)}`);
  });
}

async function incrementGuildDailyLeave(guildId: string): Promise<void> {
  const dateKey = getDateKey();
  await prisma.guildDailyStat.upsert({
    where: { guildId_dateKey: { guildId, dateKey } },
    create: { guildId, dateKey, membersLeft: 1 },
    update: { membersLeft: { increment: 1 } },
  }).catch((error) => {
    logger.debug('Analytics', `Guild daily stat leave error: ${String(error)}`);
  });
}

async function persistMemberInvite(guildId: string, userId: string, invite: InviteSnapshot | null): Promise<void> {
  await prisma.memberInvite.create({
    data: {
      guildId,
      userId,
      inviteCode: invite?.code ?? null,
      inviterId: invite?.inviterId ?? null,
      inviterTag: invite?.inviterTag ?? null,
    },
  }).catch((error) => {
    logger.debug('Analytics', `Member invite persist error: ${String(error)}`);
  });
}

async function incrementGuildDailyVoice(guildId: string, durationMinutes: number): Promise<void> {
  const dateKey = getDateKey();
  await prisma.guildDailyStat.upsert({
    where: { guildId_dateKey: { guildId, dateKey } },
    create: { guildId, dateKey, voiceMinutes: durationMinutes, voiceSessionsCount: 1 },
    update: { voiceMinutes: { increment: durationMinutes }, voiceSessionsCount: { increment: 1 } },
  }).catch((error) => {
    logger.debug('Analytics', `Guild daily stat voice error: ${String(error)}`);
  });
}

async function incrementGuildHourlyStat(guildId: string, type: 'voice' | 'join' | 'leave' | 'reaction' | 'thread', value = 1): Promise<void> {
  const now = new Date();
  const dateKey = getDateKey(now);
  const hour = now.getHours();

  await prisma.guildHourlyStat.upsert({
    where: { guildId_dateKey_hour: { guildId, dateKey, hour } },
    update: {
      voiceMinutes: type === 'voice' ? { increment: value } : undefined,
      joinsCount: type === 'join' ? { increment: value } : undefined,
      leavesCount: type === 'leave' ? { increment: value } : undefined,
      reactionsCount: type === 'reaction' ? { increment: value } : undefined,
      threadsCount: type === 'thread' ? { increment: value } : undefined,
    },
    create: {
      guildId,
      dateKey,
      hour,
      messagesCount: 0,
      voiceMinutes: type === 'voice' ? value : 0,
      joinsCount: type === 'join' ? value : 0,
      leavesCount: type === 'leave' ? value : 0,
      reactionsCount: type === 'reaction' ? value : 0,
      threadsCount: type === 'thread' ? value : 0,
      activeMembers: 0,
    },
  }).catch((error) => {
    logger.debug('Analytics', `Guild hourly stat error: ${String(error)}`);
  });
}


export async function runActivitySnapshot(client: Client): Promise<void> {
  const now = new Date();
  const dateKey = getDateKey(now);
  const hour = now.getHours();

  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) return;

  // Smoothing over 9 minutes (540,000 ms) to keep a buffer for the next 10min cycle
  const totalSmoothingMs = 9 * 60 * 1000;
  const intervalMs = Math.floor(totalSmoothingMs / guilds.length);

  logger.info('Analytics', `Starting smoothed activity snapshot for ${guilds.length} guilds (interval: ${intervalMs}ms)`);

  for (const guild of guilds) {
    try {
      await processSingleGuildSnapshot(guild, dateKey, hour);
    } catch (error) {
      logger.debug('Analytics', `Activity snapshot error for guild ${guild.id}: ${String(error)}`);
    }

    if (guilds.length > 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

async function processSingleGuildSnapshot(guild: Guild, dateKey: string, hour: number): Promise<void> {
  try {
    // Ensure the guild exists in our database before recording stats
    await prisma.guild.upsert({
      where: { id: guild.id },
      update: {},
      create: { id: guild.id }
    });

    // 1. Gather counts
    const totalMembers = guild.memberCount;
    
    // Attempt to get more accurate counts via fetch if the cache seems incomplete
    // GuildPresences intent should keep cache updated, but for large guilds or on startup it might be off.
    let onlineMembers = guild.members.cache.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
    const voiceMembers = guild.voiceStates.cache.size;

    // If we have 0 online members in cache but the guild has many members, something is likely wrong with the cache
    onlineMembers = await resolveOnlineMembersCount({
      totalMembers,
      onlineMembersFromCache: onlineMembers,
      fetchApproximatePresenceCount: async () => {
        try {
          const fetchedGuild = await guild.client.guilds.fetch({ guild: guild.id, withCounts: true, force: true });
          return fetchedGuild.approximatePresenceCount;
        } catch (e) {
          logger.debug('Analytics', `Failed to fetch approximate counts for ${guild.id}: ${String(e)}`);
          return null;
        }
      },
    });
    
    const idleMembers = guild.members.cache.filter(m => m.presence?.status === 'idle').size;
    const dndMembers = guild.members.cache.filter(m => m.presence?.status === 'dnd').size;
    const offlineMembers = totalMembers - onlineMembers;
    
    const totalBots = guild.members.cache.filter(m => m.user.bot).size;
    const totalHumans = totalMembers - totalBots;

    logger.info('Analytics', `Snapshot [${guild.name}]: ${onlineMembers} online (cache: ${guild.members.cache.size}/${totalMembers}), ${voiceMembers} vocal`);

    // Calculate active members for today (people who sent messages or were in voice)
    const activeMembersCount = await prisma.memberDailyStat.count({
      where: { guildId: guild.id, dateKey }
    });
    const activeVoiceMembersCount = await prisma.memberDailyStat.count({
      where: { guildId: guild.id, dateKey, voiceMinutes: { gt: 0 } }
    });

    // 2. Update Daily Stats (for overview charts and peaks)
    await prisma.guildDailyStat.upsert({
      where: { guildId_dateKey: { guildId: guild.id, dateKey } },
      create: {
        guildId: guild.id,
        dateKey,
        totalMembers,
        onlineMembers,
        idleMembers,
        dndMembers,
        offlineMembers,
        totalBots,
        totalHumans,
        activeMembers: activeMembersCount,
        activeVoiceMembers: activeVoiceMembersCount,
        peakOnline: onlineMembers,
        peakVoice: voiceMembers,
      },
      update: {
        totalMembers,
        onlineMembers,
        idleMembers,
        dndMembers,
        offlineMembers,
        totalBots,
        totalHumans,
        activeMembers: activeMembersCount,
        activeVoiceMembers: activeVoiceMembersCount,
      },
    });

    // Update peaks using GREATEST to ensure we keep the highest value seen today
    await prisma.$executeRawUnsafe(
      `UPDATE guild_daily_stats SET "peakOnline" = GREATEST("peakOnline", $1), "peakVoice" = GREATEST("peakVoice", $2) WHERE "guildId" = $3 AND "dateKey" = $4`,
      onlineMembers, voiceMembers, guild.id, dateKey
    );

    // 3. Update Hourly Stats (specifically for the heatmap)
    await prisma.guildHourlyStat.upsert({
      where: { guildId_dateKey_hour: { guildId: guild.id, dateKey, hour } },
      update: {
        onlineMembers,
        voiceMembers,
      },
      create: {
        guildId: guild.id,
        dateKey,
        hour,
        onlineMembers,
        voiceMembers,
        activeMembers: onlineMembers,
      },
    });

    // Update activeMembers (peak within the hour) using GREATEST
    await prisma.$executeRawUnsafe(
      `UPDATE guild_hourly_stats SET "activeMembers" = GREATEST("activeMembers", $1) WHERE "guildId" = $2 AND "dateKey" = $3 AND "hour" = $4`,
      onlineMembers, guild.id, dateKey, hour
    );

  } catch (error) {
    logger.debug('Analytics', `Activity snapshot error for guild ${guild.id}: ${String(error)}`);
  }
}



// 📊 Per-member daily stats
// 📊 Per-member daily stats (handled by queueMemberDailyMessage and flushMemberDailyMessages)

async function incrementMemberDailyVoice(guildId: string, userId: string, minutes: number): Promise<void> {
  const dateKey = getDateKey();
  await prisma.memberDailyStat.upsert({
    where: { guildId_userId_dateKey: { guildId, userId, dateKey } },
    create: { guildId, userId, dateKey, voiceMinutes: minutes },
    update: { voiceMinutes: { increment: minutes } },
  }).catch((error) => {
    logger.debug('Analytics', `Member daily stat voice error: ${String(error)}`);
  });
}



function truncate(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function stripLeadingEmoji(value: string): string {
  return value.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function embedSummary(embed: EmbedBuilder): { action: string; details: string } {
  const payload = embed.toJSON();
  const rawTitle = payload.title?.trim() || 'Événement Discord';
  const action = stripLeadingEmoji(rawTitle) || rawTitle;
  const description = payload.description?.trim() || '';
  const fieldPreview = (payload.fields ?? [])
    .slice(0, 4)
    .map((field) => {
      const fieldName = field.name.trim().toLowerCase();
      if (fieldName.startsWith('membre')) return `${field.value}`;
      return `${field.name}: ${field.value}`;
    })
    .join(' | ');

  const details = truncate([description, fieldPreview].filter(Boolean).join(' | '), 900) || 'Aucun détail.';
  return { action, details };
}

function formatUser(id: string, tag: string): string {
  return `${tag} (<@${id}>)`;
}

function parseTimestamp(value: string | number | Date | null): number | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function safeTag(member: { user?: { tag?: string; username?: string } } | null, id: string): string {
  return member?.user?.tag ?? member?.user?.username ?? `Utilisateur ${id}`;
}

function formatDurationUntil(untilTimestamp: number | null): string {
  if (!untilTimestamp) return 'Aucune durée';
  return `<t:${Math.floor(untilTimestamp / 1000)}:F> (<t:${Math.floor(untilTimestamp / 1000)}:R>)`;
}

function formatChannelName(channel: GuildBasedChannel): string {
  return `<#${channel.id}> (${channel.name})`;
}

function isGuildNamedChannel(channel: unknown): channel is GuildBasedChannel {
  if (!channel || typeof channel !== 'object') return false;
  const candidate = channel as { guild?: unknown; name?: unknown };
  return !!candidate.guild && typeof candidate.name === 'string';
}

function isFullGuild(guild: unknown): guild is Guild {
  return guild instanceof Guild;
}

function voiceSessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function memberInviteKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function formatDurationMs(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function cleanupMessageSnapshots(): void {
  const now = Date.now();

  for (const [messageId, snapshot] of messageSnapshotStore.entries()) {
    if (now - snapshot.createdAt > MESSAGE_SNAPSHOT_TTL_MS) {
      messageSnapshotStore.delete(messageId);
    }
  }

  if (messageSnapshotStore.size <= MESSAGE_SNAPSHOT_MAX_SIZE) return;

  // Evict oldest entries without sorting the entire map - find the Nth oldest
  // timestamp via a single pass, then delete everything older
  const overflow = messageSnapshotStore.size - MESSAGE_SNAPSHOT_MAX_SIZE;
  const timestamps: number[] = [];
  for (const snapshot of messageSnapshotStore.values()) {
    timestamps.push(snapshot.createdAt);
  }
  timestamps.sort((a, b) => a - b);
  const cutoff = timestamps[overflow - 1];

  let deleted = 0;
  for (const [messageId, snapshot] of messageSnapshotStore.entries()) {
    if (deleted >= overflow) break;
    if (snapshot.createdAt <= cutoff) {
      messageSnapshotStore.delete(messageId);
      deleted++;
    }
  }
}

async function getGuildLogChannelId(guildId: string): Promise<string | null> {
  const now = Date.now();
  const cached = logChannelCache.get(guildId);
  if (cached && cached.expiresAt > now) {
    return cached.channelId;
  }

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { 
      logChannelId: true,
      dashboardFeatureConfigs: {
        where: { featureKey: 'logs' },
        select: { enabled: true }
      }
    },
  });

  const isEnabled = guild?.dashboardFeatureConfigs?.[0]?.enabled !== false; // Default to true
  const channelId = isEnabled ? (guild?.logChannelId ?? null) : null;
  
  logChannelCache.set(guildId, { channelId, expiresAt: now + LOG_CHANNEL_CACHE_TTL_MS });
  return channelId;
}

/**
 * Salons dont l'activité ne doit générer aucun log. La liste ne contient que
 * des salons : un fil suit l'exclusion de son parent, sans quoi la moitié des
 * messages d'un salon exclu continuerait d'être journalisée.
 */
async function isLogIgnoredChannel(
  guild: Guild,
  channelIds: Array<string | null | undefined>,
): Promise<boolean> {
  const ids = channelIds.filter((id): id is string => !!id);
  if (ids.length === 0) return false;

  const guildConfig = await getCachedGuild(guild.id);
  const ignored = (guildConfig?.logIgnoredChannelIds ?? []) as string[];
  if (ignored.length === 0) return false;

  return ids.some((id) => {
    if (ignored.includes(id)) return true;
    const channel = guild.channels.cache.get(id);
    return !!channel?.isThread() && !!channel.parentId && ignored.includes(channel.parentId);
  });
}

async function sendLogEmbed(
  guild: Guild,
  embed: EmbedBuilder,
  eventType: string,
  components?: Array<ActionRowBuilder<ButtonBuilder>>,
  executorTag?: string | null,
  sourceChannelIds?: Array<string | null | undefined>,
): Promise<void> {
  if (sourceChannelIds && await isLogIgnoredChannel(guild, sourceChannelIds)) return;

  const summary = embedSummary(embed);

  // Pied de page « Action realisee par » : le titre dit ce qui s'est passe, le
  // pied de page dit par qui. Un embed qui porte deja son propre pied de page
  // garde le sien - il n'y a qu'un emplacement, et l'ecraser perdrait une
  // information au lieu d'en ajouter une.
  if (executorTag && !embed.toJSON().footer) {
    embed.setFooter({ text: `Action réalisée par ${executorTag}` });
  }

  // 1. Fetch event config from cache/database
  const cacheKey = `guild:${guild.id}:log_event_config:${eventType}`;
  let config = await cache.get<GuildLogEventConfig | { disabledDummy: true }>(cacheKey);
  if (!config) {
    config = await prisma.guildLogEventConfig.findUnique({
      where: {
        guildId_eventType: {
          guildId: guild.id,
          eventType
        }
      }
    });
    await cache.set(cacheKey, config ?? { disabledDummy: true }, 60);
  }

  // If configuration exists and is disabled, we do not log it
  if (config && ('disabledDummy' in config || !config.enabled)) {
    return;
  }

  // 2. Resolve destination channel: specific channelId from event config, falling back to main log channel
  let channelId = config && !('disabledDummy' in config) ? config.channelId : null;
  if (!channelId) {
    channelId = await getGuildLogChannelId(guild.id);
  }
  
  queueAuditLog({
    guildId: guild.id,
    channelId,
    user: executorTag ?? 'Système',
    action: summary.action,
    context: guild.name,
    module: 'Logs avancés',
    eventType: 'Discord',
    details: summary.details,
  });

  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch((error) => {
    logger.warn('Logs', `Impossible d'envoyer un log dans ${guild.id}: ${String(error)}`);
  });
}

async function recordMessageAudit(message: Message | PartialMessage): Promise<void> {
  if (!message.guildId || !message.author || message.author.bot) return;
  // Sans ce filtre, le contenu des messages d'un salon exclu continuerait
  // d'arriver dans le journal du dashboard.
  if (message.guild && await isLogIgnoredChannel(message.guild, [message.channelId])) return;

  queueAuditLog({
    guildId: message.guildId,
    channelId: message.channelId,
    user: formatUser(message.author.id, message.author.tag ?? message.author.username ?? `Utilisateur ${message.author.id}`),
    action: 'Message envoyé',
    context: message.guild?.name ?? `Serveur ${message.guildId}`,
    module: 'Messages',
    eventType: 'Discord',
    details: truncate([
      `ID: ${message.id}`,
      `Contenu: ${message.content?.trim() || '_vide_'}`,
      message.mentions.repliedUser ? `Réponse à: <@${message.mentions.repliedUser.id}>` : null,
      message.attachments.size > 0 ? `Pièces jointes: ${[...message.attachments.values()].slice(0, 5).map((a) => a.url).join(' | ')}` : null,
    ].filter(Boolean).join(' | '), 900),
  });
}

async function fetchGuildInviteSnapshot(guild: Guild): Promise<Map<string, InviteSnapshot> | null> {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;

  const snapshot = new Map<string, InviteSnapshot>();
  for (const invite of invites.values()) {
    snapshot.set(invite.code, {
      code: invite.code,
      uses: invite.uses ?? 0,
      inviterId: invite.inviter?.id ?? null,
      inviterTag: invite.inviter?.tag ?? invite.inviter?.username ?? null,
    });
  }
  return snapshot;
}

async function refreshGuildInviteCache(guild: Guild): Promise<void> {
  const snapshot = await fetchGuildInviteSnapshot(guild);
  if (!snapshot) return;
  inviteUsageCache.set(guild.id, snapshot);
}

async function resolveUsedInviteOnJoin(guild: Guild): Promise<InviteSnapshot | null> {
  const previous = inviteUsageCache.get(guild.id) ?? new Map<string, InviteSnapshot>();
  const current = await fetchGuildInviteSnapshot(guild);
  if (!current) return null;

  let usedInvite: InviteSnapshot | null = null;

  for (const [code, currentInvite] of current.entries()) {
    const previousUses = previous.get(code)?.uses ?? 0;
    if (currentInvite.uses > previousUses) {
      usedInvite = currentInvite;
      break;
    }
  }

  inviteUsageCache.set(guild.id, current);
  return usedInvite;
}

function formatInviteCreator(invite: { inviterId: string | null; inviterTag: string | null }): string {
  if (!invite.inviterId) return 'Inconnu';
  const tag = invite.inviterTag ?? `Utilisateur ${invite.inviterId}`;
  return `${tag} (<@${invite.inviterId}>)`;
}

async function resolveUserTag(client: Client, userId: string): Promise<string> {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return `Utilisateur ${userId}`;
  return user.tag ?? user.username ?? `Utilisateur ${userId}`;
}

function snapshotStickers(message: Message | PartialMessage): StickerSnapshot[] {
  return [...(message.stickers?.values() ?? [])].map((sticker) => ({
    name: sticker.name,
    url: sticker.url,
    renderable: sticker.format !== StickerFormatType.Lottie,
  }));
}

function snapshotFromMessage(message: Message | PartialMessage): MessageSnapshot | null {
  if (!message.guildId || !message.channelId || !message.author) return null;

  return {
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content ?? '',
    attachments: [...message.attachments.values()].map((attachment) => attachment.url),
    stickers: snapshotStickers(message),
    createdAt: Date.now(),
  };
}

function shouldIgnoreMessage(message: Message | PartialMessage): boolean {
  return !message.guildId || !!message.author?.bot;
}

/**
 * Auteur d'une action que l'evenement Discord ne nomme pas.
 *
 * `ChannelCreate`, `GuildRoleUpdate` & co. ne portent pas d'auteur : seul le
 * journal d'audit le sait. On ne regarde que les entrees recentes (meme fenetre
 * que pour les suppressions de messages) : au-dela, ce serait une action
 * anterieure qu'on attribuerait a tort a l'evenement du moment.
 *
 * Rend un nom lisible, pas une mention : la valeur alimente le pied de page des
 * embeds, ou Discord n'en resout aucune.
 */
async function resolveAuditExecutorName(
  guild: Guild,
  type: AuditLogEvent,
  targetId?: string | null,
): Promise<string | null> {
  try {
    const audit = await guild.fetchAuditLogs({ type, limit: 6 });
    const now = Date.now();

    const matching = audit.entries.find((entry) => {
      if (now - (entry.createdTimestamp ?? 0) > AUDIT_LOOKBACK_MS) return false;
      if (targetId && typeof entry.targetId === 'string' && entry.targetId !== targetId) return false;
      return true;
    });

    const executor = matching?.executor;
    if (!executor) return null;
    return executor.tag ?? executor.username ?? `Utilisateur ${executor.id}`;
  } catch {
    // Journal d'audit ferme (permission « Voir les logs du serveur » absente) :
    // le log part sans pied de page plutot que d'inventer un auteur.
    return null;
  }
}

/**
 * Qui a supprime le message : `display` pour le champ de l'embed (mention
 * cliquable), `name` pour le pied de page, ou Discord ne resout aucune mention.
 */
type LogActor = { display: string; name: string | null };

async function resolveMessageDeleteActor(
  guild: Guild,
  message: Message | PartialMessage,
  snapshot: MessageSnapshot | null,
): Promise<LogActor> {
  const authorId = snapshot?.authorId ?? message.author?.id;
  const authorTag = snapshot?.authorTag ?? message.author?.tag;

  if (!authorId || !authorTag) {
    return { display: 'Inconnu', name: null };
  }

  // Aucune entree d'audit : personne d'autre que l'auteur n'a touche au message.
  const selfDelete: LogActor = { display: formatUser(authorId, authorTag), name: authorTag };

  try {
    const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 6 });
    const now = Date.now();

    const matching = audit.entries.find((entry: GuildAuditLogsEntry<AuditLogEvent.MessageDelete>) => {
      const targetId = entry.targetId;
      if (targetId !== authorId) return false;

      const createdAt = entry.createdTimestamp ?? 0;
      if (now - createdAt > AUDIT_LOOKBACK_MS) return false;

      const extra = entry.extra as { channel?: { id?: string } } | null;
      const extraChannelId = extra?.channel?.id;
      if (extraChannelId && extraChannelId !== (snapshot?.channelId ?? message.channelId)) return false;

      return true;
    });

    if (!matching?.executor) {
      return selfDelete;
    }

    const executorId = matching.executor.id;
    if (!executorId) {
      return selfDelete;
    }

    const executorName = matching.executor.tag ?? matching.executor.username ?? `Utilisateur ${executorId}`;
    return { display: formatUser(executorId, executorName), name: executorName };
  } catch {
    return selfDelete;
  }
}

async function resolveBulkDeleteActor(
  guild: Guild,
  channelId: string,
  deletedCount: number,
): Promise<LogActor> {
  try {
    const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 6 });
    const now = Date.now();

    const matching = audit.entries.find((entry: GuildAuditLogsEntry<AuditLogEvent.MessageBulkDelete>) => {
      const createdAt = entry.createdTimestamp ?? 0;
      if (now - createdAt > AUDIT_LOOKBACK_MS) return false;

      const extra = entry.extra as { channel?: { id?: string }; count?: number } | null;
      const extraChannelId = extra?.channel?.id;
      const extraCount = typeof extra?.count === 'number' ? extra.count : null;

      if (extraChannelId && extraChannelId !== channelId) return false;
      if (extraCount !== null && extraCount !== deletedCount) return false;
      return true;
    });

    const executor = matching?.executor;
    const executorId = executor?.id;
    if (!executor || !executorId) return { display: 'Inconnu', name: null };
    const executorName = executor.tag ?? executor.username ?? `Utilisateur ${executorId}`;
    return { display: formatUser(executorId, executorName), name: executorName };
  } catch {
    return { display: 'Inconnu', name: null };
  }
}

function buildBulkDeleteEmbed(
  channelId: string,
  deletedCount: number,
  deletedBy: string,
  authorPreview: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xbc4749)
    .setTitle('🧹 Suppression de messages en masse')
    .addFields(
      { name: 'Salon', value: `<#${channelId}>`, inline: true },
      { name: 'Messages supprimés', value: `${deletedCount}`, inline: true },
      { name: 'Supprimé par', value: deletedBy, inline: true },
      { name: 'Auteurs estimés', value: authorPreview, inline: false },
    )
    .setTimestamp();
}

function buildMessageDeleteEmbed(
  snapshot: MessageSnapshot,
  deletedBy: string,
): EmbedBuilder {
  const content = snapshot.content.trim().length > 0 ? truncate(snapshot.content, 1000) : '_Aucun texte_';
  const attachments = snapshot.attachments.length > 0
    ? snapshot.attachments.slice(0, 5).map((url) => `• ${url}`).join('\n')
    : '_Aucune pièce jointe_';

  const embed = new EmbedBuilder()
    .setColor(0xe63946)
    .setTitle('🗑️ Message supprimé')
    .addFields(
      { name: 'Salon', value: `<#${snapshot.channelId}>`, inline: true },
      { name: 'Auteur', value: formatUser(snapshot.authorId, snapshot.authorTag), inline: true },
      { name: 'Supprimé par', value: deletedBy, inline: true },
      { name: 'Contenu', value: content, inline: false },
      { name: 'Pièces jointes', value: attachments, inline: false },
    )
    .setTimestamp();

  // Le champ n'apparait que s'il y a lieu : un message sur mille porte un
  // autocollant, l'afficher vide a chaque suppression alourdirait le log.
  const stickers = snapshot.stickers ?? [];
  if (stickers.length > 0) {
    embed.addFields({
      name: stickers.length > 1 ? 'Autocollants' : 'Autocollant',
      value: stickers.slice(0, 5).map((sticker) => `• [${sticker.name}](${sticker.url})`).join('\n'),
      inline: false,
    });

    // Un message ne peut porter qu'un autocollant, mais on reste tolerant.
    // Les Lottie servent du JSON : Discord ne saurait pas les afficher.
    const preview = stickers.find((sticker) => sticker.renderable);
    if (preview) embed.setThumbnail(preview.url);
  }

  return embed;
}

function buildMessageEditEmbed(
  beforeContent: string,
  afterContent: string,
  channelId: string,
  authorId: string,
  authorTag: string,
): EmbedBuilder {
  const before = beforeContent.trim().length > 0 ? truncate(beforeContent, 900) : '_Aucun texte_';
  const after = afterContent.trim().length > 0 ? truncate(afterContent, 900) : '_Aucun texte_';

  return new EmbedBuilder()
    .setColor(0xf4a261)
    .setTitle('✏️ Message modifié')
    .addFields(
      { name: 'Salon', value: `<#${channelId}>`, inline: true },
      { name: 'Auteur', value: formatUser(authorId, authorTag), inline: true },
      { name: 'Avant', value: before, inline: false },
      { name: 'Après', value: after, inline: false },
    )
    .setTimestamp();
}

function buildVoiceEmbed(
  actionTitle: string,
  member: GuildMember | null,
  userId: string,
  fields: Array<{ name: string; value: string; inline?: boolean }>,
): EmbedBuilder {
  const userTag = member?.user.tag ?? `Utilisateur ${userId}`;

  return new EmbedBuilder()
    .setColor(0x457b9d)
    .setTitle(actionTitle)
    .setDescription(formatUser(userId, userTag))
    .addFields(fields)
    .setTimestamp();
}

function buildMemberEmbed(
  title: string,
  color: number,
  member: { id: string; user: { tag: string; createdTimestamp: number }; guild: Guild },
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(formatUser(member.id, member.user.tag))
    .addFields(
      { name: 'Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Membre', value: `${member.guild.memberCount}`, inline: true },
    )
    .setTimestamp();
}

function buildChannelEventEmbed(title: string, color: number, channel: GuildBasedChannel, details: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: 'Salon', value: formatChannelName(channel), inline: false },
      { name: 'Détails', value: details, inline: false },
    )
    .setTimestamp();
}

function buildRoleEventEmbed(title: string, color: number, role: Role, details: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: 'Rôle', value: `<@&${role.id}> (${role.name})`, inline: false },
      { name: 'Détails', value: details, inline: false },
    )
    .setTimestamp();
}

function summarizePermissionChanges(previous: string[], current: string[]): string {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);

  const added: string[] = [];
  const removed: string[] = [];

  for (const permission of currentSet) {
    if (!previousSet.has(permission)) added.push(permission);
  }
  for (const permission of previousSet) {
    if (!currentSet.has(permission)) removed.push(permission);
  }

  const addedPreview = added.length > 0 ? added.slice(0, 12).join(', ') : 'Aucune';
  const removedPreview = removed.length > 0 ? removed.slice(0, 12).join(', ') : 'Aucune';
  return `Ajoutées: ${addedPreview}\nRetirées: ${removedPreview}`;
}

function summarizeMemberRoleChanges(oldMember: GuildMember, newMember: GuildMember): string | null {
  const oldRoleIds = new Set(oldMember.roles.cache.keys());
  const newRoleIds = new Set(newMember.roles.cache.keys());

  const added = [...newMember.roles.cache.values()].filter((role) => !oldRoleIds.has(role.id));
  const removed = [...oldMember.roles.cache.values()].filter((role) => !newRoleIds.has(role.id));

  if (added.length === 0 && removed.length === 0) return null;

  const addedText = added.length > 0 ? added.map((role) => `<@&${role.id}>`).join(', ') : 'Aucun';
  const removedText = removed.length > 0 ? removed.map((role) => `<@&${role.id}>`).join(', ') : 'Aucun';

  return `Rôles ajoutés: ${addedText}\nRôles retirés: ${removedText}`;
}

function buildModerationEmbed(
  title: string,
  color: number,
  targetId: string,
  targetTag: string,
  moderatorId: string,
  moderatorTag: string,
  reason: string,
  extraFields: Array<{ name: string; value: string; inline?: boolean }> = [],
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: 'Membre ciblé', value: formatUser(targetId, targetTag), inline: true },
      { name: 'Modérateur', value: formatUser(moderatorId, moderatorTag), inline: true },
      { name: 'Raison', value: reason.trim() || 'Aucune raison fournie', inline: false },
      ...extraFields,
    )
    .setTimestamp();
}

export function registerAdvancedLogsListener(client: Client): void {
  if (advancedLogsRegisteredClients.has(client)) {
    logger.warn('Logs', 'Écouteur de logs avancés déjà enregistré, double enregistrement ignoré.');
    return;
  }
  advancedLogsRegisteredClients.add(client);

  client.on(Events.MessageCreate, (message) => {
    if (shouldIgnoreMessage(message)) return;

    const snapshot = snapshotFromMessage(message);
    if (!snapshot) return;

    void recordMessageAudit(message);

    messageSnapshotStore.set(message.id, snapshot);
    void touchMemberMessageActivity({
      guildId: snapshot.guildId,
      user: message.author,
      channelId: message.channelId,
      displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    }).catch((error) => {
      logger.warn('Casier', `Impossible de mettre à jour l'activité message de ${message.author.id}: ${String(error)}`);
    });

    // 📊 Tracking d'activité staff
    void recordStaffActivity(snapshot.guildId, message.author.id, new Date(), 1, 0).catch((error) => {
      logger.debug('StaffManagement', `Staff activity tracking: ${String(error)}`);
    });

    cleanupMessageSnapshots();
  });

  client.on(Events.MessageDelete, async (message) => {
    if (shouldIgnoreMessage(message)) return;
    if (!message.guild) return;

    const snapshot = messageSnapshotStore.get(message.id) ?? snapshotFromMessage(message);
    if (!snapshot) return;

    messageSnapshotStore.delete(message.id);

    const deletedBy = await resolveMessageDeleteActor(message.guild, message, snapshot);
    const embed = buildMessageDeleteEmbed(snapshot, deletedBy.display);
    const components = [buildMemberCaseActionRow(snapshot.authorId)];
    await sendLogEmbed(message.guild, embed, 'message_delete', components, deletedBy.name, [message.channelId]);
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (shouldIgnoreMessage(newMessage)) return;
    if (!newMessage.guild) return;

    const snapshot = messageSnapshotStore.get(newMessage.id) ?? snapshotFromMessage(oldMessage);
    if (!snapshot) return;

    const newContent = newMessage.content ?? '';
    const previousContent = snapshot.content ?? '';
    if (newContent === previousContent) {
      return;
    }

    const embed = buildMessageEditEmbed(
      previousContent,
      newContent,
      snapshot.channelId,
      snapshot.authorId,
      snapshot.authorTag,
    );

    messageSnapshotStore.set(newMessage.id, {
      ...snapshot,
      content: newContent,
      attachments: [...newMessage.attachments.values()].map((attachment) => attachment.url),
      // Une edition ne touche pas aux autocollants, mais le snapshot est
      // reecrit ici : sans cette ligne, editer puis supprimer un message les
      // ferait disparaitre du log.
      stickers: snapshotStickers(newMessage),
      createdAt: Date.now(),
    });

    await sendLogEmbed(newMessage.guild, embed, 'message_edit', [buildMemberCaseActionRow(snapshot.authorId)], snapshot.authorTag, [newMessage.channelId]);
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!('guild' in channel) || !channel.guild) return;

    const guild = channel.guild;
    const channelId = channel.id;

    const total = messages.size;
    if (total === 0) return;

    const authorCount = new Map<string, number>();

    for (const message of messages.values()) {
      const snapshot = messageSnapshotStore.get(message.id) ?? snapshotFromMessage(message);
      if (!snapshot) continue;

      const key = `${snapshot.authorTag} (${snapshot.authorId})`;
      authorCount.set(key, (authorCount.get(key) ?? 0) + 1);
      messageSnapshotStore.delete(message.id);
    }

    const preview = [...authorCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_BULK_AUTHOR_PREVIEW)
      .map(([author, count]) => `• ${author}: ${count}`)
      .join('\n');

    const deletedBy = await resolveBulkDeleteActor(guild, channelId, total);

    const embed = buildBulkDeleteEmbed(
      channelId,
      total,
      deletedBy.display,
      preview.length > 0 ? preview : 'Auteur non déterminé (messages non présents en cache).',
    );

    await sendLogEmbed(guild, embed, 'message_bulk_delete', undefined, deletedBy.name, [channelId]);
  });

  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const userId = newState.id;
    const member = newState.member ?? oldState.member ?? null;
    const key = voiceSessionKey(guild.id, userId);

    if (!oldState.channelId && newState.channelId) {
      voiceSessionStore.set(key, {
        joinedAt: Date.now(),
        channelId: newState.channelId,
      });

      const embed = buildVoiceEmbed('🔊 Connexion vocale', member, userId, [
        { name: 'Salon', value: `<#${newState.channelId}>`, inline: true },
      ]);

      if (member) {
        void touchMemberVoiceJoin({
          guildId: guild.id,
          user: member.user,
          channelId: newState.channelId,
          displayName: member.displayName,
          joinedAt: new Date(),
        }).catch((error) => {
          logger.warn('Casier', `Impossible de mettre à jour l'activité vocale de ${member.id}: ${String(error)}`);
        });
      }

      await sendLogEmbed(guild, embed, 'voice_join', [buildMemberCaseActionRow(userId)], safeTag(member, userId), [newState.channelId]);
      return;
    }

    if (oldState.channelId && !newState.channelId) {
      const session = voiceSessionStore.get(key);
      voiceSessionStore.delete(key);

      const joinedAt = session?.joinedAt ?? Date.now();
      const duration = formatDurationMs(Date.now() - joinedAt);
      const previousChannelId = oldState.channelId ?? session?.channelId;
      if (!previousChannelId) return;

      const embed = buildVoiceEmbed('🔇 Déconnexion vocale', member, userId, [
        { name: 'Salon', value: `<#${previousChannelId}>`, inline: true },
        { name: 'Temps en vocal', value: duration, inline: true },
      ]);

      if (member) {
        void touchMemberVoiceLeave({
          guildId: guild.id,
          user: member.user,
          channelId: previousChannelId,
          displayName: member.displayName,
          joinedAt: session?.joinedAt ? new Date(session.joinedAt) : undefined,
          durationSeconds: Math.max(0, Math.floor((Date.now() - joinedAt) / 1000)),
        }).catch((error) => {
          logger.warn('Casier', `Impossible de fermer l'activité vocale de ${member.id}: ${String(error)}`);
        });

        // 📊 Tracking d'activité staff (vocal)
        const durationMinutes = Math.floor((Date.now() - joinedAt) / 60000);
        void recordStaffActivity(guild.id, member.id, new Date(), 0, durationMinutes).catch((error) => {
          logger.debug('StaffManagement', `Staff activity tracking: ${String(error)}`);
        });

        // 📊 Analytics: track voice duration
        void incrementGuildDailyVoice(guild.id, durationMinutes);
        void incrementGuildHourlyStat(guild.id, 'voice', durationMinutes);
        void incrementMemberDailyVoice(guild.id, member.id, durationMinutes);
      }

      await sendLogEmbed(guild, embed, 'voice_leave', [buildMemberCaseActionRow(userId)], safeTag(member, userId), [previousChannelId]);
      return;
    }

    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      const previousSession = voiceSessionStore.get(key);
      const joinedAt = previousSession?.joinedAt ?? Date.now();
      const duration = formatDurationMs(Date.now() - joinedAt);

      voiceSessionStore.set(key, {
        joinedAt: Date.now(),
        channelId: newState.channelId,
      });

      const embed = buildVoiceEmbed('🔁 Changement de salon vocal', member, userId, [
        { name: 'Depuis', value: `<#${oldState.channelId}>`, inline: true },
        { name: 'Vers', value: `<#${newState.channelId}>`, inline: true },
        { name: 'Temps dans le salon précédent', value: duration, inline: false },
      ]);

      if (member) {
        void touchMemberVoiceLeave({
          guildId: guild.id,
          user: member.user,
          channelId: oldState.channelId,
          displayName: member.displayName,
          joinedAt: previousSession?.joinedAt ? new Date(previousSession.joinedAt) : undefined,
          durationSeconds: Math.max(0, Math.floor((Date.now() - joinedAt) / 1000)),
        }).catch((error) => {
          logger.warn('Casier', `Impossible de clore l'ancien salon vocal de ${member.id}: ${String(error)}`);
        });

        void touchMemberVoiceJoin({
          guildId: guild.id,
          user: member.user,
          channelId: newState.channelId,
          displayName: member.displayName,
          joinedAt: new Date(),
        }).catch((error) => {
          logger.warn('Casier', `Impossible de démarrer la nouvelle session vocale de ${member.id}: ${String(error)}`);
        });
      }

      await sendLogEmbed(guild, embed, 'voice_move', [buildMemberCaseActionRow(userId)], safeTag(member, userId), [oldState.channelId, newState.channelId]);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const usedInvite = await resolveUsedInviteOnJoin(member.guild);

    // 🛡️ Security Check: Suspension d'invitation ou de créateur
    let isInviteSuspended = false;
    let isCreatorSuspended = false;
    let suspensionReason = '';

    if (usedInvite) {
      // 1. Check if the invitation code itself is suspended
      const dbInvite = await prisma.guildInvite.findUnique({
        where: { code: usedInvite.code },
        select: { isSuspended: true }
      }).catch(() => null);

      if (dbInvite?.isSuspended) {
        isInviteSuspended = true;
        suspensionReason = "Code d'invitation suspendu";
      }

      // 2. Check if the inviter (creator) is globally suspended in the guild
      if (usedInvite.inviterId) {
        const dbSuspendedInviter = await prisma.suspendedInviter.findUnique({
          where: {
            guildId_userId: {
              guildId: member.guild.id,
              userId: usedInvite.inviterId
            }
          },
          select: { reason: true }
        }).catch(() => null);

        if (dbSuspendedInviter) {
          isCreatorSuspended = true;
          suspensionReason = dbSuspendedInviter.reason || "Créateur d'invitations suspendu";
        }
      }
    }

    if (isInviteSuspended || isCreatorSuspended) {
      logger.info('Sécurité', `Expulsion automatique du membre ${member.user.tag} (${member.id}) : ${suspensionReason}`);
      
      const kickReason = `[Kotbo Sécurité] ${suspensionReason}`;
      
      // Kick member immediately
      await member.kick(kickReason).catch((error) => {
        logger.error('Sécurité', `Impossible de kicker le membre suspendu ${member.id}:`, error);
      });

      // Send a high-quality rich security embed in logs
      const embed = new EmbedBuilder()
        .setTitle('🚫 Arrivée Bloquée - Expulsion Automatique')
        .setColor(0xd90429) // Deep crimson red
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }) || null)
        .setDescription(`Le membre **${member.user.tag}** (<@${member.id}>) a été automatiquement exclu dès son arrivée suite à une politique de sécurité.`)
        .addFields(
          { name: 'Motif du blocage', value: suspensionReason, inline: false },
          { name: "Code d'invitation utilisé", value: usedInvite?.code ? `\`${usedInvite.code}\`` : 'Inconnu', inline: true },
          { name: "Créateur de l'invite", value: usedInvite ? formatInviteCreator(usedInvite) : 'Inconnu', inline: true },
          { name: 'ID du créateur', value: usedInvite?.inviterId ? `\`${usedInvite.inviterId}\`` : 'Inconnu', inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Kotbo Security Suite', iconURL: member.guild.iconURL() || undefined });

      await sendLogEmbed(member.guild, embed, 'member_join');
      return; // Stop join operations
    }

    void touchMemberJoin(member).catch((error) => {
      logger.warn('Casier', `Impossible de synchroniser l'arrivée du membre ${member.id}: ${String(error)}`);
    });

    void dcDetectionService.analyzeMemberJoin(member).catch((error) => {
      logger.error('DC', `Erreur lors de l'analyse DC de ${member.id}:`, error);
    });

    if (usedInvite) {
      memberInviteUsageCache.set(memberInviteKey(member.guild.id, member.id), {
        code: usedInvite.code,
        inviterId: usedInvite.inviterId,
        inviterTag: usedInvite.inviterTag,
        joinedAt: Date.now(),
      });
    }

    // 📊 Analytics: persist invite + increment daily join + hourly join
    void persistMemberInvite(member.guild.id, member.id, usedInvite);
    void incrementGuildDailyJoin(member.guild.id);
    void incrementGuildHourlyStat(member.guild.id, 'join');

    const accountAge = Date.now() - member.user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));
    const isVeryYoung = accountAgeDays < 3; // Warning if < 3 days

    const base = buildMemberEmbed(
      isVeryYoung ? '⚠️ Nouveau compte détecté !' : '✅ Membre connecté au serveur',
      isVeryYoung ? 0xea4335 : 0x2a9d8f,
      member
    );
    const inviteCode = usedInvite?.code ?? 'Inconnue / vanity / impossible à détecter';
    const inviter = usedInvite ? formatInviteCreator(usedInvite) : 'Inconnu';

    const embed = EmbedBuilder.from(base).addFields(
      { name: 'Invite utilisée', value: inviteCode, inline: true },
      { name: "Créateur de l'invite", value: inviter, inline: true },
      { name: 'Âge du compte', value: accountAgeDays === 0 ? "Moins d'un jour" : `${accountAgeDays} jours`, inline: true },
    );

    if (isVeryYoung) {
      embed.setDescription(`⚠️ Ce compte a été créé il y a seulement **${accountAgeDays} jours**. Soyez vigilant.`);
    }

    await sendLogEmbed(member.guild, embed, 'member_join', [buildMemberCaseActionRow(member.id)]);
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const inviteKey = memberInviteKey(member.guild.id, member.id);
    const joinedInvite = memberInviteUsageCache.get(inviteKey) ?? null;
    memberInviteUsageCache.delete(inviteKey);

    void touchMemberLeave({
      guildId: member.guild.id,
      user: member.user,
      displayName: member.displayName,
      guildJoinedAt: member.joinedAt ?? null,
    }).catch((error) => {
      logger.warn('Casier', `Impossible de synchroniser la sortie du membre ${member.id}: ${String(error)}`);
    });

    // 📊 Analytics: increment daily leave + hourly leave
    void incrementGuildDailyLeave(member.guild.id);
    void incrementGuildHourlyStat(member.guild.id, 'leave');

    const stayDuration = member.joinedAt ? Date.now() - member.joinedAt.getTime() : null;
    const stayDurationDays = stayDuration ? Math.floor(stayDuration / (1000 * 60 * 60 * 24)) : null;
    const stayDurationFmt = stayDurationDays !== null 
      ? (stayDurationDays === 0 ? "Moins d'un jour" : `${stayDurationDays} jours`) 
      : 'Inconnu';
    
    void recordInvitedMemberLeave(member.guild.id, member.id);

    const embed = buildMemberEmbed(
      '👋 Membre déconnecté du serveur',
      0x8d99ae,
      {
        id: member.id,
        user: {
          tag: member.user?.tag ?? member.user?.username ?? `Utilisateur ${member.id}`,
          createdTimestamp: member.user?.createdTimestamp ?? Date.now(),
        },
        guild: member.guild,
      },
    ).addFields(
      {
        name: "Invite d'arrivée",
        value: joinedInvite?.code ?? 'Inconnue (pas détectée pendant cette session bot)',
        inline: true,
      },
      {
        name: "Créateur de l'invite",
        value: joinedInvite
          ? formatInviteCreator({ inviterId: joinedInvite.inviterId, inviterTag: joinedInvite.inviterTag })
          : 'Inconnu',
        inline: true,
      },
      {
        name: 'Durée de présence',
        value: stayDurationFmt,
        inline: true,
      },
      {
        name: 'ID créateur',
        value: joinedInvite?.inviterId ?? 'Inconnu',
        inline: true,
      },
    );

    await sendLogEmbed(member.guild, embed, 'member_leave', [buildMemberCaseActionRow(member.id)]);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!reaction.message.guildId || user.bot) return;
    void incrementGuildHourlyStat(reaction.message.guildId, 'reaction');
    
    // Log the reaction interaction for the graph
    await prisma.dashboardAuditLog.create({
      data: {
        guildId: reaction.message.guildId,
        channelId: reaction.message.channelId,
        user: formatUser(user.id, user.tag ?? user.username ?? `Utilisateur ${user.id}`),
        action: 'Réaction ajoutée',
        context: reaction.message.guild?.name ?? `Serveur ${reaction.message.guildId}`,
        module: 'Interactions',
        eventType: 'Discord',
        details: truncate([
          `Emoji: ${reaction.emoji.name}`,
          `Cible: ${reaction.message.author?.tag ?? 'Inconnu'} (<@${reaction.message.author?.id ?? '0'}>)`,
          `Message ID: ${reaction.message.id}`
        ].join(' | '), 900),
        dateIso: new Date(),
      }
    }).catch(() => null);
  });

  client.on(Events.ThreadCreate, async (thread) => {
    void incrementGuildHourlyStat(thread.guildId, 'thread');
  });

  client.on(Events.InviteCreate, async (invite) => {
    if (!isFullGuild(invite.guild)) return;
    await syncGuildInvites(invite.guild);
    await refreshGuildInviteCache(invite.guild);
  });

  client.on(Events.InviteDelete, async (invite) => {
    if (!isFullGuild(invite.guild)) return;
    if (invite.code) await markInviteAsDeleted(invite.code);
    await refreshGuildInviteCache(invite.guild);
  });

  client.on(Events.ChannelCreate, async (channel) => {
    if (!isGuildNamedChannel(channel)) return;

    const embed = buildChannelEventEmbed(
      '🧱 Salon créé',
      0x2a9d8f,
      channel,
      `Type: ${channel.type}`,
    );
    const executor = await resolveAuditExecutorName(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    await sendLogEmbed(channel.guild, embed, 'channel_lifecycle', undefined, executor);
  });

  client.on(Events.ChannelDelete, async (channel) => {
    if (!isGuildNamedChannel(channel)) return;

    const embed = buildChannelEventEmbed(
      '🗑️ Salon supprimé',
      0xe63946,
      channel,
      `Type: ${channel.type}`,
    );
    const executor = await resolveAuditExecutorName(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    await sendLogEmbed(channel.guild, embed, 'channel_lifecycle', undefined, executor);
  });

  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (!isGuildNamedChannel(oldChannel) || !isGuildNamedChannel(newChannel)) return;

    if (oldChannel.name === newChannel.name) {
      const oldTopic = 'topic' in oldChannel ? oldChannel.topic : null;
      const newTopic = 'topic' in newChannel ? newChannel.topic : null;
      const oldNsfw = 'nsfw' in oldChannel ? oldChannel.nsfw : null;
      const newNsfw = 'nsfw' in newChannel ? newChannel.nsfw : null;
      const oldSlow = 'rateLimitPerUser' in oldChannel ? oldChannel.rateLimitPerUser : null;
      const newSlow = 'rateLimitPerUser' in newChannel ? newChannel.rateLimitPerUser : null;

      if (oldTopic === newTopic && oldNsfw === newNsfw && oldSlow === newSlow) {
        return;
      }
    }

    const details: string[] = [];
    if (oldChannel.name !== newChannel.name) {
      details.push(`Nom: ${oldChannel.name} -> ${newChannel.name}`);
    }

    if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) {
      details.push(`Sujet: ${(oldChannel.topic ?? 'Aucun')} -> ${(newChannel.topic ?? 'Aucun')}`);
    }

    if ('nsfw' in oldChannel && 'nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) {
      details.push(`NSFW: ${oldChannel.nsfw ? 'Oui' : 'Non'} -> ${newChannel.nsfw ? 'Oui' : 'Non'}`);
    }

    if (
      'rateLimitPerUser' in oldChannel
      && 'rateLimitPerUser' in newChannel
      && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser
    ) {
      details.push(`Slowmode: ${oldChannel.rateLimitPerUser}s -> ${newChannel.rateLimitPerUser}s`);
    }

    const embed = buildChannelEventEmbed(
      '🛠️ Salon modifié',
      0xf4a261,
      newChannel,
      details.length > 0 ? details.join('\n') : 'Modification détectée.',
    );

    const executor = await resolveAuditExecutorName(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    await sendLogEmbed(newChannel.guild, embed, 'channel_lifecycle', undefined, executor);
  });

  client.on(Events.GuildRoleCreate, async (role) => {
    const embed = buildRoleEventEmbed('🆕 Rôle créé', 0x2a9d8f, role, `Couleur: #${role.color.toString(16).padStart(6, '0')}`);
    const executor = await resolveAuditExecutorName(role.guild, AuditLogEvent.RoleCreate, role.id);
    await sendLogEmbed(role.guild, embed, 'role_lifecycle', undefined, executor);
  });

  client.on(Events.GuildRoleDelete, async (role) => {
    const embed = buildRoleEventEmbed('🗑️ Rôle supprimé', 0xe63946, role, `Couleur: #${role.color.toString(16).padStart(6, '0')}`);
    const executor = await resolveAuditExecutorName(role.guild, AuditLogEvent.RoleDelete, role.id);
    await sendLogEmbed(role.guild, embed, 'role_lifecycle', undefined, executor);
  });

  client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
    const changes: string[] = [];

    if (oldRole.name !== newRole.name) changes.push(`Nom: ${oldRole.name} -> ${newRole.name}`);
    if (oldRole.color !== newRole.color) {
      changes.push(
        `Couleur: #${oldRole.color.toString(16).padStart(6, '0')} -> #${newRole.color.toString(16).padStart(6, '0')}`,
      );
    }
    if (oldRole.hoist !== newRole.hoist) changes.push(`Affiché séparément: ${oldRole.hoist ? 'Oui' : 'Non'} -> ${newRole.hoist ? 'Oui' : 'Non'}`);
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push(`Mentionnable: ${oldRole.mentionable ? 'Oui' : 'Non'} -> ${newRole.mentionable ? 'Oui' : 'Non'}`);
    }

    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      changes.push(summarizePermissionChanges(oldRole.permissions.toArray(), newRole.permissions.toArray()));
    }

    if (changes.length === 0) return;

    const embed = buildRoleEventEmbed('🛠️ Rôle modifié', 0xf4a261, newRole, changes.join('\n'));
    const executor = await resolveAuditExecutorName(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    await sendLogEmbed(newRole.guild, embed, 'role_lifecycle', undefined, executor);
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (oldMember.partial || newMember.partial) return;

    void touchMemberProfileFromMember(newMember).catch((error) => {
      logger.warn('Casier', `Impossible de synchroniser le profil du membre ${newMember.id}: ${String(error)}`);
    });

    const roleChanges = summarizeMemberRoleChanges(oldMember, newMember);
    if (roleChanges) {
      void syncStaffHierarchyMembership(newMember.guild.id, newMember.id).catch((error) => {
        logger.warn('StaffManagement', `Impossible de synchroniser l'organigramme pour ${newMember.id}: ${String(error)}`);
      });

      const memberTag = safeTag(newMember, newMember.id);
      const embed = new EmbedBuilder()
        .setColor(0x6d597a)
        .setTitle('🧷 Rôles membre modifiés')
        .addFields(
          { name: 'Membre', value: formatUser(newMember.id, memberTag), inline: false },
          { name: 'Changements', value: roleChanges, inline: false },
        )
        .setTimestamp();

      const roleExecutor = await resolveAuditExecutorName(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
      await sendLogEmbed(newMember.guild, embed, 'member_roles_update', [buildMemberCaseActionRow(newMember.id)], roleExecutor);
    }

    const oldTimeout = oldMember.communicationDisabledUntilTimestamp ?? null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;
    if (oldTimeout !== newTimeout) {
      const memberTag = safeTag(newMember, newMember.id);
      const title = newTimeout && newTimeout > Date.now()
        ? (oldTimeout ? '⏱️ Timeout modifié' : '⏱️ Timeout appliqué')
        : '✅ Timeout retiré';

      const embed = new EmbedBuilder()
        .setColor(newTimeout && newTimeout > Date.now() ? 0xe9c46a : 0x2a9d8f)
        .setTitle(title)
        .addFields(
          { name: 'Membre', value: formatUser(newMember.id, memberTag), inline: false },
          { name: 'Ancienne échéance', value: formatDurationUntil(oldTimeout), inline: true },
          { name: 'Nouvelle échéance', value: formatDurationUntil(newTimeout), inline: true },
        )
        .setTimestamp();

      const timeoutExecutor = await resolveAuditExecutorName(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
      await sendLogEmbed(newMember.guild, embed, 'member_timeout', [buildMemberCaseActionRow(newMember.id)], timeoutExecutor);
    }
  });

  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    const executorId = entry.executorId;
    const targetId = typeof entry.targetId === 'string' ? entry.targetId : null;
    if (!executorId || !targetId) return;

    // Skip bot-initiated moderation actions to prevent duplicate logs (as the bot logs its own actions directly in sanctionService)
    if (executorId === client.user?.id) {
      return;
    }

    if (
      entry.action !== AuditLogEvent.MemberKick
      && entry.action !== AuditLogEvent.MemberBanAdd
      && entry.action !== AuditLogEvent.MemberBanRemove
      && entry.action !== AuditLogEvent.MemberUpdate
    ) {
      return;
    }

    const moderatorTag = await resolveUserTag(client, executorId);
    const targetTag = await resolveUserTag(client, targetId);
    const reason = entry.reason?.trim() ?? 'Aucune raison fournie';

    void touchSanctionTargetIdentity({ guildId: guild.id, userId: targetId, userTag: targetTag }).catch(() => null);
    void touchSanctionTargetIdentity({ guildId: guild.id, userId: executorId, userTag: moderatorTag }).catch(() => null);

    if (entry.action === AuditLogEvent.MemberKick) {
      const embed = buildModerationEmbed(
        '🥾 Expulsion (kick)',
        0xf77f00,
        targetId,
        targetTag,
        executorId,
        moderatorTag,
        reason,
      );
      await sendLogEmbed(guild, embed, 'moderation_kick', [buildMemberCaseActionRow(targetId), buildMemberCaseActionRow(executorId)], moderatorTag);
      return;
    }

    if (entry.action === AuditLogEvent.MemberBanAdd) {
      const embed = buildModerationEmbed(
        '🔨 Bannissement',
        0xd62828,
        targetId,
        targetTag,
        executorId,
        moderatorTag,
        reason,
      );
      await sendLogEmbed(guild, embed, 'moderation_ban', [buildMemberCaseActionRow(targetId), buildMemberCaseActionRow(executorId)], moderatorTag);
      return;
    }

    if (entry.action === AuditLogEvent.MemberBanRemove) {
      const embed = buildModerationEmbed(
        '🟢 Débannissement',
        0x2a9d8f,
        targetId,
        targetTag,
        executorId,
        moderatorTag,
        reason,
      );
      await sendLogEmbed(guild, embed, 'moderation_unban', [buildMemberCaseActionRow(targetId), buildMemberCaseActionRow(executorId)], moderatorTag);
      return;
    }

    if (entry.action === AuditLogEvent.MemberUpdate) {
      const timeoutChange = entry.changes.find((change) => change.key === 'communication_disabled_until');
      if (!timeoutChange) return;

      const oldUntil = parseTimestamp((timeoutChange.old ?? null) as string | number | Date | null);
      const newUntil = parseTimestamp((timeoutChange.new ?? null) as string | number | Date | null);

      const timeoutTitle = newUntil && newUntil > Date.now()
        ? (oldUntil ? '⏱️ Timeout mis à jour' : '⏱️ Timeout appliqué')
        : '✅ Timeout retiré';

      const embed = buildModerationEmbed(
        timeoutTitle,
        0xe9c46a,
        targetId,
        targetTag,
        executorId,
        moderatorTag,
        reason,
        [
          { name: 'Ancienne échéance', value: formatDurationUntil(oldUntil), inline: true },
          { name: 'Nouvelle échéance', value: formatDurationUntil(newUntil), inline: true },
        ],
      );

      await sendLogEmbed(guild, embed, 'moderation_timeout', [buildMemberCaseActionRow(targetId), buildMemberCaseActionRow(executorId)], moderatorTag);
    }
  });

  logger.success('Logs', 'Écouteur de logs avancés enregistré');

  for (const guild of client.guilds.cache.values()) {
    void syncGuildInvites(guild);
    void refreshGuildInviteCache(guild);
  }
}
