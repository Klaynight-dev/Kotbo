import {
  Client,
  Events,
  Message,
  PartialMessage,
  ChannelType,
} from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCachedGuild } from '../utils/cache.js';
import { isGuildActivated } from '../utils/activation.js';

const LOGGABLE_CHANNEL_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
]);
const MESSAGE_LOG_BATCH_SIZE = 200;
const MESSAGE_LOG_FLUSH_MS = 250;
const MESSAGE_LOG_MAX_PENDING = 5_000;

let pendingMessageLogs: Prisma.MessageLogCreateManyInput[] = [];
let messageLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
let messageLogFlushPromise: Promise<void> | null = null;
let lastMessageLogDropWarningAt = 0;

function scheduleMessageLogFlush(delayMs = MESSAGE_LOG_FLUSH_MS): void {
  if (messageLogFlushTimer || messageLogFlushPromise) return;
  messageLogFlushTimer = setTimeout(() => {
    messageLogFlushTimer = null;
    void flushPendingMessageLogs();
  }, delayMs);
  messageLogFlushTimer.unref?.();
}

/**
 * Regroupe les INSERT des salons très actifs. L'ancien createMany d'une seule
 * ligne conservait le coût d'un aller-retour PostgreSQL pour chaque message.
 */
export async function flushPendingMessageLogs(): Promise<void> {
  if (messageLogFlushPromise) return messageLogFlushPromise;
  if (messageLogFlushTimer) {
    clearTimeout(messageLogFlushTimer);
    messageLogFlushTimer = null;
  }
  if (pendingMessageLogs.length === 0) return;

  messageLogFlushPromise = (async () => {
    while (pendingMessageLogs.length > 0) {
      const batch = pendingMessageLogs.splice(0, MESSAGE_LOG_BATCH_SIZE);
      try {
        await prisma.messageLog.createMany({ data: batch, skipDuplicates: true });
      } catch (err) {
        // Conserver un lot pour une nouvelle tentative, avec une borne mémoire
        // explicite si PostgreSQL reste indisponible.
        pendingMessageLogs = [...batch, ...pendingMessageLogs].slice(-MESSAGE_LOG_MAX_PENDING);
        logger.error('MessageLogging', `Impossible d'enregistrer un lot de ${batch.length} message(s):`, err);
        break;
      }
    }
  })();

  try {
    await messageLogFlushPromise;
  } finally {
    messageLogFlushPromise = null;
    if (pendingMessageLogs.length > 0) scheduleMessageLogFlush(1_000);
  }
}

/**
 * Determines whether message logging is active for a guild/channel and returns
 * the resolved guild config, or null when logging should be skipped.
 */
async function resolveLoggingConfig(guildId: string, channel: Message['channel']) {
  if (!isGuildActivated(guildId)) return null;
  const guildConfig = await getCachedGuild(guildId);
  if (!guildConfig || !guildConfig.messageLoggingEnabled) return null;
  const ignored = (guildConfig.messageLoggingIgnoredChannels ?? []) as string[];
  if (ignored.includes(channel.id)) return null;
  // Les fils ne sont pas proposés à l'exclusion : exclure un salon doit couvrir
  // les fils qui y sont ouverts, sans quoi la moitié des messages passe quand
  // même en base.
  if (channel.isThread() && channel.parentId && ignored.includes(channel.parentId)) return null;
  return guildConfig;
}

function extractAttachments(message: Message) {
  return message.attachments.map((a) => ({
    name: a.name,
    url: a.url,
    contentType: a.contentType ?? null,
  }));
}

