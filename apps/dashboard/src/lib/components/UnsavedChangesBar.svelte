<script lang="ts">
  import { unsavedChanges } from '../stores/unsavedChanges.svelte';
  import { m } from '../i18n';

  // Whether we're animating the bar in
  let visible = $derived(unsavedChanges.isDirty);
</script>

{#if visible}
  <!-- Backdrop blur overlay at bottom, like Discord's settings save bar -->
  <div
    class="unsaved-bar"
    role="alertdialog"
    aria-label={m.d4_unsaved_title()}
    aria-live="polite"
  >
    <div class="unsaved-bar__inner">
      <!-- Left: icon + message -->
      <div class="unsaved-bar__message">
        <div class="unsaved-bar__icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div>
          <p class="unsaved-bar__title">{m.d4_unsaved_title()}</p>
          {#if unsavedChanges.pageLabel}
            <p class="unsaved-bar__subtitle">{unsavedChanges.pageLabel}</p>
          {/if}
        </div>
      </div>

      <!-- Right: actions -->
      <div class="unsaved-bar__actions">
        <button
          id="unsaved-reset-btn"
          type="button"
          onclick={() => unsavedChanges.reset()}
          disabled={unsavedChanges.saving}
          class="unsaved-bar__btn unsaved-bar__btn--reset"
        >
          {m.d4_reset()}
        </button>
        <button
          id="unsaved-save-btn"
          type="button"
          onclick={() => unsavedChanges.save()}
          disabled={unsavedChanges.saving}
          class="unsaved-bar__btn unsaved-bar__btn--save"
        >
          {#if unsavedChanges.saving}
            <svg class="unsaved-bar__spinner" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-dasharray="40" stroke-dashoffset="10"/>
            </svg>
            {m.d4_saving()}
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            {m.d4_save()}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .unsaved-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 200;
    padding: 0 1rem 1rem;
    pointer-events: none;
    animation: slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .unsaved-bar__inner {
    max-width: 860px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: var(--surface-container-highest);
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    pointer-events: all;
  }

  .unsaved-bar__message {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .unsaved-bar__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary);
    flex-shrink: 0;
  }

  .unsaved-bar__title {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--on-surface);
    margin: 0;
    line-height: 1.2;
  }

  .unsaved-bar__subtitle {
    font-size: 0.6875rem;
    color: color-mix(in srgb, var(--on-surface-variant) 70%, transparent);
    margin: 0.125rem 0 0;
    line-height: 1.2;
  }

  .unsaved-bar__actions {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-shrink: 0;
  }

  .unsaved-bar__btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    border-radius: 0.75rem;
    font-size: 0.8125rem;
    font-weight: 700;
    cursor: pointer;
    border: none;
    transition: all 0.15s ease;
    letter-spacing: 0.01em;
  }

  .unsaved-bar__btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .unsaved-bar__btn--reset {
    background: color-mix(in srgb, var(--on-surface) 8%, transparent);
    color: var(--on-surface-variant);
    border: 1px solid color-mix(in srgb, var(--outline-variant) 40%, transparent);
  }

  .unsaved-bar__btn--reset:not(:disabled):hover {
    background: color-mix(in srgb, var(--on-surface) 14%, transparent);
    color: var(--on-surface);
    transform: scale(1.02);
  }

  .unsaved-bar__btn--save {
    background: var(--primary);
    color: var(--on-primary);
  }

  .unsaved-bar__btn--save:not(:disabled):hover {
    opacity: 0.9;
  }

  .unsaved-bar__spinner {
    width: 14px;
    height: 14px;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* On mobile, stack vertically */
  @media (max-width: 600px) {
    .unsaved-bar__inner {
      flex-direction: column;
      align-items: stretch;
    }

    .unsaved-bar__actions {
      justify-content: flex-end;
    }
  }
</style>
