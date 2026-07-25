<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';

  interface Node {
    id: string;
    label: string;
    type: 'user' | 'target';
    avatar?: string | null;
  }

  interface Edge {
    from: string;
    to: string;
    type: 'mention' | 'reply' | 'reaction';
    count: number;
  }

  interface SimNode extends Node {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    isCenter: boolean;
    weight: number;
  }

  let {
    nodes = [],
    edges = [],
    onSelectNode = (id: string) => {}
  }: {
    nodes: Node[],
    edges: Edge[],
    onSelectNode?: (id: string) => void
  } = $props();

  let container: HTMLDivElement;
  let width = $state(600);
  let height = $state(520);

  let panX = $state(0);
  let panY = $state(0);
  let zoom = $state(1);
  let isPanning = $state(false);
  let startPanX = $state(0);
  let startPanY = $state(0);
  let downX = 0;
  let downY = 0;

  let hoveredNodeId = $state<string | null>(null);
  let selectedNodeId = $state<string | null>(null);
  let hoveredEdge = $state<any | null>(null);

  let simNodes = $state<SimNode[]>([]);
  let simulationDone = $state(false);

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isPanning = true;
    startPanX = e.clientX - panX;
    startPanY = e.clientY - panY;
    downX = e.clientX;
    downY = e.clientY;
  }

  function handleMouseMove(e: MouseEvent) {
    if (isPanning) {
      panX = e.clientX - startPanX;
      panY = e.clientY - startPanY;
    }
  }

  function handleMouseUp() {
    isPanning = false;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = 1.1;
    if (e.deltaY < 0) {
      zoom = Math.min(zoom * factor, 3);
    } else {
      zoom = Math.max(zoom / factor, 0.3);
    }
  }

  function resetGraph() {
    panX = 0;
    panY = 0;
    zoom = 1;
    selectedNodeId = null;
    hoveredNodeId = null;
  }

  let adjacency = $derived.by(() => {
    const adj = new Map<string, Map<string, number>>();
    for (const edge of edges) {
      if (!adj.has(edge.from)) adj.set(edge.from, new Map());
      if (!adj.has(edge.to)) adj.set(edge.to, new Map());
      adj.get(edge.from)!.set(edge.to, (adj.get(edge.from)!.get(edge.to) ?? 0) + edge.count);
      adj.get(edge.to)!.set(edge.from, (adj.get(edge.to)!.get(edge.from) ?? 0) + edge.count);
    }
    return adj;
  });

  function runForceSimulation(w: number, h: number) {
    if (nodes.length === 0) {
      simNodes = [];
      return;
    }

    const cx = w / 2;
    const cy = h / 2;

    const centerNode = nodes.find(n => n.type === 'user') || nodes[0];
    const total = nodes.length;

    const weightMap = new Map<string, number>();
    for (const n of nodes) {
      let weight = 0;
      for (const e of edges) {
        if (e.from === n.id || e.to === n.id) weight += e.count;
      }
      weightMap.set(n.id, weight);
    }
    const maxWeight = Math.max(1, ...weightMap.values());

    const sNodes: SimNode[] = nodes.map((n, i) => {
      const w = weightMap.get(n.id) ?? 0;
      const isCenter = n.id === centerNode.id;
      const normalizedWeight = w / maxWeight;
      const radius = isCenter ? 28 : Math.max(12, 10 + normalizedWeight * 18);

      let x: number, y: number;
      if (isCenter) {
        x = cx;
        y = cy;
      } else {
        const angle = (i / total) * 2 * Math.PI + (Math.random() - 0.5) * 0.5;
        const dist = 80 + Math.random() * Math.min(w, h) * 0.3;
        x = cx + Math.cos(angle) * dist;
        y = cy + Math.sin(angle) * dist;
      }

      return {
        ...n,
        x,
        y,
        vx: 0,
        vy: 0,
        radius,
        isCenter,
        weight: w,
      };
    });

    const edgePairs: Array<{ source: number; target: number; strength: number }> = [];
    for (const e of edges) {
      const si = sNodes.findIndex(n => n.id === e.from);
      const ti = sNodes.findIndex(n => n.id === e.to);
      if (si >= 0 && ti >= 0) {
        const existing = edgePairs.find(ep =>
          (ep.source === si && ep.target === ti) || (ep.source === ti && ep.target === si)
        );
        if (existing) {
          existing.strength += e.count;
        } else {
          edgePairs.push({ source: si, target: ti, strength: e.count });
        }
      }
    }

    const maxEdgeStrength = Math.max(1, ...edgePairs.map(e => e.strength));
    const scaleFactor = Math.min(w, h) / 600;
    const idealDist = (70 + total * 2.5) * scaleFactor;
    const repulsionStrength = 2500 * scaleFactor * scaleFactor;
    const iterations = 300;

    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations;
      const cooling = alpha * alpha;

      for (let i = 0; i < sNodes.length; i++) {
        sNodes[i].vx = 0;
        sNodes[i].vy = 0;
      }

      for (let i = 0; i < sNodes.length; i++) {
        for (let j = i + 1; j < sNodes.length; j++) {
          const dx = sNodes[j].x - sNodes[i].x;
          const dy = sNodes[j].y - sNodes[i].y;
          const distSq = dx * dx + dy * dy;
          const dist = Math.sqrt(distSq) || 0.1;
          const minDist = sNodes[i].radius + sNodes[j].radius + 15;

          let force = repulsionStrength / distSq;
          if (dist < minDist) {
            force += (minDist - dist) * 2;
          }

          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          sNodes[i].vx -= fx;
          sNodes[i].vy -= fy;
          sNodes[j].vx += fx;
          sNodes[j].vy += fy;
        }
      }

      for (const ep of edgePairs) {
        const a = sNodes[ep.source];
        const b = sNodes[ep.target];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const normalizedStr = ep.strength / maxEdgeStrength;
        const targetDist = idealDist * (1 - normalizedStr * 0.5);
        const force = (dist - targetDist) * 0.04 * (1 + normalizedStr);

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.isCenter) { a.vx += fx; a.vy += fy; }
        if (!b.isCenter) { b.vx -= fx; b.vy -= fy; }
      }

      for (const n of sNodes) {
        if (n.isCenter) continue;
        const dx = cx - n.x;
        const dy = cy - n.y;
        n.vx += dx * 0.003;
        n.vy += dy * 0.003;
      }

      const maxVel = 15 * cooling + 0.5;
      for (const n of sNodes) {
        if (n.isCenter) continue;
        const vel = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (vel > maxVel) {
          n.vx = (n.vx / vel) * maxVel;
          n.vy = (n.vy / vel) * maxVel;
        }
        n.x += n.vx * cooling;
        n.y += n.vy * cooling;

        const pad = n.radius + 10;
        n.x = Math.max(pad, Math.min(w - pad, n.x));
        n.y = Math.max(pad, Math.min(h - pad, n.y));
      }
    }

    simNodes = sNodes;
    simulationDone = true;
  }

  $effect(() => {
    if (nodes.length > 0 && width > 0 && height > 0) {
      runForceSimulation(width, height);
    }
  });

  let displayNodes = $derived.by(() => {
    return simNodes.map(node => {
      const isDimmed = hoveredNodeId
        ? node.id !== hoveredNodeId && !edges.some(e =>
            (e.from === hoveredNodeId && e.to === node.id) ||
            (e.from === node.id && e.to === hoveredNodeId)
          )
        : false;
      return { ...node, isDimmed };
    });
  });

  let groupedEdges = $derived.by(() => {
    const pairMap = new Map<string, any>();

    for (const edge of edges) {
      const key = edge.from < edge.to ? `${edge.from}-${edge.to}` : `${edge.to}-${edge.from}`;
      let pair = pairMap.get(key);
      if (!pair) {
        pair = {
          from: edge.from,
          to: edge.to,
          mentionCount: 0,
          replyCount: 0,
          reactionCount: 0,
          totalCount: 0,
          strongestType: 'mention' as const,
          maxCount: 0,
        };
        pairMap.set(key, pair);
      }

      if (edge.type === 'mention') pair.mentionCount += edge.count;
      if (edge.type === 'reply') pair.replyCount += edge.count;
      if (edge.type === 'reaction') pair.reactionCount += edge.count;
      pair.totalCount += edge.count;

      if (edge.count > pair.maxCount) {
        pair.maxCount = edge.count;
        pair.strongestType = edge.type;
      }
    }

    return Array.from(pairMap.values());
  });

  let edgesWithCoords = $derived.by(() => {
    if (simNodes.length === 0) return [];
    const maxTotal = Math.max(1, ...groupedEdges.map(e => e.totalCount));

    return groupedEdges.map(edge => {
      const fromNode = simNodes.find(n => n.id === edge.from);
      const toNode = simNodes.find(n => n.id === edge.to);
      if (!fromNode || !toNode) return null;

      const dx = toNode.x - fromNode.x;
      const dy = toNode.y - fromNode.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;

      const R1 = fromNode.radius ?? 20;
      const R2 = toNode.radius ?? 20;

      const sx = fromNode.x + ux * R1;
      const sy = fromNode.y + uy * R1;
      const tx = toNode.x - ux * R2;
      const ty = toNode.y - uy * R2;

      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const perpX = -(ty - sy);
      const perpY = tx - sx;
      const perpLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1;

      const curveAmount = Math.min(dist * 0.15, 30);
      const edgeHash = (edge.from + edge.to).split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
      const curveDir = edgeHash % 2 === 0 ? 1 : -1;

      const cpx = mx + (perpX / perpLen) * curveAmount * curveDir;
      const cpy = my + (perpY / perpLen) * curveAmount * curveDir;

      const isDimmed = hoveredNodeId
        ? edge.from !== hoveredNodeId && edge.to !== hoveredNodeId
        : false;

      const centerNode = nodes.find(n => n.type === 'user');
      const isCross = centerNode && edge.from !== centerNode.id && edge.to !== centerNode.id;
      const normalizedStrength = edge.totalCount / maxTotal;

      let strokeColor = '#3b82f6';
      if (edge.strongestType === 'reply') strokeColor = '#a78bfa';
      if (edge.strongestType === 'reaction') strokeColor = '#34d399';

      return {
        ...edge,
        sx, sy, tx, ty, cpx, cpy, isDimmed, strokeColor, isCross, normalizedStrength,
      };
    }).filter(Boolean);
  });

  let selectedNode = $derived(displayNodes.find(n => n.id === selectedNodeId) || null);
  let selectedNodeStats = $derived.by(() => {
    if (!selectedNodeId) return null;
    let mentions = 0, replies = 0, reactions = 0;
    for (const e of edges) {
      if (e.from === selectedNodeId || e.to === selectedNodeId) {
        if (e.type === 'mention') mentions += e.count;
        if (e.type === 'reply') replies += e.count;
        if (e.type === 'reaction') reactions += e.count;
      }
    }
    const connections = new Set<string>();
    for (const e of edges) {
      if (e.from === selectedNodeId) connections.add(e.to);
      if (e.to === selectedNodeId) connections.add(e.from);
    }
    return { mentions, replies, reactions, total: mentions + replies + reactions, connections: connections.size };
  });

  onMount(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          width = entry.contentRect.width;
          height = entry.contentRect.height;
        }
      }
    });
    if (container) resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  });
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={container}
  class="relative h-full w-full rounded-xl overflow-hidden select-none transition-all duration-300 interaction-graph-container"
