import type { SlashCommandDefinition } from '../../commands.js';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { COLORS } from '../../utils/embeds.js';
import { getInviteLeaderboard, getUserInviteStats } from '../../services/analytics/inviteService.js';
import prisma from '../../utils/db.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_invites');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand(sub =>
    sub
      .setName('stats')
      .setDescription(m.b5_invites_stats_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_invites_stats_desc({}, { locale: 'fr' }) })
      .addUserOption(option =>
        option.setName('membre').setDescription(m.b5_invites_opt_member({}, { locale: 'en' })).setDescriptionLocalizations({ fr: m.b5_invites_opt_member({}, { locale: 'fr' }) }).setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('leaderboard')
      .setDescription(m.b5_invites_leaderboard_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_invites_leaderboard_desc({}, { locale: 'fr' }) })
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();
  const locale = await getEffectiveLocale(interaction);

  if (!guildId) {
    await interaction.reply({
      content: m.b5_guild_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply();

  if (subcommand === 'stats') {
    const targetUser = interaction.options.getUser('membre') ?? interaction.user;
    const stats = await getUserInviteStats(guildId, targetUser.id);

    if (!stats || stats.totalJoined === 0) {
      await interaction.editReply({
        content: targetUser.id === interaction.user.id
          ? m.b5_invites_none_self({}, { locale })
          : m.b5_invites_none_other({ user: targetUser.username }, { locale }),
      });
      return;
    }

    const retentionRate = stats.totalJoined > 0 ? Math.round((stats.totalStayed / stats.totalJoined) * 100) : 0;

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(m.b5_invites_title({ user: targetUser.username }, { locale }))
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: m.b5_invites_field_total({}, { locale }), value: String(stats.totalJoined), inline: true },
        { name: m.b5_invites_field_active({}, { locale }), value: String(stats.totalStayed), inline: true },
        { name: m.b5_invites_field_lost({}, { locale }), value: String(stats.totalLeft), inline: true },
        { name: m.b5_invites_field_retention({}, { locale }), value: `${retentionRate}%`, inline: false }
      )
      .setFooter({ text: m.b5_invites_footer({ user: interaction.user.username }, { locale }) })
      .setTimestamp();

    // Ajouter les 5 dernières invitations
    const recentInvites = await prisma.memberInvite.findMany({
      where: { guildId, inviterId: targetUser.id },
      orderBy: { joinedAt: 'desc' },
      take: 5,
    });

    if (recentInvites.length > 0) {
      const list = recentInvites.map(inv => {
        const date = `<t:${Math.floor(inv.joinedAt.getTime() / 1000)}:d>`;
        const status = inv.leftAt ? m.b5_invites_status_left({}, { locale }) : m.b5_invites_status_present({}, { locale });
        return `• <@${inv.userId}> (${date}) - ${status}`;
      }).join('\n');

      embed.addFields({ name: m.b5_invites_field_recent({}, { locale }), value: list, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
  } else if (subcommand === 'leaderboard') {
    const leaderboard = await getInviteLeaderboard(guildId);

    if (leaderboard.length === 0) {
      await interaction.editReply({
        content: m.b5_invites_leaderboard_empty({}, { locale }),
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(m.b5_invites_leaderboard_title({}, { locale }))
      .setDescription(m.b5_invites_leaderboard_intro({}, { locale }))
      .setTimestamp();

    const list = leaderboard.map((s, i) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      return m.b5_invites_leaderboard_line({ rank, tag: s.inviterTag, stayed: s.totalStayed, joined: s.totalJoined, left: s.totalLeft }, { locale });
    }).join('\n');

    embed.addFields({ name: m.b5_invites_top10({}, { locale }), value: list });

    await interaction.editReply({ embeds: [embed] });
  }
}

export const invitesCommand = { data, execute } satisfies SlashCommandDefinition;
