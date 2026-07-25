import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { successContainer, kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import {
  analyzeGuildChannelHealth,
  upsertChannelHealthConfig,
} from '../../services/analytics/channelHealthService.js';
import { separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('channelhealth')
  .setDescription('Gestion du moniteur de santé des salons')
  .addSubcommand(sub =>
    sub
      .setName('analyse')
      .setDescription('Lance une analyse de santé des salons'),
  )
  .addSubcommand(sub =>
    sub
      .setName('activer')
      .setDescription('Active le moniteur de santé des salons')
      .addChannelOption(opt =>
        opt
          .setName('salon-alertes')
          .setDescription('Salon pour recevoir les rapports')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('desactiver')
      .setDescription('Désactive le moniteur de santé des salons'),
  )
  .addSubcommand(sub =>
    sub
      .setName('config')
      .setDescription('Configure les seuils du moniteur')
      .addStringOption(opt =>
        opt
          .setName('mode-split')
          .setDescription('Mode pour les salons surchargés')
          .addChoices(
            { name: 'Notification seulement', value: 'NOTIFY' },
            { name: 'Automatique', value: 'AUTO' },
          )
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('mode-archive')
          .setDescription('Mode pour les salons morts')
          .addChoices(
            { name: 'Notification seulement', value: 'NOTIFY' },
            { name: 'Automatique', value: 'AUTO' },
          )
          .setRequired(false),
      )
      .addIntegerOption(opt =>
        opt
          .setName('periode')
          .setDescription("Période d'analyse en jours (7-90)")
          .setMinValue(7)
          .setMaxValue(90)
          .setRequired(false),
      ),
  );

const STATUS_ICONS: Record<string, string> = {
  HEALTHY: E.online,
  OVERLOADED: E.dnd,
  UNDERUSED: E.idle,
  DEAD: E.offline,
};

function statusLabel(status: string, locale: 'fr' | 'en'): string {
  switch (status) {
    case 'HEALTHY':
      return m.b4_ch_status_healthy({}, { locale });
    case 'OVERLOADED':
      return m.b4_ch_status_overloaded({}, { locale });
    case 'UNDERUSED':
      return m.b4_ch_status_underused({}, { locale });
    case 'DEAD':
      return m.b4_ch_status_dead({}, { locale });
    default:
      return status;
  }
}

function trendIcon(trend: string): string {
  if (trend === 'UP') return `${E.success}`;
  if (trend === 'DOWN') return `${E.error}`;
  return `${E.dot}`;
}

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (subcommand === 'analyse') {
    await interaction.deferReply();

    const summary = await analyzeGuildChannelHealth(interaction.client, guildId);

    if (!summary || summary.channels.length === 0) {
      await interaction.editReply(v2Message(
        successContainer(m.b4_ch_analysis_title({}, { locale }), m.b4_ch_no_data({}, { locale })),
      ));
      return;
    }

    const statusCounts = {
      HEALTHY: summary.healthy.length,
      OVERLOADED: summary.overloaded.length,
      UNDERUSED: summary.underused.length,
      DEAD: summary.dead.length,
    };

    const fields = [
      separator({ divider: true, spacing: 'small' }),
      `**${m.b4_ch_summary({}, { locale })}**\n` +
        Object.entries(statusCounts)
          .map(([status, count]) => `${STATUS_ICONS[status]} **${statusLabel(status, locale)}**: ${count}`)
          .join(' · '),
    ];

    if (summary.overloaded.length > 0) {
      fields.push(
        separator({ divider: true, spacing: 'small' }),
        `**${E.dnd} ${m.b4_ch_overloaded_header({}, { locale })}**\n` +
          summary.overloaded
            .slice(0, 5)
            .map(c => `${E.dot} <#${c.channelId}> — ${c.avgMsgPerDay.toFixed(0)} ${m.b4_ch_unit_msgday({}, { locale })}, ${c.uniqueUsersAvg.toFixed(0)} ${m.b4_ch_unit_users({}, { locale })} (${c.confidence}%)`)
            .join('\n'),
      );
    }

    if (summary.dead.length > 0) {
      fields.push(
        separator({ divider: true, spacing: 'small' }),
        `**${E.offline} ${m.b4_ch_dead_header({}, { locale })}**\n` +
          summary.dead
            .slice(0, 5)
            .map(c => `${E.dot} <#${c.channelId}> — ${c.avgMsgPerDay.toFixed(2)} ${m.b4_ch_unit_msgday({}, { locale })}`)
            .join('\n'),
      );
    }

    if (summary.underused.length > 0) {
      fields.push(
        separator({ divider: true, spacing: 'small' }),
        `**${E.idle} ${m.b4_ch_underused_header({}, { locale })}**\n` +
          summary.underused
            .slice(0, 5)
            .map(c => `${E.dot} <#${c.channelId}> — ${c.avgMsgPerDay.toFixed(1)} ${m.b4_ch_unit_msgday({}, { locale })}, ${c.uniqueUsersAvg.toFixed(0)} ${m.b4_ch_unit_users({}, { locale })}`)
            .join('\n'),
      );
    }

    const topChannels = summary.channels.slice(0, 5);
    fields.push(
      separator({ divider: true, spacing: 'small' }),
      `**${E.trophy} ${m.b4_ch_top_header({}, { locale })}**\n` +
        topChannels
          .map((c, i) => `${E.dot} **${i + 1}.** <#${c.channelId}> — ${c.totalMessages} ${m.b4_ch_unit_msg({}, { locale })} ${trendIcon(c.trend)}`)
          .join('\n'),
    );

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'primary',
        title: `${E.stats} ${m.b4_ch_main_title({}, { locale })}`,
        fields,
        footerTitle: m.b4_ch_footer({ days: summary.periodDays, count: summary.channels.length }, { locale }),
      }),
    ));
  } else if (subcommand === 'activer') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const alertChannel = interaction.options.getChannel('salon-alertes');

    await upsertChannelHealthConfig(guildId, {
      enabled: true,
      ...(alertChannel ? { alertChannelId: alertChannel.id } : {}),
    });

    const desc = alertChannel
      ? `Les rapports seront envoyés dans <#${alertChannel.id}>.`
      : 'Configurez un salon d\'alertes avec `/channelhealth config`.';

    await interaction.editReply(v2Message(
      successContainer('Moniteur activé', desc),
    ));
  } else if (subcommand === 'desactiver') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await upsertChannelHealthConfig(guildId, { enabled: false });
    await interaction.editReply(v2Message(
      successContainer('Moniteur désactivé', 'Le moniteur de santé des salons a été désactivé.'),
    ));
  } else if (subcommand === 'config') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const splitMode = interaction.options.getString('mode-split');
    const archiveMode = interaction.options.getString('mode-archive');
    const period = interaction.options.getInteger('periode');

    const updateData: Record<string, unknown> = {};
    if (splitMode) updateData.splitMode = splitMode;
    if (archiveMode) updateData.archiveMode = archiveMode;
    if (period) updateData.analysisPeriodDays = period;

    if (Object.keys(updateData).length === 0) {
      await interaction.editReply(v2Message(
        successContainer('Configuration', 'Aucune modification spécifiée. Utilisez les options de la commande.'),
      ));
      return;
    }

    await upsertChannelHealthConfig(guildId, updateData);

    const changes = [];
    if (splitMode) changes.push(`${E.arrow} **Mode split** · ${splitMode}`);
    if (archiveMode) changes.push(`${E.arrow} **Mode archive** · ${archiveMode}`);
    if (period) changes.push(`${E.arrow} **Période** · ${period} jours`);

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'success',
        title: `${E.settings} Configuration mise à jour`,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          changes.join('\n'),
        ],
        footerTitle: 'Channel Health',
      }),
    ));
  }
}

export const channelhealthCommand = { data, execute } satisfies SlashCommandDefinition;
