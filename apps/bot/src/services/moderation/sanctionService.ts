import type { Sanction } from '@prisma/client';
import { EmbedBuilder, Guild, GuildMember, type Client } from 'discord.js';
import { Prisma, SanctionStatus, SanctionType } from '@prisma/client';
import { kotboEventBus } from '@kotbo/core';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { queueAuditLog } from '../../utils/auditLogger.js';
import { COLORS } from '../../utils/embeds.js';
import { notifyDashboardSanctionReportRequired } from '../../api/dashboardApi.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { createNotification } from '../staff/staffLeadershipService.js';
import * as altAccountService from './altAccountService.js';
import { getMissingReportReminderActions, type MissingReportReminderState } from './sanctionReportReminderPolicy.js';
import { archiveScoreFilter } from './sanctionArchiveService.js';

const MAX_DISCORD_TIMEOUT_MS = 27 * 24 * 60 * 60 * 1000;
const RENEWAL_BUFFER_MS = 60 * 1000;
const SANCTION_DEDUPE_WINDOW_MS = 30 * 1000;
let hasLoggedSanctionSchemaMismatch = false;

type Actor = {
  id: string;
  tag: string;
};

type Target = {
  id: string;
  tag: string;
};

async function touchSanctionTargetIdentity(params: { guildId: string; userId: string; userTag: string }): Promise<void> {
  // Le tag reste la seule identité disponible ici : on en tire aussi le pseudo,
  // sans quoi le profil créé s'affiche en « Utilisateur inconnu » dans la liste
  // des membres. Les tags hérités portent encore un discriminant `#0000`.
  const username = params.userTag.split('#')[0] || null;

  await prisma.memberProfile.upsert({
    where: {
      guildId_userId: {
        guildId: params.guildId,
        userId: params.userId,
      },
    },
    create: {
      guildId: params.guildId,
      userId: params.userId,
      userTag: params.userTag,
      username,
      lastSeenAt: new Date(),
    },
    update: {
      userTag: params.userTag,
      lastSeenAt: new Date(),
    },
  });
}

/**
 * Annonce la sanction sur le bus.
 *
 * N'est appelée que pour une sanction prononcée maintenant : la reprise d'un
 * historique (`registerImportedSanction`) rejouerait des mois de modération
 * auprès des abonnés, workflows compris.
 */
function publishSanctionApplied(sanction: Sanction): void {
  kotboEventBus.publish('sanction:applied', {
    guildId: sanction.guildId,
    targetId: sanction.targetUserId,
    targetTag: sanction.targetTag ?? '',
    moderatorId: sanction.moderatorUserId,
    moderatorTag: sanction.moderatorTag ?? '',
    type: sanction.type,
    reason: sanction.reason,
    duration: sanction.durationSeconds,
    sanctionId: sanction.id,
    timestamp: Date.now(),
  });
  broadcastDashboardStateChange(sanction.guildId, 'sanctions_updated');
}

function getDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function incrementModerationStats(guildId: string, type: SanctionType): Promise<void> {
  const dateKey = getDateKey();
  const updateData: Record<string, unknown> = { sanctionsCount: { increment: 1 } };

  if (type === SanctionType.WARN) updateData.warnsCount = { increment: 1 };
  else if (type === SanctionType.KICK) updateData.kicksCount = { increment: 1 };
  else if (type === SanctionType.TIMEOUT) updateData.timeoutsCount = { increment: 1 };
  else if (type === SanctionType.BAN || type === SanctionType.TEMP_BAN || type === SanctionType.SOFTBAN) updateData.bansCount = { increment: 1 };

  await prisma.guildDailyStat.upsert({
    where: { guildId_dateKey: { guildId, dateKey } },
    create: {
      guildId,
      dateKey,
      sanctionsCount: 1,
      warnsCount: type === SanctionType.WARN ? 1 : 0,
      kicksCount: type === SanctionType.KICK ? 1 : 0,
      timeoutsCount: type === SanctionType.TIMEOUT ? 1 : 0,
      bansCount: (type === SanctionType.BAN || type === SanctionType.TEMP_BAN || type === SanctionType.SOFTBAN) ? 1 : 0,
    },
    update: updateData,
  }).catch((error) => {
    logger.debug('Analytics', `Guild moderation stat error: ${String(error)}`);
  });
}

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  seconde: 1000,
  secondes: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  heure: 60 * 60 * 1000,
  heures: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  j: 24 * 60 * 60 * 1000,
  jour: 24 * 60 * 60 * 1000,
  jours: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  semaine: 7 * 24 * 60 * 60 * 1000,
  semaines: 7 * 24 * 60 * 60 * 1000,
};

function normalizeDurationInput(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ');
}

export function parseDurationToMs(input: string): number | null {
  const normalized = normalizeDurationInput(input);
  if (!normalized) return null;

  const pattern = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
  let total = 0;
  let matched = false;

  for (const match of normalized.matchAll(pattern)) {
    const rawValue = match[1];
    const rawUnit = match[2];
    if (!rawValue || !rawUnit) continue;

    const value = Number(rawValue);
    const unit = rawUnit.toLowerCase();
    const unitMs = DURATION_UNITS_MS[unit];

    if (!Number.isFinite(value) || value <= 0 || !unitMs) {
      return null;
    }

    total += Math.round(value * unitMs);
    matched = true;
  }

  if (!matched) return null;
  if (total < 1000) return null;
  return total;
}

export function formatDurationFr(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} jour${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} heure${hours > 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  if (seconds > 0 && parts.length === 0) parts.push(`${seconds} seconde${seconds > 1 ? 's' : ''}`);

  return parts.join(' ');
}

function buildActionReason(reason: string, moderatorTag: string): string {
  const base = reason.trim().slice(0, 350);
  return `${base} | Modération: ${moderatorTag}`;
}

function nextRenewalAt(now: Date, chunkMs: number): Date {
  const next = new Date(now.getTime() + chunkMs - RENEWAL_BUFFER_MS);
  if (next <= now) {
    return new Date(now.getTime() + 1000);
  }
  return next;
}

function isSanctionsSchemaMismatchError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== 'P2021' && error.code !== 'P2022') {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('sanction') || message.includes('nextactionat');
}

async function applyTimeoutChunk(member: GuildMember, durationMs: number, reason: string): Promise<void> {
  const safeMs = Math.max(1000, Math.min(durationMs, MAX_DISCORD_TIMEOUT_MS));
  await member.timeout(safeMs, reason);
}

