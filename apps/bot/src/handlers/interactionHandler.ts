import { errorMessage } from '../utils/errors.js';
import { type Interaction, type Client, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalSubmitInteraction, MessageFlags, type AnySelectMenuInteraction, PermissionFlagsBits, type GuildMember, TextInputBuilder, TextInputStyle, ModalBuilder, StringSelectMenuBuilder } from 'discord.js';
import prisma from '../utils/db.js';
import { getCachedGuild } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { SanctionStatus, SanctionType } from '@prisma/client';
import { COLORS, successEmbed, errorEmbed, truncate } from '../utils/embeds.js';
import { handleConfigChannelSelect, handleConfigModal, handleConfigSelectMenu } from './configHandler.js';
import { sendSetupStep1, sendSetupStep2, sendSetupStep3, sendSetupFinish } from '../panels/setupPanel.js';
import { reviewDailyAlgoSubmission } from '../services/progression/dailyAlgoService.js';
import { renderPanelBeside, renderPanelTarget } from '../utils/interactionResponses.js';
import { parseSetupStep, parseUserCaseRoute, parseValidateRoute, parseEventQuizRoute, parseEventResultRoute } from './interactionRoutes.js';
import { handleQuizInteraction, buildEventResultsView, getEventStats } from '../services/features/eventService.js';
import { toggleGuildBoolean } from '../utils/prismaToggles.js';
import { requireSingleSelectedValue } from '../utils/interactionValidation.js';
import { buildMemberCasePanel, type MemberCaseSection } from '../services/moderation/memberCaseService.js';
import { handleRecruitmentButton } from '../services/staff/recruitmentService.js';
import { handleTicketButton, handleTicketModalSubmit, handleTicketSelectMenu } from '../services/features/ticketService.js';
import { canManageGiveaways } from '../services/features/giveawayConfigService.js';
import { handleRpgButton, handleRpgModalSubmit, handleRpgSelectMenu } from '../services/features/rpgPanelService.js';
import { DROP_CLAIM_PREFIX, handleDropClaim } from '../services/features/dropService.js';
import { checkInMeeting, createNotification } from '../services/staff/staffLeadershipService.js';
import { handleDCInteraction } from '../services/moderation/dcDetectionService.js';
import { memberProfileIdentity } from '../services/moderation/memberIdentityService.js';
import { handleVerifyButtonClick, handleVerificationStaffAction } from '../services/moderation/securityVerificationService.js';
import { showModeratorNoteModal } from '../commands/moderation/note.js';
import { sendReportToAdmin } from '../commands/moderation/signal.js';
import { parseDurationToMs, registerBanSanction, registerKickSanction, registerTimeoutSanction, registerWarnSanction } from '../services/moderation/sanctionService.js';


/** Modal de saisie de raison (et durée pour timeout) partagé entre le select historique et les boutons rapides du casier. */
function buildSanctionReasonModal(action: string, targetUserId: string, targetUsername: string): ModalBuilder {
  const actionLabel = action === 'warn' ? 'Avertissement' : action === 'timeout' ? 'Timeout' : action === 'kick' ? 'Expulsion' : 'Bannissement';

  const modal = new ModalBuilder()
    .setCustomId(`sanction_modal:${action}:${targetUserId}`)
    .setTitle(`Sanction : ${truncate(targetUsername, 20)}`);

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(`Raison du ${actionLabel}`)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Motif de la sanction...')
    .setRequired(true)
    .setMaxLength(500);

  const rows: ActionRowBuilder<TextInputBuilder>[] = [];

  if (action === 'timeout') {
    const durationInput = new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Durée (ex: 2h, 1j)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Exemple : 2h')
      .setRequired(true)
      .setMaxLength(50);
    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(durationInput));
  }

  rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
  modal.addComponents(rows);
  return modal;
}

function normalizeTargetLanguage(value: string | null | undefined): 'FR' | 'EN' | 'ES' | 'DE' {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'EN' || normalized === 'ES' || normalized === 'DE') {
    return normalized;
  }
  return 'FR';
}

type PendingDailyAlgoScoreDraft = {
  submissionId: string;
  moderatorId: string;
  createdAt: number;
  scores: {
    correctness: number;
    comments: number;
    compactness: number;
    optimization: number;
    readability: number;
  };
};

const pendingDailyAlgoScoreDrafts = new Map<string, PendingDailyAlgoScoreDraft>();

function pendingDailyAlgoDraftKey(submissionId: string, moderatorId: string): string {
  return `${submissionId}:${moderatorId}`;
}

function prunePendingDailyAlgoDrafts(): void {
  const now = Date.now();
  const maxAgeMs = 30 * 60 * 1000;

  for (const [key, draft] of pendingDailyAlgoScoreDrafts.entries()) {
    if (now - draft.createdAt > maxAgeMs) {
      pendingDailyAlgoScoreDrafts.delete(key);
    }
  }
}

async function canModerate(member: GuildMember | null, guildId: string): Promise<boolean> {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const guild = await getCachedGuild(guildId);
  if (guild?.moderatorRoleId && member.roles.cache.has(guild.moderatorRoleId)) {
    return true;
  }

  return false;
}

async function resolveGuildMemberByUserId(interaction: Interaction, userId: string): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

