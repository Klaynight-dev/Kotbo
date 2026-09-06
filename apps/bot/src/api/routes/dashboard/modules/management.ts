/** Routes dashboard du module `management`. */
import prisma from '../../../../utils/db.js';
import { cache } from '../../../../utils/cache.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

export async function handleManagementRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, access, method, auditUser, moduleKey } = ctx;

  // Management feature routes (role-access)
  if (moduleKey === 'management') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Accès refusé. Permissions administratives requises.' });
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/management/features/:featureKey/role-access
    if (parts.length === 8 && parts[5] === 'features' && parts[7] === 'role-access' && method === 'PUT') {
      const featureKey = parts[6];
      try {
        const body = await readJsonBody<{
          roleAccessConfigs: Array<{
            roleId: string;
            canView?: boolean;
            canModerate?: boolean;
            canConfigure?: boolean;
            canDelete?: boolean;
          }>;
        }>(req);

        if (!body || !Array.isArray(body.roleAccessConfigs)) {
          json(res, 400, { error: "Payload d'accès de rôle invalide" });
          return true;
        }

        const featureConfig = await prisma.dashboardFeatureConfig.findUnique({
          where: {
            guildId_featureKey: { guildId, featureKey }
          }
        });

        if (!featureConfig) {
          json(res, 404, { error: 'Configuration du module introuvable' });
          return true;
        }

        const { updateRoleAccess } = await import('../../../../services/core/dashboardManagementService.js');
        const updated = await updateRoleAccess(guildId, featureConfig.id, body.roleAccessConfigs);

        // Les droits de dashboard sont mis en cache sous le prefixe `guild:`.
        // Sans purge, un membre garde ses anciens acces jusqu'a une minute.
        await cache.invalidateGuild(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour accès rôle',
          context: getGuildName(client, guildId),
          module: 'Configuration',
          eventType: 'Manuel',
          details: `Accès rôles pour le module "${featureKey}" mis à jour (${body.roleAccessConfigs.length} rôles).`,
          channelId: null
        });

        json(res, 200, { ok: true, config: updated });
      } catch (err) {
        logger.error('ManagementAPI', `Error updating role access for ${featureKey}:`, err);
        json(res, 500, { error: 'Erreur lors de la mise à jour des permissions du module' });
      }
      return true;
    }
  }

  return false;
}