async function findRecentSanction(params: {
  guildId: string;
  type: SanctionType;
  targetUserId: string;
  moderatorUserId: string;
}) {
  return prisma.sanction.findFirst({
    where: {
      guildId: params.guildId,
      type: params.type,
      targetUserId: params.targetUserId,
      moderatorUserId: params.moderatorUserId,
      createdAt: { gte: new Date(Date.now() - SANCTION_DEDUPE_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export function formatSanctionDurationLabel(seconds: number | null): string | null {
  if (!seconds) return null;

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];

  if (days) parts.push(`${days}j`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(' ') : `${seconds}s`;
}

async function createAutomaticReport(params: SanctionReportReminderInput) {
  const staffPseudo = params.moderatorTag?.trim() || `Modérateur ${params.moderatorUserId}`;
  const memberPseudo = params.targetTag?.trim() || `Utilisateur ${params.targetUserId}`;
  const memberReference = params.targetUserId;
  const sanctionDurationLabel = formatSanctionDurationLabel(params.durationSeconds ?? null);
  const incidentAt = new Date();
  const brokenRules = JSON.stringify([]);
  const detailedReason = params.reason || 'Rapport créé automatiquement (rapports manuels désactivés).';

  await prisma.sanctionReport.create({
    data: {
      guildId: params.guildId,
      sanctionId: params.sanctionId,
      staffPseudo,
      incidentAt,
      memberPseudo,
      memberReference,
      sanctionType: params.sanctionType,
      sanctionDurationLabel,
      brokenRules,
      detailedReason,
      evidenceLinks: params.evidenceLinks || [],
      createdByUserId: params.moderatorUserId,
      createdByTag: params.moderatorTag,
    }
  });
}

type SanctionReportReminderInput = {
  guildId: string;
  sanctionId: string;
  sanctionType: SanctionType;
  targetTag: string | null;
  targetUserId: string;
  moderatorTag: string | null;
  moderatorUserId: string;
  durationSeconds?: number | null;
  reason?: string | null;
  evidenceLinks?: string[];
};

/**
 * Projette une sanction persistee vers la charge utile du rappel de rapport.
 *
 * Les six appels a `emitSanctionReportReminder` de ce fichier repetaient cette
 * meme projection champ par champ. `extras` couvre les seules variations
 * reelles entre les appels (la presence ou non de `evidenceLinks`).
 */
function reportReminderPayload(
  sanction: Sanction,
  extras: Partial<SanctionReportReminderInput> = {},
): SanctionReportReminderInput {
  return {
    guildId: sanction.guildId,
    sanctionId: sanction.id,
    sanctionType: sanction.type,
    targetTag: sanction.targetTag,
    targetUserId: sanction.targetUserId,
    moderatorTag: sanction.moderatorTag,
    moderatorUserId: sanction.moderatorUserId,
    durationSeconds: sanction.durationSeconds,
    reason: sanction.reason,
    ...extras,
  };
}

/**
 * Vrai si la cible de la sanction est un bot.
 *
 * On lit `MemberProfile.isBot`, renseigne par le scraper de membres : le
 * service n'a pas de client Discord sous la main, et la sanction ne stocke pas
 * la nature de sa cible. Un profil absent ou pas encore scrape repond `false`,
 * donc le rapport est produit comme avant - le repli va vers le comportement
 * historique plutot que vers un silence.
 */
async function isSanctionTargetBot(guildId: string, targetUserId: string): Promise<boolean> {
  try {
    const profile = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId: targetUserId } },
      select: { isBot: true },
    });
    return profile?.isBot === true;
  } catch {
    return false;
  }
}

async function emitSanctionReportReminder(params: SanctionReportReminderInput) {
  try {
    // Vérifier si le module de sanctions et les rapports sont activés
    const { getOrCreateFeatureConfigs } = await import('../core/dashboardManagementService.js');
    const featureConfigs = await getOrCreateFeatureConfigs(params.guildId);
    const sanctionsFeature = featureConfigs.find((c) => c.featureKey === 'sanctions');
    const isModuleEnabled = sanctionsFeature ? sanctionsFeature.enabled : true;

    const guild = await prisma.guild.findUnique({
      where: { id: params.guildId },
      select: { sanctionReportEnabled: true, sanctionReportSkipBots: true }
    });

    // Sanction sur un bot : ni rappel, ni rapport automatique. Contrairement au
    // cas « rapports desactives » ci-dessous, on ne cree meme pas de brouillon -
    // il n'y a rien a documenter, et un rapport fantome pollue les statistiques.
    if (guild?.sanctionReportSkipBots && (await isSanctionTargetBot(params.guildId, params.targetUserId))) {
      return;
    }

    if (!isModuleEnabled || !guild?.sanctionReportEnabled) {
      // Rapports désactivés ou module inactif, on crée le rapport automatiquement en arrière-plan
      await createAutomaticReport(params).catch((err) => {
        logger.error('Sanctions', `Erreur lors de la création du rapport automatique pour la sanction ${params.sanctionId}:`, err);
      });
      return;
    }

    // Prefill draft report with matched rules and empty evidence links
    const sanction = await prisma.sanction.findUnique({
      where: { id: params.sanctionId },
      include: { sanctionTable: true }
    });
    const tableName = sanction?.sanctionTable?.name;

    const regulationRules = await prisma.guildRegulationArticle.findMany({
      where: { guildId: params.guildId }
    });

    const matchedRules: unknown[] = [];
    if (tableName) {
      const matchedRule = regulationRules.find(r => 
        r.title.toLowerCase().includes(tableName.toLowerCase()) ||
        tableName.toLowerCase().includes(r.title.toLowerCase())
      );
      if (matchedRule) {
        matchedRules.push({
          id: matchedRule.id,
          title: matchedRule.title,
          description: matchedRule.description || matchedRule.title
        });
      }
    }
    
    if (matchedRules.length === 0 && params.reason) {
      const matchedRule = regulationRules.find(r => 
        params.reason!.toLowerCase().includes(r.title.toLowerCase())
      );
      if (matchedRule) {
        matchedRules.push({
          id: matchedRule.id,
          title: matchedRule.title,
          description: matchedRule.description || matchedRule.title
        });
      }
    }

    if (matchedRules.length === 0) {
      matchedRules.push({
        id: 'auto_command',
        title: tableName || 'Infraction',
        description: params.reason || 'Sanction appliquée via la commande'
      });
    }

    const brokenRulesPayload = JSON.stringify(matchedRules);

    const existingReport = await prisma.sanctionReport.findFirst({
      where: { sanctionId: params.sanctionId }
    });

    if (!existingReport) {
      const staffPseudo = params.moderatorTag?.trim() || `Modérateur ${params.moderatorUserId}`;
      const memberPseudo = params.targetTag?.trim() || `Utilisateur ${params.targetUserId}`;
      const memberReference = params.targetUserId;
      const sanctionDurationLabel = formatSanctionDurationLabel(params.durationSeconds ?? null);
      const incidentAt = new Date();
      const detailedReason = params.reason || 'Rapport pré-rempli via la commande.';

      await prisma.sanctionReport.create({
        data: {
          guildId: params.guildId,
          sanctionId: params.sanctionId,
          staffPseudo,
          incidentAt,
          memberPseudo,
          memberReference,
          sanctionType: params.sanctionType,
          sanctionDurationLabel,
          brokenRules: brokenRulesPayload,
          detailedReason,
          evidenceLinks: params.evidenceLinks || [],
          createdByUserId: params.moderatorUserId,
          createdByTag: params.moderatorTag,
        }
      });
    }

    // Notification temps réel (WS)
    await notifyDashboardSanctionReportRequired({
      guildId: params.guildId,
      sanctionId: params.sanctionId,
      sanctionType: params.sanctionType,
      targetTag: params.targetTag ?? `Utilisateur ${params.targetUserId}`,
      moderatorTag: params.moderatorTag ?? `Modérateur ${params.moderatorUserId}`,
    });

    // Notification persistante (Inbox)
    await createNotification(
      params.guildId,
      params.moderatorUserId,
      'Rapport de sanction requis',
      `Vous devez remplir un rapport pour la sanction appliquée à ${params.targetTag || params.targetUserId}.`,
      'WARNING',
      '/sanctions'
    ).catch(() => null);

  } catch (error) {
    logger.warn(
      'Sanctions',
      `Notification dashboard/création brouillon impossible pour la sanction ${params.sanctionId}: ${error instanceof Error ? error.message : 'erreur inconnue'}`,
    );
  }
}

type SanctionNotificationInput = Pick<
  Sanction,
  'type' | 'targetUserId' | 'targetTag' | 'moderatorTag' | 'moderatorUserId' | 'reason'
> & Partial<Pick<Sanction, 'guildId' | 'durationSeconds' | 'expiresAt'>>;

async function resolveStaffToNotify(guildId: string, sanction: SanctionNotificationInput): Promise<Set<string>> {
  const userIdsToNotify = new Set<string>();

  if (sanction.targetUserId) {
    const targetStaff = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId: sanction.targetUserId } }
    });

    if (targetStaff) {
      const grades = await prisma.staffMemberHierarchyGrade.findMany({
        where: { staffMemberId: targetStaff.id },
        include: {
          hierarchy: true
        }
      });

      for (const hGrade of grades) {
        const headUserId = hGrade.hierarchy.responsableUserId;
        if (headUserId) {
          userIdsToNotify.add(headUserId);
        }
      }
    }
  }

  // Éviter de notifier la cible elle-même (elle reçoit déjà un message d'avertissement séparé)
  if (sanction.targetUserId) {
    userIdsToNotify.delete(sanction.targetUserId);
  }

  // Éviter de notifier le modérateur lui-même de sa propre sanction (doublon avec le rappel de rapport)
  if (sanction.moderatorUserId) {
    userIdsToNotify.delete(sanction.moderatorUserId);
  }

  return userIdsToNotify;
}

