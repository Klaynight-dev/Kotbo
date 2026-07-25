import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('economy-info')
  .setDescription("🪙 Tout ce qu'il faut savoir sur l'économie du serveur");

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);

    await interaction.reply(v2Message(
      kotboContainer({
        color: 'primary',
        title: m.b3_ecoinfo_title({ coins: E.coins, guild: interaction.guild?.name ?? '' }, { locale }),
        fields: [
          m.b3_ecoinfo_welcome({ currencyName: config.currencyName, currencyEmoji: config.currencyEmoji }, { locale }),
          separator({ divider: true, spacing: 'small' }),
          m.b3_ecoinfo_earn({ stats: E.stats, dot: E.dot }, { locale }),
          separator({ divider: true, spacing: 'small' }),
          m.b3_ecoinfo_shop({ coins: E.coins, dot: E.dot }, { locale }),
        ],
        footerOverwrite: `-# ${E.info} ${config.enabled ? m.b3_ecoinfo_enabled_yes({ success: E.success }, { locale }) : m.b3_ecoinfo_enabled_no({ error: E.error }, { locale })}`,
      }),
    ));
  } catch (err: unknown) {
    await interaction.reply({ content: m.b3_ecoinfo_error({ error: E.error }, { locale }), flags: [MessageFlags.Ephemeral] });
  }
}

export const economyInfoCommand = { data, execute } satisfies SlashCommandDefinition;
