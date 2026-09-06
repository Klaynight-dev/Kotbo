<script lang="ts">
  /**
   * Tableau de la console admin.
   *
   * Prend en charge ce que chaque page reimplementait : en-tete collante, tri
   * au clic, etat vide, squelette de chargement et defilement horizontal
   * confine (le corps de page ne doit jamais deborder lateralement).
   *
   * Le tri est pilote par le parent via `sortKey` / `sortDir` bindables : c'est
   * lui qui connait le type reel des donnees et peut trier correctement dates,
   * nombres et chaines accentuees.
   */
  import type { Snippet } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import type { AdminTableColumn } from './types';


  let {
    columns,
    rows = [],
    loading = false,
    emptyTitle = 'Aucun résultat',
    emptyHint = '',
    emptyIcon = 'Search',
    sortKey = $bindable(''),
    sortDir = $bindable<'asc' | 'desc'>('asc'),
    skeletonRows = 6,
    row,
    footer,
  }: {
    columns: AdminTableColumn[];
    rows?: unknown[];
    loading?: boolean;
    emptyTitle?: string;
    emptyHint?: string;
    emptyIcon?: string;
    sortKey?: string;
    sortDir?: 'asc' | 'desc';
    skeletonRows?: number;
    row: Snippet<[unknown, number]>;
    footer?: Snippet;
  } = $props();

  const hideClasses: Record<string, string> = {
    sm: 'hidden sm:table-cell',
    md: 'hidden md:table-cell',
    lg: 'hidden lg:table-cell',
    xl: 'hidden xl:table-cell',
  };

  const alignClasses: Record<string, string> = {
    left: 'text-left',
    right: 'text-right',
    center: 'text-center',
  };

  function toggleSort(column: AdminTableColumn) {
    if (!column.sortKey) return;
    if (sortKey === column.sortKey) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = column.sortKey;
      sortDir = 'asc';
    }
  }
</script>

<div class="rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/70 overflow-hidden">
  <div class="overflow-x-auto">
    <table class="w-full min-w-max text-sm border-collapse">
      <thead>
        <tr class="border-b border-outline-variant/25 bg-surface-container-low/60">
          {#each columns as column (column.key)}
            <th
              scope="col"
              class="sticky top-0 z-10 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant whitespace-nowrap
                {alignClasses[column.align ?? 'left']} {column.width ?? ''} {column.hideBelow ? hideClasses[column.hideBelow] : ''}"
              aria-sort={column.sortKey && sortKey === column.sortKey
                ? (sortDir === 'asc' ? 'ascending' : 'descending')
                : 'none'}
            >
              {#if column.sortKey}
                <button
                  type="button"
                  onclick={() => toggleSort(column)}
                  class="inline-flex items-center gap-1 hover:text-on-surface transition-colors rounded focus-visible:outline-2 focus-visible:outline-primary
                    {column.align === 'right' ? 'flex-row-reverse' : ''}"
                >
                  {column.label}
                  <Papicon
                    icon={sortKey === column.sortKey ? (sortDir === 'asc' ? 'ArrowUp' : 'ArrowDown') : 'ChevronsUpDown'}
                    size={11}
                    class={sortKey === column.sortKey ? 'text-primary' : 'opacity-40'}
                  />
                </button>
              {:else}
                {column.label}
              {/if}
            </th>
          {/each}
        </tr>
      </thead>

      <tbody>
        {#if loading}
          {#each Array(skeletonRows) as _, index (index)}
            <tr class="border-b border-outline-variant/12">
              {#each columns as column (column.key)}
                <td class="px-4 py-3 {column.hideBelow ? hideClasses[column.hideBelow] : ''}">
                  <div class="h-4 rounded bg-on-surface/8 animate-pulse" style="width: {40 + ((index * 17 + column.key.length * 7) % 45)}%"></div>
                </td>
              {/each}
            </tr>
          {/each}
        {:else if rows.length === 0}
          <tr>
            <td colspan={columns.length} class="px-4 py-14">
              <div class="flex flex-col items-center gap-2 text-center">
                <div class="w-11 h-11 rounded-2xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant">
                  <Papicon icon={emptyIcon} size={20} />
                </div>
                <p class="text-sm font-semibold text-on-surface">{emptyTitle}</p>
                {#if emptyHint}
                  <p class="text-[13px] text-on-surface-variant max-w-sm">{emptyHint}</p>
                {/if}
              </div>
            </td>
          </tr>
        {:else}
          {#each rows as item, index (index)}
            {@render row(item, index)}
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if footer}
    <div class="px-4 py-3 border-t border-outline-variant/20 bg-surface-container-low/40">
      {@render footer()}
    </div>
  {/if}
</div>
