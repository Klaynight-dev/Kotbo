<script lang="ts">
  /**
   * Nommer sa monnaie.
   *
   * C'est le seul ecran du parcours dont la reponse n'a aucune consequence
   * technique, et c'est probablement celui qu'on retient. Un serveur qui a
   * appele sa monnaie « Croquettes » a fait quelque chose de personnel avec un
   * produit qu'il decouvre depuis dix minutes, et ce sont ces choses-la qu'on
   * n'abandonne pas a l'ecran suivant.
   *
   * Le rythme se choisit ensuite, en trois allures plutot qu'en cinq champs. Ce
   * qui distingue reellement deux economies de serveur, c'est la vitesse a
   * laquelle on accumule : une monnaie qui pleut ne s'echange plus contre rien,
   * une monnaie rare ne circule pas. Le detail - montants exacts, recharge - se
   * regle depuis la page Economie, une fois qu'on a vu ce que les membres font
   * de leurs pieces.
   */
  import { m } from '../../../i18n';
  import { authStore } from '../../../stores/auth.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    CURRENCY_SUGGESTIONS,
    ECONOMY_RHYTHMS,
    celebrateStep,
    type EconomyRhythm,
  } from '../../../onboarding';
  import { updateEconomyConfig } from '../../../api';
  import ChoiceCard from '../ChoiceCard.svelte';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import EmojiPicker from '../../EmojiPicker.svelte';
  import EmojiText from '../../EmojiText.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const name = $derived(wizard.currencyName ?? 'Pièces');
  const emoji = $derived(wizard.currencyEmoji ?? '🪙');
  const rhythm = $derived<EconomyRhythm>(wizard.economyRhythm ?? 'standard');

  /**
   * Le selecteur n'expose qu'une valeur liee, alors que la monnaie vit dans le
   * parcours : on consomme le choix des qu'il arrive, puis on remet a vide pour
   * que le meme emoji puisse etre rechoisi.
   */
  let pickedEmoji = $state('');
  $effect(() => {
    if (!pickedEmoji) return;
    const chosen = pickedEmoji;
    pickedEmoji = '';
    wizard.answer({ currencyEmoji: chosen });
  });

  /** Un emoji du serveur s'ecrit `<:nom:id>` : il s'affiche, il ne se tape pas. */
  const isCustomEmoji = $derived(/^<a?:\w{2,32}:\d{15,25}>$/.test(emoji));

  const config = $derived(
    ECONOMY_RHYTHMS.find((entry) => entry.key === rhythm)?.config ?? ECONOMY_RHYTHMS[1].config
  );

  // Le montant montre dans l'apercu : le milieu de la fourchette, pas son
  // maximum. Annoncer 300 pour un tirage entre 120 et 300 serait une promesse
  // que le premier /daily dementirait.
  const sample = $derived(Math.round((config.dailyRewardMin + config.dailyRewardMax) / 2));

  const panelColor = $derived(wizard.panelColor ?? '#F59E0B');

  async function apply() {
    if (onboardingData.busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Donnez un nom à votre monnaie.');
      return;
    }

    onboardingData.busy = true;
    try {
      await updateEconomyConfig({
        enabled: true,
        // La boutique s'allume ici et se remplit a l'ecran suivant : l'ouvrir
        // apres coup demanderait une seconde ecriture pour rien.
        shopEnabled: true,
        currencyName: trimmed,
        currencyEmoji: emoji,
        ...config,
      });
      wizard.answer({ currencyName: trimmed, currencyEmoji: emoji, economyRhythm: rhythm });
      celebrateStep();
      wizard.complete('economy');
    } catch (err: any) {
      toast.error(err?.message || "L'économie n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_economy_title()}
  lead={m.onb_economy_lead()}
  {onEditTracks}
>
  <div class="space-y-7">
    <div class="flex gap-3">
      <div class="w-[140px] shrink-0">
        <label for="currency-emoji" class="block text-[13px] font-semibold text-on-surface mb-1.5">
          {m.onb_economy_emoji_label()}
        </label>
        <div class="flex items-center gap-1.5">
          {#if isCustomEmoji}
            <button
              type="button"
              id="currency-emoji"
              onclick={() => wizard.answer({ currencyEmoji: '🪙' })}
              title={m.onb_economy_emoji_clear()}
              class="flex h-11 flex-1 items-center justify-center rounded-xl border border-outline-variant/40
                     bg-surface-container-lowest/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <EmojiText value={emoji} size="1.5rem" />
            </button>
          {:else}
            <input
              id="currency-emoji"
              value={emoji}
              maxlength="4"
              oninput={(event) => wizard.answer({ currencyEmoji: event.currentTarget.value })}
              class="h-11 min-w-0 flex-1 rounded-xl border border-outline-variant/40 bg-surface-container-lowest/60 px-3
                     text-center text-[20px] leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          {/if}
          <EmojiPicker bind:value={pickedEmoji} />
        </div>
      </div>

      <div class="flex-1 min-w-0">
        <label for="currency-name" class="block text-[13px] font-semibold text-on-surface mb-1.5">
          {m.onb_economy_name_label()}
        </label>
        <input
          id="currency-name"
          value={name}
          maxlength="24"
          oninput={(event) => wizard.answer({ currencyName: event.currentTarget.value })}
          class="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest/60 px-3.5 py-2.5
                 text-[14px] text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      </div>
    </div>

    <div>
      <p class="text-[12.5px] text-on-surface-variant/50 mb-2">{m.onb_economy_suggestions()}</p>
      <div class="flex flex-wrap gap-2">
        <!-- Le nom du serveur en tete de liste : « Les Kotbos » se lit mieux que
             « Pièces », et c'est la suggestion qu'on ne pouvait pas ecrire a
             l'avance. -->
        {#each [
          ...(authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
            ? [{ name: authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)!.name.slice(0, 20), emoji: '✨' }]
            : []),
          ...CURRENCY_SUGGESTIONS,
        ] as suggestion (suggestion.name)}
          <button
            type="button"
            onclick={() => { wizard.answer({ currencyName: suggestion.name, currencyEmoji: suggestion.emoji }); celebrateStep(); }}
            class="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 px-3 py-1.5
                   text-[12.5px] font-medium text-on-surface-variant/75 hover:border-primary/45 hover:text-on-surface transition-colors"
          >
            <span>{suggestion.emoji}</span>
            {suggestion.name}
          </button>
        {/each}
      </div>
    </div>

    <div>
      <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_economy_rhythm_label()}</p>
      <div class="space-y-2.5">
        {#each ECONOMY_RHYTHMS as entry (entry.key)}
          <ChoiceCard
            label={entry.label()}
            pitch={entry.pitch()}
            detail={entry.detail()}
            icon={entry.icon}
            selected={rhythm === entry.key}
            onclick={() => { wizard.answer({ economyRhythm: entry.key }); celebrateStep(); }}
          />
        {/each}
      </div>
    </div>
  </div>

  {#snippet preview()}
    <DiscordPreview channel="économie">
      <DiscordEmbed
        color={panelColor}
        title={m.onb_economy_preview_daily()}
        description={m.onb_economy_preview_daily_line({
          amount: `${emoji} ${sample}`,
          currency: name.trim() || 'pièces',
          hours: config.dailyCooldownHour,
        })}
        fields={[
          { emoji, name: m.onb_economy_preview_balance(), value: `${(sample * 7).toLocaleString('fr-FR')} ${name.trim() || 'pièces'}` },
        ]}
      />
    </DiscordPreview>

    <p class="mt-3 flex items-start gap-2 text-[12.5px] text-on-surface-variant/55 leading-relaxed">
      <Papicon icon="info" size={13} class="mt-0.5 shrink-0 text-on-surface-variant/35" />
      <span>
        Entre {config.dailyRewardMin} et {config.dailyRewardMax} par jour, une fois toutes les {config.dailyCooldownHour} h.
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
      {onboardingData.busy ? 'Enregistrement…' : 'Continuer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
