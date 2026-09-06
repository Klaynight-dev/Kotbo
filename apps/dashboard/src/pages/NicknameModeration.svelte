<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { m, getLocale } from '../lib/i18n';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchNicknameModerationConfig,
    updateNicknameModerationConfig,
    fetchBannedWords,
    addBannedWord,
    deleteBannedWord,
    toggleBannedWord,
    fetchGuildLanguage,
  } from '../lib/api';

  let unsubscribeRealtime: (() => void) | null = null;

  // Le pseudo de remplacement suit la langue du bot sur ce serveur, pas celle du
  // dashboard : afficher la version francaise a qui administre un serveur en
  // anglais annoncerait un pseudo qui ne sera jamais applique.
  let botLocale = $state<'fr' | 'en'>(getLocale() as 'fr' | 'en');

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  type BannedWordEntry = {
    id: string;
    word: string;
    category: string;
    enabled: boolean;
    guildId: string | null;
  };

  type CategoryMeta = {
    label: string;
    color: string;
    bg: string;
  };

  const CATEGORIES: Record<string, CategoryMeta> = $derived({
    custom:     { label: m.nm_cat_custom(),     color: 'text-primary',      bg: 'bg-primary/10 border-primary/20' },
    racism:     { label: m.nm_cat_racism(),     color: 'text-error',        bg: 'bg-error/10 border-error/20' },
    threat:     { label: m.nm_cat_threat(),     color: 'text-orange-400',   bg: 'bg-orange-400/10 border-orange-400/20' },
    sexual:     { label: m.nm_cat_sexual(),     color: 'text-pink-400',     bg: 'bg-pink-400/10 border-pink-400/20' },
    lgbtphobia: { label: m.nm_cat_lgbtphobia(), color: 'text-purple-400',   bg: 'bg-purple-400/10 border-purple-400/20' },
    hate:       { label: m.nm_cat_hate(),       color: 'text-red-600',      bg: 'bg-red-600/10 border-red-600/20' },
    insult:     { label: m.nm_cat_insult(),     color: 'text-yellow-400',   bg: 'bg-yellow-400/10 border-yellow-400/20' },
  });

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let enabled = $state(false);
  let onJoin = $state(true);
  let onUpdate = $state(true);
  let checkInvisible = $state(true);
  let checkGlobal = $state(true);
  let checkCustom = $state(true);
  let discordAutoModSync = $state(false);
  let globalWords = $state<BannedWordEntry[]>([]);
  let customWords = $state<BannedWordEntry[]>([]);
  let whitelist = $state<string[]>([]);
  let bypass = $state<string[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  let newWord = $state('');
  let newCategory = $state('custom');
  const nickTabs = ['custom', 'global'] as const;
  let activeTab = $state<'custom' | 'global'>('custom');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/security/filters/nicknames', nickTabs, 'custom') as typeof activeTab;
  });

  let newWhitelistItem = $state('');
  let newBypassItem = $state('');

  const saveToggleAction = createAsyncActionState();
  const wordAction = createAsyncActionState();
  const exceptionAction = createAsyncActionState();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function loadData(showLoading = false) {
    if (showLoading) {
      loading = true;
    }
    try {
      const [config, words] = await Promise.all([
        fetchNicknameModerationConfig(),
        fetchBannedWords(),
      ]);
      if (config) {
        enabled = config.enabled ?? false;
        whitelist = config.whitelist ?? [];
        bypass = config.bypass ?? [];
        onJoin = config.onJoin ?? true;
        onUpdate = config.onUpdate ?? true;
        checkInvisible = config.checkInvisible ?? true;
        checkGlobal = config.checkGlobal ?? true;
        checkCustom = config.checkCustom ?? true;
        discordAutoModSync = config.discordAutoModSync ?? false;
      }
      if (words) {
        globalWords = words.global ?? [];
        customWords = words.custom ?? [];
      }
      loadError = '';
    } catch (err) {
      loadError = err instanceof Error ? err.message : m.nm_error_load();
    } finally {
      if (showLoading) {
        loading = false;
      }
    }
  }

  onMount(async () => {
    await loadData(true);

    const language = await fetchGuildLanguage();
    if (language?.locale) botLocale = language.locale;

    unsubscribeRealtime = subscribeRealtime({
      reasons: ['nickname_moderation_updated', 'banned_words_updated'],
      onUpdate: () => {
        void loadData(false);
      },
    });
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function saveToggle(nextValue: boolean) {
    const previousValue = enabled;
    enabled = nextValue;
    const saved = await saveToggleAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ enabled: nextValue });
        if (!ok) throw new Error(m.nm_error_api());
        return true;
      },
      { successMessage: nextValue ? m.nm_module_enabled() : m.nm_module_disabled() }
    );
    if (!saved) enabled = previousValue;
  }

  async function saveGranularToggle(field: 'onJoin' | 'onUpdate' | 'checkInvisible' | 'checkGlobal' | 'checkCustom' | 'discordAutoModSync', value: boolean) {
    const previousValue = {
      onJoin,
      onUpdate,
      checkInvisible,
      checkGlobal,
      checkCustom,
      discordAutoModSync,
    }[field];

    if (field === 'onJoin') onJoin = value;
    else if (field === 'onUpdate') onUpdate = value;
    else if (field === 'checkInvisible') checkInvisible = value;
    else if (field === 'checkGlobal') checkGlobal = value;
    else if (field === 'checkCustom') checkCustom = value;
    else discordAutoModSync = value;

    const saved = await saveToggleAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ [field]: value });
        if (!ok) throw new Error(m.nm_error_api());
        return true;
      },
      { successMessage: `Paramètre mis à jour.` }
    );

    if (!saved) {
      if (field === 'onJoin') onJoin = previousValue;
      else if (field === 'onUpdate') onUpdate = previousValue;
      else if (field === 'checkInvisible') checkInvisible = previousValue;
      else if (field === 'checkGlobal') checkGlobal = previousValue;
      else if (field === 'checkCustom') checkCustom = previousValue;
      else discordAutoModSync = previousValue;
    }
  }

  async function addWord() {
    const trimmed = newWord.trim().toLowerCase();
    if (!trimmed) return;
    if (customWords.some((w) => w.word === trimmed)) {
      wordAction.setError(m.nm_word_exists());
      return;
    }

    newWord = '';

    await wordAction.run(
      async () => {
        const res = await addBannedWord(trimmed, newCategory);
        if (!res?.id) throw new Error(m.nm_error_add());
        if (!customWords.some((w) => w.id === res.id || w.word === trimmed)) {
          customWords = [...customWords, { id: res.id, word: trimmed, category: newCategory, enabled: true, guildId: null }];
        }
        return true;
      },
      { successMessage: m.nm_word_added({ word: trimmed }) }
    );
  }

  async function handleDelete(entry: BannedWordEntry) {
    await wordAction.run(
      async () => {
        const ok = await deleteBannedWord(entry.id);
        if (!ok) throw new Error(m.nm_error_delete());
        customWords = customWords.filter((w) => w.id !== entry.id);

        toast.success(m.nm_word_deleted({ word: entry.word }), 6000, {
          label: m.nm_undo(),
          onClick: async () => {
            await wordAction.run(async () => {
              const res = await addBannedWord(entry.word, entry.category);
              if (!res?.id) throw new Error(m.nm_error_undo());
              if (!customWords.some((w) => w.word === entry.word)) {
                customWords = [...customWords, { id: res.id, word: entry.word, category: entry.category, enabled: true, guildId: null }];
              }
              return true;
            }, { successMessage: `"${entry.word}" rétabli.` });
          }
        });

        return true;
      },
      {}
    );
  }

  async function handleToggle(entry: BannedWordEntry) {
    const newEnabled = !entry.enabled;
    await wordAction.run(
      async () => {
        const ok = await toggleBannedWord(entry.id, newEnabled);
        if (!ok) throw new Error('Erreur');
        customWords = customWords.map((w) => w.id === entry.id ? { ...w, enabled: newEnabled } : w);
        return true;
      },
      {}
    );
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); addWord(); }
  }

  function getCat(key: string): CategoryMeta {
    return CATEGORIES[key] ?? CATEGORIES.custom;
  }

  async function addWhitelistItem() {
    const trimmed = newWhitelistItem.trim().toLowerCase();
    if (!trimmed) return;
    if (whitelist.includes(trimmed)) {
      exceptionAction.setError(m.nm_nick_exists());
      return;
    }

    const updatedWhitelist = [...whitelist, trimmed];
    await exceptionAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ whitelist: updatedWhitelist });
        if (!ok) throw new Error(m.nm_error_api());
        whitelist = updatedWhitelist;
        newWhitelistItem = '';
        return true;
      },
      { successMessage: m.nm_nick_added({ item: trimmed }) }
    );
  }

  async function removeWhitelistItem(item: string) {
    const updatedWhitelist = whitelist.filter((w) => w !== item);
    await exceptionAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ whitelist: updatedWhitelist });
        if (!ok) throw new Error(m.nm_error_api());
        
        const previousWhitelist = whitelist;
        whitelist = updatedWhitelist;

        toast.success(m.nm_nick_removed({ item }), 6000, {
          label: m.nm_undo(),
          onClick: async () => {
            await exceptionAction.run(async () => {
              const okUndo = await updateNicknameModerationConfig({ whitelist: previousWhitelist });
              if (!okUndo) throw new Error(m.nm_error_undo());
              whitelist = previousWhitelist;
              return true;
            }, { successMessage: m.nm_nick_restored({ item }) });
          }
        });

        return true;
      },
      {}
    );
  }

  async function addBypassItem() {
    const trimmed = newBypassItem.trim();
    if (!trimmed) return;
    if (bypass.includes(trimmed)) {
      exceptionAction.setError(m.nm_bypass_exists());
      return;
    }

    if (!/^\d{17,20}$/.test(trimmed)) {
      exceptionAction.setError(m.nm_bypass_invalid());
      return;
    }

    const updatedBypass = [...bypass, trimmed];
    await exceptionAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ bypass: updatedBypass });
        if (!ok) throw new Error(m.nm_error_api());
        bypass = updatedBypass;
        newBypassItem = '';
        return true;
      },
      { successMessage: m.nm_bypass_added({ id: trimmed }) }
    );
  }

  async function removeBypassItem(item: string) {
    const updatedBypass = bypass.filter((b) => b !== item);
    await exceptionAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ bypass: updatedBypass });
        if (!ok) throw new Error(m.nm_error_api());
        
        const previousBypass = bypass;
        bypass = updatedBypass;

        toast.success(m.nm_bypass_removed({ id: item }), 6000, {
          label: m.nm_undo(),
          onClick: async () => {
            await exceptionAction.run(async () => {
              const okUndo = await updateNicknameModerationConfig({ bypass: previousBypass });
              if (!okUndo) throw new Error(m.nm_error_undo());
              bypass = previousBypass;
              return true;
            }, { successMessage: m.nm_bypass_restored({ id: item }) });
          }
        });

        return true;
      },
      {}
    );
  }

  function handleWhitelistKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); addWhitelistItem(); }
  }

  function handleBypassKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); addBypassItem(); }
  }
