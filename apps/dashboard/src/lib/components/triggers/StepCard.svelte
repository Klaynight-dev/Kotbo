<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import ValueField from './ValueField.svelte';
  import Self from './StepCard.svelte';
  import {
    acceptsMoreSteps,
    getAction,
    getCondition,
    movableSteps,
    type ActionStep,
    type ConditionStep,
    type ConditionTest,
    type RecipeStep,
    type ValueRef,
    type WaitStep,
  } from '@kotbo/shared';

  /**
   * Une étape rendue comme une phrase.
   *
   * Le libellé vient de la bibliothèque partagée sous forme de texte à trous ;
   * ce composant se contente de découper la phrase et de poser un contrôle dans
   * chaque trou. Ajouter une action au catalogue suffit donc à la rendre
   * éditable, sans toucher à l'interface.
   */
  const {
    step,
    triggerType,
    roles = [],
    channels = [],
    problems = [],
    depth = 0,
    canMoveUp = false,
    canMoveDown = false,
    onChange,
    onRemove,
    onMove,
    onAddInside,
  }: {
    step: RecipeStep;
    triggerType: string;
    roles?: { id: string; name: string }[];
    channels?: { id: string; name: string }[];
    problems?: string[];
    depth?: number;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onChange: (step: RecipeStep) => void;
    onRemove: (id: string) => void;
    onMove: (id: string, delta: number) => void;
    onAddInside: (branch: 'then' | 'otherwise', parentId: string) => void;
  } = $props();

  const action = $derived(step.kind === 'action' ? getAction((step as ActionStep).action) : undefined);

  /** Découpe une phrase à trous en morceaux de texte et en champs. */
  function parts(sentence: string): { text?: string; field?: string }[] {
    return sentence
      .split(/(\{[a-zA-Z0-9_]+\})/)
      .filter((piece) => piece !== '')
      .map((piece) => (piece.startsWith('{') ? { field: piece.slice(1, -1) } : { text: piece }));
  }

  function setValue(key: string, value: ValueRef): void {
    const current = step as ActionStep;
    onChange({ ...current, values: { ...current.values, [key]: value } });
  }

  function updateTest(id: string, patch: Partial<ConditionTest>): void {
    const current = step as ConditionStep;
    onChange({
      ...current,
      tests: current.tests.map((test) => (test.id === id ? { ...test, ...patch } : test)),
    });
  }

  function removeTest(id: string): void {
    const current = step as ConditionStep;
    onChange({ ...current, tests: current.tests.filter((test) => test.id !== id) });
  }

  function updateBranch(branch: 'then' | 'otherwise', steps: RecipeStep[]): void {
    onChange({ ...(step as ConditionStep), [branch]: steps });
  }

  function replaceInBranch(branch: 'then' | 'otherwise', updated: RecipeStep): void {
    const current = step as ConditionStep;
    updateBranch(branch, current[branch].map((child) => (child.id === updated.id ? updated : child)));
  }

  function removeFromBranch(branch: 'then' | 'otherwise', id: string): void {
    const current = step as ConditionStep;
    updateBranch(branch, current[branch].filter((child) => child.id !== id));
  }

  function moveInBranch(branch: 'then' | 'otherwise', id: string, delta: number): void {
    const current = step as ConditionStep;
    const list = [...current[branch]];
    const index = list.findIndex((child) => child.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(target, 0, moved);
    updateBranch(branch, list);
  }

  const ACCENT: Record<RecipeStep['kind'], string> = {
    action: 'border-l-primary/60',
    condition: 'border-l-amber-400/60',
    wait: 'border-l-sky-400/60',
  };
</script>

<article
  class="rounded-2xl bg-surface-container-high/60 border border-outline-variant/15 border-l-[3px] {ACCENT[step.kind]} {problems.length > 0 ? 'ring-1 ring-amber-500/30' : ''}"
>
  <div class="flex items-start gap-2 p-3">
    <div class="flex-1 min-w-0 space-y-2">
      {#if step.kind === 'action' && action}
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm text-on-surface">
          <Papicon icon={action.icon} size={14} class="text-primary shrink-0" />
          {#each parts(action.sentence) as piece}
            {#if piece.text}
              <span class="text-on-surface-variant/90">{piece.text}</span>
            {:else}
              {@const field = action.fields.find((f) => f.key === piece.field)}
              {#if field}
                <ValueField
                  kind={field.kind}
                  value={(step as ActionStep).values[field.key]}
                  {triggerType}
                  {roles}
                  {channels}
                  placeholder={field.placeholder}
                  optional={field.optional}
                  onChange={(value) => setValue(field.key, value)}
                />
              {/if}
            {/if}
          {/each}
        </div>

        {#each action.fields.filter((f) => f.option) as option (option.key)}
          <div class="flex items-center gap-2 text-xs text-on-surface-variant/70">
            <span>{option.label}</span>
            <ValueField
              kind={option.kind}
              value={(step as ActionStep).values[option.key]}
              {triggerType}
              onChange={(value) => setValue(option.key, value)}
            />
          </div>
        {/each}

      {:else if step.kind === 'wait'}
        <div class="flex flex-wrap items-center gap-2 text-sm text-on-surface">
          <Papicon icon="Clock" size={14} class="text-sky-700 dark:text-sky-300 shrink-0" />
          <span class="text-on-surface-variant/90">{m.wf_wait_prefix()}</span>
          <input
            type="number"
            min="1"
            value={(step as WaitStep).seconds}
            oninput={(event) => onChange({ ...(step as WaitStep), seconds: Math.max(1, Number(event.currentTarget.value)) })}
            class="w-24 px-2.5 py-1 rounded-lg text-xs bg-surface-container-highest border border-outline-variant/25 text-on-surface focus:outline-none focus:border-primary/60"
          />
          <span class="text-on-surface-variant/90">{m.wf_wait_suffix()}</span>
        </div>

      {:else if step.kind === 'condition'}
        <div class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <Papicon icon="GitBranch" size={14} class="text-amber-700 dark:text-amber-300 shrink-0" />
            <span class="text-sm font-semibold text-on-surface">{m.wf_if()}</span>
            {#if (step as ConditionStep).tests.length > 1}
              <select
                value={(step as ConditionStep).match}
                onchange={(event) => onChange({ ...(step as ConditionStep), match: event.currentTarget.value as 'all' | 'any' })}
                class="px-2 py-0.5 rounded-lg text-[11px] bg-surface-container-highest border border-outline-variant/25 text-on-surface-variant cursor-pointer focus:outline-none"
              >
                <option value="all">{m.wf_match_all()}</option>
                <option value="any">{m.wf_match_any()}</option>
              </select>
            {/if}
          </div>

          {#each (step as ConditionStep).tests as test (test.id)}
            {@const def = getCondition(test.condition)}
            {#if def}
              <div class="flex flex-wrap items-center gap-x-1.5 gap-y-2 pl-5 text-sm">
                {#each parts(test.negate ? def.negativeSentence : def.sentence) as piece}
                  {#if piece.text}
                    <span class="text-on-surface-variant/90">{piece.text}</span>
                  {:else if piece.field === 'operator' && def.operators}
                    <select
                      value={test.operator ?? def.defaultOperator}
                      onchange={(event) => updateTest(test.id, { operator: event.currentTarget.value })}
                      class="px-2 py-1 rounded-lg text-xs bg-surface-container-highest border border-outline-variant/25 text-on-surface cursor-pointer focus:outline-none"
                    >
                      {#each def.operators as operator (operator.value)}
                        <option value={operator.value}>{operator.label}</option>
                      {/each}
                    </select>
                  {:else if piece.field === 'value' && def.valueKind}
                    <ValueField
                      kind={def.valueKind}
                      value={test.value}
                      {triggerType}
                      {roles}
                      {channels}
                      onChange={(value) => updateTest(test.id, { value })}
                    />
                  {/if}
                {/each}

                <button
                  type="button"
                  onclick={() => updateTest(test.id, { negate: !test.negate })}
                  class="px-2 py-0.5 rounded-lg text-[10px] font-medium border transition-colors {test.negate
                    ? 'bg-red-500/15 border-red-500/30 text-red-700 dark:text-red-300'
                    : 'bg-surface-container-highest border-outline-variant/20 text-on-surface-variant/70 hover:text-on-surface'}"
                  title={m.wf_invert_title()}
                >{m.wf_invert()}</button>
                <button
                  type="button"
                  onclick={() => removeTest(test.id)}
                  class="p-1 rounded-lg text-on-surface-variant/70 hover:text-red-700 dark:hover:text-red-300 transition-colors"
                  aria-label={m.wf_remove_test()}
                ><Papicon icon="Trash" size={12} /></button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#each problems as problem}
        <p class="flex items-center gap-1.5 text-[11px] text-amber-700/90 dark:text-amber-300/90">
          <Papicon icon="Warning" size={11} />
          {problem}
        </p>
      {/each}
    </div>

    <div class="flex items-center gap-0.5 shrink-0">
      <button
        type="button"
        disabled={!canMoveUp}
        onclick={() => onMove(step.id, -1)}
        class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-highest disabled:opacity-20 disabled:hover:bg-transparent transition-colors"
        aria-label={m.wf_move_up()}
      ><Papicon icon="ChevronUp" size={13} /></button>
      <button
        type="button"
        disabled={!canMoveDown}
        onclick={() => onMove(step.id, 1)}
        class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-highest disabled:opacity-20 disabled:hover:bg-transparent transition-colors"
        aria-label={m.wf_move_down()}
      ><Papicon icon="ChevronDown" size={13} /></button>
      <button
        type="button"
        onclick={() => onRemove(step.id)}
        class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-500/10 transition-colors"
        aria-label={m.wf_remove_step()}
      ><Papicon icon="Trash" size={13} /></button>
    </div>
  </div>

  {#if step.kind === 'condition'}
    {#each [{ key: 'then' as const, label: m.wf_then() }, { key: 'otherwise' as const, label: m.wf_else() }] as branch (branch.key)}
      <div class="px-3 pb-3">
        <div class="pl-3 border-l border-dashed border-outline-variant/25 space-y-2">
          <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{branch.label}</p>

          {#each (step as ConditionStep)[branch.key] as child, index (child.id)}
            {@const movable = movableSteps((step as ConditionStep)[branch.key], index)}
            <Self
              step={child}
              {triggerType}
              {roles}
              {channels}
              depth={depth + 1}
              canMoveUp={movable.up}
              canMoveDown={movable.down}
              onChange={(updated) => replaceInBranch(branch.key, updated)}
              onRemove={(id) => removeFromBranch(branch.key, id)}
              onMove={(id, delta) => moveInBranch(branch.key, id, delta)}
              {onAddInside}
            />
          {/each}

          {#if acceptsMoreSteps((step as ConditionStep)[branch.key])}
            <button
              type="button"
              onclick={() => onAddInside(branch.key, step.id)}
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-medium text-on-surface-variant/70 border border-dashed border-outline-variant/25 hover:text-on-surface hover:border-primary/40 transition-colors"
            >
              <Papicon icon="Plus" size={11} />
              {m.wf_add_step()}
            </button>
          {:else}
            <p class="text-[10px] text-on-surface-variant/70 leading-snug">{m.wf_condition_closes()}</p>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</article>
