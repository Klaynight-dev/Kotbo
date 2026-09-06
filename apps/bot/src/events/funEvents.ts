import { Client, Events, Message } from 'discord.js';
import { getCachedGuild } from '../utils/cache.js';
import {
  handleCountingMessage,
  handleOneWordStoryMessage,
  handleGuessNumberMessage,
  handleWordChainMessage,
  handleEmojiRiddleMessage,
  handleNeverSayMessage,
  handleEmojiOnlyMessage
} from '../services/features/funService.js';
import { logger } from '../utils/logger.js';

/**
 * Registers the message listener for Fun Channels.
 */
export function registerFunEventsListener(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    const guildId = message.guildId;
    
    // Ignore direct messages or messages from bots
    if (!guildId || message.author.bot) return;

    try {
      const guild = await getCachedGuild(guildId);
      
      // Ensure the Fun module is active for the server
      if (!guild || !guild.funEnabled) return;

      const channelId = message.channelId;

      if (guild.funCountingChannelId && channelId === guild.funCountingChannelId) {
        await handleCountingMessage(message, guildId, guild.funPunitiveMode);
      } else if (guild.funOneWordStoryChannelId && channelId === guild.funOneWordStoryChannelId) {
        await handleOneWordStoryMessage(message, guildId);
      } else if (guild.funGuessNumberChannelId && channelId === guild.funGuessNumberChannelId) {
        await handleGuessNumberMessage(message, guildId);
      } else if (guild.funWordChainChannelId && channelId === guild.funWordChainChannelId) {
        await handleWordChainMessage(message, guildId, guild.funPunitiveMode);
      } else if (guild.funEmojiRiddleChannelId && channelId === guild.funEmojiRiddleChannelId) {
        await handleEmojiRiddleMessage(message, guildId);
      } else if (guild.funNeverSayChannelId && channelId === guild.funNeverSayChannelId) {
        await handleNeverSayMessage(message);
      } else if (guild.funEmojiOnlyChannelId && channelId === guild.funEmojiOnlyChannelId) {
        await handleEmojiOnlyMessage(message);
      }
    } catch (error) {
      logger.error('FunEvents', `Error processing message in fun channels:`, error);
    }
  });

  logger.info('System', 'Écouteur des Salons Fun enregistré.');
}