function sanctionTypeLabel(type: string): string {
  return {
    WARN: 'Avertissement',
    KICK: 'Exclusion',
    TIMEOUT: 'Timeout',
    TEMP_BAN: 'Bannissement temporaire',
    BAN: 'Bannissement définitif',
    SOFTBAN: 'Softban',
  }[type] || 'Sanction';
}

async function notifyStaffOfSanction(guildId: string, sanction: SanctionNotificationInput) {
  const userIdsToNotify = await resolveStaffToNotify(guildId, sanction);
  const typeLabel = sanctionTypeLabel(sanction.type);

  for (const userId of userIdsToNotify) {
    await createNotification(
      guildId,
      userId,
      `${typeLabel} : ${sanction.targetTag}`,
      `${sanction.moderatorTag} a appliqué un ${typeLabel.toLowerCase()} à ${sanction.targetTag} pour : ${sanction.reason}`,
      sanction.type === 'BAN' || sanction.type === 'TEMP_BAN' ? 'ERROR' : 'WARNING',
      `/members/${sanction.targetUserId}`,
      true // On envoie un MP car ce sont uniquement les personnes directement concernées
    ).catch(() => null);
  }
}

/**
 * Notifie le staff une seule fois pour une sanction propagée sur plusieurs comptes liés (DC),
 * au lieu d'une notification par compte synchronisé (cf. altAccountService.synchronizeSanction).
 */
export async function notifyStaffOfSyncedSanction(
  guildId: string,
  originalSanction: SanctionNotificationInput,
  syncedTargetTags: string[],
) {
  if (syncedTargetTags.length === 0) return;

  const userIdsToNotify = await resolveStaffToNotify(guildId, originalSanction);
  const typeLabel = sanctionTypeLabel(originalSanction.type);
  const othersList = syncedTargetTags.join(', ');

  for (const userId of userIdsToNotify) {
    await createNotification(
      guildId,
      userId,
      `${typeLabel} : ${originalSanction.targetTag} (+ comptes liés)`,
      `${originalSanction.moderatorTag} a appliqué un ${typeLabel.toLowerCase()} à ${originalSanction.targetTag} pour : ${originalSanction.reason}. Synchronisé sur ${syncedTargetTags.length} compte(s) lié(s) : ${othersList}.`,
      originalSanction.type === 'BAN' || originalSanction.type === 'TEMP_BAN' ? 'ERROR' : 'WARNING',
      `/members/${originalSanction.targetUserId}`,
      true
    ).catch(() => null);
  }
}

async function propagateSanction(client: Client, originalGuildId: string, sanction: SanctionNotificationInput) {
  const originalGuild = await prisma.guild.findUnique({
    where: { id: originalGuildId },
    select: { propagateSanctions: true }
  });

  if (!originalGuild?.propagateSanctions) return;

  const otherGuilds = await prisma.guild.findMany({
    where: {
      id: { not: originalGuildId },
      sanctionSyncEnabled: true,
      sanctionAlertChannelId: { not: null }
    }
  });

  for (const guildConfig of otherGuilds) {
    try {
      const guild = client.guilds.cache.get(guildConfig.id) || await client.guilds.fetch(guildConfig.id).catch(() => null);
      if (!guild) continue;

      const channel = guild.channels.cache.get(guildConfig.sanctionAlertChannelId!) || await guild.channels.fetch(guildConfig.sanctionAlertChannelId!).catch(() => null);
      if (!channel || !('send' in channel)) continue;

      const typeLabel = {
        WARN: 'Avertissement',
        KICK: 'Exclusion',
        TIMEOUT: 'Timeout',
        TEMP_BAN: 'Bannissement temporaire',
        BAN: 'Bannissement définitif'
      }[sanction.type as string] || 'Sanction';

      const embed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('⚠️ Propagation de Sanction')
        .setDescription(`Un utilisateur a été sanctionné sur un autre serveur Kotbo.`)
        .addFields(
          { name: 'Utilisateur', value: `${sanction.targetTag} (<@${sanction.targetUserId}>)`, inline: true },
          { name: 'Type', value: typeLabel, inline: true },
          { name: 'Raison', value: sanction.reason || 'Aucune raison fournie', inline: false },
          { name: 'Source', value: guild.name, inline: true }
        )
        .setTimestamp();

      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
    } catch (err) {
      logger.debug('Sanctions', `Error propagating sanction to guild ${guildConfig.id}: ${String(err)}`);
    }
  }
}

/**
 * Envoie au membre le DM « tu peux contester » quand le module Appels l'active
 * pour ce type. Reserve aux sanctions ou le membre reste joignable (warn,
 * timeout) : pour un kick ou un ban, le DM doit partir avant l'action.
 */
function notifyAppealableSanction(client: Client | undefined, sanction: Sanction): void {
  if (!client) return;
  void (async () => {
    const { sendSanctionAppealDM } = await import('./banAppealService.js');
    await sendSanctionAppealDM(client, sanction.guildId, {
      id: sanction.id,
      targetUserId: sanction.targetUserId,
      type: sanction.type,
      reason: sanction.reason,
    });
  })().catch(() => null);
}