export async function handleButton(interaction: Interaction, client: Client): Promise<void> {
  if (!interaction.isButton()) return;

  const { customId, guildId, user } = interaction;

  if (customId.startsWith('help_')) {
    const { handleHelpInteraction } = await import('../commands/utility/help.js');
    await handleHelpInteraction(interaction);
    return;
  }

  // ── Confidentialité : reprise du suivi de présence après /opt-out presence
  if (customId === 'optout:presence:resume') {
    const { handleOptOutPresenceResume } = await import('../commands/utility/optout.js');
    await handleOptOutPresenceResume(interaction);
    return;
  }

  // ── Simulateur de modération : sim:<sessionId>:<stepIndex>:<action>[:<minutes>]
  if (customId.startsWith('sim:')) {
    const [, sessionId, stepIndexRaw, action, minutesRaw] = customId.split(':');
    const { recordAnswer, SimulationError } = await import('../services/staff/simulationService.js');

    try {
      const result = await recordAnswer(
        sessionId,
        Number.parseInt(stepIndexRaw, 10),
        user.id,
        action as never,
        minutesRaw ? Number.parseInt(minutesRaw, 10) : undefined,
      );

      // Une étape déjà traitée ou une session close ne mérite qu'un accusé discret
      await interaction.reply({
        content: result
          ? `${result.correct ? '✅' : '📝'} ${result.reason}`
          : '⏳ Cette étape est déjà traitée ou la session est terminée.',
        flags: [MessageFlags.Ephemeral],
      });
    } catch (err) {
      await interaction.reply({
        content: err instanceof SimulationError
          ? `❌ ${err.message}`
          : '❌ Erreur lors de l\'enregistrement de la réponse.',
        flags: [MessageFlags.Ephemeral],
      });
    }
    return;
  }

  // ── Pages de présentation du thread d'accueil ───────────────────────
  if (customId.startsWith('wpage:')) {
    const { handleWelcomeMenuInteraction } = await import('../services/features/welcomeThreadService.js');
    await handleWelcomeMenuInteraction(interaction);
    return;
  }

  // ── Ticket Satisfaction Survey ──────────────────────────────────────
  if (customId.startsWith('satisfaction:')) {
    const parts = customId.split(':');
    const satGuildId = parts[1];
    const ticketId = parts[2];
    const rating = parseInt(parts[3], 10);

    if (satGuildId && ticketId && rating >= 1 && rating <= 5) {
      const {
        recordSatisfaction,
        getSatisfactionCommentConfig,
        buildCommentPrompt,
        buildSatisfactionDoneEmbed,
        scheduleCommentPromptExpiry,
        markCommentPromptOpen,
        publishSatisfactionReview,
      } = await import('../services/features/ticketSatisfactionService.js');
      const success = await recordSatisfaction(satGuildId, ticketId, user.id, rating);

      if (!success) {
        await interaction.reply({ content: '❌ Erreur lors de l\'enregistrement.', flags: [MessageFlags.Ephemeral] });
        return;
      }

      // Publie l'avis sans attendre : la note est acquise, un commentaire arrivé
      // plus tard viendra éditer le message déjà posté.
      void publishSatisfactionReview(client, satGuildId, ticketId, user.id);

      // La note est acquise avant de proposer la question facultative : fermer le
      // sondage sans y répondre ne doit jamais faire perdre l'évaluation.
      const commentConfig = await getSatisfactionCommentConfig(satGuildId);
      if (!commentConfig.enabled) {
        await interaction.update({ embeds: [buildSatisfactionDoneEmbed(rating)], components: [] });
        return;
      }

      const { embed, row } = buildCommentPrompt(satGuildId, ticketId, rating, commentConfig);
      await interaction.update({ embeds: [embed], components: [row] });
      // Le minuteur ferme le sondage a la seconde pres ; la trace en base sert de
      // filet si le bot redemarre avant qu'il ne se declenche.
      await markCommentPromptOpen(satGuildId, ticketId, user.id, interaction.message, commentConfig.timeoutSeconds);
      scheduleCommentPromptExpiry(interaction.message, satGuildId, ticketId, user.id, rating, commentConfig.timeoutSeconds);
    }
    return;
  }

  // ── Ticket Satisfaction : commentaire facultatif ────────────────────
  if (customId.startsWith('satcomment:')) {
    const [, satGuildId, ticketId] = customId.split(':');
    if (!satGuildId || !ticketId) return;

    const { getSatisfactionCommentConfig, buildCommentModal } = await import('../services/features/ticketSatisfactionService.js');
    const commentConfig = await getSatisfactionCommentConfig(satGuildId);
    await interaction.showModal(buildCommentModal(satGuildId, ticketId, commentConfig));
    return;
  }

  if (customId.startsWith('satskip:')) {
    const [, satGuildId, ticketId] = customId.split(':');
    if (!satGuildId || !ticketId) return;

    const { buildSatisfactionDoneEmbed, clearCommentPrompt } = await import('../services/features/ticketSatisfactionService.js');
    const stored = await prisma.ticketSatisfaction.findUnique({
      where: { guildId_ticketId_userId: { guildId: satGuildId, ticketId, userId: user.id } },
      select: { rating: true, comment: true },
    });
    await clearCommentPrompt(satGuildId, ticketId, user.id);
    await interaction.update({
      embeds: stored
        ? [buildSatisfactionDoneEmbed(stored.rating, stored.comment)]
        : [new EmbedBuilder().setColor(COLORS.success).setTitle('Merci pour votre retour !').setTimestamp()],
      components: [],
    });
    return;
  }

  // ── Drop aléatoire : bouton de ramassage ────────────────────────────
  if (customId.startsWith(DROP_CLAIM_PREFIX)) {
    const dropId = customId.slice(DROP_CLAIM_PREFIX.length);
    if (!dropId) return;
    await handleDropClaim(interaction, dropId);
    return;
  }

  // ── RPG Drop Claim button ───────────────────────────────────────────
  if (customId.startsWith('rpg_drop_claim:')) {
    const dropId = customId.split(':')[1];
    if (!dropId) return;

    await interaction.deferUpdate().catch(() => null);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const drop = await tx.rpgDrop.findUnique({
          where: { id: dropId }
        });
        if (!drop) throw new Error("Ce drop n'existe plus.");
        if (drop.claimed) throw new Error('Ce drop a déjà été réclamé.');

        await tx.rpgDrop.update({
          where: { id: dropId },
          data: {
            claimed: true,
            claimedBy: user.id
          }
        });

        // Find or create profile:
        let userProfile = await tx.rpgProfile.findUnique({
          where: { guildId_userId: { guildId: guildId!, userId: user.id } }
        });
        if (!userProfile) {
          userProfile = await tx.rpgProfile.create({
            data: { guildId: guildId!, userId: user.id }
          });
        }

        const isCoins = drop.type === 'COINS';
        await tx.rpgProfile.update({
          where: { id: userProfile.id },
          data: isCoins
            ? { balance: { increment: drop.amount } }
            : { xp: { increment: drop.amount } }
        });

        return { drop };
      });

      const resourceName = result.drop.type === 'COINS' ? 'KotboCoins 🪙' : 'XP RPG ⭐';
      // Le message du drop est en Components V2 (voir utils/patchV2.ts) :
      // `interaction.message.embeds` est vide, on reconstruit donc l'embed.
      const updatedEmbed = new EmbedBuilder()
        .setTitle('🎁 Un drop est apparu !')
        .setDescription(`🎁 **Réclamé !**\n\nCe drop de **${result.drop.amount}** **${resourceName}** a été ramassé par <@${user.id}> !`)
        .setColor(COLORS.success)
        .setTimestamp();

      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`rpg_drop_claim:${dropId}`)
          .setLabel('Réclamé 🎁')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );

      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: [disabledRow]
      }).catch(() => null);

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Impossible de réclamer le drop.';
      await interaction.followUp({
        content: `❌ ${errMsg}`,
        flags: [MessageFlags.Ephemeral]
      }).catch(() => null);
    }
    return;
  }

  // ── Raid hebdomadaire : bouton d'assaut ────────────────────────────
  if (customId === 'rpg_raid_attack') {
    if (!guildId) return;
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const [{ attackRaid, RaidError }, { buildAssaultEmbed }] = await Promise.all([
      import('../services/features/rpg/rpgRaidService.js'),
      import('../services/features/rpg/rpgRaidPanel.js'),
    ]);

    try {
      const member = await resolveGuildMemberByUserId(interaction, user.id);
      const outcome = await attackRaid(interaction.client, guildId, user.id, member);
      await interaction.editReply({ embeds: [await buildAssaultEmbed(guildId, outcome)] });
    } catch (error) {
      // Un refus attendu - pas de clan, plus d'assaut, pas assez d'énergie - se dit au
      // joueur ; le reste part au journal, l'utilisateur n'ayant que faire d'une trace.
      const expected = error instanceof RaidError;
      if (!expected) logger.error('RpgRaid', `Assaut en échec sur ${guildId}:`, error);
      await interaction.editReply({
        embeds: [errorEmbed(
          'Assaut impossible',
          expected ? error.message : "L'assaut n'a pas pu être livré.",
        )],
      }).catch(() => null);
    }
    return;
  }

  // ── RPG Admin Reset Confirm/Cancel buttons ─────────────────────────
  if (customId.startsWith('rpg_reset_confirm:')) {
    const component = customId.split(':')[1] as 'all' | 'profiles' | 'items' | 'config' | 'guilds';
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!member || !member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Seuls les administrateurs peuvent confirmer un reset.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferUpdate();
    
    const { adminResetGuildEconomy } = await import('../services/features/economyService.js');
    const { restored } = await adminResetGuildEconomy(guildId!, component);

    const componentLabels: Record<string, string> = {
      all: "l'Économie & RPG (Global)",
      profiles: 'les Profils des joueurs',
      items: 'les Objets de la boutique',
      config: 'la Configuration',
      guilds: 'les Guildes RPG'
    };

    const restitution = restored.players > 0
      ? `\n\n**${restored.coins.toLocaleString('fr-FR')}** pièces de montée de niveau ont été restituées à **${restored.players}** membre(s).`
      : '';

    await interaction.editReply({
      embeds: [successEmbed('Réinitialisation terminée', `Le composant **${componentLabels[component] || component}** a été réinitialisé avec succès !${restitution}`)],
      components: []
    });
    return;
  }

  if (customId === 'rpg_reset_cancel') {
    await interaction.update({
      embeds: [errorEmbed('Annulé', 'La réinitialisation a été annulée.')],
      components: []
    });
    return;
  }

  // ── Giveaway validation admin approval buttons ─────────────────────
  // Les modérateurs valident, comme avant, mais aussi les rôles gestionnaires
  // de giveaways : sinon l'équipe qui lance les concours ne peut pas en
  // valider les gagnants.
  if (customId.startsWith('giveaway_val_approve:')) {
    const giveawayId = customId.split(':')[1];
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!)) && !(await canManageGiveaways(member, guildId!))) {
      await interaction.reply({ content: "❌ Vous n'avez pas les permissions pour valider ce giveaway.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferUpdate();

    const { approveGiveawayWinners } = await import('../services/features/giveawayService.js');
    await approveGiveawayWinners(client, giveawayId);
    return;
  }

  if (customId.startsWith('giveaway_val_reroll:')) {
    const giveawayId = customId.split(':')[1];
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!)) && !(await canManageGiveaways(member, guildId!))) {
      await interaction.reply({ content: "❌ Vous n'avez pas les permissions pour relancer ce giveaway.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const { rerollGiveaway } = await import('../services/features/giveawayService.js');
    await rerollGiveaway(client, giveawayId, interaction.guildId ?? undefined);
    
    await interaction.editReply({ content: '✅ Le giveaway a été relancé (reroll).' });
    return;
  }

  // ── Giveaway buttons ────────────────────────────────────────────────
  if (customId.startsWith('giveaway_join:')) {
    const { handleGiveawayJoin } = await import('../services/features/giveawayService.js');
    await handleGiveawayJoin(interaction);
    return;
  }

  // ── Paris entre membres (points de clan) ────────────────────────────
  if (customId.startsWith('bet:')) {
    const { handleBetButton } = await import('../services/community/clanBetService.js');
    await handleBetButton(interaction);
    return;
  }

  // ── Reaction Role buttons ───────────────────────────────────────────
  if (customId.startsWith('role_toggle:')) {
    const { handleRoleToggleInteraction } = await import('../services/features/reactionRoleService.js');
    await handleRoleToggleInteraction(interaction);
    return;
  }

  // ── Suggestion buttons ──────────────────────────────────────────────
  if (customId.startsWith('suggest_vote:')) {
    const { handleSuggestionVote } = await import('../services/features/suggestionService.js');
    const type = customId.split(':')[2] as 'up' | 'down';
    await handleSuggestionVote(interaction, type);
    return;
  }

  // ── Suggestion form button ───────────────────────────────────────────
  if (customId === 'suggest_form_open') {
    
    const modal = new ModalBuilder()
      .setCustomId('suggest_form_modal')
      .setTitle('💡 Soumettre une suggestion');

    const suggestionInput = new TextInputBuilder()
      .setCustomId('suggestion_content')
      .setLabel('Votre suggestion')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Décrivez votre suggestion en détail...')
      .setRequired(true)
      .setMaxLength(1000)
      .setMinLength(10);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(suggestionInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
    return;
  }

  const caseRoute = parseUserCaseRoute(customId);
  if (caseRoute) {
    if (!guildId) {
      await interaction.reply({ content: '❌ Le casier utilisateur est disponible uniquement sur un serveur.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires pour ouvrir un casier utilisateur.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (caseRoute.action === 'close') {
      await interaction.update({ content: '📁 Casier fermé.', embeds: [], components: [] });
      return;
    }

    if (caseRoute.action === 'note') {
      const targetUser = await client.users.fetch(caseRoute.userId).catch(() => null);
      await showModeratorNoteModal(interaction, caseRoute.userId, targetUser?.username ?? 'Utilisateur');
      return;
    }

    // Boutons rapides Warn/Timeout/Kick/Ban du casier → modal de raison
    if (caseRoute.action === 'sanction' && caseRoute.sanctionType) {
      const targetUser = await client.users.fetch(caseRoute.userId).catch(() => null);
      await interaction.showModal(buildSanctionReasonModal(caseRoute.sanctionType, caseRoute.userId, targetUser?.username ?? 'Utilisateur'));
      return;
    }

    // Bouton "Révoquer" d'une sanction active : lève la sanction côté Discord puis en base
    if (caseRoute.action === 'revoke' && caseRoute.sanctionId) {
      const sanction = await prisma.sanction.findFirst({
        where: { id: caseRoute.sanctionId, guildId },
      });

      if (sanction && sanction.status === SanctionStatus.ACTIVE) {
        const motif = `Sanction révoquée via le casier par ${user.tag}`;

        if (sanction.type === SanctionType.BAN || sanction.type === SanctionType.TEMP_BAN || sanction.type === SanctionType.SOFTBAN) {
          await interaction.guild!.members.unban(sanction.targetUserId, motif).catch(() => null);
        } else if (sanction.type === SanctionType.TIMEOUT) {
          const target = await interaction.guild!.members.fetch(sanction.targetUserId).catch(() => null);
          if (target?.isCommunicationDisabled()) {
            await target.timeout(null, motif).catch(() => null);
          }
        }

        await prisma.sanction.update({
          where: { id: sanction.id },
          data: { status: SanctionStatus.RESOLVED, resolvedAt: new Date() },
        });
      }

      const panel = await buildMemberCasePanel(interaction.guild!, caseRoute.userId, 'sanctions', caseRoute.pageIndex ?? 0);
      await renderPanelBeside(interaction, {
        // embeds: [] vide les embeds des anciens panels legacy, requis pour la conversion en Components V2
        embeds: [],
        components: panel.components,
        files: panel.files,
        flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
      });
      return;
    }

    const section: MemberCaseSection = caseRoute.section ?? 'resume';
    const pageIndex = caseRoute.action === 'prev'
      ? Math.max(0, (caseRoute.pageIndex ?? 0) - 1)
      : caseRoute.action === 'next'
        ? (caseRoute.pageIndex ?? 0) + 1
        : caseRoute.pageIndex ?? 0;

    const panel = await buildMemberCasePanel(interaction.guild!, caseRoute.userId, section, pageIndex);
    // `renderPanelBeside` et non `renderPanelTarget` : « Voir le casier » est
    // pose sur des logs et des cartes de sanction, que l'`update` remplacait
    // par le casier - le log etait alors perdu pour tout le serveur.
    await renderPanelBeside(interaction, {
      embeds: [],
      components: panel.components,
      files: panel.files,
      flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
    });
    return;
  }

  // Recruitment ticket buttons
  if (customId.startsWith('recruit:')) {
    await handleRecruitmentButton(client, customId, interaction);
    return;
  }

  // Staff server lifecycle buttons (offboarding kick/keep)
  if (customId.startsWith('staffserver:')) {
    const { handleStaffServerButton } = await import('../services/staff/staffServerService.js');
    await handleStaffServerButton(client, customId, interaction);
    return;
  }

  // Ticket system buttons
  if (customId.startsWith('ticket:')) {
    await handleTicketButton(client, customId, interaction);
    return;
  }

  // Hub RPG (/rpg) - navigation, voyage, combat, guilde, boutons Payer/Vendre/Admin
  if (customId.startsWith('rpg:')) {
    await handleRpgButton(client, customId, interaction);
    return;
  }

  // Ban appeal decision buttons (staff channel)
  if (customId.startsWith('appeal:')) {
    const { handleAppealButton } = await import('../services/moderation/banAppealService.js');
    await handleAppealButton(client, customId, interaction);
    return;
  }

  // Admin Permission Lock - approve/reject buttons (DM or staff channel, DM has no guildId)
  if (customId.startsWith('adminlock:')) {
    const { handleAdminLockButton } = await import('../services/moderation/adminLockService.js');
    await handleAdminLockButton(client, customId, interaction);
    return;
  }

  // Regulation acceptance button
  if (customId === 'regulation_accept') {
    if (!guildId) {
      await interaction.reply({ content: '❌ Action impossible hors serveur.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { regulationRoleId: true },
      });

      const discordGuild = interaction.guild;
      if (!discordGuild) {
        await interaction.editReply({ content: '❌ Erreur : Serveur Discord introuvable.' });
        return;
      }

      const member = await discordGuild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply({ content: '❌ Erreur : Membre introuvable.' });
        return;
      }

      const roleId = guild?.regulationRoleId;
      let role = roleId ? discordGuild.roles.cache.get(roleId) : null;

      if (!role) {
        // Find existing "Vérifié" role or create it
        role = discordGuild.roles.cache.find((r) => r.name === 'Vérifié') ?? null;
        if (!role) {
          try {
            role = await discordGuild.roles.create({
              name: 'Vérifié',
              reason: 'Créé automatiquement pour le règlement du serveur.',
            });
          } catch (err) {
            logger.error('RegulationButton', `Impossible de créer le rôle 'Vérifié' :`, err);
            await interaction.editReply({ content: '❌ Impossible de créer le rôle de vérification. Demandez à un administrateur de configurer le rôle.' });
            return;
          }
        }

        // Update database with the new or found role ID
        await prisma.guild.update({
          where: { id: guildId },
          data: { regulationRoleId: role.id },
        });
      }

      if (member.roles.cache.has(role.id)) {
        await interaction.editReply({ content: 'ℹ️ Tu as déjà accepté le règlement et tu es déjà vérifié !' });
        return;
      }

      await member.roles.add(role, 'Acceptation du règlement du serveur').catch((err) => {
        logger.error('RegulationButton', `Impossible d'attribuer le rôle de vérification :`, err);
        throw err;
      });

      await interaction.editReply({ content: "✅ Merci d'avoir accepté le règlement ! Tu as maintenant accès au serveur." });
    } catch (err) {
      logger.error('RegulationButton', `Erreur lors de l'acceptation du règlement :`, err);
      await interaction.editReply({ content: "❌ Une erreur est survenue lors de l'attribution du rôle. Veuillez contacter un administrateur." });
    }
    return;
  }



  // ── Captcha vocal (boutons destinés aux arrivants, pas au staff) ─────
  if (customId.startsWith('vcaptcha:')) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!member) {
      await interaction.editReply({ content: "❌ Membre introuvable sur ce serveur." });
      return;
    }

    const { getRaidProtectionConfig } = await import('../services/moderation/raidProtectionService.js');
    const config = await getRaidProtectionConfig(guildId!);
    if (!config?.captchaEnabled) {
      await interaction.editReply({ content: "ℹ️ La vérification n'est plus active sur ce serveur." });
      return;
    }

    const session = await prisma.captchaSession.findFirst({
      where: { guildId: guildId!, userId: user.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) {
      await interaction.editReply({ content: "ℹ️ Tu n'as aucune vérification en cours." });
      return;
    }

    const action = customId.split(':')[1];

    if (action === 'start' || action === 'repeat') {
      const { enqueueMember, replayCode } = await import('../services/moderation/voiceCaptchaService.js');
      const result = action === 'start'
        ? await enqueueMember(member, config)
        : await replayCode(member);

      if (!result.ok) {
        await interaction.editReply({ content: `❌ Impossible de te mettre en file : ${result.reason}.` });
        return;
      }

      if (result.immediate) {
        await interaction.editReply({ content: '🔁 Je te réénonce le code tout de suite, reste dans le salon vocal.' });
        return;
      }

      const seconds = Math.ceil(result.estimatedWaitMs / 1000);
      await interaction.editReply({
        content: result.position === 1
          ? '🎧 C\'est bientôt à toi : reste ici, je te ping dès que le salon vocal s\'ouvre.'
          : `🎧 Tu es **${result.position}e** dans la file, soit environ **${seconds} secondes** d'attente. Je te ping quand ce sera ton tour.`,
      });
      return;
    }

    if (action === 'fallback') {
      const { dequeueMember } = await import('../services/moderation/voiceCaptchaService.js');
      const { deliverImageCaptcha } = await import('../services/moderation/captchaService.js');
      dequeueMember(guildId!, user.id);
      await deliverImageCaptcha(member, config, session.id);
      await interaction.editReply({ content: '✅ Un captcha image vient d\'être envoyé dans le salon de vérification.' });
      return;
    }

    await interaction.editReply({ content: '❌ Action inconnue.' });
    return;
  }

  // ── Protection anti-raid (raid mode, reports staff) ──────────────────
  if (customId.startsWith('rprot:')) {
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    const [, action, entityId] = customId.split(':');

    if (action === 'raidmode_off') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const { getRaidProtectionConfig, deactivateRaidMode } = await import('../services/moderation/raidProtectionService.js');
      const config = await getRaidProtectionConfig(guildId!);
      if (!config?.raidModeActive) {
        await interaction.editReply({ content: 'ℹ️ Le mode raid est déjà inactif.' });
        return;
      }
      await deactivateRaidMode(interaction.guild!, config);
      await interaction.editReply({ content: '✅ Mode raid désactivé.' });
      // Désactive le bouton sur le message d'alerte
      await interaction.message.edit({ components: [] }).catch(() => null);
      return;
    }

    if (action === 'invite_approve' || action === 'invite_reject') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const { approveInviteRequest, rejectInviteRequest } = await import('../services/moderation/inviteGuardService.js');
      const approved = action === 'invite_approve';
      const request = approved
        ? await approveInviteRequest(client, entityId, user.id)
        : await rejectInviteRequest(client, entityId, user.id);
      if (!request) {
        await interaction.editReply({ content: 'ℹ️ Cette demande a déjà été traitée.' });
        return;
      }
      await interaction.editReply({
        content: approved
          ? `✅ Invitation approuvée${request.approvedInviteCode ? ` - nouveau lien envoyé à <@${request.creatorId}> (\`${request.approvedInviteCode}\`)` : ' (recréation échouée, créateur prévenu)'}.`
          : '❌ Invitation rejetée, créateur prévenu.',
      });
      const original = interaction.message.embeds[0];
      if (original) {
        const { EmbedBuilder } = await import('discord.js');
        const updated = EmbedBuilder.from(original)
          .setColor(approved ? 0x57f287 : 0xed4245)
          .addFields({ name: 'Décision', value: `${approved ? '✅ Approuvée' : '❌ Rejetée'} par <@${user.id}>`, inline: false });
        await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => null);
      } else {
        await interaction.message.edit({ components: [] }).catch(() => null);
      }
      return;
    }

    if (action === 'report_resolve' || action === 'report_dismiss') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const { handleReportDecision } = await import('../services/moderation/reportService.js');
      const resolved = action === 'report_resolve';
      const report = await handleReportDecision(entityId, user.id, resolved);
      if (!report) {
        await interaction.editReply({ content: 'ℹ️ Ce signalement a déjà été traité.' });
        return;
      }
      await interaction.editReply({ content: resolved ? '✅ Signalement marqué comme traité.' : '🗑️ Signalement rejeté.' });
      // Fige l'embed staff : plus de boutons + note de traitement
      const original = interaction.message.embeds[0];
      if (original) {
        const { EmbedBuilder } = await import('discord.js');
        const updated = EmbedBuilder.from(original)
          .setColor(resolved ? 0x57f287 : 0x99aab5)
          .addFields({ name: 'Traitement', value: `${resolved ? '✅ Traité' : '🗑️ Rejeté'} par <@${user.id}>`, inline: false });
        await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => null);
      } else {
        await interaction.message.edit({ components: [] }).catch(() => null);
      }
      return;
    }
    return;
  }

  // ── Ban Hygiene (comptes supprimés) ──────────────────────────────────
  if (customId.startsWith('banhygiene:')) {
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires.", flags: [MessageFlags.Ephemeral] });
      return;
    }
    const { handleBanHygieneButton } = await import('../services/moderation/banHygieneService.js');
    await handleBanHygieneButton(interaction);
    return;
  }

  // ── Security Verification Buttons ────────────────────────────────────
  if (customId.startsWith('secverif_start_')) {
    const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';
    await handleVerifyButtonClick(interaction, DASHBOARD_URL);
    return;
  }

  if (customId.startsWith('secverif_validate:') || customId.startsWith('secverif_reject:')) {
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires.", flags: [MessageFlags.Ephemeral] });
      return;
    }
    await handleVerificationStaffAction(interaction);
    return;
  }

  // ── Warn-Threshold Verification Trigger (NOTIFY_STAFF mode) ──────────
  if (customId.startsWith('verif_threshold_trigger:')) {
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires pour lancer une vérification.", flags: [MessageFlags.Ephemeral] });
      return;
    }
    const targetUserId = customId.split(':')[1];
    if (!targetUserId) return;
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
      const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
      if (!targetUser) {
        await interaction.editReply({ content: '❌ Impossible de trouver cet utilisateur.' });
        return;
      }
      const targetMember = guildId ? await interaction.guild?.members.fetch(targetUserId).catch(() => null) ?? null : null;
      // Force-trigger the full auto path regardless of mode so staff can manually initiate
      const { createVerificationSession, buildVerificationUrl, buildVerificationEmbed } = await import('../services/moderation/securityVerificationService.js');
      const { getDashboardUrl } = await import('../api/shared.js');
      const { queueAuditLog } = await import('../utils/auditLogger.js');
      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId! },
        select: {
          verificationEmbedTitle: true,
          verificationEmbedDesc: true,
          verificationEmbedColor: true,
          verificationLevelCommand: true,
          verificationWarnReason: true,
        },
      });
      const dashboardUrl = getDashboardUrl();
      const token = await createVerificationSession(guildId!, targetUserId, (guildConfig?.verificationLevelCommand as any) || 'HIGH');
      const verifyUrl = buildVerificationUrl(dashboardUrl, guildId!, token);
      const { embed, row } = buildVerificationEmbed(
        interaction.guild?.name ?? 'Serveur',
        guildConfig?.verificationEmbedTitle ?? 'Vérification de sécurité',
        guildConfig?.verificationEmbedDesc ?? 'Vérifiez votre identité.',
        guildConfig?.verificationEmbedColor ?? '#5865F2',
        verifyUrl,
      );
      const reason = guildConfig?.verificationWarnReason ?? "Seuil d'avertissements atteint.";
      embed.addFields({ name: '⚠️ Raison', value: reason });

      // Timeout the member
      const TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
      let timeoutOk = false;
      if (targetMember?.moderatable) {
        await targetMember.timeout(TIMEOUT_MS, `Vérification forcée par ${user.tag} (seuil warns)`).then(() => { timeoutOk = true; }).catch(() => {});
      }
      let dmSent = false;
      try {
        await targetUser.send({ embeds: [embed], components: [row] });
        dmSent = true;
      } catch {}

      queueAuditLog({
        guildId: guildId!,
        user: `${user.tag} (${user.id})`,
        action: 'Vérification forcée via seuil warns (staff)',
        context: `${targetUser.tag} (${targetUser.id})`,
        module: 'Vérification',
        eventType: 'Manuel',
        details: `Lancée depuis le bouton de notification staff. Timeout: ${timeoutOk ? 'Oui' : 'Non'}. DM: ${dmSent ? 'Oui' : 'Non'}.`,
      });

      // Remove the button from the original message
      await interaction.message?.edit({ components: [] }).catch(() => {});

      await interaction.editReply({
        content: `✅ Vérification lancée pour <@${targetUserId}>.\n${!timeoutOk ? '⚠️ Timeout non appliqué (permissions).' : ''}\n${!dmSent ? '⚠️ DM non envoyé (MP fermés).' : ''}`.trim(),
      });
    } catch (err) {
      logger.error('InteractionHandler', 'Erreur verif_threshold_trigger:', err);
      await interaction.editReply({ content: '❌ Une erreur est survenue.' });
    }
    return;
  }


  // ── Double Account Buttons ───────────────────────────────────────────
  if (customId.startsWith('dc_')) {
    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId!))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires pour gérer les DCs.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    await handleDCInteraction(interaction);
    return;
  }

  if (customId.startsWith('meeting_rsvp:')) {
    const parts = customId.split(':');
    const meetingId = parts[1];
    const status = parts[2] as 'PRESENT' | 'ABSENT' | 'EXCUSED'; // issu du customId

    if (!status || !meetingId) return;

    if (!guildId) {
      await interaction.reply({ content: '❌ Action impossible hors serveur.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    const staffMember = await prisma.staffMember.findFirst({
      where: { guildId, userId: user.id },
    });

    if (!staffMember) {
      await interaction.reply({
        content: "❌ Vous ne faites pas partie de l'équipe staff enregistrée sur ce serveur.",
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    // Cas "S'excuser" -> On demande une raison via Modal
    if (status === 'EXCUSED') {
      const modal = new ModalBuilder()
        .setCustomId(`meeting_excuse_modal:${meetingId}`)
        .setTitle("Justification d'absence");

      const reasonInput = new TextInputBuilder()
        .setCustomId('excuse_reason')
        .setLabel('Raison de votre absence')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Expliquez pourquoi vous ne pouvez pas venir...')
        .setRequired(true)
        .setMaxLength(500);

      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    try {
      const labels: Record<string, string> = { 
        PRESENT: 'Présent ✅', 
        ABSENT: 'Absent ❌' 
      };

      await checkInMeeting(client, meetingId, staffMember.id, status);
      
      let response = `✅ Votre statut pour cette réunion est désormais : **${labels[status] || status}**.`;
      if (status === 'ABSENT') {
        response += '\n⚠️ **Note :** Une absence automatique a été enregistrée dans votre dossier pour cette réunion.';
      }

      await interaction.reply({
        content: response,
        flags: [MessageFlags.Ephemeral],
      });
    } catch (error) {
      logger.error('Handler', `Error during meeting RSVP: ${error}`);
      await interaction.reply({
        content: "❌ Une erreur est survenue lors de l'enregistrement de votre réponse.",
        flags: [MessageFlags.Ephemeral],
      });
    }
    return;
  }

  if (customId.startsWith('daily-algo-feedback:')) {
    if (!guildId) {
      await interaction.reply({
        content: '❌ Cette action doit être faite depuis le serveur.',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const submissionId = customId.split(':')[1];
    if (!submissionId) {
      await interaction.reply({
        content: '❌ Soumission introuvable.',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    prunePendingDailyAlgoDrafts();
    const key = pendingDailyAlgoDraftKey(submissionId, interaction.user.id);
    const draft = pendingDailyAlgoScoreDrafts.get(key);

    if (!draft) {
      await interaction.reply({
        content: '⚠️ Le brouillon de notation a expiré. Clique de nouveau sur **Noter**.',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const feedbackModal = new ModalBuilder()
      .setCustomId(`modal:daily-algo-feedback:${submissionId}`)
      .setTitle('🗒️ Explication de la note');

    const feedbackInput = new TextInputBuilder()
      .setCustomId('score_feedback')
      .setLabel('Pourquoi la note est < 5 ?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Explique ce qui va, ce qui manque, et comment améliorer la solution.')
      .setRequired(true)
      .setMaxLength(1000);

    feedbackModal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(feedbackInput),
    );

    await interaction.showModal(feedbackModal);
    return;
  }

  if (customId.startsWith('event-custom-register:')) {
    const eventId = customId.split(':')[1];
    if (eventId) {
      const { handleCustomEventRegisterButton } = await import('../services/features/eventService.js');
      await handleCustomEventRegisterButton(interaction, eventId);
    }
    return;
  }

  if (customId.startsWith('event-ctf-submit-flag-btn:')) {
    const eventId = customId.split(':')[1];
    if (!eventId) return;

    const modal = new ModalBuilder()
      .setCustomId(`modal:event-ctf-submit-flag:${eventId}`)
      .setTitle('🚩 Soumettre un Flag');

    const flagInput = new TextInputBuilder()
      .setCustomId('ctf_flag_input')
      .setLabel('Flag')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('FLAG{...}')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(flagInput));
    await interaction.showModal(modal);
    return;
  }

  if (customId.startsWith('event-ctf-progress-btn:')) {
    const eventId = customId.split(':')[1];
    if (!eventId) return;

    const { buildCtfParticipantProgress } = await import('../services/features/eventService.js');
    await buildCtfParticipantProgress(interaction, eventId);
    return;
  }

  if (customId.startsWith('event-ctf-leaderboard-btn:')) {
    const eventId = customId.split(':')[1];
    if (!eventId) return;

    const { buildCtfLeaderboard } = await import('../services/features/eventService.js');
    await buildCtfLeaderboard(interaction, eventId);
    return;
  }

  const eventRoute = parseEventQuizRoute(customId);
  if (eventRoute && eventRoute.optionIndex !== undefined) {
    await handleQuizInteraction(interaction, eventRoute.questionId, eventRoute.optionIndex);
    return;
  }

  const resultRoute = parseEventResultRoute(customId);
  if (resultRoute) {
    const results = await buildEventResultsView(interaction, resultRoute.eventId, resultRoute.page);
    await interaction.update(results);
    return;
  }

  if (customId.startsWith('event-stats:')) {
    const parts = customId.split(':');
    const eventId = parts[1];
    if (!eventId) {
      await interaction.reply({ content: '❌ Événement introuvable.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    try {
      const stats = await getEventStats(eventId);
      if (!stats) {
        await interaction.reply({ content: '❌ Aucune statistique disponible pour cet événement.', flags: [MessageFlags.Ephemeral] });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("📊 Statistiques de l'événement")
        .setDescription(stats.questionText ? truncate(stats.questionText, 200) : 'Distribution des réponses')
        .setColor(COLORS.info)
        .setTimestamp();

      const distribution = stats.distribution || {};
      const total = Object.values(distribution).reduce((s: number, v) => s + (Number(v) || 0), 0);

      (Object.keys(distribution) || []).forEach((k) => {
        const idx = parseInt(k, 10);
        const label = (stats.options && stats.options[idx]) ? stats.options[idx] : `Option ${idx + 1}`;
        const count = distribution[idx] ?? 0;
        embed.addFields({ name: `${label}`, value: `${count} vote(s)`, inline: true });
      });

      embed.addFields({ name: 'Total réponses', value: `${total}`, inline: true });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`event-result-page:${eventId}:0`).setLabel('🔍 Voir les détails').setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
    } catch (err) {
      logger.error('Handler', 'Error showing event stats:', err);
      await interaction.reply({ content: '❌ Erreur lors de la récupération des statistiques.', flags: [MessageFlags.Ephemeral] });
    }

    return;
  }

  if (customId === 'event-result-back') {
    const events = await prisma.event.findMany({
      where: {
        guildId: guildId!,
        participants: { some: { userId: interaction.user.id } }
      },
      orderBy: { createdAt: 'desc' },
      take: 25
    });
    
    const embed = new EmbedBuilder()
      .setTitle('📈 Tes Résultats de Quiz')
      .setDescription('Sélectionne un événement pour voir le détail de tes réponses.')
      .setColor(COLORS.info);

    const select = new StringSelectMenuBuilder()
      .setCustomId('event-result-select')
      .setPlaceholder('Sélectionne un quiz...')
      .addOptions(events.map(e => ({
        label: e.title.substring(0, 100),
        value: e.id,
        description: `Le ${e.createdAt.toLocaleDateString('fr-FR')}`
      })));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  if (!guildId) return;

  const setupStep = parseSetupStep(customId);
  if (setupStep) {
    const step = setupStep;

    if (step === 'step1') await sendSetupStep1(client, guildId, interaction);
    else if (step === 'step2') await sendSetupStep2(client, guildId, interaction);
    else if (step === 'step3') await sendSetupStep3(client, guildId, interaction);
    else if (step === 'finish') await sendSetupFinish(client, guildId, interaction);

    else if (step === 'trans_toggle') {
      await toggleGuildBoolean(guildId, 'translationEnabled');
      await sendSetupStep3(client, guildId, interaction);
    }
    return;
  }





  const validateRoute = parseValidateRoute(customId);
  if (validateRoute) {
    const { action, type, itemId } = validateRoute;

    const member = await resolveGuildMemberByUserId(interaction, user.id);
    if (!(await canModerate(member, guildId))) {
      await interaction.reply({ content: "❌ Vous n'avez pas le rôle modérateur requis pour cette action.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    // Rate action opens a modal - must NOT deferUpdate first
    if (action === 'rate' && type === 'daily-algo') {
      const ratingModal = new ModalBuilder()
        .setCustomId(`modal:daily-algo-rate:${itemId}`)
        .setTitle('📝 Noter la solution');

      const correctnessInput = new TextInputBuilder()
        .setCustomId('score_correctness')
        .setLabel('✅ Exactitude (fonctionnement / cas limites)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('1 à 5')
        .setRequired(true)
        .setMaxLength(1);

      const commentsInput = new TextInputBuilder()
        .setCustomId('score_comments')
        .setLabel('💬 Commentaires (clarté / explications)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('1 à 5')
        .setRequired(true)
        .setMaxLength(1);

      const compactnessInput = new TextInputBuilder()
        .setCustomId('score_compactness')
        .setLabel('📦 Compacité (efficacité / pas de superflu)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('1 à 5')
        .setRequired(true)
        .setMaxLength(1);

      const optimizationInput = new TextInputBuilder()
        .setCustomId('score_optimization')
        .setLabel('⚡ Optimisation (performance / runtime)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('1 à 5')
        .setRequired(true)
        .setMaxLength(1);

      const readabilityInput = new TextInputBuilder()
        .setCustomId('score_readability')
        .setLabel('🧹 Lisibilité (propreté / formatage)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('1 à 5')
        .setRequired(true)
        .setMaxLength(1);

      ratingModal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(correctnessInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(commentsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(compactnessInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(optimizationInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(readabilityInput),
      );

      await interaction.showModal(ratingModal);
      return;
    }

    await interaction.deferUpdate();



    if (action === 'reject') {
      if (type === 'daily-algo') {
        await reviewDailyAlgoSubmission({
          client,
          submissionId: itemId,
          action: 'reject',
          moderatorId: user.id,
        });
        logger.info('Handler', `Rejected daily algo submission ${itemId}`);
        return;
      }
    }

    if (action === 'dismiss') {
      if (type === 'daily-algo') {
        await reviewDailyAlgoSubmission({
          client,
          submissionId: itemId,
          action: 'dismiss',
          moderatorId: user.id,
        });
        logger.info('Handler', `Dismissed daily algo submission ${itemId} (hors-sujet, sans sanction)`);
        return;
      }
    }


    return;
  }


}



export async function handleSelectMenu(interaction: AnySelectMenuInteraction, client: Client): Promise<void> {
  const { customId, guildId, values } = interaction;

  if (customId.startsWith('help_')) {
    const { handleHelpInteraction } = await import('../commands/utility/help.js');
    await handleHelpInteraction(interaction);
    return;
  }

  // Verdict par sanction contestée, dans l'embed staff des appels
  if (customId.startsWith('appeal_item:') && interaction.isStringSelectMenu()) {
    const { handleAppealItemSelect } = await import('../services/moderation/banAppealService.js');
    await handleAppealItemSelect(client, customId, interaction);
    return;
  }

  // DM guild select for /ticket open in DMs
  if (customId === 'ticket:dm_guild_select' && interaction.isStringSelectMenu()) {
    const selectedGuildId = interaction.values[0];
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import('discord.js');
    const selectedGuild = client.guilds.cache.get(selectedGuildId);
    const modal = new ModalBuilder()
      .setCustomId(`modal:ticket:open:dm_direct:${selectedGuildId}`)
      .setTitle(`Ticket · ${selectedGuild?.name || 'Serveur'}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Sujet du ticket').setStyle(TextInputStyle.Short).setPlaceholder('Ex: Problème de rôles').setMaxLength(100).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Description détaillée').setStyle(TextInputStyle.Paragraph).setPlaceholder('Décrivez votre problème...').setMaxLength(1000).setRequired(true),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (!guildId) return;

  // Hub des menus contextuels (clic droit → « ⚡ Actions Kotbo »)
  if (customId.startsWith('ctxhub:') && interaction.isStringSelectMenu()) {
    const { handleHubSelect } = await import('../services/core/contextMenuHubService.js');
    await handleHubSelect(interaction);
    return;
  }

  // Verdict d'un pari, réservé aux administrateurs
  if (customId.startsWith('bet:winner:') && interaction.isStringSelectMenu()) {
    const { handleBetWinnerSelect } = await import('../services/community/clanBetService.js');
    await handleBetWinnerSelect(interaction);
    return;
  }

  // Menu déroulant des pages de présentation du thread d'accueil
  if (customId === 'wpage_select' && interaction.isStringSelectMenu()) {
    const { handleWelcomeMenuInteraction } = await import('../services/features/welcomeThreadService.js');
    await handleWelcomeMenuInteraction(interaction);
    return;
  }

  // Ticket system select menu
  if (customId === 'ticket:select_type' || customId === 'ticket:history_select') {
    if (!interaction.isStringSelectMenu()) return;
    await handleTicketSelectMenu(client, customId, interaction);
    return;
  }

  // Hub RPG (/rpg) - sélection d'objet en boutique/inventaire, choix de boss, reset admin
  if (customId.startsWith('rpg:')) {
    if (!interaction.isStringSelectMenu()) return;
    await handleRpgSelectMenu(client, customId, interaction);
    return;
  }

  const caseRoute = parseUserCaseRoute(customId);
  if (caseRoute?.action === 'section') {
    if (!interaction.isStringSelectMenu()) return;

    const member = await resolveGuildMemberByUserId(interaction, interaction.user.id);
    if (!(await canModerate(member, guildId))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires pour ouvrir un casier utilisateur.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    const section = values[0] as MemberCaseSection | undefined;
    if (!section) return;

    const panel = await buildMemberCasePanel(interaction.guild!, caseRoute.userId, section, caseRoute.pageIndex ?? 0);
    // embeds: [] vide les embeds des anciens panels legacy, requis pour la conversion en Components V2
    await interaction.update({ embeds: [], components: panel.components, files: panel.files, flags: [MessageFlags.IsComponentsV2] });
    return;
  }

  if (customId === 'event-result-select') {
    const eventId = interaction.values[0];
    const results = await buildEventResultsView(interaction, eventId, 0);
    await interaction.update(results);
    return;
  }

  if (caseRoute?.action === 'sanction_action') {
    if (!interaction.isStringSelectMenu()) return;
    const action = interaction.values[0]; // warn, timeout, kick, ban

    const member = await resolveGuildMemberByUserId(interaction, interaction.user.id);
    if (!(await canModerate(member, guildId))) {
      await interaction.reply({ content: "❌ Tu n'as pas les permissions nécessaires.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    const targetUserId = caseRoute.userId;
    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    const targetUsername = targetUser?.username ?? 'Utilisateur';

    await interaction.showModal(buildSanctionReasonModal(action, targetUserId, targetUsername));
    return;
  }



  if (customId.startsWith('cfg:')) {
    if (interaction.isChannelSelectMenu()) {
      await handleConfigChannelSelect(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleConfigSelectMenu(interaction);
    } else {
      return;
    }
    return;
  }

  const setupStep = parseSetupStep(customId);
  if (setupStep) {
    const step = setupStep;
    const val = await requireSingleSelectedValue(interaction, 'valeur');
    if (!val) return;

    if (step === 'select_config_channel') {
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { configChannelId: val },
        create: { id: guildId, configChannelId: val },
      });
      await sendSetupStep1(client, guildId, interaction);
    }
    else if (step === 'select_public_channel') {
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { publicChannelId: val },
        create: { id: guildId, publicChannelId: val },
      });
      await sendSetupStep1(client, guildId, interaction);
    }
    else if (step === 'select_mod_role') {
      await prisma.guild.update({ where: { id: guildId }, data: { moderatorRoleId: val } });
      await sendSetupStep2(client, guildId, interaction);
    }
    else if (step === 'trans_lang') {
      const targetLang = normalizeTargetLanguage(val);
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { defaultTranslateTo: targetLang },
        create: { id: guildId, defaultTranslateTo: targetLang },
      });
      await sendSetupStep3(client, guildId, interaction);
    }
    return;
  }

  const eventRoute = parseEventQuizRoute(customId);
  if (eventRoute && interaction.isStringSelectMenu()) {
    const optionIndex = parseInt(interaction.values[0], 10);
    await handleQuizInteraction(interaction, eventRoute.questionId, optionIndex);
    return;
  }
}

export async function handleModalSubmit(interaction: ModalSubmitInteraction, client: Client): Promise<void> {
  const { customId, guildId } = interaction;

  if (customId.startsWith('help_')) {
    const { handleHelpInteraction } = await import('../commands/utility/help.js');
    await handleHelpInteraction(interaction);
    return;
  }

  // DM ticket modal - must be before guildId check
  if (customId.startsWith('modal:ticket:open:dm_direct:')) {
    await handleTicketModalSubmit(client, customId, interaction);
    return;
  }

  // Commentaire de satisfaction : soumis depuis les DM (pas de guildId), doit rester avant le contrôle guildId
  if (customId.startsWith('satcomment_modal:')) {
    const [, satGuildId, ticketId] = customId.split(':');
    const rawComment = interaction.fields.getTextInputValue('comment') ?? '';

    const { recordSatisfactionComment, buildSatisfactionDoneEmbed, clearCommentPrompt, publishSatisfactionReview } = await import('../services/features/ticketSatisfactionService.js');
    const saved = rawComment.trim()
      ? await recordSatisfactionComment(satGuildId, ticketId, interaction.user.id, rawComment)
      : false;
    await clearCommentPrompt(satGuildId, ticketId, interaction.user.id);
    if (saved) void publishSatisfactionReview(client, satGuildId, ticketId, interaction.user.id);

    const stored = await prisma.ticketSatisfaction.findUnique({
      where: { guildId_ticketId_userId: { guildId: satGuildId, ticketId, userId: interaction.user.id } },
      select: { rating: true, comment: true },
    });

    // Le modal a été ouvert depuis le message du sondage : on peut le finaliser
    // directement plutôt que d'empiler une réponse éphémère.
    const finalEmbed = stored
      ? buildSatisfactionDoneEmbed(stored.rating, stored.comment)
      : new EmbedBuilder().setColor(COLORS.success).setTitle('Merci pour votre retour !').setTimestamp();

    if (interaction.isFromMessage()) {
      await interaction.update({ embeds: [finalEmbed], components: [], allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({
        content: saved ? '✅ Merci, votre commentaire a bien été enregistré.' : '✅ Merci pour votre retour.',
        flags: [MessageFlags.Ephemeral],
      });
    }
    return;
  }

  // Admin Permission Lock decision modals - can be submitted from a DM (no guildId), must be before guildId check
  if (customId.startsWith('adminlock_modal:')) {
    const { handleAdminLockModalSubmit } = await import('../services/moderation/adminLockService.js');
    await handleAdminLockModalSubmit(client, customId, interaction);
    return;
  }

  if (!guildId) return;

  // Hub RPG (/rpg) - création/rejoindre guilde, dépôt, payer, vendre, admin
  if (customId.startsWith('rpg:')) {
    await handleRpgModalSubmit(client, customId, interaction);
    return;
  }

  // Modals des actions du hub des menus contextuels
  if (customId.startsWith('ctxhub_modal:')) {
    const { handleHubModal } = await import('../services/core/contextMenuHubService.js');
    await handleHubModal(interaction);
    return;
  }

  // ── Report modal (menu contextuel « Signaler ce message ») ───────────
  if (customId.startsWith('report_modal:')) {
    const [, targetId, channelId, messageId] = customId.split(':');
    const reason = interaction.fields.getTextInputValue('reason');

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    // Récupère le contenu du message signalé (pour contexte staff)
    let messageContent: string | undefined;
    try {
      const channel = await interaction.guild?.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(messageId).catch(() => null);
        messageContent = message?.content || undefined;
      }
    } catch { /* le contexte est optionnel */ }

    const { createMemberReport } = await import('../services/moderation/reportService.js');
    const { describeReportError } = await import('../commands/moderation/report.js');
    const result = await createMemberReport({
      client,
      guild: interaction.guild!,
      reporter: interaction.user,
      targetId,
      reason,
      channelId,
      messageId,
      messageContent,
    });

    if (!result.ok) {
      await interaction.editReply({ content: `❌ ${describeReportError(result)}` });
    } else {
      await interaction.editReply({ content: '✅ Signalement envoyé au staff. Merci de contribuer à la sécurité du serveur. 🙏' });
    }
    return;
  }

  // Ban appeal decision modals (staff channel)
  if (customId.startsWith('appeal_modal:')) {
    const { handleAppealModalSubmit } = await import('../services/moderation/banAppealService.js');
    await handleAppealModalSubmit(client, customId, interaction);
    return;
  }

  if (customId.startsWith('custom-form-modal:')) {
    const parts = customId.split(':');
    const formId = parts[1];
    const eventId = parts[2];
    if (formId) {
      const { handleFormModalSubmit } = await import('../services/features/customFormService.js');
      await handleFormModalSubmit(interaction, formId, eventId || 'none');
    }
    return;
  }

  // ── Suggestion form modal ─────────────────────────────────────────────
  if (customId === 'suggest_form_modal') {
    const content = interaction.fields.getTextInputValue('suggestion_content');
    
    try {
      const { createSuggestion } = await import('../services/features/suggestionService.js');
      const suggestion = await createSuggestion(
        guildId,
        interaction.user.id,
        interaction.user.username,
        content,
        client
      );
      
      await interaction.reply({
        content: `💡 Votre suggestion a été publiée avec succès ! (ID : \`${suggestion.id}\`)`,
        flags: [MessageFlags.Ephemeral],
      });
    } catch (err: unknown) {
      await interaction.reply({
        content: `❌ Impossible de publier la suggestion : ${errorMessage(err) || 'erreur inconnue'}`,
        flags: [MessageFlags.Ephemeral],
      });
    }
    return;
  }

  if (customId === 'modal:resignation:open') {
    const reason = interaction.fields.getTextInputValue('reason');
    try {
      const staff = await prisma.staffMember.findFirst({
        where: { guildId, userId: interaction.user.id },
      });

      if (!staff) {
        await interaction.reply({ content: "❌ Vous ne faites pas partie de l'équipe Staff.", flags: [MessageFlags.Ephemeral] });
        return;
      }

      const resignation = await prisma.staffResignation.create({
        data: {
          guildId,
          staffUserId: staff.id,
          reason,
          status: 'PENDING'
        }
      });

      // MP Discord de confirmation au membre
      let dmMessageId: string | null = null;
      try {
        const serverName = interaction.guild?.name || '';
        const confirmEmbed = new EmbedBuilder()
          .setTitle('📨 Demande de démission reçue')
          .setDescription(
            `Votre demande de démission a bien été enregistrée et est en attente d'approbation par la direction.\n\n` +
            `**Motif fourni :**\n> ${reason}\n\n` +
            `Vous serez notifié de la décision finale. Vous pouvez suivre le statut dans votre profil sur le dashboard.`
          )
          .setColor(COLORS.info)
          .setTimestamp()
          .setFooter({ text: `Référence : ${resignation.id}${serverName ? ` · Serveur : ${serverName}` : ''}` });
        const dm = await interaction.user.send({ embeds: [confirmEmbed] }).catch(() => null);
        dmMessageId = dm?.id ?? null;
      } catch {
        // Silent fail si le MP est désactivé
      }

      if (dmMessageId) {
        await prisma.staffResignation.update({
          where: { id: resignation.id },
          data: { discordMpMessageId: dmMessageId }
        }).catch(() => null);
      }

      // Notifier les managers/admins via dashboard + MP Discord
      const managers = await prisma.staffMember.findMany({
        where: {
          guildId,
          grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] }
        }
      });

      if (managers.length > 0) {
        await Promise.all(managers.map(async (m: { userId: string; username: string | null }) => {
          // Notif dashboard
          await createNotification(
            guildId,
            m.userId,
            '🔔 Demande de démission',
            `${interaction.user.username} a soumis une demande de démission.\nMotif : ${reason}`,
            'WARNING',
            '/staff-management?tab=resignations',
            true
          ).catch(() => null);

          // MP Discord aux managers
          try {
            const managerDiscordUser = await client.users.fetch(m.userId).catch(() => null);
            if (managerDiscordUser) {
              const serverName = interaction.guild?.name || '';
              const managerEmbed = new EmbedBuilder()
                .setTitle('🔔 Nouvelle demande de démission')
                .setDescription(
                  `**${interaction.user.username}** (${interaction.user.id}) a soumis une demande de démission.\n\n` +
                  `**Motif :**\n> ${reason}\n\n` +
                  `Rendez-vous sur le dashboard pour approuver ou refuser cette demande.`
                )
                .setColor(COLORS.warning)
                .setTimestamp()
                .setFooter({ text: `Référence : ${resignation.id}${serverName ? ` · Serveur : ${serverName}` : ''}` });
              await managerDiscordUser.send({ embeds: [managerEmbed] }).catch(() => null);
            }
          } catch {
            // Silent fail
          }
        }));
      }

      await interaction.reply({
        content: '✅ Votre demande de démission a été soumise avec succès aux managers pour approbation. Vous recevrez une notification de leur décision.',
        flags: [MessageFlags.Ephemeral]
      });
    } catch (err) {
      logger.error('Handler', 'Error during resignation modal submit:', err);
      await interaction.reply({
        content: "❌ Une erreur est survenue lors de l'enregistrement de votre demande.",
        flags: [MessageFlags.Ephemeral]
      });
    }
    return;
  }
  if (customId.startsWith('modal:event-ctf-submit-flag:')) {
    const eventId = customId.split(':')[2];
    if (!eventId) return;

    const flag = interaction.fields.getTextInputValue('ctf_flag_input');
    const { handleCtfFlagSubmission } = await import('../services/features/eventService.js');
    await handleCtfFlagSubmission(interaction, eventId, flag);
    return;
  }
  if (customId.startsWith('modal:ticket:')) {
    await handleTicketModalSubmit(client, customId, interaction);
    return;
  }

  if (customId.startsWith('meeting_excuse_modal:')) {
    const meetingId = customId.split(':')[1];
    const reason = interaction.fields.getTextInputValue('excuse_reason');

    if (!meetingId) return;

    const staffMember = await prisma.staffMember.findFirst({
      where: { guildId, userId: interaction.user.id },
    });

    if (!staffMember) {
      await interaction.reply({ content: '❌ Membre non trouvé.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    try {
      await checkInMeeting(client, meetingId, staffMember.id, 'EXCUSED', reason);
      await interaction.reply({
        content: `✅ Votre excuse a été enregistrée : *${reason}*.`,
        flags: [MessageFlags.Ephemeral]
      });
    } catch (error) {
      logger.error('Handler', `Error during meeting excuse modal submit: ${error}`);
      await interaction.reply({
        content: "❌ Une erreur est survenue lors de l'enregistrement de votre excuse.",
        flags: [MessageFlags.Ephemeral]
      });
    }
    return;
  }

  if (customId.startsWith('sanction_modal:')) {
    const parts = customId.split(':');
    const action = parts[1];
    const targetUserId = parts[2];
    if (!targetUserId) return;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const reason = interaction.fields.getTextInputValue('reason');
    const durationInput = action === 'timeout' ? interaction.fields.getTextInputValue('duration') : null;

    const member = await resolveGuildMemberByUserId(interaction, interaction.user.id);
    if (!(await canModerate(member, interaction.guildId!))) {
      await interaction.editReply("❌ Vous n'avez pas les permissions.");
      return;
    }

    const executor = interaction.user;

    try {
      const targetUser = await client.users.fetch(targetUserId).catch(() => null);
      const target = {
        id: targetUserId,
        tag: targetUser?.tag || 'Utilisateur inconnu',
      };
      const moderator = {
        id: executor.id,
        tag: executor.tag,
      };

      if (action === 'warn') {
        await registerWarnSanction({
          guildId: interaction.guildId!,
          target,
          moderator,
          reason,
          client,
        });
        const warnCount = await prisma.sanction.count({
          where: { guildId: interaction.guildId!, targetUserId, type: SanctionType.WARN },
        });
        await interaction.editReply({ embeds: [successEmbed('Avertissement appliqué', `L'avertissement a bien été enregistré. (Warn #${warnCount})`)] });
      } else if (action === 'timeout') {
        const durationMs = parseDurationToMs(durationInput || '');
        if (!durationMs) {
          await interaction.editReply({ embeds: [errorEmbed('Durée invalide', 'Le format de la durée est invalide.')] });
          return;
        }
        const targetMember = await interaction.guild?.members.fetch(targetUserId).catch(() => null);
        if (!targetMember) {
          await interaction.editReply({ embeds: [errorEmbed('Membre introuvable', "L'utilisateur n'est pas sur ce serveur.")] });
          return;
        }
        await registerTimeoutSanction({
          guildId: interaction.guildId!,
          target,
          moderator,
          reason,
          durationMs,
          member: targetMember,
          client,
        });
        await interaction.editReply({ embeds: [successEmbed('Timeout appliqué', `Le timeout de ${durationInput} a bien été enregistré.`)] });
      } else if (action === 'kick') {
        await registerKickSanction({
          guildId: interaction.guildId!,
          target,
          moderator,
          reason,
          client,
        });
        await interaction.editReply({ embeds: [successEmbed('Expulsion appliquée', `L'utilisateur a été expulsé.`)] });
      } else if (action === 'ban') {
        await registerBanSanction({
          guildId: interaction.guildId!,
          target,
          moderator,
          reason,
          client,
        });
        await interaction.editReply({ embeds: [successEmbed('Bannissement appliqué', `L'utilisateur a été banni.`)] });
      }
    } catch (error) {
      await interaction.editReply({ embeds: [errorEmbed('Erreur', error instanceof Error ? error.message : 'Une erreur est survenue.')] });
    }
    return;
  }

  // ── Daily Algo Rating Modal ──────────────────────────────────────────────
  if (customId.startsWith('modal:daily-algo-rate:')) {
    const submissionId = customId.split(':')[2];
    if (!submissionId) return;

    const parseScore = (raw: string): number | null => {
      const n = Number.parseInt(raw.trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > 5) return null;
      return n;
    };

    const correctness = parseScore(interaction.fields.getTextInputValue('score_correctness'));
    const comments = parseScore(interaction.fields.getTextInputValue('score_comments'));
    const compactness = parseScore(interaction.fields.getTextInputValue('score_compactness'));
    const optimization = parseScore(interaction.fields.getTextInputValue('score_optimization'));
    const readability = parseScore(interaction.fields.getTextInputValue('score_readability'));

    if (correctness === null || comments === null || compactness === null || optimization === null || readability === null) {
      await interaction.reply({
        content: '❌ Chaque note doit être un nombre entre **1** et **5**.',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const hasLowScore = [correctness, comments, compactness, optimization, readability].some((score) => score < 5);

    if (hasLowScore) {
      prunePendingDailyAlgoDrafts();
      const key = pendingDailyAlgoDraftKey(submissionId, interaction.user.id);
      pendingDailyAlgoScoreDrafts.set(key, {
        submissionId,
        moderatorId: interaction.user.id,
        createdAt: Date.now(),
        scores: { correctness, comments, compactness, optimization, readability },
      });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`daily-algo-feedback:${submissionId}`)
          .setLabel("🗒️ Ajouter l'explication")
          .setStyle(ButtonStyle.Primary),
      );

      await interaction.reply({
        content: `⚠️ Tu as mis au moins une note inférieure à **5/5**.\nAjoute maintenant une explication pour que le participant comprenne comment s'améliorer.`,
        components: [row],
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    let success = false;
    try {
      success = await reviewDailyAlgoSubmission({
        client,
        submissionId,
        action: 'approve',
        moderatorId: interaction.user.id,
        scores: { correctness, comments, compactness, optimization, readability },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Impossible de valider cette soumission.';
      await interaction.editReply({ content: `❌ ${message}` });
      return;
    }

    if (!success) {
      await interaction.editReply({ content: '❌ Soumission introuvable ou déjà notée.' });
      return;
    }

    const avg = ((correctness + comments + compactness + optimization + readability) / 5).toFixed(1);
    await interaction.editReply({
      content: `✅ **Solution notée !** Moyenne : **${avg}/5**\n\n✅ ${correctness}/5 · 💬 ${comments}/5 · 📦 ${compactness}/5 · ⚡ ${optimization}/5 · 🧹 ${readability}/5\n\nLe classement du Daily Algo a été mis à jour.`,
    });
    logger.success('Handler', `Rated daily algo submission ${submissionId} (${avg}/5) by ${interaction.user.username}`);
    return;
  }

  // ── Daily Algo Feedback Modal ────────────────────────────────────────────
  if (customId.startsWith('modal:daily-algo-feedback:')) {
    const submissionId = customId.split(':')[2];
    if (!submissionId) return;

    prunePendingDailyAlgoDrafts();
    const key = pendingDailyAlgoDraftKey(submissionId, interaction.user.id);
    const draft = pendingDailyAlgoScoreDrafts.get(key);

    if (!draft) {
      await interaction.reply({
        content: '⚠️ Le brouillon de notation a expiré. Clique de nouveau sur **Noter**.',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const feedback = interaction.fields.getTextInputValue('score_feedback').trim();
    if (!feedback) {
      await interaction.reply({
        content: '❌ Une explication est obligatoire quand une note est inférieure à 5/5.',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    let success = false;
    try {
      success = await reviewDailyAlgoSubmission({
        client,
        submissionId,
        action: 'approve',
        moderatorId: interaction.user.id,
        scores: draft.scores,
        feedback,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Impossible de valider cette soumission.';
      await interaction.editReply({ content: `❌ ${message}` });
      return;
    } finally {
      pendingDailyAlgoScoreDrafts.delete(key);
    }

    if (!success) {
      await interaction.editReply({ content: '❌ Soumission introuvable ou déjà notée.' });
      return;
    }

    const avg = ((draft.scores.correctness + draft.scores.comments + draft.scores.compactness + draft.scores.optimization + draft.scores.readability) / 5).toFixed(1);
    await interaction.editReply({
      content: `✅ **Solution notée avec explication !** Moyenne : **${avg}/5**\n\n✅ ${draft.scores.correctness}/5 · 💬 ${draft.scores.comments}/5 · 📦 ${draft.scores.compactness}/5 · ⚡ ${draft.scores.optimization}/5 · 🧹 ${draft.scores.readability}/5`,
    });
    logger.success('Handler', `Rated daily algo submission ${submissionId} with feedback (${avg}/5) by ${interaction.user.username}`);
    return;
  }

  if (customId.startsWith('cfg:')) {
    await handleConfigModal(interaction);
    return;
  }

  // ── Signal User Modal ───────────────────────────────────────────────────
  if (customId.startsWith('modal:signal:')) {
    const targetUserId = customId.split(':')[2];
    const reason = interaction.fields.getTextInputValue('raison').trim();

    if (!targetUserId) return;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    if (!targetUser) {
      await interaction.editReply({
        embeds: [errorEmbed('Utilisateur introuvable', 'Impossible de trouver cet utilisateur Discord.')],
      });
      return;
    }

    const success = await sendReportToAdmin({
      client,
      reporter: interaction.user,
      target: targetUser,
      reason,
      guildName: interaction.guild?.name ?? 'Message Privé',
      guildId: interaction.guildId ?? 'N/A',
    });

    if (success) {
      await interaction.editReply({
        embeds: [successEmbed('Signalement envoyé', `L'utilisateur ${targetUser} a été signalé avec succès à l'administrateur du bot.`)],
      });
    } else {
      await interaction.editReply({
        embeds: [errorEmbed("Échec de l'envoi", "Impossible de transmettre le signalement à l'administrateur du bot.")],
      });
    }
    return;
  }

  // ── Moderator Note Modal ────────────────────────────────────────────────
  if (customId.startsWith('modal:moderator-note:')) {
    const targetUserId = customId.split(':')[2];
    const noteContent = interaction.fields.getTextInputValue('note_content').trim();

    if (!targetUserId) return;

    // Le profil peut ne pas exister encore : on lui pose son identité Discord
    // plutôt que de créer une ligne anonyme, illisible dans la liste des membres.
    const noteMember = interaction.guild
      ? interaction.guild.members.cache.get(targetUserId)
        ?? await interaction.guild.members.fetch(targetUserId).catch(() => null)
      : null;

    await prisma.memberProfile.upsert({
      where: {
        guildId_userId: {
          guildId,
          userId: targetUserId,
        },
      },
      update: { moderatorNote: noteContent },
      create: {
        guildId,
        userId: targetUserId,
        ...(noteMember ? memberProfileIdentity(noteMember) : {}),
        moderatorNote: noteContent,
      },
    });

    // Modal ouvert depuis le panel casier : re-render le résumé avec la note à jour.
    if (interaction.isFromMessage() && interaction.guild) {
      const panel = await buildMemberCasePanel(interaction.guild, targetUserId, 'resume', 0);
      await renderPanelTarget(interaction, {
        embeds: [],
        components: panel.components,
        files: panel.files,
        flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
      });
      return;
    }

    await interaction.reply({
      content: `✅ Note modérateur mise à jour pour <@${targetUserId}>.`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }
}
