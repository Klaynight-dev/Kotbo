<script lang="ts">
  import { portal } from '../actions/portal';
  import Papicon from './Papicon.svelte';

  let {
    open = $bindable(false),
    onClose = () => {},
    title = '',
    subtitle = '',
    size = 'md',
    showCloseButton = true,
    closeOnBackdropClick = true,
    closeOnEscape = true,
    children,
    footer
  } = $props<{
    open?: boolean;
    onClose?: (e?: any) => void;
    title?: string;
    subtitle?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'screen';
    showCloseButton?: boolean;
    closeOnBackdropClick?: boolean;
    closeOnEscape?: boolean;
    children?: any;
    /** Barre d'actions fixe sous le contenu défilant (ex : Annuler / Enregistrer). */
    footer?: any;
  }>();

  const sizeClasses: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-6xl',
    screen: 'max-w-none'
  };

  const isScreen = $derived(size === 'screen');

  function handleBackdropClick(e: MouseEvent) {
    if (closeOnBackdropClick && e.currentTarget === e.target) {
      open = false;
      onClose(e);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (closeOnEscape && e.key === 'Escape') {
      open = false;
      onClose(e);
    }
  }

  $effect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  });
</script>

{#if open}
  <div
    use:portal
    class="app-modal fixed inset-0 flex items-center justify-center {isScreen ? 'p-0 sm:p-4' : 'p-4'}"
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-title"
  >
    <!-- Backdrop -->
    <div
      class="absolute inset-0 bg-black/40"
      onclick={handleBackdropClick}
      onkeydown={handleKeydown}
      onkeypress={(e) => e.key === 'Enter' && handleBackdropClick(e as any)}
      tabindex="-1"
      role="button"
      aria-label="Fermer la fenêtre"
    ></div>

    <!-- Modal Panel -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="app-modal__panel relative w-full {sizeClasses[size]} bg-surface-container-lowest shadow-lg overflow-hidden border border-outline-variant flex flex-col animate-in fade-in slide-up duration-150 {isScreen
        ? 'h-full rounded-none sm:h-[calc(100vh-2rem)] sm:rounded-xl'
        : 'rounded-xl max-h-[90vh]'}"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      {#if title || showCloseButton}
        <header class="app-modal__header px-5 py-4 border-b border-outline-variant flex items-center justify-between">
          <div class="min-w-0 flex-1">
            {#if title}
              <h3 id="modal-title" class="text-base font-semibold text-on-surface">{title}</h3>
            {/if}
            {#if subtitle}
              <p class="text-sm text-on-surface-variant mt-0.5">{subtitle}</p>
            {/if}
          </div>
          {#if showCloseButton}
            <button
              type="button"
              onclick={(e) => { open = false; onClose(e); }}
              class="ml-3 h-8 w-8 flex items-center justify-center rounded-md bg-surface-container hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-on-surface"
              aria-label="Fermer"
            >
              <Papicon icon="x" size={14} />
            </button>
          {/if}
        </header>
      {/if}

      <!-- Content - the modal's single scroll container. Children must not nest
           another overflow-y:auto full-height wrapper here, or two scrollbars appear. -->
      <div class="app-modal__body flex-1 min-h-0 overflow-y-auto">
        {@render children?.()}
      </div>

      <!-- Footer - stays put while the body scrolls, so actions on long forms are always reachable. -->
      {#if footer}
        <footer class="app-modal__footer px-5 py-3.5 border-t border-outline-variant bg-surface-container-lowest shrink-0">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
