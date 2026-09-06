import { describe, expect, test } from 'bun:test';
import {
  compileRecipe,
  estimateNodeHeight,
  layoutGraph,
  placeNewNode,
  RECIPE_TEMPLATES,
  type WorkflowGraph,
} from '@kotbo/shared';

/** Deux cartes d'une même colonne ne doivent jamais se recouvrir. */
function overlaps(graph: WorkflowGraph): string[] {
  const clashes: string[] = [];
  for (const a of graph.nodes) {
    for (const b of graph.nodes) {
      if (a.id >= b.id) continue;
      const sameColumn = Math.abs(a.position.x - b.position.x) < 200;
      if (!sameColumn) continue;

      const aBottom = a.position.y + estimateNodeHeight(a, graph);
      const bBottom = b.position.y + estimateNodeHeight(b, graph);
      if (a.position.y < bBottom && b.position.y < aBottom) {
        clashes.push(`${a.id} / ${b.id}`);
      }
    }
  }
  return clashes;
}

describe('disposition du graphe', () => {
  test('aucun modele compile ne se chevauche apres rangement', () => {
    for (const template of RECIPE_TEMPLATES) {
      const arranged = layoutGraph(compileRecipe(template.build()));
      expect(overlaps(arranged)).toEqual([]);
    }
  });

  test('le declencheur ouvre la disposition, les actions viennent apres', () => {
    const graph = layoutGraph(compileRecipe(RECIPE_TEMPLATES[0].build()));
    const trigger = graph.nodes.find((node) => node.type === 'OnMemberJoin');
    const action = graph.nodes.find((node) => node.type === 'SendMessage');

    expect(trigger).toBeDefined();
    expect(action).toBeDefined();
    expect(action!.position.x).toBeGreaterThan(trigger!.position.x);
  });

  test('une valeur se range avant le noeud qu\'elle alimente', () => {
    const graph = layoutGraph(compileRecipe(RECIPE_TEMPLATES[0].build()));
    const format = graph.nodes.find((node) => node.type === 'FormatText');
    const action = graph.nodes.find((node) => node.type === 'SendMessage');

    expect(format).toBeDefined();
    expect(format!.position.x).toBeLessThan(action!.position.x);
  });

  test('ne touche ni aux noeuds ni aux fils', () => {
    const source = compileRecipe(RECIPE_TEMPLATES[1].build());
    const arranged = layoutGraph(source);

    expect(arranged.nodes.map((n) => n.id).sort()).toEqual(source.nodes.map((n) => n.id).sort());
    expect(arranged.edges).toEqual(source.edges);
    expect(arranged.nodes.map((n) => n.type).sort()).toEqual(source.nodes.map((n) => n.type).sort());
  });

  test('supporte un graphe vide et un graphe sans declencheur', () => {
    expect(layoutGraph({ nodes: [], edges: [] }).nodes).toEqual([]);

    const orphans: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'ConstText', position: { x: 0, y: 0 }, config: { value: 'x' } },
        { id: 'b', type: 'ConstText', position: { x: 0, y: 0 }, config: { value: 'y' } },
      ],
      edges: [],
    };
    expect(overlaps(layoutGraph(orphans))).toEqual([]);
  });

  test('une boucle d\'execution ne fait pas tourner le rangement indefiniment', () => {
    // La validation refuse ce graphe, mais l'API peut en recevoir un.
    const cyclic: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'OnMemberJoin', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'SendDM', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', type: 'SendDM', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 't', sourceHandle: 'next', target: 'a', targetHandle: 'exec' },
        { id: 'e2', source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'exec' },
        { id: 'e3', source: 'b', sourceHandle: 'next', target: 'a', targetHandle: 'exec' },
      ],
    };
    expect(layoutGraph(cyclic).nodes).toHaveLength(3);
  });
});

describe('placement d\'un nouveau noeud', () => {
  test('le premier noeud part de l\'origine', () => {
    expect(placeNewNode({ nodes: [], edges: [] })).toEqual({ x: 0, y: 0 });
  });

  test('ne se pose jamais sur une carte existante', () => {
    const graph = layoutGraph(compileRecipe(RECIPE_TEMPLATES[0].build()));
    const at = placeNewNode(graph);

    const collides = graph.nodes.some((node) => (
      Math.abs(node.position.x - at.x) < 200
      && at.y < node.position.y + estimateNodeHeight(node, graph)
      && node.position.y < at.y + 90
    ));
    expect(collides).toBeFalse();
  });

  test('se range a droite du noeud d\'ancrage', () => {
    const graph = layoutGraph(compileRecipe(RECIPE_TEMPLATES[0].build()));
    const trigger = graph.nodes.find((node) => node.type === 'OnMemberJoin')!;
    expect(placeNewNode(graph, trigger.id).x).toBeGreaterThan(trigger.position.x);
  });
});
