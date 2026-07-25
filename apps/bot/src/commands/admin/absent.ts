import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  closeAbsence,
  createAbsence,
  getAbsenceById,
  getLatestOpenAbsenceForMember,
} from '../../services/staff/staffLeadershipService.js';
import { getStaffMember } from '../../services/staff/staffManagementService.js';
import { successContainer, errorContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c1_absent');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('declarer')
      .setDescription(m.c1_absent_declarer_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c1_absent_declarer_desc({}, { locale: 'fr' }) })
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription(m.c1_absent_type_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_type_opt({}, { locale: 'fr' }) })
          .setRequired(true)
          .addChoices(
            { name: m.c1_absent_type_conge({}, { locale: 'en' }), value: 'Conge', name_localizations: { fr: m.c1_absent_type_conge({}, { locale: 'fr' }) } },
            { name: m.c1_absent_type_maladie({}, { locale: 'en' }), value: 'Maladie', name_localizations: { fr: m.c1_absent_type_maladie({}, { locale: 'fr' }) } },
            { name: m.c1_absent_type_personnel({}, { locale: 'en' }), value: 'Personnel', name_localizations: { fr: m.c1_absent_type_personnel({}, { locale: 'fr' }) } },
            { name: m.c1_absent_type_autre({}, { locale: 'en' }), value: 'Autre', name_localizations: { fr: m.c1_absent_type_autre({}, { locale: 'fr' }) } },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('debut')
          .setDescription(m.c1_absent_debut_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_debut_opt({}, { locale: 'fr' }) })
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('raison')
          .setDescription(m.c1_absent_raison_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_raison_opt({}, { locale: 'fr' }) })
          .setRequired(true),
      )
      .addUserOption((option) =>
        option
          .setName('superieur')
          .setDescription(m.c1_absent_superieur_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_superieur_opt({}, { locale: 'fr' }) })
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('fin')
          .setDescription(m.c1_absent_fin_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_fin_opt({}, { locale: 'fr' }) })
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription(m.c1_absent_message_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_message_opt({}, { locale: 'fr' }) })
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('notifier_mention')
          .setDescription(m.c1_absent_notifier_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_notifier_opt({}, { locale: 'fr' }) })
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('terminer')
      .setDescription(m.c1_absent_terminer_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c1_absent_terminer_desc({}, { locale: 'fr' }) })
      .addStringOption((option) =>
        option
          .setName('absence_id')
          .setDescription(m.c1_absent_absence_id_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_absence_id_opt({}, { locale: 'fr' }) })
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName('staff')
          .setDescription(m.c1_absent_staff_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_staff_opt({}, { locale: 'fr' }) })
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('note')
          .setDescription(m.c1_absent_note_opt({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c1_absent_note_opt({}, { locale: 'fr' }) })
          .setRequired(false),
      ),
  );

