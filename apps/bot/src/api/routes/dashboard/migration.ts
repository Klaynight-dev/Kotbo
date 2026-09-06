/**
 * Routes de reprise de configuration depuis les autres bots du serveur.
 *
 * Trois surfaces : le plan (ce qu'on a detecte), l'application des propositions
 * retenues, et l'inspection d'un fichier d'export tiers.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, resolveDashboardAccess, pushAudit, getGuildName, type AuthClaims } from '../../shared.js';
import { applyMigrationPlan, buildMigrationPlan } from '../../../services/core/botMigrationService.js';

/**
 * Reglages de la guilde qu'une valeur importee peut alimenter.
 *
 * Liste fermee : le fichier vient de l'exterieur, il ne doit pas pouvoir
 * designer une colonne arbitraire de la table.
 */
const ASSIGNABLE_SETTINGS: Record<string, string> = {
  ticketCategory: 'ticketCategoryId',
  ticketLogChannel: 'ticketLogChannelId',
  welcomeChannel: 'publicChannelId',
  logChannel: 'logChannelId',
  suggestionChannel: 'digestChannelId',
  moderatorRole: 'moderatorRoleId',
};

/** Un identifiant Discord : 17 a 20 chiffres. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Aplatit un JSON quelconque et retient les valeurs qui ressemblent a des
 * identifiants Discord.
 *
 * Aucun format tiers n'est devine : les bots n'exportent pas la meme structure,
 * et un parseur specifique se casserait a leur prochaine mise a jour. On montre
 * ce qu'on a trouve, avec son chemin, et le staff associe lui-meme chaque
 * valeur au reglage Kotbo correspondant.
 */
function collectSnowflakes(
  value: unknown,
  path: string[] = [],
  out: { path: string; value: string }[] = [],
  depth = 0,
): { path: string; value: string }[] {
  // Un export profond ou circulaire ne doit pas faire tourner le serveur.
  if (depth > 8 || out.length >= 200) return out;

  if (typeof value === 'string') {
    if (SNOWFLAKE.test(value)) out.push({ path: path.join('.') || '(racine)', value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSnowflakes(item, [...path, String(index)], out, depth + 1));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectSnowflakes(child, [...path, key], out, depth + 1);
    }
  }
  return out;
}

export async function handleMigrationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
  client: Client,
  user: AuthClaims,
): Promise<boolean> {
  if (parts[4] !== 'migration') return false;

  const method = req.method;
  const guildId = parts[3];

  const access = await resolveDashboardAccess(client, guildId, user.userId);
  if (!access.canManageSettings) {
    json(res, 403, { error: 'Accès refusé' });
    return true;
  }

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    json(res, 404, { error: 'Serveur Discord introuvable' });
    return true;
  }

  const auditUser = user.username ?? `User${user.userId}`;

  // GET /api/dashboard/guilds/:guildId/migration
  if (parts.length === 5 && method === 'GET') {
    try {
      json(res, 200, await buildMigrationPlan(guild));
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur GET plan:', err);
      json(res, 500, { error: 'Erreur lors de l\'analyse du serveur' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/migration/apply { keys }
  if (parts.length === 6 && parts[5] === 'apply' && method === 'POST') {
    try {
      const body = await readJsonBody<{ keys?: unknown }>(req);
      const keys = Array.isArray(body?.keys)
        ? body.keys.filter((k): k is string => typeof k === 'string')
        : [];

      if (keys.length === 0) {
        json(res, 400, { error: 'Aucune proposition sélectionnée' });
        return true;
      }

      const result = await applyMigrationPlan(guild, keys);

      if (result.applied.length > 0) {
        await pushAudit(guildId, {
          channelId: null,
          user: auditUser,
          action: `Reprise de configuration : ${result.applied.length} réglage(s)`,
          context: getGuildName(client, guildId),
          module: 'Reprise',
          eventType: 'Settings',
          details: result.applied.join(', '),
        });
      }

      json(res, 200, { ...result, plan: await buildMigrationPlan(guild) });
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur POST apply:', err);
      json(res, 500, { error: 'Erreur lors de la reprise' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/migration/inspect { export }
  if (parts.length === 6 && parts[5] === 'inspect' && method === 'POST') {
    try {
      const body = await readJsonBody<{ export?: unknown }>(req);
      if (body?.export === undefined) {
        json(res, 400, { error: 'Fichier vide ou illisible' });
        return true;
      }

      const found = collectSnowflakes(body.export);

      // Chaque identifiant est resolu contre le serveur : un identifiant qui ne
      // correspond a rien ici vient d'un autre serveur et n'a rien a faire dans
      // la liste des choix.
      if (guild.channels.cache.size === 0) await guild.channels.fetch().catch(() => null);
      const candidates = found
        .map(({ path, value }) => {
          const channel = guild.channels.cache.get(value);
          const role = guild.roles.cache.get(value);
          if (channel) return { path, value, kind: 'channel' as const, name: channel.name };
          if (role) return { path, value, kind: 'role' as const, name: role.name };
          return null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);

      json(res, 200, {
        candidates,
        // Doublons retires : un meme salon cite dix fois dans l'export ne
        // merite pas dix lignes a l'ecran.
        settings: Object.keys(ASSIGNABLE_SETTINGS),
        inspected: found.length,
      });
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur POST inspect:', err);
      json(res, 500, { error: "Erreur lors de la lecture de l'export" });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/migration/assign { assignments }
  if (parts.length === 6 && parts[5] === 'assign' && method === 'POST') {
    try {
      const body = await readJsonBody<{ assignments?: unknown }>(req);
      const raw = Array.isArray(body?.assignments) ? body.assignments : [];

      const data: Record<string, string> = {};
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const { setting, value } = item as { setting?: unknown; value?: unknown };
        if (typeof setting !== 'string' || typeof value !== 'string') continue;

        const column = ASSIGNABLE_SETTINGS[setting];
        // Identifiant revalide cote serveur : le client a pu envoyer autre chose
        // que ce que l'inspection avait propose.
        if (!column || !SNOWFLAKE.test(value)) continue;
        data[column] = value;
      }

      if (Object.keys(data).length === 0) {
        json(res, 400, { error: 'Aucune association valide' });
        return true;
      }

      await prisma.guild.update({ where: { id: guildId }, data });

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: `Reprise depuis un export : ${Object.keys(data).length} réglage(s)`,
        context: getGuildName(client, guildId),
        module: 'Reprise',
        eventType: 'Settings',
        details: Object.keys(data).join(', '),
      });

      json(res, 200, { success: true, applied: Object.keys(data) });
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur POST assign:', err);
      json(res, 500, { error: "Erreur lors de l'association" });
    }
    return true;
  }

  return false;
}
