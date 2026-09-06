import { IncomingMessage, ServerResponse } from 'node:http';
import { Client, TextChannel } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BannedWord } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { activateGuild, deactivateGuild, reconcileStaffGuildActivation } from '../../utils/activation.js';
import { announceAccessRevoked, announceTrialStart, extendAccess, formatDuration, normalizeAccessGrant, MAX_ACCESS_DURATION_MINUTES } from '../../services/system/accessService.js';
import { E, UNICODE_FALLBACKS } from '../../utils/emojis.js';
import { isReservedByNicknameModeration } from '../../services/moderation/nicknameModerationService.js';
import { INVITE_SOURCE, recordBotInvite, tagInviteSource } from '../../services/analytics/inviteService.js';
import {
  GIFT_DURATIONS_MONTHS,
  PLAN_KEYS,
  PLAN_REGISTRY,
  TRIAL_DAYS,
  isGiftDuration,
  normalizePlanKey,
  type PlanKey,
} from '@kotbo/contracts';
import { invalidatePlan } from '../../services/system/planService.js';
import { isBillingEnabled } from '../../services/billing/stripeService.js';
import { grantAdminGift } from '../../services/billing/giftService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const servicePath = path.resolve(__dirname, '../../services/analytics/messageScraperService.js');
const guildDataSyncServicePath = path.resolve(__dirname, '../../services/analytics/guildDataSyncService.js');
import { json, verifyAuth, resolveAdminAccess, collectShardSnapshots, collectShardGuilds, loadShardingConfig, saveShardingConfig, requestContainerRestart, requestShardRespawn, normalizeGlobalBannedWord, normalizeGlobalBannedWordCategory, cleanupGlobalBannedWords, getGuildName, readJsonBody, DISCORD_CLIENT_OWNER_ID, ShardSnapshot, ShardingMode, ShardingConfig } from '../shared.js';
import {
  getModuleActivationStats,
  getModuleUsageStats,
  getModulePerformanceStats,
  getModuleStatsSummary,
  KOTBO_MODULES,
  type KotboModule,
} from '../../services/analytics/moduleStatsService.js';
import {
  BroadcastMediaError,
  deleteBroadcastMedia,
  listBroadcastMedia,
  markBroadcastMediaUsed,
  storeBroadcastMedia,
} from '../../services/system/broadcastMediaService.js';
import {
  BroadcastValidationError,
  deliverBroadcast,
  finalizeBroadcast,
  loadGuildChannelMap,
  normalizeBroadcastContent,
  resolveTargetGuildIds,
  type BroadcastChannelPref,
  type BroadcastTarget,
} from '../../services/system/broadcastService.js';
import {
  listAdminAudit,
  listAdminAuditActions,
  recordAdminAudit,
  resolveRequestIp,
  type AdminAuditOutcome,
} from '../../services/system/adminAuditService.js';
import { ensureAdminHealthSampling, getAdminHealthSeries } from '../../services/system/adminHealthService.js';
import { collectUserData } from '../../services/system/gdprExportService.js';
import { buildGdprZip } from '../../services/system/gdprZip.js';
import { handleAdminAnalyticsRoutes } from './admin/analytics.js';

/**
 * `readJsonBody` refuse (415) toute requête sans Content-Type JSON. Les endpoints
 * dont le corps est facultatif s'en servent pour ne le lire que s'il existe, et
 * rester compatibles avec les appels historiques sans corps.
 */
/** Corps accepte par `POST /api/admin/broadcast` et par les modeles d'annonce. */
interface BroadcastRequestBody {
  title?: string;
  message: string;
  color?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  footerText?: string;
  target?: BroadcastTarget;
  targetGuilds?: string[];
  channelPref?: BroadcastChannelPref;
  dryRun?: boolean;
  /** ISO 8601. Present = annonce programmee au lieu d'un envoi immediat. */
  scheduledAt?: string;
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.includes('application/json') ?? false;
}

