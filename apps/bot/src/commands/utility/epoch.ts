import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { infoEmbed, errorEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('epoch')
  .setDescription('🕐 Convertis entre timestamp Unix et date lisible')
  .addStringOption(option =>
    option
      .setName('value')
      .setDescription('Timestamp Unix (ex: 1712155663) ou date YYYY-MM-DD')
      .setRequired(false)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const input = interaction.options.getString('value');
  const locale = await getEffectiveLocale(interaction);

  try {
    let timestamp: number;
    let isConversion: boolean;

    if (!input) {
      // No argument: return current timestamp
      timestamp = Math.floor(Date.now() / 1000);
      isConversion = false;
    } else if (/^\d+$/.test(input)) {
      // Unix timestamp input: convert to readable date
      timestamp = parseInt(input, 10);
      if (timestamp < 0 || timestamp > 9999999999) {
        await interaction.reply({
          embeds: [errorEmbed(m.b1_epoch_invalid_ts_title({}, { locale }), m.b1_epoch_invalid_ts_desc({}, { locale }))],
          flags: 64, // ephemeral
        });
        return;
      }
      isConversion = true;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      // Date format YYYY-MM-DD: convert to timestamp
      const date = new Date(`${input}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) {
        await interaction.reply({
          embeds: [errorEmbed(m.b1_epoch_invalid_date_title({}, { locale }), m.b1_epoch_invalid_date_desc({}, { locale }))],
          flags: 64,
        });
        return;
      }
      timestamp = Math.floor(date.getTime() / 1000);
      isConversion = true;
    } else {
      await interaction.reply({
        embeds: [
          errorEmbed(
            m.b1_epoch_unrecognized_title({}, { locale }),
            m.b1_epoch_unrecognized_desc({}, { locale })
          ),
        ],
        flags: 64,
      });
      return;
    }

    const date = new Date(timestamp * 1000);
    const discordTimeFormat = `<t:${timestamp}:F>`;

    await interaction.reply({
      embeds: [
        infoEmbed(
          m.b1_epoch_conversion_title({}, { locale }),
          isConversion
            ? m.b1_epoch_result_converted({ ts: `${timestamp}`, date: discordTimeFormat }, { locale })
            : m.b1_epoch_result_current({ ts: `${timestamp}`, date: discordTimeFormat }, { locale }),
          [
            {
              name: 'ISO 8601',
              value: `\`${date.toISOString()}\``,
              inline: false,
            },
            {
              name: m.b1_epoch_field_discord({}, { locale }),
              value: `${discordTimeFormat}`,
              inline: false,
            },
          ]
        ),
      ],
    });
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed(m.b1_error({}, { locale }), m.b1_epoch_error_desc({}, { locale }))],
      flags: 64,
    });
  }
}

export const epochCommand = { data, execute } satisfies SlashCommandDefinition;
