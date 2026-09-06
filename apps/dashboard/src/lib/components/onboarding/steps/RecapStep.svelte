<script lang="ts">
  /**
   * « Voila votre serveur. »
   *
   * Le dernier ecran avant le paiement etait une liste de reglages effectues,
   * posee au-dessus d'une offre. C'est l'ordre inverse de ce qu'il faudrait :
   * on demande de payer au moment ou l'on vient de lire un recapitulatif
   * administratif, pas au moment ou l'on mesure ce qu'on a construit.
   *
   * Cet ecran ne demande rien. Il se monte piece par piece - chiffres qui
   * montent, lignes qui apparaissent - et il ne dit qu'une chose : tout ce que
   * vous lisez tourne deja. C'est le seul moment du parcours ou l'on s'attarde
   * volontairement, et c'est pour ca qu'il est plein ecran, sans question ni
   * colonne d'apercu.
   *
   * Il porte aussi la seconde chance : les pistes decochees y reapparaissent en
   * grise, avec ce qu'elles auraient apporte et un bouton pour les ajouter.
   * Quelqu'un qui a decoche « L'economie » a l'ecran 3 ne savait pas encore ce
   * que Kotbo faisait ; ici, il le sait.
   */
  import { onMount } from 'svelte';
  import { m } from '../../../i18n';
  import { authStore } from '../../../stores/auth.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    TRACKS,
    celebrateFinale,
    dormantModules,
    stepsOfTrack,
    type TrackKey,
  } from '../../../onboarding';
  import CountUp from '../CountUp.svelte';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  const built = $derived(onboardingData.built);

  /**
   * Ce qui reste eteint parce qu'on a ecarte le salon qui le porte.
   *
   * Ecarter une ligne au mappage est un choix legitime, et il a ete dit sur
   * l'ecran ou on l'a fait. Le repeter ici est la seule facon qu'il ne se perde
   * pas : entre l'ecran « L'equipe » et la fin du parcours, on a repondu a
   * quinze autres questions. Ce sont les seules lignes du recapitulatif qui
   * disent ce qui n'a pas ete fait, et c'est ce qui les rend utiles.
   */
  const dormant = $derived(
    onboardingData.template
      ? dormantModules(onboardingData.template.plan, wizard.mapping)
      : []
  );

  /**
   * Ce qui a ete regle, relu une derniere fois.
   *
   * Seules les etapes reellement validees y figurent : annoncer un reglement a
   * quelqu'un qui a saute l'ecran ferait mentir la seule page du parcours dont
   * on attend qu'elle dise vrai.
   */
  const lines = $derived([
    ...(built
      ? [{ icon: 'layout-grid', label: 'Structure et permissions', value: 'posées sur Discord' }]
      : []),
    ...(wizard.isDone('moderation')
      ? [{ icon: 'shield', label: 'Modération', value: 'active en continu' }]
      : []),
    ...(wizard.isDone('logs')
      ? [{ icon: 'scroll', label: m.onb_step_logs(), value: 'journaux conservés' }]
      : []),
    ...(wizard.isDone('greeting')
      ? [{ icon: 'door-open', label: 'Accueil des arrivants', value: 'activé' }]
      : []),
    ...(wizard.isDone('rules')
      ? [{ icon: 'book-open', label: 'Règlement', value: 'publié' }]
      : []),
    ...(wizard.isDone('tickets')
      ? [{ icon: 'inbox', label: 'Support', value: 'panneau en place' }]
      : []),
    ...(wizard.isDone('levels')
      ? [{ icon: 'crown', label: 'Progression', value: 'niveaux et récompenses' }]
      : []),
    ...(wizard.isDone('economy')
      ? [{ icon: 'coins', label: m.onb_step_economy(), value: wizard.currencyName ?? 'monnaie active' }]
      : []),
    ...(wizard.isDone('animation')
      ? [{ icon: 'target', label: m.onb_step_animation(), value: `${wizard.questKeys?.length ?? 0} quêtes` }]
      : []),
    ...(wizard.isDone('staff')
      ? [{ icon: 'users', label: m.onb_step_staff(), value: `${wizard.staffRoleIds?.length ?? 0} rôles` }]
      : []),
    ...(wizard.isDone('mcp')
      ? [{ icon: 'command', label: m.onb_step_mcp(), value: 'clé créée' }]
      : []),
  ]);

  /** Les pistes laissees de cote, avec ce qu'elles auraient apporte. */
  const missing = $derived(
    TRACKS.filter((track) => !wizard.tracks.includes(track.key))
  );

  /**
   * Un compte de reglages, pas un compte d'ecrans.
   *
   * Chaque element pose - un role, un salon, un module, un article de reglement,
   * un motif de ticket - vaut un reglage. C'est approximatif et c'est honnete :
   * le chiffre mesure ce qui a change sur le serveur, pas le nombre de clics.
   */
  const settingsCount = $derived(
    (built ? built.roles + built.categories + built.channels + built.modules : 0)
    + lines.length
    + (wizard.shopKeys?.length ?? 0)
    + (wizard.questKeys?.length ?? 0)
  );

  // Les chiffres montent d'eux-memes (`CountUp`) et les lignes se posent l'une
  // apres l'autre par leur delai d'animation : il ne reste ici qu'a lancer la
  // celebration, une fois, a l'arrivee sur l'ecran.
  onMount(celebrateFinale);

  function addTrack(key: TrackKey) {
    wizard.setTracks([...wizard.tracks, key], { gotoFirstOf: key });
  }
