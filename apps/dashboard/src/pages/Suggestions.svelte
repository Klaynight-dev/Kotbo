<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import {
    fetchSuggestions,
    fetchSuggestionsConfig,
    updateSuggestionsConfig,
    resolveSuggestion,
  } from '../lib/api';

  const actionState = createAsyncActionState();
  const configAction = createAsyncActionState();
  let loading = $state(false);

  const canModerate = $derived(
    !!(dashboardStore.state.featureAccess as any)?.suggestions?.canModerate
      || !!dashboardStore.state.access?.canManageSettings
  );

  const canConfigure = $derived(
    !!dashboardStore.state.featureAccess?.suggestions?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let moduleConfig = $state({
    enabled: true,
    channelId: null as string | null,
  });

  // Snapshot of last-saved state
  let savedConfig = $state({
    enabled: true,
    channelId: null as string | null,
  });

  $effect(() => {
    const dirty = JSON.stringify(moduleConfig) !== JSON.stringify(savedConfig);
    if (dirty && canConfigure) {
      untrack(() => {
        unsavedChanges.register({
          id: 'suggestions',
          label: m.suggestions_page_title(),
          onSave: () => handleSaveConfig(),
          onReset: () => {
            moduleConfig = { ...savedConfig };
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('suggestions');
      });
    }
  });

  let unsubscribeRealtime: (() => void) | null = null;

  onDestroy(() => {
    unsubscribeRealtime?.();
    unsavedChanges.release('suggestions');
  });

  let suggestions = $state<Array<{
    id: string;
    userId: string;
    username: string;
    avatarUrl: string | null;
    content: string;
    status: string; // PENDING, APPROVED, REJECTED, IMPLEMENTED
    responseText: string | null;
    upvoters: string[];
    downvoters: string[];
    createdAt: string;
  }>>([]);

  // Filter selection state
  let currentFilter = $state<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'IMPLEMENTED'>('ALL');

  // Response text form states mapped by suggestion ID
  const responseDrafts = $state<Record<string, string>>({});

  async function loadSuggestions() {
    const res = await fetchSuggestions();
    if (res?.suggestions) {
      suggestions = res.suggestions;
    }
  }

  async function loadConfig() {
    const res = await fetchSuggestionsConfig();
    if (res?.config) {
      const loaded = {
        enabled: res.config.enabled ?? true,
        channelId: res.config.channelId ?? null,
      };
      moduleConfig = loaded;
      savedConfig = { ...loaded };
    }
  }

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      await Promise.all([loadSuggestions(), loadConfig()]);
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }

    unsubscribeRealtime = subscribeRealtime({
      reasons: ['suggestions_updated'],
      onUpdate: () => {
        void loadSuggestions();
      },
    });
  });

  async function handleSaveConfig(): Promise<boolean> {
    if (!canConfigure) return false;
    let success = false;
    await configAction.run(async () => {
      const res = await updateSuggestionsConfig(moduleConfig);
      if (!res?.config) throw new Error(m.suggestions_save_config_error());
      const saved = {
        enabled: res.config.enabled ?? true,
        channelId: res.config.channelId ?? null,
      };
      moduleConfig = saved;
      savedConfig = { ...saved };
      success = true;
      return true;
    }, { successMessage: m.suggestions_save_config_success() });
    return success;
  }

  async function handleResolve(id: string, status: 'APPROVED' | 'REJECTED' | 'IMPLEMENTED') {
    if (!canModerate) return;
    const responseText = responseDrafts[id] || '';
    if (!responseText.trim()) {
      actionState.setError(m.suggestions_comment_required_error());
      return;
    }

    await actionState.run(async () => {
      const res = await resolveSuggestion(id, { status, responseText });
      if (!res || !res.suggestion) throw new Error(m.suggestions_resolve_error());
      
      // Update local state
      suggestions = suggestions.map(s => s.id === id ? res.suggestion : s);
      responseDrafts[id] = '';
      return true;
    }, { successMessage: m.suggestions_resolve_success() });
  }

  const filteredSuggestions = $derived(
    currentFilter === 'ALL' 
      ? suggestions 
      : suggestions.filter(s => s.status === currentFilter)
  );

  const statusLabels = $derived<Record<string, string>>({
    'PENDING': m.suggestions_status_pending(),
    'APPROVED': m.suggestions_status_approved(),
    'REJECTED': m.suggestions_status_rejected(),
    'IMPLEMENTED': m.suggestions_status_implemented()
  });

  const statusColors: Record<string, string> = {
    'PENDING': 'bg-amber-400/20 text-amber-400 border-amber-400/20',
    'APPROVED': 'bg-emerald-400/20 text-emerald-400 border-emerald-400/20',
    'REJECTED': 'bg-rose-400/20 text-rose-400 border-rose-400/20',
    'IMPLEMENTED': 'bg-sky-400/20 text-sky-400 border-sky-400/20'
  };

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
</script>

<ModulePage
  title={m.suggestions_page_title()}
  description={m.suggestions_page_desc()}
  icon="thumbs-up"
  featureKey="suggestions"
>
  {#snippet actions()}
    <div class="tab-group" role="tablist">
      {#each ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'IMPLEMENTED'] as filter}
        <button
          onclick={() => currentFilter = filter as any}
          role="tab" aria-selected={currentFilter === filter}
          class="tab-button {currentFilter === filter ? 'active' : ''}"
        >
          {filter === 'ALL' ? m.suggestions_filter_all() : statusLabels[filter]}
        </button>
      {/each}
    </div>
  {/snippet}

  <InlineFeedback state={actionState} />
  <InlineFeedback state={configAction} />

  {#if loading}
    <Skeleton height="180px" radius="2rem" />
    <div class="space-y-4">
      <Skeleton height="150px" radius="2rem" />
      <Skeleton height="150px" radius="2rem" />
      <Skeleton height="150px" radius="2rem" />
    </div>
  {:else}
    <div class="space-y-6">
      {#each filteredSuggestions as suggestion}
        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 hover:bg-surface-container-low/40 transition-all">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-outline-variant/10 pb-4">
            <UserDisplay
              userId={suggestion.userId}
              name={suggestion.username}
              avatarUrl={suggestion.avatarUrl}
              subtitle={m.suggestions_posted_on({ date: formatDate(suggestion.createdAt) })}
              size="lg"
            />

            <div class="flex items-center gap-3">
              <!-- Upvote Downvote pills -->
              <div class="flex items-center gap-1.5 px-3 py-1 bg-emerald-400/10 border border-emerald-400/20 text-emerald-400 rounded-full text-xs font-semibold">
                <Papicon icon="ThumbsUp" size={12} /> {suggestion.upvoters.length}
              </div>
              <div class="flex items-center gap-1.5 px-3 py-1 bg-rose-400/10 border border-rose-400/20 text-rose-400 rounded-full text-xs font-semibold">
                <Papicon icon="Minus" size={12} /> {suggestion.downvoters.length}
              </div>
              <!-- Status badge -->
              <span class="px-4 py-1.5 rounded-full text-[13px] font-medium border {statusColors[suggestion.status]}">
                {statusLabels[suggestion.status]}
              </span>
            </div>
          </div>

          <div class="text-sm font-medium text-on-surface-variant/90 leading-relaxed whitespace-pre-wrap font-sans bg-surface-container-high/15 p-5 rounded-lg border border-outline-variant/5">
            {suggestion.content}
          </div>

          {#if suggestion.responseText}
            <!-- Public response display -->
            <div class="p-5 rounded-lg bg-secondary/5 border border-secondary/15 space-y-2 animate-in fade-in duration-200">
              <div class="flex items-center gap-2 text-xs font-semibold text-secondary uppercase tracking-wider">
                <Papicon icon="User" size={14} /> {m.suggestions_staff_response()}
              </div>
              <p class="text-sm text-on-surface-variant font-medium leading-relaxed font-sans">{suggestion.responseText}</p>
            </div>
          {/if}

          {#if suggestion.status === 'PENDING' && canModerate}
            <!-- Moderation actions form -->
            <div class="space-y-4 pt-4 border-t border-outline-variant/10 animate-in fade-in duration-300">
              <div class="space-y-1.5">
                <label for={`resp-${suggestion.id}`} class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.suggestions_public_comment_label()}</label>
                <textarea 
                  id={`resp-${suggestion.id}`}
                  bind:value={responseDrafts[suggestion.id]} 
                  placeholder={m.suggestions_public_comment_ph()}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none h-20 resize-none"
                ></textarea>
              </div>

              <div class="flex flex-wrap gap-3 justify-end">
                <button 
                  onclick={() => handleResolve(suggestion.id, 'REJECTED')}
                  disabled={!responseDrafts[suggestion.id]?.trim()}
                  class="px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white text-[13px] font-medium rounded-lg transition-all disabled:opacity-50"
                >
                  {m.suggestions_btn_reject()}
                </button>
                <button 
                  onclick={() => handleResolve(suggestion.id, 'APPROVED')}
                  disabled={!responseDrafts[suggestion.id]?.trim()}
                  class="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-[13px] font-medium rounded-lg transition-all disabled:opacity-50"
                >
                  {m.suggestions_btn_approve()}
                </button>
                <button 
                  onclick={() => handleResolve(suggestion.id, 'IMPLEMENTED')}
                  disabled={!responseDrafts[suggestion.id]?.trim()}
                  class="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white text-[13px] font-medium rounded-lg transition-all disabled:opacity-50"
                >
                  {m.suggestions_btn_implement()}
                </button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="section-card">
          <EmptyState
            icon="thumbs-up"
            title={m.suggestions_empty_title()}
            description={m.suggestions_empty_desc()}
          />
        </div>
      {/each}
    </div>

    {#if canConfigure}
      <SectionCard
        title={m.suggestions_config_section_title()}
        description={m.suggestions_config_section_desc()}
        icon="settings"
      >
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="flex items-center justify-between gap-4 p-4 bg-surface-container rounded-lg border border-outline-variant">
            <div>
              <p class="text-sm font-medium text-on-surface">{m.suggestions_system_toggle_title()}</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.suggestions_system_toggle_desc()}</p>
            </div>
            <ToggleSwitch
              checked={moduleConfig.enabled}
              onToggle={(v: boolean) => { moduleConfig.enabled = v; }}
              disabled={!canConfigure}
            />
          </div>

          <div>
            <label for="suggestions-channel" class="field-label">{m.suggestions_channel_label()}</label>
            <SearchableSelect
              id="suggestions-channel"
              bind:value={moduleConfig.channelId}
              options={availableChannels.map((c) => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.announcements_select_channel_placeholder()}
              className="w-full bg-surface-container border border-outline-variant rounded-lg px-4 py-3 text-sm"
              disabled={!canConfigure || !moduleConfig.enabled}
            />
          </div>
        </div>
      </SectionCard>
    {/if}
  {/if}
</ModulePage>
