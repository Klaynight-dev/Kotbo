<script lang="ts">
import { m } from '../lib/i18n';
import { onMount } from 'svelte';
import { router } from 'tinro';
import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
import Papicon from '../lib/components/Papicon.svelte';
import {
  fetchChannelHealth,
  fetchChannelHealthAnalysis,
  updateChannelHealthConfig,
  resolveChannelHealthAlert,
  splitChannel,
  archiveChannel,
  fetchDiscordChannels,
} from '../lib/api';
import { toast } from '../lib/stores/toast.svelte';
import { channelDetailsModal } from '../lib/stores/channelDetailsModal.svelte';
import ModulePage from '../lib/components/ModulePage.svelte';
import ChannelHealthPresetPicker from '../lib/components/ChannelHealthPresetPicker.svelte';
import MultiSelect from '../lib/components/MultiSelect.svelte';
import {
  CHANNEL_HEALTH_DEFAULT_CONFIG,
  CHANNEL_HEALTH_EDITABLE_FIELDS,
  channelHealthValuesOf,
  findChannelHealthPreset,
  type ChannelHealthPreset,
} from '../lib/channelHealthPresets';

let loading = $state(true);
let error = $state('');
let data: any = $state(null);
let analysis: any = $state(null);
let analysisLoading = $state(false);
let configDraft: any = $state(null);
let savedConfig: any = $state(null);
let savingConfig = $state(false);
let availableChannels: Array<{ id: string; name: string; type: string }> = $state([]);
const healthTabs = ['accueil', 'overview', 'alerts', 'config'] as const;
const DEFAULT_TAB = 'accueil';
let activeTab = $state<'accueil' | 'overview' | 'alerts' | 'config'>(DEFAULT_TAB);

$effect(() => {
  const _path = $router.path;
  activeTab = resolveTabFromUrl('/channel-health', healthTabs, DEFAULT_TAB) as typeof activeTab;
});

// Sensibilite de la page d'accueil : elle ne touche qu'aux seuils et a la
// fenetre d'analyse. Les modes de decoupage et d'archivage restent a regler
// dans l'onglet detaille, un prereglage n'ayant pas a decider seul si le bot
// peut creer ou archiver des salons.
const selectedPreset = $derived(findChannelHealthPreset(configDraft));
const activePreset = $derived(findChannelHealthPreset(savedConfig));

// `null` tant que rien n'est configure : aucune carte ne doit alors se dire
// choisie, pas meme « Personnalise ».
const selectedCardId = $derived(configDraft ? selectedPreset?.id ?? 'custom' : null);
const activeCardId = $derived(savedConfig ? activePreset?.id ?? 'custom' : null);

// Compare a part : `some` compare par reference, deux listes de salons exclues
// identiques seraient toujours vues comme differentes.
const excludedDirty = $derived(
  (configDraft?.excludedChannelIds ?? []).join(',') !== (savedConfig?.excludedChannelIds ?? []).join(','),
);

// Compare champ par champ plutot que les objets entiers : la reponse du serveur
// porte aussi un `updatedAt`, qui rendrait la page eternellement modifiee.
const configDirty = $derived(
  !!configDraft
    && (!savedConfig
      || CHANNEL_HEALTH_EDITABLE_FIELDS.some((key) => configDraft[key] !== savedConfig[key])
      || excludedDirty),
);

// Des qu'une sensibilite est choisie, la configuration courante est la sienne :
// la carte « Personnalise » doit alors montrer la configuration enregistree,
// sans quoi elle devient le sosie de la carte qu'on vient de cliquer.
const customPresetValues = $derived(channelHealthValuesOf(selectedPreset ? savedConfig : configDraft));

// Le module jamais configure n'a pas de brouillon : la premiere sensibilite
// choisie sert alors d'initialisation, sans passer par l'onglet detaille.
function applyPreset(preset: ChannelHealthPreset) {
  if (!configDraft) {
    configDraft = { ...CHANNEL_HEALTH_DEFAULT_CONFIG, excludedChannelIds: [], ...preset.values };
    return;
  }
  Object.assign(configDraft, preset.values);
}

function openPresetDetail() {
  gotoTab('/channel-health', 'config', DEFAULT_TAB);
}

