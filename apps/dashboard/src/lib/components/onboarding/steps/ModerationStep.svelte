<script lang="ts">
  /**
   * Le niveau de moderation, montre plutot que decrit.
   *
   * Les trois reglages sont les memes qu'avant. Ce qui change, c'est qu'on les
   * voit a l'oeuvre : la colonne de droite fait passer les memes messages dans
   * un faux salon, et c'est le niveau retenu qui decide de leur sort. Changer
   * de carte rejoue la scene, et l'ecart entre « Souple » et « Strict » se
   * constate au lieu de se croire.
   *
   * Deux ecritures, deux modules : les filtres de message et les seuils
   * anti-raid vivent dans deux configurations distinctes, et un prereglage
   * deplace les deux.
   */
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { MODERATION_LEVELS, celebrateStep, type ModerationLevel } from '../../../onboarding';
  import { updateAutoModConfig, updateRaidProtection } from '../../../api';
  import { AUTOMOD_PRESETS, type AutomodPreset } from '@kotbo/shared';
  import ChoiceCard from '../ChoiceCard.svelte';
  import ModerationSim from '../ModerationSim.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const level = $derived<ModerationLevel>(wizard.moderation ?? 'standard');

  async function apply() {
    if (onboardingData.busy) return;
    const preset = AUTOMOD_PRESETS.find((entry: AutomodPreset) => entry.id === level);
    if (!preset) {
      toast.error('Niveau de protection inconnu.');
      return;
    }

    onboardingData.busy = true;
    try {
      await updateAutoModConfig(preset.filters, undefined, { silent: true });
      await updateRaidProtection(preset.raid, undefined, { silent: true });
      celebrateStep();
      wizard.complete('moderation');
    } catch (err: any) {
      toast.error(err?.message || "La protection n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Quel niveau de modération ?"
  lead="Regardez à droite : les mêmes messages, et ce que Kotbo en fait selon le réglage. Vous pourrez affiner chaque filtre plus tard."
  {onEditTracks}
>
  <div class="space-y-3">
    {#each MODERATION_LEVELS as entry (entry.key)}
      <ChoiceCard
        label={entry.label}
        pitch={entry.pitch}
        detail={entry.detail}
        icon={entry.icon}
        selected={level === entry.key}
        badge={entry.key === 'standard' ? 'Recommandé' : undefined}
        onclick={() => { wizard.answer({ moderation: entry.key }); celebrateStep(); }}
      />
    {/each}
  </div>

  {#snippet preview()}
    <ModerationSim {level} />
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Appliquer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
