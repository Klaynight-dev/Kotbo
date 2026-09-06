import { type Guild, type GuildMember, type Interaction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

import { LinkedAccountType, LinkedAccountStatus } from '@prisma/client';
import * as altAccountService from './altAccountService.js';
import { computeCrossServerLinkSignals } from './crossServerLinkService.js';
import { createNotification } from '../staff/staffLeadershipService.js';
import { fetchAllMembers } from '../../utils/discord.js';
import { memberProfileIdentity } from './memberIdentityService.js';
import {
  runDeepAnalysis,
  computeWeightedScore,
  loadSignalWeights,
  classify,
  logDetectionSample,
  recordDecision,
  type DcSignal,
  type Severity,
} from './dc/index.js';

// ─── Constantes de seuils ─────────────────────────────────────────────────────
const ACCOUNT_CREATION_PROXIMITY_MS = 15 * 60 * 1000;
export const JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS = 3 * 24 * 60 * 60 * 1000;
const USERNAME_SIMILARITY_THRESHOLD = 0.75;
const JOIN_PROXIMITY_MS = 10 * 60 * 1000;
const DC_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h entre deux alertes pour le même membre
const _AVATAR_DEFAULT_HASH_PREFIX = 'a_';
// Au-delà de ce nombre de membres arrivés via le même code d'invitation, on considère
// qu'il s'agit d'une invitation générale/publique : le lien « invité par X » n'est alors
// plus un signal fiable de double-compte et ne doit pas compter dans la détection.
const GENERAL_INVITE_USES_THRESHOLD = 10;

// ─── Types ────────────────────────────────────────────────────────────────────
export type DetectionReason = {
  type:
    | 'young_account'
    | 'creation_proximity'
    | 'username_similarity'
    | 'invite_link'
    | 'join_proximity'
    | 'shared_avatar'
    | 'shared_locale'
    | 'low_activity_pair'
    | 'role_pattern'
    | 'sequential_ids'
    // ── Nouveaux critères ──
    | 'banned_alt'
    | 'invite_loop'
    | 'repeat_rejoiner'
    | 'shared_sanction_history'
    | 'inviter_is_suspected_dc'
    | 'no_profile_picture'
    | 'cross_server_alt'
    | 'cross_server_link'
    | 'username_numeric_suffix'
    | 'same_inviter_multiple'
    // ── Signaux intelligents (analyse profonde) ──
    | 'stylometry_match'
    | 'ngram_match'
    | 'activity_heatmap'
    | 'temporal_exclusivity'
    | 'cadence_match'
    | 'daily_pattern'
    | 'mention_network'
    | 'never_interact'
    | 'shared_ip'
    | 'ip_subnet'
    | 'device_fingerprint'
    | 'oauth_connections'
    | 'voice_alternation';
  label: string;
  score: number; // 0-100 confidence
  matchedUserId?: string;
  detail?: string;
};

export type DetectionEvidence = {
  userId: string;
  reasons: DetectionReason[];
  suspectedAlts: string[];
  totalScore: number;
  detectedAt: string;
};

export type YoungAccountScanMatch = {
  userId: string;
  username: string | null;
  displayName: string | null;
  accountCreatedAt: string;
  guildJoinedAt: string;
  accountAgeMs: number;
  accountAgeLabel: string;
};

export type YoungAccountScanResult = {
  scannedCount: number;
  flaggedCount: number;
  thresholdMs: number;
  matches: YoungAccountScanMatch[];
};

// ─── Utilitaires ──────────────────────────────────────────────────────────────
function formatAgeLabel(durationMs: number): string {
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

function buildYoungAccountSuspicion(member: GuildMember, thresholdMs: number): { reason: string; accountAgeMs: number; accountAgeLabel: string } | null {
  const joinedTimestamp = member.joinedTimestamp;
  const createdTimestamp = member.user.createdTimestamp;
  if (!joinedTimestamp || !createdTimestamp) return null;
  const accountAgeMs = joinedTimestamp - createdTimestamp;
  if (accountAgeMs < 0 || accountAgeMs > thresholdMs) return null;
  const accountAgeLabel = formatAgeLabel(accountAgeMs);
  return { reason: `Compte créé ${accountAgeLabel} avant l'arrivée sur le serveur.`, accountAgeMs, accountAgeLabel };
}

function levenshteinDistance(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= len1; i++) matrix[i] = [i];
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[len1][len2];
}

function getSimilarityScore(s1: string, s2: string): number {
  const distance = levenshteinDistance(s1.toLowerCase(), s2.toLowerCase());
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - distance / maxLen;
}

function extractUsernameBase(username: string): string {
  return username.toLowerCase().replace(/[0-9_.-]+$/g, '');
}

/** Retourne le suffixe numérique terminal du pseudo, ou null si absent/trop long */
function extractNumericSuffix(username: string): string | null {
  const match = username.match(/(\d{1,4})$/);
  return match ? match[1] : null;
}

function areDiscordIdsSequential(id1: string, id2: string): boolean {
  try {
    const n1 = BigInt(id1);
    const n2 = BigInt(id2);
    const diff = n1 > n2 ? n1 - n2 : n2 - n1;
    return diff < BigInt(5 * 1000 * 4096);
  } catch { return false; }
}

// ─── Notifications ─────────────────────────────────────────────────────────────
async function notifyManagersOfSuspectedDC(guildId: string, member: GuildMember): Promise<void> {
  const managers = await prisma.staffMember.findMany({
    where: { guildId, grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] } }
  });
  if (managers.length === 0) return;
  await Promise.all(managers.map(m => createNotification(
    guildId, m.userId, '⚠️ Alerte DC suspect',
    `Un double compte potentiel a été détecté : ${member.user.tag}.`,
    'WARNING', `/double-accounts?tab=detections`, false
  ).catch(() => null)));
}