export async function registerWarnSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  reason: string;
  client?: Client;
  isSync?: boolean;
  evidenceLinks?: string[];
  /** Poids du warn (1 = léger, 2 = normal, 3 = grave). Utilisé par le score pondéré. */
  weight?: number;
}) {
  const existing = await findRecentSanction({
    guildId: params.guildId,
    type: SanctionType.WARN,
    targetUserId: params.target.id,
    moderatorUserId: params.moderator.id,
  });

  if (existing) return existing;

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: SanctionType.WARN,
      status: SanctionStatus.RESOLVED,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      weight: Math.min(3, Math.max(1, params.weight ?? 1)),
      resolvedAt: new Date(),
      resolutionNote: 'Avertissement enregistré.'
    }
  });

  queueAuditLog({
    guildId: params.guildId,
    user: `${params.moderator.tag} (${params.moderator.id})`,
    action: 'Sanction - Avertissement',
    context: `${params.target.tag} (${params.target.id})`,
    module: 'Modération',
    eventType: 'Discord',
    details: `Type: Avertissement | Cible: ${params.target.tag} (${params.target.id}) | Modérateur: ${params.moderator.tag} | Raison: ${params.reason}`,
  });

  publishSanctionApplied(sanction);

  void incrementModerationStats(params.guildId, SanctionType.WARN).catch(() => null);

  void touchSanctionTargetIdentity({
    guildId: params.guildId,
    userId: params.target.id,
    userTag: params.target.tag,
  }).catch(() => null);

  await emitSanctionReportReminder(
    reportReminderPayload(sanction, { evidenceLinks: params.evidenceLinks }),
  ).catch(() => null);

  if (!params.isSync) {
    void notifyStaffOfSanction(params.guildId, sanction).catch(() => null);
  }

  // Notifier l'utilisateur concerné (si profil existant)
  await createNotification(
    params.guildId,
    params.target.id,
    'Avertissement reçu',
    `Vous avez reçu un avertissement pour la raison suivante : ${params.reason}`,
    'WARNING',
    '/profile'
  ).catch(() => null);

  if (params.client && !params.isSync) {
    void propagateSanction(params.client, params.guildId, sanction).catch(() => null);
    void altAccountService.synchronizeSanction({
      client: params.client,
      guildId: params.guildId,
      originalUserId: params.target.id,
      type: SanctionType.WARN,
      moderator: params.moderator,
      reason: params.reason,
      evidenceLinks: params.evidenceLinks
    }).catch(() => null);

    // Déclencher la vérification automatique si le seuil de warns est atteint.
    // Centralisé ici pour couvrir tous les warns (commande, automod, tableaux…).
    // Import dynamique : verificationWarnThresholdService importe countWarns d'ici (dép. circulaire).
    void (async () => {
      const client = params.client!;
      const { checkAndTriggerVerificationThreshold } = await import('./verificationWarnThresholdService.js');
      const targetUser = await client.users.fetch(params.target.id).catch(() => null);
      if (!targetUser) return;
      const guild = await client.guilds.fetch(params.guildId).catch(() => null);
      const targetMember = guild ? await guild.members.fetch(params.target.id).catch(() => null) : null;
      await checkAndTriggerVerificationThreshold({
        client,
        guildId: params.guildId,
        targetUser,
        targetMember,
      });
    })().catch(() => null);
  }

  if (!params.isSync) notifyAppealableSanction(params.client, sanction);

  return sanction;
}

export async function registerKickSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  reason: string;
  client?: Client;
  isSync?: boolean;
  evidenceLinks?: string[];
}) {
  const existing = await findRecentSanction({
    guildId: params.guildId,
    type: SanctionType.KICK,
    targetUserId: params.target.id,
    moderatorUserId: params.moderator.id,
  });

  if (existing) return existing;

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: SanctionType.KICK,
      status: SanctionStatus.RESOLVED,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      resolvedAt: new Date(),
      resolutionNote: 'Exclusion exécutée.'
    }
  });

  queueAuditLog({
    guildId: params.guildId,
    user: `${params.moderator.tag} (${params.moderator.id})`,
    action: 'Sanction - Expulsion',
    context: `${params.target.tag} (${params.target.id})`,
    module: 'Modération',
    eventType: 'Discord',
    details: `Type: Expulsion | Cible: ${params.target.tag} (${params.target.id}) | Modérateur: ${params.moderator.tag} | Raison: ${params.reason}`,
  });

  publishSanctionApplied(sanction);

  void incrementModerationStats(params.guildId, SanctionType.KICK).catch(() => null);

  void touchSanctionTargetIdentity({
    guildId: params.guildId,
    userId: params.target.id,
    userTag: params.target.tag,
  }).catch(() => null);

  await emitSanctionReportReminder(
    reportReminderPayload(sanction, { evidenceLinks: params.evidenceLinks }),
  );

  if (!params.isSync) {
    void notifyStaffOfSanction(params.guildId, sanction).catch(() => null);
  }

  if (params.client && !params.isSync) {
    void propagateSanction(params.client, params.guildId, sanction).catch(() => null);
    void altAccountService.synchronizeSanction({
      client: params.client,
      guildId: params.guildId,
      originalUserId: params.target.id,
      type: SanctionType.KICK,
      moderator: params.moderator,
      reason: params.reason,
      evidenceLinks: params.evidenceLinks
    }).catch(() => null);
  }

  return sanction;
}

export async function registerBanSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  reason: string;
  temporaryDurationMs?: number;
  client?: Client;
  isSync?: boolean;
  evidenceLinks?: string[];
}) {
  const isTemporary = Boolean(params.temporaryDurationMs && params.temporaryDurationMs > 0);
  const sanctionType = isTemporary ? SanctionType.TEMP_BAN : SanctionType.BAN;
  const existing = await findRecentSanction({
    guildId: params.guildId,
    type: sanctionType,
    targetUserId: params.target.id,
    moderatorUserId: params.moderator.id,
  });

  if (existing) return existing;

  const now = new Date();
  const expiresAt = isTemporary ? new Date(now.getTime() + (params.temporaryDurationMs as number)) : null;

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: sanctionType,
      status: isTemporary ? SanctionStatus.ACTIVE : SanctionStatus.RESOLVED,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      durationSeconds: isTemporary ? Math.floor((params.temporaryDurationMs as number) / 1000) : null,
      expiresAt,
      nextActionAt: expiresAt,
      resolvedAt: isTemporary ? null : now,
      resolutionNote: isTemporary ? 'Bannissement temporaire actif.' : 'Bannissement définitif exécuté.'
    }
  });

  queueAuditLog({
    guildId: params.guildId,
    user: `${params.moderator.tag} (${params.moderator.id})`,
    action: isTemporary ? 'Sanction - Bannissement temporaire' : 'Sanction - Bannissement définitif',
    context: `${params.target.tag} (${params.target.id})`,
    module: 'Modération',
    eventType: 'Discord',
    details: `Type: ${isTemporary ? 'Bannissement temporaire' : 'Bannissement définitif'}${isTemporary ? ` | Durée: ${Math.floor(params.temporaryDurationMs! / 1000)}s` : ''} | Cible: ${params.target.tag} (${params.target.id}) | Modérateur: ${params.moderator.tag} | Raison: ${params.reason}`,
  });

  publishSanctionApplied(sanction);

  void incrementModerationStats(params.guildId, sanctionType).catch(() => null);

  void touchSanctionTargetIdentity({
    guildId: params.guildId,
    userId: params.target.id,
    userTag: params.target.tag,
  }).catch(() => null);

  await emitSanctionReportReminder(
    reportReminderPayload(sanction, { evidenceLinks: params.evidenceLinks }),
  );

  if (!params.isSync) {
    void notifyStaffOfSanction(params.guildId, sanction).catch(() => null);
  }

  if (params.client && !params.isSync) {
    void propagateSanction(params.client, params.guildId, sanction).catch(() => null);
    void altAccountService.synchronizeSanction({
      client: params.client,
      guildId: params.guildId,
      originalUserId: params.target.id,
      type: sanctionType,
      moderator: params.moderator,
      reason: params.reason,
      durationMs: params.temporaryDurationMs,
      evidenceLinks: params.evidenceLinks
    }).catch(() => null);
  }

  return sanction;
}

