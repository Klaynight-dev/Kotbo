<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import {
    fetchFunConfig,
    updateFunConfig,
    resetCountingGame,
    resetGuessNumberGame,
    resetWordChainGame,
    resetEmojiRiddleGame
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.fun?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let config = $state({
    funEnabled: false,
    funCountingChannelId: null as string | null,
    funOneWordStoryChannelId: null as string | null,
    funGuessNumberChannelId: null as string | null,
    funWordChainChannelId: null as string | null,
    funEmojiRiddleChannelId: null as string | null,
    funNeverSayChannelId: null as string | null,
    funEmojiOnlyChannelId: null as string | null,
    funPunitiveMode: true
  });

  let savedConfig = $state({
    funEnabled: false,
    funCountingChannelId: null as string | null,
    funOneWordStoryChannelId: null as string | null,
    funGuessNumberChannelId: null as string | null,
    funWordChainChannelId: null as string | null,
    funEmojiRiddleChannelId: null as string | null,
    funNeverSayChannelId: null as string | null,
    funEmojiOnlyChannelId: null as string | null,
    funPunitiveMode: true
  });

  let gameState = $state({
    countingCurrent: 0,
    countingLastUserId: null as string | null,
    oneWordStoryLastUserId: null as string | null,
    guessNumberTarget: 0,
    wordChainLastWord: null as string | null,
    wordChainLastUserId: null as string | null,
    emojiRiddleEmojis: null as string | null
  });

  // Detect changes and register/deregister with the global bar
  $effect(() => {
    const current = JSON.stringify(config);
    const saved = JSON.stringify(savedConfig);
    const dirty = current !== saved;

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'fun-settings',
          label: m.fun_unsaved_label(),
          onSave: () => handleSave(),
          onReset: () => { config = { ...savedConfig }; }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('fun-settings');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('fun-settings');
  });

  function mapConfig(source: any) {
    return {
      funEnabled: source.funEnabled ?? false,
      funCountingChannelId: source.funCountingChannelId ?? null,
      funOneWordStoryChannelId: source.funOneWordStoryChannelId ?? null,
      funGuessNumberChannelId: source.funGuessNumberChannelId ?? null,
      funWordChainChannelId: source.funWordChainChannelId ?? null,
      funEmojiRiddleChannelId: source.funEmojiRiddleChannelId ?? null,
      funNeverSayChannelId: source.funNeverSayChannelId ?? null,
      funEmojiOnlyChannelId: source.funEmojiOnlyChannelId ?? null,
      funPunitiveMode: source.funPunitiveMode ?? true
    };
  }

  function mapGameState(source: any) {
    return {
      countingCurrent: source.countingCurrent ?? 0,
      countingLastUserId: source.countingLastUserId ?? null,
      oneWordStoryLastUserId: source.oneWordStoryLastUserId ?? null,
      guessNumberTarget: source.guessNumberTarget ?? 0,
      wordChainLastWord: source.wordChainLastWord ?? null,
      wordChainLastUserId: source.wordChainLastUserId ?? null,
      emojiRiddleEmojis: source.emojiRiddleEmojis ?? null
    };
  }

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchFunConfig();
      if (res && res.config) {
        const loaded = mapConfig(res.config);
        config = loaded;
        savedConfig = { ...loaded };
      }
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  async function handleSave(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await actionState.run(async () => {
      const res = await updateFunConfig(config);
      if (!res) throw new Error(m.fun_save_error());
      const saved = mapConfig(res.config);
      config = saved;
      savedConfig = { ...saved };

      if (res.gameState) {
        gameState = mapGameState(res.gameState);
      }

      success = true;
      return true;
    }, { successMessage: m.fun_save_success() });
    return success;
  }

  async function handleResetCounting() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_counting_confirm_title(), confirmLabel: m.fun_reset_counting_confirm_btn(), variant: 'warning' }))) return;

    await actionState.run(async () => {
      const res = await resetCountingGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_counting_toast() });
  }

  async function handleResetGuessNumber() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_guess_confirm_title(), confirmLabel: m.fun_reset_guess_confirm_btn() }))) return;

    await actionState.run(async () => {
      const res = await resetGuessNumberGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_guess_toast() });
  }

  async function handleResetWordChain() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_wordchain_confirm_title(), confirmLabel: m.fun_reset_wordchain_confirm_btn(), variant: 'warning' }))) return;

    await actionState.run(async () => {
      const res = await resetWordChainGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_wordchain_toast() });
  }

  async function handleResetEmojiRiddle() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_emojiriddle_confirm_title(), confirmLabel: m.fun_reset_emojiriddle_confirm_btn() }))) return;

    await actionState.run(async () => {
      const res = await resetEmojiRiddleGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_emojiriddle_toast() });
  }
</script>

<ModulePage
  title={m.fun_page_title()}
  description={m.fun_page_desc()}
  icon="Smile"
  featureKey="fun"
