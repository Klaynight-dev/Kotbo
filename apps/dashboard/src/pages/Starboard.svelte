<script lang="ts">
  /**
   * Configuration de Starlight.
   *
   * La page suit l'ordre de lecture du module : où l'on publie et à partir de
   * quel score, avec quels emojis on vote, ce que le bot amorce de lui-même,
   * quels salons sont concernés, puis ce qu'il advient d'un highlight qui
   * retombe. Chaque section correspond à un bloc du schéma.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import EmojiListInput from '../lib/components/EmojiListInput.svelte';
  import FormColorPicker from '../lib/components/FormColorPicker.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import {
    fetchStarboardConfig,
    updateStarboardConfig,
    type StarboardConfigPayload,
  } from '../lib/api';

  const saveAction = createAsyncActionState();
  let loading = $state(true);
  let loadError = $state('');

  /**
   * `enabled` n'apparaît pas ici : l'interrupteur du module appartient à
   * l'en-tête de `ModulePage`, qui passe par la bascule commune à tous les
   * modules. Le renvoyer dans ce formulaire écraserait cette bascule avec un
   * état chargé avant elle.
   */
  type StarboardForm = Omit<StarboardConfigPayload, 'enabled'>;

  const DEFAULTS: StarboardForm = {
    channelId: null,
    upvoteEmojis: ['👍'],
    downvoteEmojis: ['👎'],
    threshold: 5,
    countEmbedReactions: true,
    autoReactEmbed: true,
    autoReactChannels: [],
    watchedChannels: [],
    ignoredChannels: [],
    allowBots: false,
    embedColor: '#F5C518',
    removeBelowThreshold: true,
  };

  // Copie profonde : un spread laisserait les deux états partager les mêmes
  // tableaux, et la comparaison « modifié / enregistré » ne verrait plus rien.
  let config = $state<StarboardForm>(structuredClone(DEFAULTS));
  let savedConfig = $state<StarboardForm>(structuredClone(DEFAULTS));

  const canConfigure = $derived(
    !!dashboardStore.state.featureAccess?.starboard?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(
    (dashboardStore.state.discordChannels || []).map((c: any) => ({
      id: c.id,
      name: channelDisplayName(c),
    }))
  );

  // L'API refuse d'allumer le module sans salon de publication : on le dit ici
  // plutôt que de laisser l'admin découvrir l'erreur à l'enregistrement.
  const missingChannel = $derived(!config.channelId);

  $effect(() => {
    const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
    if (dirty && canConfigure) {
      untrack(() => {
        unsavedChanges.register({
          id: 'starboard',
          label: m.starboard_page_title(),
          onSave: () => handleSave(),
          onReset: () => {
            config = $state.snapshot(savedConfig) as StarboardForm;
          },
        });
      });
    } else if (!dirty) {
      untrack(() => unsavedChanges.release('starboard'));
    }
  });

  onDestroy(() => unsavedChanges.release('starboard'));

  /** Une config absente en base revient avec les valeurs par défaut du schéma. */
  function adopt(raw: any) {
    const next: StarboardForm = {
      channelId: raw?.channelId ?? null,
      upvoteEmojis: raw?.upvoteEmojis ?? [...DEFAULTS.upvoteEmojis],
      downvoteEmojis: raw?.downvoteEmojis ?? [...DEFAULTS.downvoteEmojis],
      threshold: raw?.threshold ?? DEFAULTS.threshold,
      countEmbedReactions: raw?.countEmbedReactions ?? DEFAULTS.countEmbedReactions,
      autoReactEmbed: raw?.autoReactEmbed ?? DEFAULTS.autoReactEmbed,
      autoReactChannels: raw?.autoReactChannels ?? [],
      watchedChannels: raw?.watchedChannels ?? [],
      ignoredChannels: raw?.ignoredChannels ?? [],
      allowBots: raw?.allowBots ?? DEFAULTS.allowBots,
      embedColor: raw?.embedColor ?? DEFAULTS.embedColor,
      removeBelowThreshold: raw?.removeBelowThreshold ?? DEFAULTS.removeBelowThreshold,
    };
    config = next;
    savedConfig = structuredClone(next);
  }

  onMount(async () => {
    try {
      await dashboardStore.refresh();
      const res = await fetchStarboardConfig();
      if (res?.config) adopt(res.config);
    } catch (err) {
      loadError = err instanceof Error ? err.message : m.starboard_load_error();
    } finally {
      loading = false;
    }
  });

  async function handleSave(): Promise<boolean> {
    if (!canConfigure) return false;
    let success = false;
    await saveAction.run(async () => {
      const res = await updateStarboardConfig($state.snapshot(config) as StarboardForm);
      if (!res?.config) throw new Error(m.starboard_save_error());
      adopt(res.config);
      success = true;
      return true;
    }, { successMessage: m.starboard_save_success() });
    return success;
  }

</script>

<ModulePage
  title={m.starboard_page_title()}
  description={m.starboard_page_desc()}
  icon="star"
  featureKey="starboard"
>
  <InlineFeedback state={saveAction} />

  {#if loading}
    <Skeleton height="180px" radius="1rem" />
    <Skeleton height="220px" radius="1rem" />
    <Skeleton height="180px" radius="1rem" />
  {:else if loadError}
    <div class="rounded-xl bg-error/10 border border-error/20 p-6 text-error text-sm font-semibold">
      {loadError}
    </div>
  {:else}
    {#if missingChannel}
      <div class="flex items-start gap-3 px-5 py-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
        <div class="w-9 h-9 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
          <Papicon icon="warning" size={18} />
        </div>
        <p class="text-[13px] text-on-surface-variant/80 leading-relaxed self-center">
          {m.starboard_no_channel_warning()}
        </p>
      </div>
    {/if}

    <!-- ── Publication ──────────────────────────────────────── -->
    <SectionCard
      title={m.starboard_section_publication_title()}
      description={m.starboard_section_publication_desc()}
      icon="star"
    >
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="md:col-span-2">
          <label for="starboard-channel" class="field-label">{m.starboard_channel_label()}</label>
          <SearchableSelect
            id="starboard-channel"
            bind:value={config.channelId}
            options={availableChannels}
            placeholder={m.starboard_channel_placeholder()}
            className="w-full bg-surface-container border border-outline-variant rounded-lg px-4 py-3 text-sm"
            disabled={!canConfigure}
          />
          <p class="field-hint">{m.starboard_channel_hint()}</p>
        </div>

        <div>
          <label for="starboard-threshold" class="field-label">{m.starboard_threshold_label()}</label>
          <input
            id="starboard-threshold"
            type="number"
            min="1"
            max="1000"
            bind:value={config.threshold}
            disabled={!canConfigure}
            class="w-full bg-surface-container border border-outline-variant rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none focus:border-primary/60 disabled:opacity-50"
          />
          <p class="field-hint">{m.starboard_threshold_hint()}</p>
        </div>
      </div>

      <div class="mt-6 flex items-center justify-between gap-4 p-4 bg-surface-container rounded-lg border border-outline-variant">
        <p class="text-sm font-medium text-on-surface">{m.starboard_color_label()}</p>
        <FormColorPicker bind:value={config.embedColor} />
      </div>
    </SectionCard>

    <!-- ── Barème de vote ───────────────────────────────────── -->
    <SectionCard
      title={m.starboard_section_votes_title()}
      description={m.starboard_section_votes_desc()}
      icon="thumbs-up"
    >
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label for="starboard-upvotes" class="field-label">{m.starboard_upvotes_label()}</label>
          <EmojiListInput
            id="starboard-upvotes"
            bind:values={config.upvoteEmojis}
            accentClass="bg-emerald-500/10 border-emerald-500/25 hover:bg-emerald-500/20"
            placeholder={m.starboard_emoji_placeholder()}
            disabled={!canConfigure}
          />
          <p class="field-hint">{m.starboard_upvotes_hint()}</p>
        </div>

        <div>
          <label for="starboard-downvotes" class="field-label">{m.starboard_downvotes_label()}</label>
          <EmojiListInput
            id="starboard-downvotes"
            bind:values={config.downvoteEmojis}
            accentClass="bg-rose-500/10 border-rose-500/25 hover:bg-rose-500/20"
            placeholder={m.starboard_emoji_placeholder()}
            disabled={!canConfigure}
          />
          <p class="field-hint">{m.starboard_downvotes_hint()}</p>
        </div>
      </div>

      <div class="mt-6 flex items-center justify-between gap-4 p-4 bg-surface-container rounded-lg border border-outline-variant">
        <div class="min-w-0">
          <p class="text-sm font-medium text-on-surface">{m.starboard_count_embed_title()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">{m.starboard_count_embed_desc()}</p>
        </div>
        <ToggleSwitch
          checked={config.countEmbedReactions}
          onToggle={(v: boolean) => { config.countEmbedReactions = v; }}
          disabled={!canConfigure}
        />
      </div>
    </SectionCard>

    <!-- ── Amorçage ─────────────────────────────────────────── -->
    <SectionCard
      title={m.starboard_section_autoreact_title()}
      description={m.starboard_section_autoreact_desc()}
      icon="sparkles"
    >
      <div class="flex items-center justify-between gap-4 p-4 bg-surface-container rounded-lg border border-outline-variant">
        <div class="min-w-0">
          <p class="text-sm font-medium text-on-surface">{m.starboard_autoreact_embed_title()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">{m.starboard_autoreact_embed_desc()}</p>
        </div>
        <ToggleSwitch
          checked={config.autoReactEmbed}
          onToggle={(v: boolean) => { config.autoReactEmbed = v; }}
          disabled={!canConfigure}
        />
      </div>

      <div class="mt-6">
        <label for="starboard-autoreact-channels" class="field-label">{m.starboard_autoreact_channels_label()}</label>
        <MultiSelect
          id="starboard-autoreact-channels"
          bind:values={config.autoReactChannels}
          options={availableChannels}
          disabled={!canConfigure}
        />
        <p class="field-hint">{m.starboard_autoreact_channels_hint()}</p>
      </div>
    </SectionCard>

    <!-- ── Portée ───────────────────────────────────────────── -->
    <SectionCard
      title={m.starboard_section_scope_title()}
      description={m.starboard_section_scope_desc()}
      icon="hash"
    >
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label for="starboard-watched" class="field-label">{m.starboard_watched_label()}</label>
          <MultiSelect
            id="starboard-watched"
            bind:values={config.watchedChannels}
            options={availableChannels}
            disabled={!canConfigure}
          />
          <p class="field-hint">{m.starboard_watched_hint()}</p>
        </div>

        <div>
          <label for="starboard-ignored" class="field-label">{m.starboard_ignored_label()}</label>
          <MultiSelect
            id="starboard-ignored"
            bind:values={config.ignoredChannels}
            options={availableChannels}
            accentClass="bg-rose-500/20 text-rose-300 border-rose-500/40"
            disabled={!canConfigure}
          />
          <p class="field-hint">{m.starboard_ignored_hint()}</p>
        </div>
      </div>

      <div class="mt-6 flex items-center justify-between gap-4 p-4 bg-surface-container rounded-lg border border-outline-variant">
        <div class="min-w-0">
          <p class="text-sm font-medium text-on-surface">{m.starboard_allow_bots_title()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">{m.starboard_allow_bots_desc()}</p>
        </div>
        <ToggleSwitch
          checked={config.allowBots}
          onToggle={(v: boolean) => { config.allowBots = v; }}
          disabled={!canConfigure}
        />
      </div>
    </SectionCard>

    <!-- ── Cycle de vie ─────────────────────────────────────── -->
    <SectionCard
      title={m.starboard_section_lifecycle_title()}
      description={m.starboard_section_lifecycle_desc()}
      icon="history"
    >
      <div class="flex items-center justify-between gap-4 p-4 bg-surface-container rounded-lg border border-outline-variant">
        <div class="min-w-0">
          <p class="text-sm font-medium text-on-surface">{m.starboard_remove_below_title()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">{m.starboard_remove_below_desc()}</p>
        </div>
        <ToggleSwitch
          checked={config.removeBelowThreshold}
          onToggle={(v: boolean) => { config.removeBelowThreshold = v; }}
          disabled={!canConfigure}
        />
      </div>
    </SectionCard>
  {/if}
</ModulePage>
