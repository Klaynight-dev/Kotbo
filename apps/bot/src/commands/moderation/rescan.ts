import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { infoEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { scanGuildMembersForYoungAccounts } from '../../services/moderation/dcDetectionService.js';
import { scanAndModeratePseudos } from '../../services/moderation/nicknameModerationService.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('rescan')
  .setDescription('Scanner les membres du serveur.')
  // ──────────────────────────────────────────────────────────────────────────
  // Sous-groupe : dc (comptes récents)
  // ──────────────────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('dc')
      .setDescription('Scanner les comptes Discord récents.')
      .addSubcommand((sub) =>
        sub
          .setName('scan')
          .setDescription("Signaler les membres dont le compte est trop récent à l'arrivée.")
          .addIntegerOption((opt) =>
            opt
              .setName('seuil_jours')
              .setDescription('Nombre de jours maximum entre création du compte et arrivée')
              .setMinValue(1)
              .setMaxValue(30)
              .setRequired(false)
          )
      )
  )
  // ──────────────────────────────────────────────────────────────────────────
  // Sous-groupe : pseudo (modération des pseudos)
  // ──────────────────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('pseudo')
      .setDescription('Modération des pseudos.')
      .addSubcommand((sub) =>
        sub
          .setName('rescan')
          .setDescription('Scanner et modérer tous les pseudos non conformes du serveur.')
      )
  )
  // ──────────────────────────────────────────────────────────────────────────
  // Sous-groupe : stats (reconstruction des statistiques)
  // ──────────────────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('stats')
      .setDescription('Reconstruire ou lancer les statistiques historiques.')
      .addSubcommand((sub) =>
        sub
          .setName('rescan')
          .setDescription("Scrapper l'historique des messages pour initialiser les statistiques.")
          .addBooleanOption((opt) =>
            opt
              .setName('forcer')
              .setDescription('Forcer le re-scrap complet de tous les salons (recommencer à zéro)')
              .setRequired(false)
          )
      )
  );

// ---------------------------------------------------------------------------
// Vérification des permissions
// ---------------------------------------------------------------------------

async function canUseModerationTools(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) return false;

  const isStaffDb = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId: guild.id, userId: interaction.user.id } },
  });
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;

  return isAdmin || !!isStaffDb || (interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) ?? false);
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) {
    return interaction.reply({
      content: m.b4_rescan_guild_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
  }

  if (!(await canUseModerationTools(interaction))) {
    return interaction.reply({
      content: m.b4_rescan_no_permission({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
  }

  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  // ──────────────────────────────────────────────────────────────────────────
  // /rescan dc scan
  // ──────────────────────────────────────────────────────────────────────────
  if (group === 'dc' && sub === 'scan') {
    const thresholdDays = interaction.options.getInteger('seuil_jours') ?? 3;
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const result = await scanGuildMembersForYoungAccounts(guild, thresholdMs);
    const preview = result.matches
      .slice(0, 10)
      .map((mt) => m.b4_rescan_dc_preview_line({ userId: mt.userId, ageLabel: mt.accountAgeLabel }, { locale }))
      .join('\n');

    const summaryLines: string[] = [
      m.b4_rescan_members_analyzed({ count: result.scannedCount }, { locale }),
      m.b4_rescan_members_flagged({ count: result.flaggedCount }, { locale }),
      m.b4_rescan_dc_threshold({ days: thresholdDays, dayWord: thresholdDays > 1 ? m.b4_rescan_days({}, { locale }) : m.b4_rescan_day({}, { locale }) }, { locale }),
    ];

    if (result.flaggedCount > 0) {
      summaryLines.push('');
      summaryLines.push(m.b4_rescan_dc_first_flags({}, { locale }));
      summaryLines.push(preview);
      if (result.matches.length > 10) {
        summaryLines.push(m.b4_rescan_and_others({ count: result.matches.length - 10 }, { locale }));
      }
    }

    return interaction.editReply({
      embeds: [infoEmbed(m.b4_rescan_dc_done_title({}, { locale }), summaryLines.join('\n'))],
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // /rescan pseudo rescan
  // ──────────────────────────────────────────────────────────────────────────
  if (group === 'pseudo' && sub === 'rescan') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const result = await scanAndModeratePseudos(guild);

    const summaryLines: string[] = [
      m.b4_rescan_members_analyzed({ count: result.scannedCount }, { locale }),
      m.b4_rescan_pseudo_moderated({ count: result.renamedCount }, { locale }),
      m.b4_rescan_pseudo_skipped({ count: result.skippedCount }, { locale }),
    ];

    if (result.errorCount > 0) {
      summaryLines.push(m.b4_rescan_errors_line({ count: result.errorCount }, { locale }));
    }

    if (result.renamedCount > 0) {
      summaryLines.push('');
      summaryLines.push(m.b4_rescan_pseudo_moderated_header({}, { locale }));
      const preview = result.renamed
        .slice(0, 10)
        .map((r) => `• <@${r.userId}> — \`${r.original}\``)
        .join('\n');
      summaryLines.push(preview);
      if (result.renamed.length > 10) {
        summaryLines.push(m.b4_rescan_and_others({ count: result.renamed.length - 10 }, { locale }));
      }
    }

    const embed =
      result.renamedCount > 0
        ? successEmbed(m.b4_rescan_pseudo_done_title({}, { locale }), summaryLines.join('\n'))
        : infoEmbed(m.b4_rescan_pseudo_done_title({}, { locale }), summaryLines.join('\n'));

    return interaction.editReply({ embeds: [embed] });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // /rescan stats rescan
  // ──────────────────────────────────────────────────────────────────────────
  if (group === 'stats' && sub === 'rescan') {
    const force = interaction.options.getBoolean('forcer') ?? false;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const { startHistoricalScraping } = await import('../../services/analytics/messageScraperService.js');
      await startHistoricalScraping(interaction.client, guild.id, force);

      return interaction.editReply({
        embeds: [
          successEmbed(
            m.b4_rescan_stats_started_title({}, { locale }),
            m.b4_rescan_stats_started_desc({ forced: force ? m.b4_rescan_stats_forced_yes({}, { locale }) : m.b4_rescan_stats_forced_no({}, { locale }) }, { locale })
          ),
        ],
      });
    } catch (err) {
      console.error('Error starting historical scraping:', err);
      return interaction.editReply({
        embeds: [
          errorEmbed(
            m.b4_error({}, { locale }),
            m.b4_rescan_stats_error({ error: err instanceof Error ? err.message : String(err) }, { locale })
          ),
        ],
      });
    }
  }
}

export const rescanCommand = { data, execute } satisfies SlashCommandDefinition;
