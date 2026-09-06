<script lang="ts">
  /**
   * Le cadre du parcours de configuration.
   *
   * Il ne porte que ce qui vaut pour tous les ecrans : qui parle, ou l'on en
   * est, de quoi revenir, de quoi changer d'avis. Pas de barre laterale, pas
   * d'en-tete de tableau de bord, aucune page a atteindre - il n'y a rien a
   * naviguer tant que rien n'est monte.
   *
   * Trois dispositions, et c'est l'alternance qui fait le rythme :
   *
   * - `centered` pour les ecrans qui n'ont rien a montrer : une colonne, la
   *   question, les reponses. C'est la disposition d'origine.
   * - `split` pour le cas general : question a gauche, apercu Discord a droite,
   *   qui se met a jour pendant qu'on regle. Personne ne juge un message
   *   d'accueil a travers ses accolades, ni une couleur dans une pastille.
   * - `stage` pour les trois moments ou l'on ne repond a rien : le montage du
   *   serveur, la demonstration de moderation, le recapitulatif. Plein ecran,
   *   sans question, sans colonne - on regarde.
   *
   * Un parcours entierement en deux colonnes serait aussi plat qu'un parcours
   * entierement centre. Ces bascules sont la seule mise en scene du produit
   * avant qu'on le paie.
   *
   * La progression suit les ecrans reellement retenus, pas la liste complete :
   * une piste decochee disparait de la barre. On lit le parcours qu'on s'est
   * choisi, pas celui qu'on aurait pu prendre.
   */
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { m } from '../../i18n';
  import { authStore } from '../../stores/auth.svelte';
  import { wizard } from '../../stores/onboardingWizard.svelte';
  import { PHASES, phaseOf, stepDefinition, sound } from '../../onboarding';
  import Papicon from '../Papicon.svelte';
  import KotboMark from './KotboMark.svelte';

  const {
    title,
    lead,
    children,
    preview,
    footer,
    canGoBack = true,
    /** Remplace l'en-tete de titre par le contenu, pour les ecrans qui se rendent seuls. */
    bare = false,
    /**
     * Force la disposition, quand l'ecran en change en cours de route.
     *
     * La structure est en `split` tant qu'on regarde ce qui va etre pose, puis
     * bascule en `stage` pendant le montage : c'est le meme ecran, et c'est bien
     * deux moments differents.
     */
    layout,
    /** Ouvre l'ecran de selection des pistes. Masque sur cet ecran meme. */
    onEditTracks,
  }: {
    title?: string;
    lead?: string;
    children?: Snippet;
    preview?: Snippet;
    footer?: Snippet;
    canGoBack?: boolean;
    bare?: boolean;
    layout?: 'centered' | 'split' | 'stage';
    onEditTracks?: () => void;
  } = $props();

  const definition = $derived(stepDefinition(wizard.step));
  // Une disposition en deux colonnes sans rien a mettre a droite laisse une
  // colonne vide : c'est l'apercu fourni qui tranche, pas la seule declaration.
  const effective = $derived(
    layout ?? (definition.layout === 'split' && !preview ? 'centered' : definition.layout)
  );

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  const guildIconUrl = $derived(
    selectedGuild?.icon
      ? `https://cdn.discordapp.com/icons/${selectedGuild.id}/${selectedGuild.icon}.png?size=64`
      : null
  );

  const steps = $derived(wizard.steps);
  const index = $derived(wizard.index);
  const currentPhase = $derived(phaseOf(wizard.step));

  /**
   * Les phases a afficher, avec leurs ecrans retenus.
   *
   * Une phase dont toutes les pistes ont ete decochees n'a plus aucun ecran :
   * elle sort de la barre entierement, sinon on afficherait un intitule pour
   * une portion de parcours qui n'existe pas.
   */
  const visiblePhases = $derived(
    PHASES
      .map((phase) => ({
        key: phase.key,
        label: phase.label(),
        steps: steps.filter((step) => phaseOf(step) === phase.key),
      }))
      .filter((phase) => phase.steps.length > 0)
  );

  let soundOn = $state(sound.enabled);

  // La largeur du cadre suit la disposition : deux colonnes ont besoin de
  // place, une question seule se lit mieux serree.
  const frame = $derived(
    effective === 'centered' ? 'max-w-2xl' : effective === 'split' ? 'max-w-6xl' : 'max-w-5xl'
  );
