import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('ping');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

export async function execute(interaction: ChatInputCommandInteraction) {
  const start = Date.now();
  await interaction.deferReply();
  const roundTrip = Date.now() - start;
  const wsLatency = Math.round(interaction.client.ws.ping);
  const locale = await getEffectiveLocale(interaction);

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.ping_pong({}, { locale }),
        m.ping_details({ roundTrip, wsLatency }, { locale })
      ),
    ],
  });
}

export const pingCommand = { data, execute } satisfies SlashCommandDefinition;