>
  <InlineFeedback state={actionState} />

  {#if !loading}
    <div class="flex items-center justify-between gap-4 rounded-xl bg-surface-container-low/40 border border-outline-variant/30 p-6 mb-8">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-on-surface">{m.fun_punitive_title()}</p>
        <p class="text-xs text-on-surface-variant/70 mt-1">{m.fun_punitive_desc()}</p>
      </div>
      <ToggleSwitch
        checked={config.funPunitiveMode}
        disabled={!canManageSettings}
        onToggle={() => (config.funPunitiveMode = !config.funPunitiveMode)}
        ariaLabel={m.fun_punitive_title()}
      />
    </div>
  {/if}

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <Skeleton height="320px" radius="2.5rem" />
      <Skeleton height="320px" radius="2.5rem" />
      <Skeleton height="320px" radius="2.5rem" />
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Counting Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
              <Papicon icon="Binary" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_counting_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_counting_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="countingChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="countingChannel"
              bind:value={config.funCountingChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant/50">{m.fun_game_state_title()}</p>
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center">
                <span class="text-[10px] text-on-surface-variant/50 uppercase font-bold">{m.fun_counting_number()}</span>
                <p class="text-2xl font-semibold text-amber-500 mt-0.5">{gameState.countingCurrent}</p>
              </div>
              <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center flex flex-col justify-center min-w-0">
                <span class="text-[10px] text-on-surface-variant/50 uppercase font-bold truncate">{m.fun_last_player()}</span>
                <p class="text-xs font-bold text-on-surface mt-1 truncate" title={gameState.countingLastUserId || m.fun_none()}>
                  {gameState.countingLastUserId ? m.fun_user_id({ id: gameState.countingLastUserId }) : m.fun_none()}
                </p>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetCounting}
          disabled={!canManageSettings || actionState.state.loading}
          class="w-full py-3.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 rounded-lg text-[13px] font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_counting_btn()}
        </button>
      </section>

      <!-- One Word Story Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-500 flex items-center justify-center">
              <Papicon icon="BookOpen" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_oneword_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_oneword_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="oneWordStoryChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="oneWordStoryChannel"
              bind:value={config.funOneWordStoryChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-purple-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant/50">{m.fun_game_state_title()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center flex flex-col justify-center min-w-0">
              <span class="text-[10px] text-on-surface-variant/50 uppercase font-bold truncate">{m.fun_last_author()}</span>
              <p class="text-xs font-bold text-on-surface mt-1 truncate" title={gameState.oneWordStoryLastUserId || m.fun_none()}>
                {gameState.oneWordStoryLastUserId ? m.fun_user_id({ id: gameState.oneWordStoryLastUserId }) : m.fun_none()}
              </p>
            </div>
          </div>
        </div>

        <div class="text-[11px] text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_oneword_hint()}
        </div>
      </section>

      <!-- Guess Number Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
              <Papicon icon="Gamepad2" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_guess_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_guess_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="guessNumberChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="guessNumberChannel"
              bind:value={config.funGuessNumberChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant/50">{m.fun_game_state_title()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center">
              <span class="text-[10px] text-on-surface-variant/50 uppercase font-bold">{m.fun_guess_target()}</span>
              <p class="text-2xl font-semibold text-emerald-500 mt-0.5">{gameState.guessNumberTarget || '???'}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetGuessNumber}
          disabled={!canManageSettings || actionState.state.loading}
          class="w-full py-3.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 rounded-lg text-[13px] font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_guess_btn()}
        </button>
      </section>

      <!-- Word Chain Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-500 flex items-center justify-center">
              <Papicon icon="Link" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_wordchain_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_wordchain_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="wordChainChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="wordChainChannel"
              bind:value={config.funWordChainChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-sky-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant/50">{m.fun_game_state_title()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center flex flex-col justify-center min-w-0">
              <span class="text-[10px] text-on-surface-variant/50 uppercase font-bold truncate">{m.fun_wordchain_last_word()}</span>
              <p class="text-lg font-semibold text-sky-500 mt-0.5 truncate">{gameState.wordChainLastWord || m.fun_none()}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetWordChain}
          disabled={!canManageSettings || actionState.state.loading}
          class="w-full py-3.5 bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 rounded-lg text-[13px] font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_wordchain_btn()}
        </button>
      </section>

      <!-- Emoji Riddle Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center">
              <Papicon icon="Puzzle" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_emojiriddle_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_emojiriddle_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="emojiRiddleChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="emojiRiddleChannel"
              bind:value={config.funEmojiRiddleChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-rose-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant/50">{m.fun_emojiriddle_current_clue()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center">
              <p class="text-2xl mt-0.5">{gameState.emojiRiddleEmojis || '❓'}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetEmojiRiddle}
          disabled={!canManageSettings || actionState.state.loading}
          class="w-full py-3.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 rounded-lg text-[13px] font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_emojiriddle_btn()}
        </button>
      </section>

      <!-- Never Say Yes/No Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-orange-500/10 text-orange-500 flex items-center justify-center">
              <Papicon icon="MessageSquareOff" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_neversay_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_neversay_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="neverSayChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="neverSayChannel"
              bind:value={config.funNeverSayChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-orange-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <div class="text-[11px] text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_neversay_hint()}
        </div>
      </section>

      <!-- Emoji Only Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-teal-500/10 text-teal-500 flex items-center justify-center">
              <Papicon icon="Sticker" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_emojionly_title()}</h3>
              <p class="text-[10px] text-on-surface-variant/55 uppercase font-bold tracking-wider">{m.fun_emojionly_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="emojiOnlyChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="emojiOnlyChannel"
              bind:value={config.funEmojiOnlyChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-teal-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <div class="text-[11px] text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_emojionly_hint()}
        </div>
      </section>
    </div>
  {/if}
</ModulePage>
