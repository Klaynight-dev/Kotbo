import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { handleCtfFlagSubmission } from '../../services/features/eventService.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_ctf');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand(sub =>
    sub
      .setName('claim')
      .setDescription(m.b5_ctf_claim_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_ctf_claim_desc({}, { locale: 'fr' }) })
      .addStringOption(opt =>
        opt
          .setName('flag')
          .setDescription(m.b5_ctf_flag_opt_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b5_ctf_flag_opt_desc({}, { locale: 'fr' }) })
          .setRequired(true)
      )
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'claim') {
    return handleClaim(interaction);
  }
}

async function handleClaim(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    return interaction.reply({ content: m.b5_guild_only({}, { locale }), ephemeral: true });
  }

  const flag = interaction.options.getString('flag', true);

  try {
    // Trouver le CTF en cours sur le serveur
    const activeCtf = await prisma.event.findFirst({
      where: {
        guildId,
        type: 'CTF',
        status: 'ONGOING',
      },
    });

    if (!activeCtf) {
      return interaction.reply({ content: m.b5_ctf_none_active({}, { locale }), ephemeral: true });
    }

    return await handleCtfFlagSubmission(interaction, activeCtf.id, flag);
  } catch (err) {
    logger.error('CtfCommand', 'Error handling claim:', err);
    return interaction.reply({ content: m.b5_ctf_error({}, { locale }), ephemeral: true });
  }
}

export const ctfCommand = { data, execute } satisfies SlashCommandDefinition;
