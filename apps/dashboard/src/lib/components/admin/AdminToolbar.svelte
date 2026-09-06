<script lang="ts">
  /**
   * Barre de recherche + filtres d'une vue de liste admin.
   *
   * Chaque page reecrivait son champ de recherche et ses puces de filtre avec
   * des tailles et des etats actifs differents ; le composant fixe le
   * comportement (raccourci `/`, bouton d'effacement, compteur de resultats).
   */
  import type { Snippet } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import type { AdminFilterOption } from './types';

  let {
    search = $bindable(''),
    placeholder = 'Rechercher…',
    filters = [],
    activeFilter = $bindable(''),
    resultCount = null,
    resultLabel = 'résultat',
    actions,
  }: {
    search?: string;
    placeholder?: string;
    filters?: AdminFilterOption[];
    activeFilter?: string;
    resultCount?: number | null;
    resultLabel?: string;
    actions?: Snippet;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);

  // `/` focalise la recherche, comme dans la plupart des consoles techniques.
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    event.preventDefault();
    input?.focus();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative flex-1 min-w-56">
      <Papicon
        icon="Search"
        size={15}
        class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none"
      />
      <input
        bind:this={input}
        bind:value={search}
        type="search"
        {placeholder}
        class="w-full h-10 pl-9 pr-9 rounded-xl bg-surface-container-low/70 border border-outline-variant/25 text-sm text-on-surface
          placeholder:text-on-surface-variant focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15 transition"
      />
      {#if search}
        <button
          type="button"
          onclick={() => (search = '')}
          aria-label="Effacer la recherche"
          class="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-on-surface/8 hover:text-on-surface transition"
        >
          <Papicon icon="X" size={13} />
        </button>
      {/if}
    </div>

    {#if actions}
      <div class="flex items-center gap-2">{@render actions()}</div>
    {/if}
  </div>

  {#if filters.length > 0}
    <div class="flex flex-wrap items-center gap-1.5">
      {#each filters as filter (filter.value)}
        <button
          type="button"
          onclick={() => (activeFilter = filter.value)}
          aria-pressed={activeFilter === filter.value}
          class="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary
            {activeFilter === filter.value
              ? 'bg-primary/12 text-primary border border-primary/30'
              : 'bg-on-surface/5 text-on-surface-variant border border-transparent hover:bg-on-surface/8 hover:text-on-surface'}"
        >
          {filter.label}
          {#if typeof filter.count === 'number'}
            <span class="tabular-nums text-[11px] font-semibold px-1.5 py-0.5 rounded {activeFilter === filter.value ? 'bg-primary/15' : 'bg-on-surface/8'}">
              {filter.count}
            </span>
          {/if}
        </button>
      {/each}

      {#if resultCount !== null}
        <span class="ml-auto text-[12px] text-on-surface-variant tabular-nums">
          {resultCount} {resultLabel}{resultCount > 1 ? 's' : ''}
        </span>
      {/if}
    </div>
  {/if}
</div>
