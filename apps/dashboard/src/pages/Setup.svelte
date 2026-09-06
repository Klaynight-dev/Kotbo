<script lang="ts">
  /**
   * Prise en main : ce qu'il reste a faire, et par quoi commencer.
   *
   * Cette page etait une liste de cases a cocher qu'on ouvrait une fois, jamais
   * deux. C'est le sort de toute checklist qui ne dit pas ce qu'on gagne a la
   * remplir : on lit « salon de logs : a faire », on ne sait pas si c'est grave,
   * et on referme.
   *
   * Trois changements, dans cet ordre d'importance :
   *
   * - les prochaines actions passent en tete, en trois cartes. Pas la liste
   *   complete : les trois points qui manquent le plus, avec ce qu'ils
   *   apportent et un lien qui y mene. On ouvre la page en sachant quoi faire
   *   dans la minute.
   * - ce qu'on a laisse de cote pendant le parcours de configuration est
   *   rappele. Quelqu'un qui a decoche « L'economie » a l'ecran 3 ne savait pas
   *   encore ce que Kotbo faisait ; un mois plus tard, il le sait, et rien ne le
   *   lui reproposait.
   * - le renvoi vers la page « Reprise » disparait : la detection des autres
   *   bots se fait maintenant dans le parcours, avant que Kotbo ne pose quoi que
   *   ce soit. La proposer ici revenait a la proposer trop tard.
   *
   * Elle lit toujours la configuration reelle plutot qu'un compteur d'etapes
   * franchies : un reglage efface redevient « a faire », ce qu'un tutoriel
   * lineaire ne saurait pas montrer.
   *
   * La mise en place du serveur - poser salons, roles et modules d'un coup -
   * vivait sur sa propre page. C'etait le meme moment coupe en deux : on montait
   * la structure d'un cote, on decouvrait de l'autre ce qu'il restait a regler,
   * sans que rien ne dise dans quel ordre. Elle est desormais un bloc, replie
   * une fois faite puisqu'elle ne se relance pas.
   */
  import { onMount } from 'svelte';
  import { m } from '../lib/i18n';
  import { authStore } from '../lib/stores/auth.svelte';
  import { navigationStore } from '../lib/stores/navigation.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { fetchSetupJourney } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { wizard } from '../lib/stores/onboardingWizard.svelte';
  import { TRACKS, type TrackKey } from '../lib/onboarding';
  import ServerTemplatePanel from '../lib/components/ServerTemplatePanel.svelte';

  type Step = {
    key: string;
    group: 'essentiel' | 'moderation' | 'engagement';
    label: string;
    why: string;
    done: boolean;
    href: string;
    detail?: string;
  };

  let steps = $state<Step[]>([]);
  let progress = $state({ done: 0, total: 0 });
  let loading = $state(true);

  /**
   * La mise en place ne se relance pas : une fois faite, son formulaire n'est
   * plus qu'une archive et n'a pas a pousser le parcours hors de l'ecran. Il
   * reste depliable, l'admin devant pouvoir revoir ce qui a ete pose.
   *
   * `null` tant que le bloc n'a pas rendu son etat : le repli ne se decide
   * qu'une fois, sinon un rechargement du plan refermerait ce que l'admin
   * vient d'ouvrir.
   */
  let templateApplied = $state<boolean | null>(null);
  let templateOpen = $state(true);

  // Poser des salons demande les droits d'administration : un moderateur n'y
  // verrait qu'un formulaire refuse.
  const canBuildServer = $derived(navigationStore.isAdmin);

  const GROUPS: { key: Step['group']; title: string; description: string; icon: string }[] = [
    {
      key: 'essentiel',
      title: 'Essentiel',
      description: "Sans ces trois-là, le reste fonctionne mal ou en silence.",
      icon: 'star',
    },
    {
      key: 'moderation',
      title: 'Modération',
      description: 'De quoi encadrer le serveur et rendre les décisions défendables.',
      icon: 'shield',
    },
    {
      key: 'engagement',
      title: 'Vie du serveur',
      description: "Ce qui fait revenir les membres : accueil, entraide, réponse aux demandes.",
      icon: 'users',
    },
  ];

  const percent = $derived(progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0);
  const remaining = $derived(steps.filter((s) => !s.done));
  /** Les trois qui manquent le plus. L'ordre des groupes est l'ordre conseille. */
  const nextActions = $derived(remaining.slice(0, 3));

  /**
   * Ou aller pour configurer une piste laissee de cote.
   *
   * Le parcours de configuration ne se rouvre pas une fois clos - c'est le bot
   * qui en decide, et il a raison : rejouer la pose de structure sur un serveur
   * monte doublerait des salons. On renvoie donc vers la page qui fait le meme
   * travail, en plus complet.
   */
  const TRACK_PAGES: Record<TrackKey, string> = {
    structure: '/setup#structure',
    moderation: '/security',
    logs: '/logs',
    greeting: '/announcement',
    rules: '/regulation',
    tickets: '/tickets',
    levels: '/leveling',
    economy: '/economy',
    animation: '/quests',
    staff: '/staff-management/members',
    mcp: '/mcp-settings',
  };

  /**
   * Ce qu'on n'a pas coche pendant le parcours.
   *
   * Lu dans le store du parcours, qui garde la selection meme une fois le
   * parcours clos. Vide tant qu'on n'a rien coche - un serveur active avant
   * l'existence du menu de pistes n'a rien laisse de cote, il n'a jamais eu le
   * choix, et lui presenter onze modules comme des oublis serait faux.
   */
  const skippedTracks = $derived.by(() => {
    if (!wizard.tracksChosen) return [];
    const kept = new Set(wizard.tracks);
    return TRACKS.filter((track) => !kept.has(track.key));
  });

  function ringColor(value: number): string {
    if (value >= 85) return 'stroke-emerald-500';
    if (value >= 50) return 'stroke-amber-500';
    return 'stroke-primary';
  }

  function textColor(value: number): string {
    if (value >= 85) return 'text-emerald-500';
    if (value >= 50) return 'text-amber-500';
    return 'text-primary';
  }

  const RING_RADIUS = 42;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const ringOffset = $derived(RING_CIRCUMFERENCE * (1 - percent / 100));

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      const data = await fetchSetupJourney();
      steps = data?.steps ?? [];
      progress = data?.progress ?? { done: 0, total: 0 };
    } catch (err: any) {
      toast.error(err?.message || 'Chargement du parcours impossible');
      steps = [];
    } finally {
      loading = false;
    }
  }

  function onTemplateLoaded(state: { applied: boolean }): void {
    if (templateApplied !== null) return;
    templateApplied = state.applied;
    templateOpen = !state.applied;
  }

  /**
   * Les salons poses cochent plusieurs points du parcours : il est relu.
   *
   * Le bloc, lui, reste ouvert : il vient de servir, le replier escamoterait le
   * compte-rendu de ce qui a ete cree. Il se repliera a la visite suivante.
   */
  function onTemplateApplied(): void {
    templateApplied = true;
    void load();
  }

  onMount(load);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    // L'etat du bloc appartient au serveur affiche : le garder ferait passer la
    // mise en place d'un serveur pour celle du suivant.
    templateApplied = null;
    templateOpen = true;
    void load();
  });
