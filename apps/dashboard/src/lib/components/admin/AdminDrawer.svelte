<script lang="ts">
  /**
   * Panneau lateral de detail.
   *
   * Prefere a une modale pour les fiches consultees depuis un tableau : le
   * contexte (ligne selectionnee, filtres) reste visible a cote, et la fermeture
   * ne fait pas perdre la position de defilement de la liste.
   */
  import type { Snippet } from 'svelte';
  import { portal } from '../../actions/portal';
  import Papicon from '../Papicon.svelte';

  let {
    open = $bindable(false),
    title = '',
    subtitle = '',
    width = 'md',
    onClose = () => {},
    header,
    children,
    footer,
  }: {
    open?: boolean;
    title?: string;
    subtitle?: string;
    width?: 'sm' | 'md' | 'lg';
    onClose?: () => void;
    header?: Snippet;
    children?: Snippet;
    footer?: Snippet;
  } = $props();

  const widths: Record<string, string> = {
    sm: 'max-w-md',
    md: 'max-w-xl',
    lg: 'max-w-3xl',
  };

  function close() {
    open = false;
    onClose();
  }

  function onKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="fixed inset-0 z-50 flex justify-end" use:portal>
    <button
      type="button"
      aria-label="Fermer le panneau"
      onclick={close}
      class="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-in fade-in duration-150"
    ></button>

    <div
      class="relative h-full w-full {widths[width]} bg-surface-container-lowest border-l border-outline-variant/25 shadow-2xl
        flex flex-col animate-in slide-in-from-right duration-200"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header class="shrink-0 flex items-start justify-between gap-3 px-5 py-4 border-b border-outline-variant/20">
        <div class="min-w-0">
          {#if header}
            {@render header()}
          {:else}
            <h2 class="text-base font-semibold text-on-surface leading-tight truncate">{title}</h2>
            {#if subtitle}
              <p class="text-[13px] text-on-surface-variant mt-0.5 truncate">{subtitle}</p>
            {/if}
          {/if}
        </div>
        <button
          type="button"
          onclick={close}
          aria-label="Fermer"
          class="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-on-surface/8 hover:text-on-surface transition"
        >
          <Papicon icon="X" size={15} />
        </button>
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-5">
        {@render children?.()}
      </div>

      {#if footer}
        <footer class="shrink-0 px-5 py-4 border-t border-outline-variant/20 bg-surface-container-low/50">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