</script>

<ModulePage
  title={m.nm_page_title()}
  description={m.nm_page_desc()}
  icon="filter"
  featureKey="nickname_moderation"
>
  <InlineFeedback state={saveToggleAction} />

  {#if loading}
    <div class="flex flex-col gap-6 animate-pulse">
      {#each [1, 2] as _}
        <div class="h-32 rounded-xl bg-surface-container-low/60"></div>
      {/each}
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else if loadError}
    <div class="rounded-xl bg-error/10 border border-error/20 p-6 text-error text-sm font-semibold flex items-center gap-2">
      <Papicon icon="alert-triangle" size={18} />
      <span>{loadError}</span>
    </div>
  {:else}
    <div class="flex flex-col gap-8">
      <!-- ============================================================ -->
      <!-- Section 1 - Toggle principal                                   -->
    <!-- ============================================================ -->
    <section class="bg-surface-container-low/40 rounded-xl border border-outline-variant/30 p-8 flex flex-col gap-6">
      <div class="flex items-start justify-between gap-6">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold tracking-tight text-on-surface">{m.nm_activation()}</h2>
          <p class="text-sm text-on-surface-variant/70">
            {m.nm_activation_desc_1()}
            <code class="font-mono text-primary dark:text-blue-300 bg-primary/10 dark:bg-blue-500/15 px-1.5 py-0.5 rounded-lg text-xs">{m.nm_safe_nickname({}, { locale: botLocale })}</code>.
            <br />
            {m.nm_activation_desc_2()} <code class="font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded-lg text-xs">/rescan pseudo rescan</code>
          </p>
        </div>
        <div class="flex-shrink-0">
          <ToggleSwitch checked={enabled} onToggle={saveToggle} disabled={saveToggleAction.state.loading} />
        </div>
      </div>

      <div class="p-4 rounded-lg bg-surface-container/30 border border-outline-variant/20 flex flex-col gap-5">
        <!-- Deux questions distinctes : quand le bot regarde, et ce qu'il refuse.
             En liste plate, on ne voyait pas que couper un groupe entier eteint
             le module sans eteindre son interrupteur principal. -->
        <div class="flex flex-col gap-2">
          <p class="text-[13px] font-medium text-on-surface-variant/50">{m.nm_group_when()}</p>
          <div class="flex items-center justify-between gap-4 py-1.5 px-2 rounded-xl hover:bg-surface-container-high/30 transition-colors">
            <span class="text-sm text-on-surface-variant/80">{m.nm_watch_join()}</span>
            <ToggleSwitch checked={onJoin} onToggle={(value) => saveGranularToggle('onJoin', value)} disabled={!enabled || saveToggleAction.state.loading} />
          </div>
          <div class="flex items-center justify-between gap-4 py-1.5 px-2 rounded-xl hover:bg-surface-container-high/30 transition-colors">
            <span class="text-sm text-on-surface-variant/80">{m.nm_watch_update()}</span>
            <ToggleSwitch checked={onUpdate} onToggle={(value) => saveGranularToggle('onUpdate', value)} disabled={!enabled || saveToggleAction.state.loading} />
          </div>
          {#if enabled && !onJoin && !onUpdate}
            <p class="text-xs text-tertiary flex items-start gap-2 px-2">
              <Papicon icon="alert-triangle" size={14} class="shrink-0 mt-0.5" />
              {m.nm_warn_never()}
            </p>
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <p class="text-[13px] font-medium text-on-surface-variant/50">{m.nm_group_what()}</p>
          <div class="flex items-center justify-between gap-4 py-1.5 px-2 rounded-xl hover:bg-surface-container-high/30 transition-colors">
            <span class="text-sm text-on-surface-variant/80">{m.nm_watch_invisible()}</span>
            <ToggleSwitch checked={checkInvisible} onToggle={(value) => saveGranularToggle('checkInvisible', value)} disabled={!enabled || saveToggleAction.state.loading} />
          </div>
          <div class="flex items-center justify-between gap-4 py-1.5 px-2 rounded-xl hover:bg-surface-container-high/30 transition-colors">
            <span class="text-sm text-on-surface-variant/80">{m.nm_watch_global()}</span>
            <ToggleSwitch checked={checkGlobal} onToggle={(value) => saveGranularToggle('checkGlobal', value)} disabled={!enabled || saveToggleAction.state.loading} />
          </div>
          <div class="flex items-center justify-between gap-4 py-1.5 px-2 rounded-xl hover:bg-surface-container-high/30 transition-colors">
            <span class="text-sm text-on-surface-variant/80">{m.nm_watch_custom()}</span>
            <ToggleSwitch checked={checkCustom} onToggle={(value) => saveGranularToggle('checkCustom', value)} disabled={!enabled || saveToggleAction.state.loading} />
          </div>
          {#if enabled && !checkInvisible && !checkGlobal && !checkCustom}
            <p class="text-xs text-tertiary flex items-start gap-2 px-2">
              <Papicon icon="alert-triangle" size={14} class="shrink-0 mt-0.5" />
              {m.nm_warn_nothing()}
            </p>
          {/if}
        </div>

        <div class="flex items-center justify-between gap-4 py-3 px-2 rounded-xl hover:bg-surface-container-high/30 transition-colors border-t border-outline-variant/10">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm font-semibold text-on-surface">{m.nm_discord_automod()}</span>
            <span class="text-xs text-on-surface-variant/60">{m.nm_discord_automod_desc()}</span>
          </div>
          <ToggleSwitch checked={discordAutoModSync} onToggle={(value) => saveGranularToggle('discordAutoModSync', value)} disabled={!enabled || saveToggleAction.state.loading} />
        </div>

        <p class="text-xs text-on-surface-variant/40 italic mt-1">
          {m.nm_owner_limitation()}
        </p>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- Section 2 - Mots bannis                                       -->
    <!-- ============================================================ -->
    <section class="bg-surface-container-low/40 rounded-xl border border-outline-variant/30 p-8 flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-semibold tracking-tight text-on-surface">{m.nm_banned_words()}</h2>
        <p class="text-sm text-on-surface-variant/70">
          {m.nm_banned_words_desc_1()} <strong>{m.nm_banned_words_global()}</strong> {m.nm_banned_words_desc_2()}
          <strong>{m.nm_banned_words_custom()}</strong> {m.nm_banned_words_desc_3()}
        </p>
      </div>

      <!-- Tabs -->
      <div class="tab-group w-fit">
        {#each [{ key: 'custom', label: m.nm_tab_custom({ count: customWords.length }) }, { key: 'global', label: m.nm_tab_global({ count: globalWords.length }) }] as tab}
          <button
            onclick={() => gotoTab('/security/filters/nicknames', tab.key, 'custom')}
            class="tab-button {activeTab === tab.key ? 'active' : ''}"
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- L'interrupteur qui commande la liste est deux sections plus haut : le
           bandeau le ramene ici plutot que d'obliger a remonter. -->
      {#if activeTab === 'custom' ? !checkCustom : !checkGlobal}
        <div class="p-4 rounded-lg bg-tertiary/10 border border-tertiary/20 flex items-center gap-3">
          <span class="text-tertiary shrink-0"><Papicon icon="alert-triangle" size={20} /></span>
          <p class="text-sm text-on-surface flex-1">
            <strong class="text-tertiary">{m.nm_inactive()}</strong>
            {activeTab === 'custom' ? m.nm_custom_disabled() : m.nm_global_disabled()}
          </p>
          <button
            type="button"
            onclick={() => saveGranularToggle(activeTab === 'custom' ? 'checkCustom' : 'checkGlobal', true)}
            disabled={!enabled || saveToggleAction.state.loading}
            class="shrink-0 px-4 py-2 rounded-lg text-xs font-bold bg-tertiary/20 text-tertiary hover:bg-tertiary/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {m.nm_enable_it()}
          </button>
        </div>
      {/if}

      {#if activeTab === 'custom'}

        <!-- Formulaire d'ajout -->
        <div class="flex gap-3 items-start flex-wrap">
          <div class="flex-1 min-w-[200px] relative">
            <input
              id="banned-word-input"
              type="text"
              bind:value={newWord}
              onkeydown={handleKeydown}
              maxlength={100}
              placeholder={m.nm_word_placeholder()}
              class="w-full bg-surface-container/60 border border-outline-variant/30 rounded-lg px-5 py-3.5 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-all"
            />
          </div>
          <select
            bind:value={newCategory}
            class="bg-surface-container/60 border border-outline-variant/30 rounded-lg px-4 py-3.5 text-sm text-on-surface focus:outline-none focus:border-primary/60 transition-all"
          >
            {#each Object.entries(CATEGORIES) as [key, meta]}
              <option value={key}>{meta.label}</option>
            {/each}
          </select>
          <button
            onclick={addWord}
            disabled={!newWord.trim() || wordAction.state.loading}
            class="flex items-center gap-2 px-5 py-3.5 bg-primary text-white rounded-lg text-sm font-bold transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Papicon icon="plus" size={16} />
            {m.nm_add()}
          </button>
        </div>

        <InlineFeedback state={wordAction} />

        <!-- Liste des mots personnalisés -->
        {#if customWords.length > 0}
          <div class="section-card-flush">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{m.nm_col_word()}</th>
                  <th>{m.nm_col_category()}</th>
                  <th class="text-center">{m.nm_col_active()}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each customWords as entry (entry.id)}
                  {@const cat = getCat(entry.category)}
                  <tr class={entry.enabled ? '' : 'opacity-40'}>
                    <td class="font-mono font-semibold text-on-surface">{entry.word}</td>
                    <td>
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border {cat.bg} {cat.color}">
                        {cat.label}
                      </span>
                    </td>
                    <td class="text-center">
                      <ToggleSwitch checked={entry.enabled} onToggle={() => handleToggle(entry)} disabled={wordAction.state.loading} />
                    </td>
                    <td class="text-right">
                      <button
                        onclick={() => handleDelete(entry)}
                        disabled={wordAction.state.loading}
                        aria-label={m.nm_delete_word({ word: entry.word })}
                        class="p-2 rounded-xl text-on-surface-variant/40 hover:text-error hover:bg-error/10 transition-all disabled:opacity-30 cursor-pointer"
                      >
                        <Papicon icon="trash" size={15} />
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-on-surface-variant/40 text-right font-sans">{m.nm_custom_count({ count: customWords.length })}</p>
        {:else}
          <div class="flex flex-col items-center gap-3 py-10 text-on-surface-variant/30">
            <Papicon icon="filter" size={36} class="opacity-20" />
            <p class="text-sm font-semibold">{m.nm_no_custom_word()}</p>
            <p class="text-xs">{m.nm_global_still_active()}</p>
          </div>
        {/if}

      {:else}
        <!-- Liste globale (read-only) -->
        {#if globalWords.length > 0}
          <div class="section-card-flush">
            <div class="bg-surface-container/30 px-5 py-3 flex items-center gap-2 text-xs text-on-surface-variant/50 border-b border-outline-variant/10">
              <Papicon icon="lock" size={12} />
              <span>{m.nm_global_readonly()}</span>
            </div>
            <table class="data-table">
              <thead>
                <tr>
                  <th>{m.nm_col_word()}</th>
                  <th>{m.nm_col_category()}</th>
                  <th class="text-center">{m.nm_col_active()}</th>
                </tr>
              </thead>
              <tbody>
                {#each globalWords as entry (entry.id)}
                  {@const cat = getCat(entry.category)}
                  <tr class={entry.enabled ? '' : 'opacity-40'}>
                    <td class="font-mono font-semibold text-on-surface">{entry.word}</td>
                    <td>
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border {cat.bg} {cat.color}">
                        {cat.label}
                      </span>
                    </td>
                    <td class="text-center">
                      <span class="inline-flex items-center gap-1.5 text-xs font-bold {entry.enabled ? 'text-primary' : 'text-on-surface-variant/30'}">
                        <span class="w-2 h-2 rounded-full {entry.enabled ? 'bg-primary' : 'bg-on-surface-variant/20'}"></span>
                        {entry.enabled ? m.nm_active() : m.nm_inactive()}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-on-surface-variant/40 text-right font-sans">{m.nm_global_count({ count: globalWords.length })}</p>
        {:else}
          <div class="flex flex-col items-center gap-3 py-10 text-on-surface-variant/30">
            <Papicon icon="filter" size={36} class="opacity-20" />
            <p class="text-sm font-semibold">{m.nm_no_global_word()}</p>
          </div>
        {/if}
      {/if}
    </section>

    <!-- ============================================================ -->
    <!-- Section 3 - Exceptions (Pseudos & Membres autorisés)          -->
    <!-- ============================================================ -->
    <section class="bg-surface-container-low/40 rounded-xl border border-outline-variant/30 p-8 flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-semibold tracking-tight text-on-surface">{m.nm_exceptions()}</h2>
        <p class="text-sm text-on-surface-variant/70">
          {m.nm_exceptions_desc()}
        </p>
      </div>

      <InlineFeedback state={exceptionAction} />

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <!-- Pseudos autorisés -->
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <h3 class="text-sm font-bold text-on-surface">{m.nm_allowed_nicks()}</h3>
            <p class="text-xs text-on-surface-variant/50">
              {m.nm_allowed_nicks_desc()}
            </p>
          </div>

          <div class="flex gap-2">
            <input
              type="text"
              bind:value={newWhitelistItem}
              onkeydown={handleWhitelistKeydown}
              placeholder={m.nm_nick_placeholder()}
              class="flex-1 min-w-0 bg-surface-container/60 border border-outline-variant/30 rounded-lg px-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/60 transition-all"
            />
            <button
              onclick={addWhitelistItem}
              disabled={!newWhitelistItem.trim() || exceptionAction.state.loading}
              class="shrink-0 px-5 py-3 bg-primary text-white rounded-lg text-sm font-bold transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-40"
            >
              {m.nm_add()}
            </button>
          </div>

          {#if whitelist.length > 0}
            <div class="flex flex-wrap gap-2 p-4 rounded-lg bg-surface-container/20 border border-outline-variant/10">
              {#each whitelist as item}
                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-primary/10 text-primary border border-primary/20">
                  {item}
                  <button
                    onclick={() => removeWhitelistItem(item)}
                    disabled={exceptionAction.state.loading}
                    aria-label={m.nm_remove_item({ item })}
                    class="text-primary hover:text-error transition-colors focus:outline-none"
                  >
                    <Papicon icon="x" size={12} />
                  </button>
                </span>
              {/each}
            </div>
          {:else}
            <div class="p-6 rounded-lg bg-surface-container/10 border border-dashed border-outline-variant/20 text-center text-xs text-on-surface-variant/40">
              {m.nm_no_allowed_nick()}
            </div>
          {/if}
        </div>

        <!-- Membres exemptés -->
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <h3 class="text-sm font-bold text-on-surface">{m.nm_bypass_members()}</h3>
            <p class="text-xs text-on-surface-variant/50">
              {m.nm_bypass_members_desc()}
            </p>
          </div>

          <div class="flex gap-2">
            <input
              type="text"
              bind:value={newBypassItem}
              onkeydown={handleBypassKeydown}
              placeholder={m.nm_bypass_placeholder()}
              class="flex-1 min-w-0 bg-surface-container/60 border border-outline-variant/30 rounded-lg px-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/60 transition-all"
            />
            <button
              onclick={addBypassItem}
              disabled={!newBypassItem.trim() || exceptionAction.state.loading}
              class="shrink-0 px-5 py-3 bg-primary text-white rounded-lg text-sm font-bold transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-40"
            >
              {m.nm_add()}
            </button>
          </div>

          {#if bypass.length > 0}
            <div class="flex flex-wrap gap-2 p-4 rounded-lg bg-surface-container/20 border border-outline-variant/10">
              {#each bypass as item}
                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-secondary/10 text-on-secondary-container border border-secondary/20 font-mono">
                  {item}
                  <button
                    onclick={() => removeBypassItem(item)}
                    disabled={exceptionAction.state.loading}
                    aria-label={m.nm_remove_bypass({ item })}
                    class="text-on-secondary-container hover:text-error transition-colors focus:outline-none"
                  >
                    <Papicon icon="x" size={12} />
                  </button>
                </span>
              {/each}
            </div>
          {:else}
            <div class="p-6 rounded-lg bg-surface-container/10 border border-dashed border-outline-variant/20 text-center text-xs text-on-surface-variant/40">
              {m.nm_no_bypass()}
            </div>
          {/if}
        </div>
      </div>
    </section>
    </div>
  {/if}
</ModulePage>