// ─── Analyse principale à l'arrivée ───────────────────────────────────────────
export async function analyzeMemberJoin(member: GuildMember): Promise<DetectionEvidence | null> {
  const guildId = member.guild.id;
  const userId = member.id;
  const reasons: DetectionReason[] = [];
  const suspectedAlts = new Set<string>();

  // ── Cooldown 24h : évite le spam d'alertes pour le même membre ──────────────
  const existingProfile = await prisma.memberProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { lastDcAlertAt: true }
  });
  if (existingProfile?.lastDcAlertAt) {
    const msSinceLastAlert = Date.now() - existingProfile.lastDcAlertAt.getTime();
    if (msSinceLastAlert < DC_ALERT_COOLDOWN_MS) {
      return null; // Alerte déjà envoyée récemment, skip
    }
  }

  // ── 1. Invite tracking ──────────────────────────────────────────────────────
  const inviteRecord = await prisma.memberInvite.findFirst({
    where: { guildId, userId },
    orderBy: { joinedAt: 'desc' }
  });
  // Une invitation très utilisée est probablement générale/publique : « invité par X »
  // n'est alors pas un indice fiable de double-compte, on ignore les signaux liés à l'inviteur.
  const isGeneralInvite = inviteRecord?.inviteCode
    ? (await prisma.memberInvite.count({ where: { guildId, inviteCode: inviteRecord.inviteCode } })) >= GENERAL_INVITE_USES_THRESHOLD
    : false;

  if (inviteRecord?.inviterId && !isGeneralInvite) {
    reasons.push({
      type: 'invite_link', label: `Invité par <@${inviteRecord.inviterId}>`,
      score: 20, matchedUserId: inviteRecord.inviterId,
      detail: `Code invite utilisé par ce membre, créé par ${inviteRecord.inviterId}`,
    });
    suspectedAlts.add(inviteRecord.inviterId);

    // ── Signal 5 : L'inviteur est lui-même marqué comme DC suspect ────────────
    const inviterProfile = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId: inviteRecord.inviterId } },
      select: { isSuspectedDC: true }
    });
    if (inviterProfile?.isSuspectedDC) {
      const existing = reasons.find(r => r.matchedUserId === inviteRecord.inviterId);
      if (existing) {
        existing.score += 25;
      } else {
        reasons.push({
          type: 'inviter_is_suspected_dc',
          label: `L'inviteur <@${inviteRecord.inviterId}> est lui-même suspect DC`,
          score: 25, matchedUserId: inviteRecord.inviterId,
          detail: `Le profil de l'inviteur est marqué isSuspectedDC=true`,
        });
      }
    }

    // ── Signal 9 : L'inviteur a déjà invité plusieurs membres suspects ────────
    const inviterSuspectCount = await prisma.memberProfile.count({
      where: { guildId, isSuspectedDC: true,
        userId: { in: (await prisma.memberInvite.findMany({
          where: { guildId, inviterId: inviteRecord.inviterId },
          select: { userId: true }
        })).map(i => i.userId) }
      }
    });
    if (inviterSuspectCount >= 3) {
      reasons.push({
        type: 'same_inviter_multiple',
        label: `L'inviteur <@${inviteRecord.inviterId}> a déjà invité ${inviterSuspectCount} membres suspects`,
        score: 20, matchedUserId: inviteRecord.inviterId,
        detail: `Pattern typique d'un compte principal créant des alts via ses propres liens d'invitation`,
      });
    }

    // ── Signal 2 : Boucle d'invitation (A a invité B, et B a déjà invité A) ──
    const reverseInvite = await prisma.memberInvite.findFirst({
      where: { guildId, userId: inviteRecord.inviterId, inviterId: userId }
    });
    if (reverseInvite) {
      reasons.push({
        type: 'invite_loop',
        label: `Boucle d'invitation avec <@${inviteRecord.inviterId}>`,
        score: 40, matchedUserId: inviteRecord.inviterId,
        detail: `<@${userId}> a invité <@${inviteRecord.inviterId}> et vice-versa - comportement d'alt typique`,
      });
    }
  }

  // ── 2. Proximité de création de compte (±15 min) ────────────────────────────
  const accountsCreatedNear = await prisma.memberProfile.findMany({
    where: {
      guildId, userId: { not: userId },
      accountCreatedAt: {
        gte: new Date(member.user.createdTimestamp - ACCOUNT_CREATION_PROXIMITY_MS),
        lte: new Date(member.user.createdTimestamp + ACCOUNT_CREATION_PROXIMITY_MS)
      }
    },
    take: 10
  });
  for (const p of accountsCreatedNear) {
    const diffMs = Math.abs((p.accountCreatedAt?.getTime() ?? 0) - member.user.createdTimestamp);
    reasons.push({
      type: 'creation_proximity', label: `Compte créé à ${formatAgeLabel(diffMs)} d'intervalle de <@${p.userId}>`,
      score: diffMs < 60_000 ? 50 : 35, matchedUserId: p.userId,
      detail: `Création du compte à ${new Date(member.user.createdTimestamp).toISOString()}, autre compte à ${p.accountCreatedAt?.toISOString()}`,
    });
    suspectedAlts.add(p.userId);
  }

  // ── 3. Similarité de pseudo ─────────────────────────────────────────────────
  const recentMembers = await prisma.memberProfile.findMany({
    where: {
      guildId, userId: { not: userId },
      guildJoinedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    },
    take: 200, orderBy: { guildJoinedAt: 'desc' }
  });

  const username = member.user.username;
  const usernameBase = extractUsernameBase(username);
  const numericSuffix = extractNumericSuffix(username);

  for (const recent of recentMembers) {
    if (!recent.username) continue;
    const sim = getSimilarityScore(username, recent.username);
    if (sim >= USERNAME_SIMILARITY_THRESHOLD) {
      reasons.push({
        type: 'username_similarity',
        label: `Pseudo similaire à <@${recent.userId}> (${recent.username}) - ${Math.round(sim * 100)}%`,
        score: Math.round(sim * 40), matchedUserId: recent.userId,
        detail: `Levenshtein: "${username}" vs "${recent.username}" = ${Math.round(sim * 100)}% similitude`,
      });
      suspectedAlts.add(recent.userId);
    } else if (usernameBase.length >= 3) {
      const recentBase = extractUsernameBase(recent.username);
      if (recentBase === usernameBase && recentBase.length >= 3) {
        reasons.push({
          type: 'username_similarity',
          label: `Base de pseudo identique à <@${recent.userId}> ("${usernameBase}")`,
          score: 30, matchedUserId: recent.userId,
          detail: `Base commune "${usernameBase}": "${username}" et "${recent.username}"`,
        });
        suspectedAlts.add(recent.userId);

        // ── Signal 8 : Suffixe numérique (pseudo1, pseudo2…) ─────────────────
        if (numericSuffix && extractNumericSuffix(recent.username) && numericSuffix !== extractNumericSuffix(recent.username)) {
          const existing = reasons.find(r => r.matchedUserId === recent.userId);
          if (existing) {
            existing.score += 20;
            existing.label += ` + suffixe numérique différent`;
          } else {
            reasons.push({
              type: 'username_numeric_suffix',
              label: `Pseudo avec suffixe numérique différent de <@${recent.userId}> ("${username}" vs "${recent.username}")`,
              score: 20, matchedUserId: recent.userId,
              detail: `Pattern typique: même base + numéro incrémental`,
            });
            suspectedAlts.add(recent.userId);
          }
        }
      }
    }
  }

  // ── 4. Proximité de join (±10 min) ─────────────────────────────────────────
  const joinedAt = member.joinedAt;
  if (joinedAt) {
    const nearJoiners = await prisma.memberProfile.findMany({
      where: {
        guildId, userId: { not: userId },
        guildJoinedAt: {
          gte: new Date(joinedAt.getTime() - JOIN_PROXIMITY_MS),
          lte: new Date(joinedAt.getTime() + JOIN_PROXIMITY_MS)
        }
      },
      take: 5
    });
    for (const j of nearJoiners) {
      if (suspectedAlts.has(j.userId)) {
        const existing = reasons.find(r => r.matchedUserId === j.userId);
        if (existing) existing.score += 15;
      } else {
        const diffMs = Math.abs((j.guildJoinedAt?.getTime() ?? 0) - joinedAt.getTime());
        reasons.push({
          type: 'join_proximity', label: `Arrivée à ${formatAgeLabel(diffMs)} d'intervalle de <@${j.userId}>`,
          score: 15, matchedUserId: j.userId,
        });
        suspectedAlts.add(j.userId);
      }
    }
  }

  // ── 5. Avatar partagé ──────────────────────────────────────────────────────
  const memberAvatar = member.user.avatar;
  if (memberAvatar) {
    const sameAvatarMembers = await prisma.memberProfile.findMany({
      where: { guildId, userId: { not: userId }, avatarUrl: { contains: memberAvatar } },
      take: 5
    });
    for (const s of sameAvatarMembers) {
      reasons.push({
        type: 'shared_avatar', label: `Même avatar que <@${s.userId}>`,
        score: 25, matchedUserId: s.userId,
      });
      suspectedAlts.add(s.userId);
    }
  }

  // ── 6. IDs Discord séquentiels ─────────────────────────────────────────────
  for (const altId of [...suspectedAlts]) {
    if (areDiscordIdsSequential(userId, altId)) {
      reasons.push({
        type: 'sequential_ids', label: `IDs Discord séquentiels avec <@${altId}>`,
        score: 40, matchedUserId: altId,
        detail: `Les IDs ${userId} et ${altId} sont très proches, indiquant une création quasi-simultanée`,
      });
    }
  }

  // ── 7. Locale partagée ─────────────────────────────────────────────────────
  const memberProfile = await prisma.memberProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { locale: true }
  });
  if (memberProfile?.locale) {
    for (const altId of [...suspectedAlts]) {
      const altProfile = await prisma.memberProfile.findUnique({
        where: { guildId_userId: { guildId, userId: altId } },
        select: { locale: true }
      });
      if (altProfile?.locale && altProfile.locale === memberProfile.locale) {
        const existing = reasons.find(r => r.matchedUserId === altId);
        if (existing) existing.score += 5;
      }
    }
  }

  // ── 8. Paire peu active ────────────────────────────────────────────────────
  for (const altId of [...suspectedAlts]) {
    const altProfile = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId: altId } },
      select: { messageCount: true }
    });
    if (altProfile && altProfile.messageCount < 5) {
      const existing = reasons.find(r => r.matchedUserId === altId);
      if (existing) existing.score += 10;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOUVEAUX CRITÈRES INTELLIGENTS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Signal N1 : Alt suspect actuellement banni ─────────────────────────────
  for (const altId of [...suspectedAlts]) {
    try {
      const ban = await member.guild.bans.fetch(altId).catch(() => null);
      if (ban) {
        reasons.push({
          type: 'banned_alt',
          label: `<@${altId}> est actuellement banni du serveur`,
          score: 35, matchedUserId: altId,
          detail: `Raison du ban : ${ban.reason || 'non spécifiée'}. Un alt potentiel déjà banni est un fort indicateur.`,
        });
      }
    } catch { /* Non banni */ }
  }

  // ── Signal N3 : Membre qui rejoint/quitte plusieurs fois ──────────────────
  const joinHistory = await prisma.memberInvite.count({
    where: { guildId, userId }
  });
  if (joinHistory >= 2) {
    reasons.push({
      type: 'repeat_rejoiner',
      label: `Ce membre a rejoint ${joinHistory} fois le serveur`,
      score: joinHistory >= 4 ? 40 : 30,
      detail: `Comportement typique d'un alt qui teste les sanctions ou explore différents pseudos`,
    });
  }

  // ── Signal N4 : Historique de sanctions partagé avec un alt ───────────────
  for (const altId of [...suspectedAlts]) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentAltSanctions = await prisma.sanction.findMany({
      where: { guildId, targetUserId: altId, createdAt: { gte: thirtyDaysAgo } },
      select: { type: true, moderatorUserId: true },
      take: 10
    });
    const recentMySanctions = await prisma.sanction.findMany({
      where: { guildId, targetUserId: userId, createdAt: { gte: thirtyDaysAgo } },
      select: { type: true, moderatorUserId: true },
      take: 10
    });

    const sharedPairs = recentAltSanctions.filter(altS =>
      recentMySanctions.some(myS => myS.type === altS.type && myS.moderatorUserId === altS.moderatorUserId)
    );
    if (sharedPairs.length > 0) {
      const existing = reasons.find(r => r.matchedUserId === altId);
      if (existing) {
        existing.score += 30;
        existing.detail = (existing.detail ?? '') + ` | Historique de sanctions similaire : ${sharedPairs.length} type(s) de sanction identiques par le même modérateur`;
      } else {
        reasons.push({
          type: 'shared_sanction_history',
          label: `Historique de sanctions similaire à <@${altId}> (${sharedPairs.length} correspondance${sharedPairs.length > 1 ? 's' : ''})`,
          score: 30, matchedUserId: altId,
          detail: `Mêmes types de sanctions par les mêmes modérateurs - pattern typique d'un même utilisateur`,
        });
      }
    }
  }

  // ── Signal N6 : Pas d'avatar + compte jeune ───────────────────────────────
  const hasNoAvatar = !member.user.avatar;
  const accountAgeMs = member.joinedTimestamp ? member.joinedTimestamp - member.user.createdTimestamp : null;
  if (hasNoAvatar && accountAgeMs !== null && accountAgeMs < JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS) {
    reasons.push({
      type: 'no_profile_picture',
      label: `Aucun avatar personnalisé et compte récent (créé il y a ${formatAgeLabel(accountAgeMs)})`,
      score: 15,
      detail: `Les comptes alternes créés rapidement ont rarement de photo de profil. Ce signal est renforcé si d'autres critères s'accumulent.`,
    });
  }

  // ── Signal N7 : Vérification OAuth croisée (même IP, autre serveur) ───────
  // Cherche dans les vérifications OAuth d'autres guildes si la même IP a été liée à un DC
  const existingVerif = await prisma.securityVerification.findFirst({
    where: {
      userId,
      status: 'VERIFIED',
      ipAddress: { not: null }
    },
    select: { ipAddress: true },
    orderBy: { createdAt: 'desc' }
  });

  if (existingVerif?.ipAddress) {
    const crossServerDuplicate = await prisma.securityVerification.findFirst({
      where: {
        guildId: { not: guildId },
        ipAddress: existingVerif.ipAddress,
        userId: { not: userId },
        duplicateDetected: true
      },
      select: { userId: true, guildId: true, duplicateUserId: true }
    });

    if (crossServerDuplicate?.duplicateUserId) {
      reasons.push({
        type: 'cross_server_alt',
        label: `Même IP détectée comme DC sur un autre serveur`,
        score: 45, matchedUserId: crossServerDuplicate.duplicateUserId,
        detail: `Ce compte partage une IP déjà signalée comme double compte sur un autre serveur Kotbo. Preuve très forte.`,
      });
      suspectedAlts.add(crossServerDuplicate.duplicateUserId);
    }
  }

  // ── Signal N8 : Lien déjà posé sur d'autres serveurs de l'instance ────────
  // Si le staff d'un autre serveur a déjà lié ce membre à un autre compte, on
  // reprend ce verdict : le score monte avec le nombre de serveurs concernés.
  const crossLinkSignals = await computeCrossServerLinkSignals(guildId, userId).catch(() => [] as DcSignal[]);
  for (const s of crossLinkSignals) {
    reasons.push({ type: s.type, label: s.label, score: s.score, matchedUserId: s.matchedUserId, detail: s.detail });
    if (s.matchedUserId) suspectedAlts.add(s.matchedUserId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSE PROFONDE - signaux intelligents (comportemental, technique, vocal…)
  // ═══════════════════════════════════════════════════════════════════════════
  const deepSignals = await runDeepAnalysis(guildId, userId, Array.from(suspectedAlts)).catch(() => [] as DcSignal[]);
  for (const s of deepSignals) {
    reasons.push({ type: s.type, label: s.label, score: s.score, matchedUserId: s.matchedUserId, detail: s.detail });
    if (s.matchedUserId) suspectedAlts.add(s.matchedUserId);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  if (reasons.length === 0) return null;

  // Scoring pondéré : familles, corroboration inter-familles, redondance, poids appris.
  const weights = await loadSignalWeights(guildId).catch(() => ({}));
  const scoreResult = computeWeightedScore(reasons as DcSignal[], weights);
  const totalScore = scoreResult.totalScore;

  const evidence: DetectionEvidence = {
    userId, reasons, suspectedAlts: Array.from(suspectedAlts), totalScore, detectedAt: new Date().toISOString(),
  };

  // Persiste le flag + score + horodatage d'alerte
  await prisma.memberProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: { isSuspectedDC: true, dcScore: totalScore, lastDcAlertAt: new Date() },
    create: {
      guildId,
      userId,
      ...memberProfileIdentity(member),
      isSuspectedDC: true,
      dcScore: totalScore,
      lastDcAlertAt: new Date(),
    }
  }).catch(() => null);

  // Boucle d'apprentissage : enregistre le vecteur de features (label fixé plus tard par le staff).
  void logDetectionSample(guildId, userId, evidence.suspectedAlts[0] ?? null, totalScore, reasons as DcSignal[], scoreResult.distinctFamilies);

  await reportSuspectedDC(member, evidence, scoreResult.distinctFamilies, scoreResult.corroborationMultiplier, member.guild.memberCount);
  await notifyManagersOfSuspectedDC(guildId, member);

  // Mise en quarantaine automatique si score >= 75 et rôle de vérification configuré
  if (totalScore >= 75) {
    const config = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { verificationRoleId: true, logChannelId: true }
    });
    if (config?.verificationRoleId) {
      try {
        const role = await member.guild.roles.fetch(config.verificationRoleId).catch(() => null);
        if (role) {
          await member.roles.set([config.verificationRoleId], 'Kotbo Quarantine: Auto-quarantined suspect DC (score >= 75)');
          logger.warn('DCDetection', `Membre ${member.user.tag} (${member.id}) mis en quarantaine automatique (score: ${totalScore})`);
          
          if (config.logChannelId) {
            const logChannel = await member.guild.channels.fetch(config.logChannelId).catch(() => null);
            if (logChannel && 'send' in logChannel) {
              const quarantineEmbed = new EmbedBuilder()
                .setTitle('🔒 Quarantaine Automatique : Double Compte')
                .setColor('#ED4245')
                .setDescription(
                  `L'utilisateur ${member} (${member.user.tag}) a été mis en quarantaine automatiquement.\n\n` +
                  `**Score de suspicion :** \`${totalScore}/100\`\n` +
                  `**Raison :** Dépassement du seuil de suspicion (seuil de quarantaine: 75/100).\n` +
                  `Ses rôles ont été réinitialisés et le rôle de quarantaine/vérification <@&${config.verificationRoleId}> lui a été attribué.`
                )
                .setTimestamp();
              await logChannel.send({ embeds: [quarantineEmbed] }).catch(() => null);
            }
          }
        }
      } catch (err) {
        logger.error('DCDetection', `Impossible d'appliquer le rôle de quarantaine à ${member.user.tag}:`, err);
      }
    }
  }

  return evidence;
}

