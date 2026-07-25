import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { successContainer, errorContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { isGuildActivated, activateGuild } from '../../utils/activation.js';
import { initializeAutoBackup } from '../../services/system/autoBackupService.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c1_activate');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName('code')
      .setDescription(m.c1_activate_code_opt({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c1_activate_code_opt({}, { locale: 'fr' }) })
      .setRequired(true)
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral},
      errorContainer(m.c1_activate_error_title({}, { locale }), m.c1_activate_guild_only({}, { locale }))
    ));
  }

  // Check if already activated
  if (isGuildActivated(guildId)) {
    return interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral},
      errorContainer(m.c1_activate_already_title({}, { locale }), m.c1_activate_already_desc({}, { locale }))
    ));
  }

  const codeStr = interaction.options.getString('code', true).trim().toUpperCase();

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    // Look up code in DB
    const activationCode = await prisma.activationCode.findFirst({
      where: {
        code: codeStr,
        isActive: true,
        usedByGuildId: null,
      },
    });

    if (!activationCode) {
      return interaction.editReply(v2Message(
        errorContainer(m.c1_activate_invalid_code_title({}, { locale }), m.c1_activate_invalid_code_desc({}, { locale }))
      )
      );
    }

    // Activate
    await activateGuild(guildId, codeStr);

    // Initialize auto backup
    if (interaction.guild) {
      await initializeAutoBackup(interaction.guild).catch((err) =>
        console.error('Failed to initialize auto backup:', err)
      );
    }

    // Start historical message scraping
    const { startHistoricalScraping } = await import('../../services/analytics/messageScraperService.js');
    startHistoricalScraping(interaction.client, guildId).catch((err) =>
      console.error('Failed to start historical scraping:', err)
    );

    await interaction.editReply(v2Message(
      successContainer(
        `${E.fire} ${m.c1_activate_success_title({}, { locale })}`,
        m.c1_activate_success_desc({}, { locale }),
      )
    ));
  } catch (error) {
    console.error('Command activate error:', error);
    await interaction.editReply(v2Message(
      errorContainer(m.c1_activate_system_error_title({}, { locale }), m.c1_activate_system_error_desc({}, { locale }))
    ));
  }
}

export const activateCommand = { data, execute } satisfies SlashCommandDefinition;
