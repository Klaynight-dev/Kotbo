<script lang="ts">
  /**
   * Serveur neuf a batir, ou serveur habite a reprendre.
   *
   * La reponse ne change pas seulement le ton des ecrans suivants : elle decide
   * de leur existence. « Deja en place » insere les deux ecrans de reprise -
   * ce que Kotbo a reconnu, ce qu'il propose de recuperer - et fait de la mise
   * en place un complement plutot qu'une pose.
   *
   * Elle est deja cochee d'apres ce qu'on a observe : age, membres, salons,
   * roles. On confirme au lieu de choisir a l'aveugle entre deux mots dont on
   * ne mesure pas les consequences, et les motifs sont affiches - une
   * recommandation dont on ne voit pas la raison se fait ignorer.
   *
   * L'inspection du serveur part des qu'on repond « existant » : elle prend
   * quelques secondes, et personne n'a envie de les passer devant un ecran qui
   * tourne. Le temps d'arriver a l'ecran suivant, la reponse est la.
   */
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import type { ServerKind } from '../../../onboarding';
  import ChoiceCard from '../ChoiceCard.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const template = $derived(onboardingData.template);

  const suggested = $derived<ServerKind>(
    template?.maturity.maturity === 'established' ? 'existing' : 'new'
  );
  const kind = $derived<ServerKind>(wizard.kind ?? suggested);

  function choose(next: ServerKind) {
    wizard.answer({ kind: next });
    // Lancee des le clic, pas a l'ecran suivant : c'est la seule facon que
    // l'attente tombe pendant qu'on lit plutot que pendant qu'on patiente.
    if (next === 'existing') void onboardingData.loadMigration();
  }
</script>

<WizardShell
  title="D'où part ce serveur ?"
  lead="La suite n'est pas la même selon la réponse. Nous avons regardé votre serveur et coché la plus probable."
>
  <div class="space-y-3">
    <ChoiceCard
      label="Un serveur tout neuf"
      pitch="Peu de salons, peu de rôles, tout reste à poser."
      detail="Kotbo pose la structure d'un coup : catégories, salons, rôles et permissions cohérents."
      icon="sparkles"
      selected={kind === 'new'}
      badge={suggested === 'new' ? 'Recommandé' : undefined}
      onclick={() => choose('new')}
    />
    <ChoiceCard
      label="Un serveur déjà en place"
      pitch="Des salons, des rôles, et peut-être déjà d'autres bots."
      detail="Kotbo regarde d'abord ce que vous avez, reprend ce qu'il peut, et ne pose que ce qui manque."
      icon="robot"
      selected={kind === 'existing'}
      badge={suggested === 'existing' ? 'Recommandé' : undefined}
      onclick={() => choose('existing')}
    />
  </div>

  {#if template?.maturity.reasons.length}
    <div class="mt-5 flex flex-wrap items-center gap-2">
      <span class="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-on-surface-variant/40">
        <Papicon icon="check-circle" size={12} />
        Ce qu'on a lu
      </span>
      {#each template.maturity.reasons as reason (reason)}
        <span class="text-[12px] font-medium px-2 py-1 rounded-lg bg-surface-container-low/60 border border-outline-variant/30 text-on-surface-variant/70">
          {reason}
        </span>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      onclick={() => {
        wizard.answer({ kind });
        if (kind === 'existing') void onboardingData.loadMigration();
        wizard.next();
      }}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
    >
      Continuer
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