</script>

<WizardShell {onEditTracks}>
  <div class="text-center">
    <KotboMark size={54} halo class="mx-auto" />

    <h1 class="mt-6 text-3xl sm:text-[38px] leading-tight font-semibold tracking-tight text-on-surface font-headline">
      {m.onb_recap_title()}
    </h1>
    <p class="mt-3 text-[15.5px] text-on-surface-variant/70">
      {m.onb_recap_lead({ server: selectedGuild?.name ?? 'votre serveur' })}
    </p>
  </div>

  {#if built}
    <!-- Les chiffres, en grand : c'est ce qu'on vient de voir se poser. -->
    <div class="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-3">
      {#each [
        { value: built.roles, label: m.onb_recap_roles(), icon: 'shield' },
        { value: built.categories, label: m.onb_recap_categories(), icon: 'folder' },
        { value: built.channels, label: m.onb_recap_channels(), icon: 'message-circle' },
        { value: built.modules, label: m.onb_recap_modules(), icon: 'toggle-right' },
      ] as tile (tile.label)}
        <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 p-4 text-center">
          <span class="inline-flex w-8 h-8 rounded-lg bg-primary/10 text-primary items-center justify-center mb-2">
            <Papicon icon={tile.icon} size={15} />
          </span>
          <p class="text-[26px] font-semibold leading-none text-on-surface">
            <CountUp value={tile.value} />
          </p>
          <p class="mt-1.5 text-[12px] text-on-surface-variant/55">{tile.label}</p>
        </div>
      {/each}
    </div>
  {/if}

  {#if lines.length}
    <div class="mt-4 rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/40 divide-y divide-outline-variant/20">
      {#each lines as line, index (line.label)}
        <div
          class="row flex items-center gap-3 px-4 py-2.5"
          style="animation-delay: {700 + index * 70}ms"
        >
          <span class="w-6 h-6 shrink-0 rounded-md bg-primary/10 text-primary flex items-center justify-center">
            <Papicon icon={line.icon} size={12} />
          </span>
          <span class="text-[13.5px] font-medium text-on-surface flex-1 min-w-0 truncate">{line.label}</span>
          <span class="text-[12.5px] text-on-surface-variant/55 shrink-0">{line.value}</span>
          <Papicon icon="check" size={13} class="shrink-0 text-emerald-500" />
        </div>
      {/each}
    </div>
  {/if}

  <p class="mt-5 text-center text-[13.5px] text-on-surface-variant/55">
    {m.onb_recap_settings({ count: settingsCount, minutes: wizard.elapsedMinutes })}
  </p>

  {#if dormant.length}
    <section class="mt-10">
      <h2 class="text-[13px] font-semibold text-on-surface">Laissé de côté</h2>
      <p class="mt-1 text-[12.5px] text-on-surface-variant/50">
        Vous avez écarté le salon qui les porte. Rien n'est perdu : chacun s'allume depuis
        sa page du tableau de bord, le jour où vous lui donnez un salon.
      </p>

      <div class="mt-3 grid gap-2.5 sm:grid-cols-2">
        {#each dormant as entry (entry.key)}
          <div class="flex items-start gap-3 rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/25 p-3.5">
            <span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container text-on-surface-variant/40 flex items-center justify-center">
              <Papicon icon="power" size={15} />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-[13.5px] font-semibold text-on-surface-variant/75">{entry.name}</p>
              <p class="mt-0.5 text-[12.5px] text-on-surface-variant/50 leading-relaxed">
                {entry.because} n'a pas été mis en place.
              </p>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if missing.length}
    <!-- La seconde chance. Quelqu'un qui a decoche « L'economie » a l'ecran 3
         ne savait pas encore ce que Kotbo faisait ; ici, il le sait. -->
    <section class="mt-10">
      <h2 class="text-[13px] font-semibold text-on-surface">{m.onb_recap_missing_title()}</h2>
      <p class="mt-1 text-[12.5px] text-on-surface-variant/50">{m.onb_recap_missing_hint()}</p>

      <div class="mt-3 grid gap-2.5 sm:grid-cols-2">
        {#each missing as track (track.key)}
          <div class="flex items-start gap-3 rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/25 p-3.5">
            <span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container text-on-surface-variant/45 flex items-center justify-center">
              <Papicon icon={track.icon} size={15} />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-[13.5px] font-semibold text-on-surface-variant/75">{track.label()}</p>
              <p class="mt-0.5 text-[12.5px] text-on-surface-variant/50 leading-relaxed">{track.outcome()}</p>
            </div>
            <button
              type="button"
              onclick={() => addTrack(track.key)}
              class="shrink-0 self-center inline-flex items-center gap-1 rounded-lg border border-primary/35 px-2.5 py-1.5
                     text-[12px] font-semibold text-primary hover:bg-primary/10 transition-colors"
            >
              <Papicon icon="plus" size={11} />
              {m.onb_recap_add()}
              <span class="text-on-surface-variant/40 font-medium">
                · {m.onb_tracks_screens({ count: stepsOfTrack(track.key).length })}
              </span>
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      onclick={() => wizard.complete('recap')}
      class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
             hover:brightness-110 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {m.onb_recap_continue()}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>

<style>
  .row {
    animation: appear 320ms ease-out both;
  }

  @keyframes appear {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .row { animation: none; }
  }
</style>