>
  {#if nodes.length === 0}
    <div class="absolute inset-0 flex flex-col items-center justify-center graph-empty">
      <Papicon icon="share-2" size={48} />
      <p class="mt-4 text-[13px] font-medium">{m.d6_it_no_interaction()}</p>
    </div>
  {:else}
    <!-- Header -->
    <div class="absolute top-4 left-5 z-10 flex flex-col pointer-events-none">
      <div class="flex items-center gap-2">
        <div class="graph-compass-icon">
          <Papicon icon="share-2" size={18} />
        </div>
        <h3 class="text-sm font-semibold graph-title tracking-wide">
          {m.d6_it_network_title()}
        </h3>
      </div>
      <span class="text-[10px] graph-subtitle mt-0.5">
        {m.d6_it_members_connections({ members: nodes.length, connections: groupedEdges.length })}
      </span>
    </div>

    <!-- Controls -->
    <div class="absolute top-4 right-5 z-20 flex items-center gap-1.5">
      <button
        onclick={resetGraph}
        class="graph-btn pointer-events-auto"
        title={m.d6_it_recenter()}
      >
        <Papicon icon="rotate-ccw" size={14} />
      </button>
      <button
        onclick={() => { zoom = Math.min(zoom * 1.25, 3); }}
        class="graph-btn pointer-events-auto"
        title="Zoom +"
      >
        <Papicon icon="zoom-in" size={14} />
      </button>
      <button
        onclick={() => { zoom = Math.max(zoom / 1.25, 0.3); }}
        class="graph-btn pointer-events-auto"
        title="Zoom -"
      >
        <Papicon icon="zoom-out" size={14} />
      </button>
    </div>

    <!-- Legend -->
    <div class="absolute bottom-4 right-5 z-10 flex items-center gap-3 pointer-events-none">
      <div class="flex items-center gap-1">
        <div class="w-2 h-2 rounded-full legend-mention"></div>
        <span class="text-[8px] font-semibold uppercase tracking-wider graph-legend-text">{m.d6_it_mentions()}</span>
      </div>
      <div class="flex items-center gap-1">
        <div class="w-2 h-2 rounded-full legend-reply"></div>
        <span class="text-[8px] font-semibold uppercase tracking-wider graph-legend-text">{m.d6_it_replies()}</span>
      </div>
      <div class="flex items-center gap-1">
        <div class="w-2 h-2 rounded-full legend-reaction"></div>
        <span class="text-[8px] font-semibold uppercase tracking-wider graph-legend-text">{m.d6_it_reactions()}</span>
      </div>
    </div>

    <!-- SVG Canvas -->
    <svg
      class="w-full h-full select-none"
      class:cursor-grab={!isPanning}
      class:cursor-grabbing={isPanning}
      onmousedown={handleMouseDown}
      onwheel={handleWheel}
    >
      <defs>
        <filter id="it-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <filter id="it-node-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.3)" flood-opacity="0.3" />
        </filter>
        <linearGradient id="it-grad-mention" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.9" />
          <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.4" />
        </linearGradient>
        <linearGradient id="it-grad-reply" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.9" />
          <stop offset="100%" stop-color="#7c3aed" stop-opacity="0.4" />
        </linearGradient>
        <linearGradient id="it-grad-reaction" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#34d399" stop-opacity="0.9" />
          <stop offset="100%" stop-color="#059669" stop-opacity="0.4" />
        </linearGradient>
      </defs>

      <g transform="translate({panX}, {panY}) scale({zoom})">
        <!-- Edges -->
        <g>
          {#each edgesWithCoords as edge}
            <!-- svelte-ignore a11y_mouse_events_have_key_events -->
            <path
              d="M {edge.sx} {edge.sy} Q {edge.cpx} {edge.cpy} {edge.tx} {edge.ty}"
              fill="none"
              stroke={edge.strokeColor}
              stroke-width={edge.isCross
                ? Math.max(1, 1 + edge.normalizedStrength * 2)
                : Math.max(1.5, 1.5 + edge.normalizedStrength * 3.5)}
              stroke-opacity={edge.isDimmed ? 0.04 : (edge.isCross ? 0.15 : 0.2 + edge.normalizedStrength * 0.3)}
              stroke-linecap="round"
              class="transition-all duration-300 pointer-events-auto cursor-pointer"
              onmouseover={() => hoveredEdge = edge}
              onmouseout={() => hoveredEdge = null}
            />
            {#if !edge.isDimmed && (hoveredEdge === edge || (hoveredNodeId && (edge.from === hoveredNodeId || edge.to === hoveredNodeId)))}
              <path
                d="M {edge.sx} {edge.sy} Q {edge.cpx} {edge.cpy} {edge.tx} {edge.ty}"
                fill="none"
                stroke={edge.strokeColor}
                stroke-width={Math.max(3, 3 + edge.normalizedStrength * 5)}
                stroke-opacity="0.6"
                stroke-linecap="round"
                filter="url(#it-glow)"
                class="pointer-events-none"
              />
            {/if}
          {/each}
        </g>

        <!-- Nodes -->
        <g>
          {#each displayNodes as node (node.id)}
            <!-- svelte-ignore a11y_mouse_events_have_key_events -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              transform="translate({node.x}, {node.y})"
              class="cursor-pointer transition-opacity duration-300 pointer-events-auto"
              opacity={node.isDimmed ? 0.15 : 1}
              onmousedown={(e) => e.stopPropagation()}
              onmouseover={() => hoveredNodeId = node.id}
              onmouseout={() => hoveredNodeId = null}
              onclick={(e) => {
                e.stopPropagation();
                const dx = Math.abs(e.clientX - downX);
                const dy = Math.abs(e.clientY - downY);
                if (dx < 6 && dy < 6) {
                  if (node.isCenter) {
                    selectedNodeId = selectedNodeId === node.id ? null : node.id;
                  } else {
                    selectedNodeId = selectedNodeId === node.id ? null : node.id;
                    onSelectNode(node.id);
                  }
                }
              }}
            >
              <!-- Hover/Select glow ring -->
              {#if hoveredNodeId === node.id || selectedNodeId === node.id}
                <circle
                  r={node.radius + 6}
                  fill="none"
                  class="node-glow-ring"
                  class:node-glow-selected={selectedNodeId === node.id}
                  stroke-width="2"
                  filter="url(#it-glow)"
                />
              {/if}

              <!-- Outer ring showing connection strength -->
              {#if !node.isCenter}
                <circle
                  r={node.radius + 2}
                  fill="none"
                  stroke={hoveredNodeId === node.id ? '#60a5fa' : '#3b82f6'}
                  stroke-width="1.5"
                  stroke-opacity={0.15 + (node.weight / (Math.max(1, ...simNodes.map(n => n.weight)))) * 0.4}
                />
              {/if}

              <!-- Main circle -->
              <circle
                r={node.radius}
                class="node-base"
                class:node-center={node.isCenter}
                stroke-width={node.isCenter ? 2.5 : 1.5}
                filter="url(#it-node-shadow)"
              />

              <!-- Avatar clip -->
              <defs>
                <clipPath id="it-clip-{node.id}">
                  <circle r={node.radius - 1.5} />
                </clipPath>
              </defs>

              {#if node.avatar}
                <image
                  href={node.avatar}
                  x={-node.radius}
                  y={-node.radius}
                  width={node.radius * 2}
                  height={node.radius * 2}
                  clip-path="url(#it-clip-{node.id})"
                  preserveAspectRatio="xMidYMid slice"
                />
              {:else}
                <circle
                  r={node.radius - 1.5}
                  class="node-fallback-bg"
                  clip-path="url(#it-clip-{node.id})"
                />
                <text
                  text-anchor="middle"
                  dy="0.35em"
                  class="node-fallback-text pointer-events-none"
                  font-size={Math.max(9, node.radius * 0.55)}
                  font-weight="bold"
                >
                  {node.label.slice(0, 2).toUpperCase()}
                </text>
              {/if}

              <!-- Name label -->
              {#if hoveredNodeId === node.id || selectedNodeId === node.id || node.isCenter}
                <g transform="translate(0, {node.radius + 14})">
                  <rect
                    x={-(Math.max(40, node.label.length * 3.5) + 8)}
                    y="-9"
                    width={(Math.max(40, node.label.length * 3.5) + 8) * 2}
                    height="18"
                    rx="9"
                    class="node-label-bg"
                  />
                  <text
                    text-anchor="middle"
                    dy="0.35em"
                    class="node-label-text pointer-events-none"
                    font-size="9"
                    font-weight="600"
                  >
                    {node.label}
                  </text>
                </g>
              {/if}
            </g>
          {/each}
        </g>
      </g>
    </svg>

    <!-- Selected node detail panel -->
    {#if selectedNode && selectedNodeStats}
      <div class="absolute bottom-4 left-4 z-20 w-72 graph-detail-panel animate-fade-in-slide">
        <div class="flex items-center gap-2.5">
          {#if selectedNode.avatar}
            <img src={selectedNode.avatar} alt="Avatar" class="w-9 h-9 rounded-full detail-avatar" />
          {:else}
            <div class="w-9 h-9 rounded-full detail-avatar-fallback flex items-center justify-center text-xs font-bold">
              {selectedNode.label.slice(0, 2).toUpperCase()}
            </div>
          {/if}
          <div class="flex flex-col min-w-0">
            <span class="text-xs font-semibold detail-name truncate">{selectedNode.label}</span>
            <span class="text-[10px] detail-role">
              {selectedNode.isCenter ? m.d6_it_main_user() : m.d6_it_connections_count({ count: selectedNodeStats.connections })}
            </span>
          </div>
          <button
            onclick={() => selectedNodeId = null}
            class="ml-auto p-1 rounded-md detail-close-btn"
          >
            <Papicon icon="x" size={14} />
          </button>
        </div>

        <div class="grid grid-cols-3 gap-1.5 mt-3 text-center">
          <div class="detail-stat-card">
            <span class="text-[9px] font-medium detail-stat-label">{m.d6_it_mentions()}</span>
            <span class="text-sm font-bold detail-stat-value">{selectedNodeStats.mentions}</span>
          </div>
          <div class="detail-stat-card">
            <span class="text-[9px] font-medium detail-stat-label">{m.d6_it_replies()}</span>
            <span class="text-sm font-bold detail-stat-value">{selectedNodeStats.replies}</span>
          </div>
          <div class="detail-stat-card">
            <span class="text-[9px] font-medium detail-stat-label">{m.d6_it_reactions()}</span>
            <span class="text-sm font-bold detail-stat-value">{selectedNodeStats.reactions}</span>
          </div>
        </div>

        <div class="flex justify-between items-center text-[10px] mt-2.5 pt-2 detail-total-row">
          <span class="font-medium detail-total-label">{m.d6_it_total_interactions()}</span>
          <span class="font-bold detail-total-value">{selectedNodeStats.total}</span>
        </div>
      </div>
    {/if}

    <!-- Edge hover tooltip -->
    {#if hoveredEdge && !selectedNode}
      {@const sourceNode = nodes.find(n => n.id === hoveredEdge.from)}
      {@const targetNode = nodes.find(n => n.id === hoveredEdge.to)}
      <div class="absolute bottom-4 left-4 right-4 z-10 graph-edge-tooltip animate-fade-in">
        <div class="flex items-center justify-between pb-1.5 mb-1.5 edge-tooltip-header">
          <span class="text-[10px] font-semibold uppercase tracking-wider edge-tooltip-title">{m.d6_it_interaction()}</span>
          <span class="text-[9px] font-semibold truncate edge-tooltip-path">
            {sourceNode?.label ?? '?'} → {targetNode?.label ?? '?'}
          </span>
        </div>
        <div class="flex gap-3 items-center">
          {#if hoveredEdge.mentionCount > 0}
            <div class="flex items-center gap-1">
              <div class="w-1.5 h-1.5 rounded-full legend-mention"></div>
              <span class="text-[8px] font-semibold uppercase tracking-wider edge-tooltip-count">@ {hoveredEdge.mentionCount}</span>
            </div>
          {/if}
          {#if hoveredEdge.replyCount > 0}
            <div class="flex items-center gap-1">
              <div class="w-1.5 h-1.5 rounded-full legend-reply"></div>
              <span class="text-[8px] font-semibold uppercase tracking-wider edge-tooltip-count">💬 {hoveredEdge.replyCount}</span>
            </div>
          {/if}
          {#if hoveredEdge.reactionCount > 0}
            <div class="flex items-center gap-1">
              <div class="w-1.5 h-1.5 rounded-full legend-reaction"></div>
              <span class="text-[8px] font-semibold uppercase tracking-wider edge-tooltip-count">😊 {hoveredEdge.reactionCount}</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* ─── Container ─── */
  .interaction-graph-container {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.06);
  }

  .graph-empty {
    color: rgba(0, 0, 0, 0.15);
  }

  /* ─── Header ─── */
  .graph-compass-icon {
    color: #3b82f6;
  }

  .graph-title {
    background: linear-gradient(90deg, #3b82f6, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .graph-subtitle {
    color: rgba(0, 0, 0, 0.4);
  }

  /* ─── Controls ─── */
  .graph-btn {
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    background: rgba(255, 255, 255, 0.7);
    color: rgba(0, 0, 0, 0.5);
    font-size: 10px;
    transition: all 0.2s;
    cursor: pointer;
  }
  .graph-btn:hover {
    background: rgba(255, 255, 255, 0.9);
    color: rgba(0, 0, 0, 0.7);
    border-color: rgba(0, 0, 0, 0.15);
  }

  /* ─── Legend dots ─── */
  .legend-mention { background: #3b82f6; box-shadow: 0 0 4px #3b82f6; }
  .legend-reply { background: #a78bfa; box-shadow: 0 0 4px #a78bfa; }
  .legend-reaction { background: #34d399; box-shadow: 0 0 4px #34d399; }

  .graph-legend-text {
    color: rgba(0, 0, 0, 0.4);
  }

  /* ─── Node Styles ─── */
  .node-base {
    fill: #ffffff;
    stroke: #e2e8f0;
    transition: all 0.3s;
  }
  .node-base.node-center {
    stroke: #3b82f6;
    filter: drop-shadow(0 0 8px rgba(59, 130, 246, 0.3));
  }

  .node-glow-ring {
    stroke: #38bdf8;
    stroke-opacity: 0.6;
  }
  .node-glow-ring.node-glow-selected {
    stroke: #a78bfa;
    stroke-opacity: 0.8;
  }

  .node-fallback-bg {
    fill: #e0e7ff;
  }
  .node-fallback-text {
    fill: #312e81;
  }

  .node-label-bg {
    fill: rgba(255, 255, 255, 0.92);
    stroke: rgba(0, 0, 0, 0.06);
    stroke-width: 1;
  }
  .node-label-text {
    fill: #1e293b;
  }

  /* ─── Detail Panel ─── */
  .graph-detail-panel {
    padding: 14px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 8px 30px -6px rgba(0, 0, 0, 0.12);
  }

  .detail-avatar {
    border: 2px solid rgba(59, 130, 246, 0.3);
  }
  .detail-avatar-fallback {
    background: #e0e7ff;
    color: #312e81;
    border: 2px solid rgba(59, 130, 246, 0.3);
  }

  .detail-name { color: #0f172a; }
  .detail-role { color: #3b82f6; }

  .detail-close-btn {
    color: rgba(0, 0, 0, 0.3);
    transition: all 0.2s;
  }
  .detail-close-btn:hover {
    background: rgba(0, 0, 0, 0.04);
    color: rgba(0, 0, 0, 0.6);
  }

  .detail-stat-card {
    padding: 6px 4px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.04);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .detail-stat-label { color: rgba(0, 0, 0, 0.45); }
  .detail-stat-value { color: #0f172a; }

  .detail-total-row {
    border-top: 1px solid rgba(0, 0, 0, 0.06);
  }
  .detail-total-label { color: rgba(0, 0, 0, 0.45); }
  .detail-total-value { color: #3b82f6; }

  /* ─── Edge Tooltip ─── */
  .graph-edge-tooltip {
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 12px 24px -6px rgba(0, 0, 0, 0.1);
  }

  .edge-tooltip-header {
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  }
  .edge-tooltip-title { color: #3b82f6; }
  .edge-tooltip-path { color: #0f172a; }
  .edge-tooltip-count { color: #334155; }

  /* ─── Animations ─── */
  .animate-fade-in {
    animation: fadeIn 0.2s ease-out forwards;
  }
  .animate-fade-in-slide {
    animation: fadeInSlide 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes fadeInSlide {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* ─── DARK MODE ─── */
  :global(.dark) .interaction-graph-container {
    background: rgba(15, 17, 24, 0.8);
    border-color: rgba(255, 255, 255, 0.05);
  }

  :global(.dark) .graph-empty {
    color: rgba(255, 255, 255, 0.15);
  }

  :global(.dark) .graph-subtitle {
    color: rgba(255, 255, 255, 0.35);
  }

  :global(.dark) .graph-btn {
    background: rgba(30, 41, 59, 0.6);
    border-color: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.5);
  }
  :global(.dark) .graph-btn:hover {
    background: rgba(51, 65, 85, 0.8);
    border-color: rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.8);
  }

  :global(.dark) .graph-legend-text {
    color: rgba(255, 255, 255, 0.35);
  }

  :global(.dark) .node-base {
    fill: #1a1f2e;
    stroke: #334155;
  }
  :global(.dark) .node-base.node-center {
    stroke: #3b82f6;
    filter: drop-shadow(0 0 10px rgba(59, 130, 246, 0.4));
  }

  :global(.dark) .node-fallback-bg {
    fill: #312e81;
  }
  :global(.dark) .node-fallback-text {
    fill: #e0e7ff;
  }

  :global(.dark) .node-label-bg {
    fill: rgba(11, 15, 25, 0.92);
    stroke: rgba(255, 255, 255, 0.08);
  }
  :global(.dark) .node-label-text {
    fill: #f1f5f9;
  }

  :global(.dark) .graph-detail-panel {
    background: rgba(15, 23, 42, 0.95);
    border-color: rgba(255, 255, 255, 0.08);
    box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.5);
  }

  :global(.dark) .detail-avatar {
    border-color: rgba(167, 139, 250, 0.3);
  }
  :global(.dark) .detail-avatar-fallback {
    background: #312e81;
    color: #e0e7ff;
    border-color: rgba(167, 139, 250, 0.3);
  }

  :global(.dark) .detail-name { color: #f1f5f9; }
  :global(.dark) .detail-role { color: #a78bfa; }

  :global(.dark) .detail-close-btn {
    color: rgba(255, 255, 255, 0.3);
  }
  :global(.dark) .detail-close-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.6);
  }

  :global(.dark) .detail-stat-card {
    background: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.05);
  }
  :global(.dark) .detail-stat-label { color: rgba(255, 255, 255, 0.4); }
  :global(.dark) .detail-stat-value { color: #f1f5f9; }

  :global(.dark) .detail-total-row {
    border-top-color: rgba(255, 255, 255, 0.06);
  }
  :global(.dark) .detail-total-label { color: rgba(255, 255, 255, 0.4); }
  :global(.dark) .detail-total-value { color: #a78bfa; }

  :global(.dark) .graph-edge-tooltip {
    background: rgba(15, 23, 42, 0.95);
    border-color: rgba(255, 255, 255, 0.08);
    box-shadow: 0 20px 40px -8px rgba(0, 0, 0, 0.5);
  }
  :global(.dark) .edge-tooltip-header {
    border-bottom-color: rgba(255, 255, 255, 0.06);
  }
  :global(.dark) .edge-tooltip-title { color: #60a5fa; }
  :global(.dark) .edge-tooltip-path { color: #f8fafc; }
  :global(.dark) .edge-tooltip-count { color: #cbd5e1; }
</style>
