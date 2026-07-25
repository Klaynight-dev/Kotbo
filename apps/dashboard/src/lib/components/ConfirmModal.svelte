<script lang="ts">
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';

  interface Props {
    open?: boolean;
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
    requireInput?: string; // if set, user must type this to confirm
    loading?: boolean;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
  }

  let {
    open = $bindable(false),
    title = m.d7_confirm_required(),
    description = '',
    confirmLabel = m.d7_confirm(),
    cancelLabel = m.d7_cancel(),
    variant = 'default',
    requireInput = '',
    loading = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  let inputValue = $state('');
  let executing = $state(false);

  const variantConfig = $derived(() => {
    switch (variant) {
      case 'danger':  return { icon: 'AlertTriangle', iconBg: 'bg-red-500/10 border-red-500/20', iconColor: 'text-red-400', btnClass: 'bg-red-500 hover:bg-red-600 shadow-red-500/20' };
      case 'warning': return { icon: 'AlertTriangle', iconBg: 'bg-amber-500/10 border-amber-500/20', iconColor: 'text-amber-400', btnClass: 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20' };
      default:        return { icon: 'Info', iconBg: 'bg-primary/10 border-primary/20', iconColor: 'text-primary', btnClass: 'bg-primary hover:bg-primary/90 shadow-primary/20' };
    }
  });

  const canConfirm = $derived(requireInput ? inputValue === requireInput : true);

  function handleCancel() {
    inputValue = '';
    open = false;
    onCancel?.();
  }

  async function handleConfirm() {
    if (!canConfirm || executing) return;
    executing = true;
    try {
      await onConfirm?.();
      open = false;
      inputValue = '';
    } finally {
      executing = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') handleCancel();
    if (e.key === 'Enter' && canConfirm && !executing) handleConfirm();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    onclick={handleCancel}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCancel(); }}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="confirm-modal-title"
  >
    <div class="absolute inset-0 bg-black/40 animate-in fade-in duration-200"></div>

    <!-- Modal -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="relative z-10 w-full max-w-md bg-surface-container border border-outline-variant/20 rounded-lg shadow-sm shadow-black/50 p-6 space-y-5 animate-in fade-in zoom-in-95 duration-200"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <!-- Icon + Title -->
      <div class="flex items-start gap-4">
        <div class="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 {variantConfig().iconBg}">
          <Papicon icon={variantConfig().icon} size={20} class={variantConfig().iconColor} />
        </div>
        <div>
          <h3 id="confirm-modal-title" class="font-semibold text-on-surface text-base">{title}</h3>
          {#if description}
            <p class="text-sm text-on-surface-variant/60 mt-1 leading-relaxed">{description}</p>
          {/if}
        </div>
      </div>

      <!-- Require input -->
      {#if requireInput}
        <div class="space-y-1.5">
          <p class="text-xs text-on-surface-variant/50 font-medium">
            {m.d7_type_to_confirm_pre()} <span class="font-mono font-semibold text-on-surface">{requireInput}</span> {m.d7_type_to_confirm_post()}
          </p>
          <input
            type="text"
            bind:value={inputValue}
            placeholder={requireInput}
            autocomplete="off"
            class="w-full bg-on-surface/5 border border-outline-variant/15 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder-on-surface-variant/30 focus:outline-none focus:border-red-500/40 font-mono transition-all"
          />
        </div>
      {/if}

      <!-- Buttons -->
      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          onclick={handleCancel}
          class="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-on-surface/8 border border-outline-variant/10 transition-all"
        >
          {cancelLabel}
        </button>
        <button
          onclick={handleConfirm}
          disabled={!canConfirm || executing || loading}
          class="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white transition-all shadow-lg hover: active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100 {variantConfig().btnClass}"
        >
          {#if executing || loading}
            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
          {/if}
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
