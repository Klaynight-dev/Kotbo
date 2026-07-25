import {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import type { SlashCommandDefinition, ContextCommandDefinition } from '../../commands.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { createMemberReport, type CreateReportResult } from '../../services/moderation/reportService.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription('🚩 Signale un membre au staff du serveur')
  .addUserOption((opt) =>
    opt.setName('membre').setDescription('Le membre à signaler').setRequired(true))
  .addStringOption((opt) =>
    opt.setName('raison').setDescription('Raison du signalement').setRequired(true).setMaxLength(1000));

const contextData = new ContextMenuCommandBuilder()
  .setName('Signaler ce message')
  .setType(ApplicationCommandType.Message);

export function describeReportError(result: Extract<CreateReportResult, { ok: false }>, locale: 'fr' | 'en' = 'fr'): string {
  switch (result.error) {
    case 'DISABLED':
      return m.b2_report_err_disabled({}, { locale });
    case 'NO_CHANNEL':
      return m.b2_report_err_no_channel({}, { locale });
    case 'SELF_REPORT':
      return m.b2_report_err_self({}, { locale });
    case 'COOLDOWN':
      return m.b2_report_err_cooldown({ sec: result.retryInSec ?? 0 }, { locale });
  }
}

async function executeSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  const target = interaction.options.getUser('membre', true);
  const reason = interaction.options.getString('raison', true);
  const locale = await getEffectiveLocale(interaction);

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const result = await createMemberReport({
    client: interaction.client,
    guild: interaction.guild,
    reporter: interaction.user,
    targetId: target.id,
    reason,
  });

  if (!result.ok) {
    await interaction.editReply({ embeds: [errorEmbed(m.b2_report_impossible_title({}, { locale }), describeReportError(result, locale))] });
    return;
  }

  await interaction.editReply({
    embeds: [successEmbed(m.b2_report_sent_title({}, { locale }), m.b2_report_sent_desc({}, { locale }))],
  });
}

/** Le menu contextuel ouvre un modal pour saisir la raison ; la création du report
 *  est finalisée dans interactionHandler (`report_modal:`). */
async function executeContext(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  const message = interaction.targetMessage;
  const locale = await getEffectiveLocale(interaction);

  const modal = new ModalBuilder()
    .setCustomId(`report_modal:${message.author.id}:${message.channelId}:${message.id}`)
    .setTitle(m.b2_report_modal_title({}, { locale }))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel(m.b2_report_modal_label({}, { locale }))
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
          .setPlaceholder(m.b2_report_modal_placeholder({}, { locale }))
      )
    );

  await interaction.showModal(modal);
}

export const reportCommand: SlashCommandDefinition = { data, execute: executeSlash };
export const reportMessageContextCommand: ContextCommandDefinition = {
  data: contextData,
  execute: executeContext,
};
