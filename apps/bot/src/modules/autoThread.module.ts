/**
 * AutoThread Module - Bus-based subscriber
 *
 * Listens to message:new events on the bus and creates threads
 * for configured channels. Needs the Discord client to create
 * threads and check permissions.
 */

import type { Client, TextChannel, NewsChannel } from 'discord.js';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import { isStickyMessage } from '../services/features/stickyMessageService.js';
import { getCachedGuild } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'autothread';

async function getAutoThreadConfig(guildId: string): Promise<{ enabled: boolean; channels: string[]; botsEnabled: boolean }> {
  try {
    const guild = await getCachedGuild(guildId);
    return {
      enabled: guild?.autoThreadEnabled ?? false,
      channels: guild?.autoThreadChannels ?? [],
      botsEnabled: guild?.autoThreadBotsEnabled ?? false,
    };
  } catch {
    return { enabled: false, channels: [], botsEnabled: false };
  }
}

export function registerAutoThreadBusSubscribers(client: Client): void {
  subscribeForModule('auto_thread', 'message:new', async (payload) => {
    if (!payload.guildId) return;
    if (payload.isInteraction) return;

    const config = await getAutoThreadConfig(payload.guildId);
    if (!config.enabled || !config.channels.includes(payload.channelId)) return;

    if (payload.isBot && payload.authorId !== client.user?.id && !config.botsEnabled) return;

    const channel = client.channels.cache.get(payload.channelId) as TextChannel | NewsChannel | undefined;
    if (!channel || !('guild' in channel)) return;

    if (channel.isThread()) return;

    const botMember = channel.guild.members.me ?? await channel.guild.members.fetchMe();
    const permissions = botMember.permissionsIn(channel);
    if (!permissions.has(PermissionFlagsBits.CreatePublicThreads) ||
        !permissions.has(PermissionFlagsBits.SendMessagesInThreads)) {
      return;
    }

    const message = await channel.messages.fetch(payload.messageId).catch(() => null);
    if (!message) return;
    if (message.interaction || message.interactionMetadata || message.flags.has(MessageFlags.Ephemeral)) return;

    // Nos propres envois restent éligibles (les suggestions relayées par le bot
    // veulent leur fil), sauf le sticky : il remonte à chaque seuil et
    // laisserait un fil vide derrière chaque renvoi. Testé après le fetch, qui
    // laisse le temps à l'envoi du sticky d'être enregistré si l'événement le
    // devance.
    if (await isStickyMessage(payload.guildId, payload.channelId, payload.messageId)) return;

    let rawName = payload.content ? payload.content.replace(/[\n\r]+/g, ' ').trim() : '';
    let authorName = message.member?.displayName || message.author.displayName || message.author.username;

    if (!rawName && message.embeds.length > 0) {
      const embed = message.embeds[0];
      rawName = (embed.description || embed.title || '').replace(/[\n\r]+/g, ' ').trim();
      if (embed.author?.name) authorName = embed.author.name;
    }

    const cleanContent = rawName.substring(0, 40);
    const threadName = cleanContent
      ? `Fil de ${authorName} - ${cleanContent}...`
      : `Fil de ${authorName}`;

    await message.startThread({
      name: threadName.substring(0, 100),
      autoArchiveDuration: 1440,
      reason: 'AutoThread activé pour le salon.',
    }).catch((e: unknown) => {
      logger.error('AutoThread', `Erreur lors de la création du fil pour le message ${payload.messageId}:`, e);
    });
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}
