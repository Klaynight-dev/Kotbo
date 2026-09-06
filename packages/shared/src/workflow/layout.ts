/**
 * Disposition d'un graphe sur le canevas.
 *
 * Le compilateur de recettes place déjà ce qu'il produit, mais un graphe monté
 * à la main - ou repris de l'ancien éditeur - n'a aucune garantie de lisibilité.
 * Ce module range n'importe quel graphe en colonnes : le flux d'exécution va de
 * gauche à droite, et ce qui alimente un nœud se pose juste à sa gauche.
 *
 * Les hauteurs sont estimées à partir du catalogue plutôt que mesurées : le
 * paquet partagé ne connaît pas le DOM. L'estimation suit la forme réelle de la
 * carte - un en-tête, une ligne par port, une par champ de configuration - ce
 * qui suffit à ne plus les faire se recouvrir.
 */

import { getNodeDef, resolveNodeInputs, resolveNodeOutputs } from './catalog.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

const COLUMN_WIDTH = 380;
/** Marge verticale entre deux cartes d'une même colonne. */
const ROW_GAP = 40;

const CARD_HEADER = 42;
const CARD_PADDING = 24;
const PORT_ROW = 32;
const CONFIG_ROW = 52;
const CARD_MIN_HEIGHT = 90;

/** Hauteur approximative d'une carte, d'après ce que son type fait afficher. */
export function estimateNodeHeight(node: WorkflowNode, graph: WorkflowGraph): number {
  const def = getNodeDef(node.type);
  if (!def) return CARD_MIN_HEIGHT;

  const inputs = resolveNodeInputs(node);
  const outputs = resolveNodeOutputs(node, graph);

  const execRows = Math.max(
    inputs.filter((port) => port.type === 'Exec').length,
    outputs.filter((port) => port.type === 'Exec').length,
  );
  const dataRows = Math.max(
    inputs.filter((port) => port.type !== 'Exec').length,
    outputs.filter((port) => port.type !== 'Exec').length,
  );

  const body = (execRows + dataRows) * PORT_ROW + (def.config?.length ?? 0) * CONFIG_ROW;
  return Math.max(CARD_MIN_HEIGHT, CARD_HEADER + CARD_PADDING + body);
}

/**
 * Colonne de chaque nœud, par chemin le plus long depuis les entrées.
 *
 * Chaque fil - d'exécution comme de données - pousse sa cible d'au moins une
 * colonne. C'est ce qui garantit qu'aucun fil ne remonte vers la gauche : un
 * classement qui ne suivrait que le flux d'exécution poserait « Infos du
 * membre » avant le déclencheur qui l'alimente.
 *
 * Le nombre de passes est borné par le nombre de nœuds : la validation refuse
 * les cycles, mais un graphe reçu par l'API n'en donne pas la garantie et la
 * relaxation ne convergerait jamais.
 */
function assignColumns(graph: WorkflowGraph): Map<string, number> {
  const columns = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));

  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let moved = false;

    for (const edge of graph.edges) {
      const from = columns.get(edge.source);
      const to = columns.get(edge.target);
      if (from === undefined || to === undefined || to >= from + 1) continue;
      columns.set(edge.target, from + 1);
      moved = true;
    }

    if (!moved) break;
  }

  return columns;
}

/**
 * Renvoie le même graphe, positions réécrites.
 *
 * Les nœuds et les fils ne sont pas touchés : seule la position change, ce qui
 * rend l'opération sûre à appliquer sur un graphe déjà enregistré.
 */
export function layoutGraph(graph: WorkflowGraph): WorkflowGraph {
  if (graph.nodes.length === 0) return graph;

  const columns = assignColumns(graph);

  const byColumn = new Map<number, WorkflowNode[]>();
  for (const node of graph.nodes) {
    const column = columns.get(node.id) ?? 0;
    byColumn.set(column, [...(byColumn.get(column) ?? []), node]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, nodes] of byColumn) {
    let y = 0;
    for (const node of nodes) {
      positions.set(node.id, { x: column * COLUMN_WIDTH, y });
      y += estimateNodeHeight(node, graph) + ROW_GAP;
    }
  }

  return {
    nodes: graph.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })),
    edges: graph.edges,
  };
}

/**
 * Où poser un nœud que l'on vient d'ajouter.
 *
 * Un placement au hasard fait atterrir la carte sur une autre, ou hors de la
 * zone visible quand le canevas a été déplacé. On se range donc contre le
 * graphe existant, sous la colonne visée.
 */
export function placeNewNode(graph: WorkflowGraph, nearNodeId?: string): { x: number; y: number } {
  if (graph.nodes.length === 0) return { x: 0, y: 0 };

  const anchor = nearNodeId ? graph.nodes.find((node) => node.id === nearNodeId) : undefined;
  const x = anchor
    ? anchor.position.x + COLUMN_WIDTH
    : Math.max(...graph.nodes.map((node) => node.position.x)) + COLUMN_WIDTH;

  // Sous la dernière carte de la colonne visée plutôt que dans un intervalle
  // libre : la hauteur du nœud à venir n'est pas encore connue, et viser un
  // trou reviendrait à parier dessus.
  const column = graph.nodes.filter((node) => Math.abs(node.position.x - x) < COLUMN_WIDTH / 2);
  if (column.length === 0) return { x, y: anchor ? anchor.position.y : 0 };

  const bottom = Math.max(...column.map((node) => node.position.y + estimateNodeHeight(node, graph)));
  return { x, y: bottom + ROW_GAP };
}
