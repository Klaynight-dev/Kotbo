import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { sendDailyAlgo } from '../../services/progression/dailyAlgoService.js';
import { formatDailyAlgoDate } from '../../services/progression/dailyAlgoService.js';
import { successEmbed, errorEmbed, infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

function formatPostError(error: unknown, locale: 'fr' | 'en'): string {
  if (error instanceof Error) {
    return error.message.split('\n').map((line) => line.trim()).find(Boolean) ?? m.b5_unknown_error({}, { locale });
  }

  return String(error ?? m.b5_unknown_error({}, { locale }));
}

const meta = getCommandMetadata('b5_post');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand(subcommand =>
    subcommand
      .setName('daily-algo')
      .setDescription(m.b5_post_dailyalgo_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_post_dailyalgo_desc({}, { locale: 'fr' }) })
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);

  if (!guildId) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), m.b5_guild_only({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    if (subcommand === 'daily-algo') {
      const result = await sendDailyAlgo(interaction.client, guildId);

      if (result.status === 'exists') {
        await interaction.editReply({
          embeds: [infoEmbed(m.b5_post_already_title({}, { locale }), m.b5_post_already_desc({ date: formatDailyAlgoDate(result.dateKey) }, { locale }))],
        });
      } else {
        await interaction.editReply({
          embeds: [successEmbed(m.b5_post_sent_title({}, { locale }), m.b5_post_sent_desc({}, { locale }))],
        });
      }
    }
  } catch (error) {
    logger.error('Post', `Erreur lors du post (${subcommand}):`, error);
    await interaction.editReply({
      embeds: [errorEmbed(m.b5_post_error_title({}, { locale }), m.b5_post_error_desc({ error: formatPostError(error, locale) }, { locale }))],
    });
  }
}

export const postCommand = { data, execute } satisfies SlashCommandDefinition;
