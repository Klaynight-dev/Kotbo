import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { transferCoins, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_givecoins');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription(m.b5_givecoins_opt_member({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_givecoins_opt_member({}, { locale: 'fr' }) })
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName('montant')
      .setDescription(m.b5_givecoins_opt_amount({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_givecoins_opt_amount({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMinValue(1)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const senderId = interaction.user.id;
  const receiver = interaction.options.getUser('membre', true);
  const amount = interaction.options.getInteger('montant', true);
  const locale = await getEffectiveLocale(interaction);

  if (receiver.bot) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), m.b5_givecoins_to_bot({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  if (receiver.id === senderId) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), m.b5_givecoins_to_self({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    const result = await transferCoins(guildId, senderId, receiver.id, amount);

    await interaction.reply({
      embeds: [
        successEmbed(
          m.b5_givecoins_success_title({}, { locale }),
          m.b5_givecoins_success_desc({ amount, emoji: config.currencyEmoji, user: `<@${receiver.id}>`, senderBalance: result.senderBalance, receiverBalance: result.receiverBalance }, { locale })
        )
      ]
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_givecoins_failed_title({}, { locale }), errorMessage(err) || m.b5_givecoins_failed_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const giveCoinsCommand = { data, execute } satisfies SlashCommandDefinition;
