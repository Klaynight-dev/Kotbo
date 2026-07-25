import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  EmbedBuilder,
  MessageFlags,
  ChannelType
} from 'discord.js';
import prisma from '../../utils/db.js';
import { successEmbed, errorEmbed, COLORS } from '../../utils/embeds.js';
import { parseDateTimeOrDuration } from '../moderation/transcript.js';
import { createReminder, deleteReminder } from '../../services/staff/reminderService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c6_rappel');
const createMeta = getCommandMetadata('c6_rappel_create');
const createTempsMeta = getCommandMetadata('c6_rappel_create_temps');
const createMessageMeta = getCommandMetadata('c6_rappel_create_message');
const createSalonMeta = getCommandMetadata('c6_rappel_create_salon');
const createPlanningMeta = getCommandMetadata('c6_rappel_create_planning');
const listMeta = getCommandMetadata('c6_rappel_list');
const deleteMeta = getCommandMetadata('c6_rappel_delete');
const deleteIdMeta = getCommandMetadata('c6_rappel_delete_id');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub
      .setName(createMeta.name)
      .setNameLocalizations(createMeta.nameLocalizations)
      .setDescription(createMeta.description)
      .setDescriptionLocalizations(createMeta.descriptionLocalizations)
      .addStringOption((option) =>
        option
          .setName(createTempsMeta.name)
          .setNameLocalizations(createTempsMeta.nameLocalizations)
          .setDescription(createTempsMeta.description)
          .setDescriptionLocalizations(createTempsMeta.descriptionLocalizations)
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName(createMessageMeta.name)
          .setNameLocalizations(createMessageMeta.nameLocalizations)
          .setDescription(createMessageMeta.description)
          .setDescriptionLocalizations(createMessageMeta.descriptionLocalizations)
          .setRequired(true)
          .setMaxLength(500)
      )
      .addChannelOption((option) =>
        option
          .setName(createSalonMeta.name)
          .setNameLocalizations(createSalonMeta.nameLocalizations)
          .setDescription(createSalonMeta.description)
          .setDescriptionLocalizations(createSalonMeta.descriptionLocalizations)
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName(createPlanningMeta.name)
          .setNameLocalizations(createPlanningMeta.nameLocalizations)
          .setDescription(createPlanningMeta.description)
          .setDescriptionLocalizations(createPlanningMeta.descriptionLocalizations)
          .setAutocomplete(true)
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName(listMeta.name)
      .setNameLocalizations(listMeta.nameLocalizations)
      .setDescription(listMeta.description)
      .setDescriptionLocalizations(listMeta.descriptionLocalizations)
  )
  .addSubcommand((sub) =>
    sub
      .setName(deleteMeta.name)
      .setNameLocalizations(deleteMeta.nameLocalizations)
      .setDescription(deleteMeta.description)
      .setDescriptionLocalizations(deleteMeta.descriptionLocalizations)
      .addStringOption((option) =>
        option
          .setName(deleteIdMeta.name)
          .setNameLocalizations(deleteIdMeta.nameLocalizations)
          .setDescription(deleteIdMeta.description)
          .setDescriptionLocalizations(deleteIdMeta.descriptionLocalizations)
          .setAutocomplete(true)
          .setRequired(true)
      )
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const { guildId, user } = interaction;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: m.c6_rappel_guild_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === createMeta.name) {
    const tempsStr = interaction.options.getString(createTempsMeta.name, true);
    const message = interaction.options.getString(createMessageMeta.name, true);
    const channel = interaction.options.getChannel(createSalonMeta.name, false);
    const planningItem = interaction.options.getString(createPlanningMeta.name, false);

    const targetTimeMs = parseDateTimeOrDuration(tempsStr);
    if (targetTimeMs === null) {
      await interaction.reply({
        content: m.c6_rappel_invalid_time({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const targetTime = new Date(targetTimeMs);
    if (targetTime <= new Date()) {
      await interaction.reply({
        content: m.c6_rappel_time_in_past({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    let taskId: string | null = null;
    let callId: string | null = null;
    let meetingId: string | null = null;

    if (planningItem) {
      const [type, id] = planningItem.split(':');
      if (type === 'task') taskId = id;
      else if (type === 'call') callId = id;
      else if (type === 'meeting') meetingId = id;
    }

    try {
      await createReminder({
        guildId,
        userId: user.id,
        channelId: channel?.id || null,
        message,
        targetTime,
        taskId,
        callId,
        meetingId
      });

      const timeString = `<t:${Math.floor(targetTime.getTime() / 1000)}:F> (<t:${Math.floor(targetTime.getTime() / 1000)}:R>)`;
      const targetDest = channel ? `${channel}` : m.c6_rappel_dm({}, { locale });

      await interaction.editReply({
        embeds: [
          successEmbed(
            m.c6_rappel_created_title({}, { locale }),
            m.c6_rappel_created_desc({ message, timeString, targetDest }, { locale })
          )
        ]
      });
    } catch (error) {
      await interaction.editReply({
        embeds: [errorEmbed(m.c6_rappel_error_title({}, { locale }), m.c6_rappel_create_error({}, { locale }))]
      });
    }
  }

  else if (subcommand === listMeta.name) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const reminders = await prisma.staffReminder.findMany({
        where: {
          guildId,
          userId: user.id,
          fired: false
        },
        orderBy: {
          targetTime: 'asc'
        },
        include: {
          task: true,
          call: true,
          meeting: true
        }
      });

      if (reminders.length === 0) {
        await interaction.editReply({
          content: m.c6_rappel_none({}, { locale })
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS?.success || 0x2ECC71)
        .setTitle(m.c6_rappel_list_title({}, { locale }))
        .setTimestamp();

      const lines = reminders.map((r) => {
        const timeString = `<t:${Math.floor(r.targetTime.getTime() / 1000)}:R>`;
        let detail = '';
        if (r.task) detail = ` (${m.c6_rappel_linked_task({ title: r.task.title }, { locale })})`;
        else if (r.call) detail = ` (${m.c6_rappel_linked_call({ title: r.call.title }, { locale })})`;
        else if (r.meeting) detail = ` (${m.c6_rappel_linked_meeting({ title: r.meeting.title }, { locale })})`;

        const dest = r.channelId ? `<#${r.channelId}>` : m.c6_rappel_dm_short({}, { locale });
        return `• \`${r.id.slice(-6)}\` · **${r.message}** · ${timeString} · ${m.c6_rappel_channel_label({}, { locale })}: ${dest}${detail}`;
      });

      embed.setDescription(lines.join('\n'));

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({
        embeds: [errorEmbed(m.c6_rappel_error_title({}, { locale }), m.c6_rappel_list_error({}, { locale }))]
      });
    }
  }

  else if (subcommand === deleteMeta.name) {
    const reminderId = interaction.options.getString(deleteIdMeta.name, true);
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      await deleteReminder(reminderId, user.id);
      await interaction.editReply({
        embeds: [successEmbed(m.c6_rappel_deleted_title({}, { locale }), m.c6_rappel_deleted_desc({}, { locale }))]
      });
    } catch (error: any) {
      await interaction.editReply({
        embeds: [errorEmbed(m.c6_rappel_error_title({}, { locale }), error.message || m.c6_rappel_delete_error({}, { locale }))]
      });
    }
  }
}

async function autocomplete(interaction: AutocompleteInteraction) {
  const { guildId, user } = interaction;
  if (!guildId) return;
  const locale = await getEffectiveLocale(interaction);

  const focused = interaction.options.getFocused(true);
  const focusedOption = String(focused.value).trim();
  const focusedName = focused.name;

  if (focusedName === createPlanningMeta.name) {
    try {
      // Fetch meetings, calls and tasks matching query
      const [meetings, calls, tasks] = await Promise.all([
        prisma.staffMeeting.findMany({
          where: {
            guildId,
            scheduledAt: { gte: new Date() },
            title: { contains: focusedOption, mode: 'insensitive' }
          },
          take: 8
        }),
        prisma.staffCall.findMany({
          where: {
            guildId,
            scheduledAt: { gte: new Date() },
            title: { contains: focusedOption, mode: 'insensitive' }
          },
          take: 8
        }),
        prisma.staffTask.findMany({
          where: {
            guildId,
            status: { in: ['PENDING', 'IN_PROGRESS'] },
            title: { contains: focusedOption, mode: 'insensitive' }
          },
          take: 8
        })
      ]);

      const choices: { name: string; value: string }[] = [];

      meetings.forEach(mt => {
        choices.push({ name: `📅 [${m.c6_rappel_ac_meeting({}, { locale })}] ${mt.title.slice(0, 80)}`, value: `meeting:${mt.id}` });
      });
      calls.forEach(c => {
        choices.push({ name: `📞 [${m.c6_rappel_ac_call({}, { locale })}] ${c.title.slice(0, 80)}`, value: `call:${c.id}` });
      });
      tasks.forEach(t => {
        choices.push({ name: `📋 [${m.c6_rappel_ac_task({}, { locale })}] ${t.title.slice(0, 80)}`, value: `task:${t.id}` });
      });

      await interaction.respond(choices.slice(0, 25));
    } catch (e) {
      console.error(e);
      await interaction.respond([]);
    }
  }

  else if (focusedName === deleteIdMeta.name) {
    try {
      const reminders = await prisma.staffReminder.findMany({
        where: {
          guildId,
          userId: user.id,
          fired: false,
          message: { contains: focusedOption, mode: 'insensitive' }
        },
        orderBy: { targetTime: 'asc' },
        take: 25
      });

      const choices = reminders.map(r => {
        const dateStr = r.targetTime.toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return {
          name: `⏰ [${dateStr}] ${r.message.slice(0, 70)}`,
          value: r.id
        };
      });

      await interaction.respond(choices);
    } catch (e) {
      console.error(e);
      await interaction.respond([]);
    }
  }
}

export const rappelCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
