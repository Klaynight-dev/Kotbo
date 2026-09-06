<script lang="ts">
  import { m } from '../i18n';
  import { listSupportedTimezones } from '@kotbo/contracts';
  import { timezoneStore } from '../stores/timezone.svelte';

  /**
   * Fuseau explicitement choisi pour cet item, `null` = repli sur le fuseau
   * du serveur. On evite `undefined` pour distinguer « pas encore charge » de
   * « choisi = defaut serveur ».
   */
  let { value = $bindable<string | null>(null) }: { value?: string | null } = $props();

  let picking = $state(false);

  const effective = $derived(value ?? timezoneStore.timezone);
  const zones = $derived(listSupportedTimezones(effective));

  function apply(zone: string) {
    // `__server__` reinitialise l'override : le libelle repasse a
    // « fuseau du serveur » et une modification ulterieure du reglage global
    // se repercute automatiquement sur la reunion.
    value = zone === '__server__' ? null : zone;
    picking = false;
  }
</script>

<div class="flex flex-wrap items-center gap-1.5 text-[11px] text-on-surface-variant/70">
  <span>{m.timezone_hint_prefix({ zone: effective })}</span>
  {#if !picking}
    <button
      type="button"
      onclick={() => (picking = true)}
      class="text-primary hover:underline cursor-pointer"
    >
      {value === null ? m.timezone_hint_choose() : m.timezone_hint_change()}
    </button>
    {#if value !== null}
      <button
        type="button"
        onclick={() => (value = null)}
        class="text-on-surface-variant/60 hover:text-on-surface-variant hover:underline cursor-pointer"
      >
        {m.timezone_hint_reset()}
      </button>
    {/if}
  {:else}
    <select
      value={value ?? '__server__'}
      onchange={(e) => apply((e.currentTarget as HTMLSelectElement).value)}
      class="bg-surface-container border border-outline-variant/20 rounded px-2 py-0.5 text-[11px] text-on-surface outline-none focus:border-primary"
    >
      <option value="__server__">{m.timezone_hint_server({ zone: timezoneStore.timezone })}</option>
      {#each zones as zone}
        <option value={zone}>{zone.replace(/_/g, ' ')}</option>
      {/each}
    </select>
    <button
      type="button"
      onclick={() => (picking = false)}
      class="text-on-surface-variant/60 hover:text-on-surface-variant hover:underline cursor-pointer"
    >
      {m.common_cancel()}
    </button>
  {/if}
</div>