// ─── Recalcul de l'évidence depuis la DB (endpoint dashboard) ─────────────────
export async function getDetectionEvidence(guildId: string, userId: string): Promise<DetectionEvidence | null> {
  const profile = await prisma.memberProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { userId: true, username: true, accountCreatedAt: true, guildJoinedAt: true, locale: true, avatarUrl: true, messageCount: true, isSuspectedDC: true }
  });
  if (!profile) return null;

  const reasons: DetectionReason[] = [];
  const suspectedAlts = new Set<string>();

  const EVIDENCE_YOUNG_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
  if (profile.accountCreatedAt && profile.guildJoinedAt) {
    const ageMs = profile.guildJoinedAt.getTime() - profile.accountCreatedAt.getTime();
    if (ageMs >= 0 && ageMs < EVIDENCE_YOUNG_THRESHOLD_MS) {
      const score = ageMs < 3600_000 ? 40 : ageMs < JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS ? 25 : 15;
      reasons.push({
        type: 'young_account', label: `Compte créé ${formatAgeLabel(ageMs)} avant l'arrivée`,
        score,
        detail: `Création: ${profile.accountCreatedAt.toISOString()}, Arrivée: ${profile.guildJoinedAt.toISOString()}`,
      });
    }
  }

  const invite = await prisma.memberInvite.findFirst({ where: { guildId, userId }, orderBy: { joinedAt: 'desc' } });
  // Ignore les invitations très utilisées (probablement générales/publiques) : voir GENERAL_INVITE_USES_THRESHOLD.
  const inviteIsGeneral = invite?.inviteCode
    ? (await prisma.memberInvite.count({ where: { guildId, inviteCode: invite.inviteCode } })) >= GENERAL_INVITE_USES_THRESHOLD
    : false;
  if (invite?.inviterId && !inviteIsGeneral) {
    reasons.push({ type: 'invite_link', label: `Invité par <@${invite.inviterId}>`, score: 20, matchedUserId: invite.inviterId });
    suspectedAlts.add(invite.inviterId);
  }

  if (profile.accountCreatedAt) {
    const near = await prisma.memberProfile.findMany({
      where: {
        guildId, userId: { not: userId },
        accountCreatedAt: { gte: new Date(profile.accountCreatedAt.getTime() - ACCOUNT_CREATION_PROXIMITY_MS), lte: new Date(profile.accountCreatedAt.getTime() + ACCOUNT_CREATION_PROXIMITY_MS) }
      }, take: 10
    });
    for (const p of near) {
      const diffMs = Math.abs((p.accountCreatedAt?.getTime() ?? 0) - profile.accountCreatedAt.getTime());
      reasons.push({ type: 'creation_proximity', label: `Compte créé à ${formatAgeLabel(diffMs)} de <@${p.userId}>`, score: diffMs < 60_000 ? 50 : 35, matchedUserId: p.userId });
      suspectedAlts.add(p.userId);
    }
  }

  if (profile.username) {
    const base = extractUsernameBase(profile.username);
    const others = await prisma.memberProfile.findMany({
      where: { guildId, userId: { not: userId }, username: { not: null } }, take: 200, orderBy: { guildJoinedAt: 'desc' }
    });
    for (const o of others) {
      if (!o.username) continue;
      const sim = getSimilarityScore(profile.username, o.username);
      if (sim >= USERNAME_SIMILARITY_THRESHOLD) {
        reasons.push({ type: 'username_similarity', label: `Pseudo similaire à <@${o.userId}> - ${Math.round(sim * 100)}%`, score: Math.round(sim * 40), matchedUserId: o.userId });
        suspectedAlts.add(o.userId);
      } else if (base.length >= 3 && extractUsernameBase(o.username) === base) {
        reasons.push({ type: 'username_similarity', label: `Base de pseudo identique à <@${o.userId}> ("${base}")`, score: 30, matchedUserId: o.userId });
        suspectedAlts.add(o.userId);
      }
    }
  }

  if (profile.guildJoinedAt) {
    const nearJoin = await prisma.memberProfile.findMany({
      where: {
        guildId, userId: { not: userId },
        guildJoinedAt: { gte: new Date(profile.guildJoinedAt.getTime() - JOIN_PROXIMITY_MS), lte: new Date(profile.guildJoinedAt.getTime() + JOIN_PROXIMITY_MS) }
      }, take: 5
    });
    for (const j of nearJoin) {
      const diffMs = Math.abs((j.guildJoinedAt?.getTime() ?? 0) - profile.guildJoinedAt.getTime());
      if (!suspectedAlts.has(j.userId)) {
        reasons.push({ type: 'join_proximity', label: `Arrivée à ${formatAgeLabel(diffMs)} de <@${j.userId}>`, score: 15, matchedUserId: j.userId });
        suspectedAlts.add(j.userId);
      }
    }
  }

  for (const altId of [...suspectedAlts]) {
    if (areDiscordIdsSequential(userId, altId)) {
      reasons.push({ type: 'sequential_ids', label: `IDs séquentiels avec <@${altId}>`, score: 40, matchedUserId: altId });
    }
  }

  // Re-check repeat rejoiner
  const joinCount = await prisma.memberInvite.count({ where: { guildId, userId } });
  if (joinCount >= 2) {
    reasons.push({ type: 'repeat_rejoiner', label: `A rejoint ${joinCount} fois le serveur`, score: joinCount >= 4 ? 40 : 30 });
  }

  // Liens déjà posés sur d'autres serveurs de l'instance : même signal qu'à l'arrivée.
  const crossLinkSignals = await computeCrossServerLinkSignals(guildId, userId).catch(() => [] as DcSignal[]);
  for (const s of crossLinkSignals) {
    reasons.push({ type: s.type, label: s.label, score: s.score, matchedUserId: s.matchedUserId, detail: s.detail });
    if (s.matchedUserId) suspectedAlts.add(s.matchedUserId);
  }

  // Analyse profonde (comportemental, technique, vocal, pattern quotidien) - tout en base.
  const deepSignals = await runDeepAnalysis(guildId, userId, Array.from(suspectedAlts)).catch(() => [] as DcSignal[]);
  for (const s of deepSignals) {
    reasons.push({ type: s.type, label: s.label, score: s.score, matchedUserId: s.matchedUserId, detail: s.detail });
    if (s.matchedUserId) suspectedAlts.add(s.matchedUserId);
  }

  if (reasons.length === 0) {
    if (!profile.isSuspectedDC) return null;
    reasons.push({
      type: 'young_account',
      label: 'Marqué comme suspect par un scan précédent',
      score: 10,
      detail: "Ce membre a été signalé lors d'un scan de détection. Les conditions exactes ne sont plus reproductibles (seuil ou données modifiées depuis).",
    });
  }

  const weights = await loadSignalWeights(guildId).catch(() => ({}));
  const scoreResult = computeWeightedScore(reasons as DcSignal[], weights);

  return {
    userId, reasons, suspectedAlts: Array.from(suspectedAlts),
    totalScore: scoreResult.totalScore,
    detectedAt: new Date().toISOString(),
  };
}

