<script lang="ts">
  /**
   * Le rythme des niveaux, et les roles a debloquer.
   *
   * La page Niveaux du tableau de bord expose l'XP par message, le palier
   * vocal, le delai anti-farm et la courbe. Ici, on choisit une allure : le
   * detail se regle apres, quand on a vu tourner le systeme et qu'on sait ce
   * qu'on veut corriger.
   *
   * Les paliers, eux, se heurtaient au meme mur que l'ecran d'equipe : trois
   * listes deroulantes qui supposaient qu'on possede deja des roles a offrir.
   * Sur un serveur neuf il n'y en a aucun, et la progression s'activait donc
   * sans rien a gagner - un systeme de niveaux dont aucun palier ne debloque
   * quoi que ce soit, c'est-a-dire un compteur.
   *
   * Kotbo pose donc l'echelle lui-meme : un nom de famille - metaux,
   * anciennete, grades - et un nombre de roles. Les paliers ne sont pas
   * calcules par une formule unique mais tabules : a trois roles on veut une
   * echelle qui couvre toute la vie du serveur, a huit une echelle qui se
   * resserre au debut, la ou les premiers paliers doivent tomber vite.
   *
   * L'apercu montre la montee de niveau telle qu'elle sera annoncee dans le
   * salon. C'est ce message-la qui fait qu'on regarde sa progression, et c'est
   * lui qu'il faut voir pour juger le rythme.
   */
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    LADDER_COUNTS,
    LEVEL_LADDERS,
    LEVEL_RHYTHMS,
    PANEL_COLORS,
    REWARD_TIERS,
    buildLevelLadder,
    celebrateStep,
    toRoleRequests,
    type LevelLadderKey,
    type LevelRhythm,
  } from '../../../onboarding';
  import { addLevelingReward, createOnboardingRoles, updateLevelingConfig } from '../../../api';
  import ChoiceCard from '../ChoiceCard.svelte';
  import DiscordPreview from '../DiscordPreview.svelte';
  import DiscordEmbed from '../DiscordEmbed.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const rhythm = $derived<LevelRhythm>(wizard.rhythm ?? 'standard');
  const roles = $derived(onboardingData.roles);
  const panelColor = $derived(wizard.panelColor ?? PANEL_COLORS[0].value);

  const config = $derived(
    LEVEL_RHYTHMS.find((entry) => entry.key === rhythm)?.config ?? LEVEL_RHYTHMS[1].config
  );

  // ── Les roles de palier ────────────────────────────────────────────────────

  /**
   * Creer l'echelle, ou rattacher des roles existants.
   *
   * Le defaut suit ce que le serveur porte : sans role attribuable, il n'y a
   * rien a rattacher, et proposer trois listes vides serait proposer une
   * impasse.
   */
  let chosenMode = $state<'create' | 'existing' | null>(null);
  const mode = $derived(chosenMode ?? (roles.length === 0 ? 'create' : 'existing'));

  let ladderKey = $state<LevelLadderKey>('metals');
  let count = $state(5);

  const ladderPreset = $derived(
    LEVEL_LADDERS.find((entry) => entry.key === ladderKey) ?? LEVEL_LADDERS[0]
  );
  /** Du dernier palier au premier : c'est l'ordre de creation, pas d'affichage. */
  const ladder = $derived(buildLevelLadder(ladderPreset, count));
  const ladderAscending = $derived([...ladder].reverse());

  /** Rattachements a la main, quand on part de roles qui existent. */
  let rewards = $state<Record<number, string>>({});

  const firstReward = $derived(
    mode === 'create'
      ? ladderAscending[0]?.name ?? null
      : roles.find((role) => role.id === rewards[REWARD_TIERS[0]])?.name ?? null
  );
  const firstTier = $derived(
    mode === 'create' ? ladderAscending[0]?.level ?? REWARD_TIERS[0] : REWARD_TIERS[0]
  );

  /**
   * Enregistre un palier sans laisser un doublon arreter les autres.
   *
   * La table impose un role par niveau et par serveur : un palier deja pris
   * fait echouer sa seule ligne, et le reste doit passer quand meme.
   */
  async function grant(level: number, roleId: string) {
    try {
      await addLevelingReward(level, roleId, undefined, { silent: true });
    } catch {
      toast.info(`Le palier ${level} avait déjà une récompense : il n'a pas été remplacé.`);
    }
  }

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await updateLevelingConfig({ enabled: true, ...config }, undefined, { silent: true });

      if (mode === 'create') {
        // Les roles d'abord, les paliers ensuite : un palier ne peut pas
        // pointer sur un role qui n'existe pas encore.
        const result = await createOnboardingRoles(toRoleRequests(ladder));
        for (const warning of result.warnings) toast.info(warning);

        const levelOf = new Map(ladder.map((entry) => [entry.key, entry.level]));
        for (const created of result.roles) {
          const level = levelOf.get(created.key);
          if (level !== undefined) await grant(level, created.id);
        }

        await onboardingData.loadGuild(true);
        const posed = result.roles.filter((entry) => entry.created).length;
        if (posed > 0) toast.success(`${posed} rôle${posed > 1 ? 's' : ''} de palier créé${posed > 1 ? 's' : ''}.`);
      } else {
        for (const level of REWARD_TIERS) {
          const roleId = rewards[level];
          if (roleId) await grant(level, roleId);
        }
      }

      celebrateStep();
      wizard.complete('levels');
    } catch (err: any) {
      toast.error(err?.message || "La progression n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Faut-il récompenser les membres actifs ?"
  lead="Chaque message et chaque minute en vocal rapportent de l'expérience. Les membres montent en niveau, et peuvent gagner des rôles en chemin."
  {onEditTracks}
>
  <div class="space-y-3">
    {#each LEVEL_RHYTHMS as entry (entry.key)}
      <ChoiceCard
        label={entry.label}
        pitch={entry.pitch}
        detail={entry.detail}
        icon={entry.icon}
        selected={rhythm === entry.key}
        badge={entry.key === 'standard' ? 'Recommandé' : undefined}
        onclick={() => { wizard.answer({ rhythm: entry.key }); celebrateStep(); }}
      />
    {/each}
  </div>

  <div class="mt-6">
    <p class="flex items-center gap-2 text-[13px] font-semibold text-on-surface mb-1">
      <Papicon icon="award" size={14} class="text-primary" />
      Des rôles à débloquer
      <span class="font-normal text-on-surface-variant/50">- facultatif</span>
    </p>
    <p class="text-[12.5px] text-on-surface-variant/60 leading-relaxed mb-3">
      Le rôle est donné automatiquement au passage du niveau. C'est ce qui fait qu'on
      regarde sa progression.
    </p>

    <div class="grid gap-2.5 sm:grid-cols-2 mb-5">
      <ChoiceCard
        label="Créer l'échelle pour moi"
        pitch="Kotbo pose les rôles et leurs paliers"
        icon="sparkles"
        selected={mode === 'create'}
        onclick={() => { chosenMode = 'create'; }}
      />
      <ChoiceCard
        label="Utiliser mes rôles"
        pitch="Vous rattachez vos rôles aux paliers"
        icon="users"
        selected={mode === 'existing'}
        onclick={() => { chosenMode = 'existing'; }}
      />
    </div>

    {#if mode === 'create'}
      <div class="space-y-2.5">
        {#each LEVEL_LADDERS as entry (entry.key)}
          <ChoiceCard
            label={entry.label}
            pitch={entry.pitch}
            icon={entry.icon}
            selected={ladderKey === entry.key}
            onclick={() => { ladderKey = entry.key; celebrateStep(); }}
          />
        {/each}
      </div>

      <div class="mt-5">
        <p class="text-[13px] font-semibold text-on-surface mb-2">Combien de rôles ?</p>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Nombre de rôles à débloquer">
          {#each LADDER_COUNTS as option (option)}
            <button
              type="button"
              role="radio"
              aria-checked={count === option}
              onclick={() => { count = option; celebrateStep(); }}
              class="min-w-13 rounded-xl border px-3.5 py-2 text-[13.5px] font-semibold tabular-nums transition
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                     {count === option
                       ? 'border-primary bg-primary/[0.07] text-primary'
                       : 'border-outline-variant/40 text-on-surface-variant/70 hover:border-primary/45'}"
            >
              {option}
            </button>
          {/each}
        </div>
        <p class="mt-2 text-[12.5px] text-on-surface-variant/50 leading-relaxed">
          <!-- Le dernier palier est ce qui se lit en premier : c'est lui qui dit
               si l'échelle couvre un mois ou deux ans. -->
          Du niveau {ladderAscending[0]?.level} au niveau {ladderAscending[ladderAscending.length - 1]?.level}.
        </p>
      </div>
    {:else if roles.length === 0}
      <p class="rounded-xl border border-outline-variant/30 bg-surface-container-low/30 px-4 py-3 text-[13px] text-on-surface-variant/60">
        Aucun rôle attribuable n'a été trouvé. Choisissez « Créer l'échelle pour moi », ou
        ajoutez vos paliers plus tard depuis la page Niveaux.
      </p>
    {:else}
      <div class="space-y-2">
        {#each REWARD_TIERS as level (level)}
          <div class="flex items-center gap-3 rounded-xl border border-outline-variant/35 bg-surface-container-low/25 px-4 py-2.5">
            <span class="shrink-0 inline-flex items-center gap-1.5 text-[13px] font-semibold text-on-surface">
              <span class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-[12px] font-bold">
                {level}
              </span>
              Niveau {level}
            </span>
            <select
              bind:value={rewards[level]}
              aria-label={`Rôle offert au niveau ${level}`}
              class="flex-1 min-w-0 rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-1.5 text-[13px] text-on-surface focus:outline-none focus:border-primary/50"
            >
              <option value={undefined}>Aucun rôle</option>
              {#each roles as role (role.id)}
                <option value={role.id}>@{role.name}</option>
              {/each}
            </select>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#snippet preview()}
    <DiscordPreview channel="niveaux">
      <DiscordEmbed
        color={panelColor}
        title={`🎉 Niveau ${firstTier} atteint !`}
        description="Maë vient de passer un palier."
        fields={[
          { emoji: '⚡', name: 'Gain par message', value: `${config.xpMin} à ${config.xpMax} XP` },
          { emoji: '🎧', name: 'Gain en vocal', value: `${config.vocalXpPerMin} XP par minute` },
          ...(firstReward
            ? [{ emoji: '🏅', name: 'Rôle débloqué', value: `@${firstReward}` }]
            : []),
        ]}
      />
    </DiscordPreview>

    {#if mode === 'create'}
      <!-- L'échelle entière, sous l'annonce : c'est en la voyant d'un bloc qu'on
           juge si huit paliers sont huit paliers de trop. -->
      <div class="mt-3 rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 p-4">
        <p class="text-[12.5px] font-semibold text-on-surface mb-3">Les paliers posés</p>
        <div class="space-y-1.5">
          {#each ladderAscending as role (role.key)}
            <div class="flex items-center gap-2.5">
              <span class="w-9 shrink-0 text-[11.5px] font-semibold tabular-nums text-on-surface-variant/45">
                {role.level}
              </span>
              <span class="w-2 h-2 rounded-full shrink-0" style="background-color: {role.color}"></span>
              <span class="text-[13px] text-on-surface-variant/80 truncate">{role.name}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <p class="mt-3 flex items-start gap-2 text-[12.5px] text-on-surface-variant/55 leading-relaxed">
      <Papicon icon="clock" size={13} class="mt-0.5 shrink-0 text-on-surface-variant/35" />
      <span>
        Un message ne rapporte qu'une fois toutes les {config.cooldownSeconds} s : c'est ce qui
        empêche de monter en écrivant vite plutôt qu'en participant.
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
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Activer la progression'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