async function logMessage(message: Message): Promise<void> {
  const { guild, channel, author } = message;
  if (!guild || !author) return;
  if (channel.type === ChannelType.DM) return;
  if (!LOGGABLE_CHANNEL_TYPES.has(channel.type)) return;

  const config = await resolveLoggingConfig(guild.id, channel);
  if (!config) return;

  const attachments = extractAttachments(message);
  const stickerCount = message.stickers?.size ?? 0;

  // Nothing searchable/relevant to store (e.g. pure system messages).
  if (!message.content && attachments.length === 0 && stickerCount === 0) return;

  const channelName = 'name' in channel && channel.name ? channel.name : channel.id;
  const authorName = message.member?.displayName || author.displayName || author.username;

  if (pendingMessageLogs.length >= MESSAGE_LOG_MAX_PENDING) {
    pendingMessageLogs.splice(0, pendingMessageLogs.length - MESSAGE_LOG_MAX_PENDING + 1);
    if (Date.now() - lastMessageLogDropWarningAt > 60_000) {
      lastMessageLogDropWarningAt = Date.now();
      logger.warn('MessageLogging', `File d'attente saturée (${MESSAGE_LOG_MAX_PENDING}); les entrées les plus anciennes sont abandonnées.`);
    }
  }

  pendingMessageLogs.push({
    guildId: guild.id,
    channelId: channel.id,
    channelName,
    messageId: message.id,
    authorId: author.id,
    authorName,
    authorAvatar: author.displayAvatarURL({ size: 64 }),
    isBot: author.bot,
    content: message.content ?? '',
    attachments: attachments.length > 0 ? attachments : undefined,
    embedCount: message.embeds?.length ?? 0,
    hasAttachment: attachments.length > 0,
    mentionedUserIds: message.mentions?.users ? [...message.mentions.users.keys()] : [],
    repliedToAuthorId: message.mentions?.repliedUser?.id ?? null,
    createdAt: message.createdAt,
  });

  if (pendingMessageLogs.length >= MESSAGE_LOG_BATCH_SIZE) {
    void flushPendingMessageLogs();
  } else {
    scheduleMessageLogFlush();
  }
}

async function updateLoggedMessage(newMessage: Message | PartialMessage): Promise<void> {
  const guildId = newMessage.guild?.id;
  const channel = newMessage.channel;
  if (!guildId || !channel) return;

  const config = await resolveLoggingConfig(guildId, channel);
  if (!config) return;

  let full: Message;
  try {
    full = newMessage.partial ? await newMessage.fetch() : (newMessage as Message);
  } catch {
    return;
  }

  try {
    // Garantit qu'une édition arrivée juste après MessageCreate trouve bien sa
    // ligne, même si celle-ci attendait encore dans le lot.
    await flushPendingMessageLogs();
    await prisma.messageLog.updateMany({
      where: { messageId: full.id },
      data: {
        content: full.content ?? '',
        embedCount: full.embeds?.length ?? 0,
        editedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error('MessageLogging', `Impossible de mettre à jour le message ${full.id}:`, err);
  }
}

async function markMessageDeleted(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    await flushPendingMessageLogs();
    await prisma.messageLog.updateMany({
      where: { messageId: { in: messageIds }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  } catch (err) {
    logger.error('MessageLogging', 'Impossible de marquer des messages comme supprimés:', err);
  }
}

/**
 * Prunes message logs older than each guild's configured retention window.
 * Exported so it can be scheduled by the cron system.
 */
export async function pruneOldMessageLogs(): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { messageLoggingEnabled: true },
    select: { id: true, messageLoggingRetentionDays: true },
  });

  for (const g of guilds) {
    const days = g.messageLoggingRetentionDays ?? 90;
    if (days <= 0) continue;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      const { count } = await prisma.messageLog.deleteMany({
        where: { guildId: g.id, createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        logger.info('MessageLogging', `Purge de ${count} message(s) expiré(s) pour la guilde ${g.id}.`);
      }
    } catch (err) {
      logger.error('MessageLogging', `Erreur lors de la purge des logs pour ${g.id}:`, err);
    }
  }
}

export function registerMessageLoggingListener(client: Client): void {
  client.on(Events.MessageCreate, (message: Message) => {
    void logMessage(message).catch((err) => {
      logger.error('MessageLogging', 'Erreur lors de la journalisation du message:', err);
    });
  });

  client.on(Events.MessageUpdate, (_old, newMessage) => {
    void updateLoggedMessage(newMessage).catch((err) => {
      logger.error('MessageLogging', "Erreur lors de la mise à jour d'un message journalisé:", err);
    });
  });

  client.on(Events.MessageDelete, (message: Message | PartialMessage) => {
    void markMessageDeleted([message.id]).catch((err) => {
      logger.error('MessageLogging', "Erreur lors du marquage de suppression d'un message:", err);
    });
  });

  client.on(Events.MessageBulkDelete, (messages) => {
    void markMessageDeleted([...messages.keys()]).catch((err) => {
      logger.error('MessageLogging', 'Erreur lors du marquage de suppression groupée:', err);
    });
  });

  logger.success('MessageLogging', 'Écouteur de journalisation des messages enregistré');
}
