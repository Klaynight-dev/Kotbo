import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { text, successContainer, errorContainer, v2, COLORS_RAW } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import {
  addXp,
  setXp,
  getMemberRankData,
  getXpForLevel,
} from '../../services/progression/levelingService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c2_leveling');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup(group =>
    group
      .setName('xp')
      .setDescription(m.c2_leveling_group_xp_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c2_leveling_group_xp_desc({}, { locale: 'fr' }) })
      .addSubcommand(sub =>
        sub
          .setName('add')
          .setDescription(m.c2_leveling_xp_add_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_xp_add_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
          .addIntegerOption(option => option.setName('montant')
            .setDescription(m.c2_leveling_xp_add_amount_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_xp_add_amount_desc({}, { locale: 'fr' }) })
            .setRequired(true).setMinValue(1))
      )
      .addSubcommand(sub =>
        sub
          .setName('remove')
          .setDescription(m.c2_leveling_xp_remove_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_xp_remove_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
          .addIntegerOption(option => option.setName('montant')
            .setDescription(m.c2_leveling_xp_remove_amount_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_xp_remove_amount_desc({}, { locale: 'fr' }) })
            .setRequired(true).setMinValue(1))
      )
      .addSubcommand(sub =>
        sub
          .setName('set')
          .setDescription(m.c2_leveling_xp_set_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_xp_set_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
          .addIntegerOption(option => option.setName('montant')
            .setDescription(m.c2_leveling_xp_set_amount_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_xp_set_amount_desc({}, { locale: 'fr' }) })
            .setRequired(true).setMinValue(0))
      )
      .addSubcommand(sub =>
        sub
          .setName('voir')
          .setDescription(m.c2_leveling_voir_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_voir_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
      )
      .addSubcommand(sub =>
        sub
          .setName('reset')
          .setDescription(m.c2_leveling_reset_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_reset_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('level')
      .setDescription(m.c2_leveling_group_level_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c2_leveling_group_level_desc({}, { locale: 'fr' }) })
      .addSubcommand(sub =>
        sub
          .setName('add')
          .setDescription(m.c2_leveling_level_add_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_level_add_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
          .addIntegerOption(option => option.setName('montant')
            .setDescription(m.c2_leveling_level_add_amount_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_level_add_amount_desc({}, { locale: 'fr' }) })
            .setRequired(true).setMinValue(1))
      )
      .addSubcommand(sub =>
        sub
          .setName('remove')
          .setDescription(m.c2_leveling_level_remove_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_level_remove_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
          .addIntegerOption(option => option.setName('montant')
            .setDescription(m.c2_leveling_level_remove_amount_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_level_remove_amount_desc({}, { locale: 'fr' }) })
            .setRequired(true).setMinValue(1))
      )
      .addSubcommand(sub =>
        sub
          .setName('set')
          .setDescription(m.c2_leveling_level_set_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_level_set_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
          .addIntegerOption(option => option.setName('niveau')
            .setDescription(m.c2_leveling_level_set_niveau_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_level_set_niveau_desc({}, { locale: 'fr' }) })
            .setRequired(true).setMinValue(0))
      )
      .addSubcommand(sub =>
        sub
          .setName('voir')
          .setDescription(m.c2_leveling_voir_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_voir_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
      )
      .addSubcommand(sub =>
        sub
          .setName('reset')
          .setDescription(m.c2_leveling_reset_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c2_leveling_reset_desc({}, { locale: 'fr' }) })
          .addUserOption(option => option.setName('membre')
            .setDescription(m.c2_leveling_opt_membre_desc({}, { locale: 'en' }))
            .setDescriptionLocalizations({ fr: m.c2_leveling_opt_membre_desc({}, { locale: 'fr' }) })
            .setRequired(true))
      )
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);

  if (!guildId) {
    await interaction.reply({
      ...v2(errorContainer(m.c2_leveling_error_title({}, { locale }), m.c2_leveling_guild_only({}, { locale }))),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(true) as 'xp' | 'level';
  const subcommand = interaction.options.getSubcommand(true);
  const targetUser = interaction.options.getUser('membre', true);

  if (targetUser.bot) {
    await interaction.reply({
      ...v2(errorContainer(m.c2_leveling_error_title({}, { locale }), m.c2_leveling_bot_target_error({}, { locale }))),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  await prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });

  const numberLocale = locale === 'fr' ? 'fr-FR' : 'en-US';

  try {
    if (subcommand === 'voir') {
      const rankData = await getMemberRankData(guildId, targetUser.id);

      const container = new ContainerBuilder()
        .setAccentColor(COLORS_RAW.info)
        .addTextDisplayComponents(text(`### ${E.level} ${m.c2_leveling_progress_title({ userId: targetUser.id }, { locale })}`))
        .addTextDisplayComponents(text(
          m.c2_leveling_progress_body({
            level: rankData.level,
            rank: rankData.rank,
            totalXp: rankData.totalXp.toLocaleString(numberLocale),
            xpCurrent: rankData.xpInCurrentLevel.toLocaleString(numberLocale),
            xpRequired: rankData.xpRequiredForNextLevel.toLocaleString(numberLocale),
          }, { locale })
        ));

      await interaction.reply({
        ...v2(container),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'reset') {
      await setXp(guildId, targetUser.id, 0, interaction.client);

      await interaction.reply({
        ...v2(successContainer(
          m.c2_leveling_reset_title({}, { locale }),
          m.c2_leveling_reset_body({ userId: targetUser.id }, { locale })
        )),
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (group === 'xp') {
      const amount = interaction.options.getInteger('montant', true);

      if (subcommand === 'add' || subcommand === 'remove') {
        const delta = subcommand === 'add' ? amount : -amount;
        await addXp(guildId, targetUser.id, delta, interaction.client);
        const updated = await prisma.memberLevel.findUnique({
          where: { guildId_userId: { guildId, userId: targetUser.id } },
          select: { xp: true, level: true },
        });

        const bodyParams = {
          amount,
          emoji: E.xp,
          userId: targetUser.id,
          levelEmoji: E.level,
          level: updated?.level ?? 0,
          xp: (updated?.xp ?? 0).toLocaleString(numberLocale),
        };

        await interaction.reply({
          ...v2(successContainer(
            subcommand === 'add' ? m.c2_leveling_xp_added_title({}, { locale }) : m.c2_leveling_xp_removed_title({}, { locale }),
            subcommand === 'add' ? m.c2_leveling_xp_add_body(bodyParams, { locale }) : m.c2_leveling_xp_remove_body(bodyParams, { locale })
          )),
          flags: MessageFlags.IsComponentsV2,
        });
      } else if (subcommand === 'set') {
        const result = await setXp(guildId, targetUser.id, amount, interaction.client);

        await interaction.reply({
          ...v2(successContainer(
            m.c2_leveling_xp_set_title({}, { locale }),
            m.c2_leveling_xp_set_body({
              userId: targetUser.id,
              xp: result.xp.toLocaleString(numberLocale),
              emoji: E.level,
              level: result.level,
            }, { locale })
          )),
          flags: MessageFlags.IsComponentsV2,
        });
      }
    } else if (group === 'level') {
      if (subcommand === 'add' || subcommand === 'remove') {
        const amount = interaction.options.getInteger('montant', true);
        const rankData = await getMemberRankData(guildId, targetUser.id);
        const targetLevel = Math.max(0, rankData.level + (subcommand === 'add' ? amount : -amount));
        const targetXp = getXpForLevel(targetLevel - 1);
        const result = await setXp(guildId, targetUser.id, targetXp, interaction.client);

        await interaction.reply({
          ...v2(successContainer(
            subcommand === 'add' ? m.c2_leveling_level_added_title({}, { locale }) : m.c2_leveling_level_removed_title({}, { locale }),
            m.c2_leveling_level_change_body({
              userId: targetUser.id,
              emoji: E.level,
              level: result.level,
              xp: result.xp.toLocaleString(numberLocale),
            }, { locale })
          )),
          flags: MessageFlags.IsComponentsV2,
        });
      } else if (subcommand === 'set') {
        const level = interaction.options.getInteger('niveau', true);
        const targetXp = getXpForLevel(level - 1);
        const result = await setXp(guildId, targetUser.id, targetXp, interaction.client);

        await interaction.reply({
          ...v2(successContainer(
            m.c2_leveling_level_set_title({}, { locale }),
            m.c2_leveling_level_change_body({
              userId: targetUser.id,
              emoji: E.level,
              level: result.level,
              xp: result.xp.toLocaleString(numberLocale),
            }, { locale })
          )),
          flags: MessageFlags.IsComponentsV2,
        });
      }
    }
  } catch (err: unknown) {
    await interaction.reply({
      ...v2(errorContainer(m.c2_leveling_error_title({}, { locale }), err instanceof Error ? err.message : m.c2_leveling_generic_error({}, { locale }))),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
}

export const levelingCommand = { data, execute } satisfies SlashCommandDefinition;
