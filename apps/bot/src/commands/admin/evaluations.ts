import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { COLORS_RAW, errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E, buildProgressBar } from '../../utils/emojis.js';
import {
  generateStaffEvaluation,
  getStaffEvaluations,
  getEvaluationsDashboardData,
} from '../../services/staff/staffEvaluationService.js';
import { getStaffMember } from '../../services/staff/staffManagementService.js';
import { ContainerChild, separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

function formatDate(date: Date | string | null | undefined, locale: 'fr' | 'en'): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function trendIcon(trend: string, delta: number, locale: 'fr' | 'en'): string {
  if (trend === 'UP') return `${E.success} +${delta}`;
  if (trend === 'DOWN') return `${E.error} ${delta}`;
  return `${E.dot} ${m.c2_evaluations_trend_stable({}, { locale })}`;
}

function scoreColor(score: number): number {
  if (score >= 75) return COLORS_RAW.success;
  if (score >= 50) return COLORS_RAW.primary;
  if (score >= 30) return COLORS_RAW.warning;
  return COLORS_RAW.danger;
}

const meta = getCommandMetadata('c2_evaluations');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub.setName('me')
      .setDescription(m.c2_evaluations_sub_me_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c2_evaluations_sub_me_desc({}, { locale: 'fr' }) }))
  .addSubcommand((sub) =>
    sub.setName('check')
      .setDescription(m.c2_evaluations_sub_check_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c2_evaluations_sub_check_desc({}, { locale: 'fr' }) })
      .addUserOption((opt) => opt.setName('membre')
        .setDescription(m.c2_evaluations_opt_membre_desc({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c2_evaluations_opt_membre_desc({}, { locale: 'fr' }) })
        .setRequired(true)))
  .addSubcommand((sub) =>
    sub.setName('generate')
      .setDescription(m.c2_evaluations_sub_generate_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c2_evaluations_sub_generate_desc({}, { locale: 'fr' }) })
      .addUserOption((opt) => opt.setName('membre')
        .setDescription(m.c2_evaluations_opt_membre_desc({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c2_evaluations_opt_membre_desc({}, { locale: 'fr' }) })
        .setRequired(true))
      .addIntegerOption((opt) => opt.setName('periode')
        .setDescription(m.c2_evaluations_opt_periode_desc({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c2_evaluations_opt_periode_desc({}, { locale: 'fr' }) })
        .setMinValue(7).setMaxValue(90)))
  .addSubcommand((sub) =>
    sub.setName('overview')
      .setDescription(m.c2_evaluations_sub_overview_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c2_evaluations_sub_overview_desc({}, { locale: 'fr' }) }));

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);

  if (subcommand === 'me' || subcommand === 'check') {
    const targetUser = subcommand === 'check'
      ? interaction.options.getUser('membre', true)
      : interaction.user;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const staffMember = await getStaffMember(guildId, interaction.user.id);
    const hasAdminPerm = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      || interaction.guild?.ownerId === interaction.user.id;

    if (!staffMember && !hasAdminPerm) {
      await interaction.editReply(v2Message(
        errorContainer(m.c2_evaluations_access_denied_title({}, { locale }), m.c2_evaluations_access_denied_staff_only({}, { locale })),
      ));
      return;
    }

    const evaluations = await getStaffEvaluations(guildId, targetUser.id);

    if (evaluations.length === 0) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title: `${E.stats} ${m.c2_evaluations_list_title_user({ username: targetUser.username }, { locale })}`,
          fields: [`${E.info} ${m.c2_evaluations_none_desc({}, { locale })}`],
          footerTitle: m.c2_evaluations_footer({}, { locale }),
        }),
      ));
      return;
    }

    const latest = evaluations[0];

    const fields: ContainerChild[] = [
      separator({ divider: true, spacing: 'small' }),
      [
        `**${m.c2_evaluations_label_score_global({}, { locale })}** · **${latest.overallScore}**/100 ${trendIcon(latest.trend, latest.trendDelta, locale)}`,
        '',
        `${E.dot} **${m.c2_evaluations_label_activity({}, { locale })}** · ${buildProgressBar(latest.activityScore, 8)} \`${latest.activityScore}/100\``,
        `${E.dot} **${m.c2_evaluations_label_moderation({}, { locale })}** · ${buildProgressBar(latest.moderationScore, 8)} \`${latest.moderationScore}/100\``,
        `${E.dot} **${m.c2_evaluations_label_presence({}, { locale })}** · ${buildProgressBar(latest.presenceScore, 8)} \`${latest.presenceScore}/100\``,
      ].join('\n'),
      separator({ divider: true, spacing: 'small' }),
      [
        `**${E.messages} ${m.c2_evaluations_label_details({}, { locale })}** · ${formatDate(latest.periodStart, locale)} → ${formatDate(latest.periodEnd, locale)}`,
        `${E.dot} ${m.c2_evaluations_msg_voice({ messages: latest.totalMessages.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US'), voice: latest.totalVoiceMinutes.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US') }, { locale })}`,
        `${E.dot} ${m.c2_evaluations_sanctions_tickets({ sanctions: latest.sanctionsHandled, tickets: latest.ticketsResolved }, { locale })}`,
        `${E.dot} ${m.c2_evaluations_meetings_absences({ attended: latest.meetingsAttended, total: latest.meetingsTotal, absence: latest.absenceDays }, { locale })}`,
      ].join('\n'),
    ];

    if (latest.managerNote) {
      fields.push(
        separator({ divider: true, spacing: 'small' }),
        `**${E.info} ${m.c2_evaluations_label_manager_note({}, { locale })}**\n${latest.managerNote}`,
      );
    }

    if (evaluations.length > 1) {
      const history = evaluations.slice(1, 4).map((ev) =>
        `${E.dot} ${formatDate(ev.periodEnd, locale)} · **${ev.overallScore}**/100 ${trendIcon(ev.trend, ev.trendDelta, locale)}`
      );
      fields.push(
        separator({ divider: true, spacing: 'small' }),
        `**${E.calendar} ${m.c2_evaluations_label_history({}, { locale })}**\n${history.join('\n')}`,
      );
    }

    await interaction.editReply(v2Message(
      kotboContainer({
        color: scoreColor(latest.overallScore),
        title: `${E.stats} ${m.c2_evaluations_profile_title({ username: targetUser.username }, { locale })}`,
        titleThumbnail: { url: targetUser.displayAvatarURL() },
        fields,
        footerTitle: m.c2_evaluations_footer_count({ count: evaluations.length }, { locale }),
      }),
    ));
  }

  if (subcommand === 'generate') {
    const targetUser = interaction.options.getUser('membre', true);
    const periodDays = interaction.options.getInteger('periode') ?? 30;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const staffMember = await getStaffMember(guildId, interaction.user.id);
    const hasAdminPerm = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      || interaction.guild?.ownerId === interaction.user.id;
    const isStaffAdmin = staffMember && ['ADMIN', 'OWNER'].includes(staffMember.grade);

    if (!isStaffAdmin && !hasAdminPerm) {
      await interaction.editReply(v2Message(
        errorContainer(m.c2_evaluations_access_denied_title({}, { locale }), m.c2_evaluations_admin_only_generate({}, { locale })),
      ));
      return;
    }

    const evaluation = await generateStaffEvaluation(guildId, targetUser.id, periodDays);

    await interaction.editReply(v2Message(
      kotboContainer({
        color: scoreColor(evaluation.overallScore),
        title: `${E.success} ${m.c2_evaluations_generated_title({}, { locale })}`,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          [
            `${E.arrow} ${m.c2_evaluations_gen_member_line({ username: targetUser.username }, { locale })}`,
            `${E.arrow} ${m.c2_evaluations_gen_period_line({ days: periodDays }, { locale })}`,
            `${E.arrow} ${m.c2_evaluations_gen_score_line({ score: evaluation.overallScore }, { locale })} ${trendIcon(evaluation.trend, evaluation.trendDelta, locale)}`,
            '',
            `${E.dot} ${m.c2_evaluations_gen_scores_summary({ activity: evaluation.activityScore, moderation: evaluation.moderationScore, presence: evaluation.presenceScore }, { locale })}`,
          ].join('\n'),
        ],
        footerTitle: m.c2_evaluations_footer({}, { locale }),
      }),
    ));
  }

  if (subcommand === 'overview') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const staffMember = await getStaffMember(guildId, interaction.user.id);
    const hasAdminPerm = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      || interaction.guild?.ownerId === interaction.user.id;
    const isStaffAdmin = staffMember && ['ADMIN', 'OWNER'].includes(staffMember.grade);

    if (!isStaffAdmin && !hasAdminPerm) {
      await interaction.editReply(v2Message(
        errorContainer(m.c2_evaluations_access_denied_title({}, { locale }), m.c2_evaluations_admin_only_overview({}, { locale })),
      ));
      return;
    }

    const data = await getEvaluationsDashboardData(guildId);

    if (data.latestByStaff.length === 0) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title: `${E.stats} ${m.c2_evaluations_overview_title_short({}, { locale })}`,
          fields: [`${E.info} ${m.c2_evaluations_overview_none({}, { locale })}`],
          footerTitle: m.c2_evaluations_footer({}, { locale }),
        }),
      ));
      return;
    }

    const staffMap = new Map(data.staffMembers.map((s) => [s.userId, s.displayName]));

    const lines = data.latestByStaff
      .sort((a, b) => b.overallScore - a.overallScore)
      .map((ev, i) => {
        const name = staffMap.get(ev.staffUserId) ?? ev.staffUserId;
        const bar = buildProgressBar(ev.overallScore, 6);
        return `**${i + 1}.** ${bar} \`${ev.overallScore}\` · ${name} ${trendIcon(ev.trend, ev.trendDelta, locale)}`;
      });

    await interaction.editReply(v2Message(
      kotboContainer({
        color: scoreColor(data.averageScore),
        title: `${E.stats} ${m.c2_evaluations_overview_title({}, { locale })}`,
        fields: [
          m.c2_evaluations_avg_score_line({ avg: data.averageScore }, { locale }),
          separator({ divider: true, spacing: 'small' }),
          lines.join('\n'),
        ],
        footerTitle: m.c2_evaluations_overview_footer({ count: data.latestByStaff.length }, { locale }),
      }),
    ));
  }
}

export const evaluationsCommand = { data, execute } satisfies SlashCommandDefinition;
