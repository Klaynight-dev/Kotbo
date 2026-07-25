<script lang="ts">
  import { m } from '../i18n';

  let {
    onClick,
    loading = false,
    label = m.d6_refresh(),
    iconOnly = false,
    ariaLabel = m.d6_refresh(),
    className = '',
    iconClass = 'text-sm'
  } = $props();

  import Papicon from './Papicon.svelte';

  function getBaseClass() {
    return iconOnly
      ? 'p-3 rounded-lg bg-surface-container-low border border-outline-variant/30 text-on-surface-variant hover:text-primary hover:border-primary transition-all active:scale-95'
      : 'flex items-center gap-2 bg-primary text-white px-5 py-2 rounded-xl text-sm font-semibold hover:opacity-90 transition-all shadow-md';
  }
</script>

<button
  type="button"
  onclick={onClick}
  aria-label={ariaLabel}
  class="{getBaseClass()} {className}"
>
  <Papicon 
    icon="refresh-cw" 
    size={14} 
    class="{iconClass} {loading ? 'animate-spin' : ''}" 
  />
  {#if !iconOnly}
    {label}
  {/if}
</button>
