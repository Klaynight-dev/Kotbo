import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { json, resolveMemberFeatureAccess, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  getQuestsDashboardData,
  createQuestDefinition,
  updateQuestDefinition,
  deleteQuestDefinition,
} from '../../../services/community/questService.js';

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

export async function handleQuestRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;
  if (parts[4] !== 'quests') return false;

  // Les quetes sont une page de la section Economie du dashboard : elles suivent
  // le meme droit, sinon interdire "economy" laisserait leurs donnees accessibles.
  const featureAccess = await resolveMemberFeatureAccess(client, guildId, access, user.userId);
  if (!featureAccess.economy?.canView) {
    json(res, 403, { error: 'Accès refusé. Votre rôle ne donne pas accès aux quêtes.' });
    return true;
  }

  // Voir la section suffisait pour y ecrire : creer, modifier et supprimer une
  // quete ne demandaient rien de plus que d'avoir la page ouverte. Les quetes
  // suivent le droit de l'economie, donc aussi sa distinction entre regler la
  // section et y effacer.
  if (method !== 'GET') {
    const allowed = method === 'DELETE'
      ? featureAccess.economy?.canDelete
      : featureAccess.economy?.canConfigure;

    if (!allowed) {
      json(res, 403, {
        error: method === 'DELETE'
          ? 'Accès refusé. Votre rôle ne permet pas de supprimer les quêtes.'
          : 'Accès refusé. Votre rôle ne permet pas de modifier les quêtes.',
      });
      return true;
    }
  }

  // GET /api/dashboard/guilds/:guildId/quests
  if (parts.length === 5 && method === 'GET') {
    try {
      const data = await getQuestsDashboardData(guildId);
      json(res, 200, data);
    } catch (err) {
      logger.error('QuestsAPI', 'Error fetching quests:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des quêtes' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/quests
  if (parts.length === 5 && method === 'POST') {
    try {
      const body = await parseBody(req) as {
        name: string; description: string; type: string;
        frequency: string; target: number; rewardCoins: number; rewardXp: number;
      };
      const quest = await createQuestDefinition(guildId, body);
      json(res, 201, quest);
    } catch (err) {
      logger.error('QuestsAPI', 'Error creating quest:', err);
      json(res, 500, { error: 'Erreur lors de la création' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/quests/:questId
  if (parts.length === 6 && method === 'PATCH') {
    try {
      const body = await parseBody(req) as Record<string, any>;
      const quest = await updateQuestDefinition(parts[5], body);
      json(res, 200, quest);
    } catch (err) {
      logger.error('QuestsAPI', 'Error updating quest:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/quests/:questId
  if (parts.length === 6 && method === 'DELETE') {
    try {
      await deleteQuestDefinition(parts[5]);
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('QuestsAPI', 'Error deleting quest:', err);
      json(res, 500, { error: 'Erreur lors de la suppression' });
    }
    return true;
  }

  return false;
}
