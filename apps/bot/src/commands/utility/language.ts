import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('language');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('langue')
      .setDescription(m.language_option_langue_description({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.language_option_langue_description({}, { locale: 'fr' }) })
      .setRequired(true)
      .addChoices(
        { name: m.language_choice_fr({}, { locale: 'en' }), value: 'fr' },
        { name: m.language_choice_en({}, { locale: 'en' }), value: 'en' },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);

  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed(m.language_error_title({}, { locale }), m.language_error_description({}, { locale }))],
      flags: ['Ephemeral'],
    });
    return;
  }

  const target = interaction.options.getString('langue', true) as 'fr' | 'en';

  await prisma.guild.upsert({
    where: { id: interaction.guildId },
    update: { language: target },
    create: { id: interaction.guildId, language: target },
  });
  await cache.invalidateGuild(interaction.guildId);

  const langLabel = target === 'fr' ? m.language_choice_fr({}, { locale: target }) : m.language_choice_en({}, { locale: target });

  await interaction.reply({
    embeds: [
      successEmbed(
        m.language_success_title({}, { locale: target }),
        m.language_success_description({ lang: langLabel }, { locale: target }),
      ),
    ],
  });
}

export const languageCommand = { data, execute } satisfies SlashCommandDefinition;