const statusLabels: Record<string, { label: () => string; color: string; icon: string }> = {
  HEALTHY:    { label: () => m.channel_health_status_healthy(),    color: '#57f287', icon: 'check-circle' },
  OVERLOADED: { label: () => m.channel_health_status_overloaded(), color: '#ed4245', icon: 'alert-triangle' },
  UNDERUSED:  { label: () => m.channel_health_status_underused(),  color: '#fee75c', icon: 'alert-circle' },
  DEAD:       { label: () => m.channel_health_status_dead(),       color: '#747f8d', icon: 'x-circle' },
};

const alertTypeLabels: Record<string, () => string> = {
  SPLIT_SUGGESTED: () => m.channel_health_alert_split_suggested(),
  SPLIT_AUTO: () => m.channel_health_alert_split_auto(),
  ARCHIVE_SUGGESTED: () => m.channel_health_alert_archive_suggested(),
  ARCHIVE_AUTO: () => m.channel_health_alert_archive_auto(),
  MERGE_SUGGESTED: () => m.channel_health_alert_merge_suggested(),
};

const alertStatusLabels: Record<string, { label: () => string; color: string }> = {
  PENDING: { label: () => m.channel_health_alert_status_pending(), color: '#fee75c' },
  APPLIED: { label: () => m.channel_health_alert_status_applied(), color: '#57f287' },
  DISMISSED: { label: () => m.channel_health_alert_status_dismissed(), color: '#747f8d' },
  EXPIRED: { label: () => m.channel_health_alert_status_expired(), color: '#747f8d' },
};

async function load() {
  loading = true;
  error = '';
  try {
    data = await fetchChannelHealth();
    if (data?.config) {
      configDraft = { ...data.config, excludedChannelIds: [...(data.config.excludedChannelIds ?? [])] };
      savedConfig = { ...data.config, excludedChannelIds: [...(data.config.excludedChannelIds ?? [])] };
    }
  } catch (e: any) {
    error = e.message || m.channel_health_err_load();
  } finally {
    loading = false;
  }
}

async function runAnalysis() {
  analysisLoading = true;
  try {
    analysis = await fetchChannelHealthAnalysis();
  } catch (e: any) {
    toast.error(e.message || m.channel_health_err_analysis());
  } finally {
    analysisLoading = false;
  }
}

async function saveConfig() {
  if (!configDraft) return;
  savingConfig = true;
  try {
    const result = await updateChannelHealthConfig(configDraft);
    if (result) {
      toast.success(m.channel_health_config_saved_toast());
      // `data` est nul tant que le premier chargement a echoue : la
      // configuration vient alors d'etre creee de toutes pieces.
      if (data) data.config = result;
      configDraft = { ...result, excludedChannelIds: [...(result.excludedChannelIds ?? [])] };
      savedConfig = { ...result, excludedChannelIds: [...(result.excludedChannelIds ?? [])] };
    }
  } catch (e: any) {
    toast.error(e.message || m.channel_health_err_save());
  } finally {
    savingConfig = false;
  }
}

async function handleResolve(alertId: string, action: 'APPLIED' | 'DISMISSED') {
  try {
    await resolveChannelHealthAlert(alertId, action);
    toast.success(action === 'APPLIED' ? m.channel_health_alert_applied_toast() : m.channel_health_alert_dismissed_toast());
    await load();
  } catch (e: any) {
    toast.error(e.message || m.common_error());
  }
}

async function handleSplit(channelId: string) {
  try {
    const result = await splitChannel(channelId);
    if (result?.ok) {
      toast.success(m.channel_health_channel_created_toast());
      await load();
    }
  } catch (e: any) {
    toast.error(e.message || m.channel_health_err_split());
  }
}

async function handleArchive(channelId: string) {
  try {
    const result = await archiveChannel(channelId);
    if (result?.ok) {
      toast.success(m.channel_health_channel_archived_toast());
      await load();
    }
  } catch (e: any) {
    toast.error(e.message || m.channel_health_err_archive());
  }
}

onMount(async () => {
  await load();
  const channelsData = await fetchDiscordChannels().catch(() => null);
  // L'analyse ne porte que sur les salons textuels : proposer les forums et les
  // fils ferait croire qu'ils entrent dans le rapport.
  if (channelsData) {
    availableChannels = (channelsData.textChannels || []).filter((c: any) => c.type === 'text');
  }
});
</script>

<ModulePage
  title={m.channel_health_page_title()}
  description={m.channel_health_page_desc()}
  icon="activity"
  featureKey="channel_health"