// ─── Scan batch des membres (commande /dc scan ou cron) ──────────────────────
export async function scanGuildMembersForYoungAccounts(guild: Guild, thresholdMs = JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS): Promise<YoungAccountScanResult> {
  const fetchedMembers = await fetchAllMembers(guild).catch(() => null);
  if (!fetchedMembers) return { scannedCount: 0, flaggedCount: 0, thresholdMs, matches: [] };

  const matches: YoungAccountScanMatch[] = [];
  let scannedCount = 0;

  for (const member of fetchedMembers.values()) {
    if (member.user.bot) continue;
    scannedCount++;
    const suspicion = buildYoungAccountSuspicion(member, thresholdMs);
    if (!suspicion) continue;

    await prisma.memberProfile.upsert({
      where: { guildId_userId: { guildId: guild.id, userId: member.id } },
      update: { isSuspectedDC: true },
      create: {
        guildId: guild.id,
        userId: member.id,
        ...memberProfileIdentity(member),
        isSuspectedDC: true,
      }
    }).catch(() => null);

    const evidence: DetectionEvidence = {
      userId: member.id, reasons: [{ type: 'young_account', label: suspicion.reason, score: 30 }],
      suspectedAlts: [], totalScore: 30, detectedAt: new Date().toISOString(),
    };
    await reportSuspectedDC(member, evidence);
    await notifyManagersOfSuspectedDC(guild.id, member);

    matches.push({
      userId: member.id, username: member.user.username, displayName: member.displayName,
      accountCreatedAt: member.user.createdAt.toISOString(),
      guildJoinedAt: member.joinedAt?.toISOString() ?? new Date(member.joinedTimestamp ?? Date.now()).toISOString(),
      accountAgeMs: suspicion.accountAgeMs, accountAgeLabel: suspicion.accountAgeLabel,
    });
  }

  return { scannedCount, flaggedCount: matches.length, thresholdMs, matches };
}

