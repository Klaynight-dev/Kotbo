<script lang="ts">
  /**
   * L'ecran ou l'on choisit ce qu'on va configurer.
   *
   * C'est le premier moment ou l'on voit l'etendue de ce que Kotbo sait faire,
   * et on la voit en la choisissant plutot qu'en la subissant. Cocher
   * « L'economie » n'engage a rien mais apprend que l'economie existe - ce
   * qu'un parcours qui l'aurait cachee derriere quinze ecrans obligatoires
   * n'aurait jamais transmis, parce qu'on n'y serait pas arrive.
   *
   * Trois familles plutot qu'une liste de onze : onze cases en colonne se
   * lisent comme une facture. Groupees, on y reconnait trois intentions - tenir
   * le serveur debout, lui donner une vie, garder la main dessus - et l'on
   * coche par intention.
   *
   * Le temps estime est affiche et se recalcule a chaque clic. C'est ce qui
   * transforme la longueur du parcours en une decision : douze minutes qu'on a
   * choisies ne sont pas douze minutes qu'on subit.
   */
  import { m } from '../../../i18n';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import {
    TRACKS,
    TRACK_GROUPS,
    defaultTracks,
    estimatedMinutes,
    stepsOfTrack,
    celebrateStep,
    type TrackKey,
  } from '../../../onboarding';
  import Papicon from '../../Papicon.svelte';
  import ToggleCard from '../ToggleCard.svelte';
  import WizardShell from '../WizardShell.svelte';

  const kind = $derived(wizard.kind ?? 'new');

  // Tant que rien n'a ete valide, ce sont les suggestions tirees de l'etat du
  // serveur : un serveur habite n'a pas les memes cases cochees qu'un serveur
  // cree ce matin.
  let picked = $state<TrackKey[] | null>(null);
  const selection = $derived(picked ?? wizard.tracks);

  function toggle(key: TrackKey) {
    const current = selection;
    picked = current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key];
    celebrateStep();
  }

  const minutes = $derived(estimatedMinutes(selection));
  const screens = $derived(
    selection.reduce((total, key) => total + stepsOfTrack(key).length, 0)
  );

  function confirm() {
    wizard.setTracks([...selection]);
    wizard.complete('tracks');
  }
</script>

<WizardShell
  title={m.onb_tracks_title()}
  lead={m.onb_tracks_lead()}
>
  <div class="space-y-8">
    {#each TRACK_GROUPS as group (group.key)}
      {@const tracks = TRACKS.filter((track) => track.group === group.key)}
      <section>
        <div class="mb-3 flex items-baseline gap-2.5">
          <h2 class="text-[13px] font-semibold text-on-surface">{group.label()}</h2>
          <p class="text-[12px] text-on-surface-variant/45 truncate">{group.hint()}</p>
        </div>

        <div class="grid gap-2.5 sm:grid-cols-2">
          {#each tracks as track (track.key)}
            {@const count = stepsOfTrack(track.key).length}
            <ToggleCard
              label={track.label()}
              pitch={track.pitch()}
              detail={track.outcome()}
              icon={track.icon}
              meta={m.onb_tracks_screens({ count })}
              selected={selection.includes(track.key)}
              onclick={() => toggle(track.key)}
            />
          {/each}
        </div>
      </section>
    {/each}

    <p class="text-[12.5px] text-on-surface-variant/50 leading-relaxed">
      {m.onb_tracks_group_hint()}
    </p>
  </div>

  {#snippet footer()}
    <!-- Deux raccourcis, pas trois : « tout » pour qui veut visiter, « l'essentiel »
         pour qui veut un serveur qui tourne ce soir. -->
    <button
      type="button"
      onclick={() => { picked = TRACKS.map((track) => track.key); celebrateStep(); }}
      class="text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
    >
      {m.onb_tracks_all()}
    </button>
    <button
      type="button"
      onclick={() => { picked = defaultTracks(kind); celebrateStep(); }}
      class="text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
    >
      {m.onb_tracks_essentials()}
    </button>

    <div class="hidden sm:flex flex-col items-end leading-tight mr-1">
      <span class="text-[12px] font-semibold tabular-nums text-on-surface">
        {m.onb_tracks_estimate({ minutes })}
      </span>
      <span class="text-[11px] text-on-surface-variant/40 tabular-nums">
        {m.onb_tracks_count({ count: selection.length, total: TRACKS.length })}
        {#if screens > 0}
          · {m.onb_tracks_screens({ count: screens })}
        {/if}
      </span>
    </div>

    <button
      type="button"
      onclick={confirm}
      class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
             hover:brightness-110 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      Continuer
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>

{#if selection.length === 0}
  <!-- Rien de coche est un choix legitime - on veut juste le bot - mais il
       merite d'etre dit avant, pas decouvert a l'ecran de paiement. -->
  <div class="fixed inset-x-0 bottom-20 flex justify-center pointer-events-none px-6">
    <p class="rounded-full bg-surface-container-high/95 backdrop-blur px-4 py-2 text-[12.5px] font-medium text-on-surface-variant/75 shadow-lg">
      {m.onb_tracks_none()}
    </p>
  </div>
{/if}
