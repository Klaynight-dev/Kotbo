import type { ContextCommandDefinition, SlashCommandDefinition } from '../../commands.js';
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { renderPanelTarget } from '../../utils/interactionResponses.js';
import { buildMemberCasePanel } from '../../services/moderation/memberCaseService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_casier');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub
      .setName('voir')
      .setDescription(m.b5_casier_voir_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_casier_voir_desc({}, { locale: 'fr' }) })
      .addUserOption((option) => option.setName('membre').setDescription(m.b5_casier_opt_member({}, { locale: 'en' })).setDescriptionLocalizations({ fr: m.b5_casier_opt_member({}, { locale: 'fr' }) }).setRequired(false))
      .addStringOption((option) => option.setName('id').setDescription(m.b5_casier_opt_id({}, { locale: 'en' })).setDescriptionLocalizations({ fr: m.b5_casier_opt_id({}, { locale: 'fr' }) }).setRequired(false)),
  );

const contextData = new ContextMenuCommandBuilder()
  .setName(m.b5_casier_context_name({}, { locale: 'en' }))
  .setNameLocalizations({ fr: m.b5_casier_context_name({}, { locale: 'fr' }) })
  .setType(ApplicationCommandType.User)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

function extractUserId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(?:<@!?)?(\d{15,25})(?:>)?$/);
  return match?.[1] ?? null;
}

async function replyError(interaction: ChatInputCommandInteraction, title: string, description: string) {
  await interaction.reply({ embeds: [errorEmbed(title, description)], flags: [MessageFlags.Ephemeral] });
}

async function execute(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const locale = await getEffectiveLocale(interaction);

  const targetUserId = interaction.isChatInputCommand()
    ? (interaction.options.getUser('membre', false)?.id ?? (interaction.options.getString('id', false) ? extractUserId(interaction.options.getString('id', false)!) : null))
    : interaction.targetId;

  if (!targetUserId) {
    if (interaction.isChatInputCommand()) {
      await replyError(interaction, m.b5_casier_missing_target_title({}, { locale }), m.b5_casier_missing_target_desc({}, { locale }));
    }
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const panel = await buildMemberCasePanel(interaction.guild, targetUserId, 'resume', 0);
    await renderPanelTarget(interaction, {
      components: panel.components,
      files: panel.files,
      flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
    });
  } catch (error) {
    await renderPanelTarget(interaction, {
      embeds: [errorEmbed(m.b5_casier_unavailable_title({}, { locale }), error instanceof Error ? error.message : m.b5_casier_load_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
  }
}

export const casierCommand = { data, execute } satisfies SlashCommandDefinition;
export const casierContextCommand = { data: contextData, execute } satisfies ContextCommandDefinition;
