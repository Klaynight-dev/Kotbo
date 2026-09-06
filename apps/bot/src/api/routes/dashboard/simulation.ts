import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { validateScenario, type ScenarioStep } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, getGuildName, safePushAudit, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  ScenarioValidationError,
  createScenario,
  deleteScenario,
  getSessionDetail,
  getSimulationConfig,
  listScenarios,
  listSessions,
  sanitizeSimulationConfigPatch,
  updateScenario,
  upsertSimulationConfig,
} from '../../../services/staff/simulationService.js';

interface ScenarioBody {
  title?: unknown;
  description?: unknown;
  difficulty?: unknown;
  enabled?: unknown;
  steps?: unknown;
}

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];

function parseSteps(raw: unknown): ScenarioStep[] | null {
  return Array.isArray(raw) ? (raw as ScenarioStep[]) : null;
}

export async function handleSimulationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== 'simulation') return false;

  const method = req.method;
  const sub = parts[5];

  // Ces routes n'avaient aucun controle : n'importe quel membre du staff
  // pouvait reecrire la configuration et supprimer les scenarios. La lecture
  // reste ouverte a qui a deja acces au dashboard, comme sur les autres modules.
  if (method !== 'GET' && !access.canManageSettings) {
    json(res, 403, { error: 'Accès refusé. Permissions administratives requises.' });
    return true;
  }

  const audit = (action: string, details: string) => safePushAudit(guildId, {
    user: `${user.username ?? 'Inconnu'} (${user.userId})`,
    action,
    context: getGuildName(client, guildId),
    module: 'Staff Simulator',
    eventType: 'Manuel',
    details,
    channelId: null,
  }, action);

  // GET /simulation - configuration + scénarios
  if (!sub && method === 'GET') {
    try {
      const [config, scenarios] = await Promise.all([
        getSimulationConfig(guildId),
        listScenarios(guildId),
      ]);
      json(res, 200, { config, scenarios });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur GET:', err);
      json(res, 500, { error: 'Erreur lors de la récupération du simulateur' });
    }
    return true;
  }

  // PATCH /simulation/config
  if (sub === 'config' && method === 'PATCH') {
    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body) {
        json(res, 400, { error: 'Corps de requête manquant' });
        return true;
      }

      const patch = sanitizeSimulationConfigPatch(body);
      if (Object.keys(patch).length === 0) {
        json(res, 400, { error: 'Aucun champ valide à mettre à jour' });
        return true;
      }

      const config = await upsertSimulationConfig(guildId, patch);
      await audit('Mise à jour simulateur', `Actif : ${config.enabled}, salon de test : ${config.testChannelId ?? 'aucun'}.`);
      json(res, 200, { config });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur PATCH config:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
    }
    return true;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  if (sub === 'sessions' && method === 'GET') {
    try {
      if (parts[6]) {
        const session = await getSessionDetail(guildId, parts[6]);
        if (!session) {
          json(res, 404, { error: 'Session introuvable' });
          return true;
        }
        json(res, 200, { session });
        return true;
      }

      const sessions = await listSessions(
        guildId,
        url.searchParams.get('traineeId') ?? undefined,
        Number(url.searchParams.get('take')) || 25,
      );
      json(res, 200, { sessions });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur GET sessions:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des sessions' });
    }
    return true;
  }

  // ── Scénarios ────────────────────────────────────────────────────────────
  if (sub === 'scenarios') {
    const scenarioId = parts[6];

    if (!scenarioId && method === 'POST') {
      try {
        const body = await readJsonBody<ScenarioBody>(req);
        const steps = parseSteps(body?.steps);
        if (typeof body?.title !== 'string' || !steps) {
          json(res, 400, { error: 'Titre ou étapes manquants' });
          return true;
        }

        const scenario = await createScenario(guildId, {
          title: body.title,
          description: typeof body.description === 'string' ? body.description : '',
          difficulty: DIFFICULTIES.includes(String(body.difficulty)) ? String(body.difficulty) : 'MEDIUM',
          enabled: body.enabled !== false,
          steps,
        }, user.userId);

        await audit('Création scénario', `« ${scenario.title} », ${steps.length} étape(s).`);
        json(res, 201, { scenario });
      } catch (err) {
        if (err instanceof ScenarioValidationError) {
          json(res, 400, { error: 'Scénario invalide', issues: err.issues });
          return true;
        }
        logger.error('SimulationAPI', 'Erreur création scénario:', err);
        json(res, 500, { error: 'Erreur lors de la création du scénario' });
      }
      return true;
    }

    if (scenarioId && method === 'PUT') {
      try {
        const body = await readJsonBody<ScenarioBody>(req);
        const steps = parseSteps(body?.steps);
        if (typeof body?.title !== 'string' || !steps) {
          json(res, 400, { error: 'Titre ou étapes manquants' });
          return true;
        }

        const scenario = await updateScenario(guildId, scenarioId, {
          title: body.title,
          description: typeof body.description === 'string' ? body.description : '',
          difficulty: DIFFICULTIES.includes(String(body.difficulty)) ? String(body.difficulty) : 'MEDIUM',
          enabled: body.enabled !== false,
          steps,
        });

        if (!scenario) {
          json(res, 404, { error: 'Scénario introuvable' });
          return true;
        }

        await audit('Mise à jour scénario', `« ${scenario.title} », ${steps.length} étape(s).`);
        json(res, 200, { scenario });
      } catch (err) {
        if (err instanceof ScenarioValidationError) {
          json(res, 400, { error: 'Scénario invalide', issues: err.issues });
          return true;
        }
        logger.error('SimulationAPI', 'Erreur mise à jour scénario:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour du scénario' });
      }
      return true;
    }

    if (scenarioId && method === 'DELETE') {
      try {
        const deleted = await deleteScenario(guildId, scenarioId);
        if (!deleted) {
          json(res, 404, { error: 'Scénario introuvable' });
          return true;
        }
        await audit('Suppression scénario', `Scénario ${scenarioId} supprimé.`);
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('SimulationAPI', 'Erreur suppression scénario:', err);
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }

    // Validation à la volée, utilisée par l'éditeur avant enregistrement
    if (!scenarioId && method === 'PATCH') {
      try {
        const body = await readJsonBody<ScenarioBody>(req);
        const steps = parseSteps(body?.steps) ?? [];
        json(res, 200, {
          issues: validateScenario({ title: String(body?.title ?? ''), steps }),
        });
      } catch (err) {
        logger.error('SimulationAPI', 'Erreur validation scénario:', err);
        json(res, 500, { error: 'Erreur lors de la validation' });
      }
      return true;
    }
  }

  return false;
}
