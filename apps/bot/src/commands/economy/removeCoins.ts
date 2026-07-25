import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { adminRemoveCoins, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_removecoins');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription(m.b5_removecoins_opt_member({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_removecoins_opt_member({}, { locale: 'fr' }) })
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName('montant')
      .setDescription(m.b5_removecoins_opt_amount({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_removecoins_opt_amount({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMinValue(1)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser('membre', true);
  const amount = interaction.options.getInteger('montant', true);
  const locale = await getEffectiveLocale(interaction);

  if (targetUser.bot) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), m.b5_removecoins_bot_target({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const result = await adminRemoveCoins(guildId, targetUser.id, amount);
    const config = await getOrCreateEconomyConfig(guildId);

    await interaction.reply({
      embeds: [
        successEmbed(
          m.b5_removecoins_success_title({}, { locale }),
          m.b5_removecoins_success_desc({ amount, emoji: config.currencyEmoji, user: `<@${targetUser.id}>`, newBalance: result.newBalance }, { locale })
        )
      ]
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), errorMessage(err) || m.b5_removecoins_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const removeCoinsCommand = { data, execute } satisfies SlashCommandDefinition;
