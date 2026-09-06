/** Construction du dossier d un membre pour le dashboard. */
import { type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { parseEvidenceLinks } from '../evidence.js';
import type {
  DashboardSanctionType,
  DashboardSanctionStatus,
  DashboardRole,
  
  
  MemberCaseLogEntry,
  
  MemberCaseChannelSummary,
  MemberCaseInviteInfo,
  
  
  MemberCaseInteractionNode,
  MemberCaseInteractionEdge,
  
  MemberCaseResponse,
} from '@kotbo/contracts';
import { getStaffMember } from '../../services/staff/staffManagementService.js';
import { getCandidatureHistory } from '../../services/staff/recruitmentService.js';
import * as altAccountService from '../../services/moderation/altAccountService.js';
import { resolveMemberAvatarUrl, resolveUserAvatarUrl } from '../../services/moderation/memberIdentityService.js';
import { getVerificationHistory } from '../../services/moderation/securityVerificationService.js';
import { visiblePresenceStatus } from '../../services/core/presencePrivacyService.js';
import { getCrossServerSanctionSummary, type CrossServerSanctionSummary } from '../../services/moderation/crossServerSanctionService.js';
import { getCrossServerLinkSummary, type CrossServerLinkSummary } from '../../services/moderation/crossServerLinkService.js';
import { extractMessageId, extractMessagePreview, fetchMemberConnections, mapGuildRolePermissions, parseInviteFromDetails, safeIsoDate } from './core.js';
import type { AuthClaims } from './core.js';
import { formatChannelName, interpretMentions } from './markdown.js';

function resolveMemberCaseRoles(
  discordGuild: NonNullable<ReturnType<Client['guilds']['cache']['get']>>,
  member: { roles: { cache: { values: () => IterableIterator<{ id: string; name: string; hexColor?: string; permissions?: { toArray: () => string[] } | string[] }> } } } | null,
  rolesSnapshot: string[] | null | undefined,
): DashboardRole[] {
  const sortRoles = (left: DashboardRole, right: DashboardRole) => {
    const positionLeft = discordGuild.roles.cache.get(left.id)?.position ?? 0;
    const positionRight = discordGuild.roles.cache.get(right.id)?.position ?? 0;
    return positionRight - positionLeft || left.name.localeCompare(right.name, 'fr');
  };

  if (member) {
    return [...member.roles.cache.values()]
      .filter((role) => !!role && role.id !== discordGuild.id)
      .map((role) => mapGuildRolePermissions(role, `<@&${role.id}>`))
      .sort(sortRoles);
  }

  return (rolesSnapshot ?? [])
    .map((roleId) => {
      const role = discordGuild.roles.cache.get(roleId);
      if (!role || role.id === discordGuild.id) return null;
      return mapGuildRolePermissions(role, `<@&${role.id}>`);
    })
    .filter((role): role is DashboardRole => role !== null)
    .sort(sortRoles);
}

function resolveMemberDisplayLabel(
  userId: string,
  user: { tag?: string | null; username?: string | null; globalName?: string | null; displayName?: string | null } | null,
  profile: { userTag?: string | null; username?: string | null; globalName?: string | null; displayName?: string | null } | null,
): string {
  return (
    user?.globalName
    ?? user?.username
    ?? user?.tag
    ?? profile?.displayName
    ?? profile?.globalName
    ?? profile?.userTag
    ?? profile?.username
    ?? `Utilisateur ${userId}`
  );
}

/**
 * Historique des demandes de vérification, sérialisé pour la fiche membre.
 *
 * Un échec de lecture ne doit pas priver le staff de toute la fiche : on
 * retombe alors sur un historique vide, qui laisse simplement le bouton actif.
 */
async function buildVerificationsPayload(
  guildId: string,
  userId: string,
): Promise<MemberCaseResponse['verifications']> {
  try {
    const history = await getVerificationHistory(guildId, userId);
    return {
      entries: history.entries.map((entry) => ({
        id: entry.id,
        status: entry.status,
        level: entry.level,
        requestedAt: safeIsoDate(entry.requestedAt) ?? new Date(0).toISOString(),
        verifiedAt: safeIsoDate(entry.verifiedAt),
        expiresAt: safeIsoDate(entry.expiresAt),
      })),
      total: history.total,
      lastRequestedAt: safeIsoDate(history.lastRequestedAt),
      lastVerifiedAt: safeIsoDate(history.lastVerifiedAt),
      hasPending: history.hasPending,
      cooldownUntil: safeIsoDate(history.cooldownUntil),
    };
  } catch (err) {
    logger.warn('MemberCase', `Historique de vérification illisible pour ${userId} sur ${guildId}:`, err);
    return {
      entries: [],
      total: 0,
      lastRequestedAt: null,
      lastVerifiedAt: null,
      hasPending: false,
      cooldownUntil: null,
    };
  }
}

export async function buildMemberCaseData(client: Client, guildId: string, userId: string, auth: AuthClaims): Promise<MemberCaseResponse | null> {
  const discordGuild = client.guilds.cache.get(guildId);
  if (!discordGuild) return null;

  let actualUserId = userId.startsWith('!') ? userId.substring(1) : userId;
  
  if (!/^\d+$/.test(actualUserId)) {
    const staff = await prisma.staffMember.findUnique({
      where: { id: actualUserId },
      select: { userId: true }
    });
    if (staff) {
      actualUserId = staff.userId;
    } else {
      const profile = await prisma.memberProfile.findUnique({
        where: { id: actualUserId },
        select: { userId: true }
      });
      if (profile) actualUserId = profile.userId;
    }
  }

  if (!/^\d{17,20}$/.test(actualUserId)) {
    return null;
  }

  try {
    const linkedUserIds = await altAccountService
      .getAllLinkedUserIds(guildId, actualUserId)
      .catch(() => [actualUserId]);

    // Résumé des sanctions sur les autres serveurs de l'instance (lancé en parallèle du reste).
    const crossServerPromise = getCrossServerSanctionSummary(client, guildId, linkedUserIds)
      .catch(() => ({ enabled: false, serverCount: 0, total: 0, breakdown: { WARN: 0, KICK: 0, TIMEOUT: 0, TEMP_BAN: 0, BAN: 0, SOFTBAN: 0 }, recent: [] } as CrossServerSanctionSummary));

    // Liens de double compte déjà posés ailleurs : suggestions pour l'onglet « comptes liés ».
    const crossServerLinksPromise = getCrossServerLinkSummary(client, guildId, actualUserId)
      .catch(() => ({ enabled: false, serverCount: 0, suggestions: [] } as CrossServerLinkSummary));

    const [user, member, profile, sanctions, auditLogs, inviteConnections, staffMember, candidatureHistory, sanctionReports, dbInvite] = await Promise.all([
      Promise.race([
        client.users.fetch(actualUserId).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ]),
      Promise.race([
        discordGuild.members.fetch(actualUserId).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ]),
      prisma.memberProfile.findUnique({
        where: {
          guildId_userId: {
            guildId,
            userId: actualUserId,
          },
        },
      }).catch(() => null),
      prisma.sanction.findMany({
        where: { guildId, targetUserId: { in: linkedUserIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []),
      prisma.dashboardAuditLog.findMany({
        where: {
          guildId,
          OR: [
            { user: { contains: actualUserId } },
            { details: { contains: actualUserId } }
          ]
        },
        orderBy: { dateIso: 'desc' },
        take: 500,
      }).catch(() => []),
      fetchMemberConnections(auth.userId === actualUserId ? auth.discordToken : null).catch(() => ({ connections: [], note: "Erreur lors de la récupération des connexions." })),
      getStaffMember(guildId, actualUserId).catch(() => null),
      getCandidatureHistory(guildId, actualUserId).catch(() => []),
      prisma.sanctionReport.findMany({
        where: { guildId, memberReference: { in: linkedUserIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []),
      prisma.memberInvite.findFirst({
        where: { guildId, userId: actualUserId },
      }).catch(() => null),
    ]);

    if (
      !user
      && !member
      && !profile
      && (sanctions?.length ?? 0) === 0
      && (auditLogs?.length ?? 0) === 0
      && (sanctionReports?.length ?? 0) === 0
    ) {
      return null;
    }

  const crossServerSanctions = await crossServerPromise;
  const crossServerLinks = await crossServerLinksPromise;

  const isOnServer = !!member;
  const displayLabel = resolveMemberDisplayLabel(actualUserId, user, profile);
  const effectivePermissions = member?.permissions?.toArray() ?? [];
  const roles = resolveMemberCaseRoles(discordGuild, member, profile?.rolesSnapshot);

  const tagCandidates = new Set<string>(
    [user?.tag, user?.username, profile?.userTag, profile?.username, member?.user?.tag, displayLabel]
      .filter((entry): entry is string => !!entry),
  );

    const relevantLogs = (auditLogs || []).filter((entry) => {
      try {
        const haystack = `${entry.user || ""} ${entry.details || ""}`;
        if (haystack.includes(actualUserId)) return true;
        if ([...tagCandidates].some((candidate) => candidate && haystack.includes(candidate))) return true;
        if (entry.user === actualUserId) return true;
        return false;
      } catch (e) {
        return false;
      }
    });

    const mappedLogs: MemberCaseLogEntry[] = relevantLogs.slice(0, 120).map((entry) => ({
      id: entry.id,
      user: entry.user,
      action: entry.action,
      context: entry.context,
      module: entry.module,
      eventType: entry.eventType,
      source: entry.eventType === 'Discord' ? 'discord' : 'dashboard',
      details: interpretMentions(discordGuild, entry.details),
      dateIso: safeIsoDate(entry.dateIso) || new Date().toISOString(),
      channelId: entry.channelId,
    }));

  let invite: MemberCaseInviteInfo | null = dbInvite ? {
    code: dbInvite.inviteCode,
    inviterId: dbInvite.inviterId,
    inviterTag: dbInvite.inviterTag,
    inviterAvatarUrl: null,
    joinedAt: safeIsoDate(dbInvite.joinedAt),
  } : null;

  if (!invite) {
    invite = mappedLogs
      .map((entry) => parseInviteFromDetails(entry.details))
      .find((entry): entry is MemberCaseInviteInfo => !!entry) ?? null;
  }

  // MemberInvite.inviterId est nullable et les logs d'arrivee ne portent
  // parfois que le pseudo du createur. Sans id, le dashboard affiche le
  // pseudo en texte mort au lieu d'un lien vers sa fiche : on retrouve l'id
  // via les profils connus du serveur.
  if (invite && !invite.inviterId && invite.inviterTag) {
    const inviterName = invite.inviterTag.replace(/^@/, '').trim();
    if (inviterName) {
      const inviterProfile = await prisma.memberProfile.findFirst({
        where: {
          guildId,
          OR: [
            { userTag: { equals: inviterName, mode: 'insensitive' } },
            { username: { equals: inviterName, mode: 'insensitive' } },
            { displayName: { equals: inviterName, mode: 'insensitive' } },
            { globalName: { equals: inviterName, mode: 'insensitive' } },
          ],
        },
        select: { userId: true, avatarUrl: true },
      }).catch(() => null);
      if (inviterProfile) {
        invite.inviterId = inviterProfile.userId;
        invite.inviterAvatarUrl = inviterProfile.avatarUrl || null;
      }
    }
  }

  if (invite && invite.inviterId) {
    const cachedUser = client.users.cache.get(invite.inviterId);
    if (cachedUser) {
      invite.inviterTag = cachedUser.tag || cachedUser.username;
      invite.inviterAvatarUrl = resolveUserAvatarUrl(cachedUser, 64);
    } else {
      const fetchedUser = await client.users.fetch(invite.inviterId).catch(() => null);
      if (fetchedUser) {
        invite.inviterTag = fetchedUser.tag || fetchedUser.username;
        invite.inviterAvatarUrl = fetchedUser.displayAvatarURL({ size: 64 }) || null;
      } else {
        const inviterProfile = await prisma.memberProfile.findFirst({
          where: { guildId, userId: invite.inviterId },
          select: { userTag: true, displayName: true, username: true, avatarUrl: true }
        }).catch(() => null);
        if (inviterProfile) {
          invite.inviterTag = inviterProfile.displayName || inviterProfile.userTag || inviterProfile.username;
          invite.inviterAvatarUrl = inviterProfile.avatarUrl || null;
        }
      }
    }
  }

  if (invite && invite.inviterId && !invite.inviterTag) {
    invite.inviterTag = `Utilisateur ${invite.inviterId}`;
  }

    const messages = (auditLogs || [])
      .filter((entry) => {
        if (entry.module !== 'Messages' || entry.action !== 'Message envoyé') return false;
        if (!entry.user) return false;
        return entry.user === actualUserId || entry.user.endsWith(`(${actualUserId})`);
      })
      .slice(0, 250)
      .map((entry) => {
        const msgId = extractMessageId(entry.details);
        return {
          id: entry.id,
          channelId: entry.channelId ?? 'unknown',
          channelName: formatChannelName(discordGuild, entry.channelId),
          content: interpretMentions(discordGuild, extractMessagePreview(entry.details) ?? entry.details),
          dateIso: safeIsoDate(entry.dateIso) || new Date().toISOString(),
          discordUrl: msgId ? `https://discord.com/channels/${guildId}/${entry.channelId}/${msgId}` : null,
        };
      });

  const messagesByChannelMap = new Map<string, MemberCaseChannelSummary>();
  for (const message of messages) {
    const current = messagesByChannelMap.get(message.channelId) ?? {
      channelId: message.channelId,
      channelName: message.channelName,
      count: 0,
      lastMessageAt: null,
      recentMessages: [],
    };

    current.count += 1;
    current.lastMessageAt = message.dateIso;
    if (current.recentMessages.length < 5) {
      current.recentMessages.push(message);
    }
    messagesByChannelMap.set(message.channelId, current);
  }

    const extractIdFromUserStr = (str: string | null | undefined): string | null => {
      if (!str) return null;
      const match = str.match(/\(<@(\d+)>\)/);
      if (match) return match[1];
      const rawIdMatch = str.match(/^(\d+)$/);
      return rawIdMatch ? rawIdMatch[1] : null;
    };

    const nodes: MemberCaseInteractionNode[] = [
      {
        id: actualUserId,
        label: displayLabel,
        type: 'user',
        avatar: profile?.avatarUrl ?? resolveUserAvatarUrl(user, 128),
      },
    ];
    const edges: MemberCaseInteractionEdge[] = [];
    const targets = new Map<string, { label: string; mention: number; reply: number; reaction: number; total: number }>();

    const getOrCreateTarget = (targetId: string, defaultLabel: string) => {
      let t = targets.get(targetId);
      if (!t) {
        t = { label: defaultLabel, mention: 0, reply: 0, reaction: 0, total: 0 };
        targets.set(targetId, t);
      }
      return t;
    };

    for (const log of auditLogs || []) {
      const logUserId = extractIdFromUserStr(log.user);
      if (!logUserId) continue;

      if (log.module === 'Messages' && log.action === 'Message envoyé') {
        const details = log.details || '';
        const contentMatch = details.match(/Contenu: (.*)/);
        const content = contentMatch ? contentMatch[1] : details;

        const mentionRegex = /<@!?(\d+)>/g;
        let match;
        const processedMentions = new Set<string>();
        while ((match = mentionRegex.exec(content)) !== null) {
          const targetId = match[1];
          if (processedMentions.has(targetId)) continue;
          processedMentions.add(targetId);

          if (logUserId === actualUserId) {
            if (targetId !== actualUserId) {
              const t = getOrCreateTarget(targetId, `User ${targetId}`);
              t.mention += 1;
              t.total += 1;
            }
          } else {
            if (targetId === actualUserId) {
              const t = getOrCreateTarget(logUserId, `User ${logUserId}`);
              t.mention += 1;
              t.total += 1;
            }
          }
        }

        const replyMatch = details.match(/Réponse à:\s*<@!?(\d+)>/i);
        if (replyMatch) {
          const targetId = replyMatch[1];
          if (logUserId === actualUserId) {
            if (targetId !== actualUserId) {
              const t = getOrCreateTarget(targetId, `User ${targetId}`);
              t.reply += 1;
              t.total += 1;
            }
          } else {
            if (targetId === actualUserId) {
              const t = getOrCreateTarget(logUserId, `User ${logUserId}`);
              t.reply += 1;
              t.total += 1;
            }
          }
        }
      } else if (log.module === 'Interactions' && log.action === 'Réaction ajoutée') {
        const details = log.details || '';
        const targetMatch = details.match(/Cible:\s*.*?\(<@!?(\d+)>\)/i);
        if (targetMatch) {
          const targetId = targetMatch[1];
          if (logUserId === actualUserId) {
            if (targetId !== actualUserId) {
              const t = getOrCreateTarget(targetId, `User ${targetId}`);
              t.reaction += 1;
              t.total += 1;
            }
          } else {
            if (targetId === actualUserId) {
              const t = getOrCreateTarget(logUserId, `User ${logUserId}`);
              t.reaction += 1;
              t.total += 1;
            }
          }
        }
      }
    }

    const topTargets = [...targets.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 40);

    const topTargetIds = new Set(topTargets.map(([id]) => id));

    for (const [targetId, data] of topTargets) {
      let targetLabel = data.label;
      let targetAvatar: string | null = null;
      const cachedUser = client.users.cache.get(targetId);
      if (cachedUser) {
        targetLabel = cachedUser.tag;
        targetAvatar = resolveUserAvatarUrl(cachedUser, 128);
      }

      nodes.push({ id: targetId, label: targetLabel, type: 'target', avatar: targetAvatar });

      if (data.mention > 0) {
        edges.push({ from: actualUserId, to: targetId, type: 'mention', count: data.mention });
      }
      if (data.reply > 0) {
        edges.push({ from: actualUserId, to: targetId, type: 'reply', count: data.reply });
      }
      if (data.reaction > 0) {
        edges.push({ from: actualUserId, to: targetId, type: 'reaction', count: data.reaction });
      }
    }

    const crossEdges = new Map<string, { mention: number; reply: number; reaction: number }>();
    for (const log of auditLogs || []) {
      const logUserId = extractIdFromUserStr(log.user);
      if (!logUserId || !topTargetIds.has(logUserId)) continue;

      if (log.module === 'Messages' && log.action === 'Message envoyé') {
        const details = log.details || '';
        const contentMatch = details.match(/Contenu: (.*)/);
        const content = contentMatch ? contentMatch[1] : details;

        const mentionRegex = /<@!?(\d+)>/g;
        let match;
        while ((match = mentionRegex.exec(content)) !== null) {
          const otherId = match[1];
          if (otherId !== logUserId && otherId !== actualUserId && topTargetIds.has(otherId)) {
            const key = logUserId < otherId ? `${logUserId}:${otherId}` : `${otherId}:${logUserId}`;
            const ce = crossEdges.get(key) ?? { mention: 0, reply: 0, reaction: 0 };
            ce.mention += 1;
            crossEdges.set(key, ce);
          }
        }

        const replyMatch = details.match(/Réponse à:\s*<@!?(\d+)>/i);
        if (replyMatch) {
          const otherId = replyMatch[1];
          if (otherId !== logUserId && otherId !== actualUserId && topTargetIds.has(otherId)) {
            const key = logUserId < otherId ? `${logUserId}:${otherId}` : `${otherId}:${logUserId}`;
            const ce = crossEdges.get(key) ?? { mention: 0, reply: 0, reaction: 0 };
            ce.reply += 1;
            crossEdges.set(key, ce);
          }
        }
      } else if (log.module === 'Interactions' && log.action === 'Réaction ajoutée') {
        const details = log.details || '';
        const targetMatch = details.match(/Cible:\s*.*?\(<@!?(\d+)>\)/i);
        if (targetMatch) {
          const otherId = targetMatch[1];
          if (otherId !== logUserId && otherId !== actualUserId && topTargetIds.has(otherId)) {
            const key = logUserId < otherId ? `${logUserId}:${otherId}` : `${otherId}:${logUserId}`;
            const ce = crossEdges.get(key) ?? { mention: 0, reply: 0, reaction: 0 };
            ce.reaction += 1;
            crossEdges.set(key, ce);
          }
        }
      }
    }

    for (const [key, data] of crossEdges) {
      const [fromId, toId] = key.split(':');
      if (data.mention > 0) edges.push({ from: fromId, to: toId, type: 'mention', count: data.mention });
      if (data.reply > 0) edges.push({ from: fromId, to: toId, type: 'reply', count: data.reply });
      if (data.reaction > 0) edges.push({ from: fromId, to: toId, type: 'reaction', count: data.reaction });
    }

    // Le statut en ligne disparaît de la fiche quand le membre a coupé le suivi
    // de sa présence ; « left » n'en relève pas, c'est une donnée d'adhésion.
    const livePresenceStatus = await visiblePresenceStatus(guildId, actualUserId, member?.presence?.status ?? null);

    const result: MemberCaseResponse = {
      profile: {
        id: profile?.id ?? `${guildId}:${actualUserId}`,
        userId: actualUserId,
        userTag: user?.tag ?? profile?.userTag ?? null,
        username: user?.username ?? profile?.username ?? null,
        globalName: user?.globalName ?? profile?.globalName ?? null,
        displayName: member?.displayName ?? profile?.displayName ?? user?.globalName ?? user?.username ?? null,
        avatarUrl: resolveMemberAvatarUrl(member, 256) ?? profile?.avatarUrl ?? resolveUserAvatarUrl(user, 256),
        bannerUrl: profile?.bannerUrl ?? null,
        accentColor: profile?.accentColor ?? user?.accentColor ?? null,
        locale: profile?.locale ?? null,
        isBot: profile?.isBot ?? user?.bot ?? false,
        accountCreatedAt: safeIsoDate(profile?.accountCreatedAt ?? user?.createdAt),
        guildJoinedAt: safeIsoDate(profile?.guildJoinedAt ?? member?.joinedAt),
        guildLeftAt: safeIsoDate(profile?.guildLeftAt),
        firstSeenAt: safeIsoDate(profile?.firstSeenAt),
        lastSeenAt: safeIsoDate(profile?.lastSeenAt),
        lastMessageAt: safeIsoDate(profile?.lastMessageAt),
        lastMessageChannelId: profile?.lastMessageChannelId ?? null,
        messageCount: profile?.messageCount ?? 0,
        voiceSessionCount: profile?.voiceSessionCount ?? 0,
        voiceTimeSeconds: profile?.voiceTimeSeconds ?? 0,
        voiceLastChannelId: profile?.voiceLastChannelId ?? null,
        voiceLastJoinedAt: safeIsoDate(profile?.voiceLastJoinedAt),
        voiceLastLeftAt: safeIsoDate(profile?.voiceLastLeftAt),
        rolesSnapshot: profile?.rolesSnapshot ?? [],
        presenceStatus: livePresenceStatus ?? (!isOnServer || profile?.guildLeftAt ? 'left' : null),
        pronouns: null,
        isTutor: staffMember?.isTutor ?? false,
        staffGrade: staffMember?.grade ?? null,
        isSuspectedDC: profile?.isSuspectedDC ?? false,
        moderatorNote: profile?.moderatorNote ?? null,
        isOnServer,
      },
      invite: invite
        ? {
            ...invite,
            joinedAt: invite.joinedAt ?? safeIsoDate(member?.joinedAt ?? profile?.guildJoinedAt),
          }
        : null,
      roles,
      effectivePermissions,
      sanctions: (sanctions || []).map((entry) => ({
        id: entry.id,
        type: entry.type as DashboardSanctionType,
        status: entry.status as DashboardSanctionStatus,
        targetUserId: entry.targetUserId,
        targetTag: entry.targetTag ?? `Utilisateur ${entry.targetUserId}`,
        moderatorUserId: entry.moderatorUserId,
        moderatorTag: entry.moderatorTag ?? `Modérateur ${entry.moderatorUserId}`,
        reason: entry.reason,
        durationSeconds: entry.durationSeconds,
        expiresAt: safeIsoDate(entry.expiresAt),
        createdAt: safeIsoDate(entry.createdAt) || new Date().toISOString(),
        resolvedAt: safeIsoDate(entry.resolvedAt),
        resolutionNote: entry.resolutionNote ?? null,
        archivedAt: safeIsoDate(entry.archivedAt),
        archiveReason: entry.archiveReason ?? null,
        appealable: entry.appealable,
        appealLockReason: entry.appealLockReason ?? null,
      })),
      logs: mappedLogs,
      messagesByChannel: [...messagesByChannelMap.values()].sort((left, right) => (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? '')),
      recentMessageCount: messages.length,
      recentLogCount: mappedLogs.length,
      connections: inviteConnections?.connections || [],
      connectionsNote: inviteConnections?.note || "",
      isSuspectedDC: profile?.isSuspectedDC ?? false,
      crossServerSanctions,
      crossServerLinks,
      interactionGraph: { nodes, edges },
      candidatures: (candidatureHistory || []).map((c) => ({
        id: c.id,
        status: c.status,
        notes: c.notes ?? '',
        createdAt: safeIsoDate(c.createdAt) || new Date().toISOString(),
        data: c.data,
        autoRejected: c.autoRejected,
        autoRejectReason: c.autoRejectReason,
        rejectionReason: c.rejectionReason,
        oralResult: c.oralResult,
        reapplyAfter: safeIsoDate(c.reapplyAfter),
      })),
      sanctionReports: (sanctionReports || []).map((entry) => ({
        id: entry.id,
        sanctionId: entry.sanctionId ?? null,
        staffPseudo: entry.staffPseudo,
        incidentAt: safeIsoDate(entry.incidentAt) || new Date().toISOString(),
        memberPseudo: entry.memberPseudo,
        memberReference: entry.memberReference,
        sanctionType: entry.sanctionType as DashboardSanctionType,
        sanctionDurationLabel: entry.sanctionDurationLabel ?? null,
        brokenRules: entry.brokenRules,
        detailedReason: entry.detailedReason,
        evidenceLinks: parseEvidenceLinks(entry.evidenceLinks),
        additionalNotes: entry.additionalNotes ?? null,
        createdByUserId: entry.createdByUserId,
        createdByTag: entry.createdByTag ?? null,
        createdAt: safeIsoDate(entry.createdAt) || new Date().toISOString(),
      })),
      linkedAccounts: await Promise.all(
        linkedUserIds
          .filter(id => id !== actualUserId)
          .map(async (lid) => {
            try {
              const lProfile = await prisma.memberProfile.findUnique({
                where: { guildId_userId: { guildId, userId: lid } },
                select: { userTag: true, username: true, displayName: true, avatarUrl: true }
              });
              const lLink = await prisma.linkedAccount.findFirst({
                where: {
                  guildId,
                  OR: [
                    { user1Id: actualUserId, user2Id: lid },
                    { user1Id: lid, user2Id: actualUserId }
                  ]
                }
              });
              return {
                userId: lid,
                userTag: lProfile?.displayName ?? lProfile?.userTag ?? lProfile?.username ?? `Utilisateur ${lid}`,
                avatarUrl: lProfile?.avatarUrl ?? null,
                type: lLink?.type ?? 'DC',
                status: lLink?.status ?? 'UNKNOWN'
              };
            } catch (e) {
              return {
                userId: lid,
                userTag: `Utilisateur ${lid}`,
                avatarUrl: null,
                type: 'DC',
                status: 'UNKNOWN'
              };
            }
          })
      ),
      verifications: await buildVerificationsPayload(guildId, actualUserId),
    };

    return result;
  } catch (err) {
    logger.error('MembersAPI', `Fatal error building member case for ${actualUserId}:`, err);
    throw err;
  }
}
