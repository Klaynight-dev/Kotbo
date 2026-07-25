import { errorMessage } from '../../utils/errors.js';
import type { ContextCommandDefinition, SlashCommandDefinition } from '../../commands.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  type UserContextMenuCommandInteraction,
  type User,
  type AutocompleteInteraction,
} from 'discord.js';
import { SanctionStatus, SanctionType } from '@prisma/client';
import prisma from '../../utils/db.js';
import { errorEmbed, infoEmbed, successEmbed } from '../../utils/embeds.js';
import {
  countWarns,
  getWarnScore,
  formatDurationFr,
  getSanctionTypeBreakdown,
  listSanctionsByMember,
  parseDurationToMs,
  registerBanSanction,
  registerKickSanction,
  registerTimeoutSanction,
  registerWarnSanction,
  registerSoftbanSanction,
  runGuildBan,
} from '../../services/moderation/sanctionService.js';
import { applyProgressiveSanction, getOrCreateDefaultTables } from '../../services/moderation/sanctionTableService.js';
import { sendBanAppealNotificationDM } from '../../services/moderation/banAppealService.js';
import * as altAccountService from '../../services/moderation/altAccountService.js';
import { buildMemberCaseActionRow } from '../../services/moderation/memberCaseService.js';
import { extractTrackingInfo, resolveModuleFromCommand, wrapModuleTracking } from '../../utils/moduleTracking.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

type Locale = 'fr' | 'en';

const DURATION_HELP = 'Exemples: 30m, 2h, 3j, 1 semaine';
const SANCTION_PAGE_SIZE = 5;
const SANCTION_LIST_TIMEOUT_MS = 2 * 60 * 1000;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';

