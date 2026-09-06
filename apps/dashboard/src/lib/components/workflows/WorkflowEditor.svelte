<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteFlow, Background, BackgroundVariant, Controls, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import Papicon from '../Papicon.svelte';
  import WorkflowNodeCard from './WorkflowNodeCard.svelte';
  import ConnectPicker from './ConnectPicker.svelte';
  import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from './workflowTemplates';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { themeStore } from '../../stores/theme.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import {
    NODE_CATALOG,
    canConnect,
    getNodeDef,
    layoutGraph,
    placeNewNode,
    resolveNodeInputs,
    resolveNodeOutputs,
    validateGraph,
    hasBlockingIssue,
    type NodeCategory,
    type PortDataType,
    type ValidationIssue,
    type WorkflowGraph,
  } from '@kotbo/shared';

  /**
   * Éditeur de graphe intelligent avec palette dynamique et drag & drop.
   */
  const {
    graph = { nodes: [], edges: [] },
    replaySteps = null,
    replayIndex = -1,
    readonly = false,
    onSelectNode,
    onChange,
  }: {
    graph?: WorkflowGraph;
    replaySteps?: { nodeId: string; status: string }[] | null;
    replayIndex?: number;
    /** Rejeu d'une exécution passée : le graphe se regarde, il ne s'édite pas. */
    readonly?: boolean;
    onSelectNode?: (nodeId: string | null) => void;
    onChange?: (graph: WorkflowGraph, issues: ValidationIssue[]) => void;
  } = $props();

  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  let selectedId = $state<string | null>(null);
  let selectedEdgeId = $state<string | null>(null);
  let issues = $state<ValidationIssue[]>([]);

  // Recherche & Filtres dans la palette
  let searchQuery = $state('');
  let selectedCategoryFilter = $state<NodeCategory | 'all'>('all');
  let showTemplateModal = $state(false);

  const selectedEdge = $derived(edges.find((e) => e.id === selectedEdgeId));
  const selectedEdgeSourceNode = $derived(
    selectedEdge ? nodes.find((n) => n.id === selectedEdge.source) : undefined,
  );
  const selectedEdgeTargetNode = $derived(
    selectedEdge ? nodes.find((n) => n.id === selectedEdge.target) : undefined,
  );

  function deleteSelectedEdge(): void {
    if (!selectedEdgeId) return;
    edges = edges.filter((e) => e.id !== selectedEdgeId);
    selectedEdgeId = null;
    revalidate();
  }

  const nodeTypes = { kotbo: WorkflowNodeCard };

  const CATEGORY_LABELS: Record<NodeCategory, () => string> = {
    trigger: () => m.wf_palette_trigger(),
    flow: () => m.wf_palette_flow(),
    action: () => m.wf_palette_action(),
    data: () => m.wf_palette_data(),
    logic: () => m.wf_palette_logic(),
  };

  const CATEGORY_ICONS: Record<NodeCategory, string> = {
    trigger: 'Sparkles',
    flow: 'GitBranch',
    action: 'Send',
    data: 'Grid',
    logic: 'Code',
  };

  const CATEGORIES: NodeCategory[] = ['trigger', 'flow', 'action', 'data', 'logic'];

  const filteredCatalog = $derived(
    NODE_CATALOG.filter((def) => {
      const matchesCategory = selectedCategoryFilter === 'all' || def.category === selectedCategoryFilter;
      const matchesSearch =
        !searchQuery.trim() ||
        def.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        def.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        def.type.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    })
  );

  /** Le graphe métier, reconstruit depuis l'état du canvas. */
  function toGraph(): WorkflowGraph {
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: (n.data as { nodeType: string }).nodeType,
        position: n.position,
        config: (n.data as { config?: Record<string, unknown> }).config ?? {},
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? '',
        target: e.target,
        targetHandle: e.targetHandle ?? '',
      })),
    };
  }

  function updateConfigForNode(nodeId: string, key: string, value: unknown): void {
    nodes = nodes.map((n) => (n.id === nodeId
      ? { ...n, data: { ...(n.data as Record<string, unknown>), config: { ...((n.data as { config?: Record<string, unknown> }).config ?? {}), [key]: value } } }
      : n));
    revalidate();
  }

  /** Injecte dans chaque nœud le contexte dont son rendu a besoin. */
  function decorate(current: WorkflowGraph, currentIssues: ValidationIssue[]): void {
    const errored = new Set(currentIssues.filter((i) => i.severity === 'error').map((i) => i.nodeId));
    const replayByNode = new Map<string, { order: number; status: string }>();

    if (replaySteps) {
      replaySteps.slice(0, replayIndex + 1).forEach((step, order) => {
        replayByNode.set(step.nodeId, { order, status: step.status });
      });
    }

    untrack(() => {
      nodes = nodes.map((n) => {
        const replay = replayByNode.get(n.id);
        return {
          ...n,
          data: {
            ...(n.data as Record<string, unknown>),
            graph: current,
            hasError: errored.has(n.id),
            replayOrder: replay?.order ?? null,
            replayStatus: replay?.status ?? null,
            availableRoles,
            availableChannels,
            onUpdateConfig: (key: string, value: unknown) => updateConfigForNode(n.id, key, value),
          },
        };
      });
    });
  }

  let lastLoadedGraph: WorkflowGraph | null = null;

  // ── Historique ────────────────────────────────────────────────────────────

  /**
   * Pile des états successifs, le dernier étant l'état courant.
   *
   * Toutes les modifications passent par `revalidate`, y compris celles que
   * déclenche le canevas lui-même : c'est donc le seul endroit où empiler, et
   * l'instantané est pris après coup. Les positions sont recopiées parce que
   * SvelteFlow les modifie sur place pendant un déplacement, ce qui réécrirait
   * les instantanés déjà pris.
   */
  type Snapshot = { nodes: Node[]; edges: Edge[] };
  const MAX_HISTORY = 50;
  // Réactif : c'est sa profondeur qui active le bouton « Annuler ».
  let history = $state.raw<Snapshot[]>([]);
  let restoring = false;

  function snapshot(): Snapshot {
    return {
      nodes: nodes.map((n) => ({ ...n, position: { ...n.position } })),
      edges: edges.map((e) => ({ ...e })),
    };
  }

  function resetHistory(): void {
    history = [snapshot()];
  }

  function undo(): void {
    if (readonly || history.length < 2) return;

    history = history.slice(0, -1);
    const target = history[history.length - 1];

    restoring = true;
    nodes = target.nodes.map((n) => ({ ...n, position: { ...n.position } }));
    edges = target.edges.map((e) => ({ ...e }));
    selectedId = null;
    selectedEdgeId = null;
    revalidate();
    restoring = false;
  }

  function handleKeydown(event: KeyboardEvent): void {
    // En rejeu il n'y a rien à annuler : laisser passer le raccourci plutôt
    // que de l'avaler pour ne rien en faire.
    if (readonly) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;

    // Un Ctrl+Z dans un champ appartient au champ, pas au graphe.
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

    event.preventDefault();
    undo();
  }

  /**
   * Au-delà de ce nombre de nœuds, les fils d'exécution cessent de s'animer.
   *
   * L'animation est un `stroke-dasharray` qui tourne en continu, sans lien avec
   * une quelconque interaction : chaque fil animé repeint sa zone à chaque
   * image, et la facture croît avec le graphe. Le pointillé mobile aide à lire
   * un petit enchaînement ; passé une vingtaine de blocs il coûte plus qu'il
   * n'apporte.
   */
  const ANIMATED_EDGE_NODE_LIMIT = 20;

  /**
   * Réapplique le drapeau d'animation à tous les fils.
   *
   * Recalculé à chaque modification plutôt que figé à la création : un graphe
   * qui franchit le seuil en grandissant garderait sinon les animations posées
   * quand il était petit. Les fils inchangés gardent leur référence, pour ne
   * pas forcer un rendu inutile.
   */
  function withEdgeAnimation(current: WorkflowGraph, list: Edge[]): Edge[] {
    const animate = current.nodes.length <= ANIMATED_EDGE_NODE_LIMIT;
    return list.map((edge) => {
      const wanted = animate && isExecEdge(current, edge.source, edge.sourceHandle ?? '');
      return edge.animated === wanted ? edge : { ...edge, animated: wanted };
    });
  }

  function revalidate(): void {
    const current = toGraph();
    edges = withEdgeAnimation(current, edges);
    issues = validateGraph(current);
    decorate(current, issues);
    lastLoadedGraph = current;
    if (!restoring) {
      history = [...history, snapshot()].slice(-MAX_HISTORY);
    }
    onChange?.(current, issues);
  }

  $effect(() => {
    void availableRoles;
    void availableChannels;
    untrack(() => {
      decorate(toGraph(), issues);
    });
  });

  $effect(() => {
    const source = graph;
    if (source === lastLoadedGraph) return;
    lastLoadedGraph = source;

    untrack(() => {
      nodes = source.nodes.map((n: any) => ({
        id: n.id,
        type: 'kotbo',
        position: n.position,
        data: { nodeType: n.type, config: n.config ?? {}, graph: source },
      }));
      edges = withEdgeAnimation(source, source.edges.map((e: any) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
      })));
      issues = validateGraph(source);
      decorate(source, issues);
      resetHistory();
    });
  });

  $effect(() => {
    void replayIndex;
    void replaySteps;
    untrack(() => {
      decorate(toGraph(), issues);
    });
  });

  function isExecEdge(current: WorkflowGraph, sourceId: string, handle: string): boolean {
    const source = current.nodes.find((n: any) => n.id === sourceId);
    if (!source) return false;
    const port = resolveNodeOutputs(source, current).find((p: { id: string }) => p.id === handle);
    return port?.type === 'Exec';
  }

  let nextId = 0;
  function addNodeAt(type: string, position?: { x: number; y: number }): string | null {
    const def = getNodeDef(type);
    if (!def) return null;

    if (def.category === 'trigger') {
      // Un graphe n'a qu'un déclencheur : poser le nouveau retire l'ancien.
      // Le dire avant, et emporter ses fils, sans quoi il resterait des
      // liaisons vers un nœud disparu que la validation signalerait ensuite.
      const previous = nodes.filter((n) => getNodeDef((n.data as { nodeType: string }).nodeType)?.category === 'trigger');
      if (previous.length > 0) {
        if (!confirm(m.wf_replace_trigger_confirm())) return null;
        const removed = new Set(previous.map((n) => n.id));
        nodes = nodes.filter((n) => !removed.has(n.id));
        edges = edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
      }
    }

    const config: Record<string, unknown> = {};
    for (const field of def.config ?? []) {
      if (field.defaultValue !== undefined) config[field.key] = field.defaultValue;
    }

    // Le hasard faisait atterrir la carte sur une autre, ou hors de la zone
    // visible quand le canevas avait été déplacé.
    const pos = position ?? placeNewNode(toGraph());

    const id = `${type}-${Date.now()}-${nextId++}`;
    nodes = [...nodes, {
      id,
      type: 'kotbo',
      position: pos,
      data: { nodeType: type, config, graph: toGraph() },
    }];
    revalidate();
    return id;
  }

  function addNode(type: string): void {
    addNodeAt(type);
  }

  function handleDragStart(e: DragEvent, type: string) {
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/kotbo-node-type', type);
      e.dataTransfer.effectAllowed = 'copy';
    }
  }

  function handleCanvasDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function handleCanvasDrop(e: DragEvent) {
    e.preventDefault();
    const type = e.dataTransfer?.getData('application/kotbo-node-type');
    if (!type) return;

    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left - 80;
    const y = e.clientY - rect.top - 40;

    addNodeAt(type, { x: Math.max(20, x), y: Math.max(20, y) });
  }

  function applyTemplate(template: WorkflowTemplate) {
    // Le modèle remplace le graphe entier : la question ne se pose que s'il y
    // a quelque chose à perdre.
    if (nodes.length > 0 && !confirm(m.wf_apply_template_confirm())) return;

    const source = template.graph;
    nodes = source.nodes.map((n: any) => ({
      id: n.id,
      type: 'kotbo',
      position: n.position,
      data: { nodeType: n.type, config: n.config ?? {}, graph: source },
    }));
    // `revalidate` pose le drapeau d'animation juste après.
    edges = source.edges.map((e: any) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    }));
    showTemplateModal = false;
    revalidate();
    toast.success(m.wf_template_applied({ name: template.name }));
  }

  function deleteSelected(): void {
    if (!selectedId) return;
    nodes = nodes.filter((n) => n.id !== selectedId);
    edges = edges.filter((e) => e.source !== selectedId && e.target !== selectedId);
    selectedId = null;
    revalidate();
  }

  function isValidConnection(connection: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): boolean {
    const current = toGraph();
    const source = current.nodes.find((n: any) => n.id === connection.source);
    const target = current.nodes.find((n: any) => n.id === connection.target);
    if (!source || !target) return false;

    // `resolveNodeInputs` et pas `def.inputs` : les emplacements d'un « Texte
    // composé » naissent de sa configuration et sont absents de la définition
    // statique. Les lire là refusait toute connexion vers un slot.
    const from = resolveNodeOutputs(source, current).find((p: { id: string }) => p.id === connection.sourceHandle);
    const to = resolveNodeInputs(target).find((p: { id: string }) => p.id === connection.targetHandle);
    if (!from || !to) return false;

    return canConnect(from.type, to.type);
  }

  const selectedNode = $derived(nodes.find((n) => n.id === selectedId));
  const selectedDef = $derived(
    selectedNode ? getNodeDef((selectedNode.data as { nodeType: string }).nodeType) : undefined,
  );

  function updateConfig(key: string, value: unknown): void {
    nodes = nodes.map((n) => (n.id === selectedId
      ? { ...n, data: { ...(n.data as Record<string, unknown>), config: { ...((n.data as { config?: Record<string, unknown> }).config ?? {}), [key]: value } } }
      : n));
    revalidate();
  }

  function currentConfig(key: string): unknown {
    return (selectedNode?.data as { config?: Record<string, unknown> })?.config?.[key];
  }

  function updateCase(index: number, value: string): void {
    const cases = [...((currentConfig('cases') as string[]) ?? [])];
    cases[index] = value;
    updateConfig('cases', cases);
  }

  function addCase(): void {
    updateConfig('cases', [...((currentConfig('cases') as string[]) ?? []), 'nouveau']);
  }

  function removeCase(index: number): void {
    const cases = [...((currentConfig('cases') as string[]) ?? [])];
    cases.splice(index, 1);
    updateConfig('cases', cases);
  }

  // ── Rangement et connexion guidée ─────────────────────────────────────────

  /** Réécrit les positions sans toucher aux nœuds ni aux fils. */
  function rearrange(): void {
    const arranged = layoutGraph(toGraph());
    const byId = new Map(arranged.nodes.map((node) => [node.id, node.position]));
    nodes = nodes.map((node) => ({ ...node, position: byId.get(node.id) ?? node.position }));
    revalidate();
  }

  /** Port d'où part le fil en cours de tirage, tant qu'il n'a rien atteint. */
  let dragFrom = $state<{ nodeId: string; handleId: string; handleType: 'source' | 'target' } | null>(null);
  let picker = $state<{ nodeId: string; handleId: string; handleType: 'source' | 'target'; portType: PortDataType } | null>(null);
  let connectionLanded = false;
  /**
   * Nombre de fils au départ du tirage.
   *
   * `onconnect` est censé précéder `onconnectend`, mais rien ici ne permet de
   * le vérifier - le paquet n'est pas installé. Comparer le nombre de fils
   * tranche sans dépendre de cet ordre : une liaison réussie en ajoute un.
   */
  let edgesAtDragStart = 0;

  /**
   * Les rappels de connexion n'ont pas la même signature d'une version de la
   * librairie à l'autre : certains passent les paramètres seuls, d'autres
   * l'événement puis les paramètres. On retient donc le premier argument qui
   * porte un `nodeId` plutôt que de parier sur une forme précise. Si aucun n'en
   * porte, la fonctionnalité reste simplement inerte.
   */
  function readConnectionStart(args: unknown[]): typeof dragFrom {
    for (const arg of args) {
      const candidate = arg as { nodeId?: unknown; handleId?: unknown; handleType?: unknown } | null;
      if (!candidate || typeof candidate !== 'object' || typeof candidate.nodeId !== 'string') continue;
      return {
        nodeId: candidate.nodeId,
        handleId: typeof candidate.handleId === 'string' ? candidate.handleId : '',
        handleType: candidate.handleType === 'target' ? 'target' : 'source',
      };
    }
    return null;
  }

  function handleConnectStart(...args: unknown[]): void {
    connectionLanded = false;
    edgesAtDragStart = edges.length;
    dragFrom = readConnectionStart(args);
  }

  function handleConnect(): void {
    connectionLanded = true;
    revalidate();
  }

  /** Un fil relâché dans le vide propose de créer le bloc qui l'accueillerait. */
  function handleConnectEnd(): void {
    const from = dragFrom;
    dragFrom = null;
    if (connectionLanded || edges.length > edgesAtDragStart || !from || readonly) return;

    const current = toGraph();
    const node = current.nodes.find((candidate) => candidate.id === from.nodeId);
    if (!node) return;

    const ports = from.handleType === 'source'
      ? resolveNodeOutputs(node, current)
      : resolveNodeInputs(node);
    const port = ports.find((candidate) => candidate.id === from.handleId);
    if (!port) return;

    picker = { ...from, portType: port.type };
  }

  function createFromPicker(nodeType: string, portId: string): void {
    const target = picker;
    picker = null;
    if (!target) return;

    const created = addNodeAt(nodeType, placeNewNode(toGraph(), target.nodeId));
    if (!created) return;

    const link = target.handleType === 'source'
      ? { source: target.nodeId, sourceHandle: target.handleId, target: created, targetHandle: portId }
      : { source: created, sourceHandle: portId, target: target.nodeId, targetHandle: target.handleId };

    edges = [...edges, {
      id: `${link.source}:${link.sourceHandle}->${link.target}:${link.targetHandle}`,
      ...link,
    }];
    revalidate();
  }

  export function isValid(): boolean {
    return !hasBlockingIssue(issues);
  }

  const canUndo = $derived(!readonly && history.length > 1);
  /** Le pointillé qui s'arrête sans un mot passerait pour une panne. */
  const edgeAnimationOff = $derived(nodes.length > ANIMATED_EDGE_NODE_LIMIT);
