import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { validateGraph, type WorkflowGraph } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, getGuildName, resolveMemberFeatureAccess, safePushAudit, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  WorkflowValidationError,
  createWorkflow,
  deleteWorkflow,
  getExecutionDetail,
  getWorkflow,
  listExecutions,
  listWorkflows,
  setWorkflowEnabled,
  updateWorkflow,
} from '../../../services/features/workflow/workflowService.js';

interface WorkflowBody {
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  graph?: unknown;
}

/** Un graphe reçu par l'API n'a aucune garantie de forme : on le normalise. */
function parseGraph(raw: unknown): WorkflowGraph | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
  return { nodes: candidate.nodes, edges: candidate.edges } as WorkflowGraph;
}

export async function handleWorkflowRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== 'workflows') return false;

  const method = req.method;
  const sub = parts[5];

  // Masquer la section dans la navigation ne suffit pas : sans ce controle,
  // l'URL et l'API continuent de servir les workflows a un staff a qui le role
  // interdit la page.
  const featureAccess = await resolveMemberFeatureAccess(client, guildId, access, user.userId);
  if (!featureAccess.workflows?.canView) {
    json(res, 403, { error: 'Accès refusé. Votre rôle ne donne pas accès aux automatisations.' });
    return true;
  }

  // Creer, modifier, activer et supprimer un workflow n'avait aucun controle :
  // tout staff pouvait effacer les automatisations du serveur.
  //
  // La suppression se demande a part, comme sur les reunions : la matrice des
  // acces distingue « Configurer » de « Supprimer », et un role autorise a
  // regler les automatisations n'a pas pour autant celui de les effacer.
  const requiredWorkflowRight = method === 'DELETE'
    ? featureAccess.workflows?.canDelete
    : featureAccess.workflows?.canConfigure;

  if (method !== 'GET' && !access.canManageSettings && !requiredWorkflowRight) {
    json(res, 403, {
      error: method === 'DELETE'
        ? 'Accès refusé. Votre rôle ne permet pas de supprimer les automatisations.'
        : 'Accès refusé. Votre rôle ne permet pas de modifier les automatisations.',
    });
    return true;
  }

  const audit = (action: string, details: string) => safePushAudit(guildId, {
    user: `${user.username ?? 'Inconnu'} (${user.userId})`,
    action,
    context: getGuildName(client, guildId),
    module: 'Workflows',
    eventType: 'Manuel',
    details,
    channelId: null,
  }, action);

  // ── Exécutions ───────────────────────────────────────────────────────────
  // Placé avant la route /:id pour ne pas être capté par elle.
  if (sub === 'executions' && method === 'GET') {
    try {
      if (parts[6]) {
        const execution = await getExecutionDetail(guildId, parts[6]);
        if (!execution) {
          json(res, 404, { error: 'Exécution introuvable' });
          return true;
        }
        json(res, 200, { execution });
        return true;
      }

      const executions = await listExecutions(
        guildId,
        url.searchParams.get('workflowId') ?? undefined,
        Number(url.searchParams.get('take')) || 25,
      );
      json(res, 200, { executions });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET exécutions:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des exécutions' });
    }
    return true;
  }

  // ── Validation à la volée (utilisée par l'éditeur avant enregistrement) ──
  if (sub === 'validate' && method === 'POST') {
    try {
      const body = await readJsonBody<WorkflowBody>(req);
      const graph = parseGraph(body?.graph);
      if (!graph) {
        json(res, 400, { error: 'Graphe invalide' });
        return true;
      }
      json(res, 200, { issues: validateGraph(graph) });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur validation:', err);
      json(res, 500, { error: 'Erreur lors de la validation' });
    }
    return true;
  }

  // ── Liste ────────────────────────────────────────────────────────────────
  if (!sub && method === 'GET') {
    try {
      json(res, 200, { workflows: await listWorkflows(guildId) });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET liste:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des workflows' });
    }
    return true;
  }

  // ── Création ─────────────────────────────────────────────────────────────
  if (!sub && method === 'POST') {
    try {
      const body = await readJsonBody<WorkflowBody>(req);
      const graph = parseGraph(body?.graph);
      if (!graph || typeof body?.name !== 'string') {
        json(res, 400, { error: 'Nom ou graphe manquant' });
        return true;
      }

      const workflow = await createWorkflow(guildId, {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        enabled: body.enabled === true,
        graph,
      }, user.userId);

      await audit('Création workflow', `« ${workflow.name} » sur ${workflow.triggerType}.`);
      json(res, 201, { workflow });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        json(res, 400, { error: 'Graphe invalide', issues: err.issues });
        return true;
      }
      logger.error('WorkflowAPI', 'Erreur création:', err);
      json(res, 500, { error: 'Erreur lors de la création du workflow' });
    }
    return true;
  }

  // ── Détail ───────────────────────────────────────────────────────────────
  if (sub && !parts[6] && method === 'GET') {
    try {
      const workflow = await getWorkflow(guildId, sub);
      if (!workflow) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }
      json(res, 200, { workflow });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET détail:', err);
      json(res, 500, { error: 'Erreur lors de la récupération du workflow' });
    }
    return true;
  }

  // ── Mise à jour ──────────────────────────────────────────────────────────
  if (sub && !parts[6] && method === 'PUT') {
    try {
      const body = await readJsonBody<WorkflowBody>(req);
      const graph = parseGraph(body?.graph);
      if (!graph || typeof body?.name !== 'string') {
        json(res, 400, { error: 'Nom ou graphe manquant' });
        return true;
      }

      const workflow = await updateWorkflow(guildId, sub, {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        enabled: body.enabled === true,
        graph,
      });

      if (!workflow) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }

      await audit('Mise à jour workflow', `« ${workflow.name} », actif : ${workflow.enabled}.`);
      json(res, 200, { workflow });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        json(res, 400, { error: 'Graphe invalide', issues: err.issues });
        return true;
      }
      logger.error('WorkflowAPI', 'Erreur mise à jour:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour du workflow' });
    }
    return true;
  }

  // ── Activation / désactivation ───────────────────────────────────────────
  if (sub && parts[6] === 'toggle' && method === 'POST') {
    try {
      const body = await readJsonBody<{ enabled?: unknown }>(req);
      const toggled = await setWorkflowEnabled(guildId, sub, body?.enabled === true);

      if (!toggled) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }

      await audit('Bascule workflow', `Workflow ${body?.enabled === true ? 'activé' : 'désactivé'}.`);
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur bascule:', err);
      json(res, 500, { error: 'Erreur lors du changement d\'état' });
    }
    return true;
  }

  // ── Suppression ──────────────────────────────────────────────────────────
  if (sub && !parts[6] && method === 'DELETE') {
    try {
      const deleted = await deleteWorkflow(guildId, sub);
      if (!deleted) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }
      await audit('Suppression workflow', `Workflow ${sub} supprimé.`);
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur suppression:', err);
      json(res, 500, { error: 'Erreur lors de la suppression' });
    }
    return true;
  }

  return false;
}
