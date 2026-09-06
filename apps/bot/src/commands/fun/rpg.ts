import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { buildHubView, isInteractionAdmin, renderPanelView } from '../../services/features/rpgPanelService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('rpg_hub');
const membreMeta = getCommandMetadata('rpg_hub_membre');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption((option) =>
    option
      .setName(membreMeta.name)
      .setNameLocalizations(membreMeta.nameLocalizations)
      .setDescription(membreMeta.description)
      .setDescriptionLocalizations(membreMeta.descriptionLocalizations)
      .setRequired(false),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const guildId = interaction.guildId!;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_module_disabled_title({}, { locale }), m.rpg_module_disabled_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const target = interaction.options.getUser(membreMeta.name) ?? interaction.user;
  const view = await buildHubView(guildId, interaction.user, target, locale, isInteractionAdmin(interaction));

  await interaction.reply(renderPanelView(view));
}

export const rpgCommand = { data, execute } satisfies SlashCommandDefinition;
