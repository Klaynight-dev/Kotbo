import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, getGuildName, pushAudit, broadcastDashboardStateChange, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { clanTasks, runDistribution, runClear, runDeduplicate, runClanArtifactCleanup, handleEndSeason, settleRaidBeforeSeasonEnd } from '../../../services/community/clanService.js';
import { memberProfileIdentity } from '../../../services/moderation/memberIdentityService.js';
import { setDashboardModuleStatus } from '../../../services/core/moduleActivationService.js';
import {
  BET_ACCEPT_WINDOW_HOURS_MAX,
  BET_ACCEPT_WINDOW_HOURS_MIN,
  BET_DEBT_CEILING,
  BET_OPEN_PER_MEMBER_CEILING,
  BET_PARTICIPANTS_CEILING,
  BET_PARTICIPANTS_MIN,
  BET_SIDES_CEILING,
  BET_SIDES_MIN,
  BET_SEASON_REWARD_CEILING,
  BET_STAKE_MODES,
  firmDebtOf,
  MAX_CLAN_POINTS_PER_LEVEL_UP,
  MIN_CLAN_REFERENCE_LEVEL,
  normalizeClanBetSettings,
  CLAN_BET_SETTINGS_SELECT,
  type BetStakeMode,
} from '@kotbo/shared';

/** Garde-fou sur les ajustements manuels : au-delà, c'est une faute de frappe. */
const MAX_MANUAL_POINTS = 1_000_000;

/** Pseudo-membre portant les points attribués au clan entier. */
const CLAN_WIDE_USER_ID = 'system_manual_points';

/**
 * Segments d'URL qui désignent une action et non l'identifiant d'un clan : sans
 * cette liste, un PUT sur /clans/reset-all irait chercher un clan « reset-all ».
 */
const RESERVED_SUBACTIONS = new Set([
  'distribute',
  'clear',
  'dedupe',
  'points',
  'reset-season',
  'reset-all',
  'rollback-season',
  'bets',
]);

