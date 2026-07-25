import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  type MessageContextMenuCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  type GuildMember,
  TextChannel,
  type Message
} from 'discord.js';
import type { ContextCommandDefinition } from '../../commands.js';
import prisma from '../../utils/db.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { generateTranscriptFromMessages } from '../../services/features/transcriptService.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

async function isStaffMember(interaction: MessageContextMenuCommandInteraction, guildId: string): Promise<boolean> {
  const member = interaction.member as GuildMember;
  if (!member) return false;

  const currentTicket = interaction.channelId
    ? await prisma.ticket.findFirst({
        where: { guildId, channelId: interaction.channelId },
        select: { staffRoleId: true },
      })
    : null;

  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });

  return (
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    !!(guildConfig?.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) ||
    !!(currentTicket?.staffRoleId && member.roles.cache.has(currentTicket.staffRoleId)) ||
    !!(guildConfig?.ticketStaffRoleId && member.roles.cache.has(guildConfig.ticketStaffRoleId))
  );
}

function transcriptPublicLink(transcriptId: string): string {
  const dashboardUrl = (process.env.DASHBOARD_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${dashboardUrl}/transcripts/${transcriptId}`;
}

const fromData = new ContextMenuCommandBuilder()
  .setName('Transcrire depuis ce message')
  .setType(ApplicationCommandType.Message);

const contextData = new ContextMenuCommandBuilder()
  .setName('Transcrire avec contexte')
  .setType(ApplicationCommandType.Message);

async function executeFrom(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: `❌ ${m.b2_transcript_guild_only({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (!(await isStaffMember(interaction, guildId))) {
    await interaction.reply({
      content: `❌ ${m.b2_transcript_no_permission({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !(channel instanceof TextChannel)) {
    await interaction.reply({
      content: `❌ ${m.b2_transcript_text_only({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const targetMsg = interaction.targetMessage;
    const fetchedMessages: Message[] = [targetMsg];
    let lastId = targetMsg.id;

    for (;;) {
      const messages = await channel.messages.fetch({ limit: 100, after: lastId });
      if (messages.size === 0) break;

      const sortedBatch = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      fetchedMessages.push(...sortedBatch);

      if (messages.size < 100 || fetchedMessages.length >= 1000) break;
      lastId = sortedBatch[sortedBatch.length - 1].id;
    }

    fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const transcriptData = await generateTranscriptFromMessages(channel, fetchedMessages);
    const publicLink = transcriptPublicLink(transcriptData.id);

    await interaction.editReply({
      embeds: [
        successEmbed(
          m.b2_transcript_from_title({}, { locale }),
          m.b2_transcript_from_desc({ count: transcriptData.count, link: publicLink }, { locale })
        ),
      ],
    });
  } catch (error) {
    logger.error('TranscriptContext', 'Erreur lors de la transcription depuis le message:', error);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          m.b2_transcript_error_title({}, { locale }),
          m.b2_transcript_error_desc({}, { locale })
        ),
      ],
    });
  }
}

async function executeContext(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: `❌ ${m.b2_transcript_guild_only({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (!(await isStaffMember(interaction, guildId))) {
    await interaction.reply({
      content: `❌ ${m.b2_transcript_no_permission({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !(channel instanceof TextChannel)) {
    await interaction.reply({
      content: `❌ ${m.b2_transcript_text_only({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const targetMsg = interaction.targetMessage;
    const fetchedMessages: Message[] = [targetMsg];
    let lastId = targetMsg.id;

    // Fetch up to 50 previous messages
    while (fetchedMessages.length < 50) {
      const limit = Math.min(100, 50 - fetchedMessages.length);
      const messages = await channel.messages.fetch({ limit, before: lastId });
      if (messages.size === 0) break;
      fetchedMessages.push(...messages.values());
      lastId = messages.last()?.id ?? lastId;
    }

    fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const transcriptData = await generateTranscriptFromMessages(channel, fetchedMessages);
    const publicLink = transcriptPublicLink(transcriptData.id);

    await interaction.editReply({
      embeds: [
        successEmbed(
          '📄 Transcription avec contexte générée',
          `La transcription de **${transcriptData.count}** message(s) se terminant par le message sélectionné a été créée avec succès.\n\n🌐 [Consulter la transcription](${publicLink})`
        ),
      ],
    });
  } catch (error) {
    logger.error('TranscriptContext', 'Erreur lors de la transcription avec contexte:', error);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Erreur de transcription',
          'Une erreur est survenue lors de la transcription des messages.'
        ),
      ],
    });
  }
}

export const messageTranscriptFromContextCommand = { data: fromData, execute: executeFrom } satisfies ContextCommandDefinition;
export const messageTranscriptContextCommand = { data: contextData, execute: executeContext } satisfies ContextCommandDefinition;
