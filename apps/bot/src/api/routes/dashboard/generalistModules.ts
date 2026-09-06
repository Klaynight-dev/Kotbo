import { IncomingMessage, ServerResponse } from 'node:http';
import { Client, EmbedBuilder, PermissionFlagsBits, type ColorResolvable } from 'discord.js';
import prisma, { prismaRead } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { defaultLevelUpMessage, getOrCreateLevelConfig, updateMemberLevelRoles, getXpForLevel, getLevelFromXp, getGuildLevelCurve, invalidateLevelConfigCache, levelCurveFromConfig, resyncGuildLevels, countCurveImpact, invalidateLevelRewardsCache, getRoleResyncStatus, startRoleResync, stopRoleResync } from '../../../services/progression/levelingService.js';
import { clampXp, normalizeLevelCurve } from '@kotbo/shared';
import { getOrCreateWelcomeConfig } from '../../../services/features/welcomeGoodbyeService.js';
import { getMemberIdentities, resolveMemberAvatarUrl, resolveSearchedUserIds } from '../../../services/moderation/memberIdentityService.js';
import {
  getOrCreateWelcomeThreadConfig,
  clampStepDelay,
  MAX_THREAD_STEPS,
  MIN_INACTIVITY_DELETE_HOURS,
  MAX_INACTIVITY_DELETE_HOURS,
} from '../../../services/features/welcomeThreadService.js';
import { getOrCreateAutoModConfig, invalidateAutoModCache, syncDiscordAutoModRules } from '../../../services/moderation/autoModService.js';
import { createGiveaway, endGiveaway, rerollGiveaway } from '../../../services/features/giveawayService.js';
import { canManageGiveaways, getGiveawayConfig, normalizeRoleIds, updateGiveawayConfig } from '../../../services/features/giveawayConfigService.js';
import { createReactionRoleMenu, deleteReactionRoleMenu } from '../../../services/features/reactionRoleService.js';
import { invalidateAutoResponseCache } from '../../../services/features/autoResponseService.js';
import { resolveSuggestion } from '../../../services/features/suggestionService.js';
import { broadcastDashboardStateChange, json, readJsonBody, getGuildName, pushAudit, resolveMemberFeatureAccess, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { acquireProvisionLock, ensureTextChannel, missingProvisionPermissions, provisionCooldown, provisionCooldownMessage, releaseProvisionLock, startProvisionCooldown } from '../../../services/core/channelProvisioningService.js';
import { fetchAllMembers } from '../../../utils/discord.js';
import { resolveEmojiShortcodes } from '../../../utils/emojis.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';

/** Modules de ce fichier dont l'acces est filtre par les regles de role. */
const FEATURE_GUARDED_MODULE_KEYS = new Set(['economy', 'fun']);

const LEADERBOARD_PAGE_SIZE = 25;
/** Plafond des profils retenus par une recherche, avant pagination. */
const LEADERBOARD_SEARCH_LIMIT = 500;

/**
 * Complète des lignes de classement avec de quoi les afficher : le profil connu
 * en base, et le membre Discord quand il est en cache, qui a toujours raison sur
 * le profil (pseudo serveur, avatar à jour).
 */
async function withMemberIdentity(
  guildId: string,
  client: Client,
  rows: Array<{ userId: string }>,
) {
  const profiles = await prisma.memberProfile.findMany({
    where: { guildId, userId: { in: rows.map((row) => row.userId) } },
  });
  const profileMap = new Map(profiles.map((profile) => [profile.userId, profile]));
  const discordGuild = client.guilds.cache.get(guildId);

  return rows.map((row) => {
    const profile = profileMap.get(row.userId);
    const discordMember = discordGuild?.members.cache.get(row.userId);

    return {
      ...row,
      username: discordMember?.user?.username || profile?.username || null,
      displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${row.userId}`,
      avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
    };
  });
}

export async function handleGeneralistModulesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const moduleKey = parts[4];
  const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;

  // Masquer la section dans la navigation ne suffit pas : sans ce controle,
  // l'URL et l'API continuent de servir ces modules a un staff a qui le role
  // interdit la page. La cle de module vaut aussi cle de fonctionnalite ici.
  if (FEATURE_GUARDED_MODULE_KEYS.has(moduleKey)) {
    const featureAccess = await resolveMemberFeatureAccess(client, guildId, _access, user.userId);
    if (!featureAccess[moduleKey]?.canView) {
      json(res, 403, { error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.' });
      return true;
    }
  }

  // Economy & RPG module routes
  if (moduleKey === 'economy') {
    const { handleEconomyRoutes } = await import('./economy.js');
    return handleEconomyRoutes(req, res, parts, client, user, guildId, _access);
  }

  // 1. LEVELING MODULE ROUTES
  if (moduleKey === 'leveling') {
    // GET /api/dashboard/guilds/:guildId/leveling
    if (parts.length === 5 && method === 'GET') {
      try {
        const config = await getOrCreateLevelConfig(guildId);
        const rewards = await prisma.levelRoleReward.findMany({
          where: { guildId },
          orderBy: { level: 'asc' },
        });
        // Les compteurs du classement sortent de la base, qui les tient déjà :
        // les recalculer membre par membre dans le navigateur revenait à
        // reparcourir toute la guilde à chaque affichage.
        const totals = await prismaRead.memberLevel.aggregate({
          where: { guildId },
          _count: { _all: true },
          _sum: { xp: true },
          _avg: { level: true },
          _max: { level: true },
        });
        const stats = {
          memberCount: totals._count._all,
          totalXp: totals._sum.xp ?? 0,
          avgLevel: Math.round(totals._avg.level ?? 0),
          maxLevel: totals._max.level ?? 0,
        };

        json(res, 200, { config, rewards, stats });
      } catch (err) {
        logger.error('LevelingAPI', 'Error fetching leveling data:', err);
        json(res, 500, { error: 'Erreur lors de la récupération du leveling' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/leveling/leaderboard (Page de classement)
    if (parts.length === 6 && parts[5] === 'leaderboard' && method === 'GET') {
      try {
        const search = (url.searchParams.get('search') ?? '').trim();
        const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));

        // La recherche part sur les profils, seul endroit où les pseudos sont
        // stockés : `MemberLevel` ne connaît que des identifiants. Le plafond
        // borne la liste d'identifiants remise à la requête suivante.
        const matchedUserIds = search
          ? await resolveSearchedUserIds(guildId, search, LEADERBOARD_SEARCH_LIMIT)
          : null;

        const where = matchedUserIds ? { guildId, userId: { in: matchedUserIds } } : { guildId };
        const total = await prismaRead.memberLevel.count({ where });
        const pageCount = Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE));
        const currentPage = Math.min(page, pageCount);
        const skip = (currentPage - 1) * LEADERBOARD_PAGE_SIZE;

        // `userId` départage les ex aequo : sans second critère, deux pages
        // successives peuvent renvoyer deux fois la même ligne et en omettre
        // une autre, l'ordre entre lignes de même XP n'étant pas garanti.
        const pageRows = await prismaRead.memberLevel.findMany({
          where,
          orderBy: [{ xp: 'desc' }, { userId: 'asc' }],
          skip,
          take: LEADERBOARD_PAGE_SIZE,
        });

        // Filet contre les lignes en double d'un même membre : la page les
        // affiche par identifiant et deux lignes identiques la feraient tomber
        // entière. La plus fournie gagne, comme au recalcul des niveaux.
        const rowByUser = new Map<string, (typeof pageRows)[number]>();
        for (const row of pageRows) {
          const kept = rowByUser.get(row.userId);
          if (!kept || row.xp > kept.xp) rowByUser.set(row.userId, row);
        }
        const rows = [...rowByUser.values()];

        // Hors recherche, le rang est la position dans le tri : la base l'a déjà
        // donné. Filtré, il faut le compter, mais seulement pour les lignes
        // affichées.
        const ranks = matchedUserIds
          ? await Promise.all(rows.map((row) => prismaRead.memberLevel
              .count({ where: { guildId, xp: { gt: row.xp } } })
              .then((higher) => higher + 1)))
          : rows.map((_, index) => skip + index + 1);

        const members = await withMemberIdentity(guildId, client, rows);

        json(res, 200, {
          rows: members.map((member, index) => ({ ...member, rank: ranks[index] })),
          total,
          page: currentPage,
          pageCount,
          pageSize: LEADERBOARD_PAGE_SIZE,
          searchLimited: matchedUserIds !== null && matchedUserIds.length >= LEADERBOARD_SEARCH_LIMIT,
        });
      } catch (err) {
        logger.error('LevelingAPI', 'Error fetching leaderboard page:', err);
        json(res, 500, { error: 'Erreur lors de la récupération du classement' });
      }
      return true;
    }

    // GET|POST /api/dashboard/guilds/:guildId/leveling/role-resync (Rangement des rôles)
    if (parts.length === 6 && parts[5] === 'role-resync') {
      if (method === 'GET') {
        json(res, 200, getRoleResyncStatus(guildId));
        return true;
      }

      if (method === 'POST') {
        const body = await readJsonBody<{ stop?: boolean }>(req);
        if (body?.stop) {
          const stopped = stopRoleResync(guildId);
          json(res, 200, { stopped, ...getRoleResyncStatus(guildId) });
          return true;
        }

        const started = startRoleResync(guildId, client);
        if (started.started) {
          await pushAudit(guildId, {
            user: auditUser,
            action: 'Rangement des rôles de niveau',
            context: getGuildName(client, guildId),
            module: 'Leveling',
            eventType: 'Manuel',
            details: `${started.pending} membres à revoir`,
            channelId: null,
          });
        }
        json(res, 200, { ...started, ...getRoleResyncStatus(guildId) });
        return true;
      }
    }

    // GET /api/dashboard/guilds/:guildId/leveling/curve-impact (Effet d'une courbe)
    if (parts.length === 6 && parts[5] === 'curve-impact' && method === 'GET') {
      try {
        const curve = normalizeLevelCurve({
          baseXp: Number(url.searchParams.get('baseXp')),
          linearXp: Number(url.searchParams.get('linearXp')),
          exponent: Number(url.searchParams.get('exponent')),
          maxLevel: Number(url.searchParams.get('maxLevel')),
        });
        json(res, 200, await countCurveImpact(guildId, curve));
      } catch (err) {
        logger.error('LevelingAPI', 'Error counting curve impact:', err);
        json(res, 500, { error: "Erreur lors du calcul de l'effet de la courbe" });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/leveling/level-up-channel (Créer le salon d'annonce)
    if (parts.length === 6 && parts[5] === 'level-up-channel' && method === 'POST') {
      if (!_access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions insuffisantes.' });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur Discord introuvable.' });
        return true;
      }

      const lockKey = `leveling-channel:${guildId}`;
      if (!acquireProvisionLock(lockKey)) {
        json(res, 409, { error: 'Une création de salon est déjà en cours sur ce serveur.' });
        return true;
      }

      try {
        const cooldown = await provisionCooldown(lockKey);
        if (cooldown) {
          json(res, 429, { error: provisionCooldownMessage(cooldown, 'Le salon a déjà été créé') });
          return true;
        }

        const missing = await missingProvisionPermissions(discordGuild, [PermissionFlagsBits.ManageChannels]);
        if (missing.length > 0) {
          json(res, 400, { error: `Le bot n'a pas les permissions nécessaires : ${missing.join(', ')}.` });
          return true;
        }

        // Nom dans la langue du serveur : le salon est lu par ses membres, pas
        // par l'admin qui clique depuis le dashboard.
        const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);

        // `levelUpChannelId` porte aussi des valeurs qui ne sont pas des salons
        // (vide pour le salon d'origine, `DM` pour le message privé) : seul un
        // identifiant de salon vivant est repris, le reste part sur une création.
        const config = await getOrCreateLevelConfig(guildId);
        const existingId = config.levelUpChannelId && config.levelUpChannelId !== 'DM'
          ? config.levelUpChannelId
          : null;

        // Le refus d'ecriture vaut aussi pour le bot : sans surcharge a son nom,
        // il ne pourrait pas annoncer les niveaux dans le salon qu'il vient de
        // creer, sauf a etre administrateur du serveur.
        const botId = discordGuild.members.me?.id;

        const { channel, entry } = await ensureTextChannel(discordGuild, {
          key: 'levelUpChannel',
          existingId,
          name: m.setup_channel_leveling({}, { locale }),
          permissionOverwrites: [
            {
              id: discordGuild.roles.everyone.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny: [PermissionFlagsBits.SendMessages],
            },
            ...(botId
              ? [{
                  id: botId,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.EmbedLinks,
                  ]
                }]
              : []),
          ],
          reason: m.setup_reason_leveling({ user: auditUser }, { locale }),
        });

        // Ecrit tout de suite : un salon cree que la page n'enregistrerait pas
        // resterait sur le serveur sans que rien n'y renvoie.
        // Le message est depose en meme temps quand l'admin n'en a pas ecrit :
        // la mise en route doit laisser un texte visible et modifiable, pas un
        // champ vide dont on ne devine pas ce qu'il produira. Sans creation,
        // rien n'est ecrit et la page recoit la valeur inchangee.
        const levelUpMessage = entry.created
          ? (config.levelUpMessage?.trim() || defaultLevelUpMessage(locale))
          : config.levelUpMessage;

        if (entry.created) {
          await prisma.levelConfig.update({
            where: { guildId },
            data: { levelUpChannelId: channel.id, levelUpMessage },
          });
          invalidateLevelConfigCache(guildId);
          await startProvisionCooldown(lockKey, user.username ?? 'Utilisateur');

          await pushAudit(guildId, {
            user: auditUser,
            action: "Création du salon d'annonce des niveaux",
            context: getGuildName(client, guildId),
            module: 'Leveling',
            eventType: 'Manuel',
            details: `Salon créé : #${channel.name}`,
            channelId: channel.id,
          });
        }

        json(res, 200, { channelId: channel.id, name: channel.name, created: entry.created, levelUpMessage });
      } catch (err) {
        logger.error('LevelingAPI', 'Error creating level-up channel:', err);
        json(res, 500, { error: "Erreur lors de la création du salon d'annonce" });
      } finally {
        releaseProvisionLock(lockKey);
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/leveling (Mise à jour config)
    if (parts.length === 5 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          enabled?: boolean;
          xpMin?: number;
          xpMax?: number;
          cooldownSeconds?: number;
          vocalXpPerMin?: number;
          levelUpChannelId?: string | null;
          levelUpMessage?: string;
          stackRewards?: boolean;
          ignoredChannels?: string[];
          ignoredRoles?: string[];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          xpMultipliers?: any;
          lengthBonusEnabled?: boolean;
          lengthBonusThreshold?: number;
          lengthBonusMaxMultiplier?: number;
          curveBaseXp?: number;
          curveLinearXp?: number;
          curveExponent?: number;
          maxLevel?: number;
          voiceRequireUnmuted?: boolean;
          voiceRequireUndeafened?: boolean;
          voiceIgnoreAfkChannel?: boolean;
          voiceMinMembers?: number;
          dailyXpCap?: number;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        const previousConfig = await getOrCreateLevelConfig(guildId).catch(() => null);

        // Les valeurs absentes du corps reprennent le défaut de la courbe, mais
        // ne sont réinjectées dans l'`update` que si le client les a envoyées :
        // un PATCH partiel ne doit pas réinitialiser la courbe de la guilde.
        const curve = normalizeLevelCurve({
          baseXp: body.curveBaseXp,
          linearXp: body.curveLinearXp,
          exponent: body.curveExponent,
          maxLevel: body.maxLevel,
        });

        const config = await prisma.levelConfig.update({
          where: { guildId },
          data: {
            enabled: body.enabled,
            xpMin: body.xpMin,
            xpMax: body.xpMax,
            cooldownSeconds: body.cooldownSeconds,
            vocalXpPerMin: body.vocalXpPerMin,
            levelUpChannelId: body.levelUpChannelId,
            levelUpMessage: body.levelUpMessage,
            stackRewards: body.stackRewards,
            ignoredChannels: body.ignoredChannels,
            ignoredRoles: body.ignoredRoles,
            xpMultipliers: body.xpMultipliers,
            lengthBonusEnabled: body.lengthBonusEnabled,
            lengthBonusThreshold: body.lengthBonusThreshold !== undefined
              ? Math.max(1, Math.floor(body.lengthBonusThreshold))
              : undefined,
            lengthBonusMaxMultiplier: body.lengthBonusMaxMultiplier !== undefined
              ? Math.min(10, Math.max(1, body.lengthBonusMaxMultiplier))
              : undefined,
            // `!= null` et non `!== undefined` : un champ numérique vidé dans le
            // dashboard arrive à null, et le borner reviendrait à écrire la
            // valeur minimale au lieu de laisser le réglage en place.
            curveBaseXp: body.curveBaseXp != null ? curve.baseXp : undefined,
            curveLinearXp: body.curveLinearXp != null ? curve.linearXp : undefined,
            curveExponent: body.curveExponent != null ? curve.exponent : undefined,
            maxLevel: body.maxLevel != null ? curve.maxLevel : undefined,
            voiceRequireUnmuted: body.voiceRequireUnmuted,
            voiceRequireUndeafened: body.voiceRequireUndeafened,
            voiceIgnoreAfkChannel: body.voiceIgnoreAfkChannel,
            voiceMinMembers: body.voiceMinMembers != null
              ? Math.min(25, Math.max(1, Math.floor(body.voiceMinMembers)))
              : undefined,
            dailyXpCap: body.dailyXpCap != null
              ? Math.min(1_000_000, Math.max(0, Math.floor(body.dailyXpCap)))
              : undefined,
          },
        });

        await invalidateLevelConfigCache(guildId);

        // Un changement de courbe redistribue les niveaux : la colonne `level`
        // est réalignée tout de suite, sinon les membres inactifs la gardent
        // périmée jusqu'à leur prochain gain d'XP.
        const curveChanged = !previousConfig
          || previousConfig.curveBaseXp !== config.curveBaseXp
          || previousConfig.curveLinearXp !== config.curveLinearXp
          || previousConfig.curveExponent !== config.curveExponent
          || previousConfig.maxLevel !== config.maxLevel;

        // `null` distingue l'échec du réalignement de l'absence de réalignement :
        // le dashboard annonce un chiffre avant l'enregistrement, il ne doit pas
        // confirmer « 0 niveau réaligné » quand la requête a en fait échoué.
        let resynced: number | null = 0;
        if (curveChanged) {
          // `client` : le réalignement enchaîne sur une passe de rôles, sans
          // laquelle les récompenses resteraient sur l'ancienne courbe.
          resynced = await resyncGuildLevels(guildId, levelCurveFromConfig(config), { client })
            .catch((err) => {
              logger.error('LevelingAPI', `Réalignement des niveaux échoué pour ${guildId}:`, err);
              return null;
            });
          if (resynced && resynced > 0) {
            logger.info('LevelingAPI', `Courbe modifiée sur ${guildId} : ${resynced} niveaux réalignés.`);
          }
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour Leveling',
          context: getGuildName(client, guildId),
          module: 'Leveling',
          eventType: 'Manuel',
          details: `Configuration modifiée. Actif: ${config.enabled}`,
          channelId: null
        });

        json(res, 200, { config, resynced, roleResync: getRoleResyncStatus(guildId) });
      } catch (err) {
        logger.error('LevelingAPI', 'Error updating leveling config:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour du leveling' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/leveling/rewards (Ajouter récompense)
    if (parts.length === 6 && parts[5] === 'rewards' && method === 'POST') {
      try {
        const body = await readJsonBody<{ level: number; roleId: string }>(req);
        if (!body || !body.level || !body.roleId) {
          json(res, 400, { error: 'Niveau et rôle requis' });
          return true;
        }

        const reward = await prisma.levelRoleReward.create({
          data: {
            guildId,
            level: body.level,
            roleId: body.roleId,
          },
        });

        await invalidateLevelRewardsCache(guildId);
        json(res, 200, { reward });
      } catch (err) {
        logger.error('LevelingAPI', 'Error creating reward:', err);
        json(res, 500, { error: 'Erreur lors de la création de la récompense' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/leveling/rewards/:rewardId
    if (parts.length === 7 && parts[5] === 'rewards' && method === 'DELETE') {
      const rewardId = parts[6];
      try {
        await prisma.levelRoleReward.delete({
          where: { id: rewardId },
        });
        await invalidateLevelRewardsCache(guildId);
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('LevelingAPI', 'Error deleting reward:', err);
        json(res, 500, { error: 'Erreur lors de la suppression de la récompense' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/leveling/import
    if (parts.length === 6 && parts[5] === 'import' && method === 'POST') {
      try {
        const body = await readJsonBody<Record<string, unknown>>(req);
        if (!body || !Array.isArray(body)) {
          json(res, 400, { error: "Le corps de la requête doit être un tableau d'utilisateurs." });
          return true;
        }

        // L'import écrase l'XP des membres reconnus : en mode analyse, tout est
        // calculé et rapporté à l'identique mais rien n'est écrit, pour qu'un
        // pseudo non reconnu se découvre avant l'écrasement et non après.
        const dryRun = url.searchParams.get('dry_run') === '1';

        const validItems: Array<{
          username?: string;
          displayName?: string;
          level?: number;
          xp?: number;
        }> = [];

        const failedMembers: Array<{
          username?: string;
          display_name?: string;
          reason: string;
        }> = [];

        for (const item of body) {
          if (!item || typeof item !== 'object') {
            failedMembers.push({ reason: "Format invalide (doit être un objet)" });
            continue;
          }

          const rawItem = item as Record<string, unknown>;
          const username = rawItem.username;
          const displayName = rawItem.display_name || rawItem.displayName;
          const level = typeof rawItem.level === 'number' ? rawItem.level : (typeof rawItem.level === 'string' ? parseInt(rawItem.level as string, 10) : NaN);
          const xp = typeof rawItem.xp === 'number' ? rawItem.xp : (typeof rawItem.xp === 'string' ? parseInt(rawItem.xp as string, 10) : NaN);

          if (!username && !displayName) {
            failedMembers.push({ reason: "Nom d'utilisateur ou pseudo manquant" });
            continue;
          }

          if (isNaN(level) && isNaN(xp)) {
            failedMembers.push({
              username: username ? String(username) : undefined,
              display_name: displayName ? String(displayName) : undefined,
              reason: "Niveau ou XP invalide/manquant"
            });
            continue;
          }

          validItems.push({
            username: username ? String(username) : undefined,
            displayName: displayName ? String(displayName) : undefined,
            level: isNaN(level) ? undefined : level,
            xp: isNaN(xp) ? undefined : xp
          });
        }

        const dbProfiles = await prisma.memberProfile.findMany({
          where: { guildId }
        });

        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const discordMembers = discordGuild ? await fetchAllMembers(discordGuild).catch(() => new Map()) : new Map();

        const identityMap = new Map<string, string>();

        const normalize = (str: string) => {
          return str.toLowerCase().replace(/^@/, '').trim();
        };

        for (const p of dbProfiles) {
          if (p.userId) {
            if (p.username) identityMap.set(normalize(p.username), p.userId);
            if (p.displayName) identityMap.set(normalize(p.displayName), p.userId);
            if (p.globalName) identityMap.set(normalize(p.globalName), p.userId);
            if (p.userTag) identityMap.set(normalize(p.userTag), p.userId);
          }
        }

        if (discordMembers.size > 0) {
          for (const [id, member] of discordMembers) {
            identityMap.set(normalize(member.user.username), id);
            if (member.nickname) identityMap.set(normalize(member.nickname), id);
            identityMap.set(normalize(member.displayName), id);
            identityMap.set(normalize(member.user.tag), id);
          }
        }

        const importedSuccessfully: Array<{ userId: string; level: number; xp: number }> = [];
        const importCurve = await getGuildLevelCurve(guildId);

        for (const item of validItems) {
          let userId: string | undefined;

          if (item.username) {
            userId = identityMap.get(normalize(item.username));
          }
          if (!userId && item.displayName) {
            userId = identityMap.get(normalize(item.displayName));
          }

          if (!userId) {
            failedMembers.push({
              username: item.username,
              display_name: item.displayName,
              reason: "Membre introuvable sur le serveur Discord"
            });
            continue;
          }

          let xp = item.xp;
          let level = item.level;

          // Si seul le niveau est fourni, on déduit l'XP minimale de ce niveau.
          if (xp === undefined && level !== undefined) {
            xp = getXpForLevel(Math.max(0, level) - 1, importCurve);
          }

          // L'XP est la source de vérité : on la ramène dans les bornes stockables
          // et on recalcule toujours le niveau, pour ne jamais stocker de couple
          // incohérent (ex. niveau importé d'un autre bot avec une autre courbe).
          // Sans le plafond, une ligne aberrante du fichier importé fait échouer
          // tout l'import sur un débordement de la colonne.
          if (xp !== undefined) {
            xp = clampXp(xp);
            level = getLevelFromXp(xp, importCurve);
          }

          if (xp === undefined || level === undefined) {
            failedMembers.push({
              username: item.username,
              display_name: item.displayName,
              reason: "Valeur de niveau/XP invalide"
            });
            continue;
          }

          importedSuccessfully.push({ userId, level, xp });
        }

        // Ce que l'import va remplacer, mesuré avant d'écrire : sans ça, un
        // classement importé depuis un autre bot écrase des niveaux plus hauts
        // et personne ne s'en aperçoit.
        // Par paquets : un fichier d'import peut couvrir toute la guilde, et un
        // `IN` de plusieurs dizaines de milliers d'identifiants dépasse ce que
        // Postgres accepte de paramètres liés.
        const currentByUser = new Map<string, { xp: number; level: number }>();
        for (let start = 0; start < importedSuccessfully.length; start += 1000) {
          const userIds = importedSuccessfully.slice(start, start + 1000).map((record) => record.userId);
          const rows = await prisma.memberLevel.findMany({
            where: { guildId, userId: { in: userIds } },
            select: { userId: true, xp: true, level: true },
          });
          for (const row of rows) currentByUser.set(row.userId, { xp: row.xp, level: row.level });
        }

        let createdCount = 0;
        let levelChangeCount = 0;
        let xpLoweredCount = 0;
        for (const record of importedSuccessfully) {
          const existing = currentByUser.get(record.userId);
          if (!existing) {
            createdCount++;
            continue;
          }
          if (existing.level !== record.level) levelChangeCount++;
          if (record.xp < existing.xp) xpLoweredCount++;
        }

        const report = {
          success: true,
          dryRun,
          importedCount: importedSuccessfully.length,
          failedCount: failedMembers.length,
          failedMembers,
          createdCount,
          levelChangeCount,
          xpLoweredCount,
        };

        if (dryRun) {
          json(res, 200, report);
          return true;
        }

        for (const record of importedSuccessfully) {
          await prisma.memberLevel.upsert({
            where: { guildId_userId: { guildId, userId: record.userId } },
            update: {
              xp: record.xp,
              level: record.level,
              lastXpGain: new Date()
            },
            create: {
              guildId,
              userId: record.userId,
              xp: record.xp,
              level: record.level,
              lastXpGain: new Date()
            }
          });
        }

        if (importedSuccessfully.length > 0) {
          (async () => {
            for (const record of importedSuccessfully) {
              await updateMemberLevelRoles(guildId, record.userId, record.level, client).catch(() => {});
              await new Promise(resolve => setTimeout(resolve, 250));
            }
          })().catch(err => {
            logger.error('LevelingAPI', 'Error updating roles in background:', err);
          });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Import de classement',
          context: getGuildName(client, guildId),
          module: 'Leveling',
          eventType: 'Manuel',
          details: `Importation réussie de ${importedSuccessfully.length} membres (échec: ${failedMembers.length})`,
          channelId: null
        });

        json(res, 200, report);
      } catch (err) {
        logger.error('LevelingAPI', 'Error during leveling import:', err);
        json(res, 500, { error: "Erreur lors de l'importation des données" });
      }
      return true;
    }

  }

  // 2. GIVEAWAYS MODULE ROUTES
  if (moduleKey === 'giveaways') {
    // Les écritures sont ouvertes aux rôles gestionnaires déclarés dans
    // l'onglet Configuration : le garde-fou global de dashboard.ts les laisse
    // passer, c'est ici qu'on tranche. Le réglage de ces rôles (`/config`)
    // reste réservé aux administrateurs du dashboard.
    if (method !== 'GET' && parts[5] !== 'config' && !_access.canManageSettings) {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
      if (!(await canManageGiveaways(member, guildId))) {
        json(res, 403, { error: 'Gestion des giveaways non autorisée.' });
        return true;
      }
    }

    // GET /api/dashboard/guilds/:guildId/giveaways/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
      try {
        json(res, 200, { config: await getGiveawayConfig(guildId) });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error fetching giveaway config:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/giveaways/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'PUT') {
      try {
        const body = await readJsonBody<{
          managerRoleIds?: unknown;
          requiredRoleIds?: unknown;
          blockedRoleIds?: unknown;
        }>(req);

        if (!body || typeof body !== 'object') {
          json(res, 400, { error: 'Corps de requête invalide' });
          return true;
        }

        const config = await updateGiveawayConfig(guildId, {
          managerRoleIds: normalizeRoleIds(body.managerRoleIds),
          requiredRoleIds: normalizeRoleIds(body.requiredRoleIds),
          blockedRoleIds: normalizeRoleIds(body.blockedRoleIds),
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Configuration des giveaways',
          context: getGuildName(client, guildId),
          module: 'Giveaways',
          eventType: 'Manuel',
          details: `Gestionnaires : ${config.managerRoleIds.length} rôle(s), participation : ${config.requiredRoleIds.length} rôle(s) requis, ${config.blockedRoleIds.length} rôle(s) exclu(s)`,
          channelId: null,
        });

        json(res, 200, { config });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error updating giveaway config:', err);
        json(res, 500, { error: 'Erreur lors de l\'enregistrement de la configuration' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/giveaways
    if (parts.length === 5 && method === 'GET') {
      try {
        const giveaways = await prisma.giveaway.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
        });

        // Gagnants et auteur sont stockés en identifiants Discord : sans les
        // résoudre, la page n'affiche qu'une suite de nombres impossible à
        // rattacher à quelqu'un.
        const userIds = [...new Set(giveaways.flatMap((giveaway) => [
          ...giveaway.winners,
          ...giveaway.pendingWinners,
          ...(giveaway.createdById ? [giveaway.createdById] : []),
        ]))];
        const identities = await withMemberIdentity(guildId, client, userIds.map((userId) => ({ userId })));
        const identityById = new Map(identities.map((entry) => [entry.userId, entry]));
        const profileOf = (userId: string) =>
          identityById.get(userId)
          ?? { userId, username: null, displayName: `Utilisateur ${userId}`, avatarUrl: null };

        // Les rôles gestionnaires de l'onglet Configuration ouvrent les actions
        // sans droit d'administration du dashboard. La page doit le savoir pour
        // afficher les boutons : sinon l'autorisation accordée reste invisible,
        // alors que l'API l'accepterait.
        let canManage = _access.canManageSettings;
        if (!canManage) {
          const discordGuild = client.guilds.cache.get(guildId)
            || await client.guilds.fetch(guildId).catch(() => null);
          const member = discordGuild
            ? await discordGuild.members.fetch(user.userId).catch(() => null)
            : null;
          canManage = await canManageGiveaways(member, guildId);
        }

        json(res, 200, {
          canManage,
          giveaways: giveaways.map((giveaway) => ({
            ...giveaway,
            creatorProfile: giveaway.createdById ? profileOf(giveaway.createdById) : null,
            winnerProfiles: giveaway.winners.map(profileOf),
            pendingWinnerProfiles: giveaway.pendingWinners.map(profileOf),
          })),
        });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error fetching giveaways:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des giveaways' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/giveaways (Créer)
    if (parts.length === 5 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          prize: string;
          winnerCount: number;
          durationMinutes: number;
          description?: string;
          channelId: string;
        }>(req);

        if (
          !body
          || typeof body.prize !== 'string'
          || typeof body.channelId !== 'string'
          || typeof body.winnerCount !== 'number'
          || typeof body.durationMinutes !== 'number'
        ) {
          json(res, 400, { error: 'Champs obligatoires manquants' });
          return true;
        }
        if (!/^\d{17,20}$/.test(body.channelId)) {
          json(res, 400, { error: 'Salon Discord invalide' });
          return true;
        }

        const giveaway = await createGiveaway(
          client,
          guildId,
          body.channelId,
          body.prize,
          body.winnerCount,
          body.durationMinutes,
          body.description,
          0,
          0,
          null,
          false,
          user.userId
        );

        // Même forme que le GET : la page insère le concours en tête de liste
        // sans recharger, il doit donc porter les mêmes champs.
        const [creatorProfile] = await withMemberIdentity(guildId, client, [{ userId: user.userId }]);
        json(res, 200, {
          giveaway: { ...giveaway, creatorProfile, winnerProfiles: [], pendingWinnerProfiles: [] },
        });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error creating giveaway:', err);
        json(res, err instanceof Error && err.message.includes('serveur staff') ? 400 : 500, {
          error: err instanceof Error ? err.message : 'Erreur lors de la création du giveaway',
        });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/giveaways/:giveawayId/end (Forcer fin)
    if (parts.length === 7 && parts[6] === 'end' && method === 'POST') {
      const giveawayId = parts[5];
      try {
        const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } });
        if (!giveaway) {
          json(res, 404, { error: 'Giveaway introuvable sur ce serveur' });
          return true;
        }
        if (giveaway.ended) {
          json(res, 409, { error: 'Ce giveaway est déjà terminé' });
          return true;
        }
        await endGiveaway(client, giveawayId, guildId);
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error ending giveaway:', err);
        json(res, 500, { error: 'Erreur lors de la clôture du giveaway' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/giveaways/:giveawayId/reroll (Reroll)
    if (parts.length === 7 && parts[6] === 'reroll' && method === 'POST') {
      const giveawayId = parts[5];
      try {
        const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } });
        if (!giveaway) {
          json(res, 404, { error: 'Giveaway introuvable sur ce serveur' });
          return true;
        }
        if (!giveaway.ended) {
          json(res, 409, { error: 'Le giveaway doit être terminé avant un reroll' });
          return true;
        }
        await rerollGiveaway(client, giveawayId, guildId);
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error rerolling giveaway:', err);
        json(res, 500, { error: 'Erreur lors du reroll' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/giveaways/:giveawayId
    if (parts.length === 6 && method === 'DELETE') {
      const giveawayId = parts[5];
      try {
        const deleted = await prisma.giveaway.deleteMany({
          where: { id: giveawayId, guildId },
        });
        if (deleted.count === 0) {
          json(res, 404, { error: 'Giveaway introuvable sur ce serveur' });
          return true;
        }
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('GiveawaysAPI', 'Error deleting giveaway:', err);
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }
  }

  // 3. WELCOME & GOODBYE / ANNOUNCEMENT ROUTES
  if (moduleKey === 'announcement' || moduleKey === 'welcome') {
    // POST /api/dashboard/guilds/:guildId/announcement/autorole-rescan
    // Passe tous les membres en revue : sans ça, activer l'auto-rôle ne produit
    // rien tant qu'un membre ne modifie pas son tag ou son statut.
    if (parts.length === 6 && parts[5] === 'autorole-rescan' && method === 'POST') {
      try {
        const { rescanGuildAutoRoles } = await import('../../../services/features/serverTagRoleService.js');
        const result = await rescanGuildAutoRoles(client, guildId);
        if (!result) {
          json(res, 400, { error: 'Aucun auto-rôle d\'identité actif sur ce serveur.' });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Rescan des auto-rôles d\'identité',
          context: getGuildName(client, guildId),
          module: 'Announcement',
          eventType: 'Manuel',
          details: `${result.scanned} membre(s) analysé(s), ${result.changed} mise(s) à jour de rôle.`,
          channelId: null,
        });

        json(res, 200, { ok: true, ...result });
      } catch (err) {
        logger.error('WelcomeGoodbyeAPI', 'Error rescanning auto roles:', err);
        json(res, 500, { error: 'Erreur lors du rescan des auto-rôles' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/announcement (or /welcome)
    if (parts.length === 5 && method === 'GET') {
      try {
        const config = await getOrCreateWelcomeConfig(guildId);
        json(res, 200, { config });
      } catch (err) {
        logger.error('WelcomeGoodbyeAPI', 'Error fetching welcome config:', err);
        json(res, 500, { error: 'Erreur config accueil' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/announcement (or /welcome)
    if (parts.length === 5 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          welcomeEnabled?: boolean;
          welcomeChannelId?: string | null;
          welcomeMessage?: string;
          welcomeImageEnabled?: boolean;
          welcomeImageUrl?: string | null;
          leaveEnabled?: boolean;
          leaveChannelId?: string | null;
          leaveMessage?: string;
          boostEnabled?: boolean;
          boostChannelId?: string | null;
          boostMessage?: string;
          boostImageEnabled?: boolean;
          boostImageUrl?: string | null;
          joinRoleId?: string | null;
          tagAutoRoleEnabled?: boolean;
          tagAutoRoleId?: string | null;
          statusScanEnabled?: boolean;
          statusScanKeyword?: string;
          statusScanRoleId?: string | null;
          statusScanScope?: string;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        const statusScanScope = ['STATUS', 'ACTIVITY', 'BOTH'].includes(body.statusScanScope ?? '')
          ? body.statusScanScope
          : undefined;

        const config = await prisma.welcomeConfig.update({
          where: { guildId },
          data: {
            welcomeEnabled: body.welcomeEnabled,
            welcomeChannelId: body.welcomeChannelId,
            welcomeMessage: body.welcomeMessage,
            welcomeImageEnabled: body.welcomeImageEnabled,
            welcomeImageUrl: body.welcomeImageUrl,
            leaveEnabled: body.leaveEnabled,
            leaveChannelId: body.leaveChannelId,
            leaveMessage: body.leaveMessage,
            boostEnabled: body.boostEnabled,
            boostChannelId: body.boostChannelId,
            boostMessage: body.boostMessage,
            boostImageEnabled: body.boostImageEnabled,
            boostImageUrl: body.boostImageUrl,
            joinRoleId: body.joinRoleId,
            tagAutoRoleEnabled: body.tagAutoRoleEnabled,
            tagAutoRoleId: body.tagAutoRoleId,
            statusScanEnabled: body.statusScanEnabled,
            statusScanKeyword: body.statusScanKeyword?.slice(0, 100),
            statusScanRoleId: body.statusScanRoleId,
            statusScanScope,
          },
        });

        // Les listeners d'auto-rôle lisent une config mise en cache 5 min : sans
        // invalidation, la sauvegarde resterait sans effet visible.
        const { invalidateAutoRoleCache } = await import('../../../services/features/serverTagRoleService.js');
        await invalidateAutoRoleCache(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour Annonces/Auto-Rôle',
          context: getGuildName(client, guildId),
          module: 'Announcement',
          eventType: 'Manuel',
          details: `Modifications appliquées. Accueil: ${config.welcomeEnabled}, Départ: ${config.leaveEnabled}, Boost: ${config.boostEnabled}, Tag Auto-Role: ${config.tagAutoRoleEnabled}`,
          channelId: null
        });

        json(res, 200, { config });
      } catch (err) {
        logger.error('WelcomeGoodbyeAPI', 'Error updating welcome config:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la config' });
      }
      return true;
    }
  }

  // 3bis. WELCOME THREAD (accueil personnalisé scénarisé) ROUTES
  if (moduleKey === 'welcome-thread') {
    // GET /api/dashboard/guilds/:guildId/welcome-thread
    if (parts.length === 5 && method === 'GET') {
      try {
        const config = await getOrCreateWelcomeThreadConfig(guildId);
        json(res, 200, { config });
      } catch (err) {
        logger.error('WelcomeThreadAPI', 'Error fetching welcome thread config:', err);
        json(res, 500, { error: "Erreur config thread d'accueil" });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/welcome-thread
    if (parts.length === 5 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          enabled?: boolean;
          channelId?: string | null;
          threadNameTemplate?: string;
          threadMode?: string;
          autoArchiveMinutes?: number;
          typingEnabled?: boolean;
          inactivityDeleteEnabled?: boolean;
          inactivityDeleteHours?: number;
          webhookName?: string;
          webhookAvatarUrl?: string | null;
          menuEnabled?: boolean;
          menuStyle?: string;
          menuPlaceholder?: string;
          embedTitle?: string;
          embedDescription?: string;
          embedColor?: string;
          embedImageUrl?: string | null;
          embedThumbnailUrl?: string | null;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        if (body.threadMode !== undefined && body.threadMode !== 'public' && body.threadMode !== 'private') {
          json(res, 400, { error: "threadMode doit être 'public' ou 'private'" });
          return true;
        }
        if (body.menuStyle !== undefined && body.menuStyle !== 'buttons' && body.menuStyle !== 'select') {
          json(res, 400, { error: "menuStyle doit être 'buttons' ou 'select'" });
          return true;
        }
        if (body.autoArchiveMinutes !== undefined && ![60, 1440, 4320, 10080].includes(body.autoArchiveMinutes)) {
          json(res, 400, { error: 'autoArchiveMinutes doit être 60, 1440, 4320 ou 10080' });
          return true;
        }
        if (body.inactivityDeleteHours !== undefined && (
          !Number.isInteger(body.inactivityDeleteHours)
          || body.inactivityDeleteHours < MIN_INACTIVITY_DELETE_HOURS
          || body.inactivityDeleteHours > MAX_INACTIVITY_DELETE_HOURS
        )) {
          json(res, 400, { error: `inactivityDeleteHours doit être un entier entre ${MIN_INACTIVITY_DELETE_HOURS} et ${MAX_INACTIVITY_DELETE_HOURS}` });
          return true;
        }

        await getOrCreateWelcomeThreadConfig(guildId);
        const config = await prisma.welcomeThreadConfig.update({
          where: { guildId },
          data: {
            enabled: body.enabled,
            channelId: body.channelId,
            threadNameTemplate: body.threadNameTemplate,
            threadMode: body.threadMode,
            autoArchiveMinutes: body.autoArchiveMinutes,
            typingEnabled: body.typingEnabled,
            inactivityDeleteEnabled: body.inactivityDeleteEnabled,
            inactivityDeleteHours: body.inactivityDeleteHours,
            webhookName: body.webhookName,
            webhookAvatarUrl: body.webhookAvatarUrl,
            menuEnabled: body.menuEnabled,
            menuStyle: body.menuStyle,
            menuPlaceholder: body.menuPlaceholder,
            embedTitle: body.embedTitle,
            embedDescription: body.embedDescription,
            embedColor: body.embedColor,
            embedImageUrl: body.embedImageUrl,
            embedThumbnailUrl: body.embedThumbnailUrl,
          },
          include: { steps: { orderBy: { order: 'asc' } }, pages: { orderBy: { order: 'asc' } } },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: "Mise à jour Thread d'accueil",
          context: getGuildName(client, guildId),
          module: 'WelcomeThread',
          eventType: 'Manuel',
          details: `Config mise à jour. Activé: ${config.enabled}, Salon: ${config.channelId ?? 'aucun'}, Menu: ${config.menuStyle}`,
          channelId: config.channelId,
        });

        json(res, 200, { config });
      } catch (err) {
        logger.error('WelcomeThreadAPI', 'Error updating welcome thread config:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la config' });
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/welcome-thread/steps (remplace la séquence complète)
    if (parts.length === 6 && parts[5] === 'steps' && method === 'PUT') {
      try {
        const body = await readJsonBody<{
          steps: Array<{ content: string; name?: string | null; avatarUrl?: string | null; delayMs?: number }>;
        }>(req);

        if (!body || !Array.isArray(body.steps)) {
          json(res, 400, { error: 'Corps de requête invalide (steps attendu)' });
          return true;
        }
        if (body.steps.length > MAX_THREAD_STEPS) {
          json(res, 400, { error: `Maximum ${MAX_THREAD_STEPS} messages dans la séquence` });
          return true;
        }
        if (body.steps.some((s) => !s.content?.trim())) {
          json(res, 400, { error: 'Chaque message doit avoir un contenu' });
          return true;
        }

        await getOrCreateWelcomeThreadConfig(guildId);
        await prisma.$transaction([
          prisma.welcomeThreadStep.deleteMany({ where: { guildId } }),
          prisma.welcomeThreadStep.createMany({
            data: body.steps.map((step, index) => ({
              guildId,
              order: index,
              content: step.content.trim().slice(0, 2000),
              name: step.name?.trim() || null,
              avatarUrl: step.avatarUrl?.trim() || null,
              delayMs: clampStepDelay(step.delayMs ?? 3000),
            })),
          }),
        ]);

        const config = await getOrCreateWelcomeThreadConfig(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: "Mise à jour séquence Thread d'accueil",
          context: getGuildName(client, guildId),
          module: 'WelcomeThread',
          eventType: 'Manuel',
          details: `Séquence remplacée : ${config.steps.length} message(s)`,
          channelId: config.channelId,
        });

        json(res, 200, { config });
      } catch (err) {
        logger.error('WelcomeThreadAPI', 'Error updating welcome thread steps:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la séquence' });
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/welcome-thread/pages (remplace les pages du menu)
    if (parts.length === 6 && parts[5] === 'pages' && method === 'PUT') {
      try {
        const body = await readJsonBody<{
          pages: Array<{
            label: string;
            emoji?: string | null;
            summary?: string | null;
            actionType?: string;
            roleId?: string | null;
            roleAction?: string;
            roleGroup?: string | null;
            linkUrl?: string | null;
            embedTitle?: string;
            embedDescription?: string;
            embedColor?: string;
            embedImageUrl?: string | null;
            embedThumbnailUrl?: string | null;
          }>;
        }>(req);

        if (!body || !Array.isArray(body.pages)) {
          json(res, 400, { error: 'Corps de requête invalide (pages attendu)' });
          return true;
        }
        if (body.pages.length > 25) {
          json(res, 400, { error: 'Maximum 25 pages de présentation' });
          return true;
        }

        const VALID_ACTION_TYPES = new Set(['EMBED', 'ROLE', 'LINK']);
        const VALID_ROLE_ACTIONS = new Set(['ADD', 'REMOVE', 'TOGGLE', 'EXCLUSIVE']);
        const exclusiveGroups = new Map<string, { label: string; roleIds: Set<string> }>();
        const exclusiveRoleGroups = new Map<string, string>();

        for (const page of body.pages) {
          if (!page.label?.trim()) {
            json(res, 400, { error: 'Chaque page doit avoir un label' });
            return true;
          }
          const actionType = page.actionType && VALID_ACTION_TYPES.has(page.actionType) ? page.actionType : 'EMBED';
          if (actionType === 'EMBED' && (!page.embedTitle?.trim() || !page.embedDescription?.trim())) {
            json(res, 400, { error: 'Les pages de type Embed doivent avoir un titre et une description' });
            return true;
          }
          if (actionType === 'ROLE' && !page.roleId) {
            json(res, 400, { error: 'Les pages de type Rôle doivent avoir un rôle sélectionné' });
            return true;
          }
          if (actionType === 'ROLE' && page.roleAction === 'EXCLUSIVE') {
            const groupLabel = page.roleGroup?.trim().replace(/\s+/g, ' ') || '';
            if (!groupLabel) {
              json(res, 400, { error: 'Les rôles exclusifs doivent appartenir à un groupe' });
              return true;
            }
            if (groupLabel.length > 64) {
              json(res, 400, { error: 'Le nom du groupe exclusif est limité à 64 caractères' });
              return true;
            }

            const groupKey = groupLabel.toLocaleLowerCase('fr-FR');
            const existingRoleGroup = exclusiveRoleGroups.get(page.roleId!);
            if (existingRoleGroup && existingRoleGroup !== groupKey) {
              json(res, 400, { error: 'Un même rôle ne peut pas appartenir à plusieurs groupes exclusifs' });
              return true;
            }
            exclusiveRoleGroups.set(page.roleId!, groupKey);

            const group = exclusiveGroups.get(groupKey) ?? { label: groupLabel, roleIds: new Set<string>() };
            group.roleIds.add(page.roleId!);
            exclusiveGroups.set(groupKey, group);
          }
          if (actionType === 'LINK' && !page.linkUrl?.trim()) {
            json(res, 400, { error: 'Les pages de type Lien doivent avoir un salon ou une URL' });
            return true;
          }
        }

        for (const group of exclusiveGroups.values()) {
          if (group.roleIds.size < 2) {
            json(res, 400, { error: `Le groupe exclusif « ${group.label} » doit contenir au moins deux rôles différents` });
            return true;
          }
        }

        await getOrCreateWelcomeThreadConfig(guildId);
        await prisma.$transaction([
          prisma.welcomeMenuPage.deleteMany({ where: { guildId } }),
          prisma.welcomeMenuPage.createMany({
            data: body.pages.map((page, index) => {
              const actionType = page.actionType && VALID_ACTION_TYPES.has(page.actionType) ? page.actionType : 'EMBED';
              const roleAction = page.roleAction && VALID_ROLE_ACTIONS.has(page.roleAction) ? page.roleAction : 'ADD';
              const roleGroupKey = page.roleGroup?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR') || '';
              return {
                guildId,
                order: index,
                label: page.label.trim().slice(0, 80),
                emoji: page.emoji?.trim() || null,
                summary: page.summary?.trim().slice(0, 100) || null,
                actionType,
                roleId: actionType === 'ROLE' ? page.roleId : null,
                roleAction,
                roleGroup: actionType === 'ROLE' && roleAction === 'EXCLUSIVE'
                  ? (exclusiveGroups.get(roleGroupKey)?.label ?? null)
                  : null,
                linkUrl: actionType === 'LINK' ? (page.linkUrl?.trim() || null) : null,
                embedTitle: page.embedTitle?.trim().slice(0, 256) || null,
                embedDescription: page.embedDescription?.trim().slice(0, 4096) || null,
                embedColor: page.embedColor?.trim() || '#5865F2',
                embedImageUrl: page.embedImageUrl?.trim() || null,
                embedThumbnailUrl: page.embedThumbnailUrl?.trim() || null,
              };
            }),
          }),
        ]);

        const config = await getOrCreateWelcomeThreadConfig(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: "Mise à jour pages Thread d'accueil",
          context: getGuildName(client, guildId),
          module: 'WelcomeThread',
          eventType: 'Manuel',
          details: `Pages remplacées : ${config.pages.length} page(s)`,
          channelId: config.channelId,
        });

        json(res, 200, { config });
      } catch (err) {
        logger.error('WelcomeThreadAPI', 'Error updating welcome menu pages:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour des pages' });
      }
      return true;
    }
  }

  // 4. REACTION ROLES ROUTES
  if (moduleKey === 'reaction-roles') {
    // GET /api/dashboard/guilds/:guildId/reaction-roles
    if (parts.length === 5 && method === 'GET') {
      try {
        const menus = await prisma.reactionRoleMenu.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
        });
        json(res, 200, { menus });
      } catch (err) {
        logger.error('ReactionRolesAPI', 'Error fetching menus:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des menus' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/reaction-roles (Créer)
    if (parts.length === 5 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          title: string;
          channelId: string;
          options: Array<{ emoji?: string; label: string; roleId: string }>;
        }>(req);

        if (!body || !body.title || !body.channelId || !body.options || body.options.length === 0) {
          json(res, 400, { error: 'Champs obligatoires manquants ou vides' });
          return true;
        }

        const menu = await createReactionRoleMenu(
          client,
          guildId,
          body.channelId,
          body.title,
          body.options
        );

        json(res, 200, { menu });
      } catch (err) {
        logger.error('ReactionRolesAPI', 'Error creating menu:', err);
        json(res, 500, { error: 'Erreur lors de la création du menu de rôles' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/reaction-roles/:menuId
    if (parts.length === 6 && method === 'DELETE') {
      const menuId = parts[5];
      try {
        const deleted = await deleteReactionRoleMenu(client, guildId, menuId);
        if (!deleted) {
          json(res, 404, { error: 'Menu de rôles introuvable' });
          return true;
        }
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('ReactionRolesAPI', 'Error deleting menu:', err);
        json(res, 500, { error: 'Erreur de suppression du menu' });
      }
      return true;
    }
  }

  // 5. triggers ROUTES
  if (moduleKey === 'triggers') {
    // GET /api/dashboard/guilds/:guildId/triggers
    if (parts.length === 5 && method === 'GET') {
      try {
        const list = await prisma.autoResponse.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
        });
        json(res, 200, { list });
      } catch (err) {
        logger.error('AutoResponsesAPI', 'Error fetching triggers:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des triggers' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/triggers
    if (parts.length === 5 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          trigger: string;
          response: string | null;
          matchType?: string;
          enabled?: boolean;
          roleIdToAdd?: string | null;
          roleIdToRemove?: string | null;
          deleteTrigger?: boolean;
          closeTicket?: boolean;
          rejectForm?: boolean;
          allowedRoleIds?: string[];
          bannedRoleIds?: string[];
          allowedChannelIds?: string[];
          bannedChannelIds?: string[];
          triggerType?: string;
          formId?: string | null;
          formQuestionLabel?: string | null;
          ticketTypeId?: string | null;
          ticketQuestionLabel?: string | null;
          reactions?: string[];
          actions?: any;
          responseDestination?: string;
          responseChannelId?: string | null;
          relayToStaffServer?: boolean;
        }>(req);

        if (!body || !body.trigger) {
          json(res, 400, { error: 'Déclencheur requis' });
          return true;
        }

        if (!body.response && !body.roleIdToAdd && !body.roleIdToRemove && !body.deleteTrigger && !body.closeTicket && !body.rejectForm && (!body.reactions || body.reactions.length === 0) && !body.actions) {
          json(res, 400, { error: 'Au moins une action doit être configurée (réponse, ajout/retrait de rôle, suppression du message, fermeture de ticket, rejet de formulaire, réaction ou action avancée)' });
          return true;
        }

        const autoResponse = await prisma.autoResponse.create({
          data: {
            guildId,
            trigger: body.trigger,
            response: body.response,
            matchType: body.matchType || 'CONTAINS',
            enabled: body.enabled ?? true,
            roleIdToAdd: body.roleIdToAdd || null,
            roleIdToRemove: body.roleIdToRemove || null,
            deleteTrigger: body.deleteTrigger ?? false,
            closeTicket: body.closeTicket ?? false,
            rejectForm: body.rejectForm ?? false,
            allowedRoleIds: body.allowedRoleIds ?? [],
            bannedRoleIds: body.bannedRoleIds ?? [],
            allowedChannelIds: body.allowedChannelIds ?? [],
            bannedChannelIds: body.bannedChannelIds ?? [],
            triggerType: body.triggerType || 'MESSAGE',
            formId: body.formId || null,
            formQuestionLabel: body.formQuestionLabel || null,
            ticketTypeId: body.ticketTypeId || null,
            ticketQuestionLabel: body.ticketQuestionLabel || null,
            reactions: body.reactions ?? [],
            actions: body.actions ?? null,
            responseDestination: body.responseDestination || 'DM',
            responseChannelId: body.responseChannelId || null,
            relayToStaffServer: body.relayToStaffServer ?? false,
          },
        });

        invalidateAutoResponseCache(guildId);
        json(res, 200, { autoResponse });
      } catch (err) {
        logger.error('AutoResponsesAPI', 'Error creating trigger:', err);
        json(res, 500, { error: 'Erreur lors de la création du déclencheur' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/triggers/:id
    if (parts.length === 6 && method === 'PATCH') {
      const id = parts[5];
      try {
        const body = await readJsonBody<{
          trigger?: string;
          response?: string | null;
          matchType?: string;
          enabled?: boolean;
          roleIdToAdd?: string | null;
          roleIdToRemove?: string | null;
          deleteTrigger?: boolean;
          closeTicket?: boolean;
          rejectForm?: boolean;
          allowedRoleIds?: string[];
          bannedRoleIds?: string[];
          allowedChannelIds?: string[];
          bannedChannelIds?: string[];
          triggerType?: string;
          formId?: string | null;
          formQuestionLabel?: string | null;
          ticketTypeId?: string | null;
          ticketQuestionLabel?: string | null;
          reactions?: string[];
          actions?: any;
          responseDestination?: string;
          responseChannelId?: string | null;
          relayToStaffServer?: boolean;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        const existing = await prisma.autoResponse.findUnique({
          where: { id },
        });

        if (!existing) {
          json(res, 404, { error: 'Déclencheur introuvable' });
          return true;
        }

        const combinedTrigger = body.trigger !== undefined ? body.trigger : existing.trigger;
        const combinedResponse = body.response !== undefined ? body.response : existing.response;
        const combinedRoleIdToAdd = body.roleIdToAdd !== undefined ? body.roleIdToAdd : existing.roleIdToAdd;
        const combinedRoleIdToRemove = body.roleIdToRemove !== undefined ? body.roleIdToRemove : existing.roleIdToRemove;
        const combinedDeleteTrigger = body.deleteTrigger !== undefined ? body.deleteTrigger : existing.deleteTrigger;
        const combinedCloseTicket = body.closeTicket !== undefined ? body.closeTicket : (existing as { closeTicket?: boolean }).closeTicket;
        const combinedRejectForm = body.rejectForm !== undefined ? body.rejectForm : (existing as { rejectForm?: boolean }).rejectForm;
        const combinedReactions = body.reactions !== undefined ? body.reactions : existing.reactions;
        const combinedActions = body.actions !== undefined ? body.actions : existing.actions;

        if (!combinedTrigger) {
          json(res, 400, { error: 'Déclencheur requis' });
          return true;
        }

        if (!combinedResponse && !combinedRoleIdToAdd && !combinedRoleIdToRemove && !combinedDeleteTrigger && !combinedCloseTicket && !combinedRejectForm && (!combinedReactions || combinedReactions.length === 0) && !combinedActions) {
          json(res, 400, { error: 'Au moins une action doit être configurée (réponse, ajout/retrait de rôle, suppression du message, fermeture de ticket, rejet de formulaire, réaction ou action avancée)' });
          return true;
        }

        const autoResponse = await prisma.autoResponse.update({
          where: { id },
          data: {
            trigger: body.trigger,
            response: body.response,
            matchType: body.matchType,
            enabled: body.enabled,
            roleIdToAdd: body.roleIdToAdd,
            roleIdToRemove: body.roleIdToRemove,
            deleteTrigger: body.deleteTrigger,
            closeTicket: body.closeTicket,
            rejectForm: body.rejectForm,
            allowedRoleIds: body.allowedRoleIds,
            bannedRoleIds: body.bannedRoleIds,
            allowedChannelIds: body.allowedChannelIds,
            bannedChannelIds: body.bannedChannelIds,
            triggerType: body.triggerType,
            formId: body.formId,
            formQuestionLabel: body.formQuestionLabel,
            ticketTypeId: body.ticketTypeId,
            ticketQuestionLabel: body.ticketQuestionLabel,
            reactions: body.reactions,
            actions: body.actions,
            responseDestination: body.responseDestination,
            responseChannelId: body.responseChannelId,
            relayToStaffServer: body.relayToStaffServer,
          },
        });

        invalidateAutoResponseCache(guildId);
        json(res, 200, { autoResponse });
      } catch (err) {
        logger.error('AutoResponsesAPI', 'Error updating trigger:', err);
        json(res, 500, { error: 'Erreur lors de la modification' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/triggers/:id
    if (parts.length === 6 && method === 'DELETE') {
      const id = parts[5];
      try {
        await prisma.autoResponse.delete({
          where: { id },
        });
        invalidateAutoResponseCache(guildId);
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('AutoResponsesAPI', 'Error deleting trigger:', err);
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/triggers/emojis
    if (parts.length === 6 && parts[5] === 'emojis' && method === 'GET') {
      try {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
          json(res, 200, { emojis: [] });
          return true;
        }
        const emojis = await guild.emojis.fetch();
        json(res, 200, {
          emojis: emojis.map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: e.url })),
        });
      } catch (err) {
        logger.error('AutoResponsesAPI', 'Error fetching guild emojis:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des emojis du serveur' });
      }
      return true;
    }
  }

  // 6. AUTOMOD ROUTES
  if (moduleKey === 'automod') {
    // GET /api/dashboard/guilds/:guildId/automod
    if (parts.length === 5 && method === 'GET') {
      try {
        const config = await getOrCreateAutoModConfig(guildId);
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const isOwner = guild ? guild.ownerId === user.userId : false;
        json(res, 200, { config, isOwner });
      } catch (err) {
        logger.error('AutoModAPI', 'Error fetching config:', err);
        json(res, 500, { error: 'Erreur de récupération config AutoMod' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/automod
    if (parts.length === 5 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          discordAutoModEnabled?: boolean;
          spamEnabled?: boolean;
          spamLimit?: number;
          spamIntervalSeconds?: number;
          spamAction?: string;
          linksEnabled?: boolean;
          linksAction?: string;
          linksWhitelist?: string[];
          capsEnabled?: boolean;
          capsThresholdPercent?: number;
          capsMinLength?: number;
          emojisEnabled?: boolean;
          emojisLimit?: number;
          mentionsEnabled?: boolean;
          mentionsLimit?: number;
          ghostPingEnabled?: boolean;
          ghostPingAction?: string;
          antiEveryoneEnabled?: boolean;
          antiEveryoneAction?: string;
          customWordsEnabled?: boolean;
          customWordsAction?: string;
          customWords?: string[];
          customWordsAllowList?: string[];
          customWordsTimeoutSec?: number;
          profanityEnabled?: boolean;
          profanityPresetProfanity?: boolean;
          profanityPresetSexual?: boolean;
          profanityPresetSlurs?: boolean;
          profanityAction?: string;
          profanityAllowList?: string[];
          profanityTimeoutSec?: number;
          inviteFilterEnabled?: boolean;
          inviteFilterAction?: string;
          inviteFilterAllowedGuilds?: string[];
          inviteFilterTimeoutSec?: number;
          antiBotEnabled?: boolean;
          antiBotAction?: string;
          antiBotBypassUsers?: string[];
          bypassRoles?: string[];
          bypassChannels?: string[];
          adminLockEnabled?: boolean;
          adminLockAction?: string;
          adminLockSecurityRoleIds?: string[];
          adminLockNotifyChannelId?: string | null;
          burstSuspendEnabled?: boolean;
          burstSuspendFastLimit?: number;
          burstSuspendFastWindowSec?: number;
          burstSuspendSlowLimit?: number;
          burstSuspendSlowWindowSec?: number;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        // Seul le propriétaire du serveur peut modifier les paramètres anti-bot et admin-lock
        const antiBotFieldsProvided = body.antiBotEnabled !== undefined || body.antiBotAction !== undefined || body.antiBotBypassUsers !== undefined;
        const adminLockFieldsProvided =
          body.adminLockEnabled !== undefined ||
          body.adminLockAction !== undefined ||
          body.adminLockSecurityRoleIds !== undefined ||
          body.adminLockNotifyChannelId !== undefined ||
          body.burstSuspendEnabled !== undefined ||
          body.burstSuspendFastLimit !== undefined ||
          body.burstSuspendFastWindowSec !== undefined ||
          body.burstSuspendSlowLimit !== undefined ||
          body.burstSuspendSlowWindowSec !== undefined;

        if (antiBotFieldsProvided) {
          const existingConfig = await prisma.autoModConfig.findUnique({
            where: { guildId },
            select: { antiBotEnabled: true, antiBotAction: true, antiBotBypassUsers: true },
          });
          const antiBotChanged =
            (body.antiBotEnabled !== undefined && body.antiBotEnabled !== (existingConfig?.antiBotEnabled ?? false)) ||
            (body.antiBotAction !== undefined && body.antiBotAction !== (existingConfig?.antiBotAction ?? 'KICK')) ||
            (body.antiBotBypassUsers !== undefined &&
              JSON.stringify([...body.antiBotBypassUsers].sort()) !== JSON.stringify([...(existingConfig?.antiBotBypassUsers ?? [])].sort()));

          if (antiBotChanged) {
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild || guild.ownerId !== user.userId) {
              json(res, 403, { error: 'Seul le propriétaire du serveur peut modifier les paramètres du mode sécurisé (Anti-Bot).' });
              return true;
            }
          }
        }

        if (adminLockFieldsProvided) {
          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (!guild || guild.ownerId !== user.userId) {
            json(res, 403, { error: "Seul le propriétaire du serveur peut modifier les paramètres d'Admin Permission Lock." });
            return true;
          }
        }

        const configData = {
          discordAutoModEnabled: true,
          spamEnabled: body.spamEnabled,
          spamLimit: body.spamLimit,
          spamIntervalSeconds: body.spamIntervalSeconds,
          spamAction: body.spamAction,
          linksEnabled: body.linksEnabled,
          linksAction: body.linksAction,
          linksWhitelist: body.linksWhitelist,
          capsEnabled: body.capsEnabled,
          capsThresholdPercent: body.capsThresholdPercent,
          capsMinLength: body.capsMinLength,
          emojisEnabled: body.emojisEnabled,
          emojisLimit: body.emojisLimit,
          mentionsEnabled: body.mentionsEnabled,
          mentionsLimit: body.mentionsLimit,
          ghostPingEnabled: body.ghostPingEnabled,
          ghostPingAction: body.ghostPingAction,
          antiEveryoneEnabled: body.antiEveryoneEnabled,
          antiEveryoneAction: body.antiEveryoneAction,
          customWordsEnabled: body.customWordsEnabled,
          customWordsAction: body.customWordsAction,
          customWords: body.customWords,
          customWordsAllowList: body.customWordsAllowList,
          customWordsTimeoutSec: body.customWordsTimeoutSec,
          profanityEnabled: body.profanityEnabled,
          profanityPresetProfanity: body.profanityPresetProfanity,
          profanityPresetSexual: body.profanityPresetSexual,
          profanityPresetSlurs: body.profanityPresetSlurs,
          profanityAction: body.profanityAction,
          profanityAllowList: body.profanityAllowList,
          profanityTimeoutSec: body.profanityTimeoutSec,
          inviteFilterEnabled: body.inviteFilterEnabled,
          inviteFilterAction: body.inviteFilterAction,
          inviteFilterAllowedGuilds: body.inviteFilterAllowedGuilds,
          inviteFilterTimeoutSec: body.inviteFilterTimeoutSec,
          antiBotEnabled: body.antiBotEnabled,
          antiBotAction: body.antiBotAction,
          antiBotBypassUsers: body.antiBotBypassUsers,
          bypassRoles: body.bypassRoles,
          bypassChannels: body.bypassChannels,
          adminLockEnabled: body.adminLockEnabled,
          adminLockAction: body.adminLockAction,
          adminLockSecurityRoleIds: body.adminLockSecurityRoleIds,
          adminLockNotifyChannelId: body.adminLockNotifyChannelId,
          burstSuspendEnabled: body.burstSuspendEnabled,
          burstSuspendFastLimit: body.burstSuspendFastLimit,
          burstSuspendFastWindowSec: body.burstSuspendFastWindowSec,
          burstSuspendSlowLimit: body.burstSuspendSlowLimit,
          burstSuspendSlowWindowSec: body.burstSuspendSlowWindowSec,
        };

        const config = await prisma.autoModConfig.upsert({
          where: { guildId },
          update: configData,
          create: {
            guildId,
            ...configData,
            spamEnabled: body.spamEnabled ?? false,
            spamLimit: body.spamLimit ?? 5,
            spamIntervalSeconds: body.spamIntervalSeconds ?? 5,
            spamAction: body.spamAction ?? 'TIMEOUT',
            linksEnabled: body.linksEnabled ?? false,
            linksAction: body.linksAction ?? 'DELETE_AND_WARN',
            linksWhitelist: body.linksWhitelist ?? [],
            capsEnabled: body.capsEnabled ?? false,
            capsThresholdPercent: body.capsThresholdPercent ?? 80,
            capsMinLength: body.capsMinLength ?? 10,
            emojisEnabled: body.emojisEnabled ?? false,
            emojisLimit: body.emojisLimit ?? 10,
            mentionsEnabled: body.mentionsEnabled ?? false,
            mentionsLimit: body.mentionsLimit ?? 5,
            ghostPingEnabled: body.ghostPingEnabled ?? false,
            ghostPingAction: body.ghostPingAction ?? 'ALERT',
            antiEveryoneEnabled: body.antiEveryoneEnabled ?? false,
            antiEveryoneAction: body.antiEveryoneAction ?? 'DELETE_AND_WARN',
            customWordsEnabled: body.customWordsEnabled ?? false,
            customWordsAction: body.customWordsAction ?? 'BLOCK',
            customWords: body.customWords ?? [],
            customWordsAllowList: body.customWordsAllowList ?? [],
            customWordsTimeoutSec: body.customWordsTimeoutSec ?? 60,
            profanityEnabled: body.profanityEnabled ?? false,
            profanityPresetProfanity: body.profanityPresetProfanity ?? true,
            profanityPresetSexual: body.profanityPresetSexual ?? true,
            profanityPresetSlurs: body.profanityPresetSlurs ?? true,
            profanityAction: body.profanityAction ?? 'BLOCK',
            profanityAllowList: body.profanityAllowList ?? [],
            profanityTimeoutSec: body.profanityTimeoutSec ?? 60,
            inviteFilterEnabled: body.inviteFilterEnabled ?? false,
            inviteFilterAction: body.inviteFilterAction ?? 'BLOCK',
            inviteFilterAllowedGuilds: body.inviteFilterAllowedGuilds ?? [],
            inviteFilterTimeoutSec: body.inviteFilterTimeoutSec ?? 60,
            antiBotEnabled: body.antiBotEnabled ?? false,
            antiBotAction: body.antiBotAction ?? 'KICK',
            antiBotBypassUsers: body.antiBotBypassUsers ?? [],
            bypassRoles: body.bypassRoles ?? [],
            bypassChannels: body.bypassChannels ?? [],
            adminLockEnabled: body.adminLockEnabled ?? false,
            adminLockAction: body.adminLockAction ?? 'BLOCK',
            adminLockSecurityRoleIds: body.adminLockSecurityRoleIds ?? [],
            adminLockNotifyChannelId: body.adminLockNotifyChannelId ?? null,
            burstSuspendEnabled: body.burstSuspendEnabled ?? false,
            burstSuspendFastLimit: body.burstSuspendFastLimit ?? 5,
            burstSuspendFastWindowSec: body.burstSuspendFastWindowSec ?? 1,
            burstSuspendSlowLimit: body.burstSuspendSlowLimit ?? 10,
            burstSuspendSlowWindowSec: body.burstSuspendSlowWindowSec ?? 60,
          },
        });

        invalidateAutoModCache(guildId);

        // Synchroniser les règles natives Discord AutoMod
        let syncWarning: string | null = null;
        try {
          await syncDiscordAutoModRules(client, guildId, config);
        } catch (syncErr) {
          logger.error('AutoModAPI', `Erreur lors de la synchronisation Discord AutoMod pour ${guildId}:`, syncErr);
          syncWarning = 'Configuration sauvegardée mais la synchronisation des règles Discord AutoMod a échoué. Vérifiez que le bot a la permission « Gérer le serveur ».';
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour AutoMod',
          context: getGuildName(client, guildId),
          module: 'AutoMod',
          eventType: 'Manuel',
          details: `Verrous de sécurité mis à jour. Anti-spam: ${config.spamEnabled}, Anti-liens: ${config.linksEnabled}, Synchro native: ${config.discordAutoModEnabled}`,
          channelId: null
        });

        json(res, 200, { config, ...(syncWarning ? { syncWarning } : {}) });
      } catch (err) {
        logger.error('AutoModAPI', 'Error updating config:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour AutoMod' });
      }
      return true;
    }
  }

  // 7. SUGGESTIONS ROUTES
  if (moduleKey === 'suggestions') {
    // GET /api/dashboard/guilds/:guildId/suggestions/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
      try {
        const { getOrCreateFeatureConfigs } = await import('../../../services/core/dashboardManagementService.js');
        const configs = await getOrCreateFeatureConfigs(guildId);
        const featureConfig = configs.find((c) => c.featureKey === 'suggestions');
        json(res, 200, {
          config: {
            enabled: featureConfig?.enabled ?? true,
            channelId: featureConfig?.channelId ?? null,
          },
        });
      } catch (err) {
        logger.error('SuggestionsAPI', 'Error fetching suggestions config:', err);
        json(res, 500, { error: 'Erreur de récupération de la configuration' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/suggestions/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          enabled?: boolean;
          channelId?: string | null;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        const { getOrCreateFeatureConfigs, updateFeatureConfig } = await import('../../../services/core/dashboardManagementService.js');
        await getOrCreateFeatureConfigs(guildId);

        // L'activation passe par le service dedie : lui seul propage la cascade
        // des dependances, refuse un module hors offre et purge le cache d'etats
        // que la garde de lecture consulte.
        if (typeof body.enabled === 'boolean') {
          const { setDashboardModuleStatus } = await import('../../../services/core/moduleActivationService.js');
          await setDashboardModuleStatus(guildId, 'suggestions', body.enabled);
        }

        const updated = await updateFeatureConfig(guildId, 'suggestions', {
          channelId: body.channelId,
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour configuration suggestions',
          context: getGuildName(client, guildId),
          module: 'Suggestions',
          eventType: 'Manuel',
          details: `Module ${updated.enabled ? 'activé' : 'désactivé'}${updated.channelId ? `, salon <#${updated.channelId}>` : ''}.`,
          channelId: updated.channelId,
        });

        broadcastDashboardStateChange(guildId, 'suggestions_updated');
        json(res, 200, {
          config: {
            enabled: updated.enabled,
            channelId: updated.channelId,
          },
        });
      } catch (err) {
        logger.error('SuggestionsAPI', 'Error updating suggestions config:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/suggestions
    if (parts.length === 5 && method === 'GET') {
      try {
        const suggestions = await prisma.suggestion.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
        });
        // La table ne garde que l'identifiant et le pseudo fige a la creation :
        // sans resolution, le dashboard n'a aucune photo a afficher.
        const identities = await getMemberIdentities(
          client,
          guildId,
          suggestions.map((suggestion) => suggestion.userId),
        );
        json(res, 200, {
          suggestions: suggestions.map((suggestion) => {
            const identity = identities.get(suggestion.userId);
            return {
              ...suggestion,
              username: identity?.displayName || suggestion.username,
              avatarUrl: identity?.avatarUrl || null,
            };
          }),
        });
      } catch (err) {
        logger.error('SuggestionsAPI', 'Error fetching suggestions:', err);
        json(res, 500, { error: 'Erreur de récupération des suggestions' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/suggestions/:suggestionId/resolve (Prendre une décision)
    if (parts.length === 7 && parts[6] === 'resolve' && method === 'POST') {
      const suggestionId = parts[5];
      try {
        const body = await readJsonBody<{
          status: 'APPROVED' | 'REJECTED' | 'IMPLEMENTED';
          responseText: string;
        }>(req);

        if (!body || !body.status || !body.responseText) {
          json(res, 400, { error: 'Statut et commentaire de réponse requis' });
          return true;
        }

        const suggestion = await resolveSuggestion(
          suggestionId,
          body.status,
          body.responseText,
          user.userId,
          client
        );

        if (!suggestion) {
          json(res, 404, { error: 'Suggestion introuvable' });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Résolution suggestion',
          context: getGuildName(client, guildId),
          module: 'Suggestions',
          eventType: 'Manuel',
          details: `Suggestion ${suggestionId} résolue avec le statut : ${body.status}.`,
          channelId: null
        });

        json(res, 200, { suggestion });
      } catch (err) {
        logger.error('SuggestionsAPI', 'Error resolving suggestion:', err);
        json(res, 500, { error: 'Erreur lors de la résolution de la suggestion' });
      }
      return true;
    }
  }

  // 8. EMBED BUILDER ROUTES
  if (moduleKey === 'embed-builder') {
    // POST /api/dashboard/guilds/:guildId/embed-builder (Envoyer ou mettre à jour un embed)
    if (parts.length === 5 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          channelId: string;
          messageId?: string | null;
          content?: string | null;
          embed?: {
            title?: string;
            description?: string;
            color?: string;
            thumbnailUrl?: string | null;
            imageUrl?: string | null;
            url?: string | null;
            authorName?: string | null;
            authorIconUrl?: string | null;
            authorUrl?: string | null;
            footerText?: string | null;
            footerIconUrl?: string | null;
            timestamp?: boolean | string | null;
            fields?: Array<{ name: string; value: string; inline?: boolean }>;
          };
        }>(req);

        if (!body || !body.channelId || (!body.embed && !body.content)) {
          json(res, 400, { error: "Salon et données d'envoi requis (content ou embed)" });
          return true;
        }

        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!discordGuild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const channel = discordGuild.channels.cache.get(body.channelId);
        if (!channel?.isTextBased()) {
          json(res, 404, { error: 'Salon introuvable ou invalide' });
          return true;
        }

        // Résoudre les shortcodes emoji (:ktb_xxx: → <:ktb_xxx:ID>)
        if (body.content) body.content = resolveEmojiShortcodes(body.content);
        if (body.embed) {
          if (body.embed.title) body.embed.title = resolveEmojiShortcodes(body.embed.title);
          if (body.embed.description) body.embed.description = resolveEmojiShortcodes(body.embed.description);
          if (body.embed.authorName) body.embed.authorName = resolveEmojiShortcodes(body.embed.authorName);
          if (body.embed.footerText) body.embed.footerText = resolveEmojiShortcodes(body.embed.footerText);
          if (body.embed.fields) {
            for (const f of body.embed.fields) {
              f.name = resolveEmojiShortcodes(f.name);
              f.value = resolveEmojiShortcodes(f.value);
            }
          }
        }

        // Construire l'embed Discord si fourni
        const embed = new EmbedBuilder();
        let hasEmbedData = false;

        if (body.embed) {
          if (body.embed.title) { embed.setTitle(body.embed.title); hasEmbedData = true; }
          if (body.embed.description) { embed.setDescription(body.embed.description); hasEmbedData = true; }
          if (body.embed.color) { embed.setColor(body.embed.color as ColorResolvable); hasEmbedData = true; }
          if (body.embed.thumbnailUrl) { embed.setThumbnail(body.embed.thumbnailUrl); hasEmbedData = true; }
          if (body.embed.imageUrl) { embed.setImage(body.embed.imageUrl); hasEmbedData = true; }
          if (body.embed.url) { embed.setURL(body.embed.url); hasEmbedData = true; }
          if (body.embed.timestamp) {
            embed.setTimestamp(body.embed.timestamp === true ? new Date() : new Date(body.embed.timestamp));
            hasEmbedData = true;
          }

          if (body.embed.authorName) {
            embed.setAuthor({
              name: body.embed.authorName,
              iconURL: body.embed.authorIconUrl || undefined,
              url: body.embed.authorUrl || undefined
            });
            hasEmbedData = true;
          }

          if (body.embed.footerText) {
            embed.setFooter({
              text: body.embed.footerText,
              iconURL: body.embed.footerIconUrl || undefined
            });
            hasEmbedData = true;
          }

          if (body.embed.fields && body.embed.fields.length > 0) {
            embed.addFields(body.embed.fields.map(f => ({
              name: f.name || '-',
              value: f.value || '-',
              inline: !!f.inline
            })));
            hasEmbedData = true;
          }
        }

        if (!body.content && !hasEmbedData) {
          json(res, 400, { error: "Vous devez fournir du texte de message ou au moins un champ d'embed." });
          return true;
        }

        const messageOptions = {
          content: body.content || undefined,
          embeds: hasEmbedData ? [embed] : undefined
        };

        let messageSent;
        if (body.messageId) {
          // Tenter de modifier un message existant
          const msg = await channel.messages.fetch(body.messageId).catch(() => null);
          if (msg) {
            messageSent = await msg.edit(messageOptions).catch(() => null);
          }
        }

        if (!messageSent) {
          // Envoyer un nouveau message
          messageSent = await channel.send(messageOptions).catch(() => null);
        }

        if (!messageSent) {
          json(res, 500, { error: "Le bot n'a pas pu envoyer ou modifier le message (vérifiez ses permissions)." });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: body.messageId ? 'Mise à jour embed' : 'Envoi embed personnalisé',
          context: getGuildName(client, guildId),
          module: 'EmbedBuilder',
          eventType: 'Manuel',
          details: `Embed envoyé dans le salon <#${body.channelId}> (Message: ${messageSent.id}).`,
          channelId: body.channelId
        });

        json(res, 200, { ok: true, messageId: messageSent.id });
      } catch (err) {
        logger.error('EmbedBuilderAPI', 'Error building/sending embed:', err);
        json(res, 500, { error: "Erreur lors du traitement de l'embed" });
      }
      return true;
    }
  }

  // 9. FUN MODULE ROUTES
  if (moduleKey === 'fun') {
    // GET /api/dashboard/guilds/:guildId/fun
    if (parts.length === 5 && method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            funEnabled: true,
            funCountingChannelId: true,
            funOneWordStoryChannelId: true,
            funGuessNumberChannelId: true,
            funWordChainChannelId: true,
            funEmojiRiddleChannelId: true,
            funNeverSayChannelId: true,
            funEmojiOnlyChannelId: true,
            funPunitiveMode: true,
          }
        });

        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const { getOrCreateFunGameState } = await import('../../../services/features/funService.js');
        const gameState = await getOrCreateFunGameState(guildId);

        json(res, 200, {
          config: guild,
          gameState: {
            countingCurrent: gameState.countingCurrent,
            countingLastUserId: gameState.countingLastUserId,
            oneWordStoryLastUserId: gameState.oneWordStoryLastUserId,
            guessNumberTarget: gameState.guessNumberTarget,
            wordChainLastWord: gameState.wordChainLastWord,
            wordChainLastUserId: gameState.wordChainLastUserId,
            emojiRiddleEmojis: gameState.emojiRiddleEmojis,
          }
        });
      } catch (err) {
        logger.error('FunAPI', 'Error fetching fun config:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration fun' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/fun
    if (parts.length === 5 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          funEnabled?: boolean;
          funCountingChannelId?: string | null;
          funOneWordStoryChannelId?: string | null;
          funGuessNumberChannelId?: string | null;
          funWordChainChannelId?: string | null;
          funEmojiRiddleChannelId?: string | null;
          funNeverSayChannelId?: string | null;
          funEmojiOnlyChannelId?: string | null;
          funPunitiveMode?: boolean;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant' });
          return true;
        }

        const updatedGuild = await prisma.guild.update({
          where: { id: guildId },
          data: {
            funEnabled: body.funEnabled,
            funCountingChannelId: body.funCountingChannelId,
            funOneWordStoryChannelId: body.funOneWordStoryChannelId,
            funGuessNumberChannelId: body.funGuessNumberChannelId,
            funWordChainChannelId: body.funWordChainChannelId,
            funEmojiRiddleChannelId: body.funEmojiRiddleChannelId,
            funNeverSayChannelId: body.funNeverSayChannelId,
            funEmojiOnlyChannelId: body.funEmojiOnlyChannelId,
            funPunitiveMode: body.funPunitiveMode,
          },
        });

        // Initialize targets/riddles the first time their channel is set.
        const { getOrCreateFunGameState, resetEmojiRiddle } = await import('../../../services/features/funService.js');
        const gameState = await getOrCreateFunGameState(guildId);
        if (body.funGuessNumberChannelId && gameState.guessNumberTarget === 0) {
          const newTarget = Math.floor(Math.random() * 1000) + 1;
          await prisma.funGameState.update({
            where: { guildId },
            data: { guessNumberTarget: newTarget }
          });
        }
        if (body.funEmojiRiddleChannelId && !gameState.emojiRiddleEmojis) {
          await resetEmojiRiddle(guildId);
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour Salons Fun',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: `Configuration des salons fun modifiée. Actif: ${updatedGuild.funEnabled}`,
          channelId: null
        });

        const latestState = await prisma.funGameState.findUnique({ where: { guildId } });

        json(res, 200, {
          config: {
            funEnabled: updatedGuild.funEnabled,
            funCountingChannelId: updatedGuild.funCountingChannelId,
            funOneWordStoryChannelId: updatedGuild.funOneWordStoryChannelId,
            funGuessNumberChannelId: updatedGuild.funGuessNumberChannelId,
            funWordChainChannelId: updatedGuild.funWordChainChannelId,
            funEmojiRiddleChannelId: updatedGuild.funEmojiRiddleChannelId,
            funNeverSayChannelId: updatedGuild.funNeverSayChannelId,
            funEmojiOnlyChannelId: updatedGuild.funEmojiOnlyChannelId,
            funPunitiveMode: updatedGuild.funPunitiveMode,
          },
          gameState: {
            countingCurrent: latestState?.countingCurrent ?? 0,
            countingLastUserId: latestState?.countingLastUserId ?? null,
            oneWordStoryLastUserId: latestState?.oneWordStoryLastUserId ?? null,
            guessNumberTarget: latestState?.guessNumberTarget ?? 0,
            wordChainLastWord: latestState?.wordChainLastWord ?? null,
            wordChainLastUserId: latestState?.wordChainLastUserId ?? null,
            emojiRiddleEmojis: latestState?.emojiRiddleEmojis ?? null,
          }
        });
      } catch (err) {
        logger.error('FunAPI', 'Error updating fun config:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration fun' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/fun/counting/reset
    if (parts.length === 7 && parts[5] === 'counting' && parts[6] === 'reset' && method === 'POST') {
      try {
        const { resetCounting } = await import('../../../services/features/funService.js');
        const state = await resetCounting(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Réinitialisation Comptage',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: `Le comptage a été réinitialisé à 0 depuis le dashboard.`,
          channelId: null
        });

        json(res, 200, {
          success: true,
          gameState: {
            countingCurrent: state.countingCurrent,
            countingLastUserId: state.countingLastUserId,
            oneWordStoryLastUserId: state.oneWordStoryLastUserId,
            guessNumberTarget: state.guessNumberTarget,
            wordChainLastWord: state.wordChainLastWord,
            wordChainLastUserId: state.wordChainLastUserId,
            emojiRiddleEmojis: state.emojiRiddleEmojis,
          }
        });
      } catch (err) {
        logger.error('FunAPI', 'Error resetting counting:', err);
        json(res, 500, { error: 'Erreur lors de la réinitialisation du comptage' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/fun/guess-number/reset
    if (parts.length === 7 && parts[5] === 'guess-number' && parts[6] === 'reset' && method === 'POST') {
      try {
        const { resetGuessNumber } = await import('../../../services/features/funService.js');
        const state = await resetGuessNumber(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Réinitialisation Nombre Mystère',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: `Un nouveau nombre mystère a été généré depuis le dashboard.`,
          channelId: null
        });

        json(res, 200, {
          success: true,
          gameState: {
            countingCurrent: state.countingCurrent,
            countingLastUserId: state.countingLastUserId,
            oneWordStoryLastUserId: state.oneWordStoryLastUserId,
            guessNumberTarget: state.guessNumberTarget,
            wordChainLastWord: state.wordChainLastWord,
            wordChainLastUserId: state.wordChainLastUserId,
            emojiRiddleEmojis: state.emojiRiddleEmojis,
          }
        });
      } catch (err) {
        logger.error('FunAPI', 'Error resetting guess target:', err);
        json(res, 500, { error: 'Erreur lors du changement du nombre mystère' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/fun/word-chain/reset
    if (parts.length === 7 && parts[5] === 'word-chain' && parts[6] === 'reset' && method === 'POST') {
      try {
        const { resetWordChain } = await import('../../../services/features/funService.js');
        const state = await resetWordChain(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Réinitialisation Chaîne de mots',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: `La chaîne de mots a été réinitialisée depuis le dashboard.`,
          channelId: null
        });

        json(res, 200, {
          success: true,
          gameState: {
            countingCurrent: state.countingCurrent,
            countingLastUserId: state.countingLastUserId,
            oneWordStoryLastUserId: state.oneWordStoryLastUserId,
            guessNumberTarget: state.guessNumberTarget,
            wordChainLastWord: state.wordChainLastWord,
            wordChainLastUserId: state.wordChainLastUserId,
            emojiRiddleEmojis: state.emojiRiddleEmojis,
          }
        });
      } catch (err) {
        logger.error('FunAPI', 'Error resetting word chain:', err);
        json(res, 500, { error: 'Erreur lors de la réinitialisation de la chaîne de mots' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/fun/emoji-riddle/reset
    if (parts.length === 7 && parts[5] === 'emoji-riddle' && parts[6] === 'reset' && method === 'POST') {
      try {
        const { resetEmojiRiddle } = await import('../../../services/features/funService.js');
        const state = await resetEmojiRiddle(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Nouveau Rébus Emoji',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: `Un nouveau rébus emoji a été généré depuis le dashboard.`,
          channelId: null
        });

        json(res, 200, {
          success: true,
          gameState: {
            countingCurrent: state.countingCurrent,
            countingLastUserId: state.countingLastUserId,
            oneWordStoryLastUserId: state.oneWordStoryLastUserId,
            guessNumberTarget: state.guessNumberTarget,
            wordChainLastWord: state.wordChainLastWord,
            wordChainLastUserId: state.wordChainLastUserId,
            emojiRiddleEmojis: state.emojiRiddleEmojis,
          }
        });
      } catch (err) {
        logger.error('FunAPI', 'Error resetting emoji riddle:', err);
        json(res, 500, { error: 'Erreur lors de la génération du rébus emoji' });
      }
      return true;
    }
  }

  return false;
}
