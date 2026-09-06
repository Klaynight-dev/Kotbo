<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';

  export let id: string = '';
  export let value: string | null = null;
  export let options: Array<{ id: string; name: string; color?: string | null; icon?: string }> = [];
  export let placeholder: string = '';
  export let className: string = '';
  export let clearable: boolean = true;
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher();

  let open = false;
  let query = '';
  let highlighted = 0;
  let wrapper: HTMLDivElement;

  /** Hauteur maximale de la liste, reprise de l'ancien `max-h-56`. */
  const MENU_MAX_HEIGHT = 224;
  const MENU_GAP = 8;

  function placeMenu(node: HTMLElement) {
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - MENU_GAP;
    const above = rect.top - MENU_GAP;
    // Vers le haut seulement si le dessous est vraiment trop court : un champ en
    // bas de page doit rester lisible sans faire defiler.
    const up = below < Math.min(MENU_MAX_HEIGHT, 180) && above > below;

    node.style.position = 'fixed';
    node.style.left = `${rect.left}px`;
    node.style.width = `${rect.width}px`;
    node.style.maxHeight = `${Math.max(120, Math.min(MENU_MAX_HEIGHT, up ? above : below))}px`;
    node.style.top = up ? 'auto' : `${rect.bottom + MENU_GAP}px`;
    node.style.bottom = up ? `${window.innerHeight - rect.top + MENU_GAP}px` : 'auto';
  }

  /**
   * La liste est deplacee dans <body> : positionnee dans le flux, le moindre
   * conteneur en `overflow-hidden` la rognait (cartes de section, modales,
   * tableaux defilants). En contrepartie elle ne suit plus son champ toute
   * seule, d'ou le repositionnement au defilement et au redimensionnement.
   */
  function dropdown(node: HTMLElement) {
    document.body.appendChild(node);
    const reposition = () => placeMenu(node);
    reposition();
    // `capture` : le defilement d'un conteneur interne ne remonte pas jusqu'a
    // window en phase de bouillonnement.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    return {
      destroy() {
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        node.remove();
      },
    };
  }

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

  $: selected = options.find((o) => o.id === value) ?? null;
  $: adorned = !!(selected && (selected.color || selected.icon));

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

<div class={className} style="position:relative" bind:this={wrapper}>
  {#if adorned}
    <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 flex items-center text-on-surface-variant">
      {#if selected?.icon}
        <Papicon icon={selected.icon} size={14} />
      {:else}
        <span class="h-2.5 w-2.5 rounded-full" style="background-color:{selected?.color}"></span>
      {/if}
    </span>
  {/if}

  <input
    {id}
    type="text"
    placeholder={placeholder}
    bind:value={query}
    on:input={() => { if (!disabled) { open = true; highlighted = 0; } }}
    on:focus={() => !disabled && (open = true)}
    on:blur={() => setTimeout(() => (open = false), 150)}
    on:keydown={handleKeydown}
    class="w-full bg-surface-container-high text-on-surface text-sm {adorned ? 'pl-9 pr-4' : 'px-4'} py-2.5 rounded-xl border border-outline-variant/10 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
    autocomplete="off"
    disabled={disabled}
  />

  {#if clearable && query && !disabled}
    <!-- Boîte carrée centrée sur l'icône : le glyphe texte précédent se calait sur
         sa ligne de base, ce qui le décentrait verticalement dans le champ. -->
    <button
      type="button"
      class="absolute right-3 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-md text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-highest/60 transition-colors"
      aria-label={m.common_clear()}
      title={m.common_clear()}
      on:click|preventDefault={clear}
    >
      <Papicon icon="Cross" size={12} />
    </button>
  {/if}

  {#if open}
    <div use:dropdown class="app-popover rounded-lg border border-outline-variant/20 bg-surface-container-high text-on-surface p-2 shadow-lg overflow-auto">
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
          <span class="flex items-center gap-2 min-w-0">
            {#if opt.icon}
              <Papicon icon={opt.icon} size={14} class="shrink-0 text-on-surface-variant" />
            {:else if opt.color}
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color:{opt.color}"></span>
            {/if}
            <span class="font-bold truncate">{opt.name}</span>
          </span>
          <span class="text-xs text-on-surface-variant">{opt.id}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(.rounded-lg) { border-radius: 1rem; }
</style>