</script>

<div class="min-h-screen bg-background text-on-background flex flex-col">
  <!-- ── En-tête : identité, serveur, sortie ──────────────────────────────── -->
  <header class="shrink-0 border-b border-outline-variant/25">
    <div class="mx-auto w-full {frame} px-6 py-3.5 flex items-center justify-between gap-4 transition-[max-width] duration-300">
      <div class="flex items-center gap-2.5 min-w-0">
        <KotboMark size={26} />
        <span class="font-semibold tracking-tight text-on-surface shrink-0">Kotbo</span>
        {#if selectedGuild}
          <Papicon icon="plus" size={11} class="shrink-0 text-on-surface-variant/30" />
          <span class="flex items-center gap-1.5 min-w-0">
            {#if guildIconUrl}
              <img src={guildIconUrl} alt="" class="w-5 h-5 rounded-md shrink-0" />
            {:else}
              <span class="w-5 h-5 rounded-md shrink-0 bg-surface-container text-on-surface-variant/60 text-[10px] font-bold flex items-center justify-center">
                {selectedGuild.name.slice(0, 1).toUpperCase()}
              </span>
            {/if}
            <span class="text-[13px] font-medium text-on-surface-variant/70 truncate">
              {selectedGuild.name}
            </span>
          </span>
        {/if}
      </div>

      <div class="shrink-0 flex items-center gap-3.5">
        {#if onEditTracks}
          <button
            type="button"
            onclick={onEditTracks}
            class="inline-flex items-center gap-1.5 text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
          >
            <Papicon icon="list-checks" size={13} />
            <span class="hidden md:inline">{m.onb_tracks_edit()}</span>
          </button>
        {/if}

        <!-- Le son est actif par defaut, et se coupe d'un clic. Le reglage est
             retenu par navigateur : personne n'a a le recouper a chaque visite. -->
        <button
          type="button"
          onclick={() => { soundOn = sound.toggle(); }}
          class="inline-flex items-center text-on-surface-variant/45 hover:text-on-surface transition-colors"
          title={soundOn ? m.onb_shell_sound_on() : m.onb_shell_sound_off()}
          aria-label={soundOn ? m.onb_shell_sound_on() : m.onb_shell_sound_off()}
          aria-pressed={soundOn}
        >
          <Papicon icon={soundOn ? 'volume-2' : 'volume-x'} size={15} />
        </button>

        <a
          href="/servers"
          class="inline-flex items-center gap-1.5 text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
        >
          <Papicon icon="arrow-left-right" size={13} />
          <span class="hidden sm:inline">Changer de serveur</span>
        </a>
      </div>
    </div>
  </header>

  <!-- ── Progression, par phases ──────────────────────────────────────────── -->
  <div class="shrink-0 border-b border-outline-variant/25 bg-surface-container-lowest/40">
    <div class="mx-auto w-full {frame} px-6 py-3 transition-[max-width] duration-300">
      <div class="flex items-center gap-3">
        {#each visiblePhases as phase (phase.key)}
          <div class="flex-1 min-w-0 flex items-center gap-1" style="flex-grow: {phase.steps.length}">
            {#each phase.steps as step (step)}
              {@const position = steps.indexOf(step)}
              <div
                class="h-1 flex-1 rounded-full transition-colors duration-500
                {position < index
                  ? 'bg-primary'
                  : position === index
                    ? 'bg-primary/60'
                    : 'bg-outline-variant/30'}"
              ></div>
            {/each}
          </div>
        {/each}
      </div>

      <div class="mt-2 flex items-baseline justify-between gap-3">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-primary/75 truncate">
          {visiblePhases.find((phase) => phase.key === currentPhase)?.label ?? ''}
        </p>
        <p class="text-[11px] font-medium text-on-surface-variant/40 shrink-0">
          {definition.label()} · {index + 1}/{wizard.total}
        </p>
      </div>
    </div>
  </div>

  <!-- ── L'écran ──────────────────────────────────────────────────────────── -->
  <main class="flex-1 mx-auto w-full {frame} px-6 py-9 sm:py-12 transition-[max-width] duration-300">
    <!-- La clef sur l'etape rejoue la transition a chaque changement d'ecran :
         sans elle, Svelte reutilise le bloc et rien ne bouge. -->
    {#key wizard.step}
      {#if effective === 'stage'}
        <!-- Plein ecran : ni titre ni colonne. Ce qu'on regarde se suffit. -->
        <div in:fly={{ y: 12, duration: 320 }}>
          {@render children?.()}
        </div>

      {:else if effective === 'split'}
        <div in:fly={{ y: 10, duration: 260 }} class="grid gap-8 lg:gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] items-start">
          <div class="min-w-0">
            {#if !bare && title}
              <div class="flex items-center gap-2 mb-3">
                <span class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Papicon icon={definition.icon} size={14} />
                </span>
                <span class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant/45">
                  {definition.label()}
                </span>
              </div>

              <h1 class="text-2xl sm:text-[28px] leading-tight font-semibold tracking-tight text-on-surface font-headline">
                {title}
              </h1>
              {#if lead}
                <p class="mt-2.5 text-[15px] text-on-surface-variant/75 leading-relaxed">{lead}</p>
              {/if}
            {/if}

            <div class={bare || !title ? '' : 'mt-8'}>
              {@render children?.()}
            </div>
          </div>

          <!-- L'apercu suit le defilement : sur un ecran de reglement ou de
               boutique, la colonne de gauche est plus longue que l'ecran, et un
               apercu reste en haut ne montre plus rien de ce qu'on modifie. -->
          <aside class="min-w-0 lg:sticky lg:top-6">
            <p class="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant/35">
              <Papicon icon="eye" size={12} />
              {m.onb_shell_preview_hint()}
            </p>
            {@render preview?.()}
          </aside>
        </div>

      {:else}
        <div in:fly={{ y: 10, duration: 260 }}>
          {#if !bare && title}
            <div class="flex items-center gap-2 mb-3">
              <span class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Papicon icon={definition.icon} size={14} />
              </span>
              <span class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant/45">
                {definition.label()}
              </span>
            </div>

            <h1 class="text-2xl sm:text-[28px] leading-tight font-semibold tracking-tight text-on-surface font-headline">
              {title}
            </h1>
            {#if lead}
              <p class="mt-2.5 text-[15px] text-on-surface-variant/75 leading-relaxed">{lead}</p>
            {/if}
          {/if}

          <div class={bare || !title ? '' : 'mt-8'}>
            {@render children?.()}
          </div>
        </div>
      {/if}
    {/key}
  </main>

  <!-- ── Pied : retour et action ──────────────────────────────────────────── -->
  <footer class="shrink-0 border-t border-outline-variant/25 bg-surface-container-lowest/60 backdrop-blur-sm">
    <div class="mx-auto w-full {frame} px-6 py-4 flex items-center justify-between gap-4 transition-[max-width] duration-300">
      {#if canGoBack && !wizard.isFirst}
        <button
          type="button"
          onclick={() => wizard.back()}
          class="inline-flex items-center gap-1.5 text-[13px] font-medium text-on-surface-variant/60 hover:text-on-surface transition-colors"
        >
          <Papicon icon="ChevronLeft" size={14} />
          Retour
        </button>
      {:else}
        <span></span>
      {/if}

      <div class="flex items-center gap-3">
        {@render footer?.()}
      </div>
    </div>
  </footer>
</div>