</script>

<svelte:window onkeydown={handleKeydown} />

{#if picker}
  <ConnectPicker
    portType={picker.portType}
    direction={picker.handleType}
    onPick={createFromPicker}
    onClose={() => (picker = null)}
  />
{/if}

<div class="space-y-3">
  <!-- Barre d'outils supérieure de l'éditeur -->
  {#if !readonly}
  <div class="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10">
    <div class="flex flex-wrap items-center gap-2">
      <button
        onclick={() => (showTemplateModal = true)}
        class="px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-all flex items-center gap-2 shadow-sm"
      >
        <Papicon icon="Sparkles" size={14} />
        <span>{m.wf_templates_button()}</span>
      </button>

      <button
        onclick={undo}
        disabled={!canUndo}
        title={m.wf_undo_title()}
        class="px-3 py-2 rounded-xl text-xs font-semibold bg-surface-container-highest text-on-surface hover:bg-surface-container-highest/70 disabled:opacity-30 transition-all flex items-center gap-1.5"
      >
        <Papicon icon="ArrowLeft" size={14} />
        <span>{m.wf_undo()}</span>
      </button>

      <button
        onclick={rearrange}
        disabled={nodes.length === 0}
        title={m.wf_rearrange_title()}
        class="px-3 py-2 rounded-xl text-xs font-semibold bg-surface-container-highest text-on-surface hover:bg-surface-container-highest/70 disabled:opacity-30 transition-all flex items-center gap-1.5"
      >
        <Papicon icon="Grid" size={14} />
        <span>{m.wf_rearrange()}</span>
      </button>

      {#if edgeAnimationOff}
        <span
          class="px-2.5 py-1.5 rounded-xl text-[11px] text-on-surface-variant/70 bg-surface-container-highest/60 border border-outline-variant/15 flex items-center gap-1.5"
          title={m.wf_edges_static_hint({ n: ANIMATED_EDGE_NODE_LIMIT })}
        >
          <Papicon icon="Info" size={12} />
          <span>{m.wf_edges_static()}</span>
        </span>
      {/if}

      <!-- Filtres de catégories -->
      <div class="flex items-center gap-1 bg-surface-container-highest/60 p-1 rounded-xl border border-outline-variant/15">
        <button
          onclick={() => (selectedCategoryFilter = 'all')}
          class="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all {selectedCategoryFilter === 'all'
            ? 'bg-primary text-on-primary shadow-sm'
            : 'text-on-surface-variant/70 hover:text-on-surface'}"
        >
          {m.wf_filter_all_blocks()}
        </button>
        {#each CATEGORIES as cat}
          <button
            onclick={() => (selectedCategoryFilter = cat)}
            class="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 {selectedCategoryFilter === cat
              ? 'bg-primary text-on-primary shadow-sm'
              : 'text-on-surface-variant/70 hover:text-on-surface'}"
          >
            <Papicon icon={CATEGORY_ICONS[cat]} size={11} />
            <span>{CATEGORY_LABELS[cat]()}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Barre de recherche palette -->
    <div class="relative min-w-48">
      <Papicon icon="Search" size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/70" />
      <input
        type="text"
        bind:value={searchQuery}
        placeholder={m.wf_search_block()}
        class="w-full pl-8 pr-3 py-1.5 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-xs text-on-surface focus:border-primary/50 focus:outline-none"
      />
    </div>
  </div>
  {/if}

  <div class="flex gap-3 h-[70vh] min-h-[520px]">
    <!-- Palette dynamique avec Drag & Drop -->
    {#if !readonly}
    <aside class="w-60 shrink-0 overflow-y-auto rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 p-3 space-y-3">
      <div>
        <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 mb-0.5">{m.wf_palette()}</h3>
        <p class="text-[10px] text-on-surface-variant/70">{m.wf_palette_hint()}</p>
      </div>

      {#if filteredCatalog.length === 0}
        <p class="text-xs text-on-surface-variant/70 text-center py-4">{m.wf_no_block_found()}</p>
      {:else}
        <div class="space-y-1.5">
          {#each filteredCatalog as def}
            <!-- L'enveloppe ne porte que le glisser-deposer : le bouton
                 qu'elle entoure fait deja le meme ajout au clic, donc elle
                 n'apporte aucune semantique et se declare comme telle. Le
                 draggable reste ici plutot que sur le bouton : WebKit ne fait
                 pas glisser les controles de formulaire. -->
            <div
              draggable="true"
              ondragstart={(e) => handleDragStart(e, def.type)}
              role="presentation"
              class="group relative"
            >
              <button
                onclick={() => addNode(def.type)}
                title={def.description}
                class="w-full text-left px-2.5 py-2 rounded-xl text-xs bg-surface-container-highest/60 hover:bg-surface-container-highest text-on-surface border border-outline-variant/10 hover:border-primary/30 transition-all flex items-center justify-between cursor-grab active:cursor-grabbing"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <span class="p-1 rounded-lg bg-surface-container/60 text-primary shrink-0">
                    <Papicon icon={CATEGORY_ICONS[def.category]} size={12} />
                  </span>
                  <span class="font-medium truncate text-[11px]">{def.label}</span>
                </div>
                <Papicon icon="Plus" size={12} class="text-on-surface-variant/70 group-hover:text-primary shrink-0 transition-colors" />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </aside>
    {/if}

    <!-- Canvas principal SvelteFlow -->
    <div
      ondragover={handleCanvasDragOver}
      ondrop={handleCanvasDrop}
      role="region"
      aria-label={m.wf_canvas_label()}
      class="flex-1 rounded-2xl overflow-hidden border border-outline-variant/10 bg-surface-container-low relative"
    >
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        {isValidConnection}
        fitView
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        deleteKey={readonly ? [] : ['Delete', 'Backspace']}
        proOptions={{ hideAttribution: true }}
        onconnectstart={handleConnectStart}
        onconnect={handleConnect}
        onconnectend={handleConnectEnd}
        ondelete={revalidate}
        onnodedragstop={revalidate}
        onnodeclick={({ node }: { node: any }) => { selectedId = node.id; selectedEdgeId = null; onSelectNode?.(node.id); }}
        onedgeclick={({ edge }: { edge: any }) => { selectedEdgeId = edge.id; selectedId = null; onSelectNode?.(null); }}
        onpaneclick={() => { selectedId = null; selectedEdgeId = null; onSelectNode?.(null); }}
      >
        <!-- La trame se lit par contraste avec le fond du canevas : des points
             clairs disparaissent sur le thème clair, et inversement. -->
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1.2}
          patternColor={themeStore.dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(17, 24, 39, 0.16)'}
        />
        <Controls />
      </SvelteFlow>
    </div>

    <!-- Panneau latéral : configuration & statut -->
    {#if !readonly}
    <aside class="w-64 shrink-0 overflow-y-auto rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 p-3 space-y-4">
      {#if selectedEdge}
        <div class="p-3 rounded-xl bg-surface-container-highest/60 border border-outline-variant/20 space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{m.wf_edge_selected()}</h3>
            <button
              onclick={deleteSelectedEdge}
              class="px-2 py-1 rounded-lg text-xs font-semibold text-red-700 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors flex items-center gap-1"
              title={m.wf_edge_delete_title()}
            >
              <Papicon icon="Trash" size={12} />
              <span>{m.wf_edge_delete()}</span>
            </button>
          </div>
          <p class="text-[11px] text-on-surface-variant/80">
            {m.wf_edge_links({
              source: getNodeDef((selectedEdgeSourceNode?.data as any)?.nodeType)?.label ?? selectedEdge?.source ?? '',
              target: getNodeDef((selectedEdgeTargetNode?.data as any)?.nodeType)?.label ?? selectedEdge?.target ?? '',
            })}
          </p>
          <p class="text-[10px] text-on-surface-variant/70">{m.wf_edge_delete_hint()}</p>
        </div>
      {:else if selectedNode && selectedDef}
        <div>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{m.wf_node_config()}</h3>
            <button
              onclick={deleteSelected}
              class="p-1 rounded text-red-700 dark:text-red-400 hover:bg-red-500/10 transition-colors"
              title={m.wf_delete_node()}
            >
              <Papicon icon="Trash" size={13} />
            </button>
          </div>
          <p class="text-xs font-semibold text-on-surface">{selectedDef.label}</p>
          <p class="text-[10px] text-on-surface-variant/70 mb-3">{selectedDef.description}</p>

          {#each selectedDef.config ?? [] as field}
            <div class="space-y-1 mb-2.5">
              <label for="cfg-{field.key}" class="text-[10px] font-bold text-on-surface-variant/70 uppercase tracking-widest">
                {field.label}
              </label>

              {#if field.type === 'cases'}
                <div class="space-y-1">
                  {#each (currentConfig('cases') as string[]) ?? [] as caseValue, index}
                    <div class="flex gap-1">
                      <input
                        value={caseValue}
                        oninput={(e) => updateCase(index, e.currentTarget.value)}
                        class="flex-1 px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-[11px] text-on-surface"
                      />
                      <button onclick={() => removeCase(index)} class="px-1.5 rounded text-red-700 dark:text-red-400 hover:bg-red-500/10">
                        <Papicon icon="Cross" size={11} />
                      </button>
                    </div>
                  {/each}
                  <button
                    onclick={addCase}
                    class="w-full px-2 py-1 rounded-lg text-[10px] bg-surface-container-highest text-on-surface-variant/70 hover:text-on-surface"
                  >{m.wf_switch_add_case()}</button>
                </div>
              {:else if field.type === 'boolean'}
                <input
                  id="cfg-{field.key}"
                  type="checkbox"
                  checked={Boolean(currentConfig(field.key))}
                  onchange={(e) => updateConfig(field.key, e.currentTarget.checked)}
                  class="w-4 h-4 rounded accent-primary"
                />
              {:else if field.type === 'number'}
                <input
                  id="cfg-{field.key}"
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={Number(currentConfig(field.key) ?? field.defaultValue ?? 0)}
                  oninput={(e) => updateConfig(field.key, Number(e.currentTarget.value))}
                  class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-[11px] text-on-surface"
                />
              {:else if field.type === 'role' || field.type === 'channel'}
                <select
                  id="cfg-{field.key}"
                  value={String(currentConfig(field.key) ?? '')}
                  onchange={(e) => updateConfig(field.key, e.currentTarget.value)}
                  class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-[11px] text-on-surface"
                >
                  <option value="">-</option>
                  {#each (field.type === 'role' ? availableRoles : availableChannels) as option}
                    <option value={option.id}>{field.type === 'role' ? '@' : '#'}{option.name}</option>
                  {/each}
                </select>
              {:else if field.type === 'select'}
                <select
                  id="cfg-{field.key}"
                  value={String(currentConfig(field.key) ?? field.defaultValue ?? '')}
                  onchange={(e) => updateConfig(field.key, e.currentTarget.value)}
                  class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-[11px] text-on-surface"
                >
                  {#each field.options ?? [] as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else if field.type === 'textarea'}
                <textarea
                  id="cfg-{field.key}"
                  rows="3"
                  value={String(currentConfig(field.key) ?? '')}
                  oninput={(e) => updateConfig(field.key, e.currentTarget.value)}
                  placeholder={field.placeholder}
                  class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-[11px] text-on-surface"
                ></textarea>
              {:else}
                <input
                  id="cfg-{field.key}"
                  type="text"
                  value={String(currentConfig(field.key) ?? '')}
                  oninput={(e) => updateConfig(field.key, e.currentTarget.value)}
                  placeholder={field.placeholder}
                  class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-[11px] text-on-surface"
                />
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="p-3 rounded-xl bg-surface-container-highest/40 border border-outline-variant/15 space-y-2">
          <h3 class="text-[10px] font-bold uppercase tracking-widest text-primary flex items-center gap-1.5">
            <Papicon icon="Info" size={13} />
            <span>{m.wf_tips_title()}</span>
          </h3>
          <ul class="text-[10px] text-on-surface-variant/70 space-y-1.5 list-disc pl-3">
            <li><strong>{m.wf_tip_direct_label()}</strong> {m.wf_tip_direct()}</li>
            <li><strong>{m.wf_tip_wysiwyg_label()}</strong> {m.wf_tip_wysiwyg()}</li>
            <li><strong>{m.wf_tip_dnd_label()}</strong> {m.wf_tip_dnd()}</li>
          </ul>
        </div>
      {/if}

      <!-- Problèmes de validation -->
      <div>
        <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 mb-2">{m.wf_issues()}</h3>
        {#if issues.length === 0}
          <p class="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <Papicon icon="Check" size={12} /> {m.wf_no_issues()}
          </p>
        {:else}
          <ul class="space-y-1.5">
            {#each issues as issue}
              <li
                class="px-2 py-1.5 rounded-lg text-[10px] leading-snug {issue.severity === 'error'
                  ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}"
              >{issue.message}</li>
            {/each}
          </ul>
        {/if}
      </div>
    </aside>
    {/if}
  </div>
</div>

<!-- Modal Modèles de triggers prêts à l'emploi -->
{#if showTemplateModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
    <div class="w-full max-w-3xl rounded-2xl bg-surface-container-high border border-outline-variant/20 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
      <!-- Header -->
      <div class="px-5 py-4 border-b border-outline-variant/15 flex items-center justify-between bg-surface-container-highest/40">
        <div class="flex items-center gap-2">
          <div class="p-2 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <Papicon icon="Sparkles" size={18} />
          </div>
          <div>
            <h3 class="text-sm font-bold text-on-surface">{m.wf_templates_modal_title()}</h3>
            <p class="text-[11px] text-on-surface-variant/70">{m.wf_templates_modal_desc()}</p>
          </div>
        </div>
        <button
          onclick={() => (showTemplateModal = false)}
          class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-highest transition-colors"
        >
          <Papicon icon="Cross" size={16} />
        </button>
      </div>

      <!-- Liste des modèles -->
      <div class="p-5 grid grid-cols-1 md:grid-cols-2 gap-3 overflow-y-auto">
        {#each WORKFLOW_TEMPLATES as template}
          <button
            type="button"
            onclick={() => applyTemplate(template)}
            class="p-4 rounded-xl bg-surface-container-highest/50 border border-outline-variant/15 hover:border-amber-500/40 text-left space-y-2 transition-all hover:scale-[1.01] group"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="p-2 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300 group-hover:bg-amber-500/25 transition-colors">
                  <Papicon icon={template.icon} size={16} />
                </span>
                <h4 class="text-xs font-bold text-on-surface group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-colors">{template.name}</h4>
              </div>
              <span class="px-2 py-0.5 rounded text-[9px] font-semibold bg-surface-container-highest text-on-surface-variant/70 uppercase tracking-wider">
                {template.category}
              </span>
            </div>
            <p class="text-[11px] text-on-surface-variant/70 leading-relaxed">{template.description}</p>
            <div class="pt-1 flex items-center text-[10px] font-semibold text-amber-700 dark:text-amber-300 group-hover:underline">
              <span>{m.wf_templates_apply()} →</span>
            </div>
          </button>
        {/each}
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 border-t border-outline-variant/15 bg-surface-container-highest/30 flex items-center justify-end">
        <button
          onclick={() => (showTemplateModal = false)}
          class="px-4 py-2 rounded-xl text-xs font-semibold bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-all"
        >
          {m.wf_close()}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(.svelte-flow__attribution) {
    display: none !important;
  }

  /* Les commandes de zoom suivent le thème : figées en sombre, elles posaient
     un bloc noir au coin d'un canevas clair. */
  :global(.svelte-flow__controls) {
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.25), 0 8px 10px -6px rgba(0, 0, 0, 0.2) !important;
    border-radius: 0.75rem !important;
    overflow: hidden !important;
    border: 1px solid var(--outline-variant) !important;
    background: var(--surface-container-high) !important;
  }

  :global(.svelte-flow__controls-button) {
    background: var(--surface-container-high) !important;
    border-bottom: 1px solid var(--outline-variant) !important;
    color: var(--on-surface) !important;
    fill: var(--on-surface) !important;
    width: 28px !important;
    height: 28px !important;
    transition: background-color 0.15s ease, color 0.15s ease !important;
  }

  :global(.svelte-flow__controls-button:hover) {
    background: var(--surface-container-highest) !important;
    color: var(--on-surface) !important;
  }

  :global(.svelte-flow__controls-button svg) {
    fill: currentColor !important;
    stroke: currentColor !important;
  }

  :global(.svelte-flow__handle) {
    transition: transform 0.15s ease, box-shadow 0.15s ease !important;
    z-index: 10 !important;
  }

  /* Le halo au survol doit trancher sur le canevas, donc suivre le texte
     plutôt qu'être blanc en dur. */
  :global(.svelte-flow__handle:hover) {
    transform: translateY(-50%) scale(1.3) !important;
    box-shadow: 0 0 8px var(--on-surface) !important;
    z-index: 20 !important;
  }

  /* Seule la couleur s'anime : faire varier `stroke-width` force le navigateur
     à recalculer la géométrie du tracé à chaque image, et une sélection au
     rectangle en fait basculer des dizaines d'un coup. */
  :global(.svelte-flow__edge-path) {
    stroke-width: 2.5px !important;
    transition: stroke 0.15s ease !important;
  }

  :global(.svelte-flow__edge:hover .svelte-flow__edge-path) {
    stroke: #38bdf8 !important;
    stroke-width: 3.5px !important;
    cursor: pointer !important;
  }

  :global(.svelte-flow__edge.selected .svelte-flow__edge-path) {
    stroke: #ef4444 !important;
    stroke-width: 3.5px !important;
  }
</style>