export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client
): Promise<boolean> {
  const method = req.method;

  if (parts[0] !== 'api' || parts[1] !== 'admin') {
    return false;
  }

  const user = await verifyAuth(req);
  if (!user) {
    json(res, 401, { error: 'Non authentifié' });
    return true;
  }

  // Verification 1: Is bot admin (needed for all /api/admin endpoints)
  const isBotAdmin = await resolveAdminAccess(client, user.userId);
  if (!isBotAdmin) {
    json(res, 403, { error: 'Accès administrateur requis' });
    return true;
  }

  // Routes d'analyse commerciale et tunnel d'acquisition
  if (parts[2] === 'analytics') {
    return handleAdminAnalyticsRoutes(req, res, parts, url, client, user);
  }

  // GET /api/admin/health/series - Historique de sante pour les courbes
  if (parts[2] === 'health' && parts[3] === 'series' && method === 'GET') {
    try {
      ensureAdminHealthSampling(client);
      const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 60, 5), 24 * 60);
      const points = Math.min(Math.max(Number(url.searchParams.get('points')) || 180, 20), 720);
      json(res, 200, getAdminHealthSeries(minutes, points));
    } catch (err) {
      logger.error('AdminAPI', 'GET admin health series error:', err);
      json(res, 500, { error: "Erreur lors du chargement de l'historique de santé" });
    }
    return true;
  }

  // GET /api/admin/audit - Journal des actions admin
  if (parts[2] === 'audit' && parts.length === 3 && method === 'GET') {
    try {
      const sinceHours = Number(url.searchParams.get('sinceHours'));
      const outcomeParam = url.searchParams.get('outcome');
      const outcome = outcomeParam === 'OK' || outcomeParam === 'FAILED'
        ? (outcomeParam as AdminAuditOutcome)
        : undefined;

      json(res, 200, await listAdminAudit({
        action: url.searchParams.get('action') || undefined,
        actorId: url.searchParams.get('actorId') || undefined,
        targetId: url.searchParams.get('targetId') || undefined,
        outcome,
        search: url.searchParams.get('search') || undefined,
        since: Number.isFinite(sinceHours) && sinceHours > 0
          ? new Date(Date.now() - sinceHours * 3_600_000)
          : undefined,
        limit: Number(url.searchParams.get('limit')) || 50,
        cursor: url.searchParams.get('cursor') || undefined,
      }));
    } catch (err) {
      logger.error('AdminAPI', 'GET admin audit error:', err);
      json(res, 500, { error: 'Erreur lors du chargement du journal' });
    }
    return true;
  }

  // GET /api/admin/audit/actions - Valeurs disponibles pour le filtre
  if (parts[2] === 'audit' && parts[3] === 'actions' && method === 'GET') {
    try {
      json(res, 200, { actions: await listAdminAuditActions() });
    } catch (err) {
      logger.error('AdminAPI', 'GET admin audit actions error:', err);
      json(res, 500, { error: 'Erreur lors du chargement des actions' });
    }
    return true;
  }

  // GET /api/admin/stats
  if (parts[2] === 'stats' && method === 'GET') {
    try {
      ensureAdminHealthSampling(client);
      const shardSnapshots = await collectShardSnapshots(client);
      const guilds = await collectShardGuilds(client);
      const guildCount = guilds.length;
      const userCount = guilds.reduce((acc: number, guild: { memberCount: number }) => acc + guild.memberCount, 0);
      const activeSanctions = await prisma.sanction.count({ where: { status: 'ACTIVE' } });
      const dailyAlgoSubmissions = await prisma.dailyAlgoSubmission.count();

      json(res, 200, {
        guildCount,
        userCount,
        activeSanctions,
        dailyAlgoSubmissions,
        uptime: Math.floor(process.uptime()),
        memoryUsage: process.memoryUsage(),
        shardCount: shardSnapshots.length,
        onlineShardCount: shardSnapshots.filter((snapshot) => snapshot.status !== 'offline').length,
        averageShardPing: shardSnapshots.length > 0
          ? Math.round(shardSnapshots.reduce((acc: number, snapshot: ShardSnapshot) => acc + snapshot.ping, 0) / shardSnapshots.length)
          : 0,
      });
    } catch (err) {
      logger.error('AdminAPI', 'Error fetching admin stats:', err);
      json(res, 500, { error: 'Erreur interne du serveur' });
    }
    return true;
  }

  // GET /api/admin/stats/modules - Module statistics
  if (parts[2] === 'stats' && parts[3] === 'modules' && method === 'GET') {
    try {
      const guildId = url.searchParams.get('guildId') || undefined;
      const moduleNameRaw = url.searchParams.get('moduleName') || undefined;
      const moduleName = (moduleNameRaw && (KOTBO_MODULES as readonly string[]).includes(moduleNameRaw)) ? (moduleNameRaw as KotboModule) : undefined;
      const startDate = url.searchParams.get('startDate') || undefined;
      const endDate = url.searchParams.get('endDate') || undefined;
      const periodDays = url.searchParams.get('period') ? parseInt(url.searchParams.get('period')!) : 30;
      const summary = url.searchParams.get('summary') === 'true';

      if (summary) {
        const data = await getModuleStatsSummary({ guildId, periodDays });
        json(res, 200, data);
      } else {
        const [activation, usage, performance] = await Promise.all([
          getModuleActivationStats(guildId),
          getModuleUsageStats({ guildId, moduleName, startDate, endDate, periodDays }),
          getModulePerformanceStats({ guildId, moduleName, startDate, endDate, periodDays }),
        ]);

        json(res, 200, {
          modules: KOTBO_MODULES,
          activation,
          usage,
          performance,
        });
      }
    } catch (err) {
      logger.error('AdminAPI', 'Error fetching module stats:', err);
      json(res, 500, { error: 'Erreur interne du serveur' });
    }
    return true;
  }

  // GET /api/admin/guilds
  if (parts[2] === 'guilds' && parts.length === 3 && method === 'GET') {
    try {
      const dbGuilds = await prisma.guild.findMany({
        select: {
          id: true,
          activated: true,
          activationCode: true,
          statsConfig: true,
          serverTemplateAppliedAt: true,
          serverTemplateAppliedBy: true,
        }
      });
      const dbGuildsMap = new Map(dbGuilds.map((guild) => [guild.id, guild] as const));

      const shardGuilds = await collectShardGuilds(client);
      interface ShardGuild {
        id: string;
        name: string;
        icon: string | null;
        memberCount: number;
        joinedAt: string | null;
        shardId: number;
      }
      const guilds = shardGuilds.map((g: ShardGuild) => {
        const dbGuild = dbGuildsMap.get(g.id);
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          memberCount: g.memberCount,
          joinedAt: g.joinedAt,
          activated: dbGuild?.activated ?? false,
          activationCode: dbGuild?.activationCode ?? null,
          statsConfig: dbGuild?.statsConfig ?? null,
          serverTemplateAppliedAt: dbGuild?.serverTemplateAppliedAt?.toISOString() ?? null,
          serverTemplateAppliedBy: dbGuild?.serverTemplateAppliedBy ?? null,
          shardId: g.shardId ?? 0,
        };
      });

      json(res, 200, { guilds });
    } catch (err) {
      logger.error('AdminAPI', 'Error listing admin guilds:', err);
      json(res, 500, { error: 'Erreur interne du serveur' });
    }
    return true;
  }

  // Shards management
  if (parts[2] === 'shards') {
    // GET /api/admin/shards
    if (method === 'GET' && parts.length === 3) {
      try {
        const config = await loadShardingConfig();
        const shardSnapshots = await collectShardSnapshots(client);
        json(res, 200, {
          config,
          shards: shardSnapshots,
          onlineShardCount: shardSnapshots.filter((snapshot) => snapshot.status !== 'offline').length,
        });
      } catch (err) {
        logger.error('AdminAPI', 'Error loading shards config:', err);
        json(res, 500, { error: 'Erreur interne' });
      }
      return true;
    }

    // POST /api/admin/shards/restart-all
    if (method === 'POST' && parts.length === 4 && parts[3] === 'restart-all') {
      await recordAdminAudit({
        actorId: user.userId,
        action: 'shard.restart_all',
        targetType: 'container',
        summary: 'Redémarrage complet du conteneur demandé',
        ip: resolveRequestIp(req),
      });
      requestContainerRestart();
      json(res, 200, { ok: true, restart: 'container' });
      return true;
    }

    // POST /api/admin/shards/:shardId/restart
    if (method === 'POST' && parts.length === 5 && parts[4] === 'restart') {
      const shardId = Number(parts[3]);
      if (!Number.isInteger(shardId) || shardId < 0) {
        json(res, 400, { error: 'Identifiant de shard invalide.' });
        return true;
      }

      try {
        requestShardRespawn(shardId);
        await recordAdminAudit({
          actorId: user.userId,
          action: 'shard.restart',
          targetType: 'shard',
          targetId: String(shardId),
          summary: `Redémarrage du shard #${shardId}`,
          ip: resolveRequestIp(req),
        });
        json(res, 200, { ok: true, restart: 'shard', targetShard: shardId });
      } catch (err) {
        // Le respawn ciblé a échoué : on retombe sur un redémarrage complet,
        // ce que l'audit doit refléter tel quel.
        await recordAdminAudit({
          actorId: user.userId,
          action: 'shard.restart',
          targetType: 'shard',
          targetId: String(shardId),
          summary: `Redémarrage du shard #${shardId} impossible : redémarrage du conteneur à la place`,
          outcome: 'FAILED',
          ip: resolveRequestIp(req),
        });
        requestContainerRestart();
        json(res, 200, { ok: true, restart: 'container', targetShard: shardId });
      }
      return true;
    }

    // POST /api/admin/shards/reconfigure
    if (method === 'POST' && parts.length === 4 && parts[3] === 'reconfigure') {
      try {
        const body = await readJsonBody<{ mode?: ShardingMode; shardCount?: number }>(req);
        const nextMode: ShardingMode = body?.mode === 'fixed' ? 'fixed' : 'auto';
        const nextShardCount = Number(body?.shardCount);

        if (nextMode === 'fixed' && (!Number.isInteger(nextShardCount) || nextShardCount < 1)) {
          json(res, 400, { error: 'Un nombre de shards supérieur à zéro est requis en mode fixe.' });
          return true;
        }

        const nextConfig: ShardingConfig = {
          mode: nextMode,
          shardCount: nextMode === 'fixed' ? nextShardCount : null,
        };

        await saveShardingConfig(nextConfig);
        json(res, 200, { ok: true, config: nextConfig, restartRequired: true });
        requestContainerRestart();
      } catch (err) {
        logger.error('AdminAPI', 'Error reconfiguring shards:', err);
        json(res, 500, { error: 'Erreur lors de la reconfiguration' });
      }
      return true;
    }
  }

  // Guild specific invite/leave
  if (parts[2] === 'guilds' && parts.length === 5 && (parts[4] === 'invite' || parts[4] === 'leave')) {
    const guildId = parts[3];

    let guildExists = false;
    // Check if guild exists across shards
    if (client.shard) {
      const results = await client.shard.broadcastEval<boolean, string>((c, id) => c.guilds.cache.has(id), { context: guildId });
      guildExists = results.some((r) => r);
    } else {
      guildExists = client.guilds.cache.has(guildId) || !!(await client.guilds.fetch(guildId).catch(() => null));
    }

    if (!guildExists) {
      json(res, 404, { error: 'Serveur introuvable' });
      return true;
    }

    // POST /api/admin/guilds/:guildId/invite
    if (parts[4] === 'invite' && method === 'POST') {
      if (client.shard) {
        const results = await client.shard.broadcastEval<{ error?: string; url?: string; code?: string } | null, { guildId: string }>(async (shardClient, context) => {
          const guild = shardClient.guilds.cache.get(context.guildId);
          if (!guild) return null;
          const channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(shardClient.user!)?.has('CreateInstantInvite'));
          if (!channel) return { error: 'NO_CHANNEL' };
          try {
            if (channel && 'createInvite' in channel && typeof channel.createInvite === 'function') {
              const invite = await channel.createInvite({ maxAge: 86400, maxUses: 1 });
              return { url: invite.url, code: invite.code };
            }
            return { error: 'CREATE_FAILED' };
          } catch {
            return { error: 'CREATE_FAILED' };
          }
        }, { context: { guildId } });

        const result = results.find(r => r !== null);
        if (!result) {
          json(res, 404, { error: 'Serveur introuvable' });
        } else if (result.error === 'NO_CHANNEL') {
          json(res, 400, { error: 'Impossible de créer une invitation (pas de salon textuel ou pas la permission)' });
        } else if (result.error === 'CREATE_FAILED') {
          json(res, 500, { error: "Erreur lors de la création de l'invitation" });
        } else if (result.url) {
          // L'invitation est créée sur un autre shard : on la trace depuis ici, la base est partagée.
          if (result.code) {
            await tagInviteSource({
              guildId,
              code: result.code,
              sourceLabel: INVITE_SOURCE.supportAdmin(),
              inviterId: client.user?.id ?? null,
              inviterTag: client.user?.tag ?? null,
              maxUses: 1,
              expiresAt: new Date(Date.now() + 86400 * 1000),
            });
          }
          json(res, 200, { url: result.url });
        }
      } else {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        const channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me!)?.has('CreateInstantInvite'));
        if (!channel) {
          json(res, 400, { error: 'Impossible de créer une invitation (pas de salon textuel ou pas la permission)' });
          return true;
        }
        try {
          const invite = await (channel as TextChannel).createInvite({ maxAge: 86400, maxUses: 1 });
          await recordBotInvite(invite, INVITE_SOURCE.supportAdmin());
          json(res, 200, { url: invite.url });
        } catch (err) {
          json(res, 500, { error: "Erreur lors de la création de l'invitation" });
        }
      }
      return true;
    }

    // POST /api/admin/guilds/:guildId/leave
    if (parts[4] === 'leave' && method === 'POST') {
      if (client.shard) {
        const results = await client.shard.broadcastEval<{ success: boolean } | null, { guildId: string }>(async (shardClient, context) => {
          const guild = shardClient.guilds.cache.get(context.guildId);
          if (!guild) return null;
          try {
            await guild.leave();
            return { success: true };
          } catch {
            return { success: false };
          }
        }, { context: { guildId } });

        const result = results.find(r => r !== null);
        if (!result) {
          json(res, 404, { error: 'Serveur introuvable' });
        } else if (result.success) {
          await recordAdminAudit({
            actorId: user.userId,
            action: 'guild.leave',
            targetType: 'guild',
            targetId: guildId,
            summary: `Bot retiré du serveur ${await getGuildName(client, guildId)}`,
            ip: resolveRequestIp(req),
          });
          json(res, 200, { success: true });
        } else {
          await recordAdminAudit({
            actorId: user.userId,
            action: 'guild.leave',
            targetType: 'guild',
            targetId: guildId,
            summary: 'Départ du serveur impossible',
            outcome: 'FAILED',
            ip: resolveRequestIp(req),
          });
          json(res, 500, { error: 'Impossible de quitter le serveur' });
        }
      } else {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        try {
          const guildName = guild.name;
          await guild.leave();
          await recordAdminAudit({
            actorId: user.userId,
            action: 'guild.leave',
            targetType: 'guild',
            targetId: guildId,
            summary: `Bot retiré du serveur ${guildName}`,
            ip: resolveRequestIp(req),
          });
          json(res, 200, { success: true });
        } catch (err) {
          json(res, 500, { error: 'Impossible de quitter le serveur' });
        }
      }
      return true;
    }
  }

  // Global Admins CRUD
  if (parts[2] === 'admins') {
    // GET /api/admin/admins
    if (method === 'GET' && parts.length === 3) {
      try {
        const admins = await prisma.globalAdmin.findMany({
          orderBy: { createdAt: 'desc' }
        });
        const enrichedAdmins = await Promise.all(admins.map(async (admin) => {
          try {
            const discordUser = await client.users.fetch(admin.userId);
            return { ...admin, username: discordUser.username, avatarUrl: discordUser.displayAvatarURL() };
          } catch {
            return { ...admin, username: 'Inconnu', avatarUrl: null };
          }
        }));
        json(res, 200, { admins: enrichedAdmins });
      } catch (err) {
        json(res, 500, { error: 'Erreur de base de données' });
      }
      return true;
    }

    // POST /api/admin/admins
    if (method === 'POST' && parts.length === 3) {
      try {
         const body = await readJsonBody<{userId: string}>(req);
         if (!body || !body.userId) {
           json(res, 400, { error: 'ID Discord requis' }); 
           return true;
         }
         try {
            const discordUser = await client.users.fetch(body.userId);
            if (!discordUser) throw new Error();
            await prisma.globalAdmin.upsert({
              where: { userId: body.userId },
              update: {},
              create: { userId: body.userId, addedBy: user.userId }
            });
            await recordAdminAudit({
              actorId: user.userId,
              action: 'admin.grant',
              targetType: 'user',
              targetId: body.userId,
              summary: `Droits d'administrateur global accordés à ${discordUser.username}`,
              ip: resolveRequestIp(req),
            });
            json(res, 201, { success: true });
         } catch {
            json(res, 400, { error: 'Utilisateur Discord introuvable' });
         }
      } catch (err) {
        json(res, 500, { error: 'Erreur lors du traitement' });
      }
      return true;
    }

    // DELETE /api/admin/admins/:userId
    if (method === 'DELETE' && parts.length === 4) {
       const targetId = parts[3];
       if (DISCORD_CLIENT_OWNER_ID && targetId === DISCORD_CLIENT_OWNER_ID) {
         json(res, 403, { error: 'Impossible de supprimer le créateur' }); 
         return true;
       }
       try {
         await prisma.globalAdmin.delete({ where: { userId: targetId } }).catch(() => {});
         await recordAdminAudit({
           actorId: user.userId,
           action: 'admin.revoke',
           targetType: 'user',
           targetId,
           summary: "Droits d'administrateur global retirés",
           ip: resolveRequestIp(req),
         });
         json(res, 200, { success: true });
       } catch (err) {
         json(res, 500, { error: 'Erreur de base de données' });
       }
       return true;
    }
  }

  // Global Blacklist CRUD
  if (parts[2] === 'blacklist') {
    // GET /api/admin/blacklist
    if (method === 'GET') {
      try {
        const blacklist = await prisma.globalBlacklist.findMany({
          orderBy: { createdAt: 'desc' }
        });
        const enriched = await Promise.all(blacklist.map(async (entry) => {
          try {
            const discordUser = await client.users.fetch(entry.userId);
            return { ...entry, username: discordUser.username, avatarUrl: discordUser.displayAvatarURL() };
          } catch {
            return { ...entry, username: 'Inconnu', avatarUrl: null };
          }
        }));
        json(res, 200, { blacklist: enriched });
      } catch (err) {
        json(res, 500, { error: 'Erreur de base de données' });
      }
      return true;
    }

    // POST /api/admin/blacklist
    if (method === 'POST') {
      try {
         const body = await readJsonBody<{userId: string, reason?: string}>(req);
         if (!body || !body.userId) {
           json(res, 400, { error: 'ID Discord requis' });
           return true;
         }
         try {
            const discordUser = await client.users.fetch(body.userId);
            if (!discordUser) throw new Error();
            await prisma.globalBlacklist.upsert({
              where: { userId: body.userId },
              update: { reason: body.reason },
              create: { userId: body.userId, reason: body.reason, addedBy: user.userId }
            });

            const blacklistSet: Set<string> = globalThis.KOTBO_BLACKLIST || new Set();
            blacklistSet.add(body.userId);
            globalThis.KOTBO_BLACKLIST = blacklistSet;

            await recordAdminAudit({
              actorId: user.userId,
              action: 'blacklist.add',
              targetType: 'user',
              targetId: body.userId,
              summary: `${discordUser.username} ajouté à la blacklist globale`,
              metadata: body.reason ? { reason: body.reason } : undefined,
              ip: resolveRequestIp(req),
            });
            json(res, 201, { success: true });
         } catch (err) {
            logger.error('AdminAPI', 'Error adding to blacklist:', err);
            json(res, 400, { error: 'Utilisateur Discord introuvable' });
         }
      } catch (err) {
        json(res, 500, { error: 'Erreur lors du traitement' });
      }
      return true;
    }

    // DELETE /api/admin/blacklist/:userId
    if (method === 'DELETE' && parts.length === 4) {
       const targetId = parts[3];
       try {
         await prisma.globalBlacklist.delete({ where: { userId: targetId } }).catch(() => {});
         
         const blacklistSet: Set<string> = globalThis.KOTBO_BLACKLIST;
         if (blacklistSet) {
           blacklistSet.delete(targetId);
         }

         await recordAdminAudit({
           actorId: user.userId,
           action: 'blacklist.remove',
           targetType: 'user',
           targetId,
           summary: 'Utilisateur retiré de la blacklist globale',
           ip: resolveRequestIp(req),
         });
         json(res, 200, { success: true });
       } catch (err) {
         json(res, 500, { error: 'Erreur de base de données' });
       }
       return true;
    }
  }

  // Global Banned Words (blacklist of nicknames/words across servers)
  if (parts[2] === 'banned-words') {
    // GET /api/admin/banned-words
    if (method === 'GET' && parts.length === 3) {
      try {
        const words = await prisma.bannedWord.findMany({
          where: { guildId: null },
          orderBy: [{ word: 'asc' }],
        });
        json(res, 200, { words });
      } catch (err) {
        json(res, 500, { error: 'Erreur interne' });
      }
      return true;
    }

    // POST /api/admin/banned-words
    if (method === 'POST' && parts.length === 3) {
      try {
        const body = await readJsonBody<{ words?: Array<{ word: string; category?: string; enabled?: boolean }> }>(req);
        const entries = Array.isArray(body?.words) ? body.words : [];

        if (entries.length === 0) {
          json(res, 400, { error: 'Aucun mot à enregistrer' });
          return true;
        }

        const seen = new Map<string, { word: string; category: string; enabled: boolean }>();
        for (const entry of entries) {
          const word = normalizeGlobalBannedWord(entry?.word);
          if (!word) continue;

          if (isReservedByNicknameModeration(word)) {
            continue;
          }

          seen.set(word, {
            word,
            category: normalizeGlobalBannedWordCategory(entry?.category),
            enabled: typeof entry?.enabled === 'boolean' ? entry.enabled : true,
          });
        }

        if (seen.size === 0) {
          json(res, 400, { error: 'Aucun mot valide à enregistrer' });
          return true;
        }

        const created: BannedWord[] = [];
        const updated: BannedWord[] = [];

        for (const entry of seen.values()) {
          const existing = await prisma.bannedWord.findFirst({ where: { guildId: null, word: entry.word } });
          if (existing) {
            const next = await prisma.bannedWord.update({
              where: { id: existing.id },
              data: { category: entry.category, enabled: entry.enabled },
            });
            updated.push(next);
          } else {
            const next = await prisma.bannedWord.create({
              data: {
                guildId: null,
                word: entry.word,
                category: entry.category,
                enabled: entry.enabled,
              },
            });
            created.push(next);
          }
        }

        const words = await prisma.bannedWord.findMany({
          where: { guildId: null },
          orderBy: [{ word: 'asc' }],
        });

        json(res, 200, {
          ok: true,
          createdCount: created.length,
          updatedCount: updated.length,
          words,
        });
      } catch (err) {
        logger.error('AdminAPI', 'Error registering banned words:', err);
        json(res, 500, { error: 'Erreur serveur' });
      }
      return true;
    }

    // POST /api/admin/banned-words/cleanup
    if (method === 'POST' && parts.length === 4 && parts[3] === 'cleanup') {
      try {
        const result = await cleanupGlobalBannedWords();
        json(res, 200, { ok: true, ...result });
      } catch (err) {
        logger.error('BannedWordsAPI', 'POST banned-words cleanup error:', err);
        json(res, 500, { error: 'Erreur lors du nettoyage des mots globaux' });
      }
      return true;
    }

    // Operations on a specific banned word
    if (parts.length === 4) {
      const wordId = parts[3];

      // PATCH /api/admin/banned-words/:wordId
      if (method === 'PATCH') {
        try {
          const body = await readJsonBody<{ enabled?: boolean; word?: string; category?: string }>(req);
          const hasEnabled = typeof body?.enabled === 'boolean';
          const hasWord = typeof body?.word === 'string';
          const hasCategory = typeof body?.category === 'string';

          if (!hasEnabled && !hasWord && !hasCategory) {
            json(res, 400, { error: 'Au moins un champ doit être fourni' });
            return true;
          }

          const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId: null } });
          if (!existing) {
            json(res, 404, { error: 'Mot global introuvable' });
            return true;
          }

          const nextWord = hasWord ? normalizeGlobalBannedWord(body.word) : existing.word;
          const nextCategory = hasCategory ? normalizeGlobalBannedWordCategory(body.category) : existing.category;
          const nextEnabled = hasEnabled ? body.enabled : existing.enabled;

          if (!nextWord) {
            json(res, 400, { error: 'Le mot ne peut pas être vide' });
            return true;
          }

          if (isReservedByNicknameModeration(nextWord)) {
            json(res, 400, { error: 'Ce mot ne peut pas être banni (réservé par le système de modération)' });
            return true;
          }

          const duplicate = await prisma.bannedWord.findFirst({
            where: {
              guildId: null,
              word: nextWord,
              NOT: { id: wordId },
            },
          });

          if (duplicate) {
            json(res, 409, { error: 'Ce mot global existe déjà' });
            return true;
          }

          const updated = await prisma.bannedWord.update({
            where: { id: wordId },
            data: { word: nextWord, category: nextCategory, enabled: nextEnabled },
          });

          json(res, 200, { ok: true, word: updated });
        } catch (err) {
          logger.error('BannedWordsAPI', 'PATCH global banned-word error:', err);
          json(res, 500, { error: 'Erreur lors de la mise à jour' });
        }
        return true;
      }

      // DELETE /api/admin/banned-words/:wordId
      if (method === 'DELETE') {
        try {
          const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId: null } });
          if (!existing) {
            json(res, 404, { error: 'Mot global introuvable' });
            return true;
          }

          await prisma.bannedWord.delete({ where: { id: wordId } });
          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('BannedWordsAPI', 'DELETE global banned-word error:', err);
          json(res, 500, { error: 'Erreur lors de la suppression' });
        }
        return true;
      }
    }
  }

  // Global Config (Maintenance toggle)
  if (parts[2] === 'config') {
    // GET /api/admin/config
    if (method === 'GET') {
       try {
         const config = await prisma.botGlobalConfig.findUnique({ where: { key: 'MAINTENANCE_MODE' } });
         json(res, 200, { maintenance: config?.value === 'true' });
       } catch (err) {
         json(res, 500, { error: 'Erreur interne' });
       }
       return true;
    }

    // POST /api/admin/config
    if (method === 'POST') {
       try {
         const body = await readJsonBody<{maintenance: boolean}>(req);
         if (!body || typeof body.maintenance !== 'boolean') {
           json(res, 400, { error: 'Valeur maintenance (boolean) requise' }); 
           return true;
         }
         await prisma.botGlobalConfig.upsert({
           where: { key: 'MAINTENANCE_MODE' },
           update: { value: body.maintenance ? 'true' : 'false' },
           create: { key: 'MAINTENANCE_MODE', value: body.maintenance ? 'true' : 'false' }
         });
         globalThis.KOTBO_MAINTENANCE_MODE = body.maintenance;
         json(res, 200, { success: true });
       } catch (err) {
         json(res, 500, { error: 'Erreur de base de données' });
       }
       return true;
    }
  }

  // Bot error logs listing/clear
  if (parts[2] === 'errors') {
    // GET /api/admin/errors
    if (method === 'GET') {
       try {
         const errors = await prisma.botErrorLog.findMany({
           orderBy: { createdAt: 'desc' },
           take: 50
         });
         json(res, 200, { errors });
       } catch (err) {
         json(res, 500, { error: 'Erreur de base de données' });
       }
       return true;
    }

    // DELETE /api/admin/errors
    if (method === 'DELETE') {
       try {
         await prisma.botErrorLog.deleteMany({});
         json(res, 200, { success: true });
       } catch (err) {
         json(res, 500, { error: 'Erreur de base de données' });
       }
       return true;
    }
  }

  // ============================================================================
  // BROADCAST SYSTEM
  // ============================================================================

  if (parts[2] === 'broadcast') {
    // GET /api/admin/broadcast/emojis - Available custom emojis for the editor
    if (method === 'GET' && parts[3] === 'emojis' && parts.length === 4) {
      const emojiList = Object.entries(E)
        .filter(([, v]) => v && v.startsWith('<'))
        .map(([key, formatted]) => {
          const match = formatted.match(/^<a?:(\w+):\d+>$/);
          return {
            key,
            discordName: match?.[1] || key,
            formatted,
            unicode: UNICODE_FALLBACKS[key] || '❓',
          };
        });
      json(res, 200, { emojis: emojiList });
      return true;
    }

    // ── Medias heberges ─────────────────────────────────────────────────────
    // Une image de broadcast doit vivre derriere une URL publique stable :
    // Discord ne charge ni les `data:` URL ni les liens CDN signes expirables.

    // GET /api/admin/broadcast/media - Bibliotheque d'images
    if (method === 'GET' && parts[3] === 'media' && parts.length === 4) {
      try {
        const limit = Number(url.searchParams.get('limit')) || 60;
        json(res, 200, await listBroadcastMedia(limit));
      } catch (err) {
        logger.error('AdminAPI', 'GET broadcast media error:', err);
        json(res, 500, { error: 'Erreur lors du chargement des images' });
      }
      return true;
    }

    // POST /api/admin/broadcast/media - Upload d'une image
    if (method === 'POST' && parts[3] === 'media' && parts.length === 4) {
      try {
        const body = await readJsonBody<{ fileName?: string; mimeType?: string; data?: string }>(req);
        if (!body?.mimeType || !body?.data) {
          json(res, 400, { error: 'mimeType et data sont requis.' });
          return true;
        }

        const media = await storeBroadcastMedia({
          fileName: body.fileName,
          mimeType: body.mimeType,
          data: body.data,
          uploadedBy: user.userId,
        });

        await recordAdminAudit({
          actorId: user.userId,
          action: 'broadcast.media.upload',
          targetType: 'broadcast_media',
          targetId: media.id,
          summary: `Image de broadcast hébergée : ${media.fileName} (${Math.round(media.size / 1024)} Ko)`,
          ip: resolveRequestIp(req),
        });

        json(res, 201, media);
      } catch (err) {
        if (err instanceof BroadcastMediaError) {
          json(res, err.statusCode, { error: err.message });
          return true;
        }
        logger.error('AdminAPI', 'POST broadcast media error:', err);
        json(res, 500, { error: "Erreur lors de l'upload de l'image" });
      }
      return true;
    }

    // DELETE /api/admin/broadcast/media/:id
    if (method === 'DELETE' && parts[3] === 'media' && parts.length === 5) {
      const deleted = await deleteBroadcastMedia(parts[4]);
      if (deleted) {
        await recordAdminAudit({
          actorId: user.userId,
          action: 'broadcast.media.delete',
          targetType: 'broadcast_media',
          targetId: parts[4],
          summary: 'Image de broadcast supprimée',
          ip: resolveRequestIp(req),
        });
      }
      json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Image introuvable' });
      return true;
    }

    // ── Modeles d'annonce ───────────────────────────────────────────────────

    // GET /api/admin/broadcast/templates
    if (method === 'GET' && parts[3] === 'templates' && parts.length === 4) {
      try {
        const templates = await prisma.broadcastTemplate.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 });
        json(res, 200, { templates });
      } catch (err) {
        logger.error('AdminAPI', 'GET broadcast templates error:', err);
        json(res, 500, { error: 'Erreur lors du chargement des modèles' });
      }
      return true;
    }

    // POST /api/admin/broadcast/templates
    if (method === 'POST' && parts[3] === 'templates' && parts.length === 4) {
      try {
        const body = await readJsonBody<BroadcastRequestBody & { name?: string }>(req);
        const name = body?.name?.trim();
        if (!name) {
          json(res, 400, { error: 'Nom du modèle requis' });
          return true;
        }
        if (!body?.message?.trim()) {
          json(res, 400, { error: 'Message requis' });
          return true;
        }

        const template = await prisma.broadcastTemplate.create({
          data: {
            name: name.slice(0, 120),
            title: body.title?.trim() || null,
            message: body.message.trim(),
            color: body.color || '#5865F2',
            thumbnailUrl: body.thumbnailUrl?.trim() || null,
            imageUrl: body.imageUrl?.trim() || null,
            footerText: body.footerText?.trim() || null,
            target: body.target || 'ALL',
            targetGuilds: Array.isArray(body.targetGuilds) ? body.targetGuilds : [],
            channelPref: body.channelPref || 'AUTO',
            createdBy: user.userId,
          },
        });
        json(res, 201, template);
      } catch (err) {
        logger.error('AdminAPI', 'POST broadcast template error:', err);
        json(res, 500, { error: 'Erreur lors de la création du modèle' });
      }
      return true;
    }

    // DELETE /api/admin/broadcast/templates/:id
    if (method === 'DELETE' && parts[3] === 'templates' && parts.length === 5) {
      await prisma.broadcastTemplate.delete({ where: { id: parts[4] } }).catch(() => {});
      json(res, 200, { ok: true });
      return true;
    }

    // GET /api/admin/broadcast/:id/deliveries - Rapport serveur par serveur
    if (method === 'GET' && parts.length === 5 && parts[4] === 'deliveries') {
      try {
        const statusFilter = url.searchParams.get('status');
        const deliveries = await prisma.broadcastDelivery.findMany({
          where: {
            broadcastId: parts[3],
            ...(statusFilter && statusFilter !== 'ALL' ? { status: statusFilter } : {}),
          },
          orderBy: [{ status: 'asc' }, { guildName: 'asc' }],
          take: 1000,
        });
        json(res, 200, { deliveries });
      } catch (err) {
        logger.error('AdminAPI', 'GET broadcast deliveries error:', err);
        json(res, 500, { error: 'Erreur lors du chargement du rapport de diffusion' });
      }
      return true;
    }

    // POST /api/admin/broadcast/:id/cancel - Annule une annonce programmee
    if (method === 'POST' && parts.length === 5 && parts[4] === 'cancel') {
      try {
        const cancelled = await prisma.broadcastLog.updateMany({
          where: { id: parts[3], status: 'SCHEDULED' },
          data: { status: 'CANCELLED', cancelledBy: user.userId, finishedAt: new Date() },
        });
        if (cancelled.count === 0) {
          json(res, 409, { error: "Cette annonce n'est plus annulable (déjà envoyée ou en cours)." });
          return true;
        }
        await recordAdminAudit({
          actorId: user.userId,
          action: 'broadcast.cancel',
          targetType: 'broadcast',
          targetId: parts[3],
          summary: 'Annonce programmée annulée',
          ip: resolveRequestIp(req),
        });
        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('AdminAPI', 'POST broadcast cancel error:', err);
        json(res, 500, { error: "Erreur lors de l'annulation" });
      }
      return true;
    }

    // GET /api/admin/broadcast/channels - Per-guild broadcast channel configuration
    if (method === 'GET' && parts[3] === 'channels' && parts.length === 4) {
      try {
        interface ShardGuildChannels {
          id: string;
          name: string;
          icon: string | null;
          memberCount: number;
          channels: { id: string; name: string; category: string | null; position: number }[];
        }

        let shardGuildChannels: ShardGuildChannels[];
        if (client.shard) {
          const results = await client.shard.broadcastEval<ShardGuildChannels[]>((shardClient) =>
            shardClient.guilds.cache.map((guild) => ({
              id: guild.id,
              name: guild.name,
              icon: guild.iconURL(),
              memberCount: guild.memberCount,
              channels: guild.channels.cache
                .filter((ch): ch is import('discord.js').TextChannel | import('discord.js').NewsChannel =>
                  (ch.type === 0 || ch.type === 5) && !!ch.permissionsFor(shardClient.user!)?.has(['ViewChannel', 'SendMessages']))
                .map((ch) => ({ id: ch.id, name: ch.name, category: ch.parent?.name ?? null, position: ch.rawPosition }))
                .sort((a, b) => a.position - b.position),
            }))
          );
          shardGuildChannels = results.flat();
        } else {
          shardGuildChannels = client.guilds.cache.map((guild) => ({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL(),
            memberCount: guild.memberCount,
            channels: guild.channels.cache
              .filter((ch): ch is import('discord.js').TextChannel | import('discord.js').NewsChannel =>
                (ch.type === 0 || ch.type === 5) && !!ch.permissionsFor(client.user!)?.has(['ViewChannel', 'SendMessages']))
              .map((ch) => ({ id: ch.id, name: ch.name, category: ch.parent?.name ?? null, position: ch.rawPosition }))
              .sort((a, b) => a.position - b.position),
          }));
        }

        const dbGuilds = await prisma.guild.findMany({
          select: { id: true, activated: true, broadcastChannelId: true },
        });
        const dbMap = new Map(dbGuilds.map((g) => [g.id, g] as const));

        const guilds = shardGuildChannels.map((g) => {
          const dbG = dbMap.get(g.id);
          const configuredId = dbG?.broadcastChannelId ?? null;
          const configured = configuredId ? g.channels.find((ch) => ch.id === configuredId) ?? null : null;
          return {
            id: g.id,
            name: g.name,
            icon: g.icon,
            memberCount: g.memberCount,
            activated: dbG?.activated ?? false,
            broadcastChannelId: configuredId,
            broadcastChannelName: configured?.name ?? null,
            channelStatus: (!configuredId ? 'UNSET' : configured ? 'OK' : 'MISSING') as 'UNSET' | 'OK' | 'MISSING',
            channels: g.channels,
          };
        }).sort((a, b) => a.name.localeCompare(b.name));

        json(res, 200, { guilds });
      } catch (err) {
        logger.error('AdminAPI', 'GET broadcast channels error:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des salons' });
      }
      return true;
    }

    // PUT /api/admin/broadcast/channels/:guildId - Set the broadcast channel for a guild
    if (method === 'PUT' && parts[3] === 'channels' && parts.length === 5) {
      const guildId = parts[4];
      try {
        const body = await readJsonBody<{ channelId?: string | null }>(req);
        const channelId = body?.channelId?.trim() || null;

        if (channelId) {
          let check: { ok: boolean; reason?: string } | null = null;
          if (client.shard) {
            const results = await client.shard.broadcastEval<{ ok: boolean; reason?: string } | null, { guildId: string; channelId: string }>((shardClient, ctx) => {
              const guild = shardClient.guilds.cache.get(ctx.guildId);
              if (!guild) return null;
              const ch = guild.channels.cache.get(ctx.channelId);
              if (!ch || (ch.type !== 0 && ch.type !== 5)) return { ok: false, reason: 'NOT_FOUND' };
              const canSend = !!ch.permissionsFor(shardClient.user!)?.has(['ViewChannel', 'SendMessages']);
              return canSend ? { ok: true } : { ok: false, reason: 'NO_PERMS' };
            }, { context: { guildId, channelId } });
            check = results.find((r) => r !== null) ?? null;
          } else {
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
              const ch = guild.channels.cache.get(channelId);
              if (!ch || (ch.type !== 0 && ch.type !== 5)) check = { ok: false, reason: 'NOT_FOUND' };
              else check = ch.permissionsFor(client.user!)?.has(['ViewChannel', 'SendMessages']) ? { ok: true } : { ok: false, reason: 'NO_PERMS' };
            }
          }

          if (!check) {
            json(res, 404, { error: 'Serveur introuvable' });
            return true;
          }
          if (!check.ok) {
            json(res, 400, { error: check.reason === 'NO_PERMS' ? "Le bot ne peut pas écrire dans ce salon" : 'Salon introuvable sur ce serveur' });
            return true;
          }
        }

        await prisma.guild.upsert({
          where: { id: guildId },
          update: { broadcastChannelId: channelId },
          create: { id: guildId, broadcastChannelId: channelId },
        });

        json(res, 200, { ok: true, guildId, channelId });
      } catch (err) {
        logger.error('AdminAPI', 'PUT broadcast channel error:', err);
        json(res, 500, { error: 'Erreur lors de la configuration du salon' });
      }
      return true;
    }

    // GET /api/admin/broadcast - Broadcast history
    if (method === 'GET' && parts.length === 3) {
      try {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
        const logs = await prisma.broadcastLog.findMany({
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        const enriched = await Promise.all(logs.map(async (log) => {
          try {
            const discordUser = await client.users.fetch(log.sentBy);
            return { ...log, username: discordUser.username, avatarUrl: discordUser.displayAvatarURL() };
          } catch {
            return { ...log, username: 'Inconnu', avatarUrl: null };
          }
        }));
        json(res, 200, { logs: enriched });
      } catch (err) {
        logger.error('AdminAPI', 'GET broadcast history error:', err);
        json(res, 500, { error: "Erreur lors de la récupération de l'historique" });
      }
      return true;
    }

    // DELETE /api/admin/broadcast/:id - Delete a broadcast log entry
    if (method === 'DELETE' && parts.length === 4) {
      try {
        await prisma.broadcastLog.delete({ where: { id: parts[3] } }).catch(() => {});
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }

    // POST /api/admin/broadcast - Envoi immediat, programmation ou simulation
    if (method === 'POST' && parts.length === 3) {
      try {
        const body = await readJsonBody<BroadcastRequestBody>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête requis' });
          return true;
        }

        let normalized;
        try {
          normalized = normalizeBroadcastContent(body);
        } catch (err) {
          if (err instanceof BroadcastValidationError) {
            json(res, 400, { error: err.message, field: err.field });
            return true;
          }
          throw err;
        }

        const allowedGuildIds = await resolveTargetGuildIds(
          client,
          normalized.target,
          normalized.targetGuilds,
          collectShardGuilds,
        );
        const totalTargeted = allowedGuildIds.size;

        // Simulation : on renvoie la cible et les avertissements sans rien envoyer.
        if (body.dryRun === true) {
          const channelMap = await loadGuildChannelMap();
          const unconfigured = [...allowedGuildIds].filter((id) => !channelMap[id]?.broadcastChannelId);
          json(res, 200, {
            dryRun: true,
            totalTargeted,
            target: normalized.target,
            channelPref: normalized.channelPref,
            warnings: normalized.warnings,
            unconfiguredCount: unconfigured.length,
          });
          return true;
        }

        // Programmation : on persiste sans envoyer, le planificateur reprend la main.
        const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
        if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
          json(res, 400, { error: 'Date de programmation invalide.', field: 'scheduledAt' });
          return true;
        }
        if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
          json(res, 400, { error: 'La date de programmation est dans le passé.', field: 'scheduledAt' });
          return true;
        }

        const record = await prisma.broadcastLog.create({
          data: {
            sentBy: user.userId,
            title: normalized.title,
            message: body.message.trim(),
            color: normalized.color,
            thumbnailUrl: normalized.thumbnailUrl,
            imageUrl: normalized.imageUrl,
            footerText: normalized.footerText,
            target: normalized.target,
            targetGuilds: normalized.targetGuilds,
            channelPref: normalized.channelPref,
            totalTargeted,
            status: scheduledAt ? 'SCHEDULED' : 'SENDING',
            scheduledAt,
            startedAt: scheduledAt ? null : new Date(),
          },
        });

        if (scheduledAt) {
          await recordAdminAudit({
            actorId: user.userId,
            action: 'broadcast.schedule',
            targetType: 'broadcast',
            targetId: record.id,
            summary: `Annonce programmée pour ${scheduledAt.toISOString()} vers ${totalTargeted} serveur(s)`,
            metadata: { target: normalized.target, channelPref: normalized.channelPref },
            ip: resolveRequestIp(req),
          });
          json(res, 200, {
            success: true,
            scheduled: true,
            broadcastId: record.id,
            scheduledAt: scheduledAt.toISOString(),
            totalTargeted,
            warnings: normalized.warnings,
          });
          return true;
        }

        const channelMap = await loadGuildChannelMap();
        const deliveries = await deliverBroadcast(client, {
          title: normalized.title,
          message: normalized.message,
          color: normalized.color,
          thumbnailUrl: normalized.thumbnailUrl,
          imageUrl: normalized.imageUrl,
          footerText: normalized.footerText,
          channelPref: normalized.channelPref,
          allowedIds: [...allowedGuildIds],
          channelMap,
        });

        const { successCount, failCount } = await finalizeBroadcast(record.id, deliveries, totalTargeted);
        await markBroadcastMediaUsed([normalized.imageUrl, normalized.thumbnailUrl]);

        await recordAdminAudit({
          actorId: user.userId,
          action: 'broadcast.send',
          targetType: 'broadcast',
          targetId: record.id,
          summary: `Annonce envoyée : ${successCount} succès, ${failCount} échec(s) sur ${totalTargeted} serveur(s)`,
          metadata: { target: normalized.target, channelPref: normalized.channelPref, hasImage: Boolean(normalized.imageUrl) },
          outcome: successCount > 0 || totalTargeted === 0 ? 'OK' : 'FAILED',
          ip: resolveRequestIp(req),
        });

        json(res, 200, {
          success: true,
          broadcastId: record.id,
          successCount,
          failCount,
          totalTargeted,
          warnings: normalized.warnings,
          // Detail borne : la page en affiche l'essentiel, le reste vient de
          // `/api/admin/broadcast/:id/deliveries` a la demande.
          failures: deliveries.filter((d) => d.status !== 'SENT').slice(0, 50),
        });
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.error('AdminAPI', `Broadcast error: ${errMessage}`);
        json(res, 500, { error: "Erreur lors de l'envoi du broadcast" });
      }
      return true;
    }
  }

  // --- GLOBAL ADMIN CODES AND DEACTIVATION ---
  const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
  if (!isGlobalAdmin) {
    json(res, 403, { error: 'Accès réservé aux administrateurs globaux Kotbo.' });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Facturation - reprise en main d'un serveur
  //
  // Ces routes existent parce que Stripe ne couvre pas tout : un partenariat,
  // un geste commercial après une panne, un abonnement créé à la main dans
  // l'interface Stripe, un essai gâché. Chacune de ces situations se règle ici
  // plutôt que par un UPDATE en base, ce qui laisse une trace dans le journal
  // d'audit et purge les caches qu'un UPDATE aurait laissés périmés.
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/billing : état commercial de tous les serveurs connus
  if (parts.length === 3 && parts[2] === 'billing' && method === 'GET') {
    try {
      const guildNames = new Map(
        (await collectShardGuilds(client)).map((g: { id: string; name: string }) => [g.id, g.name] as const),
      );

      const [rows, trials] = await Promise.all([
        prisma.guild.findMany({
          select: {
            id: true,
            plan: true,
            activated: true,
            accessType: true,
            accessExpiresAt: true,
            stripeCustomerId: true,
            stripeSubscriptionId: true,
            stripeSubscriptionStatus: true,
            stripeCurrentPeriodEnd: true,
            stripeCancelAtPeriodEnd: true,
          },
        }),
        prisma.billingTrial.findMany({
          select: { guildId: true, discordUserId: true, subscriptionId: true, reservedAt: true, startedAt: true },
        }),
      ]);

      const trialByGuild = new Map(trials.map((t) => [t.guildId, t] as const));

      const guilds = rows.map((row) => {
        const trial = trialByGuild.get(row.id) ?? null;
        return {
          id: row.id,
          // Un serveur peut être en base sans que le bot y soit encore (il l'a
          // quitté, ou il est sur une autre instance) : on ne le cache pas, son
          // abonnement continue d'exister.
          name: guildNames.get(row.id) ?? null,
          present: guildNames.has(row.id),
          plan: normalizePlanKey(row.plan),
          activated: row.activated,
          accessType: row.accessType,
          accessExpiresAt: row.accessExpiresAt,
          stripeCustomerId: row.stripeCustomerId,
          stripeSubscriptionId: row.stripeSubscriptionId,
          stripeSubscriptionStatus: row.stripeSubscriptionStatus,
          stripeCurrentPeriodEnd: row.stripeCurrentPeriodEnd,
          stripeCancelAtPeriodEnd: row.stripeCancelAtPeriodEnd,
          trial: trial
            ? {
                discordUserId: trial.discordUserId,
                // Sans abonnement rattaché, la ligne n'est qu'une réservation :
                // quelqu'un a ouvert la page de paiement sans aller au bout.
                consumed: Boolean(trial.subscriptionId),
                reservedAt: trial.reservedAt,
                startedAt: trial.startedAt,
              }
            : null,
        };
      });

      const counts: Record<string, number> = {};
      for (const key of PLAN_KEYS) counts[key] = 0;
      for (const guild of guilds) counts[guild.plan] = (counts[guild.plan] ?? 0) + 1;

      json(res, 200, {
        enabled: isBillingEnabled(),
        plans: PLAN_REGISTRY.map((definition) => ({ key: definition.key, name: definition.name })),
        counts,
        trialDays: TRIAL_DAYS,
        subscriptions: guilds.filter((g) => g.stripeSubscriptionId).length,
        trials: trials.filter((t) => t.subscriptionId).length,
        guilds,
      });
    } catch (err) {
      logger.error('AdminAPI', "Erreur lors de la lecture de l'état de facturation :", err);
      json(res, 500, { error: "Erreur lors de la lecture de l'état de facturation." });
    }
    return true;
  }

  // PUT /api/admin/guilds/:guildId/plan : pose une offre à la main
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'plan' && method === 'PUT') {
    const guildId = parts[3];
    try {
      const body = await readJsonBody<{ plan?: string; reason?: string }>(req);
      const requested = typeof body?.plan === 'string' ? body.plan.toUpperCase() : '';

      // `normalizePlanKey` retomberait silencieusement sur FREE : ici on refuse,
      // une faute de frappe ne doit pas fermer les modules d'un client.
      if (!(PLAN_KEYS as readonly string[]).includes(requested)) {
        json(res, 400, { error: `Offre inconnue. Attendu : ${PLAN_KEYS.join(', ')}.` });
        return true;
      }

      const plan = requested as PlanKey;
      const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'geste administrateur';

      // `upsert` : un serveur peut n'avoir aucune ligne (jamais configuré) et
      // recevoir tout de même une offre négociée avant sa première connexion.
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { plan },
        create: { id: guildId, plan },
      });
      await invalidatePlan(guildId);

      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.plan.set',
        targetType: 'guild',
        targetId: guildId,
        summary: `Offre de ${await getGuildName(client, guildId)} posée à ${plan} (${reason})`,
        metadata: { plan, reason },
        ip: resolveRequestIp(req),
      });

      json(res, 200, {
        ok: true,
        plan,
        message: `Offre posée à ${plan}. Les modules suivent d'ici trente secondes (durée du cache).`,
      });
    } catch (err) {
      logger.error('AdminAPI', "Erreur lors de la pose de l'offre :", err);
      json(res, 500, { error: "Erreur lors de la pose de l'offre." });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/billing/gift : offre une période à un serveur
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'billing' && parts[5] === 'gift' && method === 'POST') {
    const guildId = parts[3];
    try {
      const body = await readJsonBody<{ plan?: string; months?: number; note?: string }>(req);
      const requested = typeof body?.plan === 'string' ? body.plan.toUpperCase() : '';

      if (!(PLAN_KEYS as readonly string[]).includes(requested) || requested === 'FREE') {
        json(res, 400, { error: `Offre inconnue. Attendu : ${PLAN_KEYS.filter((k) => k !== 'FREE').join(', ')}.` });
        return true;
      }

      const months = Number(body?.months);
      if (!isGiftDuration(months)) {
        json(res, 400, { error: `Durée invalide. Attendu : ${GIFT_DURATIONS_MONTHS.join(', ')} mois.` });
        return true;
      }

      // Passe par le même chemin qu'un cadeau acheté : activation si le serveur
      // ne l'était pas, offre posée par `planService`, durée par
      // `accessService`. L'historique d'un serveur ne doit pas dépendre de la
      // façon dont il a obtenu son offre.
      const { application, gift } = await grantAdminGift({
        guildId,
        plan: requested as PlanKey,
        months,
        actorId: user.userId,
        note: body?.note ?? null,
      });

      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.billing.gift',
        targetType: 'guild',
        targetId: guildId,
        summary: `${gift.planName} offert à ${await getGuildName(client, guildId)} pour ${months} mois`,
        metadata: { plan: gift.plan, months, giftId: gift.id, note: gift.note },
        ip: resolveRequestIp(req),
      });

      json(res, 200, {
        ok: true,
        gift,
        message: application.keptPermanentAccess
          ? `${gift.planName} posé. Ce serveur a un accès permanent : aucune date d'expiration n'a été écrite.`
          : `${gift.planName} offert pour ${months} mois.`,
      });
    } catch (err) {
      logger.error('AdminAPI', "Erreur lors de l'attribution d'un cadeau :", err);
      json(res, 500, { error: "Erreur lors de l'attribution du cadeau." });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/billing/detach : coupe le lien avec Stripe
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'billing' && parts[5] === 'detach' && method === 'POST') {
    const guildId = parts[3];
    try {
      // On n'annule rien côté Stripe : un abonnement continue de se facturer
      // tant qu'il n'est pas résilié là-bas. Cette route ne fait qu'oublier le
      // lien de notre côté, pour un serveur dont la facturation est reprise
      // hors ligne ou dont l'abonnement a été déplacé sur un autre compte.
      const existing = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { stripeSubscriptionId: true, stripeCustomerId: true },
      });

      if (!existing) {
        json(res, 404, { error: "Ce serveur n'est pas enregistré." });
        return true;
      }

      await prisma.guild.update({
        where: { id: guildId },
        data: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: null,
          stripePriceId: null,
          stripeCancelAtPeriodEnd: false,
          stripeCurrentPeriodEnd: null,
        },
      });
      await invalidatePlan(guildId);

      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.billing.detach',
        targetType: 'guild',
        targetId: guildId,
        summary: `Facturation Stripe détachée de ${await getGuildName(client, guildId)}`,
        metadata: {
          previousSubscriptionId: existing.stripeSubscriptionId,
          previousCustomerId: existing.stripeCustomerId,
        },
        ip: resolveRequestIp(req),
      });

      json(res, 200, {
        ok: true,
        message: existing.stripeSubscriptionId
          ? "Lien Stripe oublié. L'abonnement continue d'exister côté Stripe : le résilier là-bas si le client ne doit plus être débité."
          : 'Lien Stripe oublié.',
      });
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors du détachement de la facturation :', err);
      json(res, 500, { error: 'Erreur lors du détachement de la facturation.' });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/billing/trial-reset : rend son essai gratuit
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'billing' && parts[5] === 'trial-reset' && method === 'POST') {
    const guildId = parts[3];
    try {
      const trial = await prisma.billingTrial.findUnique({ where: { guildId } });
      if (!trial) {
        json(res, 404, { error: "Ce serveur n'a jamais ouvert d'essai." });
        return true;
      }

      // La ligne porte les deux gardes à la fois : la supprimer rend l'essai au
      // serveur *et* au compte Discord qui l'avait déclenché. C'est voulu - on
      // ne peut pas en rendre un sans l'autre - mais ça se dit.
      await prisma.billingTrial.delete({ where: { guildId } });

      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.billing.trial_reset',
        targetType: 'guild',
        targetId: guildId,
        summary: `Essai gratuit rendu à ${await getGuildName(client, guildId)}`,
        metadata: { discordUserId: trial.discordUserId, consumed: Boolean(trial.subscriptionId) },
        ip: resolveRequestIp(req),
      });

      json(res, 200, {
        ok: true,
        message: `Essai rendu au serveur et au compte ${trial.discordUserId}.`,
      });
    } catch (err) {
      logger.error('AdminAPI', "Erreur lors de la remise à zéro de l'essai :", err);
      json(res, 500, { error: "Erreur lors de la remise à zéro de l'essai." });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/billing/resync : relit l'abonnement Stripe
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'billing' && parts[5] === 'resync' && method === 'POST') {
    const guildId = parts[3];
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { stripeSubscriptionId: true },
      });

      if (!guild?.stripeSubscriptionId) {
        json(res, 404, { error: "Ce serveur n'a pas d'abonnement Stripe rattaché." });
        return true;
      }

      // Rattrapage d'un webhook perdu : `syncSubscription` recalcule l'état
      // complet à partir de l'abonnement, exactement comme le ferait
      // l'événement manquant. Idempotent, donc sans risque à relancer.
      const { retrieveSubscription } = await import('../../services/billing/stripeService.js');
      const { syncSubscription } = await import('../../services/billing/subscriptionSync.js');

      const subscription = await retrieveSubscription(guild.stripeSubscriptionId);
      if (!subscription) {
        json(res, 404, { error: "Cet abonnement n'existe plus côté Stripe (ou la clé est celle d'un autre compte)." });
        return true;
      }

      await syncSubscription(subscription);

      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.billing.resync',
        targetType: 'guild',
        targetId: guildId,
        summary: `Abonnement Stripe resynchronisé pour ${await getGuildName(client, guildId)}`,
        metadata: { subscriptionId: guild.stripeSubscriptionId, status: subscription.status },
        ip: resolveRequestIp(req),
      });

      json(res, 200, { ok: true, status: subscription.status, message: `Abonnement relu : statut ${subscription.status}.` });
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors de la resynchronisation Stripe :', err);
      json(res, 500, { error: 'Erreur lors de la resynchronisation Stripe.' });
    }
    return true;
  }

  // GET /api/admin/activation-codes
  if (parts.length === 3 && parts[2] === 'activation-codes' && method === 'GET') {
    try {
      const guildNames = new Map((await collectShardGuilds(client)).map((g: { id: string; name: string }) => [g.id, g.name] as const));
      const codes = await prisma.activationCode.findMany({
        orderBy: { createdAt: 'desc' }
      });
      // État d'accès des serveurs ayant consommé un code, pour afficher
      // l'échéance et le temps restant à côté du code.
      const usedGuildIds = codes.map((c) => c.usedByGuildId).filter((id): id is string => !!id);
      const accessRows = usedGuildIds.length
        ? await prisma.guild.findMany({
            where: { id: { in: usedGuildIds } },
            select: { id: true, activated: true, accessType: true, accessExpiresAt: true, accessExpiredAt: true },
          })
        : [];
      const accessByGuild = new Map(accessRows.map((g) => [g.id, g] as const));

      const enrichedCodes = await Promise.all(codes.map(async (c) => {
        let guildName = null;
        if (c.usedByGuildId) {
          guildName = guildNames.get(c.usedByGuildId) ?? getGuildName(client, c.usedByGuildId);
        }
        const access = c.usedByGuildId ? accessByGuild.get(c.usedByGuildId) : null;
        return {
          ...c,
          guildName,
          guildActivated: access?.activated ?? null,
          accessExpiresAt: access?.accessExpiresAt ?? null,
          accessExpiredAt: access?.accessExpiredAt ?? null,
        };
      }));
      json(res, 200, enrichedCodes);
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors de la récupération des codes :', err);
      json(res, 500, { error: "Erreur lors de la récupération des codes d'activation." });
    }
    return true;
  }

  // POST /api/admin/activation-codes
  if (parts.length === 3 && parts[2] === 'activation-codes' && method === 'POST') {
    try {
      // Corps optionnel : sans lui, on retombe sur un code permanent, le
      // comportement historique de cet endpoint.
      const body = isJsonRequest(req)
        ? await readJsonBody<{ accessType?: string; durationMinutes?: number | null; label?: string | null }>(req)
        : null;
      const access = normalizeAccessGrant(body?.accessType, body?.durationMinutes);
      if ('error' in access) {
        json(res, 400, { error: access.error });
        return true;
      }

      const code = `KB-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

      const newCode = await prisma.activationCode.create({
        data: {
          code,
          createdById: user.userId,
          isActive: true,
          accessType: access.accessType,
          durationMinutes: access.durationMinutes,
          label: body?.label?.trim() || null,
        }
      });

      json(res, 201, newCode);
    } catch (err) {
      logger.error('AdminAPI', "Erreur lors de la création d'un code :", err);
      json(res, 500, { error: "Erreur lors de la création du code d'activation." });
    }
    return true;
  }

  // DELETE /api/admin/activation-codes/:id
  if (parts.length === 4 && parts[2] === 'activation-codes' && method === 'DELETE') {
    const codeId = parts[3];
    try {
      const codeRow = await prisma.activationCode.findUnique({
        where: { id: codeId }
      });

      if (!codeRow) {
        json(res, 404, { error: 'Code introuvable.' });
        return true;
      }

      if (codeRow.usedByGuildId) {
        await deactivateGuild(codeRow.usedByGuildId);
        // Le serveur perd tout sur décision humaine : il faut le lui dire.
        // Jamais bloquant, une notification ratée ne doit pas annuler la révocation.
        await announceAccessRevoked(client, codeRow.usedByGuildId).catch((err) =>
          logger.warn('AdminAPI', `Impossible de prévenir ${codeRow.usedByGuildId} de la révocation :`, err),
        );
      }

      await prisma.activationCode.delete({
        where: { id: codeId }
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors de la suppression du code :', err);
      json(res, 500, { error: "Erreur lors de la suppression du code d'activation." });
    }
    return true;
  }

  // POST /api/admin/staff-servers/reconcile - resynchronise l'activation de tous les serveurs staff liés
  if (parts.length === 4 && parts[2] === 'staff-servers' && parts[3] === 'reconcile' && method === 'POST') {
    try {
      const links = await prisma.staffServerLink.findMany({
        where: { enabled: true },
        select: { staffGuildId: true },
        distinct: ['staffGuildId'],
      });

      const counts = { checked: 0, activated: 0, deactivated: 0, unchanged: 0 };

      for (const link of links) {
        counts.checked++;
        try {
          const result = await reconcileStaffGuildActivation(link.staffGuildId);
          counts[result]++;
        } catch (err) {
          logger.error('AdminAPI', `Erreur de réconciliation du serveur staff ${link.staffGuildId} :`, err);
          counts.unchanged++;
        }
      }

      json(res, 200, { ok: true, ...counts });
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors de la synchronisation des serveurs staff :', err);
      json(res, 500, { error: 'Erreur lors de la synchronisation des serveurs staff.' });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/deactivate
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'deactivate' && method === 'POST') {
    const guildId = parts[3];
    try {
      await deactivateGuild(guildId);
      await announceAccessRevoked(client, guildId).catch((err) =>
        logger.warn('AdminAPI', `Impossible de prévenir ${guildId} de la désactivation :`, err),
      );
      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.deactivate',
        targetType: 'guild',
        targetId: guildId,
        summary: `Serveur ${await getGuildName(client, guildId)} désactivé`,
        ip: resolveRequestIp(req),
      });
      json(res, 200, { ok: true, message: 'Le serveur a été désactivé.' });
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors de la désactivation du serveur :', err);
      json(res, 500, { error: 'Erreur lors de la désactivation du serveur.' });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/activate-auto
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'activate-auto' && method === 'POST') {
    const guildId = parts[3];
    try {
      // Corps optionnel : sans lui, l'activation reste permanente comme avant.
      const body = isJsonRequest(req)
        ? await readJsonBody<{ accessType?: string; durationMinutes?: number | null }>(req)
        : null;
      const access = normalizeAccessGrant(body?.accessType, body?.durationMinutes);
      if ('error' in access) {
        json(res, 400, { error: access.error });
        return true;
      }

      const code = `KB-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

      await prisma.activationCode.create({
        data: {
          code,
          createdById: user.userId,
          isActive: true,
          accessType: access.accessType,
          durationMinutes: access.durationMinutes,
        }
      });

      const result = await activateGuild(guildId, code);

      if (result.expiresAt && result.durationMinutes) {
        await announceTrialStart(client, guildId, result.expiresAt, result.durationMinutes).catch((err) =>
          logger.warn('AdminAPI', `Impossible d'annoncer le démarrage de l'essai sur ${guildId} :`, err),
        );
      }

      await recordAdminAudit({
        actorId: user.userId,
        action: 'guild.activate',
        targetType: 'guild',
        targetId: guildId,
        summary: result.expiresAt
          ? `Serveur ${await getGuildName(client, guildId)} activé pour ${formatDuration(result.durationMinutes!)}`
          : `Serveur ${await getGuildName(client, guildId)} activé (accès permanent)`,
        metadata: { accessType: result.accessType, code },
        ip: resolveRequestIp(req),
      });

      json(res, 200, {
        ok: true,
        code,
        accessType: result.accessType,
        accessExpiresAt: result.expiresAt,
        message: result.expiresAt
          ? `Le serveur a été activé pour ${formatDuration(result.durationMinutes!)}.`
          : 'Le serveur a été activé automatiquement.',
      });
    } catch (err) {
      logger.error('AdminAPI', 'Erreur lors de la génération et affectation du code :', err);
      json(res, 500, { error: "Erreur lors de l'activation automatique du serveur." });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/access/extend : prolonge un accès à durée limitée
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'access' && parts[5] === 'extend' && method === 'POST') {
    const guildId = parts[3];
    try {
      const body = await readJsonBody<{ minutes?: number; accessType?: string }>(req);
      const minutes = typeof body?.minutes === 'number' ? body.minutes : Number(body?.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ACCESS_DURATION_MINUTES) {
        json(res, 400, { error: `La durée doit être un nombre entier de minutes entre 1 et ${MAX_ACCESS_DURATION_MINUTES}.` });
        return true;
      }

      const type = body?.accessType ? normalizeAccessGrant(body.accessType, minutes) : null;
      if (type && 'error' in type) {
        json(res, 400, { error: type.error });
        return true;
      }

      const status = await extendAccess(guildId, minutes, type ? { type: type.accessType } : {});
      if (!status) {
        json(res, 404, { error: "Ce serveur n'est pas enregistré." });
        return true;
      }

      json(res, 200, {
        ok: true,
        accessType: status.accessType,
        accessExpiresAt: status.accessExpiresAt,
        minutesLeft: status.minutesLeft,
        message: status.accessExpiresAt
          ? `Accès prolongé jusqu'au ${status.accessExpiresAt.toLocaleString('fr-FR')}.`
          : 'Ce serveur dispose déjà d\'un accès permanent.',
      });
    } catch (err) {
      logger.error('AdminAPI', "Erreur lors de la prolongation de l'accès :", err);
      json(res, 500, { error: "Erreur lors de la prolongation de l'accès." });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/rescan-stats
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'rescan-stats' && method === 'POST') {
    const guildId = parts[3];

    // Check if guild exists across shards
    let guildExists = false;
    if (client.shard) {
      const results = await client.shard.broadcastEval<boolean, string>((c, id) => c.guilds.cache.has(id), { context: guildId });
      guildExists = results.some(r => r);
    } else {
      guildExists = client.guilds.cache.has(guildId) || !!(await client.guilds.fetch(guildId).catch(() => null));
    }

    if (!guildExists) {
      json(res, 404, { error: 'Serveur introuvable' });
      return true;
    }

    try {
      const body = await readJsonBody<{ force?: boolean; forcer?: boolean }>(req);
      const force = !!(body?.force || body?.forcer);

      if (client.shard) {
        const results = await client.shard.broadcastEval<{ status: string; error?: string } | null, { guildId: string; force: boolean; servicePath: string }>(async (shardClient, context) => {
          const guild = shardClient.guilds.cache.get(context.guildId);
          if (!guild) return null;
          try {
            const { startHistoricalScraping } = await import(context.servicePath);
            const result = await startHistoricalScraping(shardClient, context.guildId, context.force);
            return { status: result.status };
          } catch (err) {
            return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
          }
        }, { context: { guildId, force, servicePath } });

        const result = results.find(r => r !== null);
        if (!result) {
          json(res, 404, { error: 'Serveur introuvable' });
        } else if (result.status === 'STARTED') {
          json(res, 200, { ok: true, message: 'Scraping historique lancé avec succès.' });
        } else if (result.status === 'ALREADY_COMPLETED') {
          json(res, 200, { ok: true, message: "L'historique est déjà entièrement synchronisé." });
        } else if (result.status === 'ALREADY_RUNNING') {
          json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
        } else {
          json(res, 500, { error: result.error || 'Erreur lors du lancement du scraping' });
        }
      } else {
        const { startHistoricalScraping } = await import('../../services/analytics/messageScraperService.js');
        const result = await startHistoricalScraping(client, guildId, force);
        if (result.status === 'ALREADY_RUNNING') {
          json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
        } else {
          json(res, 200, {
            ok: true,
            message: result.status === 'ALREADY_COMPLETED'
              ? "L'historique est déjà entièrement synchronisé."
              : 'Scraping historique lancé avec succès.',
          });
        }
      }
    } catch (err) {
      logger.error('AdminAPI', 'POST rescan-stats error:', err);
      json(res, 500, { error: 'Erreur lors du lancement du scraping' });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/resync-all
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'resync-all' && method === 'POST') {
    const guildId = parts[3];

    try {
      if (client.shard) {
        const results = await client.shard.broadcastEval<
          { status: string; error?: string } | null,
          { guildId: string; servicePath: string }
        >(async (shardClient, context) => {
          if (!shardClient.guilds.cache.has(context.guildId)) return null;
          try {
            const { startGuildDataSync } = await import(context.servicePath);
            const result = await startGuildDataSync(shardClient, context.guildId);
            return { status: result.status };
          } catch (error) {
            return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
          }
        }, { context: { guildId, servicePath: guildDataSyncServicePath } });

        const result = results.find((entry) => entry !== null);
        if (!result) {
          json(res, 404, { error: 'Serveur introuvable' });
        } else if (result.status === 'STARTED') {
          json(res, 202, { ok: true, status: result.status, message: 'Synchronisation complète lancée.' });
        } else if (result.status === 'ALREADY_RUNNING') {
          json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
        } else if (result.status === 'NOT_ACTIVATED') {
          json(res, 400, { error: "Le serveur doit être activé avant d'être synchronisé." });
        } else {
          json(res, 500, { error: result.error || 'Impossible de lancer la synchronisation complète.' });
        }
      } else {
        if (!client.guilds.cache.has(guildId) && !(await client.guilds.fetch(guildId).catch(() => null))) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const { startGuildDataSync } = await import('../../services/analytics/guildDataSyncService.js');
        const result = await startGuildDataSync(client, guildId);
        if (result.status === 'STARTED') {
          json(res, 202, { ok: true, status: result.status, message: 'Synchronisation complète lancée.' });
        } else if (result.status === 'ALREADY_RUNNING') {
          json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
        } else if (result.status === 'NOT_ACTIVATED') {
          json(res, 400, { error: "Le serveur doit être activé avant d'être synchronisé." });
        } else {
          json(res, 404, { error: 'Serveur introuvable' });
        }
      }
    } catch (error) {
      logger.error('AdminAPI', 'POST resync-all error:', error);
      json(res, 500, { error: 'Erreur lors du lancement de la synchronisation complète.' });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/reset-server-template
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'reset-server-template' && method === 'POST') {
    const guildId = parts[3];

    try {
      const guildRow = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { serverTemplateAppliedAt: true, serverTemplateAppliedBy: true },
      });
      if (!guildRow) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }
      if (!guildRow.serverTemplateAppliedAt) {
        json(res, 409, { error: "La mise en place du serveur n'a jamais été lancée sur ce serveur." });
        return true;
      }

      // `serverTemplateRefs` survit a la remise a zero : les salons deja crees
      // existent toujours, et c'est cette trace qui evite qu'une seconde mise
      // en place les double.
      await prisma.guild.update({
        where: { id: guildId },
        data: {
          serverTemplateAppliedAt: null,
          serverTemplateAppliedBy: null,
          serverTemplateSections: [],
        },
      });
      await cache.invalidateGuild(guildId).catch(() => null);

      json(res, 200, {
        ok: true,
        message: `Mise en place rouverte (précédemment faite par ${guildRow.serverTemplateAppliedBy ?? 'un administrateur'}).`,
      });
    } catch (error) {
      logger.error('AdminAPI', 'POST reset-server-template error:', error);
      json(res, 500, { error: 'Erreur lors de la réinitialisation de la mise en place.' });
    }
    return true;
  }

  // POST /api/admin/guilds/:guildId/rescan-members
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'rescan-members' && method === 'POST') {
    const guildId = parts[3];

    let guildExists = false;
    if (client.shard) {
      const results = await client.shard.broadcastEval<boolean, string>((c, id) => c.guilds.cache.has(id), { context: guildId });
      guildExists = results.some(r => r);
    } else {
      guildExists = client.guilds.cache.has(guildId) || !!(await client.guilds.fetch(guildId).catch(() => null));
    }

    if (!guildExists) {
      json(res, 404, { error: 'Serveur introuvable' });
      return true;
    }

    try {
      const body = await readJsonBody<{ force?: boolean }>(req);
      const force = !!body?.force;

      const memberServicePath = path.resolve(__dirname, '../../services/analytics/memberScraperService.js');

      if (client.shard) {
        const results = await client.shard.broadcastEval<{ status: string; error?: string } | null, { guildId: string; force: boolean; servicePath: string }>(async (shardClient, context) => {
          const guild = shardClient.guilds.cache.get(context.guildId);
          if (!guild) return null;
          try {
            const { startMemberScraping } = await import(context.servicePath);
            const result = await startMemberScraping(shardClient, context.guildId, context.force);
            return { status: result.status };
          } catch (err) {
            return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
          }
        }, { context: { guildId, force, servicePath: memberServicePath } });

        const result = results.find(r => r !== null);
        if (!result) {
          json(res, 404, { error: 'Serveur introuvable' });
        } else if (result.status === 'STARTED') {
          json(res, 200, { ok: true, message: 'Scraping des membres lancé avec succès.' });
        } else if (result.status === 'ALREADY_COMPLETED') {
          json(res, 200, { ok: true, message: 'Les membres sont déjà synchronisés.' });
        } else if (result.status === 'ALREADY_RUNNING') {
          json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
        } else {
          json(res, 500, { error: result.error || 'Erreur lors du lancement du scraping membres' });
        }
      } else {
        const { startMemberScraping } = await import('../../services/analytics/memberScraperService.js');
        const result = await startMemberScraping(client, guildId, force);
        if (result.status === 'ALREADY_RUNNING') {
          json(res, 409, { error: 'Une synchronisation est déjà en cours sur ce serveur.' });
        } else {
          json(res, 200, {
            ok: true,
            message: result.status === 'ALREADY_COMPLETED'
              ? 'Les membres sont déjà synchronisés.'
              : 'Scraping des membres lancé avec succès.',
          });
        }
      }
    } catch (err) {
      logger.error('AdminAPI', 'POST rescan-members error:', err);
      json(res, 500, { error: 'Erreur lors du lancement du scraping membres' });
    }
    return true;
  }

  // ============================================================================
  // WHITE-LABEL INSTANCE MANAGEMENT
  // ============================================================================

  // GET /api/admin/whitelabel - List all instances
  if (parts[2] === 'whitelabel' && parts.length === 3 && method === 'GET') {
    try {
      const instances = await prisma.whiteLabelInstance.findMany({
        include: { _count: { select: { guilds: true } } },
        orderBy: { createdAt: 'desc' },
      });

      const safe = instances.map(inst => ({
        id: inst.id,
        slug: inst.slug,
        name: inst.name,
        enabled: inst.enabled,
        discordClientId: inst.discordClientId,
        dashboardUrl: inst.dashboardUrl,
        apiPort: inst.apiPort,
        brandName: inst.brandName,
        brandColor: inst.brandColor,
        brandLogoUrl: inst.brandLogoUrl,
        brandFaviconUrl: inst.brandFaviconUrl,
        brandFooterText: inst.brandFooterText,
        ownerId: inst.ownerId,
        maxGuilds: inst.maxGuilds,
        guildCount: inst._count.guilds,
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
      }));

      json(res, 200, { instances: safe });
    } catch (err) {
      logger.error('AdminAPI', 'GET whitelabel error:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des instances' });
    }
    return true;
  }

  // POST /api/admin/whitelabel - Create instance
  if (parts[2] === 'whitelabel' && parts.length === 3 && method === 'POST') {
    try {
      // Creation d'une instance marque blanche : tous les champs viennent du
      // corps de requete, valides juste en dessous.
      const body = await readJsonBody<Partial<{
        slug: string;
        name: string;
        discordToken: string;
        discordClientId: string;
        discordClientSecret: string;
        discordRedirectUri: string;
        dashboardUrl: string;
        apiPort: string | number;
        brandName: string;
        brandColor: string;
        brandLogoUrl: string;
        brandFaviconUrl: string;
        brandFooterText: string;
        ownerId: string;
        maxGuilds: string | number;
      }>>(req);
      if (!body) { json(res, 400, { error: 'Body JSON requis' }); return true; }

      const { slug, name, discordToken, discordClientId, discordClientSecret,
        discordRedirectUri, dashboardUrl, apiPort, brandName, brandColor,
        brandLogoUrl, brandFaviconUrl, brandFooterText, ownerId, maxGuilds } = body;

      if (!slug || !name || !discordToken || !discordClientId || !discordClientSecret || !ownerId) {
        json(res, 400, { error: 'Champs requis: slug, name, discordToken, discordClientId, discordClientSecret, ownerId' });
        return true;
      }

      const existing = await prisma.whiteLabelInstance.findUnique({ where: { slug } });
      if (existing) {
        json(res, 409, { error: `Le slug "${slug}" est déjà utilisé.` });
        return true;
      }

      const instance = await prisma.whiteLabelInstance.create({
        data: {
          slug,
          name,
          discordToken,
          discordClientId,
          discordClientSecret,
          discordRedirectUri: discordRedirectUri || null,
          dashboardUrl: dashboardUrl || null,
          apiPort: apiPort ? Number(apiPort) : null,
          brandName: brandName || null,
          brandColor: brandColor || '#5865F2',
          brandLogoUrl: brandLogoUrl || null,
          brandFaviconUrl: brandFaviconUrl || null,
          brandFooterText: brandFooterText || null,
          ownerId,
          maxGuilds: maxGuilds ? Number(maxGuilds) : 1,
        },
      });

      json(res, 201, { instance: { id: instance.id, slug: instance.slug, name: instance.name } });
    } catch (err) {
      logger.error('AdminAPI', 'POST whitelabel error:', err);
      json(res, 500, { error: 'Erreur lors de la création de l\'instance' });
    }
    return true;
  }

  // GET /api/admin/whitelabel/:id - Get instance details
  if (parts[2] === 'whitelabel' && parts[3] && parts.length === 4 && method === 'GET') {
    try {
      const instance = await prisma.whiteLabelInstance.findUnique({
        where: { id: parts[3] },
        include: {
          guilds: { select: { id: true, activated: true } },
        },
      });

      if (!instance) {
        json(res, 404, { error: 'Instance introuvable' });
        return true;
      }

      json(res, 200, {
        instance: {
          ...instance,
          discordToken: '••••' + instance.discordToken.slice(-6),
          discordClientSecret: '••••' + instance.discordClientSecret.slice(-4),
          jwtSecret: instance.jwtSecret ? '••••' : null,
        },
      });
    } catch (err) {
      logger.error('AdminAPI', 'GET whitelabel/:id error:', err);
      json(res, 500, { error: 'Erreur lors de la récupération de l\'instance' });
    }
    return true;
  }

  // PATCH /api/admin/whitelabel/:id - Update instance
  if (parts[2] === 'whitelabel' && parts[3] && parts.length === 4 && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      if (!body) { json(res, 400, { error: 'Body JSON requis' }); return true; }

      const existing = await prisma.whiteLabelInstance.findUnique({ where: { id: parts[3] } });
      if (!existing) {
        json(res, 404, { error: 'Instance introuvable' });
        return true;
      }

      const allowedFields = [
        'name', 'slug', 'enabled', 'discordToken', 'discordClientId',
        'discordClientSecret', 'discordRedirectUri', 'dashboardUrl', 'apiPort',
        'brandName', 'brandColor', 'brandLogoUrl', 'brandFaviconUrl',
        'brandFooterText', 'jwtSecret', 'ownerId', 'maxGuilds',
      ] as const;

      const updateData: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          if (field === 'apiPort' || field === 'maxGuilds') {
            updateData[field] = body[field] === null ? null : Number(body[field]);
          } else if (field === 'enabled') {
            updateData[field] = Boolean(body[field]);
          } else {
            updateData[field] = body[field];
          }
        }
      }

      const dashboardUrl = typeof updateData.dashboardUrl === 'string' ? updateData.dashboardUrl : null;
      if (dashboardUrl) {
        try {
          updateData.dashboardOrigin = new URL(dashboardUrl).origin;
        } catch {
          updateData.dashboardOrigin = dashboardUrl.replace(/\/$/, '');
        }
      }

      const updated = await prisma.whiteLabelInstance.update({
        where: { id: parts[3] },
        data: updateData,
      });

      json(res, 200, { instance: { id: updated.id, slug: updated.slug, name: updated.name } });
    } catch (err) {
      logger.error('AdminAPI', 'PATCH whitelabel/:id error:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de l\'instance' });
    }
    return true;
  }

  // DELETE /api/admin/whitelabel/:id - Delete instance
  if (parts[2] === 'whitelabel' && parts[3] && parts.length === 4 && method === 'DELETE') {
    try {
      const existing = await prisma.whiteLabelInstance.findUnique({
        where: { id: parts[3] },
        include: { _count: { select: { guilds: true } } },
      });

      if (!existing) {
        json(res, 404, { error: 'Instance introuvable' });
        return true;
      }

      if (existing._count.guilds > 0) {
        json(res, 409, { error: `Impossible de supprimer : ${existing._count.guilds} guild(s) rattachée(s). Détachez-les d'abord.` });
        return true;
      }

      await prisma.whiteLabelInstance.delete({ where: { id: parts[3] } });
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('AdminAPI', 'DELETE whitelabel/:id error:', err);
      json(res, 500, { error: 'Erreur lors de la suppression de l\'instance' });
    }
    return true;
  }

  // POST /api/admin/whitelabel/:id/guilds - Bind a guild to an instance
  if (parts[2] === 'whitelabel' && parts[3] && parts[4] === 'guilds' && parts.length === 5 && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body?.guildId) { json(res, 400, { error: 'guildId requis' }); return true; }

      const instance = await prisma.whiteLabelInstance.findUnique({
        where: { id: parts[3] },
        include: { _count: { select: { guilds: true } } },
      });

      if (!instance) {
        json(res, 404, { error: 'Instance introuvable' });
        return true;
      }

      if (instance._count.guilds >= instance.maxGuilds) {
        json(res, 409, { error: `Limite atteinte : ${instance.maxGuilds} guild(s) maximum pour cette instance.` });
        return true;
      }

      await prisma.guild.update({
        where: { id: String(body.guildId) },
        data: { instanceId: instance.id },
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('AdminAPI', 'POST whitelabel/:id/guilds error:', err);
      json(res, 500, { error: 'Erreur lors du rattachement de la guild' });
    }
    return true;
  }

  // DELETE /api/admin/whitelabel/:id/guilds/:guildId - Unbind a guild
  if (parts[2] === 'whitelabel' && parts[3] && parts[4] === 'guilds' && parts[5] && parts.length === 6 && method === 'DELETE') {
    try {
      await prisma.guild.update({
        where: { id: parts[5] },
        data: { instanceId: null },
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('AdminAPI', 'DELETE whitelabel guild unbind error:', err);
      json(res, 500, { error: 'Erreur lors du détachement de la guild' });
    }
    return true;
  }

  // ── RGPD : retrait des avis de satisfaction publiés sur Discord ──
  // DELETE /api/admin/gdpr/:userId/satisfaction-reviews
  // À appeler avant d'effacer les lignes en base : l'identifiant du message
  // publié n'existe que sur la ligne de l'avis.
  if (parts[2] === 'gdpr' && parts[3] && parts[4] === 'satisfaction-reviews' && parts.length === 5 && method === 'DELETE') {
    const userId = parts[3];

    if (!/^\d{5,25}$/.test(userId)) {
      json(res, 400, { error: 'Identifiant Discord invalide.' });
      return true;
    }

    try {
      const { deleteSatisfactionReviewMessages } = await import('../../services/features/ticketSatisfactionService.js');
      const result = await deleteSatisfactionReviewMessages(client, userId);
      logger.info('AdminAPI', `Avis de satisfaction de ${userId} retirés de Discord (${result.deleted} supprimés, ${result.cleared} déjà absents, ${result.failed} en échec) par ${user.userId}`);
      json(res, 200, result);
    } catch (err) {
      logger.error('AdminAPI', 'GDPR satisfaction reviews deletion error:', err);
      json(res, 500, { error: 'Erreur lors du retrait des avis publiés.' });
    }
    return true;
  }

  // ── RGPD : export des données d'un utilisateur ──────────────────
  // GET /api/admin/gdpr/:userId/preview - résumé (catégories + décomptes)
  // GET /api/admin/gdpr/:userId/export  - archive ZIP complète
  if (parts[2] === 'gdpr' && parts[3] && parts.length === 5 && method === 'GET') {
    const userId = parts[3];
    const action = parts[4];

    if (!/^\d{5,25}$/.test(userId)) {
      json(res, 400, { error: 'Identifiant Discord invalide.' });
      return true;
    }

    if (action !== 'preview' && action !== 'export') {
      return false;
    }

    try {
      const data = await collectUserData(client, userId);

      if (action === 'preview') {
        json(res, 200, {
          meta: data.meta,
          identity: data.identity,
          categories: data.categories.map((c) => ({
            key: c.key,
            label: c.label,
            description: c.description,
            count: c.count,
            tables: c.tables.map((t) => ({ key: t.key, label: t.label, count: t.count })),
          })),
        });
        return true;
      }

      // action === 'export'
      const zip = buildGdprZip(data);
      const safeName = (data.meta.username ?? userId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `kotbo_rgpd_${safeName}_${new Date().toISOString().slice(0, 10)}.zip`;
      const buffer = Buffer.from(zip);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.statusCode = 200;
      res.end(buffer);
      logger.info('AdminAPI', `Export RGPD généré pour ${userId} (${data.meta.totalRecords} enregistrements) par ${user.userId}`);
      return true;
    } catch (err) {
      logger.error('AdminAPI', 'GDPR export error:', err);
      json(res, 500, { error: "Erreur lors de la génération de l'export RGPD." });
      return true;
    }
  }

  return false;
}