export async function registerSoftbanSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  reason: string;
  client?: Client;
  isSync?: boolean;
  evidenceLinks?: string[];
}) {
  const existing = await findRecentSanction({
    guildId: params.guildId,
    type: SanctionType.SOFTBAN,
    targetUserId: params.target.id,
    moderatorUserId: params.moderator.id,
  });

  if (existing) return existing;

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: SanctionType.SOFTBAN,
      status: SanctionStatus.RESOLVED,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      resolvedAt: new Date(),
      resolutionNote: 'Softban exécuté (ban puis déban immédiat).'
    }
  });

  queueAuditLog({
    guildId: params.guildId,
    user: `${params.moderator.tag} (${params.moderator.id})`,
    action: 'Sanction - Softban',
    context: `${params.target.tag} (${params.target.id})`,
    module: 'Modération',
    eventType: 'Discord',
    details: `Type: Softban | Cible: ${params.target.tag} (${params.target.id}) | Modérateur: ${params.moderator.tag} | Raison: ${params.reason}`,
  });

  publishSanctionApplied(sanction);

  void incrementModerationStats(params.guildId, SanctionType.SOFTBAN).catch(() => null);

  void touchSanctionTargetIdentity({
    guildId: params.guildId,
    userId: params.target.id,
    userTag: params.target.tag,
  }).catch(() => null);

  await emitSanctionReportReminder(
    reportReminderPayload(sanction, { evidenceLinks: params.evidenceLinks }),
  );

  if (!params.isSync) {
    void notifyStaffOfSanction(params.guildId, sanction).catch(() => null);
  }

  if (params.client && !params.isSync) {
    void propagateSanction(params.client, params.guildId, sanction).catch(() => null);
    void altAccountService.synchronizeSanction({
      client: params.client,
      guildId: params.guildId,
      originalUserId: params.target.id,
      type: SanctionType.SOFTBAN,
      moderator: params.moderator,
      reason: params.reason,
      evidenceLinks: params.evidenceLinks
    }).catch(() => null);
  }

  return sanction;
}

export async function registerTimeoutSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  reason: string;
  durationMs: number;
  member: GuildMember;
  client?: Client;
  isSync?: boolean;
  evidenceLinks?: string[];
}) {
  const existing = await findRecentSanction({
    guildId: params.guildId,
    type: SanctionType.TIMEOUT,
    targetUserId: params.target.id,
    moderatorUserId: params.moderator.id,
  });

  if (existing) return existing;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.durationMs);
  const chunkMs = Math.min(params.durationMs, MAX_DISCORD_TIMEOUT_MS);

  await applyTimeoutChunk(params.member, chunkMs, buildActionReason(params.reason, params.moderator.tag));

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: SanctionType.TIMEOUT,
      status: SanctionStatus.ACTIVE,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      durationSeconds: Math.floor(params.durationMs / 1000),
      expiresAt,
      nextActionAt: nextRenewalAt(now, chunkMs),
      resolutionNote: 'Timeout actif.'
    }
  });

  queueAuditLog({
    guildId: params.guildId,
    user: `${params.moderator.tag} (${params.moderator.id})`,
    action: 'Sanction - Exclusion temporaire',
    context: `${params.target.tag} (${params.target.id})`,
    module: 'Modération',
    eventType: 'Discord',
    details: `Type: Exclusion temporaire | Durée: ${Math.floor(params.durationMs / 1000)}s | Cible: ${params.target.tag} (${params.target.id}) | Modérateur: ${params.moderator.tag} | Raison: ${params.reason}`,
  });

  publishSanctionApplied(sanction);

  void incrementModerationStats(params.guildId, SanctionType.TIMEOUT).catch(() => null);

  void touchSanctionTargetIdentity({
    guildId: params.guildId,
    userId: params.target.id,
    userTag: params.target.tag,
  }).catch(() => null);

  await emitSanctionReportReminder(
    reportReminderPayload(sanction, { evidenceLinks: params.evidenceLinks }),
  );

  if (!params.isSync) {
    void notifyStaffOfSanction(params.guildId, sanction).catch(() => null);
  }

  if (params.client && !params.isSync) {
    void propagateSanction(params.client, params.guildId, sanction).catch(() => null);
    void altAccountService.synchronizeSanction({
      client: params.client,
      guildId: params.guildId,
      originalUserId: params.target.id,
      type: SanctionType.TIMEOUT,
      moderator: params.moderator,
      reason: params.reason,
      durationMs: params.durationMs,
      evidenceLinks: params.evidenceLinks
    }).catch(() => null);
  }

  if (!params.isSync) notifyAppealableSanction(params.client, sanction);

  return sanction;
}

export async function registerObservedTimeoutSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  reason: string;
  expiresAt: Date;
}) {
  const existing = await findRecentSanction({
    guildId: params.guildId,
    type: SanctionType.TIMEOUT,
    targetUserId: params.target.id,
    moderatorUserId: params.moderator.id,
  });

  if (existing) return existing;

  const now = new Date();
  const remainingMs = Math.max(1000, params.expiresAt.getTime() - now.getTime());
  const chunkMs = Math.min(remainingMs, MAX_DISCORD_TIMEOUT_MS);

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: SanctionType.TIMEOUT,
      status: SanctionStatus.ACTIVE,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      durationSeconds: Math.floor(remainingMs / 1000),
      expiresAt: params.expiresAt,
      nextActionAt: nextRenewalAt(now, chunkMs),
      resolutionNote: 'Timeout observé et synchronisé.'
    }
  });

  publishSanctionApplied(sanction);

  void incrementModerationStats(params.guildId, SanctionType.TIMEOUT).catch(() => null);

  await emitSanctionReportReminder(reportReminderPayload(sanction));

  return sanction;
}

/**
 * Enregistre une sanction historique importée depuis un autre bot de modération
 * (Sapphire, Mee6, Dyno, RaidProtect...). Contrairement aux `register*Sanction`
 * ci-dessus, ne déclenche aucune action Discord (kick/ban/timeout réel), aucune
 * notification staff ni DM à la cible : l'action a déjà eu lieu ailleurs, on ne
 * fait qu'enregistrer la trace dans le casier Kotbo.
 */
