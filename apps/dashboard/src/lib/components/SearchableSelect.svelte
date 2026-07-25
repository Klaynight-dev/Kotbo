<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { m } from '../i18n';

  export let id: string = '';
  export let value: string | null = null;
  export let options: Array<{ id: string; name: string }> = [];
  export let placeholder: string = '';
  export let className: string = '';
  export let clearable: boolean = true;
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher();

  let open = false;
  let query = '';
  let highlighted = 0;

  function normalize(text: string) {
    return (text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  $: filtered = (options || []).filter((o) => normalize(o.name).includes(normalize(query)) || (o.id ?? '').includes(query)).filter((o, i, arr) => arr.findIndex((x) => x.id === o.id) === i);
  $: if (filtered) highlighted = 0; // reset highlight when list changes

  function select(opt: { id: string; name: string }) {
    if (disabled) return;
    value = opt.id;
    query = opt.name;
    open = false;
    dispatch('change', { value });
    dispatch('input', { value });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open = true;
      highlighted = Math.min(highlighted + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && filtered[highlighted]) {
        select(filtered[highlighted]);
      }
    } else if (e.key === 'Escape') {
      open = false;
    }
  }

  function clear() {
    if (disabled) return;
    value = null;
    query = '';
    dispatch('change', { value });
    dispatch('input', { value });
  }

  // Synchronise le texte affiché dès que `value` ou `options` changent.
  // onMount ne suffit pas car les options peuvent arriver après le montage (chargement asynchrone).
  $: {
    if (value && options.length > 0) {
      const sel = options.find((o) => o.id === value);
      if (sel && query !== sel.name) query = sel.name;
    } else if (!value) {
      // Si la valeur est vidée de l'extérieur, on efface aussi le texte affiché
      if (query && !open) query = '';
    }
  }
</script>

<div class={className} style="position:relative">
  <input
    {id}
    type="text"
    placeholder={placeholder}
    bind:value={query}
    on:input={() => { if (!disabled) { open = true; highlighted = 0; } }}
    on:focus={() => !disabled && (open = true)}
    on:blur={() => setTimeout(() => (open = false), 150)}
    on:keydown={handleKeydown}
    class="w-full bg-surface-container-high text-on-surface text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
    autocomplete="off"
    disabled={disabled}
  />

  {#if clearable && query && !disabled}
    <button type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant" on:click|preventDefault={clear}>✕</button>
  {/if}

  {#if open}
    <div class="absolute left-0 right-0 mt-2 z-20 rounded-lg border border-outline-variant/20 bg-surface-container-high text-on-surface p-2 shadow-sm max-h-56 overflow-auto">
      {#if filtered.length === 0}
        <div class="px-4 py-2 text-xs text-on-surface-variant">{m.e6_searchable_select_no_results()}</div>
      {/if}
      {#each filtered as opt, i (opt.id)}
        <button
          type="button"
          class="w-full text-left text-on-surface px-4 py-2 rounded-xl hover:bg-surface-container-low transition-colors flex justify-between {i === highlighted ? 'ring-1 ring-inset ring-primary bg-surface-container-low' : ''}"
          on:click={() => select(opt)}
          on:mouseenter={() => (highlighted = i)}
        >
          <span class="font-bold">{opt.name}</span>
          <span class="text-xs text-on-surface-variant">{opt.id}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(.rounded-lg) { border-radius: 1rem; }
</style>
