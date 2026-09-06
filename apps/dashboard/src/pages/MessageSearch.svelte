<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    searchMessages,
    fetchMessageLogChannels,
    fetchMessageLogStats,
    updateMessageLogConfig,
    deleteMessageLog,
    fetchDiscordChannels,
    type MessageLogEntry,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import { m, dateLocale } from '../lib/i18n';

  const PAGE_SIZE = 50;

  let messages = $state<MessageLogEntry[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasSearched = $state(false);

  // Filters
  let query = $state('');
  let channelId = $state('');
  let authorId = $state('');
  let botFilter = $state<'all' | 'true' | 'false'>('all');
  let onlyAttachments = $state(false);
  let includeDeleted = $state(false);
  let order = $state<'desc' | 'asc'>('desc');
  let showFilters = $state(false);

  // Config / stats
  let channels = $state<{ channelId: string; channelName: string; count: number }[]>([]);
  let stats = $state<{
    total: number;
    enabled: boolean;
    retentionDays: number;
    ignoredChannels: string[];
    status: {
      status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
      error: string | null;
      scrapedChannelsCount: number;
      totalChannelsCount: number;
      scrapedMessagesCount: number;
      currentChannelName: string;
      startedAt: string;
      completedAt?: string;
    } | null;
  } | null>(null);
  let savingConfig = $state(false);
  let retentionInput = $state(90);
  let guildChannels = $state<{ id: string; name: string }[]>([]);
  let ignoredDraft = $state<string[]>([]);
  let pendingDeleteId = $state<string | null>(null);

  const isAdmin = $derived(dashboardStore.state.access?.canManageSettings === true);

  const ignoredDirty = $derived(
    ignoredDraft.join(',') !== (stats?.ignoredChannels ?? []).join(','),
  );

  // Logging only captures messages sent AFTER activation, so early on there is
  // little/no data. Surface this so users don't mistake it for a bug.
  const enabledButEmpty = $derived(stats?.enabled === true && stats.total === 0);
  const enabledLowData = $derived(stats?.enabled === true && stats.total > 0 && stats.total < 50);

  // Polling logic for retroactive backfill/indexing status
  let pollInterval: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (stats?.status?.status === 'IN_PROGRESS') {
      if (!pollInterval) {
        pollInterval = setInterval(async () => {
          const st = await fetchMessageLogStats();
          if (st) {
            stats = st as any;
            if (st.status?.status !== 'IN_PROGRESS') {
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
              await refreshMeta();
              await search(true);
            }
          }
        }, 4000);
      }
    } else {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function buildParams(currentOffset: number) {
    return {
      q: query.trim() || undefined,
      channelId: channelId || undefined,
      authorId: authorId.trim() || undefined,
      isBot: botFilter === 'all' ? undefined : (botFilter as 'true' | 'false'),
      hasAttachment: onlyAttachments ? ('true' as const) : undefined,
      includeDeleted: includeDeleted || undefined,
      order,
      limit: PAGE_SIZE,
      offset: currentOffset,
    };
  }

  async function search(reset = true) {
    if (reset) {
      loading = true;
      offset = 0;
    } else {
      loadingMore = true;
    }
    hasSearched = true;
    try {
      const res = await searchMessages(buildParams(reset ? 0 : offset));
      total = res.total;
      messages = reset ? res.messages : [...messages, ...res.messages];
    } catch {
      if (reset) messages = [];
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  function onQueryInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(true), 350);
  }

  async function loadMore() {
    offset += PAGE_SIZE;
    await search(false);
  }

  async function refreshMeta() {
    const [ch, st] = await Promise.all([fetchMessageLogChannels(), fetchMessageLogStats()]);
    channels = ch;
    stats = st;
    if (st) {
      retentionInput = st.retentionDays;
      ignoredDraft = [...(st.ignoredChannels ?? [])];
    }
  }

  async function toggleLogging(enabled: boolean) {
    savingConfig = true;
    try {
      const res = await updateMessageLogConfig({ enabled });
      if (res) {
        stats = stats ? {
          ...stats,
          enabled: res.enabled,
          retentionDays: res.retentionDays,
          status: (res as any).status ?? null
        } : null;
        if (enabled) {
          toast.success(m.ms_logging_enabled());
        } else {
          toast.success(m.ms_logging_disabled());
        }
      }
    } finally {
      savingConfig = false;
    }
  }

  async function saveIgnoredChannels() {
    savingConfig = true;
    try {
      const res = await updateMessageLogConfig({ ignoredChannels: ignoredDraft });
      if (res && stats) {
        stats = { ...stats, ignoredChannels: res.ignoredChannels };
        ignoredDraft = [...res.ignoredChannels];
        toast.success(m.ms_ignored_channels_saved());
      }
    } finally {
      savingConfig = false;
    }
  }

  async function saveRetention() {
    savingConfig = true;
    try {
      const res = await updateMessageLogConfig({ retentionDays: retentionInput });
      if (res && stats) stats = { ...stats, retentionDays: res.retentionDays };
    } finally {
      savingConfig = false;
    }
  }

  async function confirmDelete(id: string) {
    const ok = await deleteMessageLog(id);
    if (ok) {
      messages = messages.filter((m) => m.id !== id);
      total = Math.max(0, total - 1);
      pendingDeleteId = null;
    }
  }

  function resetFilters() {
    channelId = '';
    authorId = '';
    botFilter = 'all';
    onlyAttachments = false;
    includeDeleted = false;
    order = 'desc';
    search(true);
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  onMount(async () => {
    await refreshMeta();
    await search(true);
    // La journalisation couvre aussi le salon textuel des salons vocaux.
    const channelsData = await fetchDiscordChannels().catch(() => null);
    if (channelsData) {
      guildChannels = [...(channelsData.textChannels || []), ...(channelsData.voiceChannels || [])];
    }
  });
</script>

<ModulePage
  title={m.ms_page_title()}
  description={m.ms_page_desc()}
  icon="search"
  featureKey=""
>
  {#snippet actions()}
    <RefreshButton onClick={() => { refreshMeta(); search(true); }} />
  {/snippet}

  {#snippet children()}
    <div class="flex flex-col gap-6">
      <!-- Logging config / status -->
      <div class="flex flex-col sm:flex-row sm:items-center gap-4 p-4 bg-surface-container-low/60 border border-outline-variant/20 rounded-xl">
        <div class="flex items-center gap-3 flex-1">
          <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 {stats?.enabled ? 'bg-primary/10' : 'bg-surface-container'}">
            <Papicon icon="message" size={18} class={stats?.enabled ? 'text-primary' : 'text-on-surface-variant/50'} />
          </div>
          <div>
            <p class="text-sm font-semibold text-on-surface">
              {m.ms_logging_label()} {stats?.enabled ? m.common_enabled() : m.common_disabled()}
            </p>
            <p class="text-xs text-on-surface-variant/60">
              {stats ? m.ms_messages_recorded({ count: stats.total }) : m.common_loading()}
            </p>
          </div>
        </div>

        {#if isAdmin}
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-2">
              <label for="retention" class="text-xs text-on-surface-variant/70">{m.ms_retention_days()}</label>
              <input
                id="retention"
                type="number"
                min="0"
                max="3650"
                bind:value={retentionInput}
                onchange={saveRetention}
                disabled={savingConfig}
                class="w-20 px-2 py-1.5 bg-surface-container border border-outline-variant/30 rounded-md text-sm text-on-surface focus:outline-none focus:border-primary/60"
              />
            </div>
            <ToggleSwitch
              checked={stats?.enabled ?? false}
              disabled={savingConfig}
              onToggle={toggleLogging}
              size="lg"
            />
          </div>
        {/if}
      </div>

      {#if isAdmin}
        <div class="p-4 bg-surface-container-low/60 border border-outline-variant/20 rounded-xl space-y-1.5">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-semibold text-on-surface">{m.ms_ignored_channels_label()}</span>
            {#if ignoredDirty}
              <button
                class="px-3 py-1.5 bg-primary text-on-primary text-xs font-medium rounded-lg active:scale-[0.98] transition-all"
                onclick={saveIgnoredChannels}
                disabled={savingConfig}
              >
                {m.common_save()}
              </button>
            {/if}
          </div>
          <MultiSelect
            id="message-log-ignored-channels"
            bind:values={ignoredDraft}
            options={guildChannels.map((c) => ({ id: c.id, name: `#${c.name}` }))}
            disabled={savingConfig}
            accentClass="bg-rose-500/20 text-rose-300 border-rose-500/40"
          />
          <p class="text-[11px] text-on-surface-variant/50">{m.ms_ignored_channels_help()}</p>
        </div>
      {/if}

      <!-- Delay-before-data notice: logging only captures messages sent after activation -->
      {#if stats?.status?.status === 'IN_PROGRESS'}
        <div class="flex items-start gap-3 p-4 bg-primary/10 border border-primary/20 rounded-xl">
          <div class="shrink-0 mt-1 text-primary">
            <div class="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full"></div>
          </div>
          <div class="text-sm">
            <p class="font-semibold text-on-surface">{m.ms_indexing_in_progress()}</p>
            <p class="text-on-surface-variant/80 mt-0.5">
              {m.ms_indexing_desc({ days: stats.retentionDays })}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant/60 font-medium">
              <span>{m.ms_current_channel()} <strong>#{stats.status.currentChannelName || '...'}</strong></span>
              <span>{m.ms_channels_scraped()} <strong>{stats.status.scrapedChannelsCount} / {stats.status.totalChannelsCount}</strong></span>
              <span>{m.ms_messages_imported()} <strong>{stats.status.scrapedMessagesCount.toLocaleString(dateLocale())}</strong></span>
            </div>
          </div>
        </div>
      {:else if stats?.status?.status === 'FAILED'}
        <div class="flex items-start gap-3 p-4 bg-error/10 border border-error/20 rounded-xl">
          <div class="shrink-0 mt-0.5 text-error">
            <Papicon icon="alert-circle" size={18} />
          </div>
          <div class="text-sm">
            <p class="font-semibold text-on-surface">{m.ms_indexing_failed()}</p>
            <p class="text-on-surface-variant/80 mt-0.5">
              {m.ms_indexing_error({ error: stats.status.error || '' })}
            </p>
          </div>
        </div>
      {:else if enabledButEmpty}
        <div class="flex items-start gap-3 p-4 bg-primary/10 border border-primary/20 rounded-xl">
          <div class="shrink-0 mt-0.5 text-primary">
            <Papicon icon="info" size={18} />
          </div>
          <div class="text-sm">
            <p class="font-semibold text-on-surface">{m.ms_collect_started_title()}</p>
            <p class="text-on-surface-variant/80 mt-0.5">
              {m.ms_collect_started_desc()}
            </p>
          </div>
        </div>
      {:else if enabledLowData}
        <div class="flex items-start gap-3 p-3 bg-surface-container-low/60 border border-outline-variant/20 rounded-xl">
          <div class="shrink-0 mt-0.5 text-on-surface-variant/60">
            <Papicon icon="info" size={16} />
          </div>
          <p class="text-xs text-on-surface-variant/80">
            {m.ms_logging_recent_notice()}
          </p>
        </div>
      {/if}

      <!-- Search bar -->
      <div class="flex items-center gap-3">
        <div class="relative flex-1">
          <div class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50">
            <Papicon icon="search" size={18} />
          </div>
          <input
            type="text"
            bind:value={query}
            oninput={onQueryInput}
            placeholder={m.ms_search_placeholder()}
            class="w-full pl-10 pr-4 py-2.5 bg-surface-container-low border border-outline-variant/30 rounded-lg text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/60 transition-colors"
          />
        </div>
        <button
          onclick={() => (showFilters = !showFilters)}
          class="flex items-center gap-2 px-4 py-2.5 bg-surface-container-low border border-outline-variant/30 text-on-surface rounded-lg hover:bg-surface-container transition-colors text-sm font-medium"
        >
          <Papicon icon="filter" size={16} />
          {m.ms_filters_btn()}
        </button>
      </div>

      <!-- Filters panel -->
      {#if showFilters}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4 bg-surface-container-low/40 border border-outline-variant/20 rounded-xl">
          <div class="flex flex-col gap-1.5">
            <label for="f-channel" class="field-label">{m.ms_filter_channel()}</label>
            <select
              id="f-channel"
              bind:value={channelId}
              onchange={() => search(true)}
              class="px-3 py-2 bg-surface-container border border-outline-variant/30 rounded-md text-sm text-on-surface focus:outline-none focus:border-primary/60"
            >
              <option value="">{m.ms_all_channels()}</option>
              {#each channels as c (c.channelId)}
                <option value={c.channelId}>#{c.channelName} ({c.count})</option>
              {/each}
            </select>
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="f-author" class="field-label">{m.ms_author_id()}</label>
            <input
              id="f-author"
              type="text"
              bind:value={authorId}
              onchange={() => search(true)}
              placeholder="123456789012345678"
              class="px-3 py-2 bg-surface-container border border-outline-variant/30 rounded-md text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/60"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="f-bot" class="field-label">{m.ms_author_type()}</label>
            <select
              id="f-bot"
              bind:value={botFilter}
              onchange={() => search(true)}
              class="px-3 py-2 bg-surface-container border border-outline-variant/30 rounded-md text-sm text-on-surface focus:outline-none focus:border-primary/60"
            >
              <option value="all">{m.ms_authors_all()}</option>
              <option value="false">{m.ms_humans_only()}</option>
              <option value="true">{m.ms_bots_only()}</option>
            </select>
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="f-order" class="field-label">{m.ms_sort_label()}</label>
            <select
              id="f-order"
              bind:value={order}
              onchange={() => search(true)}
              class="px-3 py-2 bg-surface-container border border-outline-variant/30 rounded-md text-sm text-on-surface focus:outline-none focus:border-primary/60"
            >
              <option value="desc">{m.ms_newer_first()}</option>
              <option value="asc">{m.ms_older_first()}</option>
            </select>
          </div>

          <label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer self-end pb-2">
            <input type="checkbox" bind:checked={onlyAttachments} onchange={() => search(true)} class="accent-primary" />
            {m.ms_with_attachments()}
          </label>

          <label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer self-end pb-2">
            <input type="checkbox" bind:checked={includeDeleted} onchange={() => search(true)} class="accent-primary" />
            {m.ms_include_deleted()}
          </label>

          <div class="sm:col-span-2 lg:col-span-3 flex justify-end">
            <button
              onclick={resetFilters}
              class="px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
            >{m.ms_reset_filters()}</button>
          </div>
        </div>
      {/if}

      <div class="flex items-center justify-between">
        <p class="text-sm text-on-surface-variant/70">{m.ms_results_count({ count: total })}</p>
      </div>

      <!-- Results -->
      {#if loading}
        <div class="flex items-center justify-center py-16">
          <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
        </div>
      {:else if messages.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <div class="w-16 h-16 bg-surface-container-low rounded-2xl flex items-center justify-center mb-4">
            <Papicon icon="message" size={32} class="text-on-surface-variant/40" />
          </div>
          <h3 class="text-lg font-semibold text-on-surface mb-1">{m.ms_no_message_title()}</h3>
          <p class="text-sm text-on-surface-variant/60 max-w-sm">
            {#if !stats?.enabled}
              {m.ms_empty_disabled()}
            {:else if enabledButEmpty}
              {m.ms_empty_just_started()}
            {:else if hasSearched}
              {m.ms_empty_no_match()}
            {:else}
              {m.ms_empty_default()}
            {/if}
          </p>
        </div>
      {:else}
        <div class="flex flex-col gap-2">
          {#each messages as message (message.id)}
            <div class="flex gap-3 p-4 bg-surface-container-low/60 border border-outline-variant/20 rounded-lg hover:border-outline-variant/40 transition-colors {message.deletedAt ? 'opacity-70' : ''}">
              {#if message.authorAvatar}
                <img src={message.authorAvatar} alt="" class="w-9 h-9 rounded-full shrink-0" />
              {:else}
                <div class="w-9 h-9 rounded-full bg-surface-container flex items-center justify-center shrink-0">
                  <Papicon icon="user" size={16} class="text-on-surface-variant/50" />
                </div>
              {/if}

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-semibold text-on-surface">{message.authorName}</span>
                  {#if message.isBot}
                    <span class="px-1.5 py-0.5 text-[10px] font-bold bg-primary/20 text-primary rounded">BOT</span>
                  {/if}
                  <span class="text-xs text-on-surface-variant/50">#{message.channelName}</span>
                  <span class="text-xs text-on-surface-variant/40">· {formatDate(message.createdAt)}</span>
                  {#if message.editedAt}
                    <span class="text-xs text-on-surface-variant/40">{m.ms_edited()}</span>
                  {/if}
                  {#if message.deletedAt}
                    <span class="px-1.5 py-0.5 text-[10px] font-bold bg-error/20 text-error rounded">{m.ms_deleted_badge()}</span>
                  {/if}
                </div>

                {#if message.content}
                  <p class="text-sm text-on-surface-variant mt-1 whitespace-pre-wrap break-words">{message.content}</p>
                {/if}

                {#if message.attachments && message.attachments.length > 0}
                  <div class="flex flex-wrap gap-2 mt-2">
                    {#each message.attachments as att}
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noopener"
                        class="flex items-center gap-1.5 px-2 py-1 text-xs bg-surface-container border border-outline-variant/30 rounded-md text-primary hover:bg-surface-container-high transition-colors"
                      >
                        <Papicon icon="download" size={12} />
                        {att.name}
                      </a>
                    {/each}
                  </div>
                {/if}
              </div>

              {#if isAdmin}
                {#if pendingDeleteId === message.id}
                  <div class="flex items-center gap-2 shrink-0">
                    <button
                      onclick={() => confirmDelete(message.id)}
                      class="px-2.5 py-1 text-xs font-medium bg-error text-white rounded-md hover:bg-error/90 transition-colors"
                    >{m.common_delete()}</button>
                    <button
                      onclick={() => (pendingDeleteId = null)}
                      class="px-2.5 py-1 text-xs font-medium bg-surface-container text-on-surface rounded-md hover:bg-surface-container-high transition-colors"
                    >{m.common_cancel()}</button>
                  </div>
                {:else}
                  <button
                    onclick={() => (pendingDeleteId = message.id)}
                    class="flex items-center justify-center w-8 h-8 text-on-surface-variant hover:text-error hover:bg-error/10 rounded-md transition-colors shrink-0"
                    title={m.ms_delete_history_title()}
                    aria-label={m.ms_delete_aria()}
                  >
                    <Papicon icon="trash" size={15} />
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        </div>

        {#if messages.length < total}
          <div class="flex justify-center">
            <button
              onclick={loadMore}
              disabled={loadingMore}
              class="px-4 py-2 text-sm font-medium bg-surface-container-low border border-outline-variant/30 text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50"
            >
              {loadingMore ? m.common_loading() : m.ms_load_more()}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  {/snippet}
</ModulePage>
