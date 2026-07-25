import type { SlashCommandDefinition } from '../../commands.js';
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { getStaffMember } from '../../services/staff/staffManagementService.js';
import { errorContainer } from '../../utils/embeds.js';
import { v2Message } from '@arcscord/components';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';


const data = new SlashCommandBuilder()
  .setName('demission')
  .setDescription('Soumet une demande de démission du staff avec un motif.');

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const locale = await getEffectiveLocale(interaction);

  const staff = await getStaffMember(interaction.guildId, interaction.user.id);
  if (!staff) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b2_access_denied({}, { locale }), m.b2_not_staff({}, { locale })),
    ));
    return;
  }

  // Vérifier si une demande de démission est déjà en cours
  const pending = await prisma.staffResignation.findFirst({
    where: {
      guildId: interaction.guildId,
      staffUserId: staff.id,
      status: 'PENDING'
    }
  });

  if (pending) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b2_demission_existing_title({}, { locale }), m.b2_demission_existing_desc({}, { locale })),
    ));
    return;
  }

  // Afficher le modal pour renseigner le motif
  const modal = new ModalBuilder()
    .setCustomId('modal:resignation:open')
    .setTitle(m.b2_demission_modal_title({}, { locale }));

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(m.b2_demission_modal_label({}, { locale }))
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(m.b2_demission_modal_placeholder({}, { locale }))
    .setRequired(true)
    .setMaxLength(500);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
  await interaction.showModal(modal);
}

export const demissionCommand = { data, execute } satisfies SlashCommandDefinition;
