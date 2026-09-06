<script lang="ts">
  /**
   * Ce que Kotbo garde de ce qui se dit, et pour combien de temps.
   *
   * C'est le module dont personne ne parle et que tout le monde veut le jour ou
   * il en a besoin : un membre signale un message, l'auteur l'a supprime, et
   * sans copie il n'y a plus rien a arbitrer. Le mettre dans le parcours plutot
   * que de le laisser dans une page du tableau de bord, c'est faire en sorte
   * qu'il soit en place avant le premier incident et non apres.
   *
   * Deux decisions seulement : ou publier, et combien de temps garder. Le reste
   * - salons ignores, categories d'evenements - se regle depuis la page Logs, et
   * ne se regle bien qu'une fois qu'on a vu passer quelque chose.
   *
   * L'apercu montre ce que le salon recevra. « Un message supprime reste
   * consultable » est une promesse ; l'embed qui l'affiche est la preuve.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { RETENTIONS, celebrateStep, type RetentionKey } from '../../../onboarding';
  import { updateGlobalSettings, updateMessageLogConfig } from '../../../api';
  import ChannelPicker from '../ChannelPicker.svelte';
  import ChoiceCard from '../ChoiceCard.svelte';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const retention = $derived<RetentionKey>(wizard.retention ?? 'standard');
  const channels = $derived(onboardingData.channels);

  /**
   * Le salon propose par defaut.
   *
   * La mise en place pose un `#logs` dans la categorie du staff et enregistre
   * son identifiant : quand elle est passee, il est deja choisi. Sinon, on
   * cherche un salon dont le nom en parle avant de laisser la liste vide -
   * demander de choisir parmi quarante salons sans rien suggerer, c'est
   * demander de chercher.
   *
   * Et quand cette recherche ne donne rien - piste « structure » decochee,
   * serveur habite sans salon d'equipe -, le parcours pose le salon lui-meme
   * plutot que de se terminer sur une journalisation qui ne publie nulle part.
   */
  const suggested = $derived(
    channels.find((channel) => /log|journ/i.test(channel.name))?.id ?? ''
  );
  const channelId = $derived(wizard.logChannelId ?? suggested);

  const chosenName = $derived(
    channels.find((channel) => channel.id === channelId)?.name ?? 'logs'
  );

  const days = $derived(
    RETENTIONS.find((entry) => entry.key === retention)?.days ?? 30
  );

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      // Deux ecritures, deux endroits : la conservation vit avec les journaux
      // de messages, le salon de publication avec les reglages de la guilde.
      await updateMessageLogConfig({ enabled: true, retentionDays: days });
      await updateGlobalSettings({ logChannelId: channelId || null });
      wizard.answer({ retention, logChannelId: channelId || null });
      celebrateStep();
      wizard.complete('logs');
    } catch (err: any) {
      toast.error(err?.message || "La journalisation n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_logs_title()}
  lead={m.onb_logs_lead()}
  {onEditTracks}
>
  <div class="space-y-7">
    <ChannelPicker
      id="logs-channel"
      label={m.onb_logs_channel_label()}
      hint={m.onb_logs_channel_hint()}
      purpose="logs"
      value={channelId}
      noneLabel={m.onb_logs_channel_none()}
      createLabel={m.onb_channel_create_logs()}
      suggested={!wizard.logChannelId && !!suggested}
      onpick={(id) => wizard.answer({ logChannelId: id })}
    />

    <div>
      <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_logs_retention_label()}</p>
      <div class="space-y-2.5">
        {#each RETENTIONS as entry (entry.key)}
          <ChoiceCard
            label={entry.label()}
            pitch={entry.pitch()}
            detail={entry.detail()}
            icon={entry.icon}
            selected={retention === entry.key}
            onclick={() => { wizard.answer({ retention: entry.key }); celebrateStep(); }}
          />
        {/each}
      </div>
    </div>
  </div>

  {#snippet preview()}
    <DiscordPreview channel={chosenName}>
      <DiscordEmbed
        color="#f23f43"
        title={m.onb_logs_preview_deleted()}
        fields={[
          { emoji: '👤', name: m.onb_logs_preview_author(), value: 'Maë · @mae' },
          { emoji: '#️⃣', name: m.onb_logs_preview_channel(), value: '#général' },
          { emoji: '💬', name: m.onb_logs_preview_content(), value: 'ce message a été supprimé par son auteur' },
        ]}
      />
    </DiscordPreview>

    <p class="mt-3 flex items-start gap-2 text-[12.5px] text-on-surface-variant/55 leading-relaxed">
      <Papicon icon="clock" size={13} class="mt-0.5 shrink-0 text-on-surface-variant/35" />
      <span>Conservé {days} jours, puis effacé automatiquement.</span>
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
