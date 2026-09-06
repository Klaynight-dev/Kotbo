import { getNodeDef, isTriggerNode, resolveNodeInputs, resolveNodeOutputs } from './catalog.js';
import { isValidCron } from './cron.js';
import {
  canConnect,
  DEFAULT_BUDGET,
  type ExecutionBudget,
  type PortDef,
  type WorkflowEdge,
  type WorkflowGraph,
} from './types.js';

/**
 * Validation d'un graphe, partagée entre l'éditeur et le backend.
 *
 * L'éditeur l'exécute à chaque modification pour signaler les problèmes en
 * direct ; le backend la rejoue à l'enregistrement, car rien n'empêche un appel
 * API de contourner l'interface.
 */

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/**
 * Le nœud ForEach boucle en interne : son fil « Corps » n'est jamais recâblé
 * vers l'amont par l'utilisateur. Le graphe d'exécution reste donc acyclique,
 * et tout cycle dessiné à la main est une erreur - la répétition bornée passe
 * exclusivement par ForEach, sous contrôle du budget d'exécution.
 */
function findCycle(
  adjacency: Map<string, string[]>,
  nodeIds: string[],
): string[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colors = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  const stack: string[] = [];
  let cycle: string[] | null = null;

  function visit(nodeId: string): boolean {
    colors.set(nodeId, GREY);
    stack.push(nodeId);

    for (const next of adjacency.get(nodeId) ?? []) {
      const color = colors.get(next);
      if (color === GREY) {
        cycle = stack.slice(stack.indexOf(next));
        return true;
      }
      if (color === WHITE && visit(next)) return true;
    }

    stack.pop();
    colors.set(nodeId, BLACK);
    return false;
  }

  for (const nodeId of nodeIds) {
    if (colors.get(nodeId) === WHITE && visit(nodeId)) return cycle;
  }

  return null;
}

function portById(ports: PortDef[], id: string): PortDef | undefined {
  return ports.find((port) => port.id === id);
}