>
  {#snippet actions()}
    <button
      class="px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all flex items-center gap-2"
      onclick={runAnalysis}
      disabled={analysisLoading}
    >
      <Papicon icon="refresh-cw" size={16} />
      {analysisLoading ? m.channel_health_analyzing() : m.channel_health_run_analysis_btn()}
    </button>
  {/snippet}

<!-- ======================== TABS ======================== -->
<div class="tab-group w-fit mb-6">
  <button
    class="tab-button {activeTab === 'accueil' ? 'active' : ''}"
    onclick={() => gotoTab('/channel-health', 'accueil', DEFAULT_TAB)}
  >
    <Papicon icon="sliders-horizontal" size={15} /> {m.channel_health_tab_presets()}
  </button>
  <button
    class="tab-button {activeTab === 'overview' ? 'active' : ''}"
    onclick={() => gotoTab('/channel-health', 'overview', DEFAULT_TAB)}
  >
    <Papicon icon="pie-chart" size={15} /> {m.channel_health_tab_overview()}
  </button>
  <button
    class="tab-button {activeTab === 'alerts' ? 'active' : ''}"
    onclick={() => gotoTab('/channel-health', 'alerts', DEFAULT_TAB)}
  >
    <Papicon icon="bell" size={15} /> {m.channel_health_tab_alerts()}
    {#if data?.pendingAlerts?.length > 0}
      <span class="px-1.5 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full leading-none">{data.pendingAlerts.length}</span>
    {/if}
  </button>
  <button
    class="tab-button {activeTab === 'config' ? 'active' : ''}"
    onclick={() => gotoTab('/channel-health', 'config', DEFAULT_TAB)}
  >
    <Papicon icon="settings" size={15} /> {m.channel_health_tab_config()}
  </button>
</div>

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/50 gap-4">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    <p class="text-sm">{m.common_loading()}</p>
  </div>
{:else if error}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/50 gap-4">
    <Papicon icon="alert-circle" size={32} />
    <p class="text-sm">{error}</p>
    <button class="px-4 py-2 bg-primary text-on-primary text-[13px] font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2" onclick={load}>{m.common_retry()}</button>
  </div>
{:else}

  <!-- ==================== TAB: PRESETS ==================== -->
  {#if activeTab === 'accueil'}
    <ChannelHealthPresetPicker
      selectedId={selectedCardId}
      activeId={activeCardId}
      customValues={customPresetValues}
      dirty={configDirty}
      saving={savingConfig}
      moduleEnabled={configDraft ? !!configDraft.enabled : true}
      onselect={applyPreset}
      onsave={saveConfig}
      ondetail={openPresetDetail}
    />
  {/if}

  <!-- ==================== TAB: OVERVIEW ==================== -->
  {#if activeTab === 'overview'}
    {#if !data?.config?.enabled}
      <!-- Disabled state -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-10 flex flex-col items-center justify-center text-center gap-4">
        <Papicon icon="activity" size={48} />
        <h3 class="text-base font-semibold text-on-surface">{m.channel_health_monitor_disabled_title()}</h3>
        <p class="text-sm text-on-surface-variant/60 max-w-md">{m.channel_health_monitor_disabled_desc()}</p>
        <button
          class="px-4 py-2 bg-primary text-on-primary text-[13px] font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
          onclick={() => { gotoTab('/channel-health', 'config', DEFAULT_TAB); if (configDraft) configDraft.enabled = true; }}
        >
          {m.channel_health_enable_monitor_btn()}
        </button>
      </div>
    {:else if analysis}
      <!-- Summary Cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {#each Object.entries(statusLabels) as [status, info]}
          {@const count = analysis[status.toLowerCase()]?.length ?? 0}
          <div class="flex items-center gap-4 p-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl" style="border-left: 3px solid {info.color}">
            <div style="color: {info.color}">
              <Papicon icon={info.icon} size={20} />
            </div>
            <div>
              <span class="text-2xl font-bold text-on-surface block">{count}</span>
              <span class="text-xs font-medium text-on-surface-variant/60">{info.label()}</span>
            </div>
          </div>
        {/each}
      </div>

      <!-- Channel List -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="hash" size={18} />
          {m.channel_health_all_channels_heading()}
        </h3>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-outline-variant/10">
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_channel()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_status()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_msg_day()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_users()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_total_msgs()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_trend()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_confidence()}</th>
                <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_actions()}</th>
              </tr>
            </thead>
            <tbody>
              {#each analysis.channels ?? [] as ch}
                {@const info = statusLabels[ch.status] ?? statusLabels.HEALTHY}
                <tr class="border-b border-outline-variant/5 hover:bg-surface-container-high/10 transition-colors">
                  <td class="px-3 py-2.5 text-sm font-semibold">
                    <button
                      type="button"
                      class="hover:text-primary transition-colors"
                      onclick={() => channelDetailsModal.show(ch.channelId, ch.channelName)}
                      title={m.channel_health_open_details()}
                    >#{ch.channelName}</button>
                  </td>
                  <td class="px-3 py-2.5 text-sm">
                    <span class="px-2.5 py-0.5 rounded-full text-xs font-medium" style="background: color-mix(in srgb, {info.color} 15%, transparent); color: {info.color}">{info.label()}</span>
                  </td>
                  <td class="px-3 py-2.5 text-sm">{ch.avgMsgPerDay.toFixed(1)}</td>
                  <td class="px-3 py-2.5 text-sm">{ch.uniqueUsersAvg.toFixed(0)}</td>
                  <td class="px-3 py-2.5 text-sm">{ch.totalMessages.toLocaleString()}</td>
                  <td class="px-3 py-2.5 text-sm">
                    {#if ch.trend === 'UP'}↗️
                    {:else if ch.trend === 'DOWN'}↘️
                    {:else}➡️
                    {/if}
                  </td>
                  <td class="px-3 py-2.5 text-sm">{ch.confidence}%</td>
                  <td class="px-3 py-2.5 text-sm whitespace-nowrap">
                    {#if ch.status === 'OVERLOADED'}
                      <button class="px-3 py-1.5 bg-amber-500/10 text-amber-500 rounded-lg text-xs font-bold hover:bg-amber-500/20 transition-all" onclick={() => handleSplit(ch.channelId)}>{m.channel_health_action_split()}</button>
                    {:else if ch.status === 'DEAD'}
                      <button class="px-3 py-1.5 bg-surface-container-high/40 text-on-surface-variant rounded-lg text-xs font-bold hover:bg-surface-container-high/60 transition-all" onclick={() => handleArchive(ch.channelId)}>{m.channel_health_action_archive()}</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {:else}
      <!-- No analysis yet -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-10 flex flex-col items-center justify-center text-center gap-4">
        <Papicon icon="bar-chart" size={48} />
        <h3 class="text-base font-semibold text-on-surface">{m.channel_health_no_analysis_title()}</h3>
        <p class="text-sm text-on-surface-variant/60 max-w-md">{m.channel_health_no_analysis_desc()}</p>
      </div>
    {/if}
  {/if}

  <!-- ==================== TAB: ALERTS ==================== -->
  {#if activeTab === 'alerts'}
    {#if data?.pendingAlerts?.length === 0 && data?.history?.length === 0}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-10 flex flex-col items-center justify-center text-center gap-4">
        <Papicon icon="check-circle" size={48} />
        <h3 class="text-base font-semibold text-on-surface">{m.channel_health_no_alerts_title()}</h3>
        <p class="text-sm text-on-surface-variant/60 max-w-md">{m.channel_health_no_alerts_desc()}</p>
      </div>
    {:else}
      {#if data?.pendingAlerts?.length > 0}
        <h3 class="text-base font-semibold flex items-center gap-2.5 mb-4">
          <Papicon icon="bell" size={18} />
          {m.channel_health_pending_alerts_heading({ count: data.pendingAlerts.length })}
        </h3>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {#each data.pendingAlerts as alert}
            <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 space-y-3 border-l-[3px]" style="border-left-color: #fee75c">
              <div class="flex justify-between items-center">
                <span class="text-xs font-medium text-amber-400">{alertTypeLabels[alert.type]?.() ?? alert.type}</span>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/15 text-primary">{alert.confidence}%</span>
              </div>
              <h4 class="text-sm font-semibold text-on-surface">
                <button
                  type="button"
                  class="hover:text-primary transition-colors"
                  onclick={() => channelDetailsModal.show(alert.channelId, alert.channelName)}
                  title={m.channel_health_open_details()}
                >#{alert.channelName ?? alert.channelId}</button>
              </h4>
              <p class="text-xs text-on-surface-variant/60">{alert.reason}</p>
              <div class="flex gap-4 text-xs font-medium text-on-surface-variant/60">
                <span>{m.channel_health_msg_per_day({ count: alert.avgMsgPerDay?.toFixed(1) })}</span>
                <span>{m.channel_health_users_avg({ count: alert.uniqueUsersAvg?.toFixed(0) })}</span>
                <span>{m.channel_health_analysis_period({ days: alert.analysisPeriod })}</span>
              </div>
              <div class="flex gap-2 pt-1">
                <button class="px-4 py-2 bg-primary text-on-primary text-[13px] font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2" onclick={() => handleResolve(alert.id, 'APPLIED')}>
                  {m.channel_health_alert_apply()}
                </button>
                <button class="px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all flex items-center gap-2" onclick={() => handleResolve(alert.id, 'DISMISSED')}>
                  {m.channel_health_alert_dismiss()}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if data?.history?.length > 0}
        <h3 class="text-base font-semibold flex items-center gap-2.5 mb-4 mt-8">
          <Papicon icon="clock" size={18} />
          {m.channel_health_history_heading()}
        </h3>
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6">
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="border-b border-outline-variant/10">
                  <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_date()}</th>
                  <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_channel()}</th>
                  <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_type()}</th>
                  <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_status()}</th>
                  <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">{m.channel_health_th_confidence()}</th>
                </tr>
              </thead>
              <tbody>
                {#each data.history as alert}
                  {@const statusInfo = alertStatusLabels[alert.status] ?? { label: () => alert.status, color: '#747f8d' }}
                  <tr class="border-b border-outline-variant/5 hover:bg-surface-container-high/10 transition-colors">
                    <td class="px-3 py-2.5 text-sm">{new Date(alert.createdAt).toLocaleDateString('fr-FR')}</td>
                    <td class="px-3 py-2.5 text-sm">
                      <button
                        type="button"
                        class="hover:text-primary transition-colors"
                        onclick={() => channelDetailsModal.show(alert.channelId, alert.channelName)}
                        title={m.channel_health_open_details()}
                      >#{alert.channelName ?? alert.channelId}</button>
                    </td>
                    <td class="px-3 py-2.5 text-sm">{alertTypeLabels[alert.type]?.() ?? alert.type}</td>
                    <td class="px-3 py-2.5 text-sm">
                      <span class="px-2.5 py-0.5 rounded-full text-xs font-medium" style="background: color-mix(in srgb, {statusInfo.color} 15%, transparent); color: {statusInfo.color}">{statusInfo.label()}</span>
                    </td>
                    <td class="px-3 py-2.5 text-sm">{alert.confidence}%</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    {/if}
  {/if}

  <!-- ==================== TAB: CONFIG ==================== -->
  {#if activeTab === 'config' && configDraft}
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-6">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="settings" size={18} />
        {m.channel_health_config_heading()}
      </h3>

      <div class="space-y-5">
        <!-- General -->
        <label class="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" class="w-[18px] h-[18px] accent-primary" bind:checked={configDraft.enabled} />
          <span class="text-sm text-on-surface">{m.channel_health_field_enabled()}</span>
        </label>

        <div class="space-y-1.5">
          <label for="analysis-period" class="field-label">{m.channel_health_field_period()}</label>
          <input id="analysis-period" type="number" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none" bind:value={configDraft.analysisPeriodDays} min={7} max={90} />
        </div>

        <div class="space-y-1.5">
          <label for="split-mode" class="field-label">{m.channel_health_field_split_mode()}</label>
          <select id="split-mode" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm" bind:value={configDraft.splitMode}>
            <option value="NOTIFY">{m.channel_health_mode_notify_only()}</option>
            <option value="AUTO">{m.channel_health_mode_auto()}</option>
          </select>
        </div>

        <div class="space-y-1.5">
          <label for="archive-mode" class="field-label">{m.channel_health_field_archive_mode()}</label>
          <select id="archive-mode" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm" bind:value={configDraft.archiveMode}>
            <option value="NOTIFY">{m.channel_health_mode_notify_only()}</option>
            <option value="AUTO">{m.channel_health_mode_auto()}</option>
          </select>
        </div>

        <!-- Divider: Excluded channels -->
        <hr class="border-outline-variant/10" />

        <h4 class="text-sm font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="filter_list_off" size={16} />
          {m.channel_health_section_excluded()}
        </h4>

        <div class="space-y-1.5">
          <span class="field-label">{m.channel_health_field_excluded_channels()}</span>
          <MultiSelect
            id="excluded-channels"
            bind:values={configDraft.excludedChannelIds}
            options={availableChannels.map((c) => ({ id: c.id, name: `#${c.name}` }))}
            accentClass="bg-rose-500/20 text-rose-300 border-rose-500/40"
          />
          <p class="text-[11px] text-on-surface-variant/50">{m.channel_health_field_excluded_channels_help()}</p>
        </div>

        <!-- Divider: Overload thresholds -->
        <hr class="border-outline-variant/10" />

        <h4 class="text-sm font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="alert-triangle" size={16} />
          {m.channel_health_section_overload()}
        </h4>

        <div class="space-y-1.5">
          <label for="overload-msg-hour" class="field-label">{m.channel_health_field_overload_msg_hour()}</label>
          <input id="overload-msg-hour" type="number" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none" bind:value={configDraft.overloadMsgPerHour} min={10} />
        </div>

        <div class="space-y-1.5">
          <label for="overload-unique-users" class="field-label">{m.channel_health_field_overload_unique_users()}</label>
          <input id="overload-unique-users" type="number" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none" bind:value={configDraft.overloadUniqueUsers} min={5} />
        </div>

        <!-- Divider: Underuse thresholds -->
        <hr class="border-outline-variant/10" />

        <h4 class="text-sm font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="alert-circle" size={16} />
          {m.channel_health_section_underuse()}
        </h4>

        <div class="space-y-1.5">
          <label for="underused-msg-day" class="field-label">{m.channel_health_field_underused_msg_day()}</label>
          <input id="underused-msg-day" type="number" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none" bind:value={configDraft.underusedMsgPerDay} min={1} />
        </div>

        <div class="space-y-1.5">
          <label for="underused-unique-users" class="field-label">{m.channel_health_field_underused_unique_users()}</label>
          <input id="underused-unique-users" type="number" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none" bind:value={configDraft.underusedUniqueUsers} min={1} />
        </div>

        <div class="space-y-1.5">
          <label for="dead-msg-week" class="field-label">{m.channel_health_field_dead_msg_week()}</label>
          <input id="dead-msg-week" type="number" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none" bind:value={configDraft.deadMsgPerWeek} min={0} />
        </div>

        <!-- Divider: Weekly digest -->
        <hr class="border-outline-variant/10" />

        <h4 class="text-sm font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="mail" size={16} />
          {m.channel_health_section_digest()}
        </h4>

        <label class="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" class="w-[18px] h-[18px] accent-primary" bind:checked={configDraft.weeklyDigestEnabled} />
          <span class="text-sm text-on-surface">{m.channel_health_field_digest_enabled()}</span>
        </label>

        <div class="space-y-1.5">
          <label for="weekly-digest-day" class="field-label">{m.channel_health_field_digest_day()}</label>
          <select id="weekly-digest-day" class="w-full max-w-[300px] px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm" bind:value={configDraft.weeklyDigestDay}>
            <option value={0}>{m.channel_health_day_sunday()}</option>
            <option value={1}>{m.channel_health_day_monday()}</option>
            <option value={2}>{m.channel_health_day_tuesday()}</option>
            <option value={3}>{m.channel_health_day_wednesday()}</option>
            <option value={4}>{m.channel_health_day_thursday()}</option>
            <option value={5}>{m.channel_health_day_friday()}</option>
            <option value={6}>{m.channel_health_day_saturday()}</option>
          </select>
        </div>
      </div>

      <div class="flex justify-end pt-2">
        <button class="px-4 py-2 bg-primary text-on-primary text-[13px] font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2" onclick={saveConfig} disabled={savingConfig}>
          {savingConfig ? m.channel_health_saving() : m.common_save()}
        </button>
      </div>
    </div>
  {:else if activeTab === 'config' && !configDraft}
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="settings" size={18} />
        {m.channel_health_config_heading()}
      </h3>
      <p class="text-sm text-on-surface-variant/60">{m.channel_health_not_configured_desc()}</p>
      <button
        class="px-4 py-2 bg-primary text-on-primary text-[13px] font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
        onclick={() => { configDraft = { ...CHANNEL_HEALTH_DEFAULT_CONFIG, excludedChannelIds: [] }; }}
      >
        {m.channel_health_init_config_btn()}
      </button>
    </div>
  {/if}

{/if}
</ModulePage>
