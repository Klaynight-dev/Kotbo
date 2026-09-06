import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import {
  json,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import {
  getChannelHealthDashboardData,
  analyzeGuildChannelHealth,
  resolveHealthAlert,
  upsertChannelHealthConfig,
  createSplitChannel,
  archiveChannel,
} from '../../../services/analytics/channelHealthService.js';

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

export async function handleChannelHealthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'channel-health') return false;

  // GET /api/dashboard/guilds/:guildId/channel-health
  if (parts.length === 5 && method === 'GET') {
    try {
      const data = await getChannelHealthDashboardData(guildId);
      json(res, 200, data);
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error fetching channel health data:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des données' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/channel-health/analyse
  if (parts.length === 6 && parts[5] === 'analyse' && method === 'GET') {
    try {
      const summary = await analyzeGuildChannelHealth(client, guildId);
      json(res, 200, summary ?? { channels: [], overloaded: [], underused: [], dead: [], healthy: [] });
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error running analysis:', err);
      json(res, 500, { error: 'Erreur lors de l\'analyse' });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/channel-health/config
  if (parts.length === 6 && parts[5] === 'config' && method === 'PUT') {
    try {
      const body = await parseBody(req) as Record<string, unknown>;

      const allowedFields = [
        'enabled', 'alertChannelId', 'splitMode', 'archiveMode',
        'analysisPeriodDays', 'overloadMsgPerHour', 'overloadUniqueUsers',
        'underusedMsgPerDay', 'underusedUniqueUsers', 'deadMsgPerWeek',
        'excludedChannelIds', 'archiveCategoryId', 'splitNameTemplate',
        'weeklyDigestEnabled', 'weeklyDigestDay',
      ];

      const sanitized: Record<string, unknown> = {};
      for (const key of allowedFields) {
        if (body[key] !== undefined) sanitized[key] = body[key];
      }

      if (sanitized.excludedChannelIds !== undefined) {
        const ids = sanitized.excludedChannelIds;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          json(res, 400, { error: 'excludedChannelIds doit être une liste d\'identifiants de salons' });
          return true;
        }
        sanitized.excludedChannelIds = [...new Set(ids as string[])];
      }

      const config = await upsertChannelHealthConfig(guildId, sanitized);
      json(res, 200, config);
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error updating config:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-health/alerts/:alertId/resolve
  if (parts.length === 8 && parts[5] === 'alerts' && parts[7] === 'resolve' && method === 'POST') {
    try {
      const alertId = parts[6];
      const body = await parseBody(req) as { action: string; note?: string };

      if (!['APPLIED', 'DISMISSED'].includes(body.action)) {
        json(res, 400, { error: 'Action invalide (APPLIED ou DISMISSED)' });
        return true;
      }

      const success = await resolveHealthAlert(
        alertId,
        body.action as 'APPLIED' | 'DISMISSED',
        user.userId,
        body.note,
      );

      json(res, success ? 200 : 404, success ? { ok: true } : { error: 'Alerte introuvable' });
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error resolving alert:', err);
      json(res, 500, { error: 'Erreur lors de la résolution' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-health/split
  if (parts.length === 6 && parts[5] === 'split' && method === 'POST') {
    try {
      const body = await parseBody(req) as { channelId: string };
      if (!body.channelId) {
        json(res, 400, { error: 'channelId requis' });
        return true;
      }

      const newChannelId = await createSplitChannel(client, guildId, body.channelId);
      if (newChannelId) {
        json(res, 200, { ok: true, channelId: newChannelId });
      } else {
        json(res, 500, { error: 'Impossible de créer le salon' });
      }
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error splitting channel:', err);
      json(res, 500, { error: 'Erreur lors du split' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-health/archive
  if (parts.length === 6 && parts[5] === 'archive' && method === 'POST') {
    try {
      const body = await parseBody(req) as { channelId: string };
      if (!body.channelId) {
        json(res, 400, { error: 'channelId requis' });
        return true;
      }

      const success = await archiveChannel(client, guildId, body.channelId);
      json(res, success ? 200 : 500, success ? { ok: true } : { error: 'Impossible d\'archiver le salon' });
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error archiving channel:', err);
      json(res, 500, { error: 'Erreur lors de l\'archivage' });
    }
    return true;
  }

  return false;
}
