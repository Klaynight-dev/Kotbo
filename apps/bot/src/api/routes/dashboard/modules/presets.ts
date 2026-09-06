/** Routes dashboard du module `presets`. */
import prisma from '../../../../utils/db.js';
import { cache } from '../../../../utils/cache.js';
import { logger } from '../../../../utils/logger.js';
import { type DashboardPresetKey, getGuildName, json, pushAudit, readJsonBody, resolveFeatureAccessMap } from '../../../shared.js';
import { Prisma } from '@prisma/client';
import { PermissionFlagsBits } from 'discord.js';
import { type ModuleRouteContext, PRESET_LABELS, buildCommandRestrictionsForPreset, buildModuleUpdatesForPreset } from './_shared.js';

export async function handlePresetsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, user, guildId, access, method, auditUser, moduleKey } = ctx;

  // POST /api/dashboard/guilds/:guildId/presets
  if (moduleKey === 'presets' && parts.length === 5 && method === 'POST') {
    try {
      const body = await readJsonBody<{ presetKey?: string }>(req);
      const presetKey = (body?.presetKey ?? '').trim() as DashboardPresetKey;

      if (!presetKey || !Object.keys(PRESET_LABELS).includes(presetKey)) {
        json(res, 400, { error: 'Preset invalide.' });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur introuvable.' });
        return true;
      }

      const member = await discordGuild.members.fetch(user.userId).catch(() => null);
      const roleIds = member
        ? member.roles.cache
            .map((role) => role?.id)
            .filter((roleId): roleId is string => !!roleId)
        : [];
      const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

      if (!access.canManageSettings && !(featureAccess.modules?.canConfigure && featureAccess.commands?.canConfigure)) {
        json(res, 403, { error: 'Accès refusé. Permissions insuffisantes.' });
        return true;
      }

      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { moderatorRoleId: true },
      });

      const adminRoleIds = discordGuild.roles.cache
        .filter((role) => !!role && role.permissions.has(PermissionFlagsBits.Administrator))
        .map((role) => role.id);
      const modRoleIds = discordGuild.roles.cache
        .filter((role) => !!role && (role.permissions.has(PermissionFlagsBits.ModerateMembers)
          || role.permissions.has(PermissionFlagsBits.ManageMessages)
          || role.permissions.has(PermissionFlagsBits.KickMembers)
          || role.permissions.has(PermissionFlagsBits.BanMembers)))
        .map((role) => role.id);

      const moduleUpdates = buildModuleUpdatesForPreset(presetKey);
      const commandRestrictions = buildCommandRestrictionsForPreset(presetKey, {
        moderatorRoleId: guildConfig?.moderatorRoleId ?? null,
        adminRoleIds,
        fallbackUserId: user.userId,
        modRoleIds,
      });

      const { applyPresetToFeatureAccess } = await import('../../../../services/core/dashboardManagementService.js');
      await applyPresetToFeatureAccess(guildId, presetKey, { adminRoleIds, modRoleIds });

      await prisma.$transaction([
        prisma.guild.update({ where: { id: guildId }, data: moduleUpdates }),
        prisma.dashboardSettings.update({ where: { guildId }, data: { commandRestrictions: commandRestrictions as unknown as Prisma.InputJsonValue } }),
      ]);

      // Les acces et les etats de modules vivent tous deux sous le prefixe
      // `guild:`. Un preset reecrit les deux d'un coup : sans purge, il
      // s'appliquait a retardement, jusqu'a une minute apres le clic.
      await cache.invalidateGuild(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Application preset',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: `Preset appliqué : ${PRESET_LABELS[presetKey]}.`,
        channelId: null,
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('PresetsAPI', 'Error applying preset:', err);
      json(res, 500, { error: "Erreur lors de l'application du preset" });
    }
    return true;
  }

  return false;
}
