<script lang="ts">
  /**
   * Le parcours de configuration : un ecran par question, une question par
   * decision.
   *
   * Cette page ne fait plus que trois choses : charger ce dont les ecrans ont
   * besoin, dire lequel afficher, et fournir les deux gestes qui traversent
   * tout le parcours - passer une etape facultative, revenir a la selection des
   * pistes. Tout le reste vit dans `lib/components/onboarding/steps/`, un
   * fichier par ecran, et dans `lib/onboarding/` pour l'ordre et la matiere.
   *
   * C'est ce decoupage qui rend la longueur tenable : le parcours decrit vingt
   * ecrans, mais on n'en traverse que ceux dont la piste est cochee. Tout tenir
   * dans un seul composant demandait de lire quinze cents lignes pour changer
   * un libelle, et chaque ecran ajoute rendait le suivant plus cher.
   *
   * Le tableau de bord n'existe pas pendant ce parcours. Pas de barre laterale,
   * pas d'en-tete, aucune page a atteindre : il n'y a rien a piloter tant que
   * rien n'est monte. Ce qu'on ouvre en payant, c'est le pilotage ; ce qu'on
   * traverse ici, c'est la mise en place.
   *
   * Chaque etape ecrit en la validant. Un parcours abandonne au quatrieme ecran
   * laisse donc un serveur reellement structure, pas un formulaire perdu - et
   * revenir plus tard reprend a l'etape suivante plutot que de tout redemander.
   * En contrepartie « Retour » relit une etape sans la defaire : c'est le prix
   * d'un serveur qui se construit sous les yeux.
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { wizard } from '../lib/stores/onboardingWizard.svelte';
  import { onboardingData } from '../lib/stores/onboardingData.svelte';
  import { globalNotice } from '../lib/stores/globalNotice.svelte';
  import KotboMark from '../lib/components/onboarding/KotboMark.svelte';
  import { MAPPING_STEPS, defaultMapping, type MappingState, type ThemeKey } from '../lib/onboarding';

  import WelcomeStep from '../lib/components/onboarding/steps/WelcomeStep.svelte';
  import KindStep from '../lib/components/onboarding/steps/KindStep.svelte';
  import MigrationBotsStep from '../lib/components/onboarding/steps/MigrationBotsStep.svelte';
  import MigrationFindingsStep from '../lib/components/onboarding/steps/MigrationFindingsStep.svelte';
  import TracksStep from '../lib/components/onboarding/steps/TracksStep.svelte';
  import IdentityStep from '../lib/components/onboarding/steps/IdentityStep.svelte';
  import ThemeStep from '../lib/components/onboarding/steps/ThemeStep.svelte';
  import TicketsStep from '../lib/components/onboarding/steps/TicketsStep.svelte';
  import MappingStep from '../lib/components/onboarding/steps/MappingStep.svelte';
  import StructureStep from '../lib/components/onboarding/steps/StructureStep.svelte';
  import ModerationStep from '../lib/components/onboarding/steps/ModerationStep.svelte';
  import LogsStep from '../lib/components/onboarding/steps/LogsStep.svelte';
  import StaffStep from '../lib/components/onboarding/steps/StaffStep.svelte';
  import GreetingStep from '../lib/components/onboarding/steps/GreetingStep.svelte';
  import RulesStep from '../lib/components/onboarding/steps/RulesStep.svelte';
  import LevelsStep from '../lib/components/onboarding/steps/LevelsStep.svelte';
  import EconomyStep from '../lib/components/onboarding/steps/EconomyStep.svelte';
  import EconomyShopStep from '../lib/components/onboarding/steps/EconomyShopStep.svelte';
  import QuestsStep from '../lib/components/onboarding/steps/QuestsStep.svelte';
  import DropsStep from '../lib/components/onboarding/steps/DropsStep.svelte';
  import McpStep from '../lib/components/onboarding/steps/McpStep.svelte';
  import RecapStep from '../lib/components/onboarding/steps/RecapStep.svelte';
  import CheckoutStep from '../lib/components/onboarding/steps/CheckoutStep.svelte';

  let loading = $state(true);
  let loadError = $state('');

  async function load() {
    loading = true;
    loadError = '';
    try {
      await onboardingData.loadCore();

      const template = onboardingData.template;
      if (template) {
        /**
         * Le serveur est-il habite ? La question ne se pose pas a
         * l'administrateur.
         *
         * Il repond « nouveau serveur » parce que Kotbo est nouveau pour lui,
         * et le parcours posait alors la maquette entiere par-dessus vingt
         * salons dont sa communaute se sert. C'est le bot qui tranche, sur ce
         * qu'il voit : des lors qu'il y a quelque chose a rapprocher, les
         * ecrans de mappage entrent au programme.
         */
        wizard.answer({ structured: template.structured });

        /**
         * Une structure posee ne se repropose que s'il y reste quelque chose a
         * faire.
         *
         * Avant, `applied` suffisait a sauter l'ecran, et un serveur ou la pose
         * s'etait arretee en chemin n'avait plus aucun moyen de la finir. On
         * regarde donc ce qui manque reellement : tout reconnu, on passe ;
         * sinon les ecrans s'ouvrent et ne proposeront que les lignes orphelines.
         */
        const unmatched = template.plan.some(
          (item) => item.kind !== 'module' && !template.matches[item.key],
        );
        if (template.applied && !unmatched) wizard.resumeAfter('structure');
      }

      // Roles et salons servent a quatre ecrans qui ne se suivent pas. Les lire
      // une fois ici evite quatre attentes reparties dans le parcours.
      void onboardingData.loadGuild();

      // Ce qu'un autre appareil aurait laisse plus loin. Sans attendre : le
      // navigateur porte deja de quoi afficher le premier ecran.
      void wizard.hydrateFromServer();
    } catch (err: any) {
      // Un refus d'acces (par ex. un moderateur qui n'a pas la main sur la mise
      // en place) n'a rien a faire sur cet ecran : « Reessayer » n'y changerait
      // rien, et laisser la personne coincee sur un parcours qu'elle ne peut
      // pas traverser est pire que de la renvoyer choisir un autre serveur.
      if (err?.status === 403) {
        globalNotice.show(err.message || "Vous n'avez pas les droits necessaires pour cette action.");
        router.goto('/servers');
        return;
      }
      loadError = err?.message || "La configuration n'a pas pu être chargée.";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    wizard.initialize(guildId);
  });

  /**
   * Le mappage de depart, reaccorde a la vocation choisie.
   *
   * La vocation se choisit apres le chargement et decide des sections retenues :
   * passer de « communaute » a « du jeu » ajoute les salons de bots, et il faut
   * bien que quelqu'un decide de leur sort. `defaultMapping` conserve ce qui a
   * deja ete tranche et ne pre-remplit que les lignes nouvelles - revenir d'un
   * ecran en arriere ne doit pas effacer la correction qu'on venait d'y faire.
   *
   * L'ecriture est conditionnee a un changement reel : sans cela, elle
   * relancerait l'effet qui l'a produite.
   */
  $effect(() => {
    const template = onboardingData.template;
    if (!template) return;

    const next = defaultMapping(
      template.plan,
      (wizard.theme ?? 'communaute') as ThemeKey,
      template.matches,
      wizard.mapping,
    );
    if (!sameMapping(next, wizard.mapping)) wizard.seedMapping(next);
  });

  function sameMapping(a: MappingState, b: MappingState): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => b[key]?.mode === a[key].mode && b[key]?.id === a[key].id);
  }

  /** Traverser sans rien decider : reserve aux ecrans facultatifs. */
  function skip() {
    wizard.next();
  }

  /** Revenir cocher ou decocher des pistes, depuis n'importe quel ecran. */
  function editTracks() {
    wizard.goto('tracks');
  }
