import type { SlashCommandDefinition } from '../../commands.js';
import { MessageFlags, SlashCommandBuilder, AttachmentBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { generateLeaderboardImage } from '../../services/core/imageService.js';
import { COLORS_RAW, kotboContainer } from '../../utils/embeds.js';
import { E, rankEmoji, buildProgressBar } from '../../utils/emojis.js';
import { getXpForLevel, getLevelFromXp } from '../../services/progression/levelingService.js';
import { mediaGallery, separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c5_leaderboard');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption((option) =>
    option
      .setName('type')
      .setDescription(m.c5_leaderboard_opt_type({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c5_leaderboard_opt_type({}, { locale: 'fr' }) })
      .setRequired(true)
      .addChoices(
        { name: m.c5_leaderboard_opt_type_choice_messages({}, { locale: 'en' }), value: 'messages' },
        { name: m.c5_leaderboard_opt_type_choice_voice({}, { locale: 'en' }), value: 'voice' },
        { name: m.c5_leaderboard_opt_type_choice_mixed({}, { locale: 'en' }), value: 'mixed' },
        { name: m.c5_leaderboard_opt_type_choice_xp({}, { locale: 'en' }), value: 'xp' },
      ),
  )
  .addStringOption((option) =>
    option
      .setName('style')
      .setDescription(m.c5_leaderboard_opt_style({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c5_leaderboard_opt_style({}, { locale: 'fr' }) })
      .setRequired(false)
      .addChoices(
        { name: m.c5_leaderboard_opt_style_choice_image({}, { locale: 'en' }), value: 'image' },
        { name: m.c5_leaderboard_opt_style_choice_embed({}, { locale: 'en' }), value: 'embed' },
      ),
  )
  .addIntegerOption((option) =>
    option
      .setName('periode')
      .setDescription(m.c5_leaderboard_opt_periode({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c5_leaderboard_opt_periode({}, { locale: 'fr' }) })
      .setRequired(false)
      .addChoices(
        { name: m.c5_leaderboard_opt_periode_choice_7({}, { locale: 'en' }), value: 7 },
        { name: m.c5_leaderboard_opt_periode_choice_30({}, { locale: 'en' }), value: 30 },
        { name: m.c5_leaderboard_opt_periode_choice_90({}, { locale: 'en' }), value: 90 },
      ),
  )
  .addBooleanOption((option) =>
    option
      .setName('auto_refresh')
      .setDescription(m.c5_leaderboard_opt_autorefresh({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c5_leaderboard_opt_autorefresh({}, { locale: 'fr' }) })
      .setRequired(false),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: `${E.error} ${m.c5_guild_only({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply();

  const type = interaction.options.getString('type') as 'messages' | 'voice' | 'mixed' | 'xp';
  const style = (interaction.options.getString('style') as 'image' | 'embed') ?? 'image';
  const periodDays = interaction.options.getInteger('periode') ?? 30;
  const autoRefresh = interaction.options.getBoolean('auto_refresh');

  let topMembers: { userId: string; score: number; level?: number }[] = [];

  if (type === 'xp') {
    const xpStats = await prisma.memberLevel.findMany({
      where: { guildId },
      orderBy: { xp: 'desc' },
      take: 10,
    });
    topMembers = xpStats.map((stat) => ({
      userId: stat.userId,
      score: stat.xp,
      level: getLevelFromXp(stat.xp),
    }));
  } else {
    const now = new Date();
    const startDate = new Date();
    startDate.setDate(now.getDate() - periodDays);
    const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

    const dailyStats = await prisma.memberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: startDateKey } },
      _sum: { messagesCount: true, voiceMinutes: true },
    });

    const sorted = dailyStats.map((stat) => {
      let score = 0;
      if (type === 'messages') score = stat._sum.messagesCount ?? 0;
      else if (type === 'voice') score = stat._sum.voiceMinutes ?? 0;
      else score = (stat._sum.messagesCount ?? 0) + (stat._sum.voiceMinutes ?? 0) * 2;
      return { userId: stat.userId, score };
    }).sort((a, b) => b.score - a.score).slice(0, 10);

    const userIds = sorted.map(m => m.userId);
    const levels = await prisma.memberLevel.findMany({
      where: { guildId, userId: { in: userIds } },
      select: { userId: true, xp: true },
    });
    const levelMap = new Map(levels.map(l => [l.userId, getLevelFromXp(l.xp)]));

    topMembers = sorted.map(m => ({
      ...m,
      level: levelMap.get(m.userId) ?? 0,
    }));
  }

  const discordGuild = interaction.client.guilds.cache.get(guildId);

  const formattedTopMembers = await Promise.all(topMembers.map(async (entry) => {
    let name: string = m.c5_leaderboard_unknown_user({ userId: entry.userId }, { locale });
    let avatarUrl: string | null = null;
    try {
      const member = await discordGuild?.members.fetch(entry.userId).catch(() => null);
      if (member) {
        name = member.displayName;
        avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 64 });
      }
    } catch { /* ignore */ }
    return { name, score: entry.score, avatarUrl, level: entry.level };
  }));

  const themeColor = type === 'messages' ? COLORS_RAW.primary : type === 'voice' ? COLORS_RAW.success : type === 'xp' ? COLORS_RAW.pink : COLORS_RAW.warning;
  const typeLabel = type === 'messages'
    ? m.c5_leaderboard_type_messages({}, { locale })
    : type === 'voice'
      ? m.c5_leaderboard_type_voice({}, { locale })
      : type === 'xp'
        ? m.c5_leaderboard_type_xp({}, { locale })
        : m.c5_leaderboard_type_mixed({}, { locale });
  const subTitle = type === 'xp'
    ? m.c5_leaderboard_subtitle_xp({}, { locale })
    : m.c5_leaderboard_subtitle_period({ days: periodDays }, { locale });

  if (style === 'embed') {
    const serverName = discordGuild?.name ?? m.c5_leaderboard_guild_fallback({}, { locale });

    let description = `**${serverName}**\n`;

    for (let i = 0; i < formattedTopMembers.length; i++) {
      const member = formattedTopMembers[i];
      const rank = i + 1;

      if (type === 'xp') {
        const userLevel = member.level ?? 0;
        const prevXpNeeded = getXpForLevel(userLevel - 1);
        const nextXpNeeded = getXpForLevel(userLevel);
        const xpInCurrentLevel = member.score - prevXpNeeded;
        const xpRequiredForNextLevel = nextXpNeeded - prevXpNeeded || 300;
        const percent = Math.min(100, Math.max(0, Math.round((xpInCurrentLevel / xpRequiredForNextLevel) * 100)));
        const bar = buildProgressBar(percent, 8);
        description += `\n${rankEmoji(rank)} **[${m.c5_leaderboard_level_tag({ level: userLevel }, { locale })}]** ${member.name}\n${bar} \`${percent}%\``;
      } else {
        const maxScore = formattedTopMembers[0].score || 1;
        const percent = Math.min(100, Math.max(0, Math.round((member.score / maxScore) * 100)));
        const bar = buildProgressBar(percent, 8);
        const scoreFmt = type === 'voice' ? `${Math.floor(member.score / 60)}h ${member.score % 60}m` : member.score.toLocaleString('fr-FR');
        description += `\n${rankEmoji(rank)} ${member.name}\n${bar} \`${scoreFmt}\``;
      }
    }

    await interaction.editReply(v2Message(
      kotboContainer({
        color: themeColor,
        title: `${E.trophy} ${m.c5_leaderboard_top10_title({ type: typeLabel }, { locale })}`,
        fields: [
          `-# ${subTitle}`,
          separator({ divider: true, spacing: 'small' }),
          description,
        ],
        footerOverwrite: `-# ${m.c5_leaderboard_footer({ user: interaction.user.username }, { locale })}`,
      }),
    ));
  } else {
    const imageBuffer = await generateLeaderboardImage(formattedTopMembers, type, periodDays);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'leaderboard.png' });

    await interaction.editReply({
      ...v2Message(
        kotboContainer({
          color: themeColor,
          fields: [
            mediaGallery({ items: [{ media: { url: 'attachment://leaderboard.png' } }] }),
            `-# ${m.c5_leaderboard_footer({ user: interaction.user.username }, { locale })}`,
          ],
        }),
      ),
      files: [attachment],
    });
  }

  if (autoRefresh !== null) {
    const memberPerms = interaction.memberPermissions;
    if (!memberPerms?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.followUp({
        content: `${E.error} ${m.c5_leaderboard_perm_denied({}, { locale })}`,
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    if (autoRefresh) {
      const reply = await interaction.fetchReply();
      await prisma.autoLeaderboard.upsert({
        where: { guildId_channelId_type: { guildId, channelId: interaction.channelId, type } },
        create: {
          guildId,
          channelId: interaction.channelId,
          messageId: reply.id,
          type,
          style,
          periodDays,
          enabled: true,
        },
        update: {
          messageId: reply.id,
          style,
          periodDays,
          enabled: true,
        },
      });
      await interaction.followUp({
        content: `${E.success} ${m.c5_leaderboard_autorefresh_enabled({ type }, { locale })}`,
        flags: [MessageFlags.Ephemeral],
      });
    } else {
      await prisma.autoLeaderboard.deleteMany({
        where: { guildId, channelId: interaction.channelId, type },
      });
      await interaction.followUp({
        content: `${E.success} ${m.c5_leaderboard_autorefresh_disabled({ type }, { locale })}`,
        flags: [MessageFlags.Ephemeral],
      });
    }
  }
}

export const leaderboardCommand = { data, execute } satisfies SlashCommandDefinition;
