import type { SlashCommandDefinition } from '../../commands.js';
import { MessageFlags, SlashCommandBuilder, AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { generateMemberStatsImage } from '../../services/core/imageService.js';
import { kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { mediaGallery, v2Message } from '@arcscord/components';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription("📊 Affiche les statistiques d'activité d'un membre")
  .addUserOption((option) =>
    option.setName('membre').setDescription('Membre à afficher (par défaut: toi)').setRequired(false),
  )
  .addIntegerOption((option) =>
    option
      .setName('periode')
      .setDescription('Période en jours (défaut: 30)')
      .setRequired(false)
      .addChoices(
        { name: '7 jours', value: 7 },
        { name: '30 jours', value: 30 },
        { name: '90 jours', value: 90 },
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: `${E.error} ${m.b2_guild_only_short({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply();

  const targetUser = interaction.options.getUser('membre') ?? interaction.user;
  const periodDays = interaction.options.getInteger('periode') ?? 30;

  const now = new Date();
  const startDate = new Date();
  startDate.setDate(now.getDate() - periodDays);
  const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

  const dailyStats = await prisma.memberDailyStat.findMany({
    where: { guildId, userId: targetUser.id, dateKey: { gte: startDateKey } },
    orderBy: { dateKey: 'asc' },
  });

  const totalMessages = dailyStats.reduce((sum, d) => sum + d.messagesCount, 0);
  const totalVoice = dailyStats.reduce((sum, d) => sum + d.voiceMinutes, 0);
  const activeDays = dailyStats.length;
  const peakDayMessages = Math.max(0, ...dailyStats.map(d => d.messagesCount));

  const imageBuffer = await generateMemberStatsImage(
    targetUser.username,
    periodDays,
    { totalMessages, totalVoice, activeDays, peakDayMessages },
    dailyStats.map(d => ({ date: d.dateKey, messages: d.messagesCount, voice: d.voiceMinutes })),
  );

  const attachment = new AttachmentBuilder(imageBuffer, { name: 'stats.png' });

  await interaction.editReply({
    ...v2Message(
      kotboContainer({
        color: 'primary',
        fields: [
          mediaGallery({ items: [{ media: { url: 'attachment://stats.png' } }] }),
          `-# ${m.b2_stats_footer({ user: interaction.user.username }, { locale })}`,
        ],
      }),
    ),
    files: [attachment],
  });
}

export const statsCommand = { data, execute } satisfies SlashCommandDefinition;
