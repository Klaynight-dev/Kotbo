/** Routes dashboard du module `notifications`. */
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, getOrCreateRuntime, json, type NotificationSettings, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

export async function handleNotificationsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, access, method, auditUser, moduleKey } = ctx;

  // GET /api/dashboard/guilds/:guildId/notifications/features
  if (moduleKey === 'notifications' && parts.length === 6 && parts[5] === 'features' && method === 'GET') {
    try {
      const { getOrCreateFeatureConfigs } = await import('../../../../services/core/dashboardManagementService.js');
      const configs = await getOrCreateFeatureConfigs(guildId);
      json(res, 200, { features: configs });
    } catch (err) {
      logger.error('NotificationsAPI', 'Error fetching feature configurations:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des configurations des modules' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/notifications/features/:featureKey
  if (moduleKey === 'notifications' && parts.length === 7 && parts[5] === 'features' && method === 'PATCH') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Accès refusé. Permissions administratives requises.' });
      return true;
    }

    const featureKey = parts[6];
    try {
      const body = await readJsonBody<{
        channelId?: string | null;
        secondaryChannelId?: string | null;
        requiredRoleId?: string | null;
        notificationRoleId?: string | null;
        notifyViaDiscordChannel?: boolean;
        notifyViaDM?: boolean;
        loggingEnabled?: boolean;
        userActivityTracking?: boolean;
        metadata?: Record<string, unknown>;
      }>(req);

      if (!body) {
        json(res, 400, { error: 'Payload de configuration invalide' });
        return true;
      }

      // Cette route ecrit la ligne de configuration, rien d'autre. Y accepter
      // `enabled` en faisait une seconde porte pour allumer un module : la
      // colonne changeait, mais sans la cascade des dependances, sans le
      // controle de l'offre, sans les tables propres au module et sans purge du
      // cache d'etats - la page disait une chose et le bot en faisait une autre.
      // L'activation passe par PUT /modules/:moduleId, qui fait les cinq.
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        json(res, 400, {
          error: "L'activation d'un module ne s'ecrit pas ici. Utiliser PUT /modules/:moduleId.",
          code: 'use_module_route',
        });
        return true;
      }

      const { updateFeatureConfig } = await import('../../../../services/core/dashboardManagementService.js');
      const updated = await updateFeatureConfig(guildId, featureKey, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour module',
        context: getGuildName(client, guildId),
        module: 'Configuration',
        eventType: 'Manuel',
        details: `Configuration du module "${featureKey}" mise à jour.`,
        channelId: null
      });

      json(res, 200, { ok: true, config: updated });
    } catch (err) {
      logger.error('NotificationsAPI', `Error updating feature configuration for ${featureKey}:`, err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration du module' });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/notifications
  if (moduleKey === 'notifications' && parts.length === 5 && method === 'PUT') {
    try {
      const body = await readJsonBody<NotificationSettings>(req);
      if (!body) {
        json(res, 400, { error: 'Payload notifications invalide' });
        return true;
      }

      const runtime = await getOrCreateRuntime(guildId);

      await prisma.guild.update({
        where: { id: guildId },
        data: {
          statusCheckChannelId: body.discordChannel?.replace(/[^0-9]/g, '') || null
        }
      });

      await prisma.dashboardSettings.update({
        where: { guildId },
        data: {
          email: body.email ?? '',
          emailEnabled: !!body.emailEnabled,
          cloudBackup: !!body.cloudBackup,
          debugLog: !!body.debugLog,
          killSwitchEnabled: !!body.killSwitchEnabled,
          severityByModule: body.severityByModule ?? runtime.severityByModule
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde notifications',
        context: getGuildName(client, guildId),
        module: 'Notifications',
        eventType: 'Manuel',
        details: 'Paramètres globaux mis à jour.',
        channelId: body.discordChannel?.replace(/[^0-9]/g, '') || null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('NotificationsAPI', 'Error updating notifications:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des notifications' });
    }
    return true;
  }

  return false;
}