const parseDateInput = (value: string): Date | null => {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const askIndefiniteConfirmation = async (
  interaction: ChatInputCommandInteraction,
  locale: 'fr' | 'en',
): Promise<ModalSubmitInteraction | null> => {
  const modalCustomId = `absence-indeterminee-${interaction.id}`;
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId)
    .setTitle(m.c1_absent_modal_title({}, { locale }));

  const confirmationInput = new TextInputBuilder()
    .setCustomId('confirmation')
    .setPlaceholder('INDETERMINE')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(11)
    .setMaxLength(11);

  const confirmationInputLabel = new LabelBuilder()
    .setLabel(m.c1_absent_modal_label({}, { locale }))
    .setTextInputComponent(confirmationInput)

  modal.addLabelComponents(confirmationInputLabel)
  await interaction.showModal(modal);

  try {
    const submit = await interaction.awaitModalSubmit({
      time: 90_000,
      filter: (modalInteraction) => modalInteraction.customId === modalCustomId && modalInteraction.user.id === interaction.user.id,
    });

    const value = submit.fields.getTextInputValue('confirmation').trim().toUpperCase();
    if (value !== 'INDETERMINE') {
      await submit.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.c1_absent_confirm_invalid_title({}, { locale }), m.c1_absent_confirm_invalid_desc({}, { locale })),
      ));
      return null;
    }

    await submit.deferReply({ flags: [MessageFlags.Ephemeral] });
    return submit;
  } catch {
    await interaction.followUp(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.c1_absent_confirm_expired_title({}, { locale }), m.c1_absent_confirm_expired_desc({}, { locale })),
    ));
    return null;
  }
};

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;
  const locale = await getEffectiveLocale(interaction);

  const staff = await getStaffMember(interaction.guildId, interaction.user.id);
  if (!staff) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.c1_absent_access_denied_title({}, { locale }), m.c1_absent_access_denied_desc({}, { locale }))
    ));
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'declarer') {
    const type = interaction.options.getString('type', true);
    const debutRaw = interaction.options.getString('debut', true);
    const finRaw = interaction.options.getString('fin', false);
    const reason = interaction.options.getString('raison', true);
    const message = interaction.options.getString('message', false) ?? undefined;
    const notifyOnMention = interaction.options.getBoolean('notifier_mention', false) ?? false;
    const superior = interaction.options.getUser('superieur', true);

    if (superior.bot) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.c1_absent_superior_invalid_title({}, { locale }), m.c1_absent_superior_invalid_desc({}, { locale }))
      ));
      return;
    }

    const superiorStaff = await getStaffMember(interaction.guildId, superior.id);
    if (!superiorStaff) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.c1_absent_superior_notstaff_title({}, { locale }), m.c1_absent_superior_notstaff_desc({}, { locale }))
      ));
      return;
    }

    const startDate = parseDateInput(debutRaw);
    const endDate = finRaw ? parseDateInput(finRaw) : null;

    if (!startDate || (finRaw && !endDate)) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.c1_absent_date_format_title({}, { locale }), m.c1_absent_date_format_desc({}, { locale }))
      ));
      return;
    }

    if (endDate && endDate < startDate) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.c1_absent_date_order_title({}, { locale }), m.c1_absent_date_order_desc({}, { locale }))
      ));
      return;
    }

    let replyInteraction: ChatInputCommandInteraction | ModalSubmitInteraction = interaction;

    if (!endDate) {
      const confirmedModal = await askIndefiniteConfirmation(interaction, locale);
      if (!confirmedModal) {
        return;
      }
      replyInteraction = confirmedModal;
    } else {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    }

    try {
      const absence = await createAbsence({
        guildId: interaction.guildId,
        staffMemberId: staff.id,
        startDate,
        endDate: endDate ?? undefined,
        reason,
        type,
        message,
        superiorUserId: superior.id,
        notifyOnMention,
      });

      const isIndefinite = !endDate;
      await replyInteraction.editReply(v2Message(
        successContainer(
          m.c1_absent_declared_title({}, { locale }),
          isIndefinite
            ? m.c1_absent_declared_indefinite({ superiorId: superior.id, id: absence.id }, { locale })
            : m.c1_absent_declared_dated({ start: debutRaw, end: finRaw ?? '', superiorId: superior.id, id: absence.id }, { locale }),
        )
      ));

      try {
        const lines = [
          `${E.news} ${m.c1_absent_dm_title({}, { locale })}`,
          `${E.arrow} ${m.c1_absent_dm_label_staff({}, { locale })}: ${interaction.user.tag} (${interaction.user.id})`,
          `${E.arrow} ${m.c1_absent_dm_label_type({}, { locale })}: ${type}`,
          `${E.arrow} ${m.c1_absent_dm_label_start({}, { locale })}: ${debutRaw}`,
          `${E.arrow} ${m.c1_absent_dm_label_end({}, { locale })}: ${finRaw ?? m.c1_absent_dm_indefinite({}, { locale })}`,
          `${E.arrow} ${m.c1_absent_dm_label_reason({}, { locale })}: ${reason}`,
        ];
        if (message) lines.push(`${E.arrow} ${m.c1_absent_dm_label_message({}, { locale })}: ${message}`);
        lines.push(`${E.arrow} ID: ${absence.id}`);
        await superior.send(lines.join('\n'));
      } catch {
        // Le DM peut échouer selon les préférences utilisateur, ce n'est pas bloquant.
      }
    } catch (err) {
      await replyInteraction.editReply(v2Message(
        errorContainer(m.c1_absent_generic_error_title({}, { locale }), err instanceof Error ? err.message : m.c1_absent_generic_error_desc({}, { locale }))
      ));
    }
    return;
  }

  if (subcommand === 'terminer') {
    const absenceId = interaction.options.getString('absence_id', false);
    const targetUser = interaction.options.getUser('staff', false) ?? interaction.user;
    const closeNote = interaction.options.getString('note', false) ?? undefined;

    const targetStaff = await getStaffMember(interaction.guildId, targetUser.id);
    if (!targetStaff) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.c1_absent_notfound_title({}, { locale }), m.c1_absent_notfound_desc({}, { locale }))
      ));
      return;
    }

    const absence = absenceId
      ? await getAbsenceById(interaction.guildId, absenceId)
      : await getLatestOpenAbsenceForMember(interaction.guildId, targetStaff.id);

    if (!absence) {
      await interaction.reply(v2Message(
        {flags: MessageFlags.Ephemeral},
        errorContainer(m.c1_absent_none_title({}, { locale }), m.c1_absent_none_desc({}, { locale }))
      ));
      return;
    }

    const isTargetStaff = absence.staffMember.userId === interaction.user.id;
    const isAssignedSuperior = absence.superiorUserId === interaction.user.id;

    if (!isTargetStaff && !isAssignedSuperior) {
      await interaction.reply(v2Message(
        {flags: MessageFlags.Ephemeral},
        errorContainer(m.c1_absent_permission_denied_title({}, { locale }), m.c1_absent_permission_denied_desc({}, { locale }))
      ));
      return;
    }

    await closeAbsence(absence.id, interaction.user.id, closeNote);

    await interaction.reply(v2Message(
      {flags: MessageFlags.Ephemeral},
      successContainer(m.c1_absent_closed_title({}, { locale }), m.c1_absent_closed_desc({ userId: absence.staffMember.userId, id: absence.id }, { locale }))
    ));
  }
}

export const absentCommand: SlashCommandDefinition = { data, execute } satisfies SlashCommandDefinition;
