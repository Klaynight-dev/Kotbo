import { Client, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags, type ButtonInteraction, type ColorResolvable, type Message } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';

import { resolveEmojiShortcodes } from '../../utils/emojis.js';

type SuggestionFeatureConfig = {
  featureKey?: string;
  enabled?: boolean;
  channelId?: string | null;
};

function isSuggestionFeatureConfig(value: unknown): value is SuggestionFeatureConfig {
  return typeof value === 'object'
    && value !== null
    && (value as SuggestionFeatureConfig).featureKey === 'suggestions';
}

function hasSuggestionEmbed(message: Message, suggestionId: string): boolean {
  return message.embeds.some(embed => embed.footer?.text?.includes(suggestionId));
}

function hasSuggestionComponents(message: Message, suggestionId: string): boolean {
  return JSON.stringify(message.components).includes(`suggest_vote:${suggestionId}:`)
    || JSON.stringify(message.components).includes(`ID de la suggestion : ${suggestionId}`);
}

function isSuggestionMessage(message: Message, suggestionId: string): boolean {
  return hasSuggestionEmbed(message, suggestionId) || hasSuggestionComponents(message, suggestionId);
}

function buildSuggestionEmbed(
  suggestion: { id: string; username: string; content: string },
  upvoteCount: number,
  downvoteCount: number
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('💡 Nouvelle Suggestion')
    .setDescription(resolveEmojiShortcodes(suggestion.content))
    .setAuthor({ name: suggestion.username })
    .addFields(
      { name: 'Statut', value: "⏳ En cours d'évaluation", inline: true },
      { name: 'Votes', value: `👍 Upvotes : \`${upvoteCount}\` | 👎 Downvotes : \`${downvoteCount}\``, inline: true }
    )
    .setColor('#FE75C2')
    .setFooter({ text: `ID de la suggestion : ${suggestion.id}` })
    .setTimestamp();
}

async function findSuggestionMessageInChannel(
  channel: NonNullable<Awaited<ReturnType<Client['channels']['fetch']>>>,
  suggestionId: string,
  messageId: string | null
): Promise<Message | null> {
  if (channel.isThread()) {
    const starterMessage = await channel.fetchStarterMessage().catch((e: unknown) => {
      logger.error('Suggestions', `Impossible de récupérer le message de départ du fil ${channel.id}:`, e);
      return null;
    });

    if (starterMessage && isSuggestionMessage(starterMessage, suggestionId)) {
      return starterMessage;
    }
  }

  if (!channel.isTextBased() || !('messages' in channel)) {
    return null;
  }

  if (messageId) {
    const storedMessage = await channel.messages.fetch(messageId).catch(() => null);
    if (storedMessage && isSuggestionMessage(storedMessage, suggestionId)) {
      return storedMessage;
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch((e: unknown) => {
    logger.error('Suggestions', `Impossible de rechercher le message de la suggestion ${suggestionId} dans ${channel.id}:`, e);
    return null;
  });

  return recentMessages?.find(message => isSuggestionMessage(message, suggestionId)) ?? null;
}

async function findSuggestionMessage(
  interaction: ButtonInteraction,
  suggestion: { id: string; channelId: string | null; messageId: string | null }
): Promise<Message | null> {
  if (isSuggestionMessage(interaction.message, suggestion.id)) {
    return interaction.message;
  }

  const candidateChannelIds = new Set<string>();
  if (suggestion.channelId) candidateChannelIds.add(suggestion.channelId);
  candidateChannelIds.add(interaction.channelId);

  const interactionChannel = interaction.channel;
  if (interactionChannel?.isThread()) {
    const starterMessage = await interactionChannel.fetchStarterMessage().catch(() => null);
    if (starterMessage && isSuggestionMessage(starterMessage, suggestion.id)) {
      return starterMessage;
    }
    if (interactionChannel.parentId) candidateChannelIds.add(interactionChannel.parentId);
  }

  for (const channelId of candidateChannelIds) {
    const channel = interaction.guild?.channels.cache.get(channelId)
      ?? await interaction.client.channels.fetch(channelId).catch(() => null);

    if (!channel) {
      logger.warn('Suggestions', `Channel ${channelId} introuvable pour la suggestion ${suggestion.id}`);
      continue;
    }

    const message = await findSuggestionMessageInChannel(channel, suggestion.id, suggestion.messageId);
    if (message) return message;

    if (channel.isThread() && channel.parentId && !candidateChannelIds.has(channel.parentId)) {
      candidateChannelIds.add(channel.parentId);
    }
  }

  return null;
}

/**
 * Crée et publie une nouvelle suggestion dans le salon dédié
 */
export async function createSuggestion(guildId: string, userId: string, username: string, content: string, client: Client) {
  // 1. Déterminer le salon de suggestions
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { publicChannelId: true, dashboardFeatureConfigs: true }
  });

  const featureConfigs = Array.isArray(guildConfig?.dashboardFeatureConfigs) ? guildConfig.dashboardFeatureConfigs : [];
  const featureConfig = featureConfigs.find(isSuggestionFeatureConfig);
  if (featureConfig && featureConfig.enabled === false) {
    throw new Error('Le système de suggestions est désactivé sur ce serveur.');
  }
  let targetChannelId = featureConfig?.channelId || guildConfig?.publicChannelId;

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) throw new Error("Serveur introuvable");

  // Fallback si aucun canal configuré: chercher un canal textuel nommé "suggestions"
  if (!targetChannelId) {
    const fallbackChannel = discordGuild.channels.cache.find(c => c.name.toLowerCase().includes('suggest') && c.isTextBased());
    if (fallbackChannel) {
      targetChannelId = fallbackChannel.id;
    } else {
      throw new Error("Aucun salon de suggestions n'a été configuré sur le dashboard.");
    }
  }

  const channel = discordGuild.channels.cache.get(targetChannelId);
  if (!channel?.isTextBased()) {
    throw new Error("Le salon de suggestions configuré est invalide ou introuvable.");
  }

  // 2. Créer l'entrée dans la base de données
  const suggestion = await prisma.suggestion.create({
    data: {
      guildId,
      userId,
      username,
      content,
      status: 'PENDING',
      channelId: targetChannelId,
    },
  });

  broadcastDashboardStateChange(guildId, 'suggestions_updated');

  // 3. Envoyer l'embed sur Discord
  const member = await discordGuild.members.fetch(userId).catch(() => null);
  const avatarUrl = member?.user.displayAvatarURL({ size: 128 }) || null;

  const embed = new EmbedBuilder()
    .setTitle(`💡 Nouvelle Suggestion`)
    .setDescription(resolveEmojiShortcodes(content))
    .setAuthor({ name: member?.displayName || username, iconURL: avatarUrl || undefined })
    .addFields(
      { name: 'Statut', value: "⏳ En cours d'évaluation", inline: true },
      { name: 'Votes', value: '👍 Upvotes : `0` | 👎 Downvotes : `0`', inline: true }
    )
    .setColor('#FE75C2')
    .setFooter({ text: `ID de la suggestion : ${suggestion.id}` })
    .setTimestamp();

  // Boutons de vote
  const upvoteBtn = new ButtonBuilder()
    .setCustomId(`suggest_vote:${suggestion.id}:up`)
    .setEmoji('👍')
    .setLabel('0')
    .setStyle(ButtonStyle.Secondary);

  const downvoteBtn = new ButtonBuilder()
    .setCustomId(`suggest_vote:${suggestion.id}:down`)
    .setEmoji('👎')
    .setLabel('0')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(upvoteBtn, downvoteBtn);

  const message = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  
  if (message) {
    await prisma.suggestion.update({
      where: { id: suggestion.id },
      data: { messageId: message.id },
    });
  }

  return suggestion;
}

