<script lang="ts">
  import { m } from '../i18n';
  export let values: string[] = [];
  export let options: Array<{ id: string; name: string }> = [];
  export let placeholder: string = m.d4_search_placeholder();
  export let disabled: boolean = false;
  export let accentClass: string = 'bg-primary/20 text-primary border-primary/40'; // active pill style
  export let id: string = '';

  let query = '';
  let open = false;
  let inputEl: HTMLInputElement;

  function normalize(text: string) {
    return (text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  $: filtered = options.filter(
    (o) => !values.includes(o.id) && normalize(o.name).includes(normalize(query))
  );

  $: selectedOptions = options.filter((o) => values.includes(o.id));

  function toggle(optId: string) {
    if (disabled) return;
    if (values.includes(optId)) {
      values = values.filter((id) => id !== optId);
    } else {
      values = [...values, optId];
    }
    query = '';
    inputEl?.focus();
  }

  function remove(optId: string) {
    if (disabled) return;
    values = values.filter((id) => id !== optId);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && !query && values.length > 0) {
      values = values.slice(0, -1);
    }
    if (e.key === 'Escape') open = false;
  }
</script>

<div class="relative" {id}>
  <!-- Tag input box -->
  <div
    role="combobox"
    tabindex="0"
    aria-expanded={open}
    aria-haspopup="listbox"
    aria-controls="{id}-listbox"
    class="flex flex-wrap gap-1.5 min-h-11 w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 cursor-text transition-all {open ? 'ring-2 ring-primary/30' : ''} {disabled ? 'opacity-50 cursor-not-allowed' : ''}"
    onclick={() => { if (!disabled) { open = true; inputEl?.focus(); } }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (!disabled) { open = true; inputEl?.focus(); } } }}
  >
    <!-- Selected pills -->
    {#each selectedOptions as opt (opt.id)}
      <span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-lg border {accentClass} transition-all">
        {opt.name}
        {#if !disabled}
          <button
            type="button"
            onclick={(e) => { e.stopPropagation(); remove(opt.id); }}
            class="ml-0.5 opacity-60 hover:opacity-100 transition-opacity cursor-pointer text-xs leading-none"
            aria-label={m.d4_remove_item({ name: opt.name })}
          >✕</button>
        {/if}
      </span>
    {/each}

    <!-- Search input -->
    <input
      bind:this={inputEl}
      type="text"
      {disabled}
      bind:value={query}
      {placeholder}
      class="flex-1 min-w-[120px] bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none disabled:cursor-not-allowed"
      oninput={() => { open = true; }}
      onfocus={() => { open = true; }}
      onblur={() => setTimeout(() => open = false, 180)}
      onkeydown={onKeydown}
      autocomplete="off"
    />
  </div>

  <!-- Dropdown -->
  {#if open && !disabled}
    <div
      id="{id}-listbox"
      role="listbox"
      class="absolute left-0 right-0 mt-2 z-30 rounded-lg border border-outline-variant/20 bg-surface-container-high shadow-sm max-h-52 overflow-y-auto"
    >
      {#if filtered.length === 0}
        <div class="px-4 py-3 text-xs text-on-surface-variant/50 italic">
          {query ? m.d4_no_result_for({ query }) : m.d4_all_selected()}
        </div>
      {:else}
        <div class="p-1.5 space-y-0.5">
          {#each filtered as opt (opt.id)}
            <button
              type="button"
              role="option"
              aria-selected={values.includes(opt.id)}
              onclick={() => toggle(opt.id)}
              class="w-full text-left px-3 py-2 rounded-xl hover:bg-surface-container-low/60 text-sm font-semibold text-on-surface transition-colors flex items-center justify-between gap-2 cursor-pointer"
            >
              <span>{opt.name}</span>
              <span class="text-[10px] text-on-surface-variant/40 font-mono">{opt.id.slice(0, 8)}…</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
