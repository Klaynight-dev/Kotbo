<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import { ACTION_GROUP_LABELS, availableActions, type ActionGroup } from '@kotbo/shared';

  /**
   * Choix de l'étape à ajouter.
   *
   * Seules les actions réalisables avec le contexte du déclencheur sont
   * proposées : on ne peut pas donner un rôle si rien n'a désigné de membre.
   * Le tri d'options impossibles se fait donc avant le clic, pas après.
   */
  const {
    triggerType,
    onPick,
    onClose,
  }: {
    triggerType: string;
    onPick: (choice: { kind: 'action'; action: string } | { kind: 'condition' } | { kind: 'wait' }) => void;
    onClose: () => void;
  } = $props();

  let search = $state('');

  const actions = $derived(
    availableActions(triggerType).filter((action) => (
      !search.trim() || action.label.toLowerCase().includes(search.toLowerCase())
    )),
  );

  const groups = $derived(
    [...new Set(actions.map((action) => action.group))] as ActionGroup[],
  );
</script>

<div class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-24 bg-black/50 backdrop-blur-sm" role="presentation" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="w-full max-w-2xl max-h-[70vh] overflow-y-auto rounded-3xl bg-surface-container border border-outline-variant/20 shadow-2xl"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="sticky top-0 p-4 bg-surface-container border-b border-outline-variant/15 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-on-surface">{m.wf_step_picker_title()}</h3>
        <button type="button" onclick={onClose} class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface" aria-label={m.wf_close()}>
          <Papicon icon="Cross" size={14} />
        </button>
      </div>
      <input
        type="text"
        bind:value={search}
        placeholder={m.wf_search_action()}
        class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-sm text-on-surface focus:outline-none focus:border-primary/50"
      />
    </div>

    <div class="p-4 space-y-5">
      {#each groups as group (group)}
        <section class="space-y-2">
          <h4 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
            {ACTION_GROUP_LABELS[group]}
          </h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {#each actions.filter((action) => action.group === group) as action (action.type)}
              <button
                type="button"
                onclick={() => onPick({ kind: 'action', action: action.type })}
                class="flex items-center gap-2.5 p-3 rounded-2xl text-left bg-surface-container-high/60 border border-outline-variant/15 hover:border-primary/40 hover:bg-surface-container-high transition-all"
              >
                <span class="p-2 rounded-xl bg-primary/10 text-primary shrink-0">
                  <Papicon icon={action.icon} size={14} />
                </span>
                <span class="text-xs font-medium text-on-surface">{action.label}</span>
              </button>
            {/each}
          </div>
        </section>
      {/each}

      <section class="space-y-2 pt-2 border-t border-outline-variant/15">
        <h4 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{m.wf_group_organize()}</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onclick={() => onPick({ kind: 'condition' })}
            class="flex items-center gap-2.5 p-3 rounded-2xl text-left bg-surface-container-high/60 border border-outline-variant/15 hover:border-amber-400/40 transition-all"
          >
            <span class="p-2 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300 shrink-0"><Papicon icon="GitBranch" size={14} /></span>
            <span class="min-w-0">
              <span class="block text-xs font-medium text-on-surface">{m.wf_add_condition()}</span>
              <span class="block text-[10px] text-on-surface-variant/70">{m.wf_add_condition_desc()}</span>
            </span>
          </button>
          <button
            type="button"
            onclick={() => onPick({ kind: 'wait' })}
            class="flex items-center gap-2.5 p-3 rounded-2xl text-left bg-surface-container-high/60 border border-outline-variant/15 hover:border-sky-400/40 transition-all"
          >
            <span class="p-2 rounded-xl bg-sky-500/10 text-sky-700 dark:text-sky-300 shrink-0"><Papicon icon="Clock" size={14} /></span>
            <span class="min-w-0">
              <span class="block text-xs font-medium text-on-surface">{m.wf_add_wait()}</span>
              <span class="block text-[10px] text-on-surface-variant/70">{m.wf_add_wait_desc()}</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  </div>
</div>
