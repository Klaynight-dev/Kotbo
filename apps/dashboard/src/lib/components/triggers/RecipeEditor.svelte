<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import StepCard from './StepCard.svelte';
  import StepPicker from './StepPicker.svelte';
  import TriggerPicker from './TriggerPicker.svelte';
  import ScheduleField from './ScheduleField.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import {
    DEFAULT_SCHEDULE,
    acceptsMoreSteps,
    availableConditions,
    scheduleToCron,
    compileRecipe,
    decompileGraph,
    getAction,
    getTrigger,
    movableSteps,
    newStepId,
    stepIdOfNode,
    tokensOfType,
    validateGraph,
    type ConditionStep,
    type Recipe,
    type RecipeStep,
    type ValidationIssue,
    type ValueRef,
    type WorkflowGraph,
  } from '@kotbo/shared';

  /**
   * Éditeur d'automatisation en langage courant.
   *
   * Il travaille sur une recette et ne publie qu'un graphe : la recette est
   * recompilée à chaque modification, ce qui garde l'aperçu graphe, la
   * validation et l'enregistrement sur exactement la même donnée que le moteur
   * exécutera.
   */
  const {
    graph,
    onChange,
    onUnsupported,
  }: {
    graph: WorkflowGraph;
    onChange: (graph: WorkflowGraph, issues: ValidationIssue[]) => void;
    /** Appelé quand le graphe reçu ne s'exprime pas en phrases */
    onUnsupported?: () => void;
  } = $props();

  const roles = $derived(dashboardStore.state.discordRoles || []);
  const channels = $derived(dashboardStore.state.discordChannels || []);

  let recipe = $state<Recipe>({ trigger: { type: '' }, steps: [] });
  let changingTrigger = $state(false);
  /** Branche visée par le sélecteur d'étape, `null` quand il est fermé */
  let adding = $state<{ parentId: string | null; branch: 'then' | 'otherwise' } | null>(null);

  let loaded: WorkflowGraph | null = null;

  // Le graphe entrant fait autorité tant qu'il n'a pas été relu ici : c'est ce
  // qui permet d'ouvrir une automatisation existante, quelle que soit son
  // origine.
  $effect(() => {
    const incoming = graph;
    if (incoming === loaded) return;
    loaded = incoming;

    if (incoming.nodes.length === 0) {
      recipe = { trigger: { type: '' }, steps: [] };
      changingTrigger = true;
      return;
    }

    const read = decompileGraph(incoming);
    if (!read) {
      onUnsupported?.();
      return;
    }
    recipe = read;
    changingTrigger = false;
    // Un modèle arrive avec des champs volontairement vides : on remonte l'état
    // de validation dès l'ouverture, sans quoi l'enregistrement paraîtrait
    // possible avant la première modification.
    onChange(incoming, validateGraph(incoming));
  });

  const trigger = $derived(getTrigger(recipe.trigger.type));

  const issues = $derived(recipe.trigger.type ? validateGraph(compileRecipe(recipe)) : []);

  /** Problèmes rattachés à chaque étape, l'identifiant de nœud portant le sien. */
  const problemsByStep = $derived.by(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue.nodeId || issue.severity !== 'error') continue;
      const stepId = stepIdOfNode(issue.nodeId);
      map.set(stepId, [...(map.get(stepId) ?? []), humanize(issue)]);
    }
    return map;
  });

  /** Reformule un message de validation pensé pour le graphe. */
  function humanize(issue: ValidationIssue): string {
    if (issue.code === 'MISSING_INPUT') return m.wf_field_missing();
    return issue.message;
  }

  function publish(): void {
    const compiled = compileRecipe(recipe);
    loaded = compiled;
    onChange(compiled, validateGraph(compiled));
  }

  function update(next: Recipe): void {
    recipe = next;
    publish();
  }

  // ── Déclencheur ───────────────────────────────────────────────────────────

  function pickTrigger(type: string): void {
    // Changer de déclencheur change le contexte disponible : les étapes déjà
    // écrites y feraient référence à vide, on repart donc d'une page blanche
    // plutôt que de laisser des champs cassés.
    const keep = recipe.trigger.type === type || recipe.steps.length === 0;
    // La planification part sur un motif valide : sans lui, choisir le
    // déclencheur afficherait aussitôt une erreur de validation.
    const config = type === 'OnSchedule'
      ? { cron: recipe.trigger.config?.cron ?? scheduleToCron(DEFAULT_SCHEDULE) }
      : undefined;

    update({ trigger: { type, ...(config ? { config } : {}) }, steps: keep ? recipe.steps : [] });
    changingTrigger = false;
  }

  function setTriggerConfig(key: string, value: unknown): void {
    update({ ...recipe, trigger: { ...recipe.trigger, config: { ...recipe.trigger.config, [key]: value } } });
  }

  // ── Étapes ────────────────────────────────────────────────────────────────

  /**
   * Pré-remplit ce qui n'a qu'une réponse possible.
   *
   * Quand le déclencheur ne fournit qu'un membre, le demander serait une
   * question sans choix : on répond à la place.
   */
  function defaultsFor(actionType: string): Record<string, ValueRef> {
    const def = getAction(actionType);
    const values: Record<string, ValueRef> = {};
    if (!def) return values;

    for (const field of def.fields) {
      const ENTITY: Partial<Record<string, 'Member' | 'Channel' | 'Message'>> = {
        member: 'Member', channel: 'Channel', message: 'Message',
      };
      const entity = ENTITY[field.kind];
      if (entity) {
        const [token] = tokensOfType(recipe.trigger.type, entity).filter((candidate) => candidate.root);
        if (token) values[field.key] = { from: 'context', path: token.path };
      }
      if (field.kind === 'number' && typeof field.defaultValue === 'number') {
        values[field.key] = { from: 'number', value: field.defaultValue };
      }
      if (field.option && typeof field.defaultValue === 'string') {
        values[field.key] = { from: 'text', template: field.defaultValue };
      }
    }

    return values;
  }

  function build(choice: { kind: 'action'; action: string } | { kind: 'condition' } | { kind: 'wait' }): RecipeStep {
    const id = newStepId();

    if (choice.kind === 'action') {
      return { id, kind: 'action', action: choice.action, values: defaultsFor(choice.action) };
    }
    if (choice.kind === 'wait') {
      return { id, kind: 'wait', seconds: 60 };
    }

    // Une condition sans test ne dit rien : on amorce avec la première
    // formulable, l'utilisateur n'a plus qu'à la remplacer ou la compléter.
    const [first] = availableConditions(recipe.trigger.type);
    return {
      id,
      kind: 'condition',
      match: 'all',
      tests: first ? [{ id: newStepId('t'), condition: first.key, operator: first.defaultOperator }] : [],
      then: [],
      otherwise: [],
    };
  }

  function add(choice: Parameters<typeof build>[0]): void {
    const step = build(choice);
    const target = adding;
    adding = null;
    if (!target) return;

    if (!target.parentId) {
      update({ ...recipe, steps: [...recipe.steps, step] });
      return;
    }

    update({
      ...recipe,
      steps: recipe.steps.map(function attach(current): RecipeStep {
        if (current.kind !== 'condition') return current;
        if (current.id === target.parentId) {
          return { ...current, [target.branch]: [...current[target.branch], step] };
        }
        return { ...current, then: current.then.map(attach), otherwise: current.otherwise.map(attach) };
      }),
    });
  }

  function replaceRoot(updated: RecipeStep): void {
    update({ ...recipe, steps: recipe.steps.map((step) => (step.id === updated.id ? updated : step)) });
  }

  function removeRoot(id: string): void {
    update({ ...recipe, steps: recipe.steps.filter((step) => step.id !== id) });
  }

  function moveRoot(id: string, delta: number): void {
    const list = [...recipe.steps];
    const index = list.findIndex((step) => step.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(target, 0, moved);
    update({ ...recipe, steps: list });
  }

  /** Ajout d'une condition supplémentaire dans une étape « Si ». */
  function addTest(step: ConditionStep): void {
    const [first] = availableConditions(recipe.trigger.type);
    if (!first) return;
    replaceStep({
      ...step,
      tests: [...step.tests, { id: newStepId('t'), condition: first.key, operator: first.defaultOperator }],
    });
  }

  function replaceStep(updated: RecipeStep): void {
    update({
      ...recipe,
      steps: recipe.steps.map(function walk(current): RecipeStep {
        if (current.id === updated.id) return updated;
        if (current.kind !== 'condition') return current;
        return { ...current, then: current.then.map(walk), otherwise: current.otherwise.map(walk) };
      }),
    });
  }
</script>

<div class="space-y-3">
  <!-- ── Déclencheur ──────────────────────────────────────────────────── -->
  <section class="rounded-2xl bg-surface-container-high/60 border border-outline-variant/15 border-l-[3px] border-l-emerald-400/60 p-4 space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{m.wf_when()}</h3>
      {#if trigger && !changingTrigger}
        <button
          type="button"
          onclick={() => (changingTrigger = true)}
          class="text-[11px] font-medium text-primary hover:underline"
        >{m.wf_change()}</button>
      {/if}
    </div>

    {#if trigger && !changingTrigger}
      <p class="flex items-center gap-2 text-sm font-semibold text-on-surface">
        <Papicon icon={trigger.icon} size={15} class="text-emerald-700 dark:text-emerald-300" />
        {trigger.sentence}
      </p>
      {#if recipe.trigger.type === 'OnSchedule'}
        <ScheduleField
          value={String(recipe.trigger.config?.cron ?? '')}
          onChange={(cron) => setTriggerConfig('cron', cron)}
        />
      {/if}
    {:else}
      <TriggerPicker selected={recipe.trigger.type} onPick={pickTrigger} />
    {/if}
  </section>

  <!-- ── Étapes ───────────────────────────────────────────────────────── -->
  {#if trigger && !changingTrigger}
    <section class="space-y-2">
      <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 px-1">{m.wf_then()}</h3>

      {#if recipe.steps.length === 0}
        <p class="px-4 py-6 rounded-2xl bg-surface-container-high/30 text-center text-xs text-on-surface-variant/70">
          {m.wf_no_steps()}
        </p>
      {/if}

      {#each recipe.steps as step, index (step.id)}
        {@const movable = movableSteps(recipe.steps, index)}
        <StepCard
          {step}
          triggerType={recipe.trigger.type}
          {roles}
          {channels}
          problems={problemsByStep.get(step.id) ?? []}
          canMoveUp={movable.up}
          canMoveDown={movable.down}
          onChange={replaceRoot}
          onRemove={removeRoot}
          onMove={moveRoot}
          onAddInside={(branch, parentId) => (adding = { parentId, branch })}
        />

        {#if step.kind === 'condition'}
          <button
            type="button"
            onclick={() => addTest(step as ConditionStep)}
            class="ml-4 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-on-surface-variant/70 hover:text-primary transition-colors"
          >
            <Papicon icon="Plus" size={10} />
            {m.wf_add_test()}
          </button>
        {/if}
      {/each}

      {#if acceptsMoreSteps(recipe.steps)}
        <button
          type="button"
          onclick={() => (adding = { parentId: null, branch: 'then' })}
          class="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-xs font-semibold text-on-surface-variant/70 border border-dashed border-outline-variant/30 hover:text-on-surface hover:border-primary/40 hover:bg-surface-container-high/40 transition-all"
        >
          <Papicon icon="Plus" size={13} />
          {m.wf_add_step()}
        </button>
      {:else}
        <p class="flex items-start gap-2 px-4 py-3 rounded-2xl text-[11px] text-on-surface-variant/70 border border-dashed border-outline-variant/20">
          <Papicon icon="Info" size={12} class="mt-0.5 shrink-0" />
          <span>{m.wf_condition_closes()}</span>
        </p>
      {/if}
    </section>
  {/if}
</div>

{#if adding}
  <StepPicker
    triggerType={recipe.trigger.type}
    onPick={add}
    onClose={() => (adding = null)}
  />
{/if}
