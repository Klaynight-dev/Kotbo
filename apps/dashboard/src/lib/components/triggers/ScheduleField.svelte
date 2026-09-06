<script lang="ts">
  import { m } from '../../i18n';
  import { timezoneStore } from '../../stores/timezone.svelte';
  import {
    DEFAULT_SCHEDULE,
    cronToSchedule,
    isValidCron,
    scheduleToCron,
    type ScheduleFrequency,
    type SchedulePreset,
  } from '@kotbo/shared';

  /**
   * Réglage d'une planification.
   *
   * L'éditeur en phrases ne pose jamais de champ libre dont il faudrait
   * deviner le format : la fréquence et l'heure se choisissent dans des
   * listes, et le motif cron en est déduit. La saisie brute reste accessible
   * pour les motifs que ces quatre fréquences ne savent pas dire, et c'est
   * aussi le mode de repli quand un motif enregistré ailleurs est relu.
   */
  const { value, onChange }: { value: string; onChange: (cron: string) => void } = $props();

  const preset = $derived(cronToSchedule(value));
  /** Un motif que les fréquences ne savent pas exprimer force la saisie brute. */
  let rawMode = $state(false);
  const showRaw = $derived(rawMode || (value.trim() !== '' && preset === null));

  const current = $derived<SchedulePreset>(preset ?? DEFAULT_SCHEDULE);

  const FREQUENCIES: { value: ScheduleFrequency; label: () => string }[] = [
    { value: 'hourly', label: m.wf_freq_hourly },
    { value: 'daily', label: m.wf_freq_daily },
    { value: 'weekly', label: m.wf_freq_weekly },
    { value: 'monthly', label: m.wf_freq_monthly },
  ];

  const WEEKDAYS: (() => string)[] = [
    m.wf_day_sunday, m.wf_day_monday, m.wf_day_tuesday, m.wf_day_wednesday,
    m.wf_day_thursday, m.wf_day_friday, m.wf_day_saturday,
  ];

  function patch(change: Partial<SchedulePreset>): void {
    onChange(scheduleToCron({ ...current, ...change }));
  }

  /** `HH:MM` pour l'`input[type=time]`, qui n'accepte rien d'autre. */
  const timeValue = $derived(
    `${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}`,
  );

  function setTime(raw: string): void {
    const [hour, minute] = raw.split(':').map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return;
    patch({ hour, minute });
  }

  const control = 'px-2.5 py-1 rounded-lg text-xs bg-surface-container-highest border border-outline-variant/25 text-on-surface focus:outline-none focus:border-primary/60';

  // Le motif est evalue par le bot dans le fuseau du serveur, pas dans celui du
  // navigateur : sans ce rappel, une heure choisie ici depuis un autre fuseau
  // se lit comme locale alors qu'elle ne l'est pas.
  $effect(() => {
    void timezoneStore.ensureLoaded();
  });
</script>

<div class="flex flex-wrap items-center gap-2">
  {#if showRaw}
    <input
      type="text"
      {value}
      oninput={(event) => onChange(event.currentTarget.value)}
      placeholder="0 9 * * *"
      class="{control} w-44 font-mono {value.trim() && !isValidCron(value) ? 'border-amber-500/60' : ''}"
    />
    <span class="text-[11px] text-on-surface-variant/70">
      {value.trim() && !isValidCron(value) ? m.wf_schedule_invalid() : m.wf_schedule_raw_hint()}
    </span>
    {#if preset !== null}
      <button
        type="button"
        onclick={() => (rawMode = false)}
        class="text-[11px] font-medium text-primary hover:underline"
      >{m.wf_schedule_simple()}</button>
    {/if}
  {:else}
    <select
      value={current.frequency}
      onchange={(event) => patch({ frequency: event.currentTarget.value as ScheduleFrequency })}
      class="{control} cursor-pointer"
    >
      {#each FREQUENCIES as frequency (frequency.value)}
        <option value={frequency.value}>{frequency.label()}</option>
      {/each}
    </select>

    {#if current.frequency === 'weekly'}
      <select
        value={current.weekday}
        onchange={(event) => patch({ weekday: Number(event.currentTarget.value) })}
        class="{control} cursor-pointer"
      >
        {#each WEEKDAYS as day, index (index)}
          <option value={index}>{day()}</option>
        {/each}
      </select>
    {/if}

    {#if current.frequency === 'monthly'}
      <select
        value={current.day}
        onchange={(event) => patch({ day: Number(event.currentTarget.value) })}
        class="{control} cursor-pointer"
      >
        {#each Array.from({ length: 31 }, (_, index) => index + 1) as day (day)}
          <option value={day}>{m.wf_schedule_day({ n: day })}</option>
        {/each}
      </select>
    {/if}

    {#if current.frequency === 'hourly'}
      <span class="text-xs text-on-surface-variant">{m.wf_schedule_at_minute()}</span>
      <input
        type="number"
        min="0"
        max="59"
        value={current.minute}
        oninput={(event) => patch({ minute: Number(event.currentTarget.value) })}
        class="{control} w-16"
      />
    {:else}
      <span class="text-xs text-on-surface-variant">{m.wf_schedule_at()}</span>
      <input
        type="time"
        value={timeValue}
        oninput={(event) => setTime(event.currentTarget.value)}
        class="{control} w-28"
      />
    {/if}

    <button
      type="button"
      onclick={() => (rawMode = true)}
      class="text-[11px] font-medium text-on-surface-variant/70 hover:text-primary transition-colors"
    >{m.wf_schedule_advanced()}</button>
  {/if}

  {#if timezoneStore.loaded}
    <span class="basis-full text-[11px] text-on-surface-variant/70">
      {m.wf_schedule_timezone({ zone: timezoneStore.timezone })}
    </span>
  {/if}
</div>
