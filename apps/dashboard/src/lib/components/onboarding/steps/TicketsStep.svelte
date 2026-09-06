<script lang="ts">
  /**
   * Les motifs du panneau de tickets, et la couleur des panneaux.
   *
   * Cet ecran precede la structure, et ce n'est pas negociable : la mise en
   * place publie le panneau de tickets. Le regler apres laisserait dans le
   * salon un panneau qui ignore les motifs et la couleur qu'on vient de
   * choisir, et le republier en poserait un second a cote du premier.
   *
   * La couleur ne change rien au fonctionnement - c'est la teinte des embeds
   * que Kotbo publie - et c'est justement pour cela qu'elle est ici : choisir
   * une couleur, c'est commencer a s'approprier ce qu'on installe.
   */
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    PANEL_COLORS,
    TICKET_PRESETS,
    celebrateStep,
    defaultTicketKeys,
    type ThemeKey,
  } from '../../../onboarding';
  import { fetchTicketsConfig, patchTicketsConfig, type TicketTypeConfig } from '../../../api';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const theme = $derived<ThemeKey>(wizard.theme ?? 'communaute');
  const panelColor = $derived(wizard.panelColor ?? PANEL_COLORS[0].value);

  /** Coches d'apres la vocation, tant que rien n'a ete touche a l'ecran. */
  let picked = $state<string[] | null>(null);
  const keys = $derived(picked ?? defaultTicketKeys(theme));
  const chosen = $derived(TICKET_PRESETS.filter((entry) => keys.includes(entry.key)));

  /**
   * Les motifs deja en base, ceux que la reprise a lus dans l'ancien panneau.
   *
   * Cet ecran ecrivait `ticketTypes` en entier : sur un serveur repris, il
   * effacait les motifs recuperes au profit des motifs types. Ils sont donc
   * charges d'abord, montres comme acquis, et les nouveaux s'ajoutent derriere.
   */
  let inherited = $state<TicketTypeConfig[]>([]);
  let loaded = $state(false);

  $effect(() => {
    if (loaded) return;
    loaded = true;
    void (async () => {
      const config = await fetchTicketsConfig().catch(() => null);
      const types = config?.ticketTypes;
      if (!Array.isArray(types)) return;

      inherited = types.filter(
        (type): type is TicketTypeConfig =>
          !!type && typeof type === 'object' && typeof (type as TicketTypeConfig).id === 'string',
      );
      // Un serveur qui a deja ses motifs n'en veut pas huit de plus : les
      // propositions partent decochees, a cocher une a une si besoin.
      if (inherited.length > 0 && picked === null) picked = [];
    })();
  });

  function toggle(key: string) {
    picked = keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
    celebrateStep();
  }

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      const inheritedIds = new Set(inherited.map((entry) => entry.id));
      // `patchTicketsConfig` relit la configuration avant de la renvoyer : la
      // route des tickets remplace tout ce qu'elle recoit, et un corps partiel
      // reinitialiserait les quotas, l'archivage et le reste.
      await patchTicketsConfig({
        ticketEmbedColor: panelColor,
        ticketTypes: [
          ...inherited,
          ...chosen
            .filter((entry) => !inheritedIds.has(entry.key))
            .map((entry) => ({
              id: entry.key,
              label: entry.label,
              description: entry.description,
              emoji: entry.emoji,
            })),
        ],
      }, undefined, { silent: true });
      celebrateStep();
      wizard.complete('tickets');
    } catch (err: any) {
      toast.error(err?.message || "Le support n'a pas pu être enregistré.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Pourquoi vous écrit-on ?"
  lead={inherited.length > 0
    ? `${inherited.length} motif(s) ont été repris de votre ancien panneau : ils restent tels quels. Cochez ce que vous voulez ajouter.`
    : 'Chaque motif retenu devient un bouton sur le panneau que Kotbo posera dans un instant. Un ticket ouvert crée un salon privé entre le membre et votre staff.'}
  {onEditTracks}
>
  {#if inherited.length > 0}
    <!-- Sans case a cocher : ces motifs sont acquis, et les presenter comme un
         choix ferait croire qu'on peut les perdre en decochant. -->
    <p class="mb-4 flex flex-wrap items-center gap-1.5 rounded-xl border border-outline-variant/25 bg-surface-container-lowest/30 px-3.5 py-3">
      <span class="mr-1 text-[12.5px] font-semibold uppercase tracking-wide text-on-surface-variant/45">
        Déjà repris
      </span>
      {#each inherited as type (type.id)}
        <span class="rounded-md bg-surface-container/70 px-1.5 py-0.5 text-[12px] text-on-surface-variant/70">
          {type.emoji ?? '🎫'} {type.label}
        </span>
      {/each}
    </p>
  {/if}

  <div class="grid gap-2 sm:grid-cols-2">
    {#each TICKET_PRESETS as preset (preset.key)}
      {@const selected = keys.includes(preset.key)}
      <button
        type="button"
        onclick={() => toggle(preset.key)}
        aria-pressed={selected}
        class="text-left rounded-xl border p-3.5 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
        {selected
          ? 'border-primary bg-primary/[0.05]'
          : 'border-outline-variant/35 hover:border-primary/40 hover:bg-surface-container-low/40'}"
      >
        <div class="flex items-center gap-2">
          <span class="text-[15px] leading-none">{preset.emoji}</span>
          <span class="text-[14px] font-semibold text-on-surface">{preset.label}</span>
          {#if selected}
            <span class="ml-auto w-4 h-4 shrink-0 rounded-full bg-primary text-on-primary flex items-center justify-center">
              <Papicon icon="check" size={10} />
            </span>
          {/if}
        </div>
        <p class="mt-1 text-[12.5px] text-on-surface-variant/60 leading-relaxed">{preset.description}</p>
      </button>
    {/each}
  </div>

  <div class="mt-6">
    <p class="flex items-center gap-2 text-[13px] font-semibold text-on-surface mb-2.5">
      <Papicon icon="palette" size={14} class="text-primary" />
      La couleur de vos panneaux
    </p>
    <div class="flex flex-wrap gap-2">
      {#each PANEL_COLORS as color (color.value)}
        <button
          type="button"
          onclick={() => { wizard.answer({ panelColor: color.value }); celebrateStep(); }}
          aria-pressed={panelColor === color.value}
          aria-label={color.label}
          title={color.label}
          class="w-9 h-9 rounded-xl border-2 transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
          {panelColor === color.value ? 'border-on-surface/70' : 'border-transparent'}"
          style="background-color: {color.value}"
        ></button>
      {/each}
    </div>
    <p class="mt-2 text-[12px] text-on-surface-variant/55 leading-relaxed">
      Elle vaut pour tous les panneaux que Kotbo publie : tickets, règlement, quêtes, drops.
    </p>
  </div>

  {#snippet preview()}
    <!-- Le panneau tel qu'il sera pose : les motifs repris d'abord, les ajouts
         ensuite. Juger les nouveaux boutons sans ceux qui les entourent ne dit
         pas de quoi le panneau aura l'air. -->
    {@const buttons = [
      ...inherited.map((type) => ({ emoji: type.emoji ?? '🎫', label: type.label })),
      ...chosen
        .filter((entry) => !inherited.some((type) => type.id === entry.key))
        .map((entry) => ({ emoji: entry.emoji, label: entry.label })),
    ]}
    <DiscordPreview channel="support">
      <DiscordEmbed
        color={panelColor}
        title="Besoin d'aide ?"
        description={buttons.length
          ? "Choisissez un motif ci-dessous : un salon privé s'ouvrira avec l'équipe."
          : "Aucun motif retenu : le panneau proposera un ticket générique."}
        {buttons}
      />
    </DiscordPreview>
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
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Enregistrer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
