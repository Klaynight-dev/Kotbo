export interface LayoutNode {
  id: string;
  activityCount: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  totalCount: number;
}

export interface LayoutPosition {
  id: string;
  x: number;
  y: number;
  radius: number;
  isHub: boolean;
  isCenter: boolean;
  hubId: string;
}

export interface LayoutOptions {
  width: number;
  height: number;
}

interface WorkNode extends LayoutPosition {
  vx: number;
  vy: number;
}

const EDGE_CAP = 250;

// Fruchterman-Reingold, exécuté en une passe synchrone. Appelé depuis un worker
// quand le navigateur en fournit un, sinon directement sur le thread principal.
export function computeForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  { width, height }: LayoutOptions
): LayoutPosition[] {
  if (nodes.length === 0) return [];

  const cx = width / 2;
  const cy = height / 2;
  const N = nodes.length;
  const area = width * height;
  const kFR = 1.3 * Math.sqrt(area / N);

  const sorted = [...nodes].sort((a, b) => b.activityCount - a.activityCount);
  const maxActivity = sorted[0]?.activityCount || 1;
  const sizeFactor = N > 120 ? 0.65 : N > 70 ? 0.85 : 1.0;

  const adjacency = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, count: number) => {
    let neighbours = adjacency.get(a);
    if (!neighbours) {
      neighbours = new Map<string, number>();
      adjacency.set(a, neighbours);
    }
    neighbours.set(b, (neighbours.get(b) || 0) + count);
  };
  for (const edge of edges) {
    link(edge.from, edge.to, edge.totalCount);
    link(edge.to, edge.from, edge.totalCount);
  }

  // Identify Community Hubs (top 5 community centers)
  const kHubs = Math.min(5, sorted.length);
  const hubs = sorted.slice(0, kHubs);
  const hubIds = hubs.map(h => h.id);
  const hubIdSet = new Set(hubIds);

  const hubSizes = new Map<string, number>();
  hubIds.forEach(id => hubSizes.set(id, 0));

  const nodeHubMap = new Map<string, string>();

  for (const node of sorted.slice(kHubs)) {
    let bestHubId = '';
    let maxCount = -1;

    const neighbours = adjacency.get(node.id);
    if (neighbours) {
      for (const hubId of hubIds) {
        const count = neighbours.get(hubId);
        if (count !== undefined && count > maxCount) {
          maxCount = count;
          bestHubId = hubId;
        }
      }
    }

    if (!bestHubId) {
      let minSize = Infinity;
      bestHubId = hubIds[0] || '';
      for (const hubId of hubIds) {
        const size = hubSizes.get(hubId) ?? 0;
        if (size < minSize) {
          minSize = size;
          bestHubId = hubId;
        }
      }
    }

    nodeHubMap.set(node.id, bestHubId);
    hubSizes.set(bestHubId, (hubSizes.get(bestHubId) ?? 0) + 1);
  }

  // Spaced out hubs positions
  const hubPositions = new Map<string, { x: number; y: number }>();
  hubs.forEach((hub, index) => {
    const angle = (index / kHubs) * 2 * Math.PI - Math.PI / 2;
    const R = Math.min(width, height) * 0.34;
    hubPositions.set(hub.id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
  });

  // Initialize all nodes near their hub center in a spiral
  const workNodes: WorkNode[] = sorted.map((n, i) => {
    const isHub = hubIdSet.has(n.id);
    const hubId = isHub ? n.id : (nodeHubMap.get(n.id) || '');
    const hubPos = hubPositions.get(hubId) || { x: cx, y: cy };

    const activityRatio = n.activityCount / maxActivity;
    // Proportional radius from 14px (visible and clean) to 30px (hubs)
    const radius = Math.max(14, (14 + activityRatio * 16) * sizeFactor);

    const angle = i * 0.25 * Math.PI;
    const r = 20 + i * 2.5;

    return {
      id: n.id,
      x: isHub ? hubPos.x : hubPos.x + r * Math.cos(angle),
      y: isHub ? hubPos.y : hubPos.y + r * Math.sin(angle),
      vx: 0,
      vy: 0,
      radius,
      isHub,
      isCenter: i === 0,
      hubId
    };
  });

  const byId = new Map(workNodes.map(n => [n.id, n]));

  // Paires (noeud, hub) et liens résolus une fois pour toutes plutôt qu'à chaque itération
  const hubPulls: Array<[WorkNode, WorkNode]> = [];
  for (const node of workNodes) {
    if (node.isHub) continue;
    const hubNode = byId.get(node.hubId);
    if (hubNode) hubPulls.push([node, hubNode]);
  }

  const strongestEdges = edges.length <= EDGE_CAP
    ? edges
    : [...edges].sort((a, b) => b.totalCount - a.totalCount).slice(0, EDGE_CAP);

  const links: Array<[WorkNode, WorkNode, number]> = [];
  for (const edge of strongestEdges) {
    const n1 = byId.get(edge.from);
    const n2 = byId.get(edge.to);
    if (n1 && n2) links.push([n1, n2, Math.min(1.5, 0.8 + edge.totalCount * 0.15)]);
  }

  // Moins d'itérations sur les gros graphes : la répulsion reste en O(N^2)
  const iterations = N > 400 ? 45 : N > 150 ? 70 : 100;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = (iterations - iter) / iterations; // cooling temperature

    // Le vecteur de deplacement repart de zero a chaque passe : c'est la somme
    // des forces de cette iteration-la qui donne la direction. Le cumuler d'une
    // passe a l'autre revenait a garder un elan que rien n'amortit, et le
    // placement final suivait l'historique des forces plutot que l'etat courant.
    for (const n of workNodes) {
      n.vx = 0;
      n.vy = 0;
    }

    // A. Repulsion forces between all nodes
    for (let i = 0; i < workNodes.length; i++) {
      const n1 = workNodes[i];
      for (let j = i + 1; j < workNodes.length; j++) {
        const n2 = workNodes[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;

        const minDist = n1.radius + n2.radius + 36; // spacing margin
        let fr = (kFR * kFR) / dist;

        if (dist < minDist) {
          fr += (minDist - dist) * 1.5; // push hard if overlapping
        }

        const fx = (dx / dist) * fr;
        const fy = (dy / dist) * fr;

        n1.vx -= fx;
        n1.vy -= fy;
        n2.vx += fx;
        n2.vy += fy;
      }
    }

    // B. Link attraction forces along edges
    for (const [n1, n2, strength] of links) {
      const dx = n2.x - n1.x;
      const dy = n2.y - n1.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const fa = ((dist * dist) / kFR) * 0.08 * strength;

      const fx = (dx / dist) * fa;
      const fy = (dy / dist) * fa;

      n1.vx += fx;
      n1.vy += fy;
      n2.vx -= fx;
      n2.vy -= fy;
    }

    // C. Attraction to Hub center
    for (const [node, hubNode] of hubPulls) {
      const dx = hubNode.x - node.x;
      const dy = hubNode.y - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;

      const fa = ((dist * dist) / kFR) * 0.035; // pull towards hub
      node.vx += (dx / dist) * fa;
      node.vy += (dy / dist) * fa;
    }

    // D. Gravity to viewport center
    for (const n of workNodes) {
      const dx = cx - n.x;
      const dy = cy - n.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;

      n.vx += (dx / dist) * (dist * 0.012);
      n.vy += (dy / dist) * (dist * 0.012);
    }

    // E. Update coordinates limited by cooling temperature
    for (const n of workNodes) {
      const d = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 0.1;
      const limit = Math.min(d, 40 * temp);

      n.x += (n.vx / d) * limit;
      n.y += (n.vy / d) * limit;
    }
  }

  return workNodes.map(({ id, x, y, radius, isHub, isCenter, hubId }) => ({
    id, x, y, radius, isHub, isCenter, hubId
  }));
}
