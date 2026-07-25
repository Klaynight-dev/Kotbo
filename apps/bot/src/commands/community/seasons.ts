import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E, rankEmoji, buildProgressBar } from '../../utils/emojis.js';
import { getAllSeasons, getSeasonLeaderboard } from '../../services/progression/seasonService.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { ContainerChild, separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function statusMap(locale: 'fr' | 'en'): Record<string, { icon: string; label: string }> {
  return {
    ACTIVE: { icon: E.online, label: m.c4_seasons_status_active({}, { locale }) },
    UPCOMING: { icon: E.idle, label: m.c4_seasons_status_upcoming({}, { locale }) },
    ENDED: { icon: E.offline, label: m.c4_seasons_status_ended({}, { locale }) },
  };
}

const meta = getCommandMetadata('c4_seasons');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription(m.c4_seasons_list_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_seasons_list_desc({}, { locale: 'fr' }) }))
  .addSubcommand((sub) =>
    sub.setName('current')
      .setDescription(m.c4_seasons_current_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_seasons_current_desc({}, { locale: 'fr' }) }))
  .addSubcommand((sub) =>
    sub.setName('leaderboard')
      .setDescription(m.c4_seasons_leaderboard_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_seasons_leaderboard_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) => opt.setName('saison').setDescription(m.c4_seasons_opt_saison({}, { locale: 'en' })).setDescriptionLocalizations({ fr: m.c4_seasons_opt_saison({}, { locale: 'fr' }) }).setRequired(true)));

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);
  const STATUS_MAP = statusMap(locale);

  if (subcommand === 'list') {
    await interaction.deferReply();
    const seasons = await getAllSeasons(guildId);

    if (seasons.length === 0) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title: `${E.trophy} ${m.c4_seasons_title({}, { locale })}`,
          fields: [
            `${E.info} ${m.c4_seasons_none({}, { locale })}`
          ],
          footerTitle: m.c4_seasons_title({}, { locale })
        })
      ));
      return;
    }

    const lines = seasons.map((s) => {
      const status = STATUS_MAP[s.status] ?? { icon: E.dot, label: s.status };
      const snapCount = s._count?.snapshots ?? 0;
      const participants = snapCount > 0 ? ` · ${m.c4_seasons_participants({ count: snapCount }, { locale })}` : '';
      return `${status.icon} **${m.c4_seasons_number({ number: s.number }, { locale })}** · ${s.name}\n${E.dot} ${formatDate(s.startDate)} → ${formatDate(s.endDate)} · ${status.label}${participants}`;
    });

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'primary',
        title: `${E.trophy} ${m.c4_seasons_title({}, { locale })}`,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          lines.join('\n\n')
        ],
        footerTitle: m.c4_seasons_footer_count({ count: seasons.length }, { locale })
      })
    ));
  }

  if (subcommand === 'current') {
    await interaction.deferReply();
    const seasons = await getAllSeasons(guildId);
    const active = seasons.find((s) => s.status === 'ACTIVE');

    if (!active) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title: `${E.trophy} ${m.c4_seasons_current_title({}, { locale })}`,
          fields: [
            `${E.info} ${m.c4_seasons_no_active({}, { locale })}`
          ],
          footerTitle: m.c4_seasons_title({}, { locale })
        })
      ));
      return;
    }

    const now = Date.now();
    const start = new Date(active.startDate).getTime();
    const end = new Date(active.endDate).getTime();
    const totalDuration = end - start;
    const elapsed = now - start;
    const progressPct = totalDuration > 0 ? Math.min((elapsed / totalDuration) * 100, 100) : 0;
    const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));

    const lb = await getSeasonLeaderboard(guildId, active.id, 10);

    const fields: ContainerChild[] = [
      separator({ divider: true, spacing: 'small' }),
      [
        `${E.arrow} **${m.c4_seasons_field_period({}, { locale })}** · ${formatDate(active.startDate)} → ${formatDate(active.endDate)}`,
        `${E.arrow} **${m.c4_seasons_field_progress({}, { locale })}** · ${buildProgressBar(progressPct, 8)} \`${Math.round(progressPct)}%\``,
        `${E.arrow} **${m.c4_seasons_field_time_left({}, { locale })}** · ${m.c4_seasons_days_left({ days: daysLeft }, { locale })}`,
      ].join('\n')
    ]

    // add leaderboard if exist
    if (lb.length > 0) {
      const lbLines = lb.map((entry) => {
        const medal = rankEmoji(entry.rank);
        return `${medal} <@${entry.userId}> — Lvl **${entry.level}** · **${entry.xp.toLocaleString('fr-FR')}** ${E.xp}`;
      });

      fields.push(
        separator({ divider: true, spacing: 'small' }),
        `**${E.level} ${m.c4_seasons_field_ranking({}, { locale })}**`,
        lbLines.join('\n')
      )
    }

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'primary',
        title: `${E.trophy} ${m.c4_seasons_number({ number: active.number }, { locale })} · ${active.name}`,
        fields,
        footerTitle: m.c4_seasons_title({}, { locale })
      })
    ));
  }

  if (subcommand === 'leaderboard') {
    const seasonId = interaction.options.getString('saison', true);
    await interaction.deferReply();

    const lb = await getSeasonLeaderboard(guildId, seasonId, 20);

    if (lb.length === 0) {
      await interaction.editReply(v2Message(
        errorContainer(m.c4_seasons_leaderboard_none_title({}, { locale }), m.c4_seasons_leaderboard_none_desc({}, { locale })),
      ));
      return;
    }

    const lines = lb.map((entry) => {
      const medal = rankEmoji(entry.rank);
      return `${medal} <@${entry.userId}> — Lvl **${entry.level}** · **${entry.xp.toLocaleString('fr-FR')}** ${E.xp}`;
    });

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'primary',
        title: `${E.trophy} ${m.c4_seasons_leaderboard_title({}, { locale })}`,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          lines.join('\n')
        ],
        footerTitle: m.c4_seasons_footer_participants({ count: lb.length }, { locale })
      })
    ));
  }
}

export const seasonsCommand = { data, execute } satisfies SlashCommandDefinition;
