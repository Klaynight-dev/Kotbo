<script lang="ts">
  /**
   * Ce que Kotbo peut reprendre, et ce qu'il faudra refaire.
   *
   * Le scan a trouve une categorie de tickets, un salon de logs, un role de
   * moderation. Les reprendre evite a la fois de les recreer en double et de
   * les redemander ecran apres ecran : quelqu'un qui a deja un salon de
   * reglement n'a pas a en choisir un a l'ecran « journalisation ».
   *
   * Rien n'est ecrit sans que la proposition ait ete cochee, et tout est coche
   * d'office : reprendre est le comportement attendu quand on vient d'un autre
   * bot, et decocher reste possible ligne par ligne pour ce qu'on prefere
   * regler soi-meme.
   *
   * La seconde moitie de l'ecran dit ce que Kotbo ne sait pas reprendre. C'est
   * la partie qui coute a ecrire et qui vaut le plus : annoncer une migration
   * complete puis laisser decouvrir trois trous un mois plus tard est la
   * meilleure facon de perdre quelqu'un qui avait fait confiance.
   */
  import { onMount } from 'svelte';
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { celebratePhase, celebrateStep } from '../../../onboarding';
  import { applyMigrationPlan } from '../../../api';
  import ToggleCard from '../ToggleCard.svelte';
  import RecoveredContent from '../RecoveredContent.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { skip }: { skip: () => void } = $props();

  const plan = $derived(onboardingData.migration);
  const loading = $derived(onboardingData.migrationLoading || !onboardingData.migrationLoaded);
  const findings = $derived(plan?.findings ?? []);
  const manualSteps = $derived(plan?.manualSteps ?? []);

  onMount(() => {
    void onboardingData.loadMigration();
  });

  /**
   * Ce qui est retenu. Tout, tant qu'on n'a rien decoche.
   *
   * L'etat vit ici et non dans le store du parcours : ces clefs ne servent qu'a
   * cet ecran et ne veulent plus rien dire une fois la reprise appliquee.
   */
  let dropped = $state<string[]>([]);
  const kept = $derived(findings.filter((finding) => !dropped.includes(finding.key)));

  function toggle(key: string) {
    dropped = dropped.includes(key)
      ? dropped.filter((entry) => entry !== key)
      : [...dropped, key];
    celebrateStep();
  }

  async function apply() {
    if (onboardingData.busy) return;
    if (kept.length === 0) {
      wizard.complete('migration-findings');
      return;
    }

    onboardingData.busy = true;
    try {
      await applyMigrationPlan(kept.map((finding) => finding.key));
      toast.success(m.onb_migration_applied({ count: kept.length }));
      celebratePhase();

      // Les salons et roles repris changent ce que les ecrans suivants doivent
      // proposer : sans cette relecture, la structure reproposerait de creer ce
      // qu'on vient de recuperer.
      await Promise.all([
        onboardingData.refreshTemplate().catch(() => {}),
        onboardingData.loadGuild(true),
      ]);

      wizard.complete('migration-findings');
    } catch (err: any) {
      toast.error(err?.message || "La reprise n'a pas pu être appliquée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_migration_findings_title()}
  lead={loading ? m.onb_migration_scanning() : findings.length > 0 ? m.onb_migration_findings_lead() : m.onb_migration_findings_none()}
>
  {#if loading}
    <div class="space-y-3" aria-live="polite">
      <p class="flex items-center gap-2 text-[13px] text-on-surface-variant/60">
        <Papicon icon="radar" size={14} class="text-primary animate-pulse" />
        {m.onb_migration_scanning()}
      </p>
      {#each [0, 1, 2] as row (row)}
        <div class="h-[74px] rounded-2xl bg-surface-container-low/40 animate-pulse"></div>
      {/each}
    </div>
  {:else if findings.length > 0}
    <div class="space-y-2.5">
      {#each findings as finding (finding.key)}
        <div>
          <ToggleCard
            label={finding.title}
            pitch={finding.detail}
            icon="download"
            meta={finding.entities.length > 1 ? `${finding.entities.length} éléments` : undefined}
            selected={!dropped.includes(finding.key)}
            onclick={() => toggle(finding.key)}
          >
            {#if finding.entities.length}
              <p class="mt-2 flex flex-wrap gap-1.5">
                {#each finding.entities.slice(0, 6) as entity (entity.id)}
                  <span class="rounded-md bg-surface-container/70 px-1.5 py-0.5 text-[11.5px] text-on-surface-variant/60">
                    {entity.name}
                  </span>
                {/each}
              </p>
            {/if}
            {#if finding.action}
              <p class="mt-1.5 text-[12px] text-primary/75">{finding.action}</p>
            {/if}
          </ToggleCard>

          <!-- Hors de la carte, et non dedans : la carte entiere est un bouton
               a cocher, et deplier un apercu la decocherait au passage. -->
          {#if finding.payload}
            <div class="pl-[46px] pr-4">
              <RecoveredContent payload={finding.payload} />
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if manualSteps.length > 0}
    <section class="mt-8">
      <h2 class="text-[13px] font-semibold text-on-surface">{m.onb_migration_manual_title()}</h2>
      <p class="mt-1 text-[12.5px] text-on-surface-variant/50 leading-relaxed">
        {m.onb_migration_manual_hint()}
      </p>

      <ul class="mt-3 space-y-2">
        {#each manualSteps as step (step.feature + step.label)}
          <li class="flex items-start gap-2.5 rounded-xl border border-outline-variant/25 bg-surface-container-lowest/25 px-3.5 py-2.5">
            <Papicon icon="alert-triangle" size={13} class="mt-0.5 shrink-0 text-amber-500/70" />
            <div class="min-w-0">
              <p class="text-[13px] font-medium text-on-surface-variant/80">{step.label}</p>
              <p class="mt-0.5 text-[12.5px] text-on-surface-variant/50 leading-relaxed">{step.why}</p>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      onclick={skip}
      class="text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
    >
      Passer
    </button>
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy || loading}
      class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
             hover:brightness-110 transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {#if onboardingData.busy}
        Reprise…
      {:else if kept.length > 0}
        {m.onb_migration_apply()}
      {:else}
        Continuer
      {/if}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
