import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { createSuggestion } from '../../services/features/suggestionService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_suggest');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption((o) =>
    o
      .setName('suggestion')
      .setDescription(m.b5_suggest_option_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_suggest_option_desc({}, { locale: 'fr' }) })
      .setRequired(true)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: m.b5_guild_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const content = interaction.options.getString('suggestion', true);

  try {
    const suggestion = await createSuggestion(
      guildId,
      interaction.user.id,
      interaction.user.username,
      content,
      interaction.client
    );
    await interaction.editReply(m.b5_suggest_success({ id: suggestion.id }, { locale }));
  } catch (err: unknown) {
    await interaction.editReply(m.b5_suggest_error({ error: errorMessage(err) || m.b5_unknown_error({}, { locale }) }, { locale }));
  }
}

export const suggestCommand = { data, execute } satisfies SlashCommandDefinition;
