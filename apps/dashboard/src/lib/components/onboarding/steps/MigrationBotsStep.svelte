<script lang="ts">
  /**
   * « Voyons ce qui tourne deja ici. »
   *
   * Le premier ecran qu'un serveur habite devrait voir, et il n'existait pas :
   * le parcours enchainait sur la langue et la vocation comme s'il arrivait
   * dans un serveur vide. Un serveur de trois ans a des salons, des roles,
   * souvent deux ou trois bots, et lui proposer de tout monter a neuf sans
   * avoir regarde revient a lui promettre des doublons.
   *
   * Cet ecran ne demande rien. Il montre ce que Kotbo a reconnu - les bots
   * presents, ce qu'ils couvrent, la trace qui l'a fait conclure - et c'est
   * exactement ce qui inspire confiance a ce moment-la : un produit qui a
   * regarde avant de proposer. Rien n'est ecrit ici ; la reprise se decide a
   * l'ecran suivant.
   *
   * L'inspection a ete lancee des la reponse « serveur existant » : le temps
   * d'arriver, la reponse est la. Quand elle ne l'est pas encore, on l'attend
   * en le disant plutot qu'en affichant un ecran vide.
   */
  import { onMount } from 'svelte';
  import { m } from '../../../i18n';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const plan = $derived(onboardingData.migration);
  const loading = $derived(onboardingData.migrationLoading || !onboardingData.migrationLoaded);
  const bots = $derived(plan?.bots ?? []);

  onMount(() => {
    void onboardingData.loadMigration();
  });
</script>

<WizardShell
  title={!loading && bots.length === 0 ? m.onb_migration_bots_none_title() : m.onb_migration_bots_title()}
  lead={!loading && bots.length === 0 ? m.onb_migration_bots_none_lead() : m.onb_migration_bots_lead()}
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

  {:else if bots.length === 0}
    <div class="rounded-2xl border border-dashed border-outline-variant/40 px-5 py-8 text-center">
      <Papicon icon="check-circle" size={22} class="text-emerald-500 mb-2" />
      <p class="text-[13.5px] text-on-surface-variant/65 leading-relaxed max-w-sm mx-auto">
        Kotbo n'a repéré aucun autre bot de gestion. Les écrans suivants
        configureront votre serveur à partir de ce qu'il porte déjà.
      </p>
    </div>

  {:else}
    <div class="space-y-2.5">
      {#each bots as bot (bot.id)}
        <div class="rounded-2xl border border-outline-variant/35 bg-surface-container-lowest/40 p-4">
          <div class="flex items-start gap-3.5">
            <img src={bot.avatarUrl} alt="" class="w-10 h-10 rounded-xl shrink-0 bg-surface-container" />

            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2 flex-wrap">
                <h3 class="text-[14.5px] font-semibold text-on-surface">{bot.label ?? bot.username}</h3>
                {#if bot.label && bot.label !== bot.username}
                  <span class="text-[12px] text-on-surface-variant/45">{bot.username}</span>
                {/if}
              </div>

              {#if bot.covers.length}
                <p class="mt-1 text-[12.5px] text-on-surface-variant/60">
                  <span class="text-on-surface-variant/40">{m.onb_migration_bots_covers()} :</span>
                  {bot.covers.join(', ')}
                </p>
              {/if}

              {#if bot.activeFeatures.length}
                <!-- La preuve, pas la conclusion. « Kotbo pense que ce bot gere
                     vos tickets » ne se verifie pas ; « une categorie nommee
                     Tickets, 14 salons » se verifie d'un coup d'oeil. -->
                <ul class="mt-2 space-y-1">
                  {#each bot.activeFeatures.slice(0, 3) as feature (feature.feature)}
                    <li class="flex items-start gap-1.5 text-[12px] text-on-surface-variant/50">
                      <Papicon icon="corner-down-right" size={11} class="mt-0.5 shrink-0 text-on-surface-variant/30" />
                      <span><span class="text-on-surface-variant/70">{feature.feature}</span> - {feature.evidence}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      onclick={() => wizard.complete('migration-bots')}
      disabled={loading}
      class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
             hover:brightness-110 transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      Continuer
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