// ─── Embed de signalement dans le salon de logs ──────────────────────────────
async function reportSuspectedDC(
  member: GuildMember,
  evidence: DetectionEvidence,
  distinctFamilies = 0,
  corroborationMultiplier = 1,
  guildMemberCount = 500,
): Promise<void> {
  const guild = member.guild;
  const config = await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } });
  const logChannelId = config?.logChannelId;
  if (!logChannelId) return;

  const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel || !('send' in logChannel)) return;

  const severity: Severity = classify(evidence.totalScore, guildMemberCount);
  const scoreColor = severity === 'HIGH' ? '#ED4245' : severity === 'MEDIUM' ? '#FFA500' : '#FEE75C';
  const scoreLabel = severity === 'HIGH' ? 'Élevé' : severity === 'MEDIUM' ? 'Moyen' : 'Faible';

  const reasonsText = evidence.reasons
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(r => `\`${r.score}pts\` ${r.label}`)
    .join('\n');

  const altsText = evidence.suspectedAlts.length > 0
    ? evidence.suspectedAlts.map(id => `<@${id}>`).join(', ')
    : 'Aucun';

  // Familles de signaux distinctes = fiabilité (corroboration croisée).
  const corroborationText = distinctFamilies >= 2
    ? `${distinctFamilies} familles de signaux${corroborationMultiplier > 1 ? ` (×${corroborationMultiplier.toFixed(2)} corroboration)` : ''}`
    : '1 seule famille de signaux';

  const embed = new EmbedBuilder()
    .setTitle('🔍 Détection de Double Compte')
    .setColor(parseInt(scoreColor.replace('#', ''), 16))
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(`**${member.user.tag}** (<@${member.id}>) identifié comme DC potentiel.`)
    .addFields(
      { name: '🎯 Score de confiance', value: `**${evidence.totalScore}/100** (${scoreLabel})`, inline: true },
      { name: '📊 Heuristiques', value: `${evidence.reasons.length} signal${evidence.reasons.length > 1 ? 'aux' : ''}`, inline: true },
      { name: '🧬 Fiabilité', value: corroborationText, inline: true },
      { name: '📅 Création', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '⚠️ Raisons', value: reasonsText || 'Aucune' },
      { name: '👥 Comptes suspects', value: altsText },
    )
    .setTimestamp();

  const primaryAlt = evidence.suspectedAlts[0] || 'none';

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dc_validate_${member.id}_${primaryAlt}`)
      .setLabel('Lier les comptes')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dc_reject_${member.id}`)
      .setLabel('Faux positif')
      .setStyle(ButtonStyle.Secondary),
  );

  await logChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
}