export async function registerImportedSanction(params: {
  guildId: string;
  type: SanctionType;
  target: Target;
  moderator: Actor;
  reason: string;
  createdAt: Date;
  durationSeconds?: number | null;
  sourceLabel?: string;
}) {
  const isTimedType = params.type === SanctionType.TIMEOUT || params.type === SanctionType.TEMP_BAN;
  const durationSeconds = isTimedType && params.durationSeconds && params.durationSeconds > 0
    ? Math.floor(params.durationSeconds)
    : null;
  const expiresAt = durationSeconds
    ? new Date(params.createdAt.getTime() + durationSeconds * 1000)
    : null;
  const isStillActive = isTimedType && expiresAt ? expiresAt.getTime() > Date.now() : false;

  const sanction = await prisma.sanction.create({
    data: {
      guildId: params.guildId,
      type: params.type,
      status: isStillActive ? SanctionStatus.ACTIVE : SanctionStatus.RESOLVED,
      targetUserId: params.target.id,
      targetTag: params.target.tag,
      moderatorUserId: params.moderator.id,
      moderatorTag: params.moderator.tag,
      reason: params.reason,
      durationSeconds,
      expiresAt,
      nextActionAt: isStillActive ? expiresAt : null,
      resolvedAt: isStillActive ? null : (expiresAt ?? params.createdAt),
      resolutionNote: params.sourceLabel
        ? `Sanction importée depuis ${params.sourceLabel}.`
        : 'Sanction importée depuis un fichier externe.',
      createdAt: params.createdAt,
    },
  });

  queueAuditLog({
    guildId: params.guildId,
    user: `${params.moderator.tag} (${params.moderator.id})`,
    action: 'Sanction - Import',
    context: `${params.target.tag} (${params.target.id})`,
    module: 'Modération',
    eventType: 'Manuel',
    details: `Type: ${params.type} | Cible: ${params.target.tag} (${params.target.id}) | Modérateur: ${params.moderator.tag} | Raison: ${params.reason}${params.sourceLabel ? ` | Source: ${params.sourceLabel}` : ''}`,
  });

  void incrementModerationStats(params.guildId, params.type).catch(() => null);

  void touchSanctionTargetIdentity({
    guildId: params.guildId,
    userId: params.target.id,
    userTag: params.target.tag,
  }).catch(() => null);

  return sanction;
}

export async function resolveActiveTimeoutSanction(params: {
  guildId: string;
  targetUserId: string;
  resolutionNote?: string;
}) {
  const now = new Date();
  const activeTimeouts = await prisma.sanction.findMany({
    where: {
      guildId: params.guildId,
      targetUserId: params.targetUserId,
      type: SanctionType.TIMEOUT,
      status: SanctionStatus.ACTIVE,
    },
  });

  if (activeTimeouts.length === 0) return;

  await prisma.sanction.updateMany({
    where: {
      id: { in: activeTimeouts.map((t) => t.id) },
    },
    data: {
      status: SanctionStatus.RESOLVED,
      resolvedAt: now,
      nextActionAt: null,
      resolutionNote: params.resolutionNote ?? 'Timeout retiré/levé.',
    },
  });

  logger.info('Sanctions', `Timeout résolu pour ${params.targetUserId} sur la guilde ${params.guildId}`);
  broadcastDashboardStateChange(params.guildId, 'sanctions_updated');
}

export async function processScheduledSanctions(client: Client): Promise<void> {
  try {
    await processTimeoutRenewals(client);
    await processTempBans(client);

    hasLoggedSanctionSchemaMismatch = false;
  } catch (error) {
    if (!isSanctionsSchemaMismatchError(error)) {
      throw error;
    }

    if (!hasLoggedSanctionSchemaMismatch) {
      hasLoggedSanctionSchemaMismatch = true;
      logger.error(
        'Sanctions',
        'Schéma Prisma des sanctions non synchronisé (table/colonne manquante). Lancez `bun db:push` (ou `bun db:migrate`) puis redémarrez le bot.'
      );
    }
  }
}

async function processTimeoutRenewals(client: Client): Promise<void> {
  const now = new Date();

  const sanctions = await prisma.sanction.findMany({
    where: {
      type: SanctionType.TIMEOUT,
      status: SanctionStatus.ACTIVE,
      expiresAt: { not: null },
      nextActionAt: { lte: now }
    },
    orderBy: { nextActionAt: 'asc' },
    take: 50
  });

  for (const sanction of sanctions) {
    const expiresAt = sanction.expiresAt;
    if (!expiresAt) continue;

    try {
      const guild = await client.guilds.fetch(sanction.guildId).catch(() => null);
      if (!guild) {
        await prisma.sanction.update({
          where: { id: sanction.id },
          data: {
            status: SanctionStatus.FAILED,
            resolvedAt: new Date(),
            resolutionNote: 'Serveur introuvable pour renouveler le timeout.'
          }
        });
        continue;
      }

      const member = await guild.members.fetch(sanction.targetUserId).catch(() => null);
      if (!member) {
        await prisma.sanction.update({
          where: { id: sanction.id },
          data: {
            status: SanctionStatus.FAILED,
            resolvedAt: new Date(),
            resolutionNote: 'Membre introuvable pour renouveler le timeout.'
          }
        });
        continue;
      }

      const remainingMs = expiresAt.getTime() - now.getTime();
      if (remainingMs <= 0) {
        await member.timeout(null, 'Timeout expiré automatiquement').catch(() => null);
        await prisma.sanction.update({
          where: { id: sanction.id },
          data: {
            status: SanctionStatus.RESOLVED,
            resolvedAt: new Date(),
            nextActionAt: null,
            resolutionNote: 'Timeout expiré automatiquement.'
          }
        });
        continue;
      }

      const chunkMs = Math.min(remainingMs, MAX_DISCORD_TIMEOUT_MS);
      await applyTimeoutChunk(member, chunkMs, buildActionReason(sanction.reason, sanction.moderatorTag ?? sanction.moderatorUserId));

      const refreshedNow = new Date();
      const refreshedRemainingMs = expiresAt.getTime() - refreshedNow.getTime();
      const refreshedChunk = Math.min(Math.max(1000, refreshedRemainingMs), MAX_DISCORD_TIMEOUT_MS);

      await prisma.sanction.update({
        where: { id: sanction.id },
        data: {
          nextActionAt: nextRenewalAt(refreshedNow, refreshedChunk),
          resolutionNote: refreshedRemainingMs > MAX_DISCORD_TIMEOUT_MS
            ? 'Timeout prolongé automatiquement.'
            : 'Dernière fenêtre de timeout en cours.'
        }
      });
    } catch (error) {
      logger.error('Sanctions', `Erreur renouvellement timeout ${sanction.id}:`, error);
      await prisma.sanction.update({
        where: { id: sanction.id },
        data: {
          status: SanctionStatus.FAILED,
          resolvedAt: new Date(),
          nextActionAt: null,
          resolutionNote: `Échec du renouvellement du timeout: ${error instanceof Error ? error.message : 'erreur inconnue'}`
        }
      }).catch(() => null);
    }
  }
}

async function processTempBans(client: Client): Promise<void> {
  const now = new Date();

  const sanctions = await prisma.sanction.findMany({
    where: {
      type: SanctionType.TEMP_BAN,
      status: SanctionStatus.ACTIVE,
      expiresAt: { lte: now }
    },
    orderBy: { expiresAt: 'asc' },
    take: 50
  });

  for (const sanction of sanctions) {
    try {
      const guild = await client.guilds.fetch(sanction.guildId).catch(() => null);
      if (!guild) {
        await prisma.sanction.update({
          where: { id: sanction.id },
          data: {
            status: SanctionStatus.FAILED,
            resolvedAt: new Date(),
            nextActionAt: null,
            resolutionNote: 'Serveur introuvable pour débannir automatiquement.'
          }
        });
        continue;
      }

      await guild.members.unban(sanction.targetUserId, 'Tempban expiré automatiquement').catch(() => null);

      await prisma.sanction.update({
        where: { id: sanction.id },
        data: {
          status: SanctionStatus.RESOLVED,
          resolvedAt: new Date(),
          nextActionAt: null,
          resolutionNote: 'Tempban expiré et levé automatiquement.'
        }
      });
    } catch (error) {
      logger.error('Sanctions', `Erreur de levée tempban ${sanction.id}:`, error);
      await prisma.sanction.update({
        where: { id: sanction.id },
        data: {
          status: SanctionStatus.FAILED,
          resolvedAt: new Date(),
          nextActionAt: null,
          resolutionNote: `Échec de levée du tempban: ${error instanceof Error ? error.message : 'erreur inconnue'}`
        }
      }).catch(() => null);
    }
  }
}

