import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, getGuildName, pushAudit, broadcastDashboardStateChange, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  DROP_TYPES,
  normalizeDropGlobalSettings,
  normalizeDropTypeSettings,
  type DropType,
  type DropTypeSettings,
} from '@kotbo/shared';
import { PlanLockedError, setDashboardModuleStatus } from '../../../services/core/moduleActivationService.js';
import { isGuildInOnboarding } from '../../../services/core/onboardingGate.js';
import { dropSettingsFromRow, dropSettingsToRow, getOrCreateDropConfigs } from '../../../services/features/dropService.js';

/** Nombre de drops passés renvoyés à la page, pour l'historique de l'onglet global. */
const RECENT_DROPS_LIMIT = 15;

function isDropType(value: string | undefined): value is DropType {
  return !!value && (DROP_TYPES as readonly string[]).includes(value);
}

/**
 * Réglages d'un type, prêts pour le formulaire : la normalisation est la même
 * qu'à l'écriture, donc la page ne peut pas afficher une valeur que l'API
 * refuserait ensuite.
 */
function serializeConfig(row: Awaited<ReturnType<typeof getOrCreateDropConfigs>>[number]) {
  return {
    type: row.type as DropType,
    nextDropAt: row.nextDropAt?.toISOString() ?? null,
    ...dropSettingsFromRow(row),
  };
}

export async function handleDropsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;
  const auditUser = `${user.username} (${user.userId})`;

  // Path matches: /api/dashboard/guilds/:guildId/drops/...
  const subAction = parts[5]; // undefined | XP | RPG_XP | CLAN_POINTS | COINS

  // GET /api/dashboard/guilds/:guildId/drops
  if (!subAction && method === 'GET') {
    try {
      const guildData = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          dropsEnabled: true,
          dropChannelId: true,
          dropMentionRoleId: true,
          dropLifetimeMinutes: true,
        },
      });

      if (!guildData) {
        json(res, 404, { error: 'Serveur non trouvé en base de données.' });
        return true;
      }

      const configs = await getOrCreateDropConfigs(guildId);

      const recent = await prisma.drop.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_DROPS_LIMIT,
        select: {
          id: true,
          type: true,
          mode: true,
          channelId: true,
          amount: true,
          maxClaims: true,
          claimCount: true,
          createdAt: true,
          expiresAt: true,
          closedAt: true,
        },
      });

      json(res, 200, {
        ...normalizeDropGlobalSettings(guildData),
        configs: configs.map(serializeConfig),
        recentDrops: recent.map((drop) => ({
          ...drop,
          createdAt: drop.createdAt.toISOString(),
          expiresAt: drop.expiresAt.toISOString(),
          closedAt: drop.closedAt?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      logger.error('DropsAPI', 'Error fetching drops config:', err);
      json(res, 500, { error: 'Erreur lors de la récupération de la configuration des drops.' });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/drops (réglages globaux)
  if (!subAction && method === 'PUT') {
    try {
      const body = await readJsonBody<{
        dropsEnabled?: boolean;
        dropChannelId?: string | null;
        dropMentionRoleId?: string | null;
        dropLifetimeMinutes?: number;
      }>(req);

      const current = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          dropsEnabled: true,
          dropChannelId: true,
          dropMentionRoleId: true,
          dropLifetimeMinutes: true,
        },
      });

      if (!current) {
        json(res, 404, { error: 'Serveur non trouvé en base de données.' });
        return true;
      }

      // Les bornes viennent de `@kotbo/shared` : le formulaire et l'API refusent
      // exactement les mêmes valeurs.
      const settings = normalizeDropGlobalSettings({
        dropsEnabled: body?.dropsEnabled ?? current.dropsEnabled,
        dropChannelId: body?.dropChannelId === undefined ? current.dropChannelId : (body.dropChannelId || null),
        dropMentionRoleId: body?.dropMentionRoleId === undefined ? current.dropMentionRoleId : (body.dropMentionRoleId || null),
        dropLifetimeMinutes: body?.dropLifetimeMinutes ?? current.dropLifetimeMinutes,
      });

      // L'interrupteur maître passe par la bascule de module plutôt que par la
      // colonne : elle seule tient la ligne du registre et la colonne au même
      // état, et invalide la garde d'exécution. Uniquement sur un vrai
      // changement, la page renvoyant l'interrupteur à chaque enregistrement.
      if (settings.dropsEnabled !== current.dropsEnabled) {
        const inOnboarding = await isGuildInOnboarding(guildId);
        await setDashboardModuleStatus(guildId, 'drops', settings.dropsEnabled, 'Dashboard', {
          recordIntentWhenLocked: inOnboarding,
        });
      }

      await prisma.guild.update({
        where: { id: guildId },
        data: {
          dropChannelId: settings.dropChannelId,
          dropMentionRoleId: settings.dropMentionRoleId,
          dropLifetimeMinutes: settings.dropLifetimeMinutes,
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Drops',
        context: getGuildName(client, guildId),
        module: 'Drops',
        eventType: 'Manuel',
        details: `Drops activés: ${settings.dropsEnabled}, durée de vie: ${settings.dropLifetimeMinutes} min`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'drops_updated');
      json(res, 200, settings);
    } catch (err) {
      if (err instanceof PlanLockedError) {
        json(res, 402, {
          error: err.message,
          code: 'plan_locked',
          moduleKey: err.moduleKey,
          currentPlan: err.currentPlan,
          requiredPlan: err.requiredPlan,
        });
        return true;
      }
      logger.error('DropsAPI', 'Error updating drops config:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration des drops.' });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/drops/:type (réglages d'une ressource)
  if (isDropType(subAction) && method === 'PUT') {
    try {
      const body = await readJsonBody<Partial<DropTypeSettings>>(req);
      const [existing] = await getOrCreateDropConfigs(guildId).then(
        (rows) => rows.filter((row) => row.type === subAction),
      );

      if (!existing) {
        json(res, 404, { error: 'Type de drop inconnu.' });
        return true;
      }

      const current = dropSettingsFromRow(existing);
      // Fusion champ par champ : la page enregistre une section à la fois, un
      // remplacement complet remettrait les autres modes à leur valeur par défaut.
      const settings = normalizeDropTypeSettings(subAction, {
        ...current,
        ...body,
        first: { ...current.first, ...body?.first },
        race: { ...current.race, ...body?.race },
        window: { ...current.window, ...body?.window },
        channelId: body?.channelId === undefined ? current.channelId : (body.channelId || null),
      });

      // L'échéance déjà tirée est effacée quand la fréquence change, et quand le
      // type est rallumé : sans ça, un type éteint depuis des semaines ferait
      // tomber un drop dans la minute qui suit sa réactivation, alors que la
      // page annonce un premier drop au bout d'environ un intervalle.
      const rescheduleNeeded = settings.intervalMinutes !== current.intervalMinutes
        || (settings.enabled && !current.enabled);

      const updated = await prisma.dropConfig.update({
        where: { id: existing.id },
        data: {
          ...dropSettingsToRow(settings),
          ...(rescheduleNeeded ? { nextDropAt: null } : {}),
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: `Mise à jour drop ${subAction}`,
        context: getGuildName(client, guildId),
        module: 'Drops',
        eventType: 'Manuel',
        details: `Activé: ${settings.enabled}, intervalle moyen: ${settings.intervalMinutes} min`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'drops_updated');
      json(res, 200, serializeConfig(updated));
    } catch (err) {
      logger.error('DropsAPI', `Error updating drop config ${subAction}:`, err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de ce type de drop.' });
    }
    return true;
  }

  return false;
}