/**
 * Traite les votes sur une suggestion (Upvote / Downvote)
 */
export async function handleSuggestionVote(interaction: ButtonInteraction, type: 'up' | 'down') {
  const suggestionId = interaction.customId.split(':')[1];
  const userId = interaction.user.id;

  const suggestion = await prisma.suggestion.findUnique({
    where: { id: suggestionId },
  });

  if (!suggestion) {
    return interaction.reply({ content: '❌ Suggestion introuvable.', flags: [MessageFlags.Ephemeral] });
  }

  if (suggestion.status !== 'PENDING') {
    return interaction.reply({ content: '❌ Cette suggestion a déjà été tranchée par le staff.', flags: [MessageFlags.Ephemeral] });
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  let upvoters = [...suggestion.upvoters];
  let downvoters = [...suggestion.downvoters];

  const hasUpvoted = upvoters.includes(userId);
  const hasDownvoted = downvoters.includes(userId);

  if (type === 'up') {
    if (hasUpvoted) {
      upvoters = upvoters.filter(id => id !== userId);
    } else {
      upvoters.push(userId);
      downvoters = downvoters.filter(id => id !== userId); // Enlever du camp adverse
    }
  } else {
    if (hasDownvoted) {
      downvoters = downvoters.filter(id => id !== userId);
    } else {
      downvoters.push(userId);
      upvoters = upvoters.filter(id => id !== userId); // Enlever du camp adverse
    }
  }

  // Enregistrer les votes
  await prisma.suggestion.update({
    where: { id: suggestionId },
    data: { upvoters, downvoters },
  });

  broadcastDashboardStateChange(suggestion.guildId, 'suggestions_updated');

  const message = await findSuggestionMessage(interaction, suggestion);
  if (message) {
    const originalEmbed = message.embeds.find(embed => embed.footer?.text?.includes(suggestion.id));
    const updatedEmbed = originalEmbed
      ? EmbedBuilder.from(originalEmbed)
        .setFields(
          { name: 'Statut', value: "⏳ En cours d'évaluation", inline: true },
          { name: 'Votes', value: `👍 Upvotes : \`${upvoters.length}\` | 👎 Downvotes : \`${downvoters.length}\``, inline: true }
        )
      : buildSuggestionEmbed(suggestion, upvoters.length, downvoters.length);

    const upBtn = new ButtonBuilder()
      .setCustomId(`suggest_vote:${suggestion.id}:up`)
      .setEmoji('👍')
      .setLabel(String(upvoters.length))
      .setStyle(ButtonStyle.Secondary);

    const downBtn = new ButtonBuilder()
      .setCustomId(`suggest_vote:${suggestion.id}:down`)
      .setEmoji('👎')
      .setLabel(String(downvoters.length))
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(upBtn, downBtn);

    try {
      await message.edit({ embeds: [updatedEmbed], components: [row] });

      if (suggestion.channelId !== message.channelId || suggestion.messageId !== message.id) {
        await prisma.suggestion.update({
          where: { id: suggestionId },
          data: { channelId: message.channelId, messageId: message.id },
        });
      }
    } catch (e: unknown) {
      logger.error('Suggestions', `Impossible de mettre à jour l'embed de la suggestion ${suggestion.id}:`, e);
      return interaction.editReply({
        content: "✅ Votre vote a été enregistré, mais l'affichage du compteur n'a pas pu être rafraîchi.",
      });
    }

    return interaction.editReply({
      content: '✅ Votre vote a été pris en compte !',
    });
  } else {
    logger.warn('Suggestions', `Message public introuvable pour la suggestion ${suggestion.id} (interaction message: ${interaction.message.id})`);
  }

  return interaction.editReply({
    content: "✅ Votre vote a été enregistré, mais le message public de la suggestion est introuvable.",
  });
}

/**
 * Met à jour le statut d'une suggestion et son affichage sur Discord (décision du staff)
 */
export async function resolveSuggestion(
  suggestionId: string,
  status: 'APPROVED' | 'REJECTED' | 'IMPLEMENTED',
  responseText: string,
  respondedById: string,
  client: Client
) {
  const suggestion = await prisma.suggestion.findUnique({
    where: { id: suggestionId },
  });

  if (!suggestion) return null;

  // Enregistrer dans la base de données
  const updated = await prisma.suggestion.update({
    where: { id: suggestionId },
    data: {
      status,
      responseText,
      respondedById,
      respondedAt: new Date(),
    },
  });

  broadcastDashboardStateChange(suggestion.guildId, 'suggestions_updated');

  // Mettre à jour l'affichage sur Discord
  if (suggestion.channelId && suggestion.messageId) {
    const discordGuild = client.guilds.cache.get(suggestion.guildId) || await client.guilds.fetch(suggestion.guildId).catch(() => null);
    if (discordGuild) {
      const channel = discordGuild.channels.cache.get(suggestion.channelId);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(suggestion.messageId).catch(() => null);
        if (message) {
          let statusText = "⏳ En cours d'évaluation";
          let color: ColorResolvable = '#FE75C2';

          if (status === 'APPROVED') {
            statusText = '✅ **Approuvée par le Staff**';
            color = '#57F287';
          } else if (status === 'REJECTED') {
            statusText = '❌ **Refusée par le Staff**';
            color = '#ED4245';
          } else if (status === 'IMPLEMENTED') {
            statusText = '🚀 **Implémentée dans la communauté**';
            color = '#5865F2';
          }

          // Le message est en Components V2 (voir utils/patchV2.ts) : `message.embeds`
          // est vide, on reconstruit donc l'embed à partir des données de la BDD.
          const updatedEmbed = new EmbedBuilder()
            .setTitle('💡 Nouvelle Suggestion')
            .setDescription(resolveEmojiShortcodes(suggestion.content))
            .setAuthor({ name: suggestion.username })
            .setColor(color)
            .setFooter({ text: `ID de la suggestion : ${suggestion.id}` })
            .setTimestamp()
            .setFields(
              { name: 'Statut', value: statusText, inline: true },
              { name: 'Votes finaux', value: `👍 Upvotes : \`${updated.upvoters.length}\` | 👎 Downvotes : \`${updated.downvoters.length}\``, inline: true },
              { name: `Réponse de la modération`, value: responseText || 'Aucun commentaire.', inline: false }
            );

          // Désactiver les boutons de vote pour sceller le scrutin
          const upBtn = new ButtonBuilder()
            .setCustomId(`suggest_vote_disabled_up:${suggestion.id}`)
            .setEmoji('👍')
            .setLabel(String(updated.upvoters.length))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

          const downBtn = new ButtonBuilder()
            .setCustomId(`suggest_vote_disabled_down:${suggestion.id}`)
            .setEmoji('👎')
            .setLabel(String(updated.downvoters.length))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(upBtn, downBtn);

          await message.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => null);
        }
      }
    }
  }

  return updated;
}