export function validateGraph(
  graph: WorkflowGraph,
  budget: ExecutionBudget = DEFAULT_BUDGET,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  // ── Nœuds ────────────────────────────────────────────────────────────────
  if (nodes.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_GRAPH', message: 'Le workflow est vide.' });
    return issues;
  }

  if (nodes.length > budget.maxNodes) {
    issues.push({
      severity: 'error',
      code: 'TOO_MANY_NODES',
      message: `Le workflow dépasse la limite de ${budget.maxNodes} nœuds (${nodes.length}).`,
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (nodeById.size !== nodes.length) {
    issues.push({ severity: 'error', code: 'DUPLICATE_NODE_ID', message: 'Deux nœuds portent le même identifiant.' });
  }

  for (const node of nodes) {
    if (!getNodeDef(node.type)) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_NODE_TYPE',
        message: `Type de nœud inconnu : ${node.type}.`,
        nodeId: node.id,
      });
    }
  }

  const triggers = nodes.filter((node) => isTriggerNode(node.type));
  if (triggers.length === 0) {
    issues.push({ severity: 'error', code: 'NO_TRIGGER', message: 'Le workflow n\'a aucun déclencheur.' });
  } else if (triggers.length > 1) {
    issues.push({
      severity: 'error',
      code: 'MULTIPLE_TRIGGERS',
      message: 'Un workflow ne peut avoir qu\'un seul déclencheur.',
      nodeId: triggers[1].id,
    });
  }

  // ── Arêtes ───────────────────────────────────────────────────────────────
  const execAdjacency = new Map<string, string[]>();
  const dataAdjacency = new Map<string, string[]>();
  const execOutUsage = new Map<string, number>();
  const dataInUsage = new Map<string, number>();

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);

    if (!source || !target) {
      issues.push({
        severity: 'error',
        code: 'DANGLING_EDGE',
        message: 'Un fil pointe vers un nœud inexistant.',
        edgeId: edge.id,
      });
      continue;
    }

    const sourceDef = getNodeDef(source.type);
    const targetDef = getNodeDef(target.type);
    if (!sourceDef || !targetDef) continue;

    // Les sorties du Switch dépendent de sa configuration, celles du ForEach
    // du type de la liste branchée : on passe donc par le résolveur partagé.
    const sourceOutputs = resolveNodeOutputs(source, graph);

    const fromPort = portById(sourceOutputs, edge.sourceHandle);
    const toPort = portById(resolveNodeInputs(target), edge.targetHandle);

    if (!fromPort || !toPort) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_PORT',
        message: `Fil rattaché à un port inexistant (${edge.sourceHandle} → ${edge.targetHandle}).`,
        edgeId: edge.id,
      });
      continue;
    }

    if (!canConnect(fromPort.type, toPort.type)) {
      issues.push({
        severity: 'error',
        code: 'TYPE_MISMATCH',
        message: `Types incompatibles : ${fromPort.type} ne peut pas alimenter ${toPort.type}.`,
        edgeId: edge.id,
      });
      continue;
    }

    if (fromPort.type === 'Exec') {
      const key = `${edge.source}:${edge.sourceHandle}`;
      execOutUsage.set(key, (execOutUsage.get(key) ?? 0) + 1);
      execAdjacency.set(edge.source, [...(execAdjacency.get(edge.source) ?? []), edge.target]);
    } else {
      const key = `${edge.target}:${edge.targetHandle}`;
      dataInUsage.set(key, (dataInUsage.get(key) ?? 0) + 1);
      // Le fil de données va de la source vers la cible, mais l'évaluation
      // remonte de la cible vers la source : on enregistre ce sens-là.
      dataAdjacency.set(edge.target, [...(dataAdjacency.get(edge.target) ?? []), edge.source]);
    }
  }

  // Une sortie d'exécution ne peut alimenter qu'un seul nœud : sinon l'ordre
  // d'exécution serait indéterminé.
  for (const [key, count] of execOutUsage) {
    if (count > 1) {
      issues.push({
        severity: 'error',
        code: 'EXEC_FORK',
        message: 'Une sortie d\'exécution ne peut être reliée qu\'à un seul nœud.',
        nodeId: key.split(':')[0],
      });
    }
  }

  // Une entrée de données ne peut recevoir qu'une seule valeur.
  for (const [key, count] of dataInUsage) {
    if (count > 1) {
      issues.push({
        severity: 'error',
        code: 'DATA_MERGE',
        message: 'Une entrée de données ne peut recevoir qu\'un seul fil.',
        nodeId: key.split(':')[0],
      });
    }
  }

  // ── Entrées obligatoires ─────────────────────────────────────────────────
  for (const node of nodes) {
    const def = getNodeDef(node.type);
    if (!def) continue;

    for (const input of resolveNodeInputs(node)) {
      if (input.type === 'Exec' || input.optional) continue;

      const connected = dataInUsage.has(`${node.id}:${input.id}`);
      // Un port peut aussi être renseigné par un champ de configuration
      // portant la même clé (le nœud Delay fonctionne ainsi).
      const configured = node.config?.[input.id] !== undefined && node.config?.[input.id] !== '';

      if (!connected && !configured) {
        issues.push({
          severity: 'error',
          code: 'MISSING_INPUT',
          message: `L'entrée « ${input.label} » de ${def.label} n'est pas renseignée.`,
          nodeId: node.id,
        });
      }
    }
  }

  // ── Planification ────────────────────────────────────────────────────────
  // Le motif du déclencheur « Planification » vit en configuration, pas sur un
  // port : les règles d'entrées ci-dessus ne le voient pas. Un motif vide ou
  // mal formé ne ferait jamais partir le workflow, en silence.
  for (const node of nodes) {
    if (node.type !== 'OnSchedule') continue;

    const expression = typeof node.config?.cron === 'string' ? node.config.cron : '';
    if (!expression.trim()) {
      issues.push({
        severity: 'error',
        code: 'MISSING_SCHEDULE',
        message: 'La planification n\'est pas renseignée.',
        nodeId: node.id,
      });
    } else if (!isValidCron(expression)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_SCHEDULE',
        message: `Planification illisible : « ${expression} ».`,
        nodeId: node.id,
      });
    }
  }

  // ── Cycles ───────────────────────────────────────────────────────────────
  const nodeIds = nodes.map((node) => node.id);

  const execCycle = findCycle(execAdjacency, nodeIds);
  if (execCycle) {
    issues.push({
      severity: 'error',
      code: 'EXEC_CYCLE',
      message: 'Le flux d\'exécution boucle sur lui-même. Utilisez un nœud « Pour chaque » pour répéter une action.',
      nodeId: execCycle[0],
    });
  }

  const dataCycle = findCycle(dataAdjacency, nodeIds);
  if (dataCycle) {
    issues.push({
      severity: 'error',
      code: 'DATA_CYCLE',
      message: 'Deux nœuds de données dépendent l\'un de l\'autre.',
      nodeId: dataCycle[0],
    });
  }

  // ── Avertissements ───────────────────────────────────────────────────────
  const reachable = new Set<string>();
  if (triggers.length === 1) {
    const queue = [triggers[0].id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (reachable.has(current)) continue;
      reachable.add(current);
      queue.push(...(execAdjacency.get(current) ?? []));
    }

    for (const node of nodes) {
      const def = getNodeDef(node.type);
      // Seuls les nœuds du flux d'exécution ont vocation à être atteints ;
      // les nœuds de données sont tirés à la demande.
      const inExecFlow = def && (def.category === 'action' || def.category === 'flow');
      if (inExecFlow && !reachable.has(node.id)) {
        issues.push({
          severity: 'warning',
          code: 'UNREACHABLE_NODE',
          message: `« ${def.label} » n'est relié à aucun chemin d'exécution.`,
          nodeId: node.id,
        });
      }
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