</script>

{#if loading}
  <div class="min-h-screen bg-background flex flex-col items-center justify-center gap-6">
    <KotboMark size={52} halo />
    <div class="w-full max-w-2xl px-6 space-y-3">
      <div class="h-8 w-1/2 rounded-lg bg-surface-container-low/50 animate-pulse"></div>
      <div class="h-24 rounded-2xl bg-surface-container-low/40 animate-pulse"></div>
      <div class="h-24 rounded-2xl bg-surface-container-low/40 animate-pulse"></div>
    </div>
  </div>

{:else if loadError}
  <div class="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6 text-center">
    <KotboMark size={44} />
    <p class="text-[15px] text-on-surface-variant/80 max-w-sm leading-relaxed">{loadError}</p>
    <button
      type="button"
      onclick={load}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
    >
      Réessayer
    </button>
  </div>

{:else if wizard.step === 'welcome'}
  <WelcomeStep />
{:else if wizard.step === 'kind'}
  <KindStep />
{:else if wizard.step === 'migration-bots'}
  <MigrationBotsStep />
{:else if wizard.step === 'migration-findings'}
  <MigrationFindingsStep {skip} />
{:else if wizard.step === 'tracks'}
  <TracksStep />
{:else if wizard.step === 'identity'}
  <IdentityStep onEditTracks={editTracks} />
{:else if wizard.step === 'theme'}
  <ThemeStep onEditTracks={editTracks} />
{:else if wizard.step === 'tickets'}
  <TicketsStep onEditTracks={editTracks} {skip} />
{:else if MAPPING_STEPS.includes(wizard.step)}
  <!-- Un composant pour tous : les ecrans de mappage ne different que par la
       section qu'ils interrogent, et c'est `wizard.step` qui la designe. -->
  <MappingStep onEditTracks={editTracks} />
{:else if wizard.step === 'structure'}
  <StructureStep onEditTracks={editTracks} />
{:else if wizard.step === 'moderation'}
  <ModerationStep onEditTracks={editTracks} />
{:else if wizard.step === 'logs'}
  <LogsStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'staff'}
  <StaffStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'greeting'}
  <GreetingStep onEditTracks={editTracks} />
{:else if wizard.step === 'rules'}
  <RulesStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'levels'}
  <LevelsStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'economy'}
  <EconomyStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'economy-shop'}
  <EconomyShopStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'animation'}
  <QuestsStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'animation-drops'}
  <DropsStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'mcp'}
  <McpStep onEditTracks={editTracks} {skip} />
{:else if wizard.step === 'recap'}
  <RecapStep onEditTracks={editTracks} />
{:else}
  <CheckoutStep onEditTracks={editTracks} />
{/if}
