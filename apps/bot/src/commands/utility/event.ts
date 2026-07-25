import type { SlashCommandDefinition } from '../../commands.js';
import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { buildEventResultsView } from '../../services/features/eventService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_event');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand(sub =>
    sub
      .setName('resultat')
      .setDescription(m.b5_event_resultat_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_event_resultat_desc({}, { locale: 'fr' }) })
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'resultat') {
    return handleResults(interaction);
  }
}

async function handleResults(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const locale = await getEffectiveLocale(interaction);

  try {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(m.b5_guild_only({}, { locale }));
      return;
    }

    const results = await buildEventResultsView(interaction, '', 0);
    await interaction.editReply(results);
  } catch (err) {
    logger.error('EventCommand', 'Error showing results:', err);
    await interaction.editReply(m.b5_generic_error({}, { locale }));
  }
}

export const eventCommand = { data, execute } satisfies SlashCommandDefinition;
