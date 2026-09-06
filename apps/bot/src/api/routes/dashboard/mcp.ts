import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { logger } from '../../../utils/logger.js';
import { getMcpConnectionLogs, makeMcpDirectUrl } from '../../mcp/mcpServer.js';
import { createMcpKey, getMcpKeys, deactivateMcpKey, findActiveMcpKeyById } from '../../mcp/mcpKeyService.js';
import type { McpKeyPermission } from '@prisma/client';

const VALID_PERMISSIONS: McpKeyPermission[] = [
  'READ_STATS',
  'READ_MEMBERS',
  'READ_SANCTIONS',
  'READ_STAFF',
  'READ_TICKETS',
  'READ_COMMUNITY',
  'READ_ECONOMY',
  'READ_MODERATION',
  'READ_ANALYTICS',
  'WRITE_SANCTIONS',
  'WRITE_MESSAGES',
  'WRITE_TICKETS',
  'WRITE_COMMUNITY',
  'WRITE_MEMBERS',
  'READ_WORKFLOWS',
  'WRITE_WORKFLOWS',
];

export async function handleMCPKeyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
  _client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  if (parts[4] !== 'mcp-keys' && parts[4] !== 'mcp-logs') return false;

  const method = req.method;

  if (!access.canManageSettings) {
    json(res, 403, { error: 'Réservé aux administrateurs du dashboard.' });
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/mcp-logs
  if (parts.length === 5 && parts[4] === 'mcp-logs' && method === 'GET') {
    const logs = getMcpConnectionLogs(guildId);
    json(res, 200, { logs });
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/mcp-keys
  if (parts.length === 5 && parts[4] === 'mcp-keys' && method === 'GET') {
    try {
      const keys = await getMcpKeys(guildId);
      json(res, 200, keys);
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error fetching MCP keys:', error);
      json(res, 500, { error: 'Erreur lors de la récupération des clés MCP' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/mcp-keys
  if (parts.length === 5 && parts[4] === 'mcp-keys' && method === 'POST') {
    try {
      const body = await readJsonBody<{ name?: string; permissions?: string[] }>(req);
      if (!body?.name || typeof body.name !== 'string' || !body.name.trim()) {
        json(res, 400, { error: 'Le champ "name" est requis.' });
        return true;
      }

      const permissions: McpKeyPermission[] = (body.permissions ?? ['READ_STATS', 'READ_MEMBERS', 'READ_SANCTIONS'])
        .filter((p): p is McpKeyPermission => VALID_PERMISSIONS.includes(p as McpKeyPermission));

      // La cle agit au nom de qui la cree : c'est ce rattachement qui permet
      // de la couper quand ce compte perd ses droits sur le serveur.
      const created = await createMcpKey(guildId, body.name.trim(), permissions, user.userId);
      json(res, 201, {
        id: created.id,
        name: created.name,
        displayKey: created.displayKey,
        permissions: created.permissions,
        isActive: created.isActive,
        createdAt: created.createdAt,
        fullKey: created.fullKey,
      });
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error creating MCP key:', error);
      json(res, 500, { error: 'Erreur lors de la création de la clé MCP' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/mcp-keys/:keyId/direct-url
  if (parts.length === 7 && parts[4] === 'mcp-keys' && parts[6] === 'direct-url' && method === 'GET') {
    const keyId = parts[5];
    try {
      const key = await findActiveMcpKeyById(keyId, guildId);
      if (!key) {
        json(res, 404, { error: 'Clé MCP introuvable ou inactive' });
        return true;
      }

      json(res, 200, makeMcpDirectUrl(req, _url, guildId, key.id));
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error creating MCP direct URL:', error);
      json(res, 500, { error: 'Erreur lors de la génération de l URL MCP directe' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/mcp-keys/:keyId
  if (parts.length === 6 && parts[4] === 'mcp-keys' && method === 'DELETE') {
    const keyId = parts[5];
    try {
      await deactivateMcpKey(guildId, keyId);
      json(res, 200, { ok: true });
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error deactivating MCP key:', error);
      json(res, 500, { error: 'Erreur lors de la suppression de la clé MCP' });
    }
    return true;
  }

  return false;
}
