import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { COLORS_RAW, kotboContainer } from '../../utils/embeds.js';
import { E, buildProgressBar } from '../../utils/emojis.js';
import { getPulseDashboardData } from '../../services/analytics/pulseService.js';
import { ContainerChild, separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c1_pulse');

function scoreColor(score: number): number {
  if (score >= 75) return COLORS_RAW.success;
  if (score >= 50) return COLORS_RAW.primary;
  if (score >= 30) return COLORS_RAW.warning;
  return COLORS_RAW.danger;
}

function trendLabel(trend: string, delta: number, locale: 'fr' | 'en'): string {
  if (trend === 'UP') return `${E.success} +${delta} ${m.c1_pulse_pts({}, { locale })}`;
  if (trend === 'DOWN') return `${E.error} ${delta} ${m.c1_pulse_pts({}, { locale })}`;
  return `${E.dot} ${m.c1_pulse_stable({}, { locale })}`;
}

function scoreBar(label: string, score: number): string {
  return `${E.dot} **${label}** · ${buildProgressBar(score, 8)} \`${score}/100\``;
}

const ALERT_ICONS: Record<string, string> = {
  danger: E.error,
  warning: E.warning,
  success: E.success,
};

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const locale = await getEffectiveLocale(interaction);

  const guildId = interaction.guildId;
  if (!guildId) return;

  const pulse = await getPulseDashboardData(guildId);
  const { current, metrics } = pulse;

  const localeTag = locale === 'fr' ? 'fr-FR' : 'en-US';

  const fields: ContainerChild[] = [
    separator({ divider: true, spacing: 'small' }),
    [
      `**${m.c1_pulse_global_score({}, { locale })}** · **${current.score}**/100 ${trendLabel(current.trend, current.trendDelta, locale)}`,
      '',
      scoreBar(m.c1_pulse_activity({}, { locale }), current.activityScore),
      scoreBar(m.c1_pulse_engagement({}, { locale }), current.engagementScore),
      scoreBar(m.c1_pulse_growth({}, { locale }), current.growthScore),
      scoreBar(m.c1_pulse_moderation({}, { locale }), current.moderationScore),
      scoreBar(m.c1_pulse_health({}, { locale }), current.healthScore),
    ].join('\n'),
    separator({ divider: true, spacing: 'small' }),
    [
      `**${E.messages} ${m.c1_pulse_today_metrics({}, { locale })}**`,
      `${E.dot} ${m.c1_pulse_messages({}, { locale })}: **${metrics.totalMessages.toLocaleString(localeTag)}** · ${m.c1_pulse_voice({}, { locale })}: **${metrics.totalVoiceMinutes.toLocaleString(localeTag)} ${m.c1_pulse_min({}, { locale })}**`,
      `${E.dot} ${m.c1_pulse_active_members({}, { locale })}: **${metrics.activeMembers}**/${metrics.totalMembers}`,
      `${E.dot} ${m.c1_pulse_joins({}, { locale })}: **+${metrics.membersJoined}** · ${m.c1_pulse_leaves({}, { locale })}: **-${metrics.membersLeft}**`,
      `${E.dot} ${m.c1_pulse_sanctions({}, { locale })}: **${metrics.sanctionsCount}** · ${m.c1_pulse_tickets({}, { locale })}: ${E.success} **${metrics.ticketsResolved}** / ${E.clock} **${metrics.ticketsOpen}**`,
      `${E.dot} ${m.c1_pulse_channels({}, { locale })}: ${E.online} **${metrics.channelsHealthy}** ${m.c1_pulse_healthy({}, { locale })} · ${E.dnd} **${metrics.channelsUnhealthy}** ${m.c1_pulse_to_watch({}, { locale })}`,
    ].join('\n'),
  ];

  if (current.alerts.length > 0) {
    const alertLines = current.alerts.map((a) => {
      const icon = ALERT_ICONS[a.severity] ?? E.info;
      return `${icon} ${a.message}`;
    });
    fields.push(
      separator({ divider: true, spacing: 'small' }),
      `**${E.warning} ${m.c1_pulse_alerts({}, { locale })}**\n${alertLines.join('\n')}`,
    );
  }

  await interaction.editReply(v2Message(
    kotboContainer({
      color: scoreColor(current.score),
      title: `${E.stats} ${m.c1_pulse_dashboard_title({}, { locale })}`,
      fields,
      footerTitle: 'Pulse',
    }),
  ));
}

export const pulseCommand = { data, execute } satisfies SlashCommandDefinition;
