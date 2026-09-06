import {
  DEFAULT_BUDGET,
  getNodeDef,
  resolveNodeInputs,
  type ExecutionBudget,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '@kotbo/shared';
import {
  coerceToBoolean,
  coerceToList,
  coerceToNumber,
  coerceToString,
  daysSince,
  isChannel,
  isMember,
  isRole,
  type ChannelValue,
  type MemberValue,
  type RoleValue,
} from './values.js';

/**
 * Interpréteur de workflows.
 *
 * Deux mécanismes distincts cohabitent :
 *
 *  - Les **données** sont tirées à la demande : quand un nœud a besoin d'une
 *    entrée, on remonte le fil et on évalue la source, récursivement. Un nœud
 *    de données jamais relié à une entrée utile n'est donc jamais évalué.
 *
 *  - L'**exécution** avance sur une pile de continuations explicite plutôt que
 *    par récursion. C'est ce qui permet à un nœud « Attendre » de suspendre
 *    l'exécution au milieu d'une boucle et de la reprendre plus tard : la pile
 *    est un simple tableau sérialisable.
 *
 * Tout ce qui touche Discord passe par l'interface `WorkflowEffects`, ce qui
 * rend le moteur entièrement testable sans client Discord.
 */

// ============================================================================
// EFFETS EXTERNES
// ============================================================================

export interface WorkflowEffects {
  getRole(roleId: string): Promise<RoleValue | null>;
  getChannel(channelId: string): Promise<ChannelValue | null>;
  getMember(userId: string): Promise<MemberValue | null>;
  getGuildInfo(): Promise<{ name: string; memberCount: number }>;
  /** Exécute une action à effet de bord et retourne ses éventuelles sorties. */
  runAction(
    type: string,
    inputs: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

// ============================================================================
// ÉTAT D'EXÉCUTION
// ============================================================================

/** Une continuation : soit un nœud à exécuter, soit une boucle à poursuivre. */
export type Frame =
  | { kind: 'node'; nodeId: string }
  | { kind: 'loop'; nodeId: string; items: unknown[]; index: number };

export interface StepRecord {
  order: number;
  nodeId: string;
  nodeType: string;
  status: 'OK' | 'ERROR' | 'SKIPPED';
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

/** État sérialisable d'une exécution, suffisant pour la reprendre plus tard. */
export interface ExecutionState {
  stack: Frame[];
  /** Valeurs des sorties du déclencheur, réinjectées à chaque reprise */
  triggerOutputs: Record<string, unknown>;
  /** Élément et index courants de chaque boucle en cours */
  loopValues: Record<string, { item: unknown; index: number }>;
  nodeVisits: number;
  iterations: number;
  /**
   * Rang de la prochaine étape tracée. Reporté d'une reprise à l'autre : sans
   * lui, les étapes exécutées après un « Attendre » repartiraient du rang 0 et
   * s'entremêleraient avec les précédentes dans le détail d'exécution.
   */
  stepOrder: number;
  /**
   * Profondeur de cascade au départ de l'exécution. Le moteur ne s'en sert
   * pas : il la transporte pour que `workflowService` la retrouve à la reprise.
   * Sans elle, une chaîne d'automatisations coupée par un « Attendre »
   * repartirait de zéro et sa borne ne l'arrêterait jamais.
   */
  cascadeDepth?: number;
}

export type ExecutionOutcome =
  | { status: 'COMPLETED'; steps: StepRecord[]; state: ExecutionState }
  | { status: 'SUSPENDED'; steps: StepRecord[]; state: ExecutionState; resumeAt: Date }
  | { status: 'FAILED'; steps: StepRecord[]; state: ExecutionState; error: string };

export interface RunOptions {
  graph: WorkflowGraph;
  effects: WorkflowEffects;
  budget?: ExecutionBudget;
  /** État repris après une suspension ; absent pour un premier départ */
  state?: ExecutionState;
  /** Sorties du nœud déclencheur, pour un premier départ */
  triggerOutputs?: Record<string, unknown>;
  now?: () => number;
}

// ============================================================================
// MOTEUR
// ============================================================================

class BudgetExceededError extends Error {}

export async function runWorkflow(options: RunOptions): Promise<ExecutionOutcome> {
  const { graph, effects } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps: StepRecord[] = [];

  const state: ExecutionState = options.state ?? {
    stack: [],
    triggerOutputs: options.triggerOutputs ?? {},
    loopValues: {},
    nodeVisits: 0,
    iterations: 0,
    stepOrder: 0,
  };

  // Un état sérialisé avant l'introduction du compteur reprend à zéro : mieux
  // vaut des rangs qui se chevauchent qu'une exécution qui échoue à la reprise.
  if (typeof state.stepOrder !== 'number') state.stepOrder = 0;

  // Premier départ : on part du nœud relié à la sortie du déclencheur.
  if (!options.state) {
    const trigger = graph.nodes.find((node) => getNodeDef(node.type)?.category === 'trigger');
    if (!trigger) {
      return { status: 'FAILED', steps, state, error: 'Aucun déclencheur dans le graphe.' };
    }
    const first = execTarget(graph, trigger.id, 'next');
    if (first) state.stack = [{ kind: 'node', nodeId: first }];
  }

  /**
   * Les valeurs mémorisées sont invalidées à chaque itération de boucle : un
   * nœud qui lit l'élément courant doit être réévalué, sinon toute la boucle
   * travaillerait sur le premier élément.
   */
  let generation = 0;
  const memo = new Map<string, unknown>();
  const resolving = new Set<string>();

  function checkBudget(): void {
    if (state.nodeVisits > budget.maxNodeVisits) {
      throw new BudgetExceededError(`Budget dépassé : plus de ${budget.maxNodeVisits} nœuds parcourus.`);
    }
    if (state.iterations > budget.maxIterations) {
      throw new BudgetExceededError(`Budget dépassé : plus de ${budget.maxIterations} itérations.`);
    }
    if (now() - startedAt > budget.maxDurationMs) {
      throw new BudgetExceededError(`Budget dépassé : exécution de plus de ${budget.maxDurationMs} ms.`);
    }
  }

  // ── Évaluation des données (tirée à la demande) ──────────────────────────
  async function evaluatePort(nodeId: string, portId: string): Promise<unknown> {
    const key = `${generation}:${nodeId}:${portId}`;
    if (memo.has(key)) return memo.get(key);

    if (resolving.has(key)) {
      throw new Error(`Dépendance circulaire sur ${nodeId}.${portId}.`);
    }
    resolving.add(key);

    try {
      const node = nodeById.get(nodeId);
      if (!node) return null;

      const def = getNodeDef(node.type);
      if (!def) return null;

      // Déclencheur : ses sorties sont fournies au démarrage
      if (def.category === 'trigger') {
        const value = state.triggerOutputs[portId] ?? null;
        memo.set(key, value);
        return value;
      }

      // Boucle : élément et index courants
      if (node.type === 'ForEach') {
        const loop = state.loopValues[nodeId];
        const value = portId === 'item' ? loop?.item ?? null : portId === 'index' ? loop?.index ?? 0 : null;
        memo.set(key, value);
        return value;
      }

      const outputs = await evaluateDataNode(node);
      for (const [outId, outValue] of Object.entries(outputs)) {
        memo.set(`${generation}:${nodeId}:${outId}`, outValue);
      }
      return outputs[portId] ?? null;
    } finally {
      resolving.delete(key);
    }
  }

  /** Valeur d'une entrée : le fil branché, sinon la configuration du nœud. */
  async function inputValue(node: WorkflowNode, portId: string): Promise<unknown> {
    const incoming = graph.edges.find((e) => e.target === node.id && e.targetHandle === portId);
    if (incoming) {
      const raw = await evaluatePort(incoming.source, incoming.sourceHandle);
      return applyCoercion(graph, incoming, raw);
    }
    return node.config?.[portId] ?? null;
  }

  async function collectInputs(node: WorkflowNode): Promise<Record<string, unknown>> {
    const def = getNodeDef(node.type);
    if (!def) return {};

    const inputs: Record<string, unknown> = {};
    for (const port of resolveNodeInputs(node)) {
      if (port.type === 'Exec') continue;
      inputs[port.id] = await inputValue(node, port.id);
    }
    return inputs;
  }

  async function evaluateDataNode(node: WorkflowNode): Promise<Record<string, unknown>> {
    const inputs = await collectInputs(node);
    const config = node.config ?? {};
    return evaluatePureNode(node.type, inputs, config, effects, now());
  }

  // ── Parcours du flux d'exécution ─────────────────────────────────────────
  try {
    while (state.stack.length > 0) {
      checkBudget();
      const frame = state.stack.pop() as Frame;

      // Poursuite d'une boucle
      if (frame.kind === 'loop') {
        if (frame.index < frame.items.length) {
          state.iterations++;
          generation++;
          state.loopValues[frame.nodeId] = { item: frame.items[frame.index], index: frame.index };
          // La continuation est empilée d'abord : le corps s'exécutera avant.
          state.stack.push({ ...frame, index: frame.index + 1 });
          const body = execTarget(graph, frame.nodeId, 'body');
          if (body) state.stack.push({ kind: 'node', nodeId: body });
        } else {
          delete state.loopValues[frame.nodeId];
          generation++;
          const done = execTarget(graph, frame.nodeId, 'done');
          if (done) state.stack.push({ kind: 'node', nodeId: done });
        }
        continue;
      }

      const node = nodeById.get(frame.nodeId);
      if (!node) continue;

      const def = getNodeDef(node.type);
      if (!def) {
        throw new Error(`Type de nœud inconnu : ${node.type}.`);
      }

      state.nodeVisits++;
      const stepStart = now();
      const inputs = await collectInputs(node);

      // ── Nœuds de contrôle de flux ──────────────────────────────────────
      if (node.type === 'If') {
        const condition = coerceToBoolean(inputs.condition);
        const target = execTarget(graph, node.id, condition ? 'true' : 'false');
        if (target) state.stack.push({ kind: 'node', nodeId: target });
        steps.push(step(state.stepOrder++, node, inputs, { branche: condition ? 'Vrai' : 'Faux' }, now() - stepStart));
        continue;
      }

      if (node.type === 'Switch') {
        const value = coerceToString(inputs.value);
        const cases = Array.isArray(node.config?.cases) ? (node.config.cases as unknown[]) : [];
        const matched = cases.findIndex((c) => typeof c === 'string' && c === value);
        const handle = matched >= 0 ? `case-${matched}` : 'default';
        const target = execTarget(graph, node.id, handle);
        if (target) state.stack.push({ kind: 'node', nodeId: target });
        steps.push(step(state.stepOrder++, node, inputs, { sortie: matched >= 0 ? String(cases[matched]) : 'Sinon' }, now() - stepStart));
        continue;
      }

      if (node.type === 'ForEach') {
        const items = coerceToList(inputs.list);
        if (items.length > budget.maxIterations) {
          throw new BudgetExceededError(
            `La liste parcourue contient ${items.length} éléments, au-delà de la limite de ${budget.maxIterations}.`,
          );
        }
        if (loopDepth(state.stack) >= budget.maxLoopDepth) {
          throw new BudgetExceededError(`Imbrication de boucles supérieure à ${budget.maxLoopDepth}.`);
        }
        state.stack.push({ kind: 'loop', nodeId: node.id, items, index: 0 });
        steps.push(step(state.stepOrder++, node, inputs, { éléments: items.length }, now() - stepStart));
        continue;
      }

      if (node.type === 'Delay') {
        const seconds = Math.max(1, coerceToNumber(inputs.seconds ?? node.config?.seconds ?? 60));
        const next = execTarget(graph, node.id, 'next');
        // La reprise repartira du nœud suivant : le Delay lui-même est consommé.
        if (next) state.stack.push({ kind: 'node', nodeId: next });
        steps.push(step(state.stepOrder++, node, inputs, { secondes: seconds }, now() - stepStart));
        return {
          status: 'SUSPENDED',
          steps,
          state,
          resumeAt: new Date(now() + seconds * 1000),
        };
      }

      // ── Actions ────────────────────────────────────────────────────────
      if (def.category === 'action') {
        const outputs = await effects.runAction(node.type, inputs, node.config ?? {});
        for (const [outId, outValue] of Object.entries(outputs)) {
          memo.set(`${generation}:${node.id}:${outId}`, outValue);
        }
        steps.push(step(state.stepOrder++, node, inputs, outputs, now() - stepStart));

        const next = execTarget(graph, node.id, 'next');
        if (next) state.stack.push({ kind: 'node', nodeId: next });
        continue;
      }

      // Un nœud de données atteint par le flux d'exécution n'a rien à y faire
      steps.push(step(state.stepOrder++, node, inputs, {}, now() - stepStart, 'SKIPPED'));
    }

    return { status: 'COMPLETED', steps, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (steps.length > 0) {
      const last = steps[steps.length - 1];
      if (last.status === 'OK') {
        last.status = 'ERROR';
        last.error = message;
      }
    }
    return { status: 'FAILED', steps, state, error: message };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function step(
  order: number,
  node: WorkflowNode,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  durationMs: number,
  status: StepRecord['status'] = 'OK',
): StepRecord {
  return { order, nodeId: node.id, nodeType: node.type, status, inputs, outputs, durationMs };
}

function execTarget(graph: WorkflowGraph, nodeId: string, handle: string): string | null {
  const edge = graph.edges.find((e) => e.source === nodeId && e.sourceHandle === handle);
  return edge?.target ?? null;
}

function loopDepth(stack: Frame[]): number {
  return stack.filter((frame) => frame.kind === 'loop').length;
}

/**
 * Applique la conversion implicite vers du texte quand le port cible est de
 * type String et que la source ne l'est pas.
 */
function applyCoercion(graph: WorkflowGraph, edge: WorkflowEdge, value: unknown): unknown {
  const target = graph.nodes.find((n) => n.id === edge.target);
  const port = target
    ? resolveNodeInputs(target).find((p) => p.id === edge.targetHandle)
    : undefined;
  if (port?.type === 'String' && typeof value !== 'string') return coerceToString(value);
  return value;
}

/**
 * Évaluation d'un nœud de données ou de logique.
 *
 * Tout ce qui peut être calculé sans Discord l'est ici, ce qui laisse à
 * `WorkflowEffects` une surface minimale et rend l'essentiel testable.
 */
export async function evaluatePureNode(
  type: string,
  inputs: Record<string, unknown>,
  config: Record<string, unknown>,
  effects: WorkflowEffects,
  now: number,
): Promise<Record<string, unknown>> {
  switch (type) {
    // ── Constantes ─────────────────────────────────────────────────────────
    case 'ConstText':
      return { value: String(config.value ?? '') };
    case 'ConstNumber':
      return { value: coerceToNumber(config.value) };
    case 'ConstBoolean':
      return { value: Boolean(config.value) };

    /**
     * Texte composé : chaque `{slot}` du gabarit est remplacé par la valeur
     * branchée sur l'entrée du même nom. Un emplacement sans valeur donne une
     * chaîne vide plutôt que le jeton brut, pour ne jamais publier « {slot0} »
     * dans un salon.
     */
    case 'FormatText': {
      const template = String(config.template ?? '');
      return {
        value: template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, slot: string) => (
          slot in inputs ? coerceToString(inputs[slot]) : whole
        )),
      };
    }

    // ── Sélecteurs Discord ─────────────────────────────────────────────────
    case 'SelectRole':
      return { role: await effects.getRole(String(config.roleId ?? '')) };
    case 'SelectChannel':
      return { channel: await effects.getChannel(String(config.channelId ?? '')) };
    case 'GuildInfo': {
      const guild = await effects.getGuildInfo();
      return { name: guild.name, memberCount: guild.memberCount };
    }

    // ── Accesseurs ─────────────────────────────────────────────────────────
    case 'MemberInfo': {
      const member = inputs.member;
      if (!isMember(member)) {
        return { displayName: '', tag: '', id: '', accountAgeDays: 0, joinedDaysAgo: 0, isBot: false, roles: [] };
      }
      // Les rôles sont résolus en entités pour rester utilisables en aval
      const roles = await Promise.all(member.roleIds.map((id) => effects.getRole(id)));
      return {
        displayName: member.displayName,
        tag: member.tag,
        id: member.id,
        accountAgeDays: daysSince(member.accountCreatedAt, now),
        joinedDaysAgo: daysSince(member.joinedAt, now),
        isBot: member.isBot,
        roles: roles.filter((role): role is RoleValue => role !== null),
      };
    }

    case 'MessageInfo': {
      const message = inputs.message;
      if (!message || typeof message !== 'object') {
        return { content: '', author: null, channel: null, length: 0 };
      }
      const value = message as { content?: string; authorId?: string; channelId?: string };
      return {
        content: value.content ?? '',
        author: value.authorId ? await effects.getMember(value.authorId) : null,
        channel: value.channelId ? await effects.getChannel(value.channelId) : null,
        length: (value.content ?? '').length,
      };
    }

    case 'ChannelInfo': {
      const channel = inputs.channel;
      if (!isChannel(channel)) return { name: '', id: '', categoryName: '' };
      return { name: channel.name, id: channel.id, categoryName: channel.categoryName ?? '' };
    }

    // ── Logique ────────────────────────────────────────────────────────────
    case 'HasRole': {
      const member = inputs.member;
      const role = inputs.role;
      if (!isMember(member) || !isRole(role)) return { result: false };
      return { result: member.roleIds.includes(role.id) };
    }

    case 'ChannelEquals': {
      const a = inputs.a;
      const b = inputs.b;
      if (!isChannel(a) || !isChannel(b)) return { result: false };
      return { result: a.id === b.id };
    }

    case 'TextContains': {
      const haystack = coerceToString(inputs.text);
      const needle = coerceToString(inputs.search);
      if (needle === '') return { result: false };
      return config.caseSensitive
        ? { result: haystack.includes(needle) }
        : { result: haystack.toLowerCase().includes(needle.toLowerCase()) };
    }

    case 'TextEquals': {
      const a = coerceToString(inputs.a);
      const b = coerceToString(inputs.b);
      return config.caseSensitive
        ? { result: a === b }
        : { result: a.toLowerCase() === b.toLowerCase() };
    }

    case 'Compare': {
      const a = coerceToNumber(inputs.a);
      const b = coerceToNumber(inputs.b);
      switch (config.operator) {
        case 'gte': return { result: a >= b };
        case 'lt': return { result: a < b };
        case 'lte': return { result: a <= b };
        case 'eq': return { result: a === b };
        case 'neq': return { result: a !== b };
        default: return { result: a > b };
      }
    }

    case 'Logic': {
      const a = coerceToBoolean(inputs.a);
      const b = coerceToBoolean(inputs.b);
      return { result: config.operator === 'or' ? a || b : a && b };
    }

    case 'Not':
      return { result: !coerceToBoolean(inputs.value) };

    case 'Concat': {
      const separator = typeof config.separator === 'string' ? config.separator : '';
      return { result: `${coerceToString(inputs.a)}${separator}${coerceToString(inputs.b)}` };
    }

    case 'TextLength':
      return { result: coerceToString(inputs.text).length };

    case 'Math': {
      const a = coerceToNumber(inputs.a);
      const b = coerceToNumber(inputs.b);
      switch (config.operator) {
        case 'sub': return { result: a - b };
        case 'mul': return { result: a * b };
        // Une division par zéro renvoie 0 plutôt que l'infini, qui ne serait
        // ni sérialisable en JSON ni exploitable en aval.
        case 'div': return { result: b === 0 ? 0 : a / b };
        default: return { result: a + b };
      }
    }

    case 'ListLength':
      return { result: coerceToList(inputs.list).length };

    default:
      return {};
  }
}
