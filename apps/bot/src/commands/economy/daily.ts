import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags, EmbedBuilder } from 'discord.js';
import { claimDaily, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('🪙 Récupérer vos pièces quotidiennes gratuites');

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getEffectiveLocale(interaction);

  try {
    const result = await claimDaily(guildId, userId);
    const config = await getOrCreateEconomyConfig(guildId);

    if (!result.success) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            m.b2_daily_unavailable_title({}, { locale }),
            m.b2_daily_unavailable_desc({ hours: result.remainingHours ?? 0, minutes: result.remainingMinutes ?? 0 }, { locale })
          )
        ],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(m.b2_daily_reward_title({}, { locale }))
      .setDescription(m.b2_daily_reward_desc({ reward: result.reward ?? 0, emoji: config.currencyEmoji, name: config.currencyName }, { locale }))
      .addFields({ name: m.b2_daily_new_balance({}, { locale }), value: `**${result.newBalance}** ${config.currencyEmoji}` })
      .setColor(COLORS.success)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), errorMessage(err) || m.b2_daily_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const dailyCommand = { data, execute } satisfies SlashCommandDefinition;
