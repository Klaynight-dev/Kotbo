<script lang="ts">
  /**
   * Ce qu'on peut acheter avec.
   *
   * Une monnaie qui ne s'echange contre rien n'est qu'un compteur, et un
   * compteur ne fait revenir personne. Trois objets suffisent a la rendre
   * credible : quelque chose qui se consomme, quelque chose qui aide, quelque
   * chose qui se montre. Le catalogue s'etoffe depuis la page Economie, quand
   * on a vu ce que les membres achetent reellement.
   *
   * Les prix sont editables sur place. C'est le meme principe que le reglement :
   * ce n'est pas d'avoir coche trois cases qui fait qu'on considere la boutique
   * comme sienne, c'est d'avoir change un prix.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { SHOP_PRESETS, celebrateStep, type ShopPreset } from '../../../onboarding';
  import { saveRpgItem } from '../../../api';
  import ToggleCard from '../ToggleCard.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const currency = $derived(wizard.currencyName ?? 'Pièces');
  const emoji = $derived(wizard.currencyEmoji ?? '🪙');

  const selection = $derived(
    wizard.shopKeys ?? SHOP_PRESETS.filter((item) => item.byDefault).map((item) => item.key)
  );

  /** Les prix ajustes a l'ecran. Le preset fait foi tant qu'on n'y a pas touche. */
  let prices = $state<Record<string, number>>({});
  const priceOf = (item: ShopPreset) => prices[item.key] ?? item.price;

  const chosen = $derived(SHOP_PRESETS.filter((item) => selection.includes(item.key)));

  function toggle(key: string) {
    wizard.answer({
      shopKeys: selection.includes(key)
        ? selection.filter((entry) => entry !== key)
        : [...selection, key],
    });
    celebrateStep();
  }

  function effectOf(item: ShopPreset): string {
    if (item.effect.hpRestore) return m.onb_economy_shop_effect_hp({ value: item.effect.hpRestore });
    if (item.effect.energyRestore) return m.onb_economy_shop_effect_energy({ value: item.effect.energyRestore });
    if (item.effect.levelXpReward) return m.onb_economy_shop_effect_xp({ value: item.effect.levelXpReward });
    return m.onb_economy_shop_effect_none();
  }

  async function apply() {
    if (onboardingData.busy) return;
    if (chosen.length === 0) {
      wizard.complete('economy-shop');
      return;
    }

    onboardingData.busy = true;
    try {
      // En serie : la route de creation renumerote et relit le catalogue a
      // chaque appel, et la contrainte d'unicite porte sur le couple
      // (serveur, nom) - deux ecritures concurrentes se marcheraient dessus.
      for (const item of chosen) {
        await saveRpgItem({
          name: item.name,
          description: item.description,
          emoji: item.emoji,
          type: item.type,
          rarity: item.rarity,
          price: priceOf(item),
          purchasable: true,
          hpRestore: item.effect.hpRestore ?? 0,
          energyRestore: item.effect.energyRestore ?? 0,
          levelXpReward: item.effect.levelXpReward ?? 0,
        });
      }
      wizard.answer({ shopKeys: selection });
      celebrateStep();
      wizard.complete('economy-shop');
    } catch (err: any) {
      // Un objet deja present - parcours rejoue, catalogue importe - fait
      // echouer sa seule creation. On le dit sans defaire ce qui est passe.
      toast.info(err?.message || "Certains objets existaient déjà : ils n'ont pas été remplacés.");
      wizard.complete('economy-shop');
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_economy_shop_title()}
  lead={m.onb_economy_shop_lead()}
  {onEditTracks}
>
  <div class="space-y-2.5">
    {#each SHOP_PRESETS as item (item.key)}
      {@const picked = selection.includes(item.key)}
      <div>
        <ToggleCard
          label={item.name}
          pitch={item.description}
          emoji={item.emoji}
          selected={picked}
          onclick={() => toggle(item.key)}
        />

        {#if picked}
          <!-- Le prix vit sous la carte, pas dedans : un champ de saisie a
               l'interieur d'un bouton n'est ni valide ni utilisable au clavier.
               Il n'apparait qu'une fois l'objet retenu - regler le prix de ce
               qu'on ne vend pas n'aurait pas de sens. -->
          <div class="editor mt-1.5 ml-9 flex items-center gap-2 rounded-xl border border-outline-variant/25 bg-surface-container-lowest/40 px-3 py-2">
            <label for="price-{item.key}" class="text-[12px] text-on-surface-variant/55">
              {m.onb_economy_shop_price()}
            </label>
            <input
              id="price-{item.key}"
              type="number"
              min="0"
              step="10"
              value={priceOf(item)}
              oninput={(event) => { prices = { ...prices, [item.key]: Number(event.currentTarget.value) || 0 }; }}
              class="w-24 rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-2 py-1
                     text-[12.5px] tabular-nums text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <span class="text-[12px] text-on-surface-variant/50 truncate">{emoji} {currency}</span>
            <span class="ml-auto shrink-0 text-[11.5px] text-on-surface-variant/40">{effectOf(item)}</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <p class="mt-3 text-[12px] text-on-surface-variant/45 tabular-nums">
    {chosen.length > 0
      ? m.onb_economy_shop_selected({ count: chosen.length })
      : m.onb_economy_shop_empty()}
  </p>

  {#snippet preview()}
    <div class="rounded-xl overflow-hidden border border-black/25 shadow-sm">
      <div class="flex items-center gap-2 px-3.5 py-2.5 bg-[#2b2d31] border-b border-black/25">
        <Papicon icon="shopping-bag" size={13} class="text-[#80848e]" />
        <span class="text-[13px] font-semibold text-[#dbdee1] truncate">
          {m.onb_economy_shop_preview_title()}
        </span>
      </div>

      <div class="bg-[#313338] px-3.5 py-3 space-y-2 min-h-[200px]">
        {#each chosen as item (item.key)}
          <div class="flex items-center gap-2.5 rounded-md bg-[#2b2d31] px-2.5 py-2">
            <span class="text-[17px] leading-none shrink-0">{item.emoji}</span>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-medium text-[#f2f3f5] truncate">{item.name}</p>
              <p class="text-[11.5px] text-[#949ba4] truncate">{effectOf(item)}</p>
            </div>
            <span class="shrink-0 text-[12.5px] font-semibold tabular-nums text-[#f0b232]">
              {emoji} {priceOf(item).toLocaleString('fr-FR')}
            </span>
          </div>
        {:else}
          <p class="text-[12.5px] text-[#949ba4] py-8 text-center">{m.onb_economy_shop_empty()}</p>
        {/each}
      </div>
    </div>
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

<style>
  .editor {
    animation: unfold 200ms ease-out both;
  }

  @keyframes unfold {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .editor { animation: none; }
  }
</style>
