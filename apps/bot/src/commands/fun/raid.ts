import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, joinFieldEntries, COLORS } from '../../utils/embeds.js';
import { getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { getRaidLeaderboard } from '../../services/features/rpg/rpgRaidService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('rpg_raid_cmd');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub.setName('top')
      .setDescription(m.rpg_raid_cmd_top_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.rpg_raid_cmd_top_desc({}, { locale: 'fr' }) }));

function medal(index: number): string {
  if (index === 0) return '🥇';
  if (index === 1) return '🥈';
  if (index === 2) return '🥉';
  return `\`#${index + 1}\``;
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const guildId = interaction.guildId;
  if (!guildId) return;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled || !config.raidEnabled) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_raid_panel_title({}, { locale }), m.rpg_raid_panel_disabled({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply();

  const { strikers, teams } = await getRaidLeaderboard(guildId, 10);
  if (strikers.length === 0) {
    await interaction.editReply({
      embeds: [errorEmbed(m.rpg_raid_top_empty_title({}, { locale }), m.rpg_raid_top_empty_desc({}, { locale }))],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_raid_top_title({ guild: interaction.guild?.name ?? '' }, { locale }))
    .setColor(COLORS.danger)
    .setDescription(strikers.map((striker, index) => m.rpg_raid_top_striker({
      medal: medal(index),
      user: `<@${striker.userId}>`,
      damage: striker.damage.toLocaleString('fr-FR'),
      assaults: striker.assaults,
      blows: striker.killingBlows > 0 ? m.rpg_raid_top_blows({ blows: striker.killingBlows }, { locale }) : '',
    }, { locale })).join('\n'))
    .setTimestamp();

  // Les équipes se comptent en boss abattus et non en dégâts : une équipe nombreuse en porte
  // mécaniquement plus, alors que mettre son boss à terre est la même épreuve pour toutes.
  if (teams.length > 0) {
    embed.addFields({
      name: m.rpg_raid_top_field_kills({}, { locale }),
      value: joinFieldEntries(
        teams.map((team, index) => m.rpg_raid_top_team({ medal: medal(index), team: team.teamName, kills: team.kills }, { locale })),
        { more: (count) => m.rpg_raid_teams_more({ count }, { locale }) },
      ),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

export const raidCommand = { data, execute } satisfies SlashCommandDefinition;
