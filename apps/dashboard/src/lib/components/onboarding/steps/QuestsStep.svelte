<script lang="ts">
  /**
   * Des objectifs qui se renouvellent, et une raison de revenir demain.
   *
   * C'est la difference entre un serveur qu'on a rejoint et un serveur qu'on
   * ouvre. Les quetes proposees visent des gestes ordinaires - parler,
   * repondre, passer en vocal - et non des exploits : une quete qu'on accomplit
   * sans y penser est une quete qu'on remarque en la validant, et c'est cette
   * notification-la qui ramene le lendemain.
   *
   * On les coche, on ne les redige pas. Ecrire cinq quetes avec leur type,
   * leur objectif et leurs deux recompenses le jour ou l'on decouvre le produit
   * demanderait de savoir a l'avance ce qu'un serveur en fait ; la page Quetes
   * du tableau de bord garde ce reglage pour plus tard.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { QUEST_PRESETS, celebrateStep } from '../../../onboarding';
  import { createQuest } from '../../../api';
  import ToggleCard from '../ToggleCard.svelte';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const selection = $derived(
    wizard.questKeys ?? QUEST_PRESETS.filter((quest) => quest.byDefault).map((quest) => quest.key)
  );
  const chosen = $derived(QUEST_PRESETS.filter((quest) => selection.includes(quest.key)));

  const currency = $derived(wizard.currencyName ?? 'pièces');
  const panelColor = $derived(wizard.panelColor ?? '#8B5CF6');

  function toggle(key: string) {
    wizard.answer({
      questKeys: selection.includes(key)
        ? selection.filter((entry) => entry !== key)
        : [...selection, key],
    });
    celebrateStep();
  }

  async function apply() {
    if (onboardingData.busy) return;
    if (chosen.length === 0) {
      wizard.complete('animation');
      return;
    }

    onboardingData.busy = true;
    try {
      // En serie, comme le reglement : la route relit la liste a chaque
      // creation, et deux ecritures concurrentes se disputeraient l'ordre.
      for (const quest of chosen) {
        await createQuest({
          name: quest.name,
          description: quest.description,
          type: quest.type,
          frequency: quest.frequency,
          target: quest.target,
          rewardCoins: quest.rewardCoins,
          rewardXp: quest.rewardXp,
        });
      }
      wizard.answer({ questKeys: selection });
      celebrateStep();
      wizard.complete('animation');
    } catch (err: any) {
      toast.error(err?.message || "Les quêtes n'ont pas pu être enregistrées.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_quests_title()}
  lead={m.onb_quests_lead()}
  {onEditTracks}
>
  <div class="space-y-2.5">
    {#each QUEST_PRESETS as quest (quest.key)}
      <ToggleCard
        label={quest.name}
        pitch={quest.description}
        emoji={quest.emoji}
        meta={quest.frequency === 'DAILY' ? m.onb_quests_daily() : m.onb_quests_weekly()}
        detail={m.onb_quests_reward({ coins: quest.rewardCoins, xp: quest.rewardXp })}
        selected={selection.includes(quest.key)}
        onclick={() => toggle(quest.key)}
      />
    {/each}
  </div>

  <p class="mt-3 text-[12px] text-on-surface-variant/45 tabular-nums">
    {chosen.length > 0
      ? m.onb_quests_selected({ count: chosen.length })
      : m.onb_quests_empty()}
  </p>

  {#snippet preview()}
    <DiscordPreview channel="quêtes">
      <DiscordEmbed
        color={panelColor}
        title={m.onb_quests_preview_title()}
        description={m.onb_quests_preview_progress({ done: 1, total: Math.max(1, chosen.length) })}
        fields={chosen.slice(0, 4).map((quest, index) => ({
          emoji: index === 0 ? '✅' : quest.emoji,
          name: quest.name,
          value: `${quest.description} - ${m.onb_quests_reward({ coins: quest.rewardCoins, xp: quest.rewardXp })}`,
        }))}
      />
    </DiscordPreview>

    <p class="mt-3 flex items-start gap-2 text-[12.5px] text-on-surface-variant/55 leading-relaxed">
      <Papicon icon="info" size={13} class="mt-0.5 shrink-0 text-on-surface-variant/35" />
      <span>
        Les récompenses se versent en {currency} et en XP, à la validation de chaque quête.
      </span>
    </p>
  {/snippet}

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
      disabled={onboardingData.busy}
      class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
             hover:brightness-110 transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {onboardingData.busy ? 'Création…' : 'Continuer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
