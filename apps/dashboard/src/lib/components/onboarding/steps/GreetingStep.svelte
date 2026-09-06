<script lang="ts">
  /**
   * Le premier message qu'un arrivant lit.
   *
   * Trois tons prets a poser : on part d'une phrase, on ne redige pas. Et
   * l'apercu montre le resultat, pas le gabarit - personne ne juge une phrase a
   * travers ses accolades et ses asterisques, et « est-ce que ca sonne bien ? »
   * redevient une question a laquelle on peut repondre.
   */
  import { authStore } from '../../../stores/auth.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { celebrateStep } from '../../../onboarding';
  import { fetchWelcomeConfig, updateWelcomeConfig } from '../../../api';
  import DiscordPreview from '../DiscordPreview.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const TONES = [
    { key: 'warm', label: 'Chaleureux', icon: 'heart', text: "Bienvenue {user} sur **{server}** ! Installe-toi, présente-toi, et n'hésite pas si tu as la moindre question. 🎉" },
    { key: 'plain', label: 'Sobre', icon: 'align-left', text: 'Bienvenue {user} sur **{server}**. Merci de lire le règlement avant de participer.' },
    { key: 'playful', label: 'Enjoué', icon: 'star', text: 'Un nouveau membre est apparu ! {user} rejoint **{server}**. 👋 Fais-toi plaisir, on ne mord pas.' },
  ];

  let message = $state('');
  let loaded = $state(false);

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  /** Le gabarit, avec ses variables remplacees : c'est ce que l'arrivant lira. */
  const rendered = $derived(
    message
      .replaceAll('{user}', `@${authStore.user?.username ?? 'nouveau'}`)
      .replaceAll('{server}', selectedGuild?.name ?? 'votre serveur')
  );

  $effect(() => {
    if (loaded) return;
    loaded = true;
    void (async () => {
      try {
        const config = await fetchWelcomeConfig();
        message = config?.welcomeMessage
          || 'Bienvenue {user} sur **{server}** ! Prends le temps de lire le règlement. 🎉';
      } catch {
        message = 'Bienvenue {user} ! Prends le temps de lire le règlement. 🎉';
      }
    })();
  });

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await updateWelcomeConfig(
        { welcomeEnabled: true, welcomeMessage: message },
        undefined,
        { silent: true },
      );
      celebrateStep();
      wizard.complete('greeting');
    } catch (err: any) {
      toast.error(err?.message || "Le message d'accueil n'a pas pu être enregistré.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Comment accueillir les arrivants ?"
  lead="Ce message part automatiquement à chaque arrivée. Un serveur qui n'accueille pas perd la moitié de ses arrivants dans la première heure."
  {onEditTracks}
>
  <div class="flex flex-wrap gap-2 mb-4">
    {#each TONES as tone (tone.key)}
      <button
        type="button"
        onclick={() => { message = tone.text; celebrateStep(); }}
        class="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-low/40 px-3 py-1.5 text-[12.5px] font-medium text-on-surface-variant/80
               hover:border-primary/45 hover:text-on-surface transition-colors"
      >
        <Papicon icon={tone.icon} size={13} />
        {tone.label}
      </button>
    {/each}
  </div>

  <label for="welcome-message" class="block text-[13px] font-semibold text-on-surface mb-2">
    Message de bienvenue
  </label>
  <textarea
    id="welcome-message"
    bind:value={message}
    rows="5"
    class="w-full rounded-xl border border-outline-variant/40 bg-surface-container-low/40 px-4 py-3 text-[14px] text-on-surface
           placeholder-on-surface-variant/40 focus:outline-none focus:border-primary/50 resize-none"
    placeholder="Bienvenue {'{user}'} !"
  ></textarea>

  <p class="mt-2 text-[12px] text-on-surface-variant/55 leading-relaxed">
    <code class="px-1 py-0.5 rounded bg-surface-container text-on-surface-variant">{'{user}'}</code>
    mentionne l'arrivant,
    <code class="px-1 py-0.5 rounded bg-surface-container text-on-surface-variant">{'{server}'}</code>
    donne le nom du serveur. Les deux sont remplacés à l'envoi.
  </p>

  {#snippet preview()}
    <DiscordPreview channel="bienvenue" content={rendered} />
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy || !message.trim()}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Enregistrer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
