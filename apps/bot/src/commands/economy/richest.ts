import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { getRichestPlayers, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_richest');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    const richest = await getRichestPlayers(guildId, 10);

    if (richest.length === 0) {
      await interaction.reply({
        content: m.b5_richest_none({}, { locale }),
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(m.b5_richest_title({ guild: interaction.guild?.name ?? '' }, { locale }))
      .setColor(COLORS.primary)
      .setTimestamp();

    const list = richest
      .map((profile, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `\`#${index + 1}\``;
        return `${medal} <@${profile.userId}> — **${profile.balance}** ${config.currencyEmoji} (${m.b5_richest_level({ level: profile.level }, { locale })})`;
      })
      .join('\n');

    embed.setDescription(list);

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), errorMessage(err) || m.b5_richest_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const richestCommand = { data, execute } satisfies SlashCommandDefinition;