export async function handleClansRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = `${user.username} (${user.userId})`;

  // Path matches: /api/dashboard/guilds/:guildId/clans/...
  const subAction = parts[5]; // undefined | id | distribute | clear | reset-season

  // GET /api/dashboard/guilds/:guildId/clans
  if (!subAction && method === 'GET') {
    try {
      const guildData = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          clansEnabled: true,
          clanAutoAssignOnJoin: true,
          clanWeeklyDigest: true,
          currentClanSeason: true,
          clanXpFromLevelUp: true,
          clanXpPerLevelUp: true,
          clanXpLevelUpProportional: true,
          clanXpReferenceLevel: true,
          clanXpFromBoost: true,
          clanXpPerBoost: true,
          clanAnnouncementChannelId: true,
          clanRewardGiveaway: true,
          clanRewardXpBoost: true,
          clanRewardXpBoostRate: true,
          clanRewardLeaderRole: true,
          lastWinningClanId: true,
          clanSeasonStartsAt: true,
          clanSeasonEndsAt: true,
          ...CLAN_BET_SETTINGS_SELECT,
        },
      });

      if (!guildData) {
        json(res, 404, { error: 'Serveur non trouvé en base de données.' });
        return true;
      }

      const clans = await prisma.clan.findMany({
        where: { guildId },
        orderBy: { name: 'asc' },
      });

      // Calculer dynamiquement le nombre de membres et l'XP de la saison en cours pour chaque clan
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      
      const clansWithStats = await Promise.all(
        clans.map(async (clan) => {
          // Nombre de membres réels ayant le rôle actuellement
          const memberCount = discordGuild?.roles.cache.get(clan.roleId)?.members.size ?? 0;

          // Somme des contributions d'XP pour la saison active
          const aggregate = await prisma.clanMemberContribution.aggregate({
            where: {
              guildId,
              clanId: clan.id,
              season: guildData.currentClanSeason,
            },
            _sum: { xp: true },
          });

          return {
            ...clan,
            memberCount,
            totalXp: aggregate._sum.xp ?? 0,
          };
        })
      );

      const taskInProgress = clanTasks.get(guildId) || null;

      json(res, 200, {
        clansEnabled: guildData.clansEnabled,
        clanAutoAssignOnJoin: guildData.clanAutoAssignOnJoin,
        clanWeeklyDigest: guildData.clanWeeklyDigest,
        currentClanSeason: guildData.currentClanSeason,
        clanXpFromLevelUp: guildData.clanXpFromLevelUp,
        clanXpPerLevelUp: guildData.clanXpPerLevelUp,
        clanXpLevelUpProportional: guildData.clanXpLevelUpProportional,
        clanXpReferenceLevel: guildData.clanXpReferenceLevel,
        clanXpFromBoost: guildData.clanXpFromBoost,
        clanXpPerBoost: guildData.clanXpPerBoost,
        clanAnnouncementChannelId: guildData.clanAnnouncementChannelId,
        clanRewardGiveaway: guildData.clanRewardGiveaway,
        clanRewardXpBoost: guildData.clanRewardXpBoost,
        clanRewardXpBoostRate: guildData.clanRewardXpBoostRate,
        clanRewardLeaderRole: guildData.clanRewardLeaderRole,
        lastWinningClanId: guildData.lastWinningClanId,
        clanSeasonStartsAt: guildData.clanSeasonStartsAt,
        clanSeasonEndsAt: guildData.clanSeasonEndsAt,
        ...normalizeClanBetSettings(guildData),
        clans: clansWithStats,
        taskInProgress,
      });
    } catch (err) {
      logger.error('ClansAPI', 'Error fetching clans data:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des clans.' });
    }
    return true;
  }

  if (!subAction && method === 'PATCH') {
    try {
      const body = await readJsonBody<{
        clansEnabled?: boolean;
        clanAutoAssignOnJoin?: boolean;
        clanWeeklyDigest?: boolean;
        clanXpFromLevelUp?: boolean;
        clanXpPerLevelUp?: number;
        clanXpLevelUpProportional?: boolean;
        clanXpReferenceLevel?: number;
        clanXpFromBoost?: boolean;
        clanXpPerBoost?: number;
        clanAnnouncementChannelId?: string | null;
        clanRewardGiveaway?: boolean;
        clanRewardXpBoost?: boolean;
        clanRewardXpBoostRate?: number;
        clanRewardLeaderRole?: boolean;
        clanSeasonStartsAt?: string | null;
        clanSeasonEndsAt?: string | null;
        betsEnabled?: boolean;
        betChannelId?: string | null;
        betAnnouncementChannelId?: string | null;
        betMinStake?: number;
        betMaxStake?: number;
        betMaxOpenPerMember?: number;
        betAcceptWindowHours?: number;
        betAllowDebt?: boolean;
        betMaxDebt?: number;
        betDebtResetOnSeason?: boolean;
        betResolverRoleIds?: string[];
        betAllowPool?: boolean;
        betAllowTeams?: boolean;
        betAllowOpen?: boolean;
        betStakeMode?: BetStakeMode;
        betMaxParticipants?: number;
        betMaxSides?: number;
        betSeasonRewardEnabled?: boolean;
        betSeasonRewardRoleId?: string | null;
        betRewardTop1?: number;
        betRewardTop2?: number;
        betRewardTop3?: number;
      }>(req);

      const updateData: Record<string, any> = {};
      if (body?.clanAutoAssignOnJoin !== undefined) updateData.clanAutoAssignOnJoin = body.clanAutoAssignOnJoin;
      if (body?.clanWeeklyDigest !== undefined) updateData.clanWeeklyDigest = body.clanWeeklyDigest;
      if (body?.clanXpFromLevelUp !== undefined) updateData.clanXpFromLevelUp = body.clanXpFromLevelUp;
      if (body?.clanXpPerLevelUp !== undefined) {
        if (typeof body.clanXpPerLevelUp !== 'number' || body.clanXpPerLevelUp < 0) {
          json(res, 400, { error: 'Le nombre de points par passage de niveau doit être un entier positif.' });
          return true;
        }
        updateData.clanXpPerLevelUp = Math.min(MAX_CLAN_POINTS_PER_LEVEL_UP, Math.floor(body.clanXpPerLevelUp));
      }
      if (body?.clanXpLevelUpProportional !== undefined) updateData.clanXpLevelUpProportional = body.clanXpLevelUpProportional;
      if (body?.clanXpReferenceLevel !== undefined) {
        if (typeof body.clanXpReferenceLevel !== 'number' || body.clanXpReferenceLevel < MIN_CLAN_REFERENCE_LEVEL) {
          json(res, 400, { error: `Le niveau de référence doit être un entier supérieur ou égal à ${MIN_CLAN_REFERENCE_LEVEL}.` });
          return true;
        }
        updateData.clanXpReferenceLevel = Math.min(1_000, Math.floor(body.clanXpReferenceLevel));
      }
      if (body?.clanXpFromBoost !== undefined) updateData.clanXpFromBoost = body.clanXpFromBoost;
      if (body?.clanXpPerBoost !== undefined) {
        if (typeof body.clanXpPerBoost !== 'number' || body.clanXpPerBoost < 0) {
          json(res, 400, { error: 'Le nombre de points par boost doit être un entier positif.' });
          return true;
        }
        updateData.clanXpPerBoost = Math.min(MAX_CLAN_POINTS_PER_LEVEL_UP, Math.floor(body.clanXpPerBoost));
      }
      if (body?.clanAnnouncementChannelId !== undefined) updateData.clanAnnouncementChannelId = body.clanAnnouncementChannelId || null;
      if (body?.clanRewardGiveaway !== undefined) updateData.clanRewardGiveaway = body.clanRewardGiveaway;
      if (body?.clanRewardXpBoost !== undefined) updateData.clanRewardXpBoost = body.clanRewardXpBoost;
      if (body?.clanRewardXpBoostRate !== undefined) {
        if (typeof body.clanRewardXpBoostRate !== 'number' || body.clanRewardXpBoostRate < 1.0) {
          json(res, 400, { error: "Le taux de boost d'XP doit être supérieur ou égal à 1.0." });
          return true;
        }
        updateData.clanRewardXpBoostRate = body.clanRewardXpBoostRate;
      }
      if (body?.clanRewardLeaderRole !== undefined) updateData.clanRewardLeaderRole = body.clanRewardLeaderRole;
      if (body?.clanSeasonStartsAt !== undefined) {
        const startsAt = body.clanSeasonStartsAt ? new Date(body.clanSeasonStartsAt) : null;
        if (startsAt && Number.isNaN(startsAt.getTime())) {
          json(res, 400, { error: 'La date de début de saison est invalide.' });
          return true;
        }
        updateData.clanSeasonStartsAt = startsAt;
      }
      if (body?.clanSeasonEndsAt !== undefined) {
        const endsAt = body.clanSeasonEndsAt ? new Date(body.clanSeasonEndsAt) : null;
        if (endsAt && Number.isNaN(endsAt.getTime())) {
          json(res, 400, { error: 'La date de fin de saison est invalide.' });
          return true;
        }
        updateData.clanSeasonEndsAt = endsAt;
      }
      // La durée de la saison sert de gabarit pour toutes les suivantes : une fin
      // antérieure au début enchaînerait des saisons déjà expirées.
      if (updateData.clanSeasonStartsAt && updateData.clanSeasonEndsAt
        && updateData.clanSeasonEndsAt.getTime() <= updateData.clanSeasonStartsAt.getTime()) {
        json(res, 400, { error: 'La date de fin de saison doit être postérieure à la date de début.' });
        return true;
      }

      // Réglages de l'onglet Paris. Les bornes viennent de `@kotbo/shared` pour
      // que le formulaire et l'API refusent exactement les mêmes valeurs.
      if (body?.betsEnabled !== undefined) updateData.betsEnabled = body.betsEnabled;
      if (body?.betAllowDebt !== undefined) updateData.betAllowDebt = body.betAllowDebt;
      if (body?.betDebtResetOnSeason !== undefined) updateData.betDebtResetOnSeason = body.betDebtResetOnSeason;
      if (body?.betChannelId !== undefined) updateData.betChannelId = body.betChannelId || null;
      if (body?.betAnnouncementChannelId !== undefined) updateData.betAnnouncementChannelId = body.betAnnouncementChannelId || null;
      if (body?.betResolverRoleIds !== undefined) {
        if (!Array.isArray(body.betResolverRoleIds)) {
          json(res, 400, { error: 'La liste des rôles arbitres est invalide.' });
          return true;
        }
        updateData.betResolverRoleIds = [...new Set(
          body.betResolverRoleIds.filter((id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id)),
        )];
      }

      // Les mises sont normalisées ensemble : une mise minimale au-dessus de la
      // maximale rendrait tout pari impossible sans que rien ne le signale.
      if (body?.betMinStake !== undefined || body?.betMaxStake !== undefined) {
        const current = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { betMinStake: true, betMaxStake: true },
        });
        const normalized = normalizeClanBetSettings({
          betMinStake: body?.betMinStake ?? current?.betMinStake,
          betMaxStake: body?.betMaxStake ?? current?.betMaxStake,
        });
        updateData.betMinStake = normalized.betMinStake;
        updateData.betMaxStake = normalized.betMaxStake;
      }

      if (body?.betMaxOpenPerMember !== undefined) {
        if (typeof body.betMaxOpenPerMember !== 'number' || body.betMaxOpenPerMember < 1) {
          json(res, 400, { error: 'Le nombre de paris simultanés doit être un entier supérieur ou égal à 1.' });
          return true;
        }
        updateData.betMaxOpenPerMember = Math.min(BET_OPEN_PER_MEMBER_CEILING, Math.floor(body.betMaxOpenPerMember));
      }
      if (body?.betAcceptWindowHours !== undefined) {
        if (typeof body.betAcceptWindowHours !== 'number' || body.betAcceptWindowHours < BET_ACCEPT_WINDOW_HOURS_MIN) {
          json(res, 400, { error: `Le délai d'acceptation doit être d'au moins ${BET_ACCEPT_WINDOW_HOURS_MIN} heure.` });
          return true;
        }
        updateData.betAcceptWindowHours = Math.min(BET_ACCEPT_WINDOW_HOURS_MAX, Math.floor(body.betAcceptWindowHours));
      }
      if (body?.betMaxDebt !== undefined) {
        if (typeof body.betMaxDebt !== 'number' || body.betMaxDebt < 0) {
          json(res, 400, { error: 'Le plafond de dette doit être un entier positif.' });
          return true;
        }
        updateData.betMaxDebt = Math.min(BET_DEBT_CEILING, Math.floor(body.betMaxDebt));
      }

      for (const flag of ['betAllowPool', 'betAllowTeams', 'betAllowOpen'] as const) {
        if (body?.[flag] !== undefined) {
          if (typeof body[flag] !== 'boolean') {
            json(res, 400, { error: `Le réglage ${flag} doit être un booléen.` });
            return true;
          }
          updateData[flag] = body[flag];
        }
      }

      // Le mode par camp divise la mise entre les places d'un camp, ce qui exige
      // des camps à effectif fixe : la contrainte est appliquée à la création du
      // pari, où le nombre de places est connu.
      if (body?.betStakeMode !== undefined) {
        if (!BET_STAKE_MODES.includes(body.betStakeMode)) {
          json(res, 400, { error: 'Le mode de mise doit valoir PER_MEMBER ou PER_SIDE.' });
          return true;
        }
        updateData.betStakeMode = body.betStakeMode;
      }

      if (body?.betMaxParticipants !== undefined) {
        if (typeof body.betMaxParticipants !== 'number' || body.betMaxParticipants < BET_PARTICIPANTS_MIN) {
          json(res, 400, { error: `Un pari doit accepter au moins ${BET_PARTICIPANTS_MIN} participants.` });
          return true;
        }
        updateData.betMaxParticipants = Math.min(BET_PARTICIPANTS_CEILING, Math.floor(body.betMaxParticipants));
      }

      if (body?.betMaxSides !== undefined) {
        if (typeof body.betMaxSides !== 'number' || body.betMaxSides < BET_SIDES_MIN) {
          json(res, 400, { error: `Un pari doit compter au moins ${BET_SIDES_MIN} camps.` });
          return true;
        }
        updateData.betMaxSides = Math.min(BET_SIDES_CEILING, Math.floor(body.betMaxSides));
      }

      if (body?.betSeasonRewardEnabled !== undefined) {
        if (typeof body.betSeasonRewardEnabled !== 'boolean') {
          json(res, 400, { error: 'Le réglage betSeasonRewardEnabled doit être un booléen.' });
          return true;
        }
        updateData.betSeasonRewardEnabled = body.betSeasonRewardEnabled;
      }
      if (body?.betSeasonRewardRoleId !== undefined) {
        updateData.betSeasonRewardRoleId = body.betSeasonRewardRoleId || null;
      }

      // Les trois primes partagent la même borne : une prime sans plafond
      // verserait au podium plus de points que la saison n'en a distribués.
      for (const key of ['betRewardTop1', 'betRewardTop2', 'betRewardTop3'] as const) {
        if (body?.[key] === undefined) continue;
        if (typeof body[key] !== 'number' || body[key] < 0) {
          json(res, 400, { error: 'Une prime de fin de saison doit être un entier positif ou nul.' });
          return true;
        }
        updateData[key] = Math.min(BET_SEASON_REWARD_CEILING, Math.floor(body[key]));
      }

      if (Object.keys(updateData).length === 0 && body?.clansEnabled === undefined) {
        json(res, 400, { error: 'Aucune donnée valide à mettre à jour.' });
        return true;
      }

      // L'interrupteur de la page passe par la bascule de module plutôt que par
      // la colonne : elle seule tient la ligne du registre et la colonne au même
      // état, et invalide la garde d'exécution. Uniquement sur un vrai
      // changement : la page renvoie l'interrupteur à chaque enregistrement, et
      // la bascule republie les commandes du serveur au passage.
      if (body?.clansEnabled !== undefined) {
        const current = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { clansEnabled: true },
        });
        if (current && current.clansEnabled !== body.clansEnabled) {
          await setDashboardModuleStatus(guildId, 'clans', body.clansEnabled);
        }
      }

      const updatedGuild = Object.keys(updateData).length > 0
        ? await prisma.guild.update({ where: { id: guildId }, data: updateData })
        : await prisma.guild.findUniqueOrThrow({ where: { id: guildId } });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Clans',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Paramètres clans mis à jour. Activé: ${updatedGuild.clansEnabled}, Auto-assignation à la jointure: ${updatedGuild.clanAutoAssignOnJoin}, XP Level Up: ${updatedGuild.clanXpFromLevelUp} (${updatedGuild.clanXpPerLevelUp} pts)`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, {
        clansEnabled: updatedGuild.clansEnabled,
        clanAutoAssignOnJoin: updatedGuild.clanAutoAssignOnJoin,
        clanWeeklyDigest: updatedGuild.clanWeeklyDigest,
        clanXpFromLevelUp: updatedGuild.clanXpFromLevelUp,
        clanXpPerLevelUp: updatedGuild.clanXpPerLevelUp,
        clanXpLevelUpProportional: updatedGuild.clanXpLevelUpProportional,
        clanXpReferenceLevel: updatedGuild.clanXpReferenceLevel,
        clanXpFromBoost: updatedGuild.clanXpFromBoost,
        clanXpPerBoost: updatedGuild.clanXpPerBoost,
        clanAnnouncementChannelId: updatedGuild.clanAnnouncementChannelId,
        clanRewardGiveaway: updatedGuild.clanRewardGiveaway,
        clanRewardXpBoost: updatedGuild.clanRewardXpBoost,
        clanRewardXpBoostRate: updatedGuild.clanRewardXpBoostRate,
        clanRewardLeaderRole: updatedGuild.clanRewardLeaderRole,
        clanSeasonStartsAt: updatedGuild.clanSeasonStartsAt,
        clanSeasonEndsAt: updatedGuild.clanSeasonEndsAt,
        ...normalizeClanBetSettings(updatedGuild),
      });
    } catch (err) {
      logger.error('ClansAPI', 'Error updating clan settings:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration des clans.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans (Create Clan)
  if (!subAction && method === 'POST') {
    try {
      const body = await readJsonBody<{
        name: string;
        description?: string;
        roleId: string;
        generalChannelId?: string | null;
        leaderRoleId?: string | null;
      }>(req);

      if (!body?.name || !body?.roleId) {
        json(res, 400, { error: 'Le nom et le rôle du clan sont requis.' });
        return true;
      }

      // Vérifier si le rôle existe sur Discord
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        json(res, 400, { error: 'Serveur introuvable sur Discord.' });
        return true;
      }

      const roleExists = discordGuild.roles.cache.has(body.roleId);
      if (!roleExists) {
        json(res, 400, { error: "Le rôle sélectionné n'existe pas sur ce serveur Discord." });
        return true;
      }

      // Vérifier l'unicité du rôle
      const existingRoleClan = await prisma.clan.findUnique({
        where: { roleId: body.roleId },
      });
      if (existingRoleClan) {
        json(res, 400, { error: 'Ce rôle est déjà assigné à un autre clan.' });
        return true;
      }

      // Créer le clan
      const clan = await prisma.clan.create({
        data: {
          guildId,
          name: body.name,
          description: body.description ?? null,
          roleId: body.roleId,
          generalChannelId: body.generalChannelId ?? null,
          leaderRoleId: body.leaderRoleId ?? null,
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création de clan',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Clan "${clan.name}" créé avec le rôle ${clan.roleId}.`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 201, { clan });
    } catch (err) {
      logger.error('ClansAPI', 'Error creating clan:', err);
      json(res, 500, { error: 'Erreur lors de la création du clan.' });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/clans/:id
  if (subAction && !RESERVED_SUBACTIONS.has(subAction) && method === 'PUT') {
    try {
      const clanId = subAction;
      const body = await readJsonBody<{
        name: string;
        description?: string;
        roleId: string;
        generalChannelId?: string | null;
        leaderRoleId?: string | null;
      }>(req);

      if (!body?.name || !body?.roleId) {
        json(res, 400, { error: 'Le nom et le rôle du clan sont requis.' });
        return true;
      }

      // Vérifier l'existence du rôle sur Discord
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild && !discordGuild.roles.cache.has(body.roleId)) {
        json(res, 400, { error: "Le rôle sélectionné n'existe pas sur Discord." });
        return true;
      }

      // Vérifier l'unicité du rôle
      const existingRoleClan = await prisma.clan.findFirst({
        where: { roleId: body.roleId, id: { not: clanId } },
      });
      if (existingRoleClan) {
        json(res, 400, { error: 'Ce rôle est déjà attribué à un autre clan.' });
        return true;
      }

      const updatedClan = await prisma.clan.update({
        where: { id: clanId, guildId },
        data: {
          name: body.name,
          description: body.description ?? null,
          roleId: body.roleId,
          generalChannelId: body.generalChannelId ?? null,
          leaderRoleId: body.leaderRoleId ?? null,
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification de clan',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Clan "${updatedClan.name}" mis à jour. Rôle : ${updatedClan.roleId}.`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, { clan: updatedClan });
    } catch (err) {
      logger.error('ClansAPI', 'Error updating clan:', err);
      json(res, 500, { error: 'Erreur lors de la modification du clan.' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/clans/:id
  if (subAction && !RESERVED_SUBACTIONS.has(subAction) && method === 'DELETE') {
    try {
      const clanId = subAction;

      const deletedClan = await prisma.clan.delete({
        where: { id: clanId, guildId },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression de clan',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Clan "${deletedClan.name}" supprimé.`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('ClansAPI', 'Error deleting clan:', err);
      json(res, 500, { error: 'Erreur lors de la suppression du clan.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/distribute (Bulk Random Distribution)
  if (subAction === 'distribute' && method === 'POST') {
    try {
      const message = await runDistribution(guildId, client, auditUser);
      json(res, 200, { message });
    } catch (err: any) {
      logger.error('ClansAPI', 'Error launching distribution:', err);
      json(res, err.message.includes('en cours') || err.message.includes('configurer') ? 400 : 500, { error: err.message });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/clear (Bulk Remove Clan Roles)
  if (subAction === 'clear' && method === 'POST') {
    try {
      const message = await runClear(guildId, client, auditUser);
      json(res, 200, { message });
    } catch (err: any) {
      logger.error('ClansAPI', 'Error launching clear:', err);
      json(res, err.message.includes('en cours') || err.message.includes('Aucun clan') ? 400 : 500, { error: err.message });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/dedupe (Repair members with several clans)
  if (subAction === 'dedupe' && method === 'POST') {
    try {
      const message = await runDeduplicate(guildId, client, auditUser);
      json(res, 200, { message });
    } catch (err: any) {
      logger.error('ClansAPI', 'Error launching dedupe:', err);
      json(res, err.message.includes('en cours') || err.message.includes('deux clans') ? 400 : 500, { error: err.message });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/reset-season (New Season / Reset)
  if (subAction === 'reset-season' && method === 'POST') {
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { currentClanSeason: true, clanSeasonStartsAt: true, clanSeasonEndsAt: true },
      });

      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable.' });
        return true;
      }

      const nextSeason = guild.currentClanSeason + 1;

      let nextStartsAt: Date | null = null;
      let nextEndsAt: Date | null = null;

      // Cf. checkAndProgressClanSeasons : une durée nulle ou négative produirait
      // une saison immédiatement expirée, reclôturée par le cron toutes les 15 min.
      if (guild.clanSeasonStartsAt && guild.clanSeasonEndsAt) {
        const durationMs = guild.clanSeasonEndsAt.getTime() - guild.clanSeasonStartsAt.getTime();
        if (durationMs > 0) {
          nextStartsAt = new Date();
          nextEndsAt = new Date(nextStartsAt.getTime() + durationMs);
        }
      }

      // Le raid en cours est soldé avant que le compteur ne change : ses points sont
      // crédités dans la saison lue en base au moment du versement, et la fin de saison
      // part en arrière-plan juste après. Solder plus tard créditerait la saison suivante.
      await settleRaidBeforeSeasonEnd(guildId, client, guild.currentClanSeason);

      // 1. Mettre à jour la saison en base de données immédiatement
      await prisma.guild.update({
        where: { id: guildId },
        data: { 
          currentClanSeason: nextSeason,
          clanSeasonStartsAt: nextStartsAt,
          clanSeasonEndsAt: nextEndsAt,
        },
      });

      // 2. Décerner les bonus, renommer les QG et publier les annonces de fin de saison en arrière-plan
      void handleEndSeason(guildId, client, auditUser, guild.currentClanSeason, nextSeason).catch((err) => {
        logger.error('ClansAPI', 'Error handling end season in background:', err);
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Reset Saison de Clans',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Saison de clan réinitialisée. Nouvelle saison active: ${nextSeason}`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, { currentClanSeason: nextSeason });
    } catch (err) {
      logger.error('ClansAPI', 'Error resetting clan season:', err);
      json(res, 500, { error: 'Erreur lors de la réinitialisation de la saison.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/reset-all (Reset All Data)
  if (subAction === 'reset-all' && method === 'POST') {
    try {
      // 0. Le nettoyage des QG a besoin des clans avant que la base ne soit
      // vidée. Les rôles des membres ne sont pas touchés : un reset des données
      // ne défait pas l'appartenance des gens à leur clan.
      const clansToClean = await prisma.clan.findMany({
        where: { guildId },
        select: { generalChannelId: true },
      });
      void runClanArtifactCleanup(guildId, client, clansToClean, auditUser).catch((err) => {
        logger.error('ClansAPI', 'Error cleaning up clan artifacts:', err);
      });

      // 1. Supprimer toutes les contributions
      await prisma.clanMemberContribution.deleteMany({
        where: { guildId }
      });

      // 2. Supprimer tous les clans du serveur
      await prisma.clan.deleteMany({
        where: { guildId }
      });

      // 2 bis. Paris et dettes suivent les contributions : sans ce nettoyage, un
      // pari en cours désignerait des clans supprimés, et une dette resterait à
      // rembourser sur des points qui n'existent plus.
      await prisma.clanBet.deleteMany({ where: { guildId } });
      await prisma.clanPointDebt.deleteMany({ where: { guildId } });
      // Les instantanés partent aussi : conservés, ils rétabliraient au premier
      // retour arrière des dettes rattachées à des clans qui n'existent plus.
      await prisma.clanDebtSnapshot.deleteMany({ where: { guildId } });
      // La saison repart à 1 : garder les marques de primes versées priverait
      // les prochaines saisons de leur podium.
      await prisma.clanBetSeasonAward.deleteMany({ where: { guildId } });

      // 3. Réinitialiser la guilde
      await prisma.guild.update({
        where: { id: guildId },
        data: {
          currentClanSeason: 1,
          lastWinningClanId: null,
          clanSeasonStartsAt: null,
          clanSeasonEndsAt: null,
          clansEnabled: false,
        }
      });

      // 4. Audit
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Réinitialisation Totale des Clans',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: 'Réinitialisation totale des clans, contributions et retour à la saison 1. Balises de champion retirées des QG.',
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, { success: true });
    } catch (err: any) {
      logger.error('ClansAPI', 'Error resetting all clan data:', err);
      json(res, 500, { error: 'Erreur lors de la réinitialisation des données de clans.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/rollback-season (Rollback Last Season)
  if (subAction === 'rollback-season' && method === 'POST') {
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { currentClanSeason: true, clanRewardLeaderRole: true }
      });

      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable.' });
        return true;
      }

      const currentSeason = guild.currentClanSeason;
      if (currentSeason <= 1) {
        json(res, 400, { error: 'Impossible de retourner en arrière de la saison 1.' });
        return true;
      }

      const targetSeason = currentSeason - 1;
      const restoredSeason = targetSeason - 1; // La saison qui a déterminé le vainqueur de targetSeason

      // Un retour arrière rétablit l'état de fin de la saison visée, pas seulement
      // le numéro de saison : les paris joués depuis n'ont plus eu lieu, et les
      // dettes reviennent à ce qu'elles valaient à cette clôture.
      try {
        const { settleOpenBetsForSeason } = await import('../../../services/community/clanBetService.js');
        const { restoreClanDebts, dropClanDebtSnapshotsAfter } = await import('../../../services/community/clanDebtService.js');

        // Les paris encore ouverts sont soldés d'abord, pendant que les lignes de
        // contribution qui portent leurs mises existent encore : sans ça, un pari
        // survivrait à la saison et verserait plus tard un pot que plus personne
        // n'a payé.
        await settleOpenBetsForSeason(client, guildId, currentSeason);

        // Puis les paris de la saison abandonnée disparaissent avec elle, comme
        // ses contributions et ses événements. Les garder les rattacherait à une
        // saison qui n'existe plus, et la prochaine à porter ce numéro les
        // compterait dans son palmarès.
        const droppedBets = await prisma.clanBet.deleteMany({ where: { guildId, season: currentSeason } });

        // Les dettes reviennent ensuite à leur montant de fin de saison visée.
        // Après la suppression des paris : leur remboursement a pu en effacer une
        // partie, et l'instantané fait foi.
        const restored = await restoreClanDebts(guildId, targetSeason);
        await dropClanDebtSnapshotsAfter(guildId, targetSeason);

        // La clôture de la saison visée n'a plus eu lieu : sa marque de primes
        // versées s'en va avec elle, sinon la reclore laisserait son podium
        // sans récompense.
        await prisma.clanBetSeasonAward.deleteMany({ where: { guildId, season: { gte: targetSeason } } });

        logger.info(
          'ClansAPI',
          `Retour arrière ${currentSeason} vers ${targetSeason} sur ${guildId} : ${droppedBets.count} pari(s) supprimé(s), `
          + (restored === null ? 'dettes conservées faute d\'instantané.' : `${restored} dette(s) rétablie(s).`),
        );
      } catch (betErr) {
        logger.error('ClansAPI', `Retour arrière des paris et dettes de ${guildId} impossible :`, betErr);
      }

      // 1. Trouver le vainqueur de la saison restoredSeason (si >= 1)
      let restoredWinningClanId: string | null = null;
      if (restoredSeason >= 1) {
        const clans = await prisma.clan.findMany({ where: { guildId } });
        let maxXp = 0;
        for (const clan of clans) {
          const aggregate = await prisma.clanMemberContribution.aggregate({
            where: { guildId, clanId: clan.id, season: restoredSeason },
            _sum: { xp: true }
          });
          const xp = aggregate._sum.xp ?? 0;
          if (xp > maxXp) {
            maxXp = xp;
            restoredWinningClanId = clan.id;
          }
        }
      }

      // 2. Mettre à jour la guilde et supprimer les contributions de la saison annulée en BDD
      await prisma.guild.update({
        where: { id: guildId },
        data: {
          currentClanSeason: targetSeason,
          lastWinningClanId: restoredWinningClanId,
          clanSeasonStartsAt: null,
          clanSeasonEndsAt: null,
        }
      });

      await prisma.clanMemberContribution.deleteMany({
        where: { guildId, season: currentSeason }
      });
      await prisma.clanContributionEvent.deleteMany({
        where: { guildId, season: currentSeason }
      });

      // 3. Rétablir les rôles de chefs et renommer les QG Discord en arrière-plan
      (async () => {
        const clans = await prisma.clan.findMany({ where: { guildId } });
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!discordGuild) return;

        // Retirer les chefs actuels
        for (const clan of clans) {
          if (clan.leaderRoleId) {
            const role = discordGuild.roles.cache.get(clan.leaderRoleId) || await discordGuild.roles.fetch(clan.leaderRoleId).catch(() => null);
            if (role) {
              const members = Array.from(role.members.values());
              await Promise.all(members.map(m => m.roles.remove(clan.leaderRoleId!, "Annulation clôture saison").catch(() => null)));
            }
          }
        }

        // Rétablir les chefs de restoredSeason
        if (guild.clanRewardLeaderRole && restoredSeason >= 1) {
          for (const clan of clans) {
            if (clan.leaderRoleId) {
              // Même règle qu'à la clôture : un clan dont le score a été ramené
              // à zéro ne sacre personne. Les lignes des membres survivent au
              // retrait manuel, donc le seul total fait foi.
              const totalXp = (await prisma.clanMemberContribution.aggregate({
                where: { guildId, clanId: clan.id, season: restoredSeason },
                _sum: { xp: true },
              }))._sum.xp ?? 0;
              if (totalXp <= 0) continue;

              const top = await prisma.clanMemberContribution.findFirst({
                where: { guildId, clanId: clan.id, season: restoredSeason, userId: { not: CLAN_WIDE_USER_ID } },
                orderBy: { xp: 'desc' }
              });
              if (top && top.xp > 0) {
                const member = discordGuild.members.cache.get(top.userId) || await discordGuild.members.fetch(top.userId).catch(() => null);
                if (member) {
                  await member.roles.add(clan.leaderRoleId, `Rétablissement chef saison ${restoredSeason}`).catch(() => null);
                }
              }
            }
          }
        }
      })().catch((err) => {
        logger.error('ClansAPI', 'Error updating Discord elements during rollback:', err);
      });

      // 4. Audit
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Annulation Clôture de Saison',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Retour à la saison ${targetSeason} depuis la saison ${currentSeason}. Données de la saison ${currentSeason} supprimées.`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, { currentClanSeason: targetSeason });
    } catch (err: any) {
      logger.error('ClansAPI', 'Error rolling back clan season:', err);
      json(res, 500, { error: 'Erreur lors de l\'annulation de la saison.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/clans/points (Adjust points manually on a clan or a member, positive or negative)
  // GET /api/dashboard/guilds/:guildId/clans/bets
  //
  // Alimente l'onglet Paris : les paris récents et les dettes ouvertes. Les
  // dettes vivent hors saison, elles sont donc listées telles quelles et pas
  // filtrées sur la saison en cours.
  if (subAction === 'bets' && method === 'GET') {
    try {
      // Les totaux sont comptés par la base, pas déduits des lignes lues : celles-ci
      // s'arrêtent à 50, et l'onglet afficherait un historique tronqué sans que rien
      // ne le signale.
      const [bets, debts, betCount, debtCount] = await Promise.all([
        prisma.clanBet.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { sides: { orderBy: { position: 'asc' }, include: { participants: { orderBy: { joinedAt: 'asc' } } } } },
        }),
        // Plus large que les 50 lignes affichées : le classement se fait sur la
        // dette ferme, qui ne suit pas l'ordre des montants bruts.
        prisma.clanPointDebt.findMany({
          where: { guildId, amount: { gt: 0 } },
          orderBy: { amount: 'desc' },
          take: 200,
        }),
        prisma.clanBet.count({ where: { guildId } }),
        prisma.clanPointDebt.count({ where: { guildId, amount: { gt: 0 } } }),
      ]);

      const joinedOf = (bet: (typeof bets)[number]) =>
        bet.sides.flatMap((side) => side.participants.filter((entry) => entry.status === 'JOINED'));

      const clanIds = [...new Set(
        bets.flatMap((bet) => joinedOf(bet).map((entry) => entry.clanId))
          .filter((id): id is string => Boolean(id)),
      )];
      const clans = clanIds.length > 0
        ? await prisma.clan.findMany({ where: { id: { in: clanIds } }, select: { id: true, name: true } })
        : [];
      const clanNames = new Map(clans.map((clan) => [clan.id, clan.name]));

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const nameFor = (userId: string) =>
        discordGuild?.members.cache.get(userId)?.displayName ?? null;

      // Une dette se lit en deux morceaux : ce qui est ferme, et ce qui n'est
      // encore qu'engagé dans des paris non tranchés. Le tri porte sur le
      // ferme, seul montant qui ne peut plus disparaître tout seul.
      const { getEngagedBetCredit } = await import('../../../services/community/clanBetService.js');
      const engagedByUser = await getEngagedBetCredit(guildId, debts.map((debt) => debt.userId));
      const debtRows = debts
        .map((debt) => {
          const engaged = Math.min(debt.amount, engagedByUser.get(debt.userId) ?? 0);
          return {
            userId: debt.userId,
            displayName: nameFor(debt.userId),
            amount: debt.amount,
            engaged,
            firm: firmDebtOf(debt.amount, engaged),
            source: debt.source,
            createdAt: debt.createdAt,
          };
        })
        .sort((a, b) => b.firm - a.firm || b.amount - a.amount)
        .slice(0, 50);

      json(res, 200, {
        betCount,
        debtCount,
        bets: bets.map((bet) => {
          const joined = joinedOf(bet);
          return {
            id: bet.id,
            subject: bet.subject,
            stake: bet.stake,
            stakeMode: bet.stakeMode,
            shape: bet.shape,
            access: bet.access,
            season: bet.season,
            status: bet.status,
            sides: bet.sides.map((side) => ({
              id: side.id,
              label: side.label,
              capacity: side.capacity,
              won: side.id === bet.winningSideId,
              members: side.participants
                .filter((entry) => entry.status !== 'DECLINED')
                .map((entry) => ({
                  userId: entry.userId,
                  displayName: nameFor(entry.userId),
                  clanName: entry.clanId ? clanNames.get(entry.clanId) ?? null : null,
                  status: entry.status,
                  engaged: entry.escrow + entry.debt,
                  debt: entry.debt,
                  payout: entry.payout,
                })),
            })),
            pot: joined.reduce((sum, entry) => sum + entry.escrow + entry.debt, 0),
            creditUsed: joined.reduce((sum, entry) => sum + entry.debt, 0),
            winningSideId: bet.winningSideId,
            resolvedById: bet.resolvedById,
            resolvedAt: bet.resolvedAt,
            createdAt: bet.createdAt,
          };
        }),
        debts: debtRows,
      });
    } catch (err) {
      logger.error('ClansAPI', 'Error fetching bets:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des paris.' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/clans/bets/debts/:userId[?engaged=1]
  //
  // Efface une dette à la main. Utile après un incident : sans ce geste, un
  // membre endetté par erreur voit tous ses gains partir en remboursement.
  //
  // Seule la part ferme part par défaut : le crédit encore engagé dans des
  // paris non tranchés a été misé en connaissance de cause, et l'effacer
  // rendrait gratuits des paris toujours en jeu. `engaged=1` l'emporte quand
  // même, pour les incidents où le pari lui-même est en cause.
  if (subAction === 'bets' && parts[6] === 'debts' && parts[7] && method === 'DELETE') {
    const userId = parts[7];
    const includeEngaged = new URL(req.url ?? '', 'http://localhost').searchParams.get('engaged') === '1';
    try {
      const existing = await prisma.clanPointDebt.findUnique({
        where: { guildId_userId: { guildId, userId } },
        select: { amount: true },
      });
      if (!existing) {
        json(res, 200, { success: true, remaining: 0, cleared: 0 });
        return true;
      }

      let engaged = 0;
      if (!includeEngaged) {
        const { getEngagedBetCredit } = await import('../../../services/community/clanBetService.js');
        engaged = Math.min(existing.amount, (await getEngagedBetCredit(guildId, [userId])).get(userId) ?? 0);
      }

      // Tout est engagé et la case n'a pas été cochée : il n'y a rien à effacer,
      // et une ligne d'audit annonçant zéro point ferait croire à un geste.
      const cleared = existing.amount - engaged;
      if (cleared <= 0) {
        json(res, 200, { success: true, remaining: engaged, cleared: 0 });
        return true;
      }

      if (engaged > 0) {
        await prisma.clanPointDebt.update({
          where: { guildId_userId: { guildId, userId } },
          data: { amount: engaged },
        });
      } else {
        await prisma.clanPointDebt.deleteMany({ where: { guildId, userId } });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Effacement d\'une dette de points de clan',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: engaged > 0
          ? `${cleared} point(s) de dette effacé(s) pour ${userId} ; ${engaged} laissé(s) en jeu sur des paris en cours.`
          : `Dette de ${cleared} point(s) effacée pour ${userId}${includeEngaged ? ', crédit des paris en cours compris' : ''}.`,
        channelId: null,
      });
      broadcastDashboardStateChange(guildId, 'clans_updated');
      json(res, 200, { success: true, remaining: engaged, cleared });
    } catch (err) {
      logger.error('ClansAPI', 'Error clearing clan point debt:', err);
      json(res, 500, { error: 'Erreur lors de l\'effacement de la dette.' });
    }
    return true;
  }

  if (subAction === 'points' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        clanId?: string | null;
        userId?: string | null;
        amount: number;
      }>(req);

      if (typeof body?.amount !== 'number') {
        json(res, 400, { error: 'Le paramètre amount (nombre) est requis.' });
        return true;
      }

      // La base ne stocke pas de décimale, et un montant nul n'ajuste rien.
      // Le signe porte le sens : positif pour un ajout, négatif pour un retrait.
      if (!Number.isInteger(body.amount) || body.amount === 0) {
        json(res, 400, { error: 'Le montant doit être un nombre entier non nul (pas de décimale).' });
        return true;
      }
      if (Math.abs(body.amount) > MAX_MANUAL_POINTS) {
        json(res, 400, { error: `Le montant ne peut pas dépasser ${MAX_MANUAL_POINTS.toLocaleString('fr-FR')} points.` });
        return true;
      }

      // 1. Récupérer la saison en cours
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { currentClanSeason: true }
      });
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable.' });
        return true;
      }
      const season = guild.currentClanSeason;

      let resolvedClanId: string;
      let resolvedClanName: string;
      let targetUserId: string;

      if (body.userId?.trim()) {
        const userId = body.userId.trim();

        // Récupérer le membre Discord et ses rôles
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!discordGuild) {
          json(res, 500, { error: "Impossible d'accéder au serveur Discord." });
          return true;
        }

        const member = discordGuild.members.cache.get(userId) || await discordGuild.members.fetch(userId).catch(() => null);
        if (!member) {
          json(res, 404, { error: "L'utilisateur est introuvable sur le serveur Discord." });
          return true;
        }

        // S'assurer que le profil membre existe en base de données. Le membre
        // Discord est résolu avant, pour ne jamais créer de profil anonyme.
        await prisma.memberProfile.upsert({
          where: { guildId_userId: { guildId, userId } },
          update: {},
          create: { guildId, userId, ...memberProfileIdentity(member) },
        }).catch(() => null);

        const clans = await prisma.clan.findMany({ where: { guildId } });
        const memberClan = clans.find(c => member.roles.cache.has(c.roleId));
        if (!memberClan) {
          json(res, 400, { error: "Ce membre n'appartient à aucun clan configuré sur Discord." });
          return true;
        }

        resolvedClanId = memberClan.id;
        resolvedClanName = memberClan.name;

        // Résoudre l'identifiant Double Compte (DC) canonique
        const { getAllLinkedUserIds } = await import('../../../services/moderation/altAccountService.js');
        const linkedIds = await getAllLinkedUserIds(guildId, userId).catch(() => [userId]);
        targetUserId = linkedIds.sort()[0];
      } else {
        if (!body.clanId) {
          json(res, 400, { error: 'Le paramètre clanId est requis si aucun utilisateur n\'est spécifié.' });
          return true;
        }

        // Vérifier si le clan existe
        const clan = await prisma.clan.findUnique({
          where: { id: body.clanId }
        });
        if (!clan || clan.guildId !== guildId) {
          json(res, 404, { error: 'Clan introuvable pour ce serveur.' });
          return true;
        }

        resolvedClanId = clan.id;
        resolvedClanName = clan.name;
        targetUserId = CLAN_WIDE_USER_ID;
      }

      // 2. Un retrait ne peut pas dépasser ce qui existe. Le solde est lu avant
      // d'écrire : sans ça, un retrait sur un compteur vide renverrait un succès
      // sans rien avoir retiré.
      //
      // Les points donnés au clan entier vivent sur un pseudo-membre, mais le
      // total affiché est la somme de toutes les lignes de la saison : un retrait
      // « global » se mesure donc sur ce total, pas sur la seule cagnotte
      // manuelle, sinon il ne mordrait presque jamais.
      const isClanWide = targetUserId === CLAN_WIDE_USER_ID;
      let effectiveAmount = body.amount;

      if (body.amount < 0) {
        const available = isClanWide
          ? (await prisma.clanMemberContribution.aggregate({
              where: { guildId, clanId: resolvedClanId, season },
              _sum: { xp: true },
            }))._sum.xp ?? 0
          : (await prisma.clanMemberContribution.findUnique({
              where: { guildId_clanId_userId_season: { guildId, clanId: resolvedClanId, userId: targetUserId, season } },
              select: { xp: true },
            }))?.xp ?? 0;

        if (available <= 0) {
          json(res, 400, {
            error: isClanWide
              ? "Ce clan n'a aucun point à retirer sur la saison en cours."
              : "Ce membre n'a aucun point à retirer sur la saison en cours.",
          });
          return true;
        }

        effectiveAmount = Math.max(body.amount, -available);
      }

      // 3. Créditer la contribution, plafond de saison compris
      const { creditClanContribution, logClanContribution } = await import('../../../services/community/clanService.js');
      const { granted, contribution, debtRepaid } = await creditClanContribution({
        guildId,
        clanId: resolvedClanId,
        userId: targetUserId,
        season,
        amount: effectiveAmount,
        allowNegativeBalance: isClanWide,
      });

      let appliedAmount = granted;
      let appliedContribution = contribution;

      // 4. Le disponible a été lu avant l'écriture : deux retraits partis en
      // même temps le lisent tous les deux et se cumulent, ce qui ferait passer
      // le total du clan sous zéro. On relit donc après coup et on rend
      // l'excédent.
      //
      // Chacun ne rend que ce qu'il a lui-même retiré : rendre tout l'excédent
      // ferait rapporter un gain à qui venait de retirer, et l'audit mentirait.
      // Le reste est réparé par les retraits concurrents, qui passent tous ici.
      //
      // Un retrait sur un membre n'a pas besoin de cette correction : son
      // plancher est celui de sa propre ligne, que `creditClanContribution`
      // applique après l'incrément, donc à l'abri de la concurrence.
      if (isClanWide && granted < 0) {
        const total = (await prisma.clanMemberContribution.aggregate({
          where: { guildId, clanId: resolvedClanId, season },
          _sum: { xp: true },
        }))._sum.xp ?? 0;

        const refund = Math.min(-total, -granted);
        if (refund > 0) {
          const corrected = await prisma.clanMemberContribution.update({
            where: { guildId_clanId_userId_season: { guildId, clanId: resolvedClanId, userId: targetUserId, season } },
            data: { xp: { increment: refund } },
          }).catch(() => null);

          if (corrected) {
            appliedAmount = granted + refund;
            appliedContribution = corrected;
            logger.warn(
              'ClansAPI',
              `Retrait concurrent sur le clan ${resolvedClanId} : ${refund} XP rendus pour ne pas passer sous zéro.`,
            );
          }
        }
      }

      // Journaliser le mouvement pour le flux public « derniers scores », après
      // la correction. Le montant est brut : la part éventuellement partie en
      // remboursement d'une dette y est déjà journalisée à part, en négatif, et
      // loguer le net ferait deux lignes qui ne s'additionnent pas au geste de
      // l'administrateur.
      const loggedAmount = appliedAmount + debtRepaid;
      if (loggedAmount !== 0) {
        await logClanContribution(guildId, resolvedClanId, targetUserId, loggedAmount, 'ADMIN', season);
      }

      const isRemoval = body.amount < 0;
      await pushAudit(guildId, {
        user: auditUser,
        action: isRemoval ? 'Retrait de points de clan' : 'Ajout de points de clan',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `${isRemoval ? 'Retrait' : 'Ajout'} manuel de ${Math.abs(loggedAmount)} XP ${isRemoval ? 'sur le' : 'au'} clan "${resolvedClanName}"`
          + (body.userId ? ` pour l'utilisateur ${body.userId}` : ' (global)')
          + (loggedAmount !== body.amount ? ` (${Math.abs(body.amount)} demandés, borné par le total de la saison)` : '')
          + (debtRepaid > 0 ? ` - dont ${debtRepaid} partis en remboursement de dette` : ''),
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      // `granted` reste le net inscrit au classement ; `debtRepaid` explique
      // l'écart avec le montant demandé, sans quoi la page annoncerait « 30
      // points ajoutés » à qui en a saisi 100.
      json(res, 200, { success: true, granted: appliedAmount, debtRepaid, contribution: appliedContribution });
    } catch (err) {
      logger.error('ClansAPI', 'Error adjusting manual points:', err);
      json(res, 500, { error: 'Erreur lors de l\'ajustement manuel de points.' });
    }
    return true;
  }

  return false;
}