function normalizeTargetUserIds(targetUserId: string, targetUserIds?: string[]): string[] {
  const ids = (targetUserIds && targetUserIds.length > 0 ? targetUserIds : [targetUserId])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return Array.from(new Set(ids));
}

function buildTargetUserWhere(targetUserId: string, targetUserIds?: string[]) {
  const ids = normalizeTargetUserIds(targetUserId, targetUserIds);
  return ids.length === 1 ? { targetUserId: ids[0] } : { targetUserId: { in: ids } };
}

/**
 * Compte les warns d'un membre. Les warns archivés sont exclus, sauf si la
 * guilde a activé `countArchivedInWarnScore` : archiver, c'est désactiver.
 */
export async function countWarns(guildId: string, targetUserId: string, targetUserIds?: string[]): Promise<number> {
  return prisma.sanction.count({
    where: {
      guildId,
      ...buildTargetUserWhere(targetUserId, targetUserIds),
      ...(await archiveScoreFilter(guildId)),
      type: SanctionType.WARN
    }
  });
}

/**
 * Score de warns d'un membre, pondération incluse si activée sur la guilde.
 *
 * - warnWeightingEnabled désactivé → compte brut (comportement historique).
 * - Activé → somme des poids (1/2/3) des warns encore « vivants » :
 *   si warnDecayDays est défini, seuls les warns plus récents que N jours comptent.
 *
 * Dans les deux cas les warns archivés sont écartés, à moins que la guilde
 * n'ait activé `countArchivedInWarnScore`.
 *
 * Les seuils existants (vérif auto, escalade) comparent ce score au même
 * nombre configuré : un seuil de 3 = 3 warns légers ou 1 warn grave.
 */
export async function getWarnScore(
  guildId: string,
  targetUserId: string,
  targetUserIds?: string[],
): Promise<number> {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { warnWeightingEnabled: true, warnDecayDays: true },
  });

  if (!guildConfig?.warnWeightingEnabled) {
    return countWarns(guildId, targetUserId, targetUserIds);
  }

  const decayCutoff = guildConfig.warnDecayDays
    ? new Date(Date.now() - guildConfig.warnDecayDays * 24 * 60 * 60 * 1000)
    : null;

  const result = await prisma.sanction.aggregate({
    where: {
      guildId,
      ...buildTargetUserWhere(targetUserId, targetUserIds),
      ...(await archiveScoreFilter(guildId)),
      type: SanctionType.WARN,
      ...(decayCutoff ? { createdAt: { gte: decayCutoff } } : {}),
    },
    _sum: { weight: true },
  });

  return result._sum.weight ?? 0;
}

export interface ListedSanction {
  id: string;
  type: SanctionType;
  status: SanctionStatus;
  reason: string;
  durationSeconds: number | null;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  moderatorTag: string | null;
  moderatorUserId: string;
  /** Non nul = sanction archivée : conservée, mais hors casier actif. */
  archivedAt: Date | null;
  archiveReason: string | null;
  /** false = contestation verrouillée par le staff. */
  appealable: boolean;
}

/**
 * Casier paginé d'un membre.
 *
 * Les sanctions archivées restent listées par défaut (le staff doit pouvoir les
 * consulter) mais sont marquées via `archivedAt` ; `includeArchived: false`
 * rend la vue « casier actif ». `archivedTotal` permet d'afficher le compte des
 * archives sans seconde requête.
 */
export async function listSanctionsByMember(params: {
  guildId: string;
  targetUserId: string;
  targetUserIds?: string[];
  page: number;
  pageSize: number;
  includeArchived?: boolean;
}): Promise<{ total: number; archivedTotal: number; sanctions: ListedSanction[] }> {
  const page = Math.max(0, params.page);
  const pageSize = Math.max(1, Math.min(20, params.pageSize));
  const targetUserWhere = buildTargetUserWhere(params.targetUserId, params.targetUserIds);
  const includeArchived = params.includeArchived !== false;
  const archiveWhere = includeArchived ? {} : { archivedAt: null };

  const [total, archivedTotal, sanctions] = await prisma.$transaction([
    prisma.sanction.count({
      where: {
        guildId: params.guildId,
        ...targetUserWhere,
        ...archiveWhere,
      },
    }),
    prisma.sanction.count({
      where: {
        guildId: params.guildId,
        ...targetUserWhere,
        archivedAt: { not: null },
      },
    }),
    prisma.sanction.findMany({
      where: {
        guildId: params.guildId,
        ...targetUserWhere,
        ...archiveWhere,
      },
      orderBy: { createdAt: 'desc' },
      skip: page * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        durationSeconds: true,
        expiresAt: true,
        resolvedAt: true,
        createdAt: true,
        moderatorTag: true,
        moderatorUserId: true,
        archivedAt: true,
        archiveReason: true,
        appealable: true,
      },
    }),
  ]);

  return { total, archivedTotal, sanctions };
}

export async function getSanctionTypeBreakdown(guildId: string, targetUserId: string, targetUserIds?: string[]): Promise<Record<SanctionType, number>> {
  const targetUserWhere = buildTargetUserWhere(targetUserId, targetUserIds);

  const rows = await prisma.sanction.groupBy({
    by: ['type'],
    where: {
      guildId,
      ...targetUserWhere,
      ...(await archiveScoreFilter(guildId)),
    },
    _count: {
      type: true,
    },
  });

  const breakdown: Record<SanctionType, number> = {
    WARN: 0,
    KICK: 0,
    TIMEOUT: 0,
    TEMP_BAN: 0,
    BAN: 0,
    SOFTBAN: 0,
  };

  for (const row of rows) {
    breakdown[row.type] = row._count.type;
  }

  return breakdown;
}

export async function createSanctionReport(params: {
  guildId: string;
  sanctionId?: string | null;
  staffPseudo: string;
  incidentAt: Date;
  memberPseudo: string;
  memberReference: string;
  sanctionType: SanctionType;
  sanctionDurationLabel?: string | null;
  brokenRules: string;
  detailedReason: string;
  evidenceLinks: string[];
  additionalNotes?: string | null;
  createdByUserId: string;
  createdByTag?: string | null;
  client?: Client;
}) {
  const report = await prisma.sanctionReport.create({
    data: {
      guildId: params.guildId,
      sanctionId: params.sanctionId ?? null,
      staffPseudo: params.staffPseudo,
      incidentAt: params.incidentAt,
      memberPseudo: params.memberPseudo,
      memberReference: params.memberReference,
      sanctionType: params.sanctionType,
      sanctionDurationLabel: params.sanctionDurationLabel ?? null,
      brokenRules: params.brokenRules,
      detailedReason: params.detailedReason,
      evidenceLinks: params.evidenceLinks,
      additionalNotes: params.additionalNotes ?? null,
      createdByUserId: params.createdByUserId,
      createdByTag: params.createdByTag ?? null,
    }
  });

  if (params.client) {
    await announceSanctionReportToStaff(params.client, report).catch((err) =>
      logger.warn('SanctionService', `Impossible d'annoncer le rapport ${report.id} sur le serveur staff :`, err),
    );
  }

  broadcastDashboardStateChange(params.guildId, 'sanctions_updated');

  return report;
}

