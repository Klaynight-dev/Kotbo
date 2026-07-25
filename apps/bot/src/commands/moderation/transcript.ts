import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  TextChannel,
  type Message,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { generateTranscriptFromMessages } from '../../services/features/transcriptService.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('transcript')
  .setDescription('📄 Génère, liste, recherche ou supprime des transcriptions de salon')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('generer')
      .setDescription('📄 Génère une transcription des messages de ce salon')
      .addIntegerOption((option) =>
        option
          .setName('nombre')
          .setDescription('Nombre de messages à transcrire (par défaut 100)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(5000)
      )
      .addStringOption((option) =>
        option
          .setName('temps')
          .setDescription('Début : Durée (ex: 2h), Date (JJ/MM/AAAA-HH:MM) ou Timestamp')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('message_id')
          .setDescription('Début : ID du message de départ')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('jusqua_message_id')
          .setDescription("Fin : ID du message d'arrêt")
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('jusqua_temps')
          .setDescription('Fin : Durée (ex: 1h), Date (JJ/MM/AAAA-HH:MM) ou Timestamp')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('liste')
      .setDescription('📋 Liste les dernières transcriptions du serveur')
      .addChannelOption((option) =>
        option
          .setName('salon')
          .setDescription('Filtrer par salon')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('rechercher')
      .setDescription('🔎 Recherche des transcriptions par nom de salon')
      .addStringOption((option) =>
        option
          .setName('requete')
          .setDescription('Nom (ou partie du nom) du salon à rechercher')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('supprimer')
      .setDescription('🗑️ Supprime une transcription (administrateurs)')
      .addStringOption((option) =>
        option
          .setName('id')
          .setDescription('ID de la transcription à supprimer')
          .setRequired(true)
      )
  );

export function parseDurationToMs(durationStr: string): number | null {
  const match = durationStr.trim().toLowerCase().match(/^(\d+)\s*(m|h|d|j|s|w|min|heures?|jours?|semaines?)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm':
    case 'min':
      return value * 60 * 1000;
    case 'h':
    case 'heure':
    case 'heures':
      return value * 60 * 60 * 1000;
    case 'd':
    case 'j':
    case 'jour':
    case 'jours':
      return value * 24 * 60 * 60 * 1000;
    case 'w':
    case 's':
    case 'semaine':
    case 'semaines':
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

export function parseDateTimeOrDuration(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Check relative duration first (e.g., 2h, 30m)
  const durationMs = parseDurationToMs(trimmed);
  if (durationMs !== null) {
    return Date.now() - durationMs;
  }

  // 2. Check if digits only (unix timestamp)
  if (/^\d+$/.test(trimmed)) {
    const val = parseInt(trimmed, 10);
    if (trimmed.length <= 11) {
      return val * 1000;
    }
    return val;
  }

  // 3. Check French date format DD/MM/YYYY-HH:MM or DD/MM/YYYY HH:MM or DD/MM/YYYY
  const dateRegex = /^(\d{2})[/-](\d{2})[/-](\d{4})(?:[ -](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const match = trimmed.match(dateRegex);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const year = parseInt(match[3], 10);
    const hour = match[4] ? parseInt(match[4], 10) : 0;
    const minute = match[5] ? parseInt(match[5], 10) : 0;
    const second = match[6] ? parseInt(match[6], 10) : 0;

    const date = new Date(year, month, day, hour, minute, second);
    if (!isNaN(date.getTime())) {
      return date.getTime();
    }
  }

  // 4. Fallback JS parse
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    return parsed;
  }

  return null;
}

/**
 * Checks whether the invoking member is allowed to use transcript commands
 * (Manage Messages / Administrator, a configured moderator/ticket-staff role,
 * or the current ticket's staff role).
 */
async function isStaffMember(interaction: ChatInputCommandInteraction, guildId: string): Promise<boolean> {
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

async function executeGenerate(interaction: ChatInputCommandInteraction, _guildId: string) {
  const locale = await getEffectiveLocale(interaction);
  const channel = interaction.channel;
  if (!channel || !(channel instanceof TextChannel)) {
    await interaction.reply({
      content: m.b4_transcript_text_channel_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const count = interaction.options.getInteger('nombre', false);
  const temps = interaction.options.getString('temps', false);
  const messageId = interaction.options.getString('message_id', false);
  const jusquaMessageId = interaction.options.getString('jusqua_message_id', false);
  const jusquaTemps = interaction.options.getString('jusqua_temps', false);

  // Check start options (mutually exclusive)
  let startOptionsCount = 0;
  if (count !== null) startOptionsCount++;
  if (temps !== null) startOptionsCount++;
  if (messageId !== null) startOptionsCount++;

  if (startOptionsCount > 1) {
    await interaction.reply({
      content: m.b4_transcript_one_start_option({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  // Check end options (mutually exclusive)
  let endOptionsCount = 0;
  if (jusquaMessageId !== null) endOptionsCount++;
  if (jusquaTemps !== null) endOptionsCount++;

  if (endOptionsCount > 1) {
    await interaction.reply({
      content: m.b4_transcript_one_end_option({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    // Validate explicit message IDs if provided
    if (messageId !== null) {
      try {
        await channel.messages.fetch(messageId);
      } catch (err) {
        await interaction.editReply({
          content: m.b4_transcript_start_msg_not_found({ messageId }, { locale }),
        });
        return;
      }
    }

    if (jusquaMessageId !== null) {
      try {
        await channel.messages.fetch(jusquaMessageId);
      } catch (err) {
        await interaction.editReply({
          content: m.b4_transcript_end_msg_not_found({ jusquaMessageId }, { locale }),
        });
        return;
      }
    }

    let startId: string | undefined;
    let endId: string | undefined;

    // Resolve start point
    if (messageId !== null) {
      startId = messageId;
    } else if (temps !== null) {
      const startTimestamp = parseDateTimeOrDuration(temps);
      if (startTimestamp === null) {
        await interaction.editReply({
          content: m.b4_transcript_invalid_start_format({}, { locale }),
        });
        return;
      }
      startId = ((BigInt(startTimestamp) - 1420070400000n) << 22n).toString();
    }

    // Resolve end point
    if (jusquaMessageId !== null) {
      endId = jusquaMessageId;
    } else if (jusquaTemps !== null) {
      const endTimestamp = parseDateTimeOrDuration(jusquaTemps);
      if (endTimestamp === null) {
        await interaction.editReply({
          content: m.b4_transcript_invalid_end_format({}, { locale }),
        });
        return;
      }
      endId = ((BigInt(endTimestamp) - 1420070400000n) << 22n).toString();
    }

    const fetchedMessages: Message[] = [];

    if (startId !== undefined) {
      // Fetch forward from startId
      const finalEndId = endId ?? ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();

      // Ensure chronological order
      let firstId = startId;
      let secondId = finalEndId;
      if (BigInt(firstId) > BigInt(secondId)) {
        firstId = finalEndId;
        secondId = startId;
      }

      try {
        const startMsg = await channel.messages.fetch(firstId);
        if (startMsg) {
          fetchedMessages.push(startMsg);
        }
      } catch (err) {
        // Ignore
      }

      let lastId = firstId;
      for (;;) {
        const messages = await channel.messages.fetch({ limit: 100, after: lastId });
        if (messages.size === 0) break;

        let stop = false;
        const sortedBatch = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const msg of sortedBatch) {
          if (BigInt(msg.id) > BigInt(secondId)) {
            stop = true;
            break;
          }
          fetchedMessages.push(msg);
        }

        if (stop || messages.size < 100) break;
        lastId = sortedBatch[sortedBatch.length - 1].id;
      }
      fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    } else if (endId !== undefined) {
      // Fetch backward from endId
      const limitCount = count ?? 100;

      try {
        const endMsg = await channel.messages.fetch(endId);
        if (endMsg) {
          fetchedMessages.push(endMsg);
        }
      } catch (err) {
        // Ignore
      }

      let lastId = endId;
      while (fetchedMessages.length < limitCount) {
        const limit = Math.min(100, limitCount - fetchedMessages.length);
        const messages = await channel.messages.fetch({ limit, before: lastId });
        if (messages.size === 0) break;
        fetchedMessages.push(...messages.values());
        lastId = messages.last()?.id ?? lastId;
      }
      fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    } else {
      // Default: fetch last X messages from now
      const limitCount = count ?? 100;
      let lastId: string | undefined;
      while (fetchedMessages.length < limitCount) {
        const limit = Math.min(100, limitCount - fetchedMessages.length);
        const messages = await channel.messages.fetch({ limit, before: lastId });
        if (messages.size === 0) break;
        fetchedMessages.push(...messages.values());
        lastId = messages.last()?.id;
      }
      fetchedMessages.reverse();
    }

    if (fetchedMessages.length === 0) {
      await interaction.editReply({
        content: m.b4_transcript_no_messages({}, { locale }),
      });
      return;
    }

    // Generate transcript using the existing module
    const transcriptData = await generateTranscriptFromMessages(channel, fetchedMessages);
    const publicLink = transcriptPublicLink(transcriptData.id);

    await interaction.editReply({
      embeds: [
        successEmbed(
          m.b4_transcript_generated_title({}, { locale }),
          m.b4_transcript_generated_desc({ count: transcriptData.count, publicLink }, { locale })
        ),
      ],
    });

  } catch (error) {
    logger.error('Transcript', 'Erreur lors de la génération de la transcription command:', error);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          m.b4_transcript_error_title({}, { locale }),
          m.b4_transcript_error_desc({}, { locale })
        ),
      ],
    });
  }
}

async function executeList(interaction: ChatInputCommandInteraction, guildId: string, searchQuery?: string) {
  const locale = await getEffectiveLocale(interaction);
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const channelOption = interaction.options.getChannel('salon', false);

  const where: Record<string, unknown> = { guildId };
  if (channelOption) where.channelId = channelOption.id;
  if (searchQuery) where.channelName = { contains: searchQuery, mode: 'insensitive' };

  try {
    const transcripts = await prisma.transcript.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, channelName: true, createdAt: true },
    });

    if (transcripts.length === 0) {
      await interaction.editReply({
        content: searchQuery
          ? m.b4_transcript_none_found_query({ searchQuery }, { locale })
          : m.b4_transcript_none_saved({}, { locale }),
      });
      return;
    }

    const lines = transcripts.map((t) => {
      const ts = Math.floor(t.createdAt.getTime() / 1000);
      const link = transcriptPublicLink(t.id);
      return `• **#${t.channelName}** — <t:${ts}:R> · [${m.b4_transcript_open({}, { locale })}](${link})\n\`${t.id}\``;
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          searchQuery ? m.b4_transcript_list_search_title({ searchQuery }, { locale }) : m.b4_transcript_list_recent_title({}, { locale }),
          lines.join('\n')
        ),
      ],
    });
  } catch (error) {
    logger.error('Transcript', 'Erreur lors de la liste des transcriptions:', error);
    await interaction.editReply({
      embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_transcript_list_fetch_error({}, { locale }))],
    });
  }
}

async function executeDelete(interaction: ChatInputCommandInteraction, guildId: string) {
  const locale = await getEffectiveLocale(interaction);
  const member = interaction.member as GuildMember;
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: m.b4_transcript_delete_admin_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const id = interaction.options.getString('id', true);
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const transcript = await prisma.transcript.findUnique({
      where: { id },
      select: { id: true, guildId: true, channelName: true },
    });

    if (!transcript || transcript.guildId !== guildId) {
      await interaction.editReply({ content: m.b4_transcript_id_not_found({ id }, { locale }) });
      return;
    }

    await prisma.transcript.delete({ where: { id } });
    await interaction.editReply({
      embeds: [
        successEmbed(m.b4_transcript_deleted_title({}, { locale }), m.b4_transcript_deleted_desc({ channelName: transcript.channelName, id }, { locale })),
      ],
    });
  } catch (error) {
    logger.error('Transcript', 'Erreur lors de la suppression de la transcription:', error);
    await interaction.editReply({
      embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_transcript_delete_error({}, { locale }))],
    });
  }
}

async function execute(interaction: ChatInputCommandInteraction) {
  const { guildId } = interaction;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: m.b4_transcript_guild_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (!(await isStaffMember(interaction, guildId))) {
    await interaction.reply({
      content: m.b4_transcript_no_permission({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case 'generer':
      await executeGenerate(interaction, guildId);
      break;
    case 'liste':
      await executeList(interaction, guildId);
      break;
    case 'rechercher':
      await executeList(interaction, guildId, interaction.options.getString('requete', true));
      break;
    case 'supprimer':
      await executeDelete(interaction, guildId);
      break;
    default:
      await interaction.reply({
        content: m.b4_transcript_unknown_subcommand({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
  }
}

export const transcriptCommand = { data, execute } satisfies SlashCommandDefinition;