// ─── Interactions boutons Discord ─────────────────────────────────────────────
export async function handleDCInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('dc_')) return;

  let action: string;
  let userId: string;
  let altId: string | undefined;

  if (interaction.customId.includes(':')) {
    const parts = interaction.customId.split(':');
    action = parts[0].replace('dc_', '').replace('_link', '');
    userId = parts[1];
    altId = parts[2];
  } else {
    const parts = interaction.customId.split('_');
    action = parts[1];
    userId = parts[2];
    altId = parts[3];
  }

  if (action === 'validate') {
    if (!altId || altId === 'none') {
      await interaction.reply({ content: '❌ Impossible de valider sans un autre compte spécifié.', ephemeral: true });
      return;
    }

    await altAccountService.linkAccounts({
      guildId: interaction.guildId!, user1Id: userId, user2Id: altId,
      type: LinkedAccountType.AUTOMATIC, status: LinkedAccountStatus.VALIDATED,
      reason: 'Validé par la modération (Interface de détection ou signalement).',
      linkedByUserId: interaction.user.id
    });

    // Réinitialise le flag sur les deux comptes
    await prisma.memberProfile.updateMany({
      where: { userId: { in: [userId, altId] }, guildId: interaction.guildId! },
      data: { isSuspectedDC: false, dcScore: null }
    }).catch(() => null);

    // Boucle d'apprentissage : lien confirmé = vrai positif.
    void recordDecision(interaction.guildId!, [userId, altId], 'TRUE_POSITIVE', interaction.user.id);

    const dmEmbed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('Comptes liés officiellement')
      .setDescription(`Vos comptes <@${userId}> et <@${altId}> ont été reliés sur **${interaction.guild?.name || 'le serveur'}**.`)
      .setTimestamp();

    const u1 = await interaction.client.users.fetch(userId).catch(() => null);
    if (u1) await u1.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    const u2 = await interaction.client.users.fetch(altId).catch(() => null);
    if (u2) await u2.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);

    await interaction.update({
      content: `✅ <@${userId}> lié à <@${altId}> par <@${interaction.user.id}>.`,
      embeds: [], components: []
    });
  } else if (action === 'reject') {
    // Faux positif : remet isSuspectedDC à false + dcScore à null
    await prisma.memberProfile.updateMany({
      where: { userId: { in: [userId, altId || userId] }, guildId: interaction.guildId! },
      data: { isSuspectedDC: false, dcScore: null }
    }).catch(() => null);

    // Boucle d'apprentissage : rejet = faux positif.
    void recordDecision(interaction.guildId!, [userId, altId || userId], 'FALSE_POSITIVE', interaction.user.id);

    await interaction.update({
      content: `⚠️ Faux positif confirmé par <@${interaction.user.id}>. Alerte ignorée et profil réinitialisé.`,
      embeds: [], components: []
    });
  }
}
