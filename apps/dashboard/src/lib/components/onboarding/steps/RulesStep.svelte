<script lang="ts">
  /**
   * Un reglement pret a publier, qu'on ajuste plutot qu'on ne redige.
   *
   * Personne n'ecrit huit articles depuis une page blanche le jour ou il
   * decouvre un bot. Ceux-ci couvrent ce qu'on retrouve sur presque tous les
   * serveurs ; ils s'editent sur place, et c'est cette edition qui fait qu'on
   * les considere comme les siens - pas le fait d'avoir coche des cases.
   */
  import { authStore } from '../../../stores/auth.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { PANEL_COLORS, RULE_PRESETS, celebrateStep } from '../../../onboarding';
  import { createRegulationArticle, fetchGuildState, publishRegulation } from '../../../api';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );
  const panelColor = $derived(wizard.panelColor ?? PANEL_COLORS[0].value);

  /** Les articles retenus, editables : c'est l'edition qui en fait les siens. */
  let rules = $state(
    RULE_PRESETS.map((preset) => ({
      key: preset.key,
      emoji: preset.emoji,
      title: preset.title,
      description: preset.description,
      selected: preset.byDefault,
    }))
  );
  let editing = $state<string | null>(null);

  /**
   * Le reglement deja en base, celui que la reprise vient d'importer.
   *
   * Un serveur habite arrive ici avec ses regles - lues dans le salon de son
   * ancien bot, ou ecrites a la main un jour. Reproposer les huit articles types
   * par-dessus donnerait un reglement en double : ce qu'on a deja est montre en
   * grise, et les propositions se decochent d'elles-memes.
   */
  let existing = $state<{ id: string; title: string; description: string; emoji: string | null }[]>([]);
  let loaded = $state(false);

  /** Deux titres se valent quand ils disent la meme chose sans la ponctuation. */
  const normalize = (title: string) =>
    title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

  $effect(() => {
    if (loaded) return;
    loaded = true;
    void (async () => {
      try {
        const state = await fetchGuildState();
        existing = (state?.regulationRules ?? []).filter((rule: { enabled?: boolean }) => rule.enabled !== false);
      } catch {
        // Un etat illisible ne bloque pas l'ecran : au pire, on repropose ce
        // qui existe deja, et le staff decoche.
        return;
      }

      if (existing.length === 0) return;
      const taken = new Set(existing.map((rule) => normalize(rule.title)));
      rules = rules.map((rule) => ({ ...rule, selected: rule.selected && !taken.has(normalize(rule.title)) }));
    })();
  });

  const chosen = $derived(rules.filter((rule) => rule.selected));
  const incomplete = $derived(chosen.some((rule) => !rule.title.trim() || !rule.description.trim()));
  /** Le reglement tel qu'il sera publie : l'acquis d'abord, les ajouts ensuite. */
  const published = $derived([
    ...existing.map((rule) => ({ emoji: rule.emoji ?? '', title: rule.title, description: rule.description })),
    ...chosen.map((rule) => ({ emoji: rule.emoji, title: rule.title, description: rule.description })),
  ]);

  async function apply() {
    if (onboardingData.busy) return;
    // Rien a ecrire et rien en base : il n'y a pas de reglement a publier.
    // Rien a ecrire mais un reglement importe : il reste a poser sur Discord.
    if (chosen.length === 0 && existing.length === 0) {
      wizard.complete('rules');
      return;
    }

    onboardingData.busy = true;
    try {
      // En serie et non en parallele : la route renumerote tout le reglement a
      // chaque creation, et deux ecritures concurrentes se disputeraient l'ordre.
      for (const rule of chosen) {
        // `dashboardMutation` rend un booleen et a deja signale l'echec : on
        // s'arrete la plutot que d'annoncer un reglement publie a moitie.
        const ok = await createRegulationArticle({
          title: rule.title.trim(),
          description: rule.description.trim(),
          emoji: rule.emoji,
          enabled: true,
        }, undefined, { silent: true });
        if (!ok) return;
      }

      // La publication demande un salon de reglement. La maquette en pose un,
      // mais un serveur habite peut ne pas en avoir : l'echec ne perd rien -
      // les articles sont ecrits et la page Règlement les publiera.
      try {
        await publishRegulation(undefined, { silent: true });
      } catch {
        toast.info("Le règlement est enregistré. Il sera publié depuis le tableau de bord, une fois son salon choisi.");
      }

      celebrateStep();
      wizard.complete('rules');
    } catch (err: any) {
      toast.error(err?.message || "Le règlement n'a pas pu être enregistré.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Quelles règles sur ce serveur ?"
  lead={existing.length > 0
    ? `Votre règlement compte déjà ${existing.length} article(s) : ils restent tels quels. Ajoutez seulement ce qui manque.`
    : 'Décochez ce qui ne vous ressemble pas, réécrivez le reste. Kotbo publiera le règlement dans son salon.'}
  {onEditTracks}
>
  {#if existing.length > 0}
    <!-- En grise et sans case : ces articles sont acquis, les remontrer comme
         un choix ferait croire qu'on peut les perdre en decochant. -->
    <section class="mb-4 rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/30 p-4">
      <h2 class="text-[12.5px] font-semibold uppercase tracking-wide text-on-surface-variant/45">
        Déjà en place
      </h2>
      <ul class="mt-2 space-y-1.5">
        {#each existing as rule (rule.id)}
          <li class="flex items-start gap-2 text-[13px] text-on-surface-variant/55">
            <Papicon icon="check" size={12} class="mt-1 shrink-0 text-emerald-500/60" />
            <span class="min-w-0">
              {#if rule.emoji}<span class="mr-1">{rule.emoji}</span>{/if}{rule.title}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="space-y-2">
    {#each rules as rule (rule.key)}
      <div
        class="rounded-2xl border transition-colors
        {rule.selected ? 'border-primary/45 bg-primary/[0.04]' : 'border-outline-variant/35 bg-surface-container-low/20'}"
      >
        <div class="flex items-start gap-3 p-4">
          <button
            type="button"
            onclick={() => { rule.selected = !rule.selected; celebrateStep(); }}
            aria-pressed={rule.selected}
            aria-label={rule.selected ? `Retirer « ${rule.title} »` : `Ajouter « ${rule.title} »`}
            class="mt-0.5 w-5 h-5 shrink-0 rounded-md border flex items-center justify-center transition-colors
            {rule.selected
              ? 'bg-primary border-primary text-on-primary'
              : 'border-outline-variant/60 text-transparent hover:border-primary/50'}"
          >
            <Papicon icon="check" size={11} />
          </button>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[15px] leading-none">{rule.emoji}</span>
              <p class="text-[14px] font-semibold text-on-surface">{rule.title}</p>
              {#if rule.selected}
                <button
                  type="button"
                  onclick={() => (editing = editing === rule.key ? null : rule.key)}
                  class="ml-auto shrink-0 inline-flex items-center gap-1 text-[12px] font-medium text-on-surface-variant/55 hover:text-primary transition-colors"
                >
                  <Papicon icon="pencil" size={11} />
                  {editing === rule.key ? 'Terminer' : 'Modifier'}
                </button>
              {/if}
            </div>

            {#if editing === rule.key}
              <!-- Le titre s'edite au meme titre que le texte : c'est lui qu'on
                   lit en premier dans le reglement publie, et le laisser fige
                   revenait a proposer d'ecrire ses regles sans pouvoir les
                   nommer. -->
              <input
                bind:value={rule.title}
                maxlength="80"
                aria-label="Titre de l'article"
                class="mt-2 w-full rounded-lg border border-outline-variant/40 bg-surface-container-low/50 px-3 py-2 text-[13px] font-semibold text-on-surface
                       focus:outline-none focus:border-primary/50"
              />
              <textarea
                bind:value={rule.description}
                rows="3"
                aria-label="Texte de l'article"
                class="mt-2 w-full rounded-lg border border-outline-variant/40 bg-surface-container-low/50 px-3 py-2 text-[13px] text-on-surface
                       focus:outline-none focus:border-primary/50 resize-none"
              ></textarea>
            {:else}
              <p class="mt-1 text-[13px] text-on-surface-variant/65 leading-relaxed">{rule.description}</p>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>

  {#snippet preview()}
    <!-- L'apercu montre le reglement publie, donc l'existant et les ajouts
         ensemble : juger les nouveaux articles hors de ceux qui les entourent
         ne dit pas si l'ensemble se tient. -->
    {#if published.length}
      <DiscordPreview channel="règlement">
        <DiscordEmbed
          color={panelColor}
          title={`Règlement de ${selectedGuild?.name ?? 'votre serveur'}`}
          description="En participant à ce serveur, vous acceptez les règles suivantes."
          fields={published.map((rule) => ({ emoji: rule.emoji, name: rule.title, value: rule.description }))}
        />
      </DiscordPreview>
    {:else}
      <p class="rounded-xl border border-outline-variant/30 bg-surface-container-low/30 px-4 py-3 text-[13px] text-on-surface-variant/60 leading-relaxed">
        Aucun article retenu : rien ne sera publié. Vous pourrez écrire votre règlement
        depuis le tableau de bord.
      </p>
    {/if}
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
      disabled={onboardingData.busy || incomplete}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {#if onboardingData.busy}
        Publication…
      {:else if chosen.length && existing.length}
        Ajouter {chosen.length} article(s)
      {:else if chosen.length}
        Publier {chosen.length} articles
      {:else if existing.length}
        Publier le règlement
      {:else}
        Continuer
      {/if}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
