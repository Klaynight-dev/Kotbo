<script lang="ts">
  import type { Snippet } from 'svelte';

  const {
    label = '',
    description = '',
    labelFor = undefined,
    stacked = false,
    children,
  }: {
    label?: string;
    description?: string;
    labelFor?: string | undefined;
    /** true : le controle passe sous le libelle (selecteurs larges) */
    stacked?: boolean;
    children?: Snippet;
  } = $props();
</script>

<div class="settings-row {stacked ? 'settings-row--stacked' : ''}">
  <div class="settings-row__text">
    {#if labelFor}
      <label class="settings-row__label" for={labelFor}>{label}</label>
    {:else}
      <p class="settings-row__label">{label}</p>
    {/if}
    {#if description}
      <p class="settings-row__description">{description}</p>
    {/if}
  </div>
  <div class="settings-row__control">
    {@render children?.()}
  </div>
</div>

<style>
  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.875rem 1rem;
  }

  .settings-row--stacked {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .settings-row__text {
    min-width: 0;
  }

  .settings-row__label {
    display: block;
    margin: 0;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--on-surface);
  }

  .settings-row__description {
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: color-mix(in srgb, var(--on-surface-variant) 75%, transparent);
  }

  .settings-row__control {
    flex-shrink: 0;
  }

  .settings-row--stacked .settings-row__control {
    flex-shrink: 1;
  }

  @media (max-width: 640px) {
    .settings-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.625rem;
    }

    .settings-row__control {
      flex-shrink: 1;
    }
  }
</style>
