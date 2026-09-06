import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import { errorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { formatGuildDateTime } from '../../../../utils/timezone.js';
import {
  json,
  readJsonBody,
  getGuildName,
  
  pushAudit,
  
  
  
  
} from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  getCalls,
  createCall,
  updateCall,
  deleteCall,
  getCallPermissionConfig,
  updateCallPermissionConfig,
  canUserCreateCall,
  
  
  
  
} from '../../../../services/staff/staffLeadershipService.js';

export async function handleCallRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;

    if (parts[4] === 'calls') {
      // GET /api/dashboard/guilds/:guildId/calls
      if (parts.length === 5 && method === 'GET') {
        try {
          const calls = await getCalls(guildId);
          json(res, 200, { calls });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting calls:', err);
          json(res, 500, { error: 'Erreur lors de la récupération des appels' });
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/calls
      if (parts.length === 5 && method === 'POST') {
        try {
          const body = await readJsonBody<{
            title: string;
            description?: string | null;
            scheduledAt: string;
            channelMode: string;
            channelType?: string | null;
            discordChannelId?: string | null;
            isTempChannel?: boolean;
            inviteeUserIds?: string[];
          }>(req);

          if (!body?.title || !body?.scheduledAt || !body?.channelMode) {
            json(res, 400, { error: 'title, scheduledAt et channelMode sont obligatoires' });
            return true;
          }

          const scheduledAt = new Date(body.scheduledAt);
          if (Number.isNaN(scheduledAt.getTime())) {
            json(res, 400, { error: "Date d'appel invalide" });
            return true;
          }

          if (!access.canManageSettings && access.level !== 'admin') {
            const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
            const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
            const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
            const allowed = await canUserCreateCall(guildId, user.userId, roleIds);
            if (!allowed) {
              json(res, 403, { error: "Vous n'avez pas la permission de planifier des appels." });
              return true;
            }
          }

          const call = await createCall(
            client,
            guildId,
            user.userId,
            body.title,
            body.description || null,
            scheduledAt,
            body.channelMode,
            body.channelType || null,
            body.discordChannelId || null,
            body.isTempChannel !== false,
            body.inviteeUserIds || []
          );

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Création appel',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Appel "${body.title}" planifié pour le ${await formatGuildDateTime(guildId, scheduledAt)}`,
            channelId: null,
          });

          json(res, 201, { call });
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error creating call:', err);
          json(res, 500, { error: errorMessage(err) || "Erreur lors de la planification de l'appel" });
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/calls/:callId
      if (parts.length === 6 && method === 'PATCH') {
        const callId = parts[5];
        try {
          const body = await readJsonBody<{
            title?: string;
            description?: string | null;
            scheduledAt?: string;
            endedAt?: string;
            status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';
            invitees?: string[];
          }>(req);

          const updateData: Record<string, unknown> = {};
          if (body?.title) updateData.title = body.title;
          if (body?.description !== undefined) updateData.description = body.description;
          if (body?.scheduledAt) updateData.scheduledAt = new Date(body.scheduledAt);
          if (body?.endedAt) updateData.endedAt = new Date(body.endedAt);
          if (body?.status) updateData.status = body.status;
          if (body?.invitees) updateData.invitees = body.invitees;

          const call = await updateCall(client, guildId, callId, updateData);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Mise à jour appel',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Appel ${callId} mis à jour. Statut: ${call.status}`,
            channelId: null,
          });

          json(res, 200, { call });
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error updating call:', err);
          json(res, 500, { error: errorMessage(err) || "Erreur lors de la mise à jour de l'appel" });
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/calls/:callId
      if (parts.length === 6 && method === 'DELETE') {
        const callId = parts[5];
        try {
          await deleteCall(client, guildId, callId);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Suppression appel',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Appel ${callId} supprimé`,
            channelId: null,
          });

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting call:', err);
          json(res, 500, { error: "Erreur lors de la suppression de l'appel" });
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/calls/config
      if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
        try {
          const config = await getCallPermissionConfig(guildId);

          let canCreate = access.canManageSettings || access.level === 'admin';
          if (!canCreate) {
            const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
            const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
            const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
            canCreate = await canUserCreateCall(guildId, user.userId, roleIds);
          }

          json(res, 200, { config, canCreate });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting call permission config:', err);
          json(res, 500, { error: 'Erreur lors de la récupération de la configuration des appels' });
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/calls/config
      if (parts.length === 6 && parts[5] === 'config' && method === 'POST') {
        if (!access.canManageSettings) {
          json(res, 403, { error: 'Accès refusé' });
          return true;
        }

        try {
          const body = await readJsonBody<{
            mode: 'EVERYONE' | 'RESTRICTED';
            allowedRoleIds?: string[];
            allowedUserIds?: string[];
          }>(req);

          if (body?.mode !== 'EVERYONE' && body?.mode !== 'RESTRICTED') {
            json(res, 400, { error: 'mode doit être EVERYONE ou RESTRICTED' });
            return true;
          }

          const config = await updateCallPermissionConfig(guildId, {
            mode: body.mode,
            allowedRoleIds: Array.isArray(body.allowedRoleIds) ? body.allowedRoleIds.filter((id) => typeof id === 'string') : [],
            allowedUserIds: Array.isArray(body.allowedUserIds) ? body.allowedUserIds.filter((id) => typeof id === 'string') : [],
          });

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Mise à jour permissions appels',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Mode: ${config.mode}, Rôles: ${config.allowedRoleIds.length}, Membres: ${config.allowedUserIds.length}`,
            channelId: null,
          });

          json(res, 200, { config });
        } catch (err) {
          logger.error('StaffAPI', 'Error updating call permission config:', err);
          json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration des appels' });
        }
        return true;
      }
    }

  return false;
}
