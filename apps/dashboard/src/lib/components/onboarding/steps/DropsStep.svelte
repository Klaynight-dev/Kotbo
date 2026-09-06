<script lang="ts">
  /**
   * Des recompenses qui tombent dans le salon.
   *
   * Un drop est une interruption : c'est ce qui fait sa valeur et ce qui fait
   * son danger. Toutes les six heures, on leve la tete ; toutes les vingt
   * minutes, on coupe le salon. L'ecran ne propose donc pas un champ
   * « intervalle en minutes » mais trois allures qui disent ce qu'on va vivre.
   *
   * Le type retenu est l'XP, et lui seul. C'est le seul qui fonctionne sans
   * rien d'autre : les pieces supposent une economie allumee, les points de
   * clan supposent des clans, un objet suppose un catalogue. Le parcours ne
   * peut pas savoir si ces modules seront la, et un drop qui annonce une
   * recompense que rien ne peut verser est pire que pas de drop du tout.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { DROP_RHYTHMS, celebrateStep, type DropRhythm } from '../../../onboarding';
  import { updateDropGlobalSettings, updateDropTypeSettings } from '../../../api';
  import ChannelPicker from '../ChannelPicker.svelte';
  import ChoiceCard from '../ChoiceCard.svelte';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const channels = $derived(onboardingData.channels);
  const rhythm = $derived<DropRhythm>(wizard.dropRhythm ?? 'standard');

  const suggested = $derived(
    channels.find((channel) => /general|général|chat|discussion/i.test(channel.name))?.id
      ?? channels[0]?.id
      ?? ''
  );
  const channelId = $derived(wizard.dropChannelId ?? suggested);
  const channelName = $derived(
    channels.find((channel) => channel.id === channelId)?.name ?? 'général'
  );

  const interval = $derived(
    DROP_RHYTHMS.find((entry) => entry.key === rhythm)?.intervalMinutes ?? 240
  );

  const panelColor = $derived(wizard.panelColor ?? '#10B981');

  async function apply() {
    if (onboardingData.busy) return;
    if (!channelId) {
      toast.error('Choisissez un salon où publier les drops.');
      return;
    }

    onboardingData.busy = true;
    try {
      await updateDropGlobalSettings({
        dropsEnabled: true,
        dropChannelId: channelId,
        // Une heure pour reagir : assez pour qu'un drop de nuit trouve preneur
        // au reveil, assez court pour qu'il ne traine pas trois jours.
        dropLifetimeMinutes: 60,
      });
      await updateDropTypeSettings('XP', {
        enabled: true,
        intervalMinutes: interval,
      });
      wizard.answer({ dropRhythm: rhythm, dropChannelId: channelId });
      celebrateStep();
      wizard.complete('animation-drops');
    } catch (err: any) {
      toast.error(err?.message || "Les drops n'ont pas pu être enregistrés.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_drops_title()}
  lead={m.onb_drops_lead()}
  {onEditTracks}
>
  <div class="space-y-7">
    <ChannelPicker
      id="drop-channel"
      label={m.onb_drops_channel_label()}
      purpose="drops"
      value={channelId}
      createLabel={m.onb_channel_create_drops()}
      onpick={(id) => wizard.answer({ dropChannelId: id })}
    />

    <div>
      <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_drops_rhythm_label()}</p>
      <div class="space-y-2.5">
        {#each DROP_RHYTHMS as entry (entry.key)}
          <ChoiceCard
            label={entry.label()}
            pitch={entry.pitch()}
            detail={entry.detail()}
            icon={entry.icon}
            selected={rhythm === entry.key}
            onclick={() => { wizard.answer({ dropRhythm: entry.key }); celebrateStep(); }}
          />
        {/each}
      </div>
    </div>
  </div>

  {#snippet preview()}
    <DiscordPreview channel={channelName}>
      <DiscordEmbed
        color={panelColor}
        title={`🎁 ${m.onb_drops_preview_title()}`}
        description={m.onb_drops_preview_line()}
        fields={[{ emoji: '⚡', name: 'Récompense', value: 'entre 50 et 250 XP' }]}
        buttons={[{ emoji: '🎁', label: m.onb_drops_preview_button() }]}
      />
    </DiscordPreview>

    <p class="mt-3 flex items-start gap-2 text-[12.5px] text-on-surface-variant/55 leading-relaxed">
      <Papicon icon="clock" size={13} class="mt-0.5 shrink-0 text-on-surface-variant/35" />
      <span>
        Environ toutes les {interval >= 60 ? `${Math.round(interval / 60)} h` : `${interval} min`},
        à heure imprévisible. Chaque drop reste ouvert une heure.
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