/**
 * Poste l'embed d'un nouveau rapport de sanction dans le salon configuré sur le serveur staff lié.
 * Silencieux si aucun lien/salon n'est configuré.
 */
export async function announceSanctionReportToStaff(
  client: Client,
  report: {
    id: string;
    guildId: string;
    staffPseudo: string;
    memberPseudo: string;
    memberReference: string;
    sanctionType: SanctionType;
    sanctionDurationLabel: string | null;
    detailedReason: string;
    brokenRules: string;
    evidenceLinks: string[];
    incidentAt: Date;
  },
): Promise<void> {
  const { getStaffServerNotifyChannel } = await import('../staff/staffServerService.js');
  const channel = await getStaffServerNotifyChannel(client, report.guildId, 'sanctionReport');
  if (!channel) return;

  const mainGuildName = client.guilds.cache.get(report.guildId)?.name ?? report.guildId;
  const evidence = report.evidenceLinks.slice(0, 5).map((link, i) => `[Preuve ${i + 1}](${link})`).join(' · ');

  const embed = new EmbedBuilder()
    .setTitle('📋 Nouveau rapport de sanction')
    .setColor('#ED4245')
    .addFields(
      { name: 'Staff', value: report.staffPseudo, inline: true },
      { name: 'Membre', value: `${report.memberPseudo} (${report.memberReference})`, inline: true },
      { name: 'Type', value: `${report.sanctionType}${report.sanctionDurationLabel ? ` (${report.sanctionDurationLabel})` : ''}`, inline: true },
      { name: 'Incident', value: `<t:${Math.floor(report.incidentAt.getTime() / 1000)}:f>`, inline: true },
      { name: 'Règles enfreintes', value: report.brokenRules.slice(0, 1024) || '-', inline: false },
      { name: 'Raison détaillée', value: report.detailedReason.slice(0, 1024) || '-', inline: false },
      ...(evidence ? [{ name: 'Preuves', value: evidence, inline: false }] : []),
    )
    .setFooter({ text: `Depuis ${mainGuildName} · Rapport ${report.id}` })
    .setTimestamp();

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
}

export async function runGuildBan(guild: Guild, userId: string, reason: string): Promise<void> {
  await guild.members.ban(userId, { reason, deleteMessageSeconds: 0 });
}

export async function checkMissingReports() {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const sanctions = await prisma.sanction.findMany({
    where: {
      createdAt: { lte: threeDaysAgo },
      type: { in: [SanctionType.BAN, SanctionType.TEMP_BAN, SanctionType.KICK, SanctionType.TIMEOUT] },
      reports: { none: {} },
      OR: [
        { lastReportReminderAt: null },
        { lastReportReminderAt: { lte: oneDayAgo } },
        { createdAt: { lte: sevenDaysAgo }, managerReportEscalatedAt: null },
      ],
    },
    select: {
      id: true,
      guildId: true,
      targetUserId: true,
      targetTag: true,
      moderatorUserId: true,
      moderatorTag: true,
      createdAt: true,
      lastReportReminderAt: true,
      managerReportEscalatedAt: true,
    },
  });

  for (const sanction of sanctions) {
    // Vérifier si le module de sanctions et les rapports sont activés pour cette guilde
    const { getOrCreateFeatureConfigs } = await import('../core/dashboardManagementService.js');
    const featureConfigs = await getOrCreateFeatureConfigs(sanction.guildId);
    const sanctionsFeature = featureConfigs.find((c) => c.featureKey === 'sanctions');
    const isModuleEnabled = sanctionsFeature ? sanctionsFeature.enabled : true;

    const guild = await prisma.guild.findUnique({
      where: { id: sanction.guildId },
      select: { sanctionReportEnabled: true, sanctionReportSkipBots: true }
    });

    if (!isModuleEnabled || !guild?.sanctionReportEnabled) {
      // Rapports désactivés ou module inactif, ignorer cette sanction
      continue;
    }

    // Meme garde qu'a l'emission : sans elle, une sanction sur un bot posee
    // avant l'activation du reglage continuerait a relancer le moderateur.
    if (guild.sanctionReportSkipBots && (await isSanctionTargetBot(sanction.guildId, sanction.targetUserId))) {
      continue;
    }
    const actions = getMissingReportReminderActions(sanction as unknown as MissingReportReminderState, now);
    if (actions.remindModerator) {
      const claim = await prisma.sanction.updateMany({
        where: {
          id: sanction.id,
          reports: { none: {} },
          OR: [
            { lastReportReminderAt: null },
            { lastReportReminderAt: { lte: oneDayAgo } },
          ],
        },
        data: { lastReportReminderAt: now },
      });

      if (claim.count === 1) {
        try {
          await createNotification(
            sanction.guildId,
            sanction.moderatorUserId,
            'RAPPEL : Rapport manquant (3 jours+)',
            `Le rapport pour la sanction sur ${sanction.targetTag ?? sanction.targetUserId} est toujours manquant.`,
            'ERROR',
            '/sanctions'
          );
        } catch (error) {
          await prisma.sanction.updateMany({
            where: { id: sanction.id, lastReportReminderAt: now },
            data: { lastReportReminderAt: (sanction as unknown as MissingReportReminderState).lastReportReminderAt },
          });
          logger.error('Sanctions', `Échec du rappel de rapport pour la sanction ${sanction.id}:`, error);
        }
      }
    }

    if (actions.escalateManagers) {
      const claim = await prisma.sanction.updateMany({
        where: {
          id: sanction.id,
          reports: { none: {} },
          managerReportEscalatedAt: null,
        },
        data: { managerReportEscalatedAt: now },
      });
      if (claim.count !== 1) continue;

      const managers = await prisma.staffMember.findMany({
        where: {
          guildId: sanction.guildId,
          userId: { not: sanction.moderatorUserId },
          grade: { in: ['Manager', 'Admin', 'Administrateur', 'Direction', 'Fondateur'] },
        },
      });

      const results = await Promise.allSettled(managers.map((manager) =>
        createNotification(
          sanction.guildId,
          manager.userId,
          'Alerte : Rapport non rempli par un staff',
          `Le modérateur ${sanction.moderatorTag ?? sanction.moderatorUserId} n'a pas rempli le rapport pour sa sanction sur ${sanction.targetTag ?? sanction.targetUserId} depuis 7 jours.`,
          'ERROR',
          `/members/${sanction.targetUserId}`
        )
      ));

      if (managers.length === 0 || results.every((result) => result.status === 'rejected')) {
        await prisma.sanction.updateMany({
          where: { id: sanction.id, managerReportEscalatedAt: now },
          data: { managerReportEscalatedAt: null },
        });
      }
    }
  }
}
