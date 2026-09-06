<script lang="ts">
  import { onMount } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RecipeEditor from '../lib/components/triggers/RecipeEditor.svelte';
  import WorkflowEditor from '../lib/components/workflows/WorkflowEditor.svelte';
  import { RECIPE_TEMPLATES, type RecipeTemplate } from '@kotbo/shared';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import {
    compileRecipe,
    getNodeDef,
    getTrigger,
    hasBlockingIssue,
    type ValidationIssue,
    type WorkflowGraph,
  } from '@kotbo/shared';
  import {
    fetchWorkflows,
    fetchWorkflow,
    createWorkflow,
    updateWorkflow,
    toggleWorkflow,
    deleteWorkflow,
    fetchWorkflowExecutions,
    fetchWorkflowExecution,
    type WorkflowSummary,
    type WorkflowExecutionSummary,
    type WorkflowExecutionDetail,
  } from '../lib/api';

  /**
   * Automatisations - liste, création guidée et édition.
   *
   * L'édition se fait en phrases ; la vue graphe reste accessible et prend la
   * main d'office pour les automatisations qui ne s'expriment pas linéairement,
   * notamment celles écrites avec l'ancien éditeur. Rien n'est jamais converti
   * de force : les deux vues travaillent sur le même graphe.
   */

  const canManageSettings = $derived(!!dashboardStore.state.access?.canManageSettings);

  type View = 'list' | 'templates' | 'editor' | 'replay';
  let view = $state<View>('list');
  let tab = $state<'steps' | 'graph'>('steps');
  /** Vrai quand le graphe ouvert ne se lit pas comme une suite de phrases */
  let advancedOnly = $state(false);

  let loading = $state(true);
  let error = $state('');

  let workflows = $state<WorkflowSummary[]>([]);
  let executions = $state<WorkflowExecutionSummary[]>([]);

  let searchFilter = $state('');
  let statusFilter = $state<'all' | 'active' | 'inactive'>('all');

  let editingId = $state<string | null>(null);
  let form = $state({ name: '', description: '', enabled: false });
  let graph = $state<WorkflowGraph>({ nodes: [], edges: [] });
  let issues = $state<ValidationIssue[]>([]);
  let saving = $state(false);

  /**
   * Rejeu d'une exécution passée.
   *
   * Le moteur consigne chaque nœud traversé avec les valeurs qui y sont
   * entrées et sorties : rejouer, c'est réafficher le graphe enregistré en
   * s'arrêtant au rang choisi. Rien n'est réexécuté, on relit une trace.
   */
  let replay = $state<WorkflowExecutionDetail | null>(null);
  let replayIndex = $state(0);
  let replayLoading = $state(false);

  const replayStep = $derived(replay?.steps[replayIndex]);
  const replayNodeLabel = $derived(
    replayStep ? getNodeDef(replayStep.nodeType)?.label ?? replayStep.nodeType : '',
  );

  const blocking = $derived(issues.filter((issue) => issue.severity === 'error'));

  const filteredWorkflows = $derived(
    workflows.filter((workflow) => {
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && workflow.enabled) ||
        (statusFilter === 'inactive' && !workflow.enabled);

      const needle = searchFilter.trim().toLowerCase();
      const haystack = [
        workflow.name,
        workflow.description ?? '',
        getTrigger(workflow.triggerType)?.sentence ?? workflow.triggerType,
      ].join(' ').toLowerCase();

      return matchesStatus && (!needle || haystack.includes(needle));
    }),
  );

  async function loadList(): Promise<void> {
    try {
      const [list, runs] = await Promise.all([fetchWorkflows(), fetchWorkflowExecutions()]);
      if (list) workflows = list.workflows;
      if (runs) executions = runs.executions;
    } catch (e: any) {
      error = e?.message || m.wf_error();
    }
  }

  onMount(async () => {
    loading = true;
    await loadList();
    loading = false;
  });

  // ── Création ──────────────────────────────────────────────────────────────

  function openEditor(name: string, next: WorkflowGraph): void {
    editingId = null;
    form = { name, description: '', enabled: false };
    graph = next;
    issues = [];
    advancedOnly = false;
    tab = 'steps';
    view = 'editor';
  }

  function startFromTemplate(template: RecipeTemplate): void {
    openEditor(TEMPLATE_LABELS[template.id]?.name() ?? '', compileRecipe(template.build()));
  }

  async function edit(id: string): Promise<void> {
    try {
      const result = await fetchWorkflow(id);
      if (!result?.workflow) return;

      editingId = id;
      form = {
        name: result.workflow.name,
        description: result.workflow.description ?? '',
        enabled: result.workflow.enabled,
      };
      graph = result.workflow.graph;
      issues = [];
      advancedOnly = false;
      tab = 'steps';
      view = 'editor';
    } catch (e: any) {
      toast.error(e?.message || m.wf_error());
    }
  }

  // ── Rejeu ─────────────────────────────────────────────────────────────────

  /**
   * Ouvre une exécution passée sur le graphe du workflow.
   *
   * Le graphe vient du workflow et non de l'exécution : seule la trace est
   * conservée pas à pas. Un workflow modifié depuis fait donc apparaître des
   * étapes rattachées à des nœuds disparus, que la carte ignore simplement.
   */
  async function openReplay(execution: WorkflowExecutionSummary): Promise<void> {
    if (replayLoading) return;
    replayLoading = true;
    try {
      const [detail, workflow] = await Promise.all([
        fetchWorkflowExecution(execution.id),
        fetchWorkflow(execution.workflowId),
      ]);

      if (!detail?.execution || !workflow?.workflow) return;
      if (detail.execution.steps.length === 0) {
        toast.error(m.wf_replay_empty());
        return;
      }

      graph = workflow.workflow.graph;
      replay = detail.execution;
      replayIndex = 0;
      view = 'replay';
    } catch (e: any) {
      toast.error(e?.message || m.wf_error());
    } finally {
      replayLoading = false;
    }
  }

  function closeReplay(): void {
    replay = null;
    replayIndex = 0;
    graph = { nodes: [], edges: [] };
    view = 'list';
  }

  function seekReplay(delta: number): void {
    if (!replay) return;
    replayIndex = Math.min(replay.steps.length - 1, Math.max(0, replayIndex + delta));
  }

  /**
   * Rend lisible une valeur consignée.
   *
   * Le moteur écrit des entités marquées d'un `kind` (membre, salon, rôle,
   * message) autant que des scalaires : afficher le JSON brut d'un membre
   * remplirait la colonne pour rien.
   */
  function describeValue(value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (Array.isArray(value)) {
      return value.length === 0 ? '-' : value.map(describeValue).join(', ');
    }
    if (typeof value === 'object') {
      const tagged = value as { kind?: string; name?: string; displayName?: string; tag?: string; content?: string };
      if (tagged.kind) return tagged.displayName || tagged.name || tagged.tag || tagged.content || tagged.kind;
      return JSON.stringify(value);
    }
    return String(value);
  }

  // ── Enregistrement ────────────────────────────────────────────────────────

  async function save(): Promise<void> {
    if (!canManageSettings || saving) return;

    if (!form.name.trim()) {
      toast.error(m.wf_need_name());
      return;
    }
    if (hasBlockingIssue(issues)) {
      toast.error(m.wf_steps_incomplete());
      return;
    }

    saving = true;
    try {
      const payload = {
        name: form.name,
        description: form.description || null,
        enabled: form.enabled,
        graph,
      };
      const result = editingId ? await updateWorkflow(editingId, payload) : await createWorkflow(payload);

      if (result?.workflow) editingId = result.workflow.id;
      toast.success(m.wf_saved());
      await loadList();
    } catch (e: any) {
      toast.error(e?.message || m.wf_error());
    } finally {
      saving = false;
    }
  }

  async function toggle(workflow: WorkflowSummary): Promise<void> {
    try {
      await toggleWorkflow(workflow.id, !workflow.enabled);
      await loadList();
    } catch (e: any) {
      toast.error(e?.message || m.wf_error());
    }
  }

  async function duplicate(workflow: WorkflowSummary): Promise<void> {
    try {
      const full = await fetchWorkflow(workflow.id);
      if (!full?.workflow) return;

      await createWorkflow({
        name: m.wf_copy_name({ name: full.workflow.name }),
        description: full.workflow.description,
        enabled: false,
        graph: full.workflow.graph,
      });
      toast.success(m.wf_duplicated());
      await loadList();
    } catch (e: any) {
      toast.error(e?.message || m.wf_error());
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm(m.wf_delete_confirm())) return;
    try {
      await deleteWorkflow(id);
      toast.success(m.wf_deleted());
      await loadList();
    } catch (e: any) {
      toast.error(e?.message || m.wf_error());
    }
  }

  // ── Affichage ─────────────────────────────────────────────────────────────

  /**
   * Un workflow actif qui n'a jamais rien produit.
   *
   * Le cas le plus courant d'un « ça ne marche pas » silencieux : déclencheur
   * mal choisi, condition qui ne passe jamais, module éteint après coup. On ne
   * le signale qu'au bout d'un moment, sinon tout workflow fraîchement
   * enregistré s'accuserait lui-même.
   */
  const SILENT_AFTER_MS = 24 * 60 * 60 * 1000;

  function isSilent(workflow: WorkflowSummary): boolean {
    if (!workflow.enabled || workflow.runCount > 0) return false;
    return Date.now() - new Date(workflow.updatedAt).getTime() > SILENT_AFTER_MS;
  }

  function successRate(workflow: WorkflowSummary): number {
    if (workflow.runCount === 0) return 0;
    return Math.round((workflow.successCount / workflow.runCount) * 100);
  }

  function formatDate(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleString(dateLocale(), {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  /** Libellés des modèles, tenus hors du fichier de données pour rester traduisibles. */
  const TEMPLATE_LABELS: Record<string, { name: () => string; description: () => string }> = {
    welcome: { name: m.wf_tpl_welcome, description: m.wf_tpl_welcome_desc },
    'young-account': { name: m.wf_tpl_young, description: m.wf_tpl_young_desc },
    'anti-invite': { name: m.wf_tpl_invite, description: m.wf_tpl_invite_desc },
    'level-reward': { name: m.wf_tpl_level, description: m.wf_tpl_level_desc },
    'ticket-welcome': { name: m.wf_tpl_ticket, description: m.wf_tpl_ticket_desc },
  };

  const STATUS_META: Record<string, { label: () => string; color: string }> = {
    COMPLETED: { label: () => m.wf_exec_status_completed(), color: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
    FAILED: { label: () => m.wf_exec_status_failed(), color: 'bg-red-500/15 text-red-700 dark:text-red-300' },
    WAITING: { label: () => m.wf_exec_status_waiting(), color: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
    RUNNING: { label: () => m.wf_exec_status_running(), color: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
    CANCELLED: { label: () => m.wf_exec_status_cancelled(), color: 'bg-surface-container-highest text-on-surface-variant/70' },
  };
</script>

<ModulePage title={m.wf_page_title()} description={m.wf_page_desc()} icon="Workflow" featureKey="workflows">
  {#snippet actions()}
    <!-- Le rejeu ne modifie rien : il reste ouvert aux comptes sans droit de
         configuration, contrairement aux actions d'édition ci-dessous. -->
    {#if view === 'replay'}
      <button
        onclick={closeReplay}
        class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-all"
      >{m.wf_back()}</button>
    {:else if canManageSettings}
      <div class="flex items-center gap-2">
        {#if view === 'editor'}
          <button
            onclick={() => { view = 'list'; }}
            class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-all"
          >{m.wf_back()}</button>
          <button
            onclick={save}
            disabled={saving || hasBlockingIssue(issues) || graph.nodes.length === 0}
            class="px-5 py-2.5 rounded-xl text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-all disabled:opacity-40 flex items-center gap-2"
          >
            <Papicon icon={saving ? 'Loader' : 'Check'} size={14} class={saving ? 'animate-spin' : ''} />
            {saving ? m.wf_saving() : m.wf_save()}
          </button>
        {:else if view === 'templates'}
          <button
            onclick={() => { view = 'list'; }}
            class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-all"
          >{m.wf_back()}</button>
        {:else}
          <button
            onclick={() => { view = 'templates'; }}
            class="px-5 py-2.5 rounded-xl text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-all flex items-center gap-2 shadow-lg shadow-primary/20"
          >
            <Papicon icon="Plus" size={14} />
            {m.wf_new_automation()}
          </button>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#if loading}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="h-24 rounded-2xl bg-surface-container-high/40 animate-pulse"></div>
      {/each}
    </div>

  {:else if error}
    <div class="p-6 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-700 dark:text-red-300 flex items-center gap-3">
      <Papicon icon="Warning" size={20} />
      <span>{error}</span>
    </div>

  <!-- ══ Choix du point de départ ═══════════════════════════════════════ -->
  {:else if view === 'templates'}
    <div class="space-y-5">
      <div class="space-y-1">
        <h2 class="text-sm font-bold text-on-surface">{m.wf_start_title()}</h2>
        <p class="text-xs text-on-surface-variant/70">
          {m.wf_start_desc()}
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {#each RECIPE_TEMPLATES as template (template.id)}
          {@const labels = TEMPLATE_LABELS[template.id]}
          <button
            type="button"
            onclick={() => startFromTemplate(template)}
            class="flex items-start gap-3 p-4 rounded-2xl text-left bg-surface-container-high/50 border border-outline-variant/15 hover:border-primary/40 hover:bg-surface-container-high transition-all"
          >
            <span class="p-2.5 rounded-xl bg-primary/10 text-primary shrink-0">
              <Papicon icon={template.icon} size={16} />
            </span>
            <span class="min-w-0 space-y-1">
              <span class="block text-sm font-semibold text-on-surface">{labels?.name()}</span>
              <span class="block text-xs text-on-surface-variant/70 leading-snug">{labels?.description()}</span>
            </span>
          </button>
        {/each}

        <button
          type="button"
          onclick={() => openEditor('', { nodes: [], edges: [] })}
          class="flex items-start gap-3 p-4 rounded-2xl text-left border border-dashed border-outline-variant/30 hover:border-primary/40 transition-all"
        >
          <span class="p-2.5 rounded-xl bg-surface-container-highest text-on-surface-variant/70 shrink-0">
            <Papicon icon="Plus" size={16} />
          </span>
          <span class="min-w-0 space-y-1">
            <span class="block text-sm font-semibold text-on-surface">{m.wf_start_blank()}</span>
            <span class="block text-xs text-on-surface-variant/70 leading-snug">{m.wf_start_blank_desc()}</span>
          </span>
        </button>
      </div>
    </div>

  <!-- ══ Rejeu d'une exécution ══════════════════════════════════════════ -->
  {:else if view === 'replay' && replay}
    <div class="space-y-3">
      <!-- Transport -->
      <div class="flex flex-wrap items-center gap-3 p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10">
        <div class="flex items-center gap-1">
          <button
            onclick={() => seekReplay(-1)}
            disabled={replayIndex === 0}
            class="p-2 rounded-xl bg-surface-container-highest text-on-surface hover:bg-surface-container-highest/70 disabled:opacity-30 transition-all"
            aria-label={m.wf_replay_previous()}
          ><Papicon icon="ChevronLeft" size={14} /></button>
          <button
            onclick={() => seekReplay(1)}
            disabled={replayIndex >= replay.steps.length - 1}
            class="p-2 rounded-xl bg-surface-container-highest text-on-surface hover:bg-surface-container-highest/70 disabled:opacity-30 transition-all"
            aria-label={m.wf_replay_next()}
          ><Papicon icon="ChevronRight" size={14} /></button>
        </div>

        <span class="text-xs font-semibold text-on-surface tabular-nums">
          {m.wf_replay_position({ n: replayIndex + 1, total: replay.steps.length })}
        </span>

        <input
          type="range"
          min="0"
          max={replay.steps.length - 1}
          value={replayIndex}
          oninput={(event) => (replayIndex = Number(event.currentTarget.value))}
          class="flex-1 min-w-40 accent-primary cursor-pointer"
          aria-label={m.wf_replay_position({ n: replayIndex + 1, total: replay.steps.length })}
        />

        {#if replay.error}
          <span class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-red-500/10 text-red-700 dark:text-red-300 max-w-72 truncate" title={replay.error}>
            {replay.error}
          </span>
        {/if}
      </div>

      <div class="flex flex-col lg:flex-row gap-3">
        <div class="flex-1 min-w-0">
          <WorkflowEditor
            {graph}
            replaySteps={replay.steps}
            {replayIndex}
            readonly
            onSelectNode={(nodeId) => {
              // Cliquer un nœud rejoue jusqu'à son dernier passage : c'est la
              // lecture naturelle quand une boucle l'a traversé plusieurs fois.
              const last = replay!.steps.findLastIndex((step) => step.nodeId === nodeId);
              if (last >= 0) replayIndex = last;
            }}
          />
        </div>

        <!-- Valeurs consignées sur l'étape courante -->
        <aside class="w-full lg:w-72 shrink-0 space-y-3">
          {#if replayStep}
            {@const stepStatus = replayStep.status}
            <div class="p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-bold text-on-surface truncate">{replayNodeLabel}</span>
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 {stepStatus === 'ERROR'
                    ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                    : stepStatus === 'SKIPPED'
                      ? 'bg-surface-container-highest text-on-surface-variant'
                      : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'}"
                >{stepStatus}</span>
              </div>
              <p class="text-[11px] text-on-surface-variant/70">{m.wf_replay_duration({ n: replayStep.durationMs })}</p>
              {#if replayStep.error}
                <p class="px-2.5 py-1.5 rounded-lg bg-red-500/10 text-[10px] text-red-700 dark:text-red-300 border border-red-500/20">{replayStep.error}</p>
              {/if}
            </div>

            {#each [
              { label: m.wf_replay_inputs(), values: replayStep.inputs },
              { label: m.wf_replay_outputs(), values: replayStep.outputs },
            ] as slot (slot.label)}
              {@const entries = Object.entries(slot.values ?? {})}
              <div class="p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-2">
                <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{slot.label}</h3>
                {#if entries.length === 0}
                  <p class="text-[11px] text-on-surface-variant/70">{m.wf_replay_no_value()}</p>
                {:else}
                  <dl class="space-y-1.5">
                    {#each entries as [key, value] (key)}
                      <div class="flex items-baseline gap-2 text-[11px]">
                        <dt class="font-semibold text-on-surface-variant shrink-0">{key}</dt>
                        <dd class="text-on-surface truncate" title={describeValue(value)}>{describeValue(value)}</dd>
                      </div>
                    {/each}
                  </dl>
                {/if}
              </div>
            {/each}
          {/if}
        </aside>
      </div>
    </div>

  <!-- ══ Édition ════════════════════════════════════════════════════════ -->
  {:else if view === 'editor'}
    <div class="space-y-4">
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex-1 min-w-56 space-y-1.5">
          <label for="wf-name" class="text-[10px] font-bold text-on-surface-variant/70 uppercase tracking-widest">{m.wf_name()}</label>
          <input
            id="wf-name"
            bind:value={form.name}
            placeholder={m.wf_name_example()}
            class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
          />
        </div>

        <label class="flex items-center gap-2 px-3 py-2 cursor-pointer">
          <input type="checkbox" bind:checked={form.enabled} class="w-4 h-4 rounded accent-primary cursor-pointer" />
          <span class="text-xs text-on-surface font-medium">{m.wf_enabled()}</span>
        </label>

        <div class="flex items-center gap-1 p-1 rounded-xl bg-surface-container-highest/60 border border-outline-variant/15">
          <button
            onclick={() => (tab = 'steps')}
            disabled={advancedOnly}
            class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-30 {tab === 'steps'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant/70 hover:text-on-surface'}"
          >{m.wf_tab_steps()}</button>
          <button
            onclick={() => (tab = 'graph')}
            class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {tab === 'graph'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant/70 hover:text-on-surface'}"
          >{m.wf_tab_graph()}</button>
        </div>
      </div>

      {#if advancedOnly}
        <p class="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-800 dark:text-amber-200">
          <Papicon icon="Warning" size={13} class="mt-0.5 shrink-0" />
          <span>
            {m.wf_advanced_notice()}
          </span>
        </p>
      {/if}

      {#if blocking.length > 0}
        <p class="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-800 dark:text-amber-200">
          <Papicon icon="Warning" size={13} />
          {m.wf_incomplete({ n: blocking.length })}
        </p>
      {/if}

      {#if tab === 'steps'}
        <RecipeEditor
          {graph}
          onChange={(next, nextIssues) => { graph = next; issues = nextIssues; }}
          onUnsupported={() => { advancedOnly = true; tab = 'graph'; }}
        />
      {:else}
        <WorkflowEditor
          {graph}
          onChange={(next, nextIssues) => { graph = next; issues = nextIssues; }}
        />
      {/if}
    </div>

  <!-- ══ Liste ══════════════════════════════════════════════════════════ -->
  {:else}
    <div class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10">
        <div class="flex items-center gap-1 bg-surface-container-highest/60 p-1 rounded-xl border border-outline-variant/15">
          {#each [
            { key: 'all' as const, label: m.wf_filter_all(), count: workflows.length },
            { key: 'active' as const, label: m.wf_filter_active(), count: workflows.filter((w) => w.enabled).length },
            { key: 'inactive' as const, label: m.wf_filter_paused(), count: workflows.filter((w) => !w.enabled).length },
          ] as filter (filter.key)}
            <button
              onclick={() => (statusFilter = filter.key)}
              class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {statusFilter === filter.key
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant/70 hover:text-on-surface'}"
            >{filter.label} ({filter.count})</button>
          {/each}
        </div>

        <div class="relative min-w-64">
          <Papicon icon="Search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/70" />
          <input
            type="text"
            bind:value={searchFilter}
            placeholder={m.wf_search_placeholder()}
            class="w-full pl-9 pr-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-xs text-on-surface focus:border-primary/50 focus:outline-none"
          />
        </div>
      </div>

      {#if filteredWorkflows.length === 0}
        <div class="p-10 text-center rounded-2xl bg-surface-container-high/30 space-y-3">
          <div class="p-3 rounded-2xl bg-surface-container-highest/60 w-fit mx-auto text-on-surface-variant/70">
            <Papicon icon="Workflow" size={24} />
          </div>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-on-surface">
              {workflows.length === 0 ? m.wf_empty_title() : m.wf_no_result()}
            </p>
            <p class="text-xs text-on-surface-variant/70">
              {workflows.length === 0 ? m.wf_empty_desc() : m.wf_try_other()}
            </p>
          </div>
          {#if workflows.length === 0 && canManageSettings}
            <button
              onclick={() => (view = 'templates')}
              class="px-4 py-2 rounded-xl text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-all"
            >{m.wf_create_first()}</button>
          {/if}
        </div>
      {:else}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {#each filteredWorkflows as workflow (workflow.id)}
            {@const trigger = getTrigger(workflow.triggerType)}
            <article class="p-4 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-3 hover:border-outline-variant/30 transition-all">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 space-y-1">
                  <h3 class="text-sm font-bold text-on-surface truncate">{workflow.name}</h3>
                  <p class="flex items-center gap-1.5 text-xs text-on-surface-variant/70">
                    <Papicon icon={trigger?.icon ?? 'Warning'} size={11} class="{trigger ? 'text-primary' : 'text-amber-700 dark:text-amber-300'} shrink-0" />
                    {trigger?.sentence ?? m.wf_trigger_unknown({ type: workflow.triggerType })}
                  </p>
                  {#if workflow.description}
                    <p class="text-[11px] text-on-surface-variant/70 line-clamp-2">{workflow.description}</p>
                  {/if}
                </div>
                <span
                  class="px-2.5 py-1 rounded-full text-[10px] font-bold shrink-0 {workflow.enabled
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                    : 'bg-surface-container-highest text-on-surface-variant/70'}"
                >{workflow.enabled ? m.wf_status_active() : m.wf_status_paused()}</span>
              </div>

              {#if isSilent(workflow)}
                <p
                  class="flex items-start gap-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-800 dark:text-amber-200"
                >
                  <Papicon icon="Warning" size={11} class="mt-0.5 shrink-0" />
                  <span><strong>{m.wf_never_started()}</strong> {m.wf_never_started_hint()}</span>
                </p>
              {/if}

              <div class="flex flex-wrap items-center gap-3 text-[11px] text-on-surface-variant/70 pt-1 border-t border-outline-variant/10">
                <span>{m.wf_runs({ n: workflow.runCount })}</span>
                {#if workflow.runCount > 0}
                  <span class="text-emerald-700 dark:text-emerald-400 font-medium">{m.wf_success_rate({ n: successRate(workflow) })}</span>
                {/if}
                <span class="ml-auto">{workflow.lastRunAt ? m.wf_last_run({ date: formatDate(workflow.lastRunAt) }) : m.wf_never_run()}</span>
              </div>

              {#if workflow.lastError}
                <p class="px-2.5 py-1.5 rounded-lg bg-red-500/10 text-[10px] text-red-700 dark:text-red-300 truncate border border-red-500/20">{workflow.lastError}</p>
              {/if}

              {#if canManageSettings}
                <div class="flex items-center gap-2 pt-1">
                  <button
                    onclick={() => edit(workflow.id)}
                    class="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-surface-container-highest text-on-surface hover:bg-surface-container-highest/80 transition-all flex items-center gap-1.5"
                  >
                    <Papicon icon="Pen" size={12} />
                    {m.wf_edit()}
                  </button>
                  <button
                    onclick={() => duplicate(workflow)}
                    class="px-3 py-1.5 rounded-xl text-xs font-medium bg-surface-container-highest text-on-surface-variant/80 hover:text-on-surface transition-all"
                  >{m.wf_duplicate()}</button>
                  <button
                    onclick={() => toggle(workflow)}
                    class="px-3 py-1.5 rounded-xl text-xs font-medium bg-surface-container-highest text-on-surface-variant/70 hover:text-on-surface transition-all"
                  >{workflow.enabled ? m.wf_pause() : m.wf_activate()}</button>
                  <button
                    onclick={() => remove(workflow.id)}
                    class="p-1.5 rounded-xl text-red-700/70 dark:text-red-300/70 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-500/10 transition-all ml-auto"
                    aria-label={m.wf_delete()}
                  ><Papicon icon="Trash" size={13} /></button>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}

      <section class="space-y-3 pt-4 border-t border-outline-variant/15">
        <div class="space-y-0.5">
          <h2 class="text-sm font-bold text-on-surface">{m.wf_executions()}</h2>
          {#if executions.length > 0}
            <p class="text-[11px] text-on-surface-variant/70">{m.wf_executions_hint()}</p>
          {/if}
        </div>
        {#if executions.length === 0}
          <p class="text-xs text-on-surface-variant/70">{m.wf_executions_empty()}</p>
        {:else}
          <ul class="space-y-2">
            {#each executions.slice(0, 12) as execution (execution.id)}
              {@const meta = STATUS_META[execution.status] ?? STATUS_META.CANCELLED}
              <li>
                <button
                  type="button"
                  onclick={() => openReplay(execution)}
                  disabled={replayLoading}
                  class="w-full flex flex-wrap items-center gap-3 px-3.5 py-2.5 rounded-xl bg-surface-container-high/50 text-xs text-left border border-outline-variant/10 hover:border-primary/40 hover:bg-surface-container-high transition-all disabled:opacity-50"
                >
                  <span class="px-2.5 py-0.5 rounded-full font-semibold text-[10px] {meta.color}">{meta.label()}</span>
                  <span class="text-on-surface font-medium truncate">
                    {workflows.find((w) => w.id === execution.workflowId)?.name ?? execution.workflowId}
                  </span>
                  {#if execution.resumeAt}
                    <span class="text-amber-700 dark:text-amber-300">{m.wf_exec_resume_at({ date: formatDate(execution.resumeAt) })}</span>
                  {/if}
                  <span class="text-on-surface-variant/70 ml-auto">{formatDate(execution.startedAt)}</span>
                  <Papicon icon="ChevronRight" size={12} class="text-on-surface-variant/70 shrink-0" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}
</ModulePage>
