import { IncomingMessage, ServerResponse } from 'node:http';
import { type GuildMember, Client, EmbedBuilder } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { resolveViewTimezone } from '../../../utils/timezone.js';
import { COLORS } from '../../../utils/embeds.js';
import * as altAccountService from '../../../services/moderation/altAccountService.js';
import { scanGuildMembersForYoungAccounts, getDetectionEvidence } from '../../../services/moderation/dcDetectionService.js';
import { memberProfileIdentity, resolveMemberAvatarUrl, resolveMissingMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { findPresenceOptOuts } from '../../../services/core/presencePrivacyService.js';
import { LinkedAccountType, LinkedAccountStatus } from '@prisma/client';
import {
  json,
  readJsonBody,
  getGuildName,
  getGuildMembers,
  buildMemberCaseData,
  pushAudit,
  safePushAudit,
  broadcastDashboardStateChange,
  formatDurationFr,
  getDashboardUrl,
  type AuthClaims,
  type DashboardAccess,
  type MemberCaseQuickAction,
  type FeatureAccessMap,
} from '../../shared.js';
import {
  registerBanSanction,
  registerKickSanction,
  registerTimeoutSanction,
  registerWarnSanction,
  runGuildBan,
} from '../../../services/moderation/sanctionService.js';
import { sendBanAppealNotificationDM } from '../../../services/moderation/banAppealService.js';

export async function handleMembersRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
  featureAccess: FeatureAccessMap
): Promise<boolean> {
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;

  // 1. Linked Accounts Management
  if (parts[4] === 'linked-accounts') {
    const isAdmin = access.level === 'admin';
    const isStaff = isAdmin || access.level === 'moderator';

    if (!isStaff) {
      json(res, 403, { error: 'Accès refusé' });
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/linked-accounts
    if (method === 'GET') {
      try {
        const page = Number(url.searchParams.get('page') ?? '1') || 1;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200);
        const skip = (page - 1) * limit;

        const [linkedAccounts, total] = await Promise.all([
          prisma.linkedAccount.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          prisma.linkedAccount.count({ where: { guildId } }),
        ]);

        // Batch-fetch all member profiles in 1 query instead of 2*N
        const userIds = [...new Set(linkedAccounts.flatMap(a => [a.user1Id, a.user2Id]))];
        const profiles = userIds.length > 0
          ? await prisma.memberProfile.findMany({
              where: { guildId, userId: { in: userIds } },
              select: { userId: true, username: true, avatarUrl: true },
            })
          : [];
        const profileMap = new Map(profiles.map(p => [p.userId, p]));

        const enriched = linkedAccounts.map((acc) => {
          const p1 = profileMap.get(acc.user1Id);
          const p2 = profileMap.get(acc.user2Id);
          return {
            ...acc,
            user1: p1 ? { tag: p1.username, avatar: p1.avatarUrl } : { tag: acc.user1Id, avatar: null },
            user2: p2 ? { tag: p2.username, avatar: p2.avatarUrl } : { tag: acc.user2Id, avatar: null },
          };
        });

        json(res, 200, { data: enriched, total, page, limit });
      } catch (err) {
        logger.error('LinkedAccountsAPI', 'Error fetching linked accounts:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des comptes liés' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/linked-accounts/:id
    if (parts.length === 6 && method === 'PATCH') {
      try {
        const id = parts[5];
        const body = await readJsonBody<{ status: 'VALIDATED' | 'REJECTED' }>(req);
        
        if (!body?.status) {
          json(res, 400, { error: 'Statut requis' });
          return true;
        }

        const link = await prisma.linkedAccount.findUnique({
          where: { id }
        });

        if (!link) {
          json(res, 404, { error: 'Lien introuvable' });
          return true;
        }

        const updatedLink = await prisma.linkedAccount.update({
          where: { id },
          data: { status: body.status }
        });

        await pushAudit(guildId, {
          channelId: null,
          user: auditUser,
          action: body.status === 'VALIDATED' ? 'Validation Compte Lié' : 'Rejet Compte Lié',
          context: `Comptes: ${link.user1Id} et ${link.user2Id}`,
          module: 'Membres',
          eventType: 'Settings',
          details: `Statut: ${body.status} | Compte 1: ${link.user1Id} | Compte 2: ${link.user2Id}`,
        });

        if (body.status === 'VALIDATED') {
          const discordGuild = client.guilds.cache.get(guildId);
          const dmEmbed = new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('🔗 Comptes liés officiellement')
            .setDescription(`Vos comptes **<@${link.user1Id}>** et **<@${link.user2Id}>** ont été reliés sur **${discordGuild?.name || 'le serveur'}**.`)
            .setTimestamp();

          try {
            const member1 = await client.users.fetch(link.user1Id).catch(() => null);
            if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
          } catch { /* ignored */ }

          try {
            const member2 = await client.users.fetch(link.user2Id).catch(() => null);
            if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
          } catch { /* ignored */ }
        }

        json(res, 200, updatedLink);
      } catch (err) {
        logger.error('LinkedAccountsAPI', 'Error updating linked account:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour du compte lié' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/linked-accounts/:id
    if (parts.length === 6 && method === 'DELETE') {
      try {
        const id = parts[5];
        const link = await prisma.linkedAccount.findUnique({
          where: { id }
        });

        if (!link) {
          json(res, 404, { error: 'Lien introuvable' });
          return true;
        }

        await prisma.linkedAccount.delete({
          where: { id }
        });

        await pushAudit(guildId, {
          channelId: null,
          user: auditUser,
          action: 'Suppression Compte Lié',
          context: `Comptes: ${link.user1Id} et ${link.user2Id}`,
          module: 'Membres',
          eventType: 'Settings',
          details: `Compte 1: ${link.user1Id} | Compte 2: ${link.user2Id}`,
        });

        const discordGuild = client.guilds.cache.get(guildId);
        const dmEmbed = new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('🔗 Comptes déliés')
          .setDescription(`Vos comptes **<@${link.user1Id}>** et **<@${link.user2Id}>** ont été séparés sur **${discordGuild?.name || 'le serveur'}**.`)
          .setTimestamp();

        try {
          const member1 = await client.users.fetch(link.user1Id).catch(() => null);
          if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
        } catch { /* ignored */ }

        try {
          const member2 = await client.users.fetch(link.user2Id).catch(() => null);
          if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
        } catch { /* ignored */ }

        json(res, 200, { success: true });
      } catch (err) {
        logger.error('LinkedAccountsAPI', 'Error deleting linked account:', err);
        json(res, 500, { error: 'Erreur lors de la suppression du compte lié' });
      }
      return true;
    }
  }

  // 2. Suspected DC Detections
  // GET /api/dashboard/guilds/:guildId/detections - List suspected DC detections with evidence
  if (parts.length === 5 && parts[4] === 'detections' && method === 'GET') {
    try {
      if (!access.canManageSettings && !featureAccess.double_accounts?.canView) {
        json(res, 403, { error: "Accès refusé. Le module Détections n'est pas accessible." });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId);
      const discordMembers = new Map<string, GuildMember>();

      if (discordGuild) {
        const allServerMembers = await getGuildMembers(discordGuild).catch(() => null);
        if (allServerMembers) {
          for (const member of allServerMembers.values()) {
            discordMembers.set(member.id, member);
          }
        }
      }

      const suspiciousMembersRaw = await prisma.memberProfile.findMany({
        where: { guildId, isSuspectedDC: true },
        orderBy: [{ lastSeenAt: 'desc' }, { guildJoinedAt: 'desc' }],
        take: 200,
        select: {
          userId: true, username: true, displayName: true, userTag: true,
          avatarUrl: true, isBot: true, accountCreatedAt: true, guildJoinedAt: true,
          guildLeftAt: true, lastSeenAt: true, messageCount: true, isSuspectedDC: true,
        },
      });

      // Garde-fou : évite les userId en double (ex. lignes member_profiles dupliquées en base)
      // qui feraient planter le keyed #each côté dashboard (each_key_duplicate).
      const seenUserIds = new Set<string>();
      const suspiciousMembers = suspiciousMembersRaw.filter((member) => {
        if (seenUserIds.has(member.userId)) return false;
        seenUserIds.add(member.userId);
        return true;
      });

      // Confidentialité : un membre ayant coupé le suivi de sa présence
      // n'expose pas son statut en ligne, même dans une vue de modération.
      const presenceOptOuts = await findPresenceOptOuts(guildId, suspiciousMembers.map((member) => member.userId));

      const detections = await Promise.all(suspiciousMembers.map(async (member) => {
        const discordMember = discordMembers.get(member.userId) ?? null;
        const accountCreatedAt = member.accountCreatedAt?.toISOString() ?? null;
        const guildJoinedAt = discordMember?.joinedAt?.toISOString() ?? member.guildJoinedAt?.toISOString() ?? null;
        const createdTs = member.accountCreatedAt?.getTime() ?? null;
        const joinedTs = discordMember?.joinedTimestamp ?? member.guildJoinedAt?.getTime() ?? null;
        const accountAgeMs = createdTs !== null && joinedTs !== null ? Math.max(0, joinedTs - createdTs) : null;

        const evidence = await getDetectionEvidence(guildId, member.userId).catch(() => null);

        const suspectedAlts: Array<{ userId: string; username: string | null; avatarUrl: string | null }> = [];
        if (evidence?.suspectedAlts) {
          for (const altId of evidence.suspectedAlts.slice(0, 5)) {
            const altProfile = await prisma.memberProfile.findUnique({
              where: { guildId_userId: { guildId, userId: altId } },
              select: { username: true, avatarUrl: true }
            }).catch(() => null);
            const altDiscord = discordMembers.get(altId);
            suspectedAlts.push({
              userId: altId,
              username: altProfile?.username ?? altDiscord?.user?.username ?? null,
              avatarUrl: altProfile?.avatarUrl ?? resolveMemberAvatarUrl(altDiscord, 64),
            });
          }
        }

        return {
          id: member.userId,
          username: member.username ?? null,
          displayName: member.displayName ?? member.userTag ?? member.username ?? null,
          avatarUrl: resolveMemberAvatarUrl(discordMember, 256) ?? member.avatarUrl ?? null,
          isBot: member.isBot,
          accountCreatedAt, guildJoinedAt,
          guildLeftAt: member.guildLeftAt?.toISOString() ?? null,
          lastSeenAt: member.lastSeenAt?.toISOString() ?? null,
          messageCount: member.messageCount ?? 0,
          isOnServer: !!discordMember,
          presenceStatus: discordMember
            ? (presenceOptOuts.has(member.userId) ? null : discordMember.presence?.status ?? null)
            : 'left',
          accountAgeMs,
          accountAgeLabel: accountAgeMs !== null ? formatDurationFr(accountAgeMs) : 'Inconnue',
          suspectedAlts,
          evidence: evidence ? {
            reasons: evidence.reasons.map(r => ({ type: r.type, label: r.label, score: r.score, matchedUserId: r.matchedUserId, detail: r.detail })),
            totalScore: evidence.totalScore,
          } : null,
        };
      }));

      json(res, 200, { total: detections.length, detections });
    } catch (err) {
      logger.error('MembersAPI', 'Error fetching suspected detections:', err);
      json(res, 500, { error: 'Erreur lors du chargement des détections' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/detections/:userId/link - Link a detected user with their suspected alt
  if (parts.length === 7 && parts[4] === 'detections' && parts[6] === 'link' && method === 'POST') {
    try {
      if (!access.canManageSettings && !featureAccess.double_accounts?.canModerate) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }
      const targetUserId = parts[5];
      const body = await readJsonBody<{ altUserId: string; reason?: string }>(req);
      if (!body?.altUserId) {
        json(res, 400, { error: 'altUserId requis.' });
        return true;
      }
      await altAccountService.linkAccounts({
        guildId, user1Id: targetUserId, user2Id: body.altUserId,
        type: LinkedAccountType.AUTOMATIC, status: LinkedAccountStatus.VALIDATED,
        reason: body.reason || 'Lié depuis le dashboard (détection).',
        linkedByUserId: user.userId,
      });
      await prisma.memberProfile.updateMany({
        where: { guildId, userId: { in: [targetUserId, body.altUserId] } },
        data: { isSuspectedDC: false },
      }).catch(() => null);
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('MembersAPI', 'Error linking from detection:', err);
      json(res, 500, { error: 'Erreur lors de la liaison.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/detections/:userId/dismiss - Dismiss a detection (false positive)
  if (parts.length === 7 && parts[4] === 'detections' && parts[6] === 'dismiss' && method === 'POST') {
    try {
      if (!access.canManageSettings && !featureAccess.double_accounts?.canModerate) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }
      const targetUserId = parts[5];
      await prisma.memberProfile.updateMany({
        where: { guildId, userId: targetUserId },
        data: { isSuspectedDC: false },
      });
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('MembersAPI', 'Error dismissing detection:', err);
      json(res, 500, { error: 'Erreur.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/detections/:userId/restore - Restore a dismissed detection (undo)
  if (parts.length === 7 && parts[4] === 'detections' && parts[6] === 'restore' && method === 'POST') {
    try {
      if (!access.canManageSettings && !featureAccess.double_accounts?.canModerate) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }
      const targetUserId = parts[5];
      await prisma.memberProfile.updateMany({
        where: { guildId, userId: targetUserId },
        data: { isSuspectedDC: true },
      });
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('MembersAPI', 'Error restoring detection:', err);
      json(res, 500, { error: 'Erreur.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/detections/scan - Trigger a rescan of guild members for young accounts
  if (parts.length === 6 && parts[4] === 'detections' && parts[5] === 'scan' && method === 'POST') {
    try {
      if (!access.canManageSettings && !featureAccess.double_accounts?.canModerate) {
        json(res, 403, { error: "Accès refusé. Vous n'avez pas les permissions nécessaires pour lancer un scan." });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId);
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur Discord introuvable ou inaccessible par le bot' });
        return true;
      }

      let thresholdMs: number | undefined = undefined;
      const body = await readJsonBody<{ thresholdDays?: number }>(req).catch(() => null);
      if (body && body.thresholdDays !== undefined) {
        const days = Number(body.thresholdDays);
        if (Number.isNaN(days) || days < 1 || days > 30 || !Number.isInteger(days)) {
          json(res, 400, { error: 'Le seuil de jours doit être un entier compris entre 1 et 30.' });
          return true;
        }
        thresholdMs = days * 24 * 60 * 60 * 1000;
      }

      const result = await scanGuildMembersForYoungAccounts(discordGuild, thresholdMs);

      json(res, 200, {
        success: true,
        scannedCount: result.scannedCount,
        flaggedCount: result.flaggedCount,
      });
    } catch (err) {
      logger.error('MembersAPI', 'Error scanning suspected detections:', err);
      json(res, 500, { error: 'Erreur lors du scan des détections' });
    }
    return true;
  }

  // 3. Members search, Case files, and Note editing
  // GET /api/dashboard/guilds/:guildId/members/search - Pagination SQL via MemberRepository
  if (parts.length === 6 && parts[4] === 'members' && parts[5] === 'search' && method === 'GET') {
    try {
      const searchQuery = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '24'), 100);
      const page = Math.max(Number(url.searchParams.get('page') ?? '1'), 1);
      const sortBy = url.searchParams.get('sortBy') ?? 'lastSeenAt';
      const sortOrder = url.searchParams.get('sortOrder') ?? 'desc';
      const serverStatus = url.searchParams.get('serverStatus') ?? 'on_server';
      const botFilter = url.searchParams.get('botFilter') ?? 'human';

      const validSortFields = ['lastSeenAt', 'messageCount', 'guildJoinedAt'] as const;
      const finalSortBy = (validSortFields as readonly string[]).includes(sortBy)
        ? (sortBy as typeof validSortFields[number])
        : 'lastSeenAt';

      const botFilterMap: Record<string, 'include' | 'exclude' | 'only'> = {
        human: 'exclude',
        bot: 'only',
        all: 'include',
      };
      const serverStatusMap: Record<string, 'on_server' | 'left' | undefined> = {
        on_server: 'on_server',
        left: 'left',
        all: undefined,
      };

      const { MemberRepository } = await import('@kotbo/database');
      const memberRepo = new MemberRepository(prisma);

      const result = await memberRepo.search({
        guildId,
        query: searchQuery || undefined,
        page,
        limit,
        sortBy: finalSortBy,
        sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
        serverStatus: serverStatusMap[serverStatus],
        botFilter: botFilterMap[botFilter] ?? 'exclude',
      });

      // Compteurs globaux
      const discordGuild = client.guilds.cache.get(guildId);
      const [dbOnServerCount, leftCount, botCount] = await Promise.all([
        prisma.memberProfile.count({ where: { guildId, guildLeftAt: null } }),
        prisma.memberProfile.count({ where: { guildId, guildLeftAt: { not: null } } }),
        prisma.memberProfile.count({ where: { guildId, isBot: true } }),
      ]);
      const onServerCount = discordGuild?.memberCount ?? dbOnServerCount;

      // Type explicite : la liste peut ensuite etre remplacee par un repli
      // Discord, dont certains champs sont absents (dernier passage, messages).
      type MemberListEntry = {
        id: string;
        username: string;
        displayName: string;
        avatarUrl: string | null;
        isBot: boolean;
        lastSeenAt: string | null;
        messageCount: number;
        guildJoinedAt: string | null;
        guildLeftAt: string | null;
        isOnServer: boolean;
      };

      // Certaines lignes de profil sont créées sans identité (détection de
      // doubles comptes, note de modération, adhésion à un clan) : sans ce
      // rattrapage, elles s'affichent en « Utilisateur inconnu » alors que la
      // fiche membre, qui interroge Discord, montre le bon compte.
      const identities = await resolveMissingMemberIdentities(
        client,
        guildId,
        result.members.filter((m) => !m.username).map((m) => m.userId),
      ).catch((err) => {
        logger.warn('MembersAPI', 'Identités membres non complétées:', err);
        return new Map<string, { username: string; displayName: string; avatarUrl: string }>();
      });

      let members: MemberListEntry[] = result.members.map((m) => {
        const identity = m.username ? undefined : identities.get(m.userId);
        return {
          id: m.userId,
          username: m.username ?? identity?.username ?? 'Utilisateur inconnu',
          displayName: m.displayName ?? identity?.displayName ?? m.username ?? 'Utilisateur inconnu',
          avatarUrl: m.avatarUrl ?? identity?.avatarUrl ?? null,
          isBot: m.isBot,
          lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
          messageCount: m.messageCount,
          guildJoinedAt: m.guildJoinedAt?.toISOString() ?? null,
          guildLeftAt: m.guildLeftAt?.toISOString() ?? null,
          isOnServer: !m.guildLeftAt,
        };
      });

      // Fallback Discord : si la recherche DB ne trouve rien, chercher sur Discord
      if (members.length === 0 && searchQuery && discordGuild && serverStatus !== 'left') {
        const discordResults = await discordGuild.members.search({ query: searchQuery, limit }).catch(() => null);
        if (discordResults && discordResults.size > 0) {
          members = discordResults.map((dm) => ({
            id: dm.id,
            username: dm.user.username,
            displayName: dm.displayName ?? dm.user.username,
            avatarUrl: resolveMemberAvatarUrl(dm, 128),
            isBot: dm.user.bot,
            lastSeenAt: null,
            messageCount: 0,
            guildJoinedAt: dm.joinedAt?.toISOString() ?? null,
            guildLeftAt: null,
            isOnServer: true,
          }));
        }
      }

      json(res, 200, {
        members,
        totalFound: members.length > result.totalFound ? members.length : result.totalFound,
        totalPages: result.totalPages,
        onServerCount,
        leftCount,
        botCount,
      });
    } catch (err) {
      logger.error('MembersAPI', 'Error searching members:', err);
      json(res, 500, { error: 'Erreur lors de la recherche de membres', details: String(err) });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/members/:userId - Get member detailed case file
  if (parts.length === 6 && parts[4] === 'members' && method === 'GET') {
    try {
      const memberCase = await buildMemberCaseData(client, guildId, parts[5], user);
      if (!memberCase) {
        json(res, 404, { error: 'Membre introuvable ou identifiant invalide.' });
        return true;
      }
      json(res, 200, memberCase);
    } catch (err) {
      logger.error('MembersAPI', `Error building member case for ${parts[5]}:`, err);
      json(res, 500, { error: 'Erreur lors de la construction du dossier membre', details: String(err) });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/members/:userId/link - Link alternative account
  if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'link' && method === 'POST') {
    try {
      const u1Id = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
      const body = await readJsonBody<{ targetAccountId?: string; reason?: string }>(req);
      const u2Id = body?.targetAccountId;
      const reason = body?.reason;

      if (!u2Id) {
        json(res, 400, { error: "L'ID du compte cible est requis." });
        return true;
      }

      if (u1Id === u2Id) {
        json(res, 400, { error: 'Impossible de lier un compte à lui-même.' });
        return true;
      }

      const isStaffDb = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId: guildId, userId: user.userId } } });
      const isAdmin = access.level === 'admin';
      const isStaff = isAdmin || !!isStaffDb || access.level === 'moderator';

      if (!isStaff) {
        json(res, 403, { error: 'Accès refusé' });
        return true;
      }

      if (!isAdmin && !reason) {
        json(res, 400, { error: 'En tant que membre du staff, tu dois obligatoirement fournir une raison pour lier ces comptes.' });
        return true;
      }

      await altAccountService.linkAccounts({
        guildId,
        user1Id: u1Id,
        user2Id: u2Id,
        type: 'MANUAL',
        status: 'VALIDATED',
        reason: reason || 'Action Administrateur (Dashboard)',
        linkedByUserId: user.userId,
        metadata: { linkedBy: user.userId, source: 'dashboard', at: new Date().toISOString() }
      });

      const discordGuild = client.guilds.cache.get(guildId);
      const dmEmbed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('🔗 Comptes liés officiellement')
        .setDescription(`Vos comptes **<@${u1Id}>** et **<@${u2Id}>** ont été reliés sur **${discordGuild?.name || 'le serveur'}**.`)
        .addFields({ name: 'Raison / Notes', value: reason || 'Liaison validée par le staff.', inline: false })
        .setTimestamp();

      try {
        const member1 = await client.users.fetch(u1Id).catch(() => null);
        if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
      } catch { /* ignored */ }

      try {
        const member2 = await client.users.fetch(u2Id).catch(() => null);
        if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
      } catch { /* ignored */ }

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('MembersAPI', `Error linking accounts for ${parts[5]}:`, err);
      json(res, 500, { error: 'Erreur lors de la liaison des comptes', details: String(err) });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/members/:userId/link/:targetId - Unlink accounts
  if (parts.length === 8 && parts[4] === 'members' && parts[6] === 'link' && method === 'DELETE') {
    try {
      const u1Id = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
      const u2Id = parts[7];

      const isStaffDb = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId: guildId, userId: user.userId } } });
      const isAdmin = access.level === 'admin';
      const isStaff = isAdmin || !!isStaffDb || access.level === 'moderator';

      if (!isStaff) {
        json(res, 403, { error: 'Accès refusé' });
        return true;
      }

      await altAccountService.unlinkAccounts(guildId, u1Id, u2Id);
      
      const discordGuild = client.guilds.cache.get(guildId);
      const dmEmbed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('🔗 Comptes déliés')
        .setDescription(`Vos comptes **<@${u1Id}>** et **<@${u2Id}>** ont été séparés sur **${discordGuild?.name || 'le serveur'}**.`)
        .setTimestamp();

      try {
        const member1 = await client.users.fetch(u1Id).catch(() => null);
        if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
      } catch { /* ignored */ }

      try {
        const member2 = await client.users.fetch(u2Id).catch(() => null);
        if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
      } catch { /* ignored */ }

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('MembersAPI', `Error unlinking accounts for ${parts[5]}:`, err);
      json(res, 500, { error: 'Erreur lors de la suppression de la liaison', details: String(err) });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/members/:userId/actions - Moderation actions
  if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'actions' && method === 'POST') {
    if (!access.canModerateContent) {
      json(res, 403, { error: 'Action de modération non autorisée.' });
      return true;
    }

    const userId = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
    const body = await readJsonBody<{
      type?: MemberCaseQuickAction;
      reason?: string;
      durationMs?: number | null;
    }>(req);

    const action = body?.type;
    const reason = body?.reason?.trim() || 'Action lancée depuis le profil membre.';
    const discordGuild = client.guilds.cache.get(guildId);
    if (!discordGuild) {
      json(res, 404, { error: 'Serveur Discord introuvable.' });
      return true;
    }

    try {
      const targetUser = await client.users.fetch(userId).catch(() => null);
      const targetMember = await discordGuild.members.fetch(userId).catch(() => null);
      const moderator = { id: user.userId, tag: user.username ?? `Utilisateur ${user.userId}` };
      const target = {
        id: userId,
        tag: targetUser?.tag ?? targetMember?.user.tag ?? `Utilisateur ${userId}`,
      };

      if (!action || !['WARN', 'KICK', 'TIMEOUT', 'BAN', 'REQUEST_VERIFICATION'].includes(action)) {
        json(res, 400, { error: "Type d'action invalide." });
        return true;
      }

      if (action === 'REQUEST_VERIFICATION') {
        if (!targetMember) {
          json(res, 404, { error: 'Le membre doit être présent sur le serveur.' });
          return true;
        }

        const {
          createVerificationSession,
          buildVerificationUrl,
          buildVerificationEmbed,
          getVerificationHistory,
        } = await import('../../../services/moderation/securityVerificationService.js');

        // Anti-spam : chaque demande timeout le membre 28 jours et lui envoie un
        // MP. Deux modérateurs qui cliquent coup sur coup le harcèlent sans rien
        // apprendre de plus (issue #216).
        const history = await getVerificationHistory(guildId, userId);
        if (history.hasPending) {
          json(res, 409, {
            error: 'Une demande de vérification est déjà en cours pour ce membre.',
            verifications: { hasPending: true, cooldownUntil: history.cooldownUntil?.toISOString() ?? null },
          });
          return true;
        }
        if (history.cooldownUntil) {
          const waitMinutes = Math.max(1, Math.ceil((history.cooldownUntil.getTime() - Date.now()) / 60000));
          json(res, 429, {
            error: `Une vérification vient d'être demandée pour ce membre. Réessayez dans ${waitMinutes} min.`,
            verifications: { hasPending: false, cooldownUntil: history.cooldownUntil.toISOString() },
          });
          return true;
        }

        const token = await createVerificationSession(guildId, userId);


        // 28 days timeout to force verification
        const TIMEOUT_DURATION = 28 * 24 * 60 * 60 * 1000;
        await targetMember.timeout(TIMEOUT_DURATION, `Vérification de sécurité requise par ${moderator.tag}`).catch((err) => {
          logger.error('MembersAPI', `Failed to timeout ${userId}:`, err);
        });

        const verifyUrl = buildVerificationUrl(getDashboardUrl(), guildId, token);
        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            verificationEmbedTitle: true,
            verificationEmbedDesc: true,
            verificationEmbedColor: true,
          },
        });
        const embedTitle = guildConfig?.verificationEmbedTitle || "Vérification de sécurité";
        const embedDesc = guildConfig?.verificationEmbedDesc || "Vous devez vérifier votre identité pour regagner l'accès au serveur.";
        const embedColor = guildConfig?.verificationEmbedColor || "#5865F2";
        
        const { embed, row } = buildVerificationEmbed(
          discordGuild.name,
          embedTitle,
          embedDesc,
          embedColor,
          verifyUrl
        );

        let dmSent = false;
        try {
          await targetMember.send({ embeds: [embed], components: [row] });
          dmSent = true;
        } catch (err) {
          logger.warn('MembersAPI', `Failed to send DM to ${targetMember.user.tag}:`, err);
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Demande de vérification forcée',
          context: getGuildName(client, guildId),
          module: 'Sanctions',
          eventType: 'Manuel',
          details: `Vérification forcée pour ${target.tag} (${target.id}). Raison: ${reason}. DM envoyé: ${dmSent ? 'Oui' : 'Non'}. Membre mis en Timeout.`,
          channelId: null,
        });

        json(res, 200, { ok: true, dmSent });
        return true;
      }

      if (action === 'WARN') {
        const sanction = await registerWarnSanction({ guildId, target, moderator, reason });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Warn depuis le profil membre',
          context: getGuildName(client, guildId),
          module: 'Sanctions',
          eventType: 'Manuel',
          details: `Warn appliqué à ${target.tag} (${target.id}). Raison: ${reason}`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'member_warned');
        json(res, 200, { ok: true, sanctionId: sanction.id });
        return true;
      }

      if (action === 'KICK') {
        if (!targetMember) {
          json(res, 404, { error: 'Le membre doit être présent sur le serveur pour être expulsé.' });
          return true;
        }
        if (!targetMember.kickable) {
          json(res, 400, { error: 'Le bot ne peut pas exclure ce membre.' });
          return true;
        }

        await targetMember.kick(`${reason} | Modération: ${user.username ?? user.userId}`);
        const sanction = await registerKickSanction({ guildId, target, moderator, reason });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Kick depuis le profil membre',
          context: getGuildName(client, guildId),
          module: 'Sanctions',
          eventType: 'Manuel',
          details: `Kick appliqué à ${target.tag} (${target.id}). Raison: ${reason}`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'member_kicked');
        json(res, 200, { ok: true, sanctionId: sanction.id });
        return true;
      }

      if (action === 'TIMEOUT') {
        if (!targetMember) {
          json(res, 404, { error: 'Le membre doit être présent sur le serveur pour un timeout.' });
          return true;
        }
        if (!targetMember.moderatable) {
          json(res, 400, { error: 'Le bot ne peut pas appliquer de timeout à ce membre.' });
          return true;
        }

        const durationMs = Number(body?.durationMs ?? 0);
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
          json(res, 400, { error: 'Une durée valide en millisecondes est requise pour le timeout.' });
          return true;
        }

        const sanction = await registerTimeoutSanction({
          guildId,
          target,
          moderator,
          reason,
          durationMs,
          member: targetMember,
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Timeout depuis le profil membre',
          context: getGuildName(client, guildId),
          module: 'Sanctions',
          eventType: 'Manuel',
          details: `Timeout appliqué à ${target.tag} (${target.id}) pour ${Math.floor(durationMs / 1000)}s. Raison: ${reason}`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'member_timeout');
        json(res, 200, { ok: true, sanctionId: sanction.id });
        return true;
      }

      if (action === 'BAN') {
        if (targetMember && !targetMember.bannable) {
          json(res, 400, { error: 'Le bot ne peut pas bannir ce membre.' });
          return true;
        }

        // Le DM avec le lien d'appel doit partir avant le ban (sinon le bot
        // peut ne plus partager de serveur avec le membre pour lui écrire).
        await sendBanAppealNotificationDM(client, guildId, userId).catch(() => false);
        await runGuildBan(discordGuild, userId, `${reason} | Modération: ${user.username ?? user.userId}`);
        const sanction = await registerBanSanction({ guildId, target, moderator, reason });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Ban depuis le profil membre',
          context: getGuildName(client, guildId),
          module: 'Sanctions',
          eventType: 'Manuel',
          details: `Ban appliqué à ${target.tag} (${target.id}). Raison: ${reason}`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'member_banned');
        json(res, 200, { ok: true, sanctionId: sanction.id });
        return true;
      }
    } catch (err) {
      logger.error('MembersAPI', `Error executing moderation action for ${userId}:`, err);
      json(res, 500, { error: "Erreur lors de l'exécution de l'action de modération", details: String(err) });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/members/:userId/note - Edit moderator note
  if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'note' && method === 'PATCH') {
    if (!access.canModerateContent) {
      json(res, 403, { error: 'Action de modération non autorisée.' });
      return true;
    }

    const userId = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
    const body = await readJsonBody<{ note: string }>(req);

    try {
      // Une note peut viser un membre encore absent de la base : on lui pose
      // son identité Discord pour ne pas créer un profil anonyme.
      const noteGuild = client.guilds.cache.get(guildId);
      const noteMember = noteGuild
        ? noteGuild.members.cache.get(userId) ?? await noteGuild.members.fetch(userId).catch(() => null)
        : null;

      const profile = await prisma.memberProfile.upsert({
        where: { guildId_userId: { guildId, userId } },
        update: { moderatorNote: body?.note ?? null },
        create: {
          guildId,
          userId,
          ...(noteMember ? memberProfileIdentity(noteMember) : {}),
          moderatorNote: body?.note ?? null,
        },
      });

      // La note est déjà enregistrée : un échec de journalisation ne doit pas
      // faire remonter « Erreur lors de l'enregistrement » côté dashboard.
      await safePushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour note modérateur',
        context: getGuildName(client, guildId),
        module: 'Members',
        eventType: 'Manuel',
        details: `Note mise à jour pour l'utilisateur ${userId}.`,
        channelId: null,
      }, 'member note update');

      json(res, 200, { ok: true, note: profile.moderatorNote });
    } catch (err) {
      logger.error('MembersAPI', `Error updating note for ${userId}:`, err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la note' });
    }
    return true;
  }

  // ==========================================
  // 4. Invitations Endpoints
  // ==========================================
  if (parts[4] === 'invitations') {
    // Check view access for GET routes
    if (method === 'GET') {
      if (!access.canManageSettings && !featureAccess?.members?.canView) {
        json(res, 403, { error: 'Accès refusé' });
        return true;
      }
    } else {
      // Check moderation access for state-changing routes
      const canModerate = access.canModerateContent || access.canManageSettings || featureAccess?.members?.canModerate;
      if (!canModerate) {
        json(res, 403, { error: 'Action non autorisée. Modération requise.' });
        return true;
      }
    }

    // GET /api/dashboard/guilds/:guildId/invitations
    if (!parts[5]) {
      if (method === 'GET') {
        try {
          const invitations = await prisma.guildInvite.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          const suspendedInviters = await prisma.suspendedInviter.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          const inviteUsage = await prisma.memberInvite.groupBy({
            by: ['inviteCode'],
            where: { guildId },
            _count: {
              _all: true,
              leftAt: true,
            },
            _max: {
              joinedAt: true,
            },
          });
          const inviterUsage = await prisma.memberInvite.groupBy({
            by: ['inviterId', 'inviterTag'],
            where: { guildId, inviterId: { not: null } },
            _count: {
              _all: true,
              leftAt: true,
            },
            _max: {
              joinedAt: true,
            },
          });
          const inviterIds = inviterUsage
            .map((entry) => entry.inviterId)
            .filter((id): id is string => !!id);
          const inviterProfiles = inviterIds.length > 0
            ? await prisma.memberProfile.findMany({
                where: { guildId, userId: { in: inviterIds } },
                select: { userId: true, avatarUrl: true },
              })
            : [];
          const inviterAvatarMap = new Map(
            inviterProfiles.map((profile) => [profile.userId, profile.avatarUrl])
          );
          const enrichedInviterUsage = inviterUsage.map((entry) => ({
            ...entry,
            avatarUrl: entry.inviterId
              ? inviterAvatarMap.get(entry.inviterId)
                ?? client.users.cache.get(entry.inviterId)?.displayAvatarURL({ size: 128 })
                ?? null
              : null,
          }));
          const totalJoined = await prisma.memberInvite.count({
            where: { guildId },
          });
          const totalLeft = await prisma.memberInvite.count({
            where: { guildId, leftAt: { not: null } },
          });

          json(res, 200, {
            invitations,
            suspendedInviters,
            inviteUsage,
            inviterUsage: enrichedInviterUsage,
            summary: { totalJoined, totalLeft },
          });
        } catch (err) {
          logger.error('InvitationsAPI', `Error listing invitations for guild ${guildId}:`, err);
          json(res, 500, { error: 'Erreur lors de la récupération des invitations' });
        }
        return true;
      }
    }

    // POST /api/dashboard/guilds/:guildId/invitations/suspended-inviters
    if (parts[5] === 'suspended-inviters' && !parts[6]) {
      if (method === 'POST') {
        try {
          const body = await readJsonBody<{
            userId: string;
            userTag?: string;
            reason?: string;
            cascade?: boolean;
          }>(req);

          if (!body?.userId || !isValidSnowflake(body.userId)) {
            json(res, 400, { error: 'ID utilisateur Discord invalide' });
            return true;
          }

          const userId = body.userId;
          const userTag = body.userTag || null;
          const reason = body.reason || null;
          const cascade = !!body.cascade;

          const suspendedInviter = await prisma.suspendedInviter.upsert({
            where: { guildId_userId: { guildId, userId } },
            update: { userTag, reason },
            create: { guildId, userId, userTag, reason },
          });

          let cascadeResult = null;

          if (cascade) {
            await prisma.guildInvite.updateMany({
              where: { guildId, inviterId: userId },
              data: { isSuspended: true },
            });

            const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            let purgedCount = 0;
            if (discordGuild) {
              const activeJoins = await prisma.memberInvite.findMany({
                where: {
                  guildId,
                  inviterId: userId,
                  leftAt: null,
                },
              });

              const now = new Date();
              for (const join of activeJoins) {
                const member = await discordGuild.members.fetch(join.userId).catch(() => null);
                if (member) {
                  await member.kick(`Purge cascade créateur suspendu ${userId} par ${auditUser}`).catch(() => null);
                  purgedCount++;
                }
                await prisma.memberInvite.updateMany({
                  where: { id: join.id },
                  data: { leftAt: now },
                });
              }
              cascadeResult = { purgedCount };
            }
          }

          await pushAudit(guildId, {
            user: auditUser,
            action: "Suspension créateur d'invitations",
            context: getGuildName(client, guildId),
            module: 'Invitations',
            eventType: 'Manuel',
            details: `Créateur suspendu : ${userId} (${userTag || 'sans tag'}). Cascade : ${cascade ? 'Oui' : 'Non'}.`,
            channelId: null,
          });

          json(res, 201, { ok: true, suspendedInviter, cascade: cascadeResult });
        } catch (err) {
          logger.error('InvitationsAPI', 'Error suspending inviter:', err);
          json(res, 500, { error: 'Erreur lors de la suspension du créateur' });
        }
        return true;
      }
    }

    // DELETE /api/dashboard/guilds/:guildId/invitations/suspended-inviters/:userId
    if (parts[5] === 'suspended-inviters' && parts[6] && !parts[7]) {
      if (method === 'DELETE') {
        const userId = parts[6];
        if (!isValidSnowflake(userId)) {
          json(res, 400, { error: 'ID utilisateur Discord invalide' });
          return true;
        }

        try {
          const record = await prisma.suspendedInviter.findUnique({
            where: { guildId_userId: { guildId, userId } },
          });
          if (!record) {
            json(res, 404, { error: 'Créateur suspendu introuvable' });
            return true;
          }

          await prisma.suspendedInviter.delete({
            where: { guildId_userId: { guildId, userId } },
          });

          await prisma.guildInvite.updateMany({
            where: { guildId, inviterId: userId },
            data: { isSuspended: false },
          });

          await pushAudit(guildId, {
            user: auditUser,
            action: "Réhabilitation créateur d'invitations",
            context: getGuildName(client, guildId),
            module: 'Invitations',
            eventType: 'Manuel',
            details: `Créateur réhabilité : ${userId}. Ses invitations ont été restaurées.`,
            channelId: null,
          });

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('InvitationsAPI', `Error removing suspended inviter ${userId}:`, err);
          json(res, 500, { error: 'Erreur lors de la réhabilitation du créateur' });
        }
        return true;
      }
    }

    // POST /api/dashboard/guilds/:guildId/invitations/inviters/:userId/purge
    if (parts[5] === 'inviters' && parts[6] && parts[7] === 'purge') {
      if (method === 'POST') {
        const userId = parts[6];
        if (!isValidSnowflake(userId)) {
          json(res, 400, { error: 'ID utilisateur Discord invalide' });
          return true;
        }

        try {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (!discordGuild) {
            json(res, 404, { error: 'Serveur Discord introuvable' });
            return true;
          }

          const activeJoins = await prisma.memberInvite.findMany({
            where: {
              guildId,
              inviterId: userId,
              leftAt: null,
            },
          });

          let purgedCount = 0;
          const now = new Date();

          for (const join of activeJoins) {
            const member = await discordGuild.members.fetch(join.userId).catch(() => null);
            if (member) {
              await member.kick(`Purge en cascade par créateur ${userId} par ${auditUser}`).catch(() => null);
              purgedCount++;
            }
            await prisma.memberInvite.updateMany({
              where: { id: join.id },
              data: { leftAt: now },
            });
          }

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Purge en cascade par créateur',
            context: getGuildName(client, guildId),
            module: 'Invitations',
            eventType: 'Manuel',
            details: `Membres invités par ${userId} purgés : ${purgedCount} membre(s) exclu(s).`,
            channelId: null,
          });

          json(res, 200, { ok: true, purgedCount });
        } catch (err) {
          logger.error('InvitationsAPI', `Error purging inviter members for ${userId}:`, err);
          json(res, 500, { error: 'Erreur lors de la purge en cascade des membres' });
        }
        return true;
      }
    }

    // Detail and other actions on single invite codes:
    // GET /api/dashboard/guilds/:guildId/invitations/:code
    // PUT /api/dashboard/guilds/:guildId/invitations/:code/source
    // PUT /api/dashboard/guilds/:guildId/invitations/:code/suspend
    // DELETE /api/dashboard/guilds/:guildId/invitations/:code
    // POST /api/dashboard/guilds/:guildId/invitations/:code/purge
    if (parts[5] && parts[5] !== 'suspended-inviters' && parts[5] !== 'inviters') {
      const code = parts[5];
      if (!isValidInviteCode(code)) {
        json(res, 400, { error: "Code d'invitation invalide" });
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/invitations/:code
      if (method === 'GET' && !parts[6]) {
        try {
          const invite = await prisma.guildInvite.findUnique({
            where: { code },
          });
          if (!invite || invite.guildId !== guildId) {
            json(res, 404, { error: 'Invitation introuvable' });
            return true;
          }

          const daysParam = url.searchParams.get('days');
          const days = Number(daysParam) || 30;

          const now = new Date();
          const startDate = new Date();
          startDate.setDate(now.getDate() - days + 1);
          startDate.setHours(0, 0, 0, 0);

          const periodJoins = await prisma.memberInvite.findMany({
            where: {
              guildId,
              inviteCode: code,
              joinedAt: { gte: startDate },
            },
          });

          const totalJoined = periodJoins.length;
          const totalLeft = periodJoins.filter((j) => j.leftAt !== null).length;
          const totalStayed = totalJoined - totalLeft;

          const countsByDate = new Map<string, number>();
          for (const join of periodJoins) {
            const dateKey = join.joinedAt.toISOString().slice(0, 10);
            countsByDate.set(dateKey, (countsByDate.get(dateKey) || 0) + 1);
          }

          const labels: string[] = [];
          const counts: number[] = [];
          for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const dateKey = d.toISOString().slice(0, 10);
            labels.push(dateKey);
            counts.push(countsByDate.get(dateKey) || 0);
          }

          const joins = await prisma.memberInvite.findMany({
            where: { guildId, inviteCode: code },
            orderBy: { joinedAt: 'desc' },
          });

          const userIds = joins.map((j) => j.userId);
          const profiles = await prisma.memberProfile.findMany({
            where: { guildId, userId: { in: userIds } },
          });
          const profileMap = new Map(profiles.map((p) => [p.userId, p]));

          const enrichedJoins = joins.map((j) => {
            const p = profileMap.get(j.userId);
            return {
              userId: j.userId,
              userTag: p?.username || p?.userTag || `Utilisateur ${j.userId}`,
              joinedAt: j.joinedAt,
              leftAt: j.leftAt,
              avatarUrl: p?.avatarUrl || null,
              accountCreatedAt: p?.accountCreatedAt || null,
              messageCount: p?.messageCount ?? 0,
              ghostStatus: p?.ghostStatus || null,
              isBot: p?.isBot ?? false,
            };
          });

          // Blocs analytiques calculés sur tout l'historique du code, pas
          // seulement la période affichée : la rétention à 30 jours n'a pas de
          // sens si on tronque les arrivées à la fenêtre courante.
          const { getInviteInsights } = await import('../../../services/analytics/inviteDetailService.js');
          const timezone = await resolveViewTimezone(url.searchParams.get('tz'), guildId);
          const insights = await getInviteInsights(guildId, code, joins, labels, counts, timezone);

          json(res, 200, {
            invite,
            trend: {
              totalJoined,
              totalLeft,
              totalStayed,
              labels,
              counts,
            },
            joins: enrichedJoins,
            ...insights,
          });
        } catch (err) {
          logger.error('InvitationsAPI', `Error fetching invite details for ${code}:`, err);
          json(res, 500, { error: "Erreur lors de la récupération des détails de l'invitation" });
        }
        return true;
      }

      // PUT /api/dashboard/guilds/:guildId/invitations/:code/source
      if (method === 'PUT' && parts[6] === 'source' && !parts[7]) {
        try {
          const body = await readJsonBody<{ sourceLabel?: string | null }>(req);
          if (!body || (body.sourceLabel !== null && typeof body.sourceLabel !== 'string')) {
            json(res, 400, { error: 'Nom de provenance invalide' });
            return true;
          }

          const sourceLabel = body.sourceLabel?.trim() || null;
          if (sourceLabel && sourceLabel.length > 60) {
            json(res, 400, { error: 'Le nom de provenance est limité à 60 caractères' });
            return true;
          }

          const invite = await prisma.guildInvite.findUnique({ where: { code } });
          if (!invite || invite.guildId !== guildId) {
            json(res, 404, { error: 'Invitation introuvable' });
            return true;
          }

          const updatedInvite = await prisma.guildInvite.update({
            where: { code },
            data: { sourceLabel },
          });

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Provenance invitation',
            context: getGuildName(client, guildId),
            module: 'Invitations',
            eventType: 'Settings',
            details: sourceLabel
              ? `L'invitation ${code} est maintenant attribuée à la provenance « ${sourceLabel} ».`
              : `La provenance de l'invitation ${code} a été retirée.`,
            channelId: null,
          });

          json(res, 200, { ok: true, invite: updatedInvite });
        } catch (err) {
          logger.error('InvitationsAPI', `Error updating invite source for ${code}:`, err);
          json(res, 500, { error: "Erreur lors de la modification de la provenance" });
        }
        return true;
      }

      // PUT /api/dashboard/guilds/:guildId/invitations/:code/suspend
      if (parts[6] === 'suspend') {
        if (method === 'PUT') {
          try {
            const body = await readJsonBody<{ suspended: boolean }>(req);
            const suspended = !!body?.suspended;

            const invite = await prisma.guildInvite.findUnique({
              where: { code },
            });
            if (!invite || invite.guildId !== guildId) {
              json(res, 404, { error: 'Invitation introuvable' });
              return true;
            }

            const updatedInvite = await prisma.guildInvite.update({
              where: { code },
              data: { isSuspended: suspended },
            });

            await pushAudit(guildId, {
              user: auditUser,
              action: suspended ? 'Suspension invitation' : 'Restauration invitation',
              context: getGuildName(client, guildId),
              module: 'Invitations',
              eventType: 'Manuel',
              details: `L'invitation ${code} a été ${suspended ? 'suspendue' : 'restaurée'}.`,
              channelId: null,
            });

            json(res, 200, { ok: true, invite: updatedInvite });
          } catch (err) {
            logger.error('InvitationsAPI', `Error toggling invite suspension for ${code}:`, err);
            json(res, 500, { error: "Erreur lors de la modification de l'invitation" });
          }
          return true;
        }
      }

      // DELETE /api/dashboard/guilds/:guildId/invitations/:code
      if (method === 'DELETE' && !parts[6]) {
        try {
          const invite = await prisma.guildInvite.findUnique({
            where: { code },
          });
          if (!invite || invite.guildId !== guildId) {
            json(res, 404, { error: 'Invitation introuvable' });
            return true;
          }

          const updatedInvite = await prisma.guildInvite.update({
            where: { code },
            data: { isDeleted: true },
          });

          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (discordGuild) {
            const discordInvites = await discordGuild.invites.fetch().catch(() => null);
            const discordInvite = discordInvites?.get(code);
            if (discordInvite) {
              await discordInvite.delete('Supprimée via le dashboard Kotbo').catch(() => null);
            }
          }

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Suppression invitation',
            context: getGuildName(client, guildId),
            module: 'Invitations',
            eventType: 'Manuel',
            details: `L'invitation ${code} a été marquée comme supprimée.`,
            channelId: null,
          });

          json(res, 200, { ok: true, invite: updatedInvite });
        } catch (err) {
          logger.error('InvitationsAPI', `Error deleting invite ${code}:`, err);
          json(res, 500, { error: "Erreur lors de la suppression de l'invitation" });
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/invitations/:code/purge
      if (parts[6] === 'purge') {
        if (method === 'POST') {
          try {
            const invite = await prisma.guildInvite.findUnique({
              where: { code },
            });
            if (!invite || invite.guildId !== guildId) {
              json(res, 404, { error: 'Invitation introuvable' });
              return true;
            }

            const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!discordGuild) {
              json(res, 404, { error: 'Serveur Discord introuvable' });
              return true;
            }

            const activeJoins = await prisma.memberInvite.findMany({
              where: {
                guildId,
                inviteCode: code,
                leftAt: null,
              },
            });

            let purgedCount = 0;
            const now = new Date();

            for (const join of activeJoins) {
              const member = await discordGuild.members.fetch(join.userId).catch(() => null);
              if (member) {
                const reason = `Purge de l'invitation ${code} par ${auditUser}`;
                await member.kick(reason).catch((e) => {
                  logger.warn('InvitationsAPI', `Failed to kick member ${join.userId}:`, e);
                });
                purgedCount++;
              }
              await prisma.memberInvite.updateMany({
                where: { id: join.id },
                data: { leftAt: now },
              });
            }

            await pushAudit(guildId, {
              user: auditUser,
              action: 'Purge invitation',
              context: getGuildName(client, guildId),
              module: 'Invitations',
              eventType: 'Manuel',
              details: `Purge de l'invitation ${code} : ${purgedCount} membre(s) exclu(s).`,
              channelId: null,
            });

            json(res, 200, { ok: true, purgedCount });
          } catch (err) {
            logger.error('InvitationsAPI', `Error purging invite ${code}:`, err);
            json(res, 500, { error: "Erreur lors de la purge de l'invitation" });
          }
          return true;
        }
      }
    }
  }

  return false;
}

function isValidSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

function isValidInviteCode(code: string): boolean {
  return /^[a-zA-Z0-9_-]{2,20}$/.test(code);
}
