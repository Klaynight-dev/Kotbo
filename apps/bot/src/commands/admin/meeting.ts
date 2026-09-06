import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { errorContainer, infoContainer, kotboContainer, successContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { checkInMeeting, getMeetings, createMeeting, syncMeetingPresencesWithAbsences, MeetingValidationError } from '../../services/staff/staffLeadershipService.js';
import { getStaffMember } from '../../services/staff/staffManagementService.js';
import { logger } from '../../utils/logger.js';
import { separator, v2Message } from '@arcscord/components';
import { getCommandMetadata } from '../../utils/i18n.js';
import { parseDateTimeInTimezone, resolveGuildTimezone } from '../../utils/timezone.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c2_meeting');
const checkinMeta = getCommandMetadata('c2_meeting_checkin');
const listMeta = getCommandMetadata('c2_meeting_list');
const syncMeta = getCommandMetadata('c2_meeting_sync');
const createMeta = getCommandMetadata('c2_meeting_create');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand(sub =>
    sub.setName(checkinMeta.name)
      .setNameLocalizations(checkinMeta.nameLocalizations)
      .setDescription(checkinMeta.description)
      .setDescriptionLocalizations(checkinMeta.descriptionLocalizations))
  .addSubcommand(sub =>
    sub.setName(listMeta.name)
      .setNameLocalizations(listMeta.nameLocalizations)
      .setDescription(listMeta.description)
      .setDescriptionLocalizations(listMeta.descriptionLocalizations))
  .addSubcommand(sub =>
    sub.setName(syncMeta.name)
      .setNameLocalizations(syncMeta.nameLocalizations)
      .setDescription(syncMeta.description)
      .setDescriptionLocalizations(syncMeta.descriptionLocalizations))
  .addSubcommand(sub =>
    sub.setName(createMeta.name)
      .setNameLocalizations(createMeta.nameLocalizations)
      .setDescription(createMeta.description)
      .setDescriptionLocalizations(createMeta.descriptionLocalizations)
      .addStringOption(opt => opt
        .setName('title')
        .setDescription(m.c2_meeting_create_opt_title({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c2_meeting_create_opt_title({}, { locale: 'fr' }) })
        .setRequired(true))
      .addStringOption(opt => opt
        .setName('date')
        .setDescription(m.c2_meeting_create_opt_date({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c2_meeting_create_opt_date({}, { locale: 'fr' }) })
        .setRequired(true))
      .addStringOption(opt => opt
        .setName('description')
        .setDescription(m.c2_meeting_create_opt_description({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c2_meeting_create_opt_description({}, { locale: 'fr' }) })
        .setRequired(false)));

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const staff = await getStaffMember(interaction.guildId, interaction.user.id);
  if (!staff) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer('Accès refusé', "Vous ne faites pas partie de l'équipe Staff."),
    ));
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'checkin') {
    const meetings = await getMeetings(interaction.guildId);
    const now = new Date();
    const activeMeeting = meetings.find(m => m.status === 'SCHEDULED' && Math.abs(m.scheduledAt.getTime() - now.getTime()) < 6 * 60 * 60 * 1000);

    if (!activeMeeting) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer('Aucune réunion', 'Aucune réunion Staff prévue ou en cours.'),
      ));
      return;
    }

    await checkInMeeting(interaction.client, activeMeeting.id, staff.id, 'PRESENT');
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer('Présence validée', `Présence validée pour: **${activeMeeting.title}**`),
    ));
  }

  else if (subcommand === 'list') {
    const meetings = await getMeetings(interaction.guildId);
    const upcoming = meetings.filter(m => m.scheduledAt.getTime() > Date.now() - 2 * 60 * 60 * 1000).slice(0, 5);

    if (upcoming.length === 0) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        infoContainer('Aucune réunion', 'Aucune réunion prévue prochainement.'),
      ));
      return;
    }

    const lines = upcoming.map((m) => {
      const timestamp = Math.floor(m.scheduledAt.getTime() / 1000);
      return `${E.dot} **${m.title}**: <t:${timestamp}:F> (<t:${timestamp}:R>)\n-# Statut: ${m.status}`;
    });

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      kotboContainer({
        color: 'info',
        title: `${E.calendar} Réunions Staff Prévues`,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          ...lines,
        ],
      }),
    ));
  }

  else if (subcommand === 'sync') {
    const meetings = await getMeetings(interaction.guildId);
    const now = new Date();
    const nearest = meetings.find(m => m.status === 'SCHEDULED' && Math.abs(m.scheduledAt.getTime() - now.getTime()) < 24 * 60 * 60 * 1000);

    if (!nearest) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer('Aucune réunion', 'Aucune réunion proche trouvée pour la synchronisation.'),
      ));
      return;
    }

    await syncMeetingPresencesWithAbsences(interaction.client, nearest.id);
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer('Synchronisation effectuée', `Synchronisation des absences effectuée pour: **${nearest.title}**.`),
    ));
  }

  else if (subcommand === 'create') {
    const title = interaction.options.getString('title', true);
    const dateStr = interaction.options.getString('date', true);
    const description = interaction.options.getString('description') || '';

    // Sans fuseau explicite, `new Date` lit la saisie dans celui du process,
    // qui est UTC : « 21:00 » devenait 23h a Paris.
    const timezone = await resolveGuildTimezone(interaction.guildId);
    const scheduledAt = parseDateTimeInTimezone(dateStr, timezone);
    if (!scheduledAt) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer('Format invalide', 'Format de date invalide. Utilisez `YYYY-MM-DD HH:mm` (ex: 2024-05-20 21:00).'),
      ));
      return;
    }

    try {
      const _meeting = await createMeeting(interaction.client, interaction.guildId, interaction.user.id, title, description, scheduledAt);

      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        successContainer('Réunion planifiée', `Réunion planifiée: **${title}** pour le <t:${Math.floor(scheduledAt.getTime()/1000)}:F>.\nL'événement Discord a été créé et l'annonce a été postée.`),
      ));
    } catch (err) {
      // Un refus previsible porte deja son explication : la jeter pour un
      // « Erreur lors de la creation » laissait l'admin sans la moindre piste.
      if (err instanceof MeetingValidationError) {
        logger.warn('MeetingCmd', `Error creating meeting: ${err.message}`);
        await interaction.reply(v2Message(
          { flags: MessageFlags.Ephemeral },
          errorContainer('Création impossible', err.message),
        ));
      } else {
        logger.error('MeetingCmd', 'Error creating meeting:', err);
        await interaction.reply(v2Message(
          { flags: MessageFlags.Ephemeral },
          errorContainer('Erreur', 'Erreur lors de la création de la réunion.'),
        ));
      }
    }
  }
}

export const meetingCommand = { data, execute } satisfies SlashCommandDefinition;
