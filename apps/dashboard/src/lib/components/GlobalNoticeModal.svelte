<script lang="ts">
  import Papicon from './Papicon.svelte';
  import { portal } from '../actions/portal';
  import { globalNotice } from '../stores/globalNotice.svelte';

  function close() {
    globalNotice.close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (globalNotice.open && e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if globalNotice.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal
    class="global-notice-modal fixed inset-0 flex items-center justify-center p-4"
    onclick={close}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') close(); }}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="global-notice-title"
  >
    <div class="absolute inset-0 bg-black/40 animate-in fade-in duration-200"></div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="global-notice-modal__panel relative z-10 w-full max-w-md bg-surface-container border border-outline-variant/20 rounded-lg shadow-sm shadow-black/50 p-6 space-y-5 animate-in fade-in zoom-in-95 duration-200"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="flex items-start gap-4">
        <div class="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 bg-amber-500/10 border-amber-500/20">
          <Papicon icon="AlertTriangle" size={20} class="text-amber-400" />
        </div>
        <p id="global-notice-title" class="text-sm text-on-surface leading-relaxed pt-1.5">
          {globalNotice.message}
        </p>
      </div>

      <div class="flex items-center justify-end pt-1">
        <button
          type="button"
          onclick={close}
          class="px-5 py-2 rounded-xl text-sm font-semibold text-on-primary bg-primary hover:bg-primary/90 shadow-lg shadow-primary/20 transition-all active:scale-95"
        >
          Compris
        </button>
      </div>
    </div>
  </div>
{/if}
