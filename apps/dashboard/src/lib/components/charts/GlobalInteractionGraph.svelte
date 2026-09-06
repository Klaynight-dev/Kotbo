<script lang="ts">
  import { untrack } from 'svelte';
  import { computeForceLayout, type LayoutEdge, type LayoutNode, type LayoutPosition } from '../../graph/forceLayout';
  import Papicon from '../Papicon.svelte';
  import { MessageSquare, ThumbsUp, AtSign, Compass, RotateCcw, Search, Users, ShieldAlert } from 'lucide-svelte';

  interface GraphNode {
    id: string;
    label: string;
    avatar?: string | null;
    activityCount: number;
    status?: string;
  }

  interface GraphEdge {
    from: string;
    to: string;
    type: 'mention' | 'reply' | 'reaction';
    count: number;
  }

  interface SimNode extends GraphNode {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    isHub: boolean;
    isCenter: boolean;
    hubId: string;
  }

  const {
    nodes = [],
    edges = [],
    hiddenMembersCount = 0,
    onSelectNode = (_id: string) => {}
  }: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    hiddenMembersCount?: number;
    onSelectNode?: (id: string) => void;
  } = $props();

  let container = $state<HTMLDivElement | null>(null);
  const width = 1400;
  const height = 850;
  const cx0 = width / 2;
  const cy0 = height / 2;

  // Default zoom is intentionally > 1 so the graph overflows/bleeds past the card edges
  const DEFAULT_ZOOM = 1.35;

  // Pan & Zoom
  let panX = $state(cx0 * (1 - DEFAULT_ZOOM));
  let panY = $state(cy0 * (1 - DEFAULT_ZOOM));
  let zoom = $state(DEFAULT_ZOOM);
  let isPanning = $state(false);
  let startPanX = $state(0);
  let startPanY = $state(0);

  // Touch Support variables
  let isTouching = $state(false);
  let startTouchX = $state(0);
  let startTouchY = $state(0);

  // Selection & Search
  let selectedNodeId = $state<string | null>(null);
  let hoveredNodeId = $state<string | null>(null);
  let searchQuery = $state('');

  // Edge type filter: 'all' | 'mention' | 'reply' | 'reaction'
  let selectedTypeFilter = $state<'all' | 'mention' | 'reply' | 'reaction'>('all');

  // Simulation nodes with static computed coordinates
  let simNodes = $state<SimNode[]>([]);

  const nodeById = $derived(new Map(simNodes.map(n => [n.id, n])));

  // Adjacence pondérée, construite une seule fois : évite de rebalayer `edges`
  // pour chaque noeud (survol, layout, top interlocuteurs).
  const adjacency = $derived.by(() => {
    const map = new Map<string, Map<string, number>>();
    const link = (a: string, b: string, count: number) => {
      let neighbours = map.get(a);
      if (!neighbours) {
        neighbours = new Map<string, number>();
        map.set(a, neighbours);
      }
      neighbours.set(b, (neighbours.get(b) || 0) + count);
    };
    for (const edge of edges || []) {
      link(edge.from, edge.to, edge.count);
      link(edge.to, edge.from, edge.count);
    }
    return map;
  });

  const hoveredNeighbours = $derived(hoveredNodeId ? adjacency.get(hoveredNodeId) ?? null : null);

  // Discord presence status colors
  function getStatusColor(status: string | undefined) {
    switch (status) {
      case 'online': return '#42b72a'; // Green
      case 'idle': return '#faa61a'; // Yellow
      case 'dnd': return '#f04747'; // Red
      case 'offline':
      default: return '#747f8d'; // Grey
    }
  }

  function getStatusLabel(status: string | undefined) {
    switch (status) {
      case 'online': return 'En ligne';
      case 'idle': return 'Inactif';
      case 'dnd': return 'Ne pas déranger';
      case 'offline':
      default: return 'Hors ligne';
    }
  }

  // Search autocomplete results
  const searchResults = $derived.by(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    return nodes
      .filter(n => n.label.toLowerCase().includes(query))
      .slice(0, 5);
  });

  // Selected profile details
  const selectedNode = $derived(selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null);

  // Group edges between any two users to avoid multiple overlapping lines
  const groupedEdges = $derived.by(() => {
    const safeEdges = edges || [];
    const pairMap = new Map<string, any>();

    safeEdges.forEach(edge => {
      const u1 = edge.from;
      const u2 = edge.to;
      const key = u1 < u2 ? `${u1}-${u2}` : `${u2}-${u1}`;

      let pair = pairMap.get(key);
      if (!pair) {
        pair = {
          from: u1,
          to: u2,
          mentionCount: 0,
          replyCount: 0,
          reactionCount: 0,
          totalCount: 0,
          strongestType: 'mention',
          maxCount: 0
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
    });

    return Array.from(pairMap.values());
  });

  const EDGE_CAP = 250;

  function capStrongest(list: any[]) {
    if (list.length <= EDGE_CAP) return list;
    return [...list].sort((a, b) => b.totalCount - a.totalCount).slice(0, EDGE_CAP);
  }

  // Filter edges dynamically by connection type
  const filteredEdges = $derived.by(() => {
    if (selectedTypeFilter === 'all') return capStrongest(groupedEdges);
    return capStrongest(groupedEdges.filter(e => e.strongestType === selectedTypeFilter));
  });

  // Le layout s'appuie toujours sur toutes les relations : changer de filtre ne
  // redéclenche donc pas la simulation et les noeuds ne sautent plus.
  const layoutEdges = $derived<LayoutEdge[]>(
    groupedEdges.map(e => ({ from: e.from, to: e.to, totalCount: e.totalCount }))
  );

  // Calculate coordinates for curved Bezier paths
  const edgesWithCoords = $derived.by(() => {
    const byId = nodeById;
    const result: any[] = [];

    for (const edge of filteredEdges) {
      const fromNode = byId.get(edge.from);
      const toNode = byId.get(edge.to);
      if (!fromNode || !toNode) continue;

      const x1 = fromNode.x;
      const y1 = fromNode.y;
      const x2 = toNode.x;
      const y2 = toNode.y;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;

      // node padding limits
      const R_start = fromNode.radius;
      const R_end = toNode.radius;

      const sx = x1 + ux * R_start;
      const sy = y1 + uy * R_start;
      const tx = x2 - ux * R_end;
      const ty = y2 - uy * R_end;

      // Curved control point calculation for Bezier quadratic path
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const px = -uy;
      const py = ux;
      
      // Curved offset depending on distance
      const curveAmount = Math.min(22, dist * 0.1);
      const cx = mx + px * curveAmount;
      const cy = my + py * curveAmount;

      // Determine edge color (color-coded connections based on relationship)
      let strokeColor = '#5865f2'; // Discord Indigo for Mentions
      if (edge.strongestType === 'reply') strokeColor = '#faa61a'; // Yellow for Replies
      if (edge.strongestType === 'reaction') strokeColor = '#f368e0'; // Pink for Reactions

      result.push({
        from: edge.from,
        to: edge.to,
        totalCount: edge.totalCount,
        sx, sy, tx, ty, cx, cy, strokeColor
      });
    }

    return result;
  });

  // Top 5 Connectors (Default Sidebar state)
  const topConnectors = $derived.by(() => {
    return [...simNodes]
      .sort((a, b) => b.activityCount - a.activityCount)
      .slice(0, 5);
  });

  // Top 5 Interactors for selected member (Selected Sidebar state)
  const selectedTopInteractors = $derived.by(() => {
    if (!selectedNodeId) return [];
    const neighbours = adjacency.get(selectedNodeId);
    if (!neighbours) return [];

    return Array.from(neighbours.entries())
      .map(([otherId, count]) => {
        const node = nodeById.get(otherId);
        return {
          id: otherId,
          label: node?.label || 'Membre',
          avatar: node?.avatar,
          status: node?.status,
          count
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  });

  const layoutInputNodes = $derived(nodes.map(n => ({ id: n.id, activityCount: n.activityCount })));

  let layoutWorker: Worker | null = null;
  let workerUnavailable = false;
  let pendingRequestId = 0;
  let lastLayoutInput: { nodes: LayoutNode[]; edges: LayoutEdge[] } | null = null;

  function applyPositions(positions: LayoutPosition[]) {
    const source = new Map(nodes.map(n => [n.id, n]));
    simNodes = positions.map(pos => {
      const node = source.get(pos.id);
      return {
        id: pos.id,
        label: node?.label || 'Membre',
        avatar: node?.avatar ?? null,
        activityCount: node?.activityCount ?? 0,
        status: node?.status || 'offline',
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
        radius: pos.radius,
        isHub: pos.isHub,
        isCenter: pos.isCenter,
        hubId: pos.hubId
      };
    });
  }

  function getWorker(): Worker | null {
    if (workerUnavailable) return null;
    if (layoutWorker) return layoutWorker;

    try {
      const worker = new Worker(new URL('../../graph/graphLayout.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ requestId: number; positions: LayoutPosition[] }>) => {
        // Une réponse périmée arriverait après un changement de données
        if (event.data.requestId !== pendingRequestId) return;
        applyPositions(event.data.positions);
      };
      worker.onerror = () => {
        workerUnavailable = true;
        worker.terminate();
        layoutWorker = null;
        if (lastLayoutInput) {
          applyPositions(computeForceLayout(lastLayoutInput.nodes, lastLayoutInput.edges, { width, height }));
        }
      };
      layoutWorker = worker;
      return worker;
    } catch {
      workerUnavailable = true;
      return null;
    }
  }

  function requestLayout(simEdges: LayoutEdge[], inputNodes: LayoutNode[]) {
    if (inputNodes.length === 0) {
      simNodes = [];
      return;
    }

    const requestId = ++pendingRequestId;
    lastLayoutInput = { nodes: inputNodes, edges: simEdges };
    const worker = getWorker();

    if (!worker) {
      applyPositions(computeForceLayout(inputNodes, simEdges, { width, height }));
      return;
    }

    worker.postMessage({ requestId, nodes: inputNodes, edges: simEdges, width, height });
  }

  // Get statistics for selected members
  function getNodeStats(nodeId: string) {
    let mentionsCount = 0;
    let repliesCount = 0;
    let reactionsCount = 0;

    const safeEdges = edges || [];
    safeEdges.forEach(e => {
      if (e.from === nodeId || e.to === nodeId) {
        if (e.type === 'mention') mentionsCount += e.count;
        if (e.type === 'reply') repliesCount += e.count;
        if (e.type === 'reaction') reactionsCount += e.count;
      }
    });

    return {
      mentions: mentionsCount,
      replies: repliesCount,
      reactions: reactionsCount,
      total: mentionsCount + repliesCount + reactionsCount
    };
  }

  // Zoom & Pan listeners
  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return; // Only pan on left click
    isPanning = true;
    startPanX = e.clientX - panX;
    startPanY = e.clientY - panY;
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
    const zoomFactor = 1.1;
    if (e.deltaY < 0) {
      zoom = Math.min(zoom * zoomFactor, 2.5);
    } else {
      zoom = Math.max(zoom / zoomFactor, 0.4);
    }
  }

  // Touch Support listeners (Mobile panning)
  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      isTouching = true;
      startTouchX = e.touches[0].clientX - panX;
      startTouchY = e.touches[0].clientY - panY;
    }
  }

  function handleTouchMove(e: TouchEvent) {
    if (isTouching && e.touches.length === 1) {
      panX = e.touches[0].clientX - startTouchX;
      panY = e.touches[0].clientY - startTouchY;
    }
  }

  function handleTouchEnd() {
    isTouching = false;
  }

  // Smooth centering focus navigation
  function focusNode(nodeId: string) {
    const node = nodeById.get(nodeId);
    if (!node || !container) return;

    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 550;

    zoom = 1.35;
    panX = cw / 2 - node.x * zoom;
    panY = ch / 2 - node.y * zoom;
    selectedNodeId = nodeId;
  }

  function resetGraph() {
    zoom = DEFAULT_ZOOM;
    panX = cx0 * (1 - DEFAULT_ZOOM);
    panY = cy0 * (1 - DEFAULT_ZOOM);
    selectedNodeId = null;
  }

  // Sync props using untrack to prevent Svelte 5 reactive loop crashes
  $effect(() => {
    const simEdges = layoutEdges;
    const inputNodes = layoutInputNodes;
    untrack(() => {
      requestLayout(simEdges, inputNodes);
    });
  });

  $effect(() => () => layoutWorker?.terminate());
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

<div class="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full min-h-[620px]">
  
  <!-- LEFT COLUMN: Profile info / Connecteurs widget (col-span-4) -->
  <div class="lg:col-span-4 flex flex-col gap-4">
    {#if selectedNode}
      {@const stats = getNodeStats(selectedNode.id)}
      <div class="rounded-xl border border-white/5 bg-[#18191a]/95 shadow-2xl flex flex-col overflow-hidden animate-fade-in-slide">
        <!-- Cover photo -->
        <div class="h-24 w-full bg-gradient-to-r from-[#1877f2] via-[#3b82f6] to-[#00c6ff] relative">
          <button 
            onclick={() => selectedNodeId = null}
            class="absolute top-2 right-2 p-1.5 rounded-full bg-black/30 hover:bg-black/50 text-white/80 hover:text-white transition-colors"
          >
            <Papicon icon="x" size={14} />
          </button>
        </div>

        <!-- Profile Header Area -->
        <div class="px-5 pb-5 pt-0 relative flex flex-col">
          <!-- Floating Avatar -->
          <div class="absolute -top-10 left-5">
            {#if selectedNode.avatar}
              <img src={selectedNode.avatar} alt="Avatar" class="w-20 h-20 rounded-full border-4 border-[#18191a] shadow-lg" />
            {:else}
              <div class="w-20 h-20 rounded-full bg-indigo-900 border-4 border-[#18191a] flex items-center justify-center text-indigo-200 font-bold text-xl shadow-lg">
                {selectedNode.label.slice(0, 2).toUpperCase()}
              </div>
            {/if}
            <!-- Status dot -->
            <span 
              class="absolute bottom-1 right-1 w-4.5 h-4.5 rounded-full border-3 border-[#18191a]"
              style="background-color: {getStatusColor(selectedNode.status)}"
            ></span>
          </div>

          <!-- Name & Discord Presence -->
          <div class="mt-12 flex flex-col">
            <div class="flex items-center gap-1.5">
              <span class="text-base font-bold text-slate-100">{selectedNode.label}</span>
              {#if selectedNode.isHub}
                <span class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#1877f2] text-white" style="font-size: 8px;" title="Hub Communauté">✓</span>
              {/if}
            </div>
            <span class="text-xs text-slate-400 font-medium mt-0.5 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full inline-block" style="background-color: {getStatusColor(selectedNode.status)}"></span>
              {getStatusLabel(selectedNode.status)}
            </span>
          </div>

          <!-- Stats Cards Grid -->
          <div class="grid grid-cols-3 gap-2 mt-5 text-center">
            <div class="rounded-xl bg-[#242526] border border-white/5 py-2 px-1 flex flex-col items-center">
              <AtSign class="w-4 h-4 text-sky-400 mb-1" />
              <span class="text-[9px] text-slate-400 font-bold uppercase">Mentions</span>
              <span class="text-sm font-bold text-slate-100 mt-0.5">{stats.mentions}</span>
            </div>
            <div class="rounded-xl bg-[#242526] border border-white/5 py-2 px-1 flex flex-col items-center">
              <MessageSquare class="w-4 h-4 text-yellow-400 mb-1" />
              <span class="text-[9px] text-slate-400 font-bold uppercase">Réponses</span>
              <span class="text-sm font-bold text-slate-100 mt-0.5">{stats.replies}</span>
            </div>
            <div class="rounded-xl bg-[#242526] border border-white/5 py-2 px-1 flex flex-col items-center">
              <ThumbsUp class="w-4 h-4 text-pink-400 mb-1" />
              <span class="text-[9px] text-slate-400 font-bold uppercase">Réactions</span>
              <span class="text-sm font-bold text-slate-100 mt-0.5">{stats.reactions}</span>
            </div>
          </div>

          <div class="flex justify-between items-center text-xs border-t border-white/5 pt-3 mt-4">
            <span class="text-slate-400 font-medium">Interactions totales</span>
            <span class="font-bold text-[#1877f2] text-sm">{stats.total}</span>
          </div>

          <!-- Action Button -->
          <button
            onclick={() => {
              onSelectNode(selectedNode!.id);
              selectedNodeId = null;
            }}
            class="w-full mt-4 py-2 bg-[#1877f2] hover:bg-[#166fe5] text-white text-xs font-bold rounded-lg transition-all shadow-md flex items-center justify-center gap-1.5"
          >
            <Compass class="w-4 h-4" />
            Consulter l'activité complète
          </button>

          <!-- Top Interlocutors List (Dynamic friendship progress bars) -->
          <div class="mt-5 flex flex-col gap-2 border-t border-white/5 pt-4">
            <span class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Top 5 Interlocuteurs</span>
            
            {#if selectedTopInteractors.length === 0}
              <div class="flex items-center gap-2 p-3 rounded-lg bg-[#242526]/20 border border-dashed border-white/5 justify-center text-slate-400 text-xs">
                <ShieldAlert class="w-4 h-4 text-slate-500" />
                Aucune interaction directe enregistrée.
              </div>
            {:else}
              {#each selectedTopInteractors as interactor}
                <button 
                  onclick={() => focusNode(interactor.id)}
                  class="w-full flex flex-col p-2 rounded-lg bg-[#242526]/30 hover:bg-[#242526]/60 border border-white/0 hover:border-white/5 transition-all text-left group"
                >
                  <div class="flex items-center gap-2.5">
                    <div class="relative">
                      {#if interactor.avatar}
                        <img src={interactor.avatar} alt="" class="w-6 h-6 rounded-full" />
                      {:else}
                        <div class="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-300">
                          {interactor.label.slice(0, 2).toUpperCase()}
                        </div>
                      {/if}
                      <span class="absolute bottom-0 right-0 w-2 h-2 rounded-full border border-[#18191a]" style="background-color: {getStatusColor(interactor.status)}"></span>
                    </div>
                    <div class="flex-1 min-w-0 flex items-center justify-between">
                      <span class="text-xs font-semibold text-slate-200 truncate group-hover:text-primary transition-colors">{interactor.label}</span>
                      <span class="text-[10px] text-slate-400 font-medium">{interactor.count} int.</span>
                    </div>
                  </div>
                  <!-- Progress bar showing relative share of interactions -->
                  <div class="w-full bg-slate-900/50 rounded-full h-1 mt-2 overflow-hidden">
                    <div 
                      class="bg-gradient-to-r from-[#1877f2] to-[#00c6ff] h-full rounded-full transition-all duration-300" 
                      style="width: {Math.min(100, (interactor.count / stats.total) * 100)}%"
                    ></div>
                  </div>
                </button>
              {/each}
            {/if}
          </div>

        </div>
      </div>
    {:else}
      <!-- Default summary stats & Top Server Connectors card -->
      <div class="rounded-xl border border-white/5 bg-[#18191a]/95 shadow-2xl p-5 flex flex-col gap-4 animate-fade-in-slide">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-[#1877f2]/10 flex items-center justify-center text-[#1877f2]">
            <Users class="w-5 h-5" />
          </div>
          <div>
            <h4 class="text-sm font-bold text-slate-100">Réseau d'activité</h4>
            <p class="text-[10px] text-slate-400">Relations et liens sociaux du serveur</p>
          </div>
        </div>

        <div class="space-y-2 border-t border-white/5 pt-3">
          <div class="flex justify-between text-xs">
            <span class="text-slate-400">Total membres analysés</span>
            <span class="font-bold text-slate-200">{nodes.length}</span>
          </div>
          <div class="flex justify-between text-xs">
            <span class="text-slate-400">Liaisons de communication</span>
            <span class="font-bold text-slate-200">{edges.length}</span>
          </div>
          {#if hiddenMembersCount > 0}
            <div class="flex justify-between text-xs">
              <span class="text-slate-400">Membres moins actifs non affichés</span>
              <span class="font-bold text-slate-400">{hiddenMembersCount}</span>
            </div>
          {/if}
        </div>

        <!-- Top Connectors Ranked List -->
        <div class="flex flex-col gap-2 mt-2 border-t border-white/5 pt-4">
          <span class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Top 5 Connecteurs du Serveur</span>
          {#each topConnectors as connector, index}
            <button 
              onclick={() => focusNode(connector.id)}
              class="w-full flex items-center gap-3 p-2 rounded-lg bg-[#242526]/30 hover:bg-[#242526]/70 border border-transparent hover:border-white/5 transition-all text-left group"
            >
              <div class="flex items-center justify-center relative">
                <span class="w-5 text-xs font-bold text-slate-500 text-center">
                  {#if index === 0}👑{:else}#{index + 1}{/if}
                </span>
                {#if connector.avatar}
                  <img src={connector.avatar} alt="" class="w-8 h-8 rounded-full ml-1" />
                {:else}
                  <div class="w-8 h-8 rounded-full bg-slate-800 ml-1 flex items-center justify-center text-xs font-bold text-slate-300">
                    {connector.label.slice(0, 2).toUpperCase()}
                  </div>
                {/if}
                <span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-[#18191a]" style="background-color: {getStatusColor(connector.status)}"></span>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-slate-200 truncate group-hover:text-primary transition-colors">{connector.label}</div>
                <div class="text-[10px] text-slate-400">{connector.activityCount} actions enregistrées</div>
              </div>
            </button>
          {/each}
        </div>

        <p class="text-[11px] text-slate-400 leading-relaxed mt-2 bg-slate-900/50 p-3 rounded-lg border border-white/5">
          👉 Cliquez sur n'importe quel membre du réseau ou sur un top connecteur pour explorer son cercle social et ses interlocuteurs favoris.
        </p>
      </div>
    {/if}
  </div>

  <!-- RIGHT COLUMN: Organic static hairball SVG (col-span-8) -->
  <div class="lg:col-span-8 relative rounded-xl border border-white/5 bg-[#18191a]/60 overflow-hidden flex flex-col shadow-inner">
    
    <!-- Top Bar Toolbar controls (Glassmorphism design) -->
    <div class="absolute top-4 left-4 right-4 z-10 flex flex-col md:flex-row md:items-center justify-between gap-4 pointer-events-none">
      
      <!-- Filter Tabs by interaction type -->
      <div class="flex items-center gap-1.5 p-1 rounded-lg bg-[#18191a]/90 border border-white/5 pointer-events-auto shadow-md">
        <button 
          onclick={() => selectedTypeFilter = 'all'}
          class="px-2.5 py-1 rounded text-[10px] font-bold transition-all {selectedTypeFilter === 'all' ? 'bg-[#1877f2] text-white' : 'text-slate-400 hover:text-slate-200'}"
        >
          Tout
        </button>
        <button 
          onclick={() => selectedTypeFilter = 'mention'}
          class="px-2.5 py-1 rounded text-[10px] font-bold transition-all flex items-center gap-1 {selectedTypeFilter === 'mention' ? 'bg-[#5865f2] text-white' : 'text-slate-400 hover:text-slate-200'}"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-[#5865f2]"></span> Mentions
        </button>
        <button 
          onclick={() => selectedTypeFilter = 'reply'}
          class="px-2.5 py-1 rounded text-[10px] font-bold transition-all flex items-center gap-1 {selectedTypeFilter === 'reply' ? 'bg-[#faa61a] text-white' : 'text-slate-400 hover:text-slate-200'}"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-[#faa61a]"></span> Réponses
        </button>
        <button 
          onclick={() => selectedTypeFilter = 'reaction'}
          class="px-2.5 py-1 rounded text-[10px] font-bold transition-all flex items-center gap-1 {selectedTypeFilter === 'reaction' ? 'bg-[#f368e0] text-white' : 'text-slate-400 hover:text-slate-200'}"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-[#f368e0]"></span> Réactions
        </button>
      </div>

      <!-- Search Input Container -->
      <div class="relative w-60 pointer-events-auto shadow-md">
        <div class="relative flex items-center">
          <Search class="absolute left-3 w-4 h-4 text-slate-400" />
          <input
            type="text"
            bind:value={searchQuery}
            placeholder="Rechercher un membre..."
            class="w-full pl-9 pr-4 py-1.5 bg-[#18191a]/95 border border-white/5 rounded-lg text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-[#1877f2]/50 transition-all"
          />
        </div>

        <!-- Autocomplete search results -->
        {#if searchResults.length > 0}
          <div class="absolute top-full left-0 right-0 mt-1.5 rounded-lg border border-white/5 bg-[#1e202a] shadow-2xl overflow-hidden flex flex-col z-30">
            {#each searchResults as result}
              <button
                onclick={() => {
                  focusNode(result.id);
                  searchQuery = '';
                }}
                class="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-[#1877f2]/10 text-xs text-slate-200 transition-colors"
              >
                {#if result.avatar}
                  <img src={result.avatar} alt="" class="w-5 h-5 rounded-full" />
                {:else}
                  <div class="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold">
                    {result.label.slice(0, 2).toUpperCase()}
                  </div>
                {/if}
                <span class="font-semibold">{result.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- Zoom and Center Controls (Facebook styled overlay) -->
    <div class="absolute bottom-4 right-4 z-10 flex flex-col gap-1.5 pointer-events-auto shadow-lg">
      <button
        onclick={() => zoom = Math.min(zoom * 1.25, 2.5)}
        class="w-9 h-9 rounded-t-lg border border-white/5 bg-[#18191a]/85 hover:bg-[#242526] text-slate-200 text-base font-bold flex items-center justify-center transition-colors"
        title="Zoomer"
      >
        +
      </button>
      <button
        onclick={() => zoom = Math.max(zoom / 1.25, 0.4)}
        class="w-9 h-9 border-t border-b border-white/5 bg-[#18191a]/85 hover:bg-[#242526] text-slate-200 text-base font-bold flex items-center justify-center transition-colors"
        title="Dézoomer"
      >
        −
      </button>
      <button
        onclick={resetGraph}
        class="w-9 h-9 rounded-b-lg border border-white/5 bg-[#18191a]/85 hover:bg-[#242526] text-slate-300 flex items-center justify-center transition-colors"
        title="Recentrer le graphe"
      >
        <RotateCcw class="w-3.5 h-3.5 text-[#1877f2]" />
      </button>
    </div>

    <!-- SVG Interactive Canvas Graph Area -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div 
      bind:this={container}
      class="w-full h-full cursor-grab active:cursor-grabbing select-none"
      onmousedown={handleMouseDown}
      onwheel={handleWheel}
      ontouchstart={handleTouchStart}
      ontouchmove={handleTouchMove}
      ontouchend={handleTouchEnd}
    >
      <svg viewBox="0 0 1400 850" class="w-full h-full">
        <defs>
          <!-- Glowing mesh gradient backgrounds for fallback nodes -->
          <radialGradient id="node-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#5865f2" />
            <stop offset="100%" stop-color="#3d49c2" />
          </radialGradient>
          <radialGradient id="hub-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#00c6ff" />
            <stop offset="100%" stop-color="#0072ff" />
          </radialGradient>

          <!-- Découpe circulaire partagée par tous les avatars -->
          <clipPath id="clip-avatar" clipPathUnits="objectBoundingBox">
            <circle cx="0.5" cy="0.5" r="0.5" />
          </clipPath>

          <!-- Glow filters for link overlays -->
          <filter id="glow-link" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="3.0" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        <g transform="translate({panX}, {panY}) scale({zoom})">
          <!-- 1. Connections layer (Color-coded relationship paths with glow) -->
          <g>
            {#each edgesWithCoords as edge}
              {@const isHovered = hoveredNodeId === edge.from || hoveredNodeId === edge.to}
              {@const isDimmed = hoveredNodeId ? !isHovered : false}
              <path
                d="M {edge.sx} {edge.sy} Q {edge.cx} {edge.cy} {edge.tx} {edge.ty}"
                fill="none"
                stroke={edge.strokeColor}
                stroke-width={isHovered ? 4.0 : Math.min(1.5 + edge.totalCount * 0.4, 6)}
                stroke-opacity={isDimmed ? 0.05 : isHovered ? 0.95 : 0.65}
                filter={isHovered ? 'url(#glow-link)' : ''}
                class="transition-[stroke-width,stroke-opacity] duration-200 pointer-events-none"
              />
            {/each}
          </g>

          <!-- 2. Nodes layer (Circular Avatars with Discord presence status rings and name pills) -->
          <g>
            {#each simNodes as node (node.id)}
              {@const isSelected = selectedNodeId === node.id}
              {@const isHovered = hoveredNodeId === node.id}
              {@const isNeighbour = hoveredNeighbours?.has(node.id) ?? false}
              {@const isDimmed = hoveredNodeId ? !isHovered && !isNeighbour : false}
              {@const fontSize = Math.max(8.5, node.radius * 0.42)}
              {@const textWidth = Math.max(32, node.label.length * fontSize * 0.58)}
              {@const showLabel = node.isHub || isSelected || isHovered || isNeighbour}
              
              <!-- svelte-ignore a11y_mouse_events_have_key_events -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <g
                transform="translate({node.x}, {node.y})"
                class="cursor-pointer transition-opacity duration-200 pointer-events-auto"
                opacity={isDimmed ? 0.12 : 1}
                onmouseover={() => hoveredNodeId = node.id}
                onmouseout={() => hoveredNodeId = null}
                onclick={(e) => {
                  e.stopPropagation();
                  if (selectedNodeId === node.id) {
                    selectedNodeId = null;
                  } else {
                    focusNode(node.id);
                  }
                }}
              >
                <!-- Glowing highlight outer halo -->
                {#if isSelected || isHovered}
                  <circle
                    r={node.radius + 5}
                    fill="none"
                    stroke="#1877f2"
                    stroke-width="2.5"
                    stroke-opacity="0.85"
                    class="animate-pulse"
                  />
                {/if}

                <!-- Avatar border circle colored by Discord presence status -->
                <circle
                  r={node.radius}
                  fill="#18191a"
                  stroke={getStatusColor(node.status)}
                  stroke-width={node.isHub ? 3.0 : 2.0}
                  class="transition-colors duration-200"
                />

                <!-- Profile Picture (pp) of the person -->
                {#if node.avatar}
                  <image
                    href={node.avatar}
                    x={-(node.radius - 1.5)}
                    y={-(node.radius - 1.5)}
                    width={(node.radius - 1.5) * 2}
                    height={(node.radius - 1.5) * 2}
                    clip-path="url(#clip-avatar)"
                    preserveAspectRatio="xMidYMid slice"
                  />
                {:else}
                  <!--Fallback elegant letter avatar -->
                  <circle
                    r={node.radius - 1.5}
                    fill={node.isHub ? 'url(#hub-grad)' : 'url(#node-grad)'}
                  />
                  <text
                    text-anchor="middle"
                    dy="0.3em"
                    fill="#f1f5f9"
                    font-size={node.radius * 0.55}
                    font-weight="bold"
                    font-family="'Inter', sans-serif"
                    class="pointer-events-none"
                  >
                    {node.label.slice(0, 2).toUpperCase()}
                  </text>
                {/if}

                <!-- Active status dot (Facebook style) -->
                <circle
                  cx={node.radius * 0.7}
                  cy={node.radius * 0.7}
                  r={Math.max(4.0, node.radius * 0.2)}
                  fill={getStatusColor(node.status)}
                  stroke="#18191a"
                  stroke-width="1.8"
                />

                <!-- Name Label clearly printed below avatar inside a clean background pill -->
                {#if showLabel}
                  <g transform="translate(0, {node.radius + fontSize + 4})">
                    <rect
                      x={-textWidth / 2 - 4}
                      y={-fontSize / 2 - 3}
                      width={textWidth + 8}
                      height={fontSize + 6}
                      rx="4"
                      fill="#18191a"
                      fill-opacity="0.9"
                      stroke={isSelected ? '#1877f2' : 'rgba(255, 255, 255, 0.05)'}
                      stroke-width="0.8"
                    />
                    <text
                      text-anchor="middle"
                      dy="0.35em"
                      fill={isSelected ? '#1877f2' : isHovered ? '#f1f5f9' : '#cbd5e1'}
                      font-size={fontSize}
                      font-weight={node.isHub || isSelected ? '700' : '500'}
                      font-family="'Inter', sans-serif"
                      class="pointer-events-none tracking-wide transition-colors"
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
    </div>

  </div>
</div>

<style>
  /* Custom micro-animations */
  @keyframes fadeInSlide {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .animate-fade-in-slide {
    animation: fadeInSlide 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
</style>
