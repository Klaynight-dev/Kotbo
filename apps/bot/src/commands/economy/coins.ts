import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { v2Message } from '@arcscord/components';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('coins')
  .setDescription("🪙 Consulter le solde de pièces d'un membre")
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription('Le membre à inspecter (défaut: vous-même)')
      .setRequired(false)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser('membre') ?? interaction.user;
  const locale = await getEffectiveLocale(interaction);

  if (targetUser.bot) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b3_error_title({}, { locale }), m.b3_coins_bot_error({}, { locale })),
    ));
    return;
  }

  try {
    const profile = await getOrCreateRpgProfile(guildId, targetUser.id);
    const config = await getOrCreateEconomyConfig(guildId);

    await interaction.reply(v2Message(
      kotboContainer({
        color: 'primary',
        title: m.b3_coins_title({ coins: E.coins, name: targetUser.displayName }, { locale }),
        titleThumbnail: { url: targetUser.displayAvatarURL({ size: 128 }) },
        fields: [
          m.b3_coins_balance({ userId: targetUser.id, balance: profile.balance, currencyEmoji: config.currencyEmoji, currencyName: config.currencyName }, { locale }),
        ],
      }),
    ));
  } catch (err: unknown) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b3_error_title({}, { locale }), err instanceof Error ? err.message : m.b3_coins_error_desc({}, { locale })),
    ));
  }
}

export const coinsCommand = { data, execute } satisfies SlashCommandDefinition;
