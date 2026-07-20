import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, getGuildName, pushAudit, broadcastDashboardStateChange, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { clanTasks, runDistribution, runClear, handleEndSeason } from '../../../services/community/clanService.js';

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
          clansUnique: true,
          currentClanSeason: true,
          clanXpFromLevelUp: true,
          clanXpPerLevelUp: true,
          clanAnnouncementChannelId: true,
          clanRewardGiveaway: true,
          clanRewardXpBoost: true,
          clanRewardXpBoostRate: true,
          clanRewardLeaderRole: true,
          lastWinningClanId: true,
          clanSeasonStartsAt: true,
          clanSeasonEndsAt: true,
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
        clansUnique: guildData.clansUnique,
        currentClanSeason: guildData.currentClanSeason,
        clanXpFromLevelUp: guildData.clanXpFromLevelUp,
        clanXpPerLevelUp: guildData.clanXpPerLevelUp,
        clanAnnouncementChannelId: guildData.clanAnnouncementChannelId,
        clanRewardGiveaway: guildData.clanRewardGiveaway,
        clanRewardXpBoost: guildData.clanRewardXpBoost,
        clanRewardXpBoostRate: guildData.clanRewardXpBoostRate,
        clanRewardLeaderRole: guildData.clanRewardLeaderRole,
        lastWinningClanId: guildData.lastWinningClanId,
        clanSeasonStartsAt: guildData.clanSeasonStartsAt,
        clanSeasonEndsAt: guildData.clanSeasonEndsAt,
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
        clansUnique?: boolean;
        clanXpFromLevelUp?: boolean;
        clanXpPerLevelUp?: number;
        clanAnnouncementChannelId?: string | null;
        clanRewardGiveaway?: boolean;
        clanRewardXpBoost?: boolean;
        clanRewardXpBoostRate?: number;
        clanRewardLeaderRole?: boolean;
        clanSeasonStartsAt?: string | null;
        clanSeasonEndsAt?: string | null;
      }>(req);

      const updateData: Record<string, any> = {};
      if (body?.clansEnabled !== undefined) updateData.clansEnabled = body.clansEnabled;
      if (body?.clansUnique !== undefined) updateData.clansUnique = body.clansUnique;
      if (body?.clanXpFromLevelUp !== undefined) updateData.clanXpFromLevelUp = body.clanXpFromLevelUp;
      if (body?.clanXpPerLevelUp !== undefined) {
        if (typeof body.clanXpPerLevelUp !== 'number' || body.clanXpPerLevelUp < 0) {
          json(res, 400, { error: 'Le nombre de points par passage de niveau doit être un entier positif.' });
          return true;
        }
        updateData.clanXpPerLevelUp = Math.floor(body.clanXpPerLevelUp);
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
        updateData.clanSeasonStartsAt = body.clanSeasonStartsAt ? new Date(body.clanSeasonStartsAt) : null;
      }
      if (body?.clanSeasonEndsAt !== undefined) {
        updateData.clanSeasonEndsAt = body.clanSeasonEndsAt ? new Date(body.clanSeasonEndsAt) : null;
      }

      if (Object.keys(updateData).length === 0) {
        json(res, 400, { error: 'Aucune donnée valide à mettre à jour.' });
        return true;
      }

      const updatedGuild = await prisma.guild.update({
        where: { id: guildId },
        data: updateData,
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Clans',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Paramètres clans mis à jour. Activé: ${updatedGuild.clansEnabled}, Unique: ${updatedGuild.clansUnique}, XP Level Up: ${updatedGuild.clanXpFromLevelUp} (${updatedGuild.clanXpPerLevelUp} pts)`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, {
        clansEnabled: updatedGuild.clansEnabled,
        clansUnique: updatedGuild.clansUnique,
        clanXpFromLevelUp: updatedGuild.clanXpFromLevelUp,
        clanXpPerLevelUp: updatedGuild.clanXpPerLevelUp,
        clanAnnouncementChannelId: updatedGuild.clanAnnouncementChannelId,
        clanRewardGiveaway: updatedGuild.clanRewardGiveaway,
        clanRewardXpBoost: updatedGuild.clanRewardXpBoost,
        clanRewardXpBoostRate: updatedGuild.clanRewardXpBoostRate,
        clanRewardLeaderRole: updatedGuild.clanRewardLeaderRole,
        clanSeasonStartsAt: updatedGuild.clanSeasonStartsAt,
        clanSeasonEndsAt: updatedGuild.clanSeasonEndsAt,
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
  if (subAction && subAction !== 'distribute' && subAction !== 'clear' && subAction !== 'reset-season' && subAction !== 'points' && method === 'PUT') {
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
  if (subAction && subAction !== 'distribute' && subAction !== 'clear' && subAction !== 'reset-season' && subAction !== 'points' && method === 'DELETE') {
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
      json(res, err.message.includes('déjà en cours') || err.message.includes('configurer') ? 400 : 500, { error: err.message });
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
      json(res, err.message.includes('déjà en cours') || err.message.includes('Aucun clan') ? 400 : 500, { error: err.message });
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

      if (guild.clanSeasonStartsAt && guild.clanSeasonEndsAt) {
        const durationMs = guild.clanSeasonEndsAt.getTime() - guild.clanSeasonStartsAt.getTime();
        nextStartsAt = new Date();
        nextEndsAt = new Date(nextStartsAt.getTime() + durationMs);
      }

      // 1. Décerner les bonus, renommer les QG et publier les annonces de fin de saison
      await handleEndSeason(guildId, client, auditUser, guild.currentClanSeason, nextSeason);

      // 2. Mettre à jour la saison en base de données
      await prisma.guild.update({
        where: { id: guildId },
        data: { 
          currentClanSeason: nextSeason,
          clanSeasonStartsAt: nextStartsAt,
          clanSeasonEndsAt: nextEndsAt,
        },
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
      // 1. Supprimer toutes les contributions
      await prisma.clanMemberContribution.deleteMany({
        where: { guildId }
      });

      // 2. Supprimer tous les clans du serveur
      await prisma.clan.deleteMany({
        where: { guildId }
      });

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
        details: 'Réinitialisation totale des clans, contributions et retour à la saison 1.',
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

      // 2. Mettre à jour la guilde
      await prisma.guild.update({
        where: { id: guildId },
        data: {
          currentClanSeason: targetSeason,
          lastWinningClanId: restoredWinningClanId,
          clanSeasonStartsAt: null,
          clanSeasonEndsAt: null,
        }
      });

      // 3. Supprimer toutes les contributions de la saison "annulée" (currentSeason)
      await prisma.clanMemberContribution.deleteMany({
        where: { guildId, season: currentSeason }
      });

      // 4. Rétablir les rôles de chefs de clan
      const clans = await prisma.clan.findMany({ where: { guildId } });
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        // Retirer les chefs actuels
        for (const clan of clans) {
          if (clan.leaderRoleId) {
            const role = discordGuild.roles.cache.get(clan.leaderRoleId) || await discordGuild.roles.fetch(clan.leaderRoleId).catch(() => null);
            if (role) {
              for (const [, m] of role.members) {
                await m.roles.remove(clan.leaderRoleId, "Annulation clôture saison").catch(() => null);
              }
            }
          }
        }

        // Rétablir les chefs de restoredSeason
        if (guild.clanRewardLeaderRole && restoredSeason >= 1) {
          for (const clan of clans) {
            if (clan.leaderRoleId) {
              const top = await prisma.clanMemberContribution.findFirst({
                where: { guildId, clanId: clan.id, season: restoredSeason, userId: { not: 'system_manual_points' } },
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

        // 5. Renommer les catégories QG pour le vainqueur rétabli
        const { ChannelType } = await import('discord.js');
        for (const clan of clans) {
          if (clan.generalChannelId) {
            const channel = discordGuild.channels.cache.get(clan.generalChannelId) || await discordGuild.channels.fetch(clan.generalChannelId).catch(() => null);
            if (channel && channel.type === ChannelType.GuildCategory) {
              const isWinner = restoredWinningClanId && clan.id === restoredWinningClanId;
              const cleanName = channel.name.replace(/^\[🏆\s*.*?\]\s*/, '');
              const targetName = isWinner ? `[🏆 ${clan.name}] ${cleanName}` : cleanName;
              if (channel.name !== targetName) {
                await channel.setName(targetName, "Annulation clôture saison").catch(() => null);
              }
            }
          }
        }
      }

      // 6. Audit
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

  // POST /api/dashboard/guilds/:guildId/clans/points (Add points manually to a clan or a member)
  if (subAction === 'points' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        clanId?: string | null;
        userId?: string | null;
        amount: number;
      }>(req);

      if (typeof body.amount !== 'number') {
        json(res, 400, { error: 'Le paramètre amount (nombre) est requis.' });
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
        // Vérifier si l'utilisateur existe dans la base de données
        const dbMember = await prisma.member.findUnique({
          where: { id: userId }
        });
        if (!dbMember) {
          json(res, 404, { error: "L'utilisateur n'existe pas dans la base de données de Kotbo (il doit interagir sur Discord d'abord)." });
          return true;
        }

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
        targetUserId = 'system_manual_points';
      }

      // 2. Upsert la contribution
      const contribution = await prisma.clanMemberContribution.upsert({
        where: {
          guildId_clanId_userId_season: {
            guildId,
            clanId: resolvedClanId,
            userId: targetUserId,
            season,
          }
        },
        update: {
          xp: { increment: body.amount }
        },
        create: {
          guildId,
          clanId: resolvedClanId,
          userId: targetUserId,
          season,
          xp: body.amount
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Ajout de points de clan',
        context: getGuildName(client, guildId),
        module: 'Clans',
        eventType: 'Manuel',
        details: `Ajout manuel de ${body.amount} XP au clan "${resolvedClanName}"` + (body.userId ? ` pour l'utilisateur ${body.userId}` : ' (global)'),
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'clans_updated');

      json(res, 200, { success: true, contribution });
    } catch (err) {
      logger.error('ClansAPI', 'Error adding manual points:', err);
      json(res, 500, { error: 'Erreur lors de l\'ajout de points manuel.' });
    }
    return true;
  }

  return false;
}