const data = new SlashCommandBuilder()
  .setName('sanction')
  .setDescription('🛡️ Gère les sanctions (warn, TO, kick, ban, tempban, list)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub
      .setName('warn')
      .setDescription('Ajoute un avertissement à un membre')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à avertir').setRequired(true))
      .addStringOption((option) => option.setName('raison').setDescription('Raison du warn').setRequired(true))
      .addIntegerOption((option) =>
        option
          .setName('gravite')
          .setDescription('Gravité du warn (compte dans le score si la pondération est activée)')
          .setRequired(false)
          .addChoices(
            { name: 'Léger (1 point)', value: 1 },
            { name: 'Normal (2 points)', value: 2 },
            { name: 'Grave (3 points)', value: 3 },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('to')
      .setDescription('Applique un timeout, avec renouvellement auto si nécessaire')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à timeout').setRequired(true))
      .addStringOption((option) => option.setName('duree').setDescription(DURATION_HELP).setRequired(true))
      .addStringOption((option) => option.setName('raison').setDescription('Raison du timeout').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kick')
      .setDescription('Exclut un membre du serveur')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à exclure').setRequired(true))
      .addStringOption((option) => option.setName('raison').setDescription('Raison du kick').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('ban')
      .setDescription('Bannit définitivement un membre')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à bannir').setRequired(true))
      .addStringOption((option) => option.setName('raison').setDescription('Raison du ban').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('tempban')
      .setDescription('Bannit temporairement un membre')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à bannir temporairement').setRequired(true))
      .addStringOption((option) => option.setName('duree').setDescription(DURATION_HELP).setRequired(true))
      .addStringOption((option) => option.setName('raison').setDescription('Raison du tempban').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('softban')
      .setDescription('Bannit puis débannit immédiatement un membre pour supprimer ses messages récents (7 jours)')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à softban').setRequired(true))
      .addStringOption((option) => option.setName('raison').setDescription('Raison du softban').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription("Affiche la liste des sanctions d'un membre")
      .addUserOption((option) => option.setName('membre').setDescription('Membre à afficher').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('tableau')
      .setDescription('Applique une sanction progressive via un tableau de sanction')
      .addUserOption((option) => option.setName('membre').setDescription('Membre à sanctionner').setRequired(true))
      .addStringOption((option) =>
        option
          .setName('nom')
          .setDescription('Nom du tableau de sanction')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName('raison')
          .setDescription('Raison de la sanction')
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName('bypass')
          .setDescription('Forcer un palier spécifique (ex: 3 pour T3) (optionnel)')
          .setRequired(false)
          .setMinValue(1)
          .setAutocomplete(true)
      ),
  );

const contextData = new ContextMenuCommandBuilder()
  .setName('Sanctionner')
  .setType(ApplicationCommandType.User)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

function canModerate(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction): interaction is ChatInputCommandInteraction<'cached'> | UserContextMenuCommandInteraction<'cached'> {
  if (!interaction.inCachedGuild()) return false;
  const me = interaction.guild.members.me;
  return Boolean(me);
}

async function fetchTargetMember(interaction: ChatInputCommandInteraction<'cached'> | UserContextMenuCommandInteraction<'cached'>, targetUser: User) {
  return interaction.guild.members.fetch(targetUser.id).catch(() => null);
}

function validateTarget(interaction: ChatInputCommandInteraction<'cached'> | UserContextMenuCommandInteraction<'cached'>, member: GuildMember | null, targetUser: User, action: string, locale: Locale = 'fr'): string | null {
  if (targetUser.bot && action === 'warn') return m.b1_cannot_warn_bot({}, { locale });
  if (targetUser.id === interaction.user.id) return m.b1_cannot_sanction_self({}, { locale });
  if (targetUser.id === interaction.client.user.id) return m.b1_cannot_sanction_bot({}, { locale });

  const executor = interaction.member;
  if (executor instanceof GuildMember && member) {
    if (member.roles.highest.position >= executor.roles.highest.position && interaction.guild.ownerId !== interaction.user.id) {
      return m.b1_cannot_sanction_higher({}, { locale });
    }
  }

  return null;
}

async function replyError(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction, title: string, description: string) {
  await interaction.reply({ embeds: [errorEmbed(title, description)], flags: [MessageFlags.Ephemeral] });
}

async function notifyModeratorDashboardReportReminder(
  interaction: ChatInputCommandInteraction<'cached'>,
  params: { sanctionId: string; targetLabel: string },
) {
  const dashboardSanctionsUrl = `${DASHBOARD_URL.replace(/\/+$/, '')}/sanctions`;
  const _reminderEmbed = infoEmbed(
    'Rapport à compléter',
    [
      `Tu as sanctionné ${params.targetLabel}.`,
      'Pense à compléter le rapport associé dans le dashboard.',
      `Accès: ${dashboardSanctionsUrl}`,
    ].join('\n'),
  ).addFields({ name: 'ID sanction', value: params.sanctionId, inline: false });

  try {
    const locale = await getEffectiveLocale(interaction);
    await interaction.followUp({
      embeds: [infoEmbed(m.b1_report_required_title({}, { locale }), m.b1_report_required_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
  } catch {
    // Silent catch if interaction is already replied/expired
  }
}

function sanctionTypeLabel(type: SanctionType, locale: Locale = 'fr'): string {
  switch (type) {
    case SanctionType.WARN:
      return m.b1_sanction_label_warn({}, { locale });
    case SanctionType.TIMEOUT:
      return m.b1_sanction_label_timeout({}, { locale });
    case SanctionType.KICK:
      return m.b1_sanction_label_kick({}, { locale });
    case SanctionType.TEMP_BAN:
      return m.b1_sanction_label_tempban({}, { locale });
    case SanctionType.BAN:
      return m.b1_sanction_label_ban({}, { locale });
    case SanctionType.SOFTBAN:
      return m.b1_sanction_label_softban({}, { locale });
    default:
      return type;
  }
}

function sanctionTypeEmoji(type: SanctionType): string {
  switch (type) {
    case SanctionType.WARN:
      return '⚠️';
    case SanctionType.TIMEOUT:
      return '⏳';
    case SanctionType.KICK:
      return '👢';
    case SanctionType.TEMP_BAN:
      return '🚫';
    case SanctionType.BAN:
      return '⛔';
    case SanctionType.SOFTBAN:
      return '🧼';
    default:
      return '📌';
  }
}

function sanctionStatusLabel(status: SanctionStatus, locale: Locale = 'fr'): string {
  switch (status) {
    case SanctionStatus.ACTIVE:
      return m.b1_sanction_status_active({}, { locale });
    case SanctionStatus.RESOLVED:
      return m.b1_sanction_status_resolved({}, { locale });
    case SanctionStatus.FAILED:
      return m.b1_sanction_status_failed({}, { locale });
    default:
      return status;
  }
}

function sanitizeReason(reason: string, locale: Locale = 'fr'): string {
  const trimmed = reason.trim();
  if (!trimmed) return m.b1_no_reason({}, { locale });
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

async function buildSanctionListView(guildId: string, targetUserId: string, targetLabel: string, pageIndex: number, locale: Locale = 'fr') {
  const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, targetUserId);

  const [listResult, typeBreakdown] = await Promise.all([
    listSanctionsByMember({ guildId, targetUserId, targetUserIds: linkedUserIds, page: pageIndex, pageSize: SANCTION_PAGE_SIZE }),
    getSanctionTypeBreakdown(guildId, targetUserId, linkedUserIds),
  ]);

  const total = listResult.total;
  const totalPages = Math.max(1, Math.ceil(total / SANCTION_PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(0, pageIndex), totalPages - 1);

  const finalList = safePageIndex === pageIndex
    ? listResult
    : await listSanctionsByMember({ guildId, targetUserId, targetUserIds: linkedUserIds, page: safePageIndex, pageSize: SANCTION_PAGE_SIZE });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(m.b1_sanction_history_title({ target: targetLabel }, { locale }))
    .setTimestamp()
    .setFooter({ text: m.b1_page_footer({ current: safePageIndex + 1, total: totalPages }, { locale }) });

  if (finalList.total === 0) {
    embed.setDescription(m.b1_no_sanctions_found({}, { locale }));
  } else {
    const lines = finalList.sanctions.map((sanction, index) => {
      const absoluteIndex = safePageIndex * SANCTION_PAGE_SIZE + index + 1;
      const reason = sanitizeReason(sanction.reason, locale);
      const moderatorLabel = sanction.moderatorTag ?? `<@${sanction.moderatorUserId}>`;
      const durationLabel = sanction.durationSeconds ? ` · ${formatDurationFr(sanction.durationSeconds * 1000)}` : '';
      const expiryLabel = sanction.expiresAt ? `\n${m.b1_sanction_line_end({ date: `<t:${Math.floor(sanction.expiresAt.getTime() / 1000)}:R>` }, { locale })}` : '';

      return [
        `**${absoluteIndex}. ${sanctionTypeEmoji(sanction.type)} ${sanctionTypeLabel(sanction.type, locale)}** (${sanctionStatusLabel(sanction.status, locale)})${durationLabel}`,
        m.b1_sanction_line_reason({ reason }, { locale }),
        m.b1_sanction_line_moderation({ moderator: moderatorLabel, created: `<t:${Math.floor(sanction.createdAt.getTime() / 1000)}:R>` }, { locale }) + expiryLabel,
      ].join('\n');
    });

    embed.setDescription(lines.join('\n\n'));
  }

  embed.addFields({
    name: m.b1_summary({}, { locale }),
    value: m.b1_sanction_summary(
      {
        total,
        warn: typeBreakdown.WARN,
        timeout: typeBreakdown.TIMEOUT,
        kick: typeBreakdown.KICK,
        tempban: typeBreakdown.TEMP_BAN,
        ban: typeBreakdown.BAN,
      },
      { locale },
    ),
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('sanction:list:prev')
      .setLabel(m.b1_previous({}, { locale }))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePageIndex === 0 || finalList.total === 0),
    new ButtonBuilder()
      .setCustomId('sanction:list:next')
      .setLabel(m.b1_next({}, { locale }))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePageIndex >= totalPages - 1 || finalList.total === 0),
  );

  const caseRow = buildMemberCaseActionRow(targetUserId);

  return { embed, row, caseRow, pageIndex: safePageIndex, totalPages };
}

async function execute(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction): Promise<void> {
  const { guildId, userId } = extractTrackingInfo(interaction);
  const moduleName = resolveModuleFromCommand('sanction');
  const actionName = interaction.isChatInputCommand() ? interaction.options.getSubcommand(true) : 'context_menu';

  // Wrapper pour tracker les performances et l'utilisation
  await wrapModuleTracking(
    moduleName,
    executeInternal,
    [interaction],
    {
      actionType: 'command',
      actionName,
      guildId,
      userId,
    }
  );
}

async function executeInternal(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  if (!canModerate(interaction)) {
    await replyError(interaction, m.b1_server_required_title({}, { locale }), m.b1_server_required_desc({}, { locale }));
    return;
  }

  if (interaction.isUserContextMenuCommand()) {
    const targetUserId = interaction.targetId;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`case:sanction_action:${targetUserId}`)
      .setPlaceholder(m.b1_sanction_menu_placeholder({}, { locale }))
      .addOptions(
        { label: m.b1_menu_warn({}, { locale }), value: 'warn', emoji: '⚠️' },
        { label: m.b1_menu_timeout({}, { locale }), value: 'timeout', emoji: '⏳' },
        { label: m.b1_menu_kick({}, { locale }), value: 'kick', emoji: '👢' },
        { label: m.b1_menu_ban({}, { locale }), value: 'ban', emoji: '🔨' },
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    await interaction.reply({
      content: m.b1_choose_sanction({ user: `<@${targetUserId}>` }, { locale }),
      components: [row],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const targetUser = interaction.options.getUser('membre', true);
  const targetMember = await fetchTargetMember(interaction, targetUser);

  const validationError = subcommand === 'list' ? null : validateTarget(interaction, targetMember, targetUser, subcommand, locale);
  if (validationError) {
    await replyError(interaction, m.b1_action_refused({}, { locale }), validationError);
    return;
  }

  const moderator = { id: interaction.user.id, tag: interaction.user.tag };
  const target = { id: targetUser.id, tag: targetUser.tag };

  try {
    if (subcommand === 'list') {
      let currentPage = 0;
      const view = await buildSanctionListView(interaction.guildId, targetUser.id, targetUser.tag, currentPage, locale);
      currentPage = view.pageIndex;

      const reply = await interaction.reply({
        embeds: [view.embed],
        components: [view.row, view.caseRow],
        fetchReply: true,
        flags: [MessageFlags.Ephemeral],
      });

      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: SANCTION_LIST_TIMEOUT_MS,
      });

      collector.on('collect', async (buttonInteraction) => {
        if (buttonInteraction.user.id !== interaction.user.id) {
          await buttonInteraction.reply({
            embeds: [infoEmbed(m.b1_action_refused({}, { locale }), m.b1_only_moderator_paging({}, { locale }))],
            flags: [MessageFlags.Ephemeral],
          });
          return;
        }

        if (buttonInteraction.customId === 'sanction:list:prev') {
          currentPage = Math.max(0, currentPage - 1);
        } else if (buttonInteraction.customId === 'sanction:list:next') {
          currentPage += 1;
        }

        const nextView = await buildSanctionListView(interaction.guildId, targetUser.id, targetUser.tag, currentPage, locale);
        currentPage = nextView.pageIndex;

        await buttonInteraction.update({ embeds: [nextView.embed], components: [nextView.row, nextView.caseRow] });
      });

      collector.on('end', async () => {
        try {
          const expiredView = await buildSanctionListView(interaction.guildId, targetUser.id, targetUser.tag, currentPage, locale);
          const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('sanction:list:prev')
              .setLabel(m.b1_previous({}, { locale }))
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId('sanction:list:next')
              .setLabel(m.b1_next({}, { locale }))
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
          );
          await interaction.editReply({ embeds: [expiredView.embed], components: [disabledRow, expiredView.caseRow] });
        } catch {
          // Message possiblement supprimé ou interaction expirée.
        }
      });

      return;
    }

    if (subcommand === 'warn') {
      const reason = interaction.options.getString('raison', true).trim();
      const weight = interaction.options.getInteger('gravite') ?? 1;

      const sanction = await registerWarnSanction({ guildId: interaction.guildId, target, moderator, reason, weight, client: interaction.client });
      const linkedUserIds = await altAccountService.getAllLinkedUserIds(interaction.guildId, targetUser.id);
      const warnCount = await countWarns(interaction.guildId, targetUser.id, linkedUserIds);
      const warnScore = await getWarnScore(interaction.guildId, targetUser.id, linkedUserIds);

      const gravityLabel = weight === 3 ? m.b1_gravity_high({}, { locale }) : weight === 2 ? m.b1_gravity_normal({}, { locale }) : m.b1_gravity_low({}, { locale });
      const scoreFields = warnScore !== warnCount
        ? [
            { name: m.b1_total_warns({}, { locale }), value: `${warnCount}`, inline: true },
            { name: m.b1_weighted_score({}, { locale }), value: m.b1_points({ score: warnScore }, { locale }), inline: true },
            { name: m.b1_gravity({}, { locale }), value: gravityLabel, inline: true },
          ]
        : [{ name: m.b1_total_warns({}, { locale }), value: `${warnCount}`, inline: true }];

      await interaction.reply({
        embeds: [
          successEmbed(m.b1_warn_saved_title({}, { locale }), m.b1_warn_saved_desc({ user: `${targetUser}` }, { locale })).addFields(
            { name: m.b1_reason({}, { locale }), value: reason },
            ...scoreFields,
          ),
        ],
        components: [buildMemberCaseActionRow(targetUser.id)],
        flags: [MessageFlags.Ephemeral],
      });

      await notifyModeratorDashboardReportReminder(interaction, {
        sanctionId: sanction.id,
        targetLabel: targetUser.tag,
      });

      // La vérification auto sur seuil de warns est déclenchée dans registerWarnSanction.

      return;
    }

    if (subcommand === 'to') {
      const reason = interaction.options.getString('raison', true).trim();

      if (!targetMember) {
        await replyError(interaction, m.b1_member_not_found({}, { locale }), m.b1_member_must_be_present_timeout({}, { locale }));
        return;
      }
      if (!targetMember.moderatable) {
        await replyError(interaction, m.b1_action_impossible({}, { locale }), m.b1_cannot_timeout_member({}, { locale }));
        return;
      }

      const durationInput = interaction.options.getString('duree', true);
      const durationMs = parseDurationToMs(durationInput);
      if (!durationMs) {
        await replyError(interaction, m.b1_invalid_duration_title({}, { locale }), m.b1_invalid_duration_desc({ help: m.b1_duration_help({}, { locale }) }, { locale }));
        return;
      }

      const sanction = await registerTimeoutSanction({
        guildId: interaction.guildId,
        target,
        moderator,
        reason,
        durationMs,
        member: targetMember,
        client: interaction.client,
      });

      await interaction.reply({
        embeds: [
          successEmbed(m.b1_timeout_applied_title({}, { locale }), m.b1_timeout_applied_desc({ user: `${targetUser}` }, { locale })).addFields(
            { name: m.b1_duration({}, { locale }), value: formatDurationFr(durationMs), inline: true },
            { name: m.b1_reason({}, { locale }), value: reason, inline: false },
            { name: m.b1_auto_followup({}, { locale }), value: m.b1_auto_followup_value({}, { locale }), inline: false },
            { name: m.b1_sanction_id({}, { locale }), value: sanction.id, inline: false },
          ),
        ],
        components: [buildMemberCaseActionRow(targetUser.id)],
        flags: [MessageFlags.Ephemeral],
      });

      await notifyModeratorDashboardReportReminder(interaction, {
        sanctionId: sanction.id,
        targetLabel: targetUser.tag,
      });
      return;
    }

    if (subcommand === 'kick') {
      const reason = interaction.options.getString('raison', true).trim();

      if (!targetMember) {
        await replyError(interaction, m.b1_member_not_found({}, { locale }), m.b1_member_must_be_present_kick({}, { locale }));
        return;
      }
      if (!targetMember.kickable) {
        await replyError(interaction, m.b1_action_impossible({}, { locale }), m.b1_cannot_kick_member({}, { locale }));
        return;
      }

      await targetMember.kick(`${reason} | Modération: ${interaction.user.tag}`);
      const sanction = await registerKickSanction({ guildId: interaction.guildId, target, moderator, reason, client: interaction.client });

      await interaction.reply({
        embeds: [successEmbed(m.b1_kick_done_title({}, { locale }), m.b1_kick_done_desc({ user: targetUser.tag }, { locale })).addFields({ name: m.b1_reason({}, { locale }), value: reason })],
        components: [buildMemberCaseActionRow(targetUser.id)],
        flags: [MessageFlags.Ephemeral],
      });

      await notifyModeratorDashboardReportReminder(interaction, {
        sanctionId: sanction.id,
        targetLabel: targetUser.tag,
      });
      return;
    }

    if (subcommand === 'ban') {
      const reason = interaction.options.getString('raison', true).trim();

      if (targetMember && !targetMember.bannable) {
        await replyError(interaction, m.b1_action_impossible({}, { locale }), m.b1_cannot_ban_member({}, { locale }));
        return;
      }

      // Le DM avec le lien d'appel doit partir avant le ban : une fois banni,
      // l'utilisateur ne partage plus forcément de serveur avec le bot.
      await sendBanAppealNotificationDM(interaction.client, interaction.guildId, targetUser.id).catch(() => false);
      await runGuildBan(interaction.guild, targetUser.id, `${reason} | Modération: ${interaction.user.tag}`);
      const sanction = await registerBanSanction({ guildId: interaction.guildId, target, moderator, reason, client: interaction.client });

      await interaction.reply({
        embeds: [successEmbed(m.b1_ban_done_title({}, { locale }), m.b1_ban_done_desc({ user: targetUser.tag }, { locale })).addFields({ name: m.b1_reason({}, { locale }), value: reason })],
        components: [buildMemberCaseActionRow(targetUser.id)],
        flags: [MessageFlags.Ephemeral],
      });

      await notifyModeratorDashboardReportReminder(interaction, {
        sanctionId: sanction.id,
        targetLabel: targetUser.tag,
      });
      return;
    }

    if (subcommand === 'tempban') {
      const reason = interaction.options.getString('raison', true).trim();

      if (targetMember && !targetMember.bannable) {
        await replyError(interaction, m.b1_action_impossible({}, { locale }), m.b1_cannot_ban_member({}, { locale }));
        return;
      }

      const durationInput = interaction.options.getString('duree', true);
      const durationMs = parseDurationToMs(durationInput);
      if (!durationMs) {
        await replyError(interaction, m.b1_invalid_duration_title({}, { locale }), m.b1_invalid_duration_desc({ help: m.b1_duration_help({}, { locale }) }, { locale }));
        return;
      }

      await runGuildBan(interaction.guild, targetUser.id, `${reason} | Modération: ${interaction.user.tag}`);
      const sanction = await registerBanSanction({
        guildId: interaction.guildId,
        target,
        moderator,
        reason,
        temporaryDurationMs: durationMs,
        client: interaction.client,
      });

      await interaction.reply({
        embeds: [
          successEmbed(m.b1_tempban_done_title({}, { locale }), m.b1_tempban_done_desc({ user: targetUser.tag }, { locale })).addFields(
            { name: m.b1_duration({}, { locale }), value: formatDurationFr(durationMs), inline: true },
            { name: m.b1_reason({}, { locale }), value: reason, inline: false },
            { name: m.b1_auto_unban({}, { locale }), value: `<t:${Math.floor((sanction.expiresAt?.getTime() ?? Date.now()) / 1000)}:F>`, inline: false },
          ),
        ],
        components: [buildMemberCaseActionRow(targetUser.id)],
        flags: [MessageFlags.Ephemeral],
      });

      await notifyModeratorDashboardReportReminder(interaction, {
        sanctionId: sanction.id,
        targetLabel: targetUser.tag,
      });
      return;
    }

    if (subcommand === 'softban') {
      const reason = interaction.options.getString('raison', true).trim();

      if (targetMember && !targetMember.bannable) {
        await replyError(interaction, m.b1_action_impossible({}, { locale }), m.b1_cannot_softban_member({}, { locale }));
        return;
      }

      // 1. Bannir le membre avec suppression des messages de 7 jours (604800 secondes)
      await interaction.guild.members.ban(targetUser.id, {
        deleteMessageSeconds: 7 * 24 * 60 * 60,
        reason: `${reason} | Softban par ${interaction.user.tag}`
      });

      // 2. Débannir le membre immédiatement
      await interaction.guild.members.unban(targetUser.id, `Softban (re-déban automatique) | Modération: ${interaction.user.tag}`);

      // 3. Enregistrer la sanction dans la BDD
      const sanction = await registerSoftbanSanction({
        guildId: interaction.guildId,
        target,
        moderator,
        reason,
        client: interaction.client,
      });

      await interaction.reply({
        embeds: [
          successEmbed(m.b1_softban_done_title({}, { locale }), m.b1_softban_done_desc({ user: targetUser.tag }, { locale })).addFields(
            { name: m.b1_messages_deleted({}, { locale }), value: m.b1_last_7_days({}, { locale }), inline: true },
            { name: m.b1_reason({}, { locale }), value: reason, inline: false },
            { name: m.b1_sanction_id({}, { locale }), value: sanction.id, inline: false }
          ),
        ],
        components: [buildMemberCaseActionRow(targetUser.id)],
        flags: [MessageFlags.Ephemeral],
      });

      await notifyModeratorDashboardReportReminder(interaction, {
        sanctionId: sanction.id,
        targetLabel: targetUser.tag,
      });
      return;
    }

    if (subcommand === 'tableau') {
      const reason = interaction.options.getString('raison')?.trim() || null;
      const tableName = interaction.options.getString('nom', true).trim();
      const bypassLevel = interaction.options.getInteger('bypass');

      if (targetUser.bot) {
        await replyError(interaction, m.b1_action_refused({}, { locale }), m.b1_cannot_sanction_a_bot({}, { locale }));
        return;
      }

      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      try {
        const result = await applyProgressiveSanction({
          guildId: interaction.guildId!,
          target,
          moderator,
          tableName,
          bypassLevel,
          reason,
          guild: interaction.guild!,
          member: targetMember,
          client: interaction.client,
        });

        const actionLabel = sanctionTypeLabel(result.action, locale);
        const actionEmoji = sanctionTypeEmoji(result.action);
        const bypassText = bypassLevel ? m.b1_bypass_forced({ level: bypassLevel }, { locale }) : '';

        const embed = successEmbed(
          m.b1_progressive_applied_title({}, { locale }),
          m.b1_progressive_applied_desc({ user: `${targetUser}`, table: result.table.name }, { locale })
        ).addFields(
          { name: m.b1_applied_sanction({}, { locale }), value: `${actionEmoji} ${actionLabel}${bypassText}`, inline: true },
          { name: m.b1_tier_reached({}, { locale }), value: `T${result.level}`, inline: true },
          { name: m.b1_reason({}, { locale }), value: result.sanction.reason, inline: false },
          { name: m.b1_sanction_id({}, { locale }), value: result.sanction.id, inline: false }
        );

        await interaction.editReply({
          embeds: [embed],
          components: [buildMemberCaseActionRow(targetUser.id)],
        });

        await notifyModeratorDashboardReportReminder(interaction, {
          sanctionId: result.sanction.id,
          targetLabel: targetUser.tag,
        });
      } catch (err: unknown) {
        const embed = errorEmbed(m.b1_progressive_error_title({}, { locale }), errorMessage(err) || m.b1_progressive_error_fallback({}, { locale }));
        await interaction.editReply({ embeds: [embed] });
      }
      return;
    }

    await interaction.reply({
      embeds: [infoEmbed(m.b1_unknown_subcommand_title({}, { locale }), m.b1_unknown_subcommand_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
  } catch (error) {
    await interaction.reply({
      embeds: [errorEmbed(m.b1_error({}, { locale }), error instanceof Error ? error.message : m.b1_unknown_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
  }
}

async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedOption = interaction.options.getFocused(true);
  const guildId = interaction.guildId!;

  try {
    await getOrCreateDefaultTables(guildId);

    if (focusedOption.name === 'nom') {
      const focusedValue = String(focusedOption.value).toLowerCase();
      const tables = await prisma.sanctionTable.findMany({
        where: {
          guildId,
          name: { contains: focusedValue, mode: 'insensitive' },
        },
        take: 25,
      });

      await interaction.respond(
        tables.map((table) => ({
          name: table.name,
          value: table.name,
        }))
      );
      return;
    }

    if (focusedOption.name === 'bypass') {
      const tableName = interaction.options.getString('nom');
      if (!tableName) {
        await interaction.respond([]);
        return;
      }

      const table = await prisma.sanctionTable.findFirst({
        where: {
          guildId,
          name: { equals: tableName, mode: 'insensitive' },
        },
        include: {
          tiers: {
            orderBy: { level: 'asc' },
          },
        },
      });

      if (!table || !table.tiers || table.tiers.length === 0) {
        await interaction.respond([]);
        return;
      }

      const locale = await getEffectiveLocale(interaction);
      const choices = table.tiers.map((tier) => {
        const actionLabel = sanctionTypeLabel(tier.action, locale);
        const durationLabel = tier.durationSeconds ? ` (${formatDurationFr(tier.durationSeconds * 1000)})` : '';
        const name = `T${tier.level} - ${actionLabel}${durationLabel}`;
        return {
          name,
          value: tier.level,
        };
      });

      const query = String(focusedOption.value).toLowerCase();
      const filtered = choices.filter((c) => c.name.toLowerCase().includes(query));

      await interaction.respond(filtered.slice(0, 25));
      return;
    }

    await interaction.respond([]);
  } catch {
    try {
      await interaction.respond([]);
    } catch {
      // ignore
    }
  }
}

export const sanctionCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
export const sanctionContextCommand = { data: contextData, execute } satisfies ContextCommandDefinition;