</script>

<ModulePage
  title="Prise en main"
  description="Par quoi commencer, ce qui manque, et ce que vous aviez laissé de côté"
  icon="compass"
  featureKey="settings"
>
  {#snippet actions()}
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  {#if loading && steps.length === 0}
    <LoadingHint context="config" />
  {:else if steps.length === 0}
    <EmptyState icon="compass" title="Parcours indisponible" description="Relancez le calcul." />
  {:else}
    <div class="space-y-4">
      <!-- ── Les trois prochaines actions ───────────────────────────────── -->
      {#if nextActions.length > 0}
        <div class="grid gap-3 sm:grid-cols-3">
          {#each nextActions as action, index (action.key)}
            <a
              href={action.href}
              class="group rounded-2xl border p-4 transition-colors
              {index === 0
                ? 'border-primary/45 bg-primary/[0.05] hover:border-primary/70'
                : 'border-outline-variant/30 bg-surface-container-low/30 hover:border-primary/40'}"
            >
              <div class="flex items-center gap-2 mb-2">
                <span class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0
                  {index === 0 ? 'bg-primary text-on-primary' : 'bg-primary/12 text-primary'}">
                  <Papicon icon="arrow-right" size={13} />
                </span>
                {#if index === 0}
                  <span class="text-[10px] font-semibold uppercase tracking-wider text-primary">
                    À faire maintenant
                  </span>
                {/if}
              </div>

              <p class="text-[14px] font-semibold text-on-surface leading-tight">{action.label}</p>
              <p class="mt-1 text-[12.5px] text-on-surface-variant/70 leading-relaxed">{action.why}</p>
              {#if action.detail}
                <p class="mt-2 text-[11px] px-1.5 py-0.5 rounded bg-error/10 text-error inline-block">
                  manque : {action.detail}
                </p>
              {/if}
            </a>
          {/each}
        </div>
      {/if}

      <!-- ── Avancement ─────────────────────────────────────────────────── -->
      <SectionCard>
        <div class="flex flex-col sm:flex-row items-center gap-5">
          <div class="relative w-[110px] h-[110px] shrink-0">
            <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r={RING_RADIUS} class="stroke-outline-variant/30" stroke-width="8" fill="none" />
              <circle
                cx="50" cy="50" r={RING_RADIUS}
                class="{ringColor(percent)} transition-all duration-700"
                stroke-width="8" fill="none" stroke-linecap="round"
                stroke-dasharray={RING_CIRCUMFERENCE}
                stroke-dashoffset={ringOffset}
              />
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center">
              <span class="text-2xl font-bold tracking-tight {textColor(percent)}">{percent}%</span>
              <span class="text-[10px] uppercase tracking-widest text-on-surface-variant/70">
                {progress.done}/{progress.total}
              </span>
            </div>
          </div>

          <div class="min-w-0 flex-1 text-center sm:text-left">
            {#if remaining.length === 0}
              <p class="text-sm font-semibold text-emerald-500">Tout est configuré.</p>
              <p class="text-[13px] text-on-surface-variant mt-1 leading-relaxed">
                Les points essentiels sont couverts. Le reste se règle module par module,
                au fil de ce dont le serveur a besoin.
              </p>
            {:else}
              <p class="text-sm font-semibold text-on-surface">
                {remaining.length} point{remaining.length > 1 ? 's' : ''} à régler
              </p>
              <p class="text-[13px] text-on-surface-variant mt-1 leading-relaxed">
                Le prochain : <a href={remaining[0].href} class="text-primary hover:underline font-medium">{remaining[0].label}</a>.
                {remaining[0].why}
              </p>
            {/if}
          </div>
        </div>
      </SectionCard>

      <!-- ── Monter le serveur ──────────────────────────────────────────── -->
      {#if canBuildServer}
        <section id="structure" class="scroll-mt-6">
          <SectionCard
            title={m.st_title()}
            description={m.st_description()}
            icon="sparkles"
          >
            {#snippet actions()}
              {#if templateApplied}
                <button
                  type="button"
                  onclick={() => (templateOpen = !templateOpen)}
                  class="px-3 py-1.5 text-[12px] font-medium rounded-lg text-primary hover:bg-primary/10 transition-colors"
                >
                  {templateOpen ? 'Masquer' : 'Revoir'}
                </button>
              {/if}
            {/snippet}

            {#if templateApplied && !templateOpen}
              <p class="text-[13px] text-on-surface-variant leading-relaxed">
                La structure a été posée : elle ne se relance pas. « Revoir » rouvre le
                détail de ce qui a été créé.
              </p>
            {/if}

            <!-- Toujours monté, même replié : c'est lui qui charge le plan, et
                 donc lui qui dit si la mise en place a déjà eu lieu. -->
            <div class:hidden={templateApplied !== null && !templateOpen}>
              <ServerTemplatePanel onLoaded={onTemplateLoaded} onApplied={onTemplateApplied} />
            </div>
          </SectionCard>
        </section>
      {/if}

      <!-- ── Étapes par groupe ──────────────────────────────────────────── -->
      {#each GROUPS as group (group.key)}
        {@const groupSteps = steps.filter((s) => s.group === group.key)}
        {#if groupSteps.length > 0}
          {@const groupDone = groupSteps.filter((s) => s.done).length}
          <SectionCard title={group.title} description={group.description} icon={group.icon}>
            {#snippet actions()}
              <span class="text-[11px] px-2 py-0.5 rounded-full font-semibold
                {groupDone === groupSteps.length ? 'bg-emerald-500/10 text-emerald-500' : 'bg-surface-container text-on-surface-variant'}">
                {groupDone}/{groupSteps.length}
              </span>
            {/snippet}

            <ul class="space-y-1.5">
              {#each groupSteps as step (step.key)}
                <li>
                  <a
                    href={step.href}
                    class="flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors
                    {step.done
                      ? 'border-outline-variant/20 bg-surface-container-low/30 hover:border-outline-variant/40'
                      : 'border-primary/25 bg-primary/[0.04] hover:border-primary/45'}"
                  >
                    <div class="w-6 h-6 shrink-0 rounded-full flex items-center justify-center mt-0.5
                      {step.done ? 'bg-emerald-500/15 text-emerald-500' : 'bg-primary/15 text-primary'}">
                      <Papicon icon={step.done ? 'check' : 'arrow-right'} size={13} />
                    </div>

                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-[13.5px] font-semibold {step.done ? 'text-on-surface-variant' : 'text-on-surface'}">
                          {step.label}
                        </span>
                        {#if !step.done && step.detail}
                          <span class="text-[10.5px] px-1.5 py-0.5 rounded bg-error/10 text-error">
                            manque : {step.detail}
                          </span>
                        {:else if step.done && step.detail}
                          <span class="text-[10.5px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                            {step.detail}
                          </span>
                        {/if}
                      </div>
                      <p class="mt-0.5 text-[12.5px] text-on-surface-variant leading-relaxed">{step.why}</p>
                    </div>
                  </a>
                </li>
              {/each}
            </ul>
          </SectionCard>
        {/if}
      {/each}

      {#if skippedTracks.length > 0}
        <!-- Ce qu'on a laisse de cote pendant le parcours. Quelqu'un qui a
             decoche « L'economie » le premier jour ne savait pas encore ce que
             Kotbo faisait ; ici, il le sait, et personne ne le lui reproposait. -->
        <SectionCard
          title="Ce que vous n'avez pas encore configuré"
          description="Vous l'aviez laissé de côté à la mise en place. Rien ne presse - mais voilà ce que ça apporterait."
          icon="package"
        >
          <div class="grid gap-2.5 sm:grid-cols-2">
            {#each skippedTracks as track (track.key)}
              <a
                href={TRACK_PAGES[track.key]}
                class="flex items-start gap-3 rounded-xl border border-outline-variant/25 bg-surface-container-low/25 p-3.5
                       hover:border-primary/40 transition-colors"
              >
                <span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container text-on-surface-variant/50 flex items-center justify-center">
                  <Papicon icon={track.icon} size={15} />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-[13.5px] font-semibold text-on-surface">{track.label()}</p>
                  <p class="mt-0.5 text-[12.5px] text-on-surface-variant/60 leading-relaxed">{track.outcome()}</p>
                </div>
                <Papicon icon="ChevronRight" size={14} class="mt-1 shrink-0 text-on-surface-variant/30" />
              </a>
            {/each}
          </div>
        </SectionCard>
      {/if}
    </div>
  {/if}
</ModulePage>
