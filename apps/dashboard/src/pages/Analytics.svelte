<script lang="ts">
import { onMount } from 'svelte';
import { router } from 'tinro';
import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
import { authStore } from '../lib/stores/auth.svelte';
import Papicon from '../lib/components/Papicon.svelte';
import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
import { fetchAnalytics, fetchMemberCase, fetchInviteAnalytics, fetchHourlyHeatmap, fetchWeeklyComparison, fetchDailyAlgoAnalytics, fetchGlobalInteractions, type AdvancedAnalyticsSection } from '../lib/api';
import AdvancedAnalyticsPanel from '../lib/components/analytics/AdvancedAnalyticsPanel.svelte';
import GhostMembersPanel from '../lib/components/analytics/GhostMembersPanel.svelte';
import AnalyticsSkeleton from '../lib/components/analytics/AnalyticsSkeleton.svelte';
import LoadingHint from '../lib/components/LoadingHint.svelte';
import StatsOverview from '../lib/components/analytics/StatsOverview.svelte';
import EngagementMetrics from '../lib/components/analytics/EngagementMetrics.svelte';
import MembersStats from '../lib/components/analytics/MembersStats.svelte';
import InvitationsStats from '../lib/components/analytics/InvitationsStats.svelte';
import ModerationAudit from '../lib/components/analytics/ModerationAudit.svelte';
import StaffAudit from '../lib/components/analytics/StaffAudit.svelte';
import HourlyHeatmap from '../lib/components/analytics/HourlyHeatmap.svelte';
import WeeklyComparison from '../lib/components/analytics/WeeklyComparison.svelte';
import DailyAlgoAnalyticsCard from '../lib/components/analytics/DailyAlgoAnalyticsCard.svelte';
import CommandUsage from '../lib/components/analytics/CommandUsage.svelte';
import StaffPerformance from '../lib/components/analytics/StaffPerformance.svelte';
import GlobalInteractionGraph from '../lib/components/charts/GlobalInteractionGraph.svelte';
import { downloadXlsx } from '../lib/xlsxExport';
import { toast } from '../lib/stores/toast.svelte';
import ExportDropdown from '../lib/components/analytics/ExportDropdown.svelte';
import { m, dateLocale } from '../lib/i18n';

  let data: any = $state(null);
  let heatmapData: any = $state(null);
  let weeklyData: any = $state(null);
  let algoData: any = $state(null);
  let interactionsData: any = $state(null);
  let loading = $state(true);
  let loadingInteractions = $state(false);
  let error = $state('');
  let interactionsError = $state('');
  let period = $state(30);
  let startDate = $state('');
  let endDate = $state('');
  let isCustomPeriod = $state(false);

  const periodPresets = $derived([
    { label: m.an_period_24h(), value: 1 },
    { label: m.an_period_7d(), value: 7 },
    { label: m.an_period_30d(), value: 30 },
    { label: m.an_period_90d(), value: 90 },
    { label: m.an_period_365d(), value: 365 },
    { label: m.an_period_custom(), value: 'custom' }
  ]);

  let currentInteractionsRequestId = 0;

  async function loadInteractions() {
    const requestId = ++currentInteractionsRequestId;
    loadingInteractions = true;
    interactionsError = '';
    const options = isCustomPeriod 
      ? { startDate, endDate } 
      : { period };

    try {
      const res = await fetchGlobalInteractions(options);
      if (requestId === currentInteractionsRequestId) {
        interactionsData = res;
      }
    } catch (e: any) {
      if (requestId === currentInteractionsRequestId) {
        console.error('Error preloading interactions:', e);
        interactionsError = e.message || m.an_error_interactions();
      }
    } finally {
      if (requestId === currentInteractionsRequestId) {
        loadingInteractions = false;
      }
    }
  }

  async function load() {
    loading = true; error = '';
    const options = isCustomPeriod 
      ? { startDate, endDate } 
      : { period, ...(period === 1 ? { granularity: '30' } : {}) };

    try { 
      const [mainData, invites, heatmap, weekly, algo] = await Promise.all([
        fetchAnalytics(options),
        fetchInviteAnalytics(),
        fetchHourlyHeatmap(isCustomPeriod ? { startDate, endDate } : { days: period }),
        fetchWeeklyComparison(),
        fetchDailyAlgoAnalytics(isCustomPeriod ? { startDate, endDate } : { days: period })
      ]);
      data = mainData;
      invitesData = invites;
      heatmapData = heatmap;
      weeklyData = weekly;
      algoData = algo;
      
      // Pre-charge/preload the heavy interactions graph in the background
      loadInteractions();
    }
    catch (e: any) { error = e.message || m.an_error_generic(); }
    finally { loading = false; }
  }

  onMount(() => {
    // Default to local time for datetime-local
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    endDate = now.toISOString().slice(0, 16);
    
    const start = new Date();
    start.setDate(start.getDate() - 30);
    start.setMinutes(start.getMinutes() - start.getTimezoneOffset());
    startDate = start.toISOString().slice(0, 16);
    
    load();
  });

  function changePeriod(p: number | 'custom') { 
    if (p === 'custom') {
      isCustomPeriod = true;
    } else {
      isCustomPeriod = false;
      period = p; 
      load(); 
    }
  }

  function applyCustomRange() {
    if (startDate && endDate) {
      load();
    }
  }

  type ExportRow = Record<string, string | number | boolean | null>;
  type ExportSheet = { name: string; rows: ExportRow[] };

  function normalizeCellValue(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return JSON.stringify(value);
  }

  function normalizeRow(row: Record<string, unknown>): ExportRow {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)])
    ) as ExportRow;
  }

  function appendExportValue(sheets: ExportSheet[], name: string, value: unknown) {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      if (value.length === 0) return;
      if (typeof value[0] === 'object' && value[0] !== null) {
        sheets.push({
          name,
          rows: value.map((entry) => normalizeRow(entry as Record<string, unknown>))
        });
      } else {
        sheets.push({
          name,
          rows: value.map((entry, index) => ({ index: index + 1, value: normalizeCellValue(entry) }))
        });
      }
      return;
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const arrayEntries = entries.filter(([, entryValue]) => Array.isArray(entryValue));

      if (arrayEntries.length > 0) {
        for (const [key, nestedValue] of arrayEntries) {
          appendExportValue(sheets, `${name}_${key}`, nestedValue);
        }

        const scalarEntries = entries.filter(([, entryValue]) => !Array.isArray(entryValue));
        if (scalarEntries.length > 0) {
          sheets.push({
            name: `${name}_meta`,
            rows: scalarEntries.map(([key, entryValue]) => ({
              key,
              value: normalizeCellValue(entryValue)
            }))
          });
        }
        return;
      }

      sheets.push({ name, rows: [normalizeRow(value as Record<string, unknown>)] });
      return;
    }

    sheets.push({ name, rows: [{ value: normalizeCellValue(value) }] });
  }

  function collectExportSheets(): ExportSheet[] {
    const sheets: ExportSheet[] = [];
    appendExportValue(sheets, 'analytics_dailyTrend', data?.dailyTrend);
    appendExportValue(sheets, 'analytics_topChannels', data?.topChannels);
    appendExportValue(sheets, 'analytics_topVoiceChannels', data?.topVoiceChannels);
    appendExportValue(sheets, 'analytics_topMessageMembers', data?.topMessageMembers);
    appendExportValue(sheets, 'analytics_topVoiceMembers', data?.topVoiceMembers);
    appendExportValue(sheets, 'analytics_topInviters', data?.topInviters);
    appendExportValue(sheets, 'analytics_topModerators', data?.topModerators);
    appendExportValue(sheets, 'analytics_topSanctionedMembers', data?.topSanctionedMembers);
    appendExportValue(sheets, 'analytics_recentSanctions', data?.recentSanctions);
    appendExportValue(sheets, 'analytics_staff', data?.staff);
    appendExportValue(sheets, 'analytics_recruitmentPipeline', data?.recruitmentPipeline);
    appendExportValue(sheets, 'analytics_roleDistribution', data?.roleDistribution);
    appendExportValue(sheets, 'analytics_recentJoins', data?.recentJoins);
    appendExportValue(sheets, 'analytics_recentLeaves', data?.recentLeaves);
    appendExportValue(sheets, 'analytics_commandUsage', data?.commandUsage);
    appendExportValue(sheets, 'invites', invitesData);
    appendExportValue(sheets, 'heatmap', heatmapData);
    appendExportValue(sheets, 'weeklyComparison', weeklyData);
    appendExportValue(sheets, 'dailyAlgo', algoData);
    appendExportValue(sheets, 'interactions', interactionsData);
    return sheets;
  }

  function escapeCsvCell(value: string | number | boolean | null): string {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  function triggerDownload(content: BlobPart, fileName: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportAllToCSV() {
    const sheets = collectExportSheets();
    if (sheets.length === 0) {
      toast.error(m.an_export_no_data());
      return;
    }

    const csvParts: string[] = [];
    for (const sheet of sheets) {
      if (!sheet.rows.length) continue;
      const headers = Array.from(new Set(sheet.rows.flatMap((row) => Object.keys(row))));
      csvParts.push(`# ${sheet.name}`);
      csvParts.push(headers.join(','));
      for (const row of sheet.rows) {
        csvParts.push(headers.map((header) => escapeCsvCell(row[header] ?? null)).join(','));
      }
      csvParts.push('');
    }

    const datePart = new Date().toISOString().split('T')[0];
    triggerDownload(csvParts.join('\n'), `analytics_kotbo_all_${datePart}.csv`, 'text/csv;charset=utf-8');
    toast.success(m.an_export_csv_done());
  }

  async function exportAllToXLSX() {
    const sheets = collectExportSheets();
    if (sheets.length === 0) {
      toast.error(m.an_export_no_data());
      return;
    }

    const datePart = new Date().toISOString().split('T')[0];
    const exported = await downloadXlsx(`analytics_kotbo_all_${datePart}.xlsx`, sheets);
    if (!exported) {
      toast.error(m.an_export_no_data());
      return;
    }
    toast.success(m.an_export_xlsx_done());
  }

  function sanitizeFileNamePart(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'chart';
  }

  function isLargeGraphicElement(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width >= 280 && rect.height >= 160;
  }

  function resolveGraphicName(element: Element, index: number): string {
    const titleCandidate = element
      .closest('section, article, div')
      ?.querySelector('h1, h2, h3, h4, h5')
      ?.textContent
      ?.trim();
    const safeTitle = sanitizeFileNamePart(titleCandidate || `graph-${index}`);
    return `${String(index).padStart(2, '0')}_${safeTitle}`;
  }

  async function svgToBlob(svg: SVGSVGElement): Promise<Blob | null> {
    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svg);
    const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Impossible de convertir le SVG'));
        img.src = url;
      });

      const rect = svg.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.fillStyle = '#0f1118';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function exportAllChartsAsImages() {
    const root = document.getElementById('analytics-export-root');
    if (!root) {
      toast.error(m.an_export_root_missing());
      return;
    }

    const canvases = Array.from(root.querySelectorAll('canvas')).filter(isLargeGraphicElement);
    const svgs = Array.from(root.querySelectorAll('svg')).filter(isLargeGraphicElement);

    if (canvases.length === 0 && svgs.length === 0) {
      toast.error(m.an_export_no_visible_chart());
      return;
    }

    let exportedCount = 0;

    for (const [index, canvas] of canvases.entries()) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) continue;
      triggerDownload(blob, `analytics_${resolveGraphicName(canvas, index + 1)}.png`, 'image/png');
      exportedCount += 1;
    }

    const startIndex = exportedCount;
    for (const [index, svg] of svgs.entries()) {
      const blob = await svgToBlob(svg);
      if (!blob) continue;
      triggerDownload(blob, `analytics_${resolveGraphicName(svg, startIndex + index + 1)}.png`, 'image/png');
      exportedCount += 1;
    }

    if (exportedCount === 0) {
      toast.error(m.an_export_images_failed());
      return;
    }

    toast.success(m.an_export_images_done({ count: exportedCount }));
  }

  let activeCategory = $state('overview');
  let activeTab = $state('overview');

  const categories = $derived([
    { id: 'overview', label: m.an_cat_overview(), icon: 'Grid', description: m.an_cat_overview_desc() },
    { id: 'engagement', label: m.an_cat_engagement(), icon: 'ChatBubbles', description: m.an_cat_engagement_desc() },
    { id: 'community', label: m.an_cat_community(), icon: 'Compass', description: m.an_cat_community_desc() },
    { id: 'growth', label: m.an_cat_growth(), icon: 'TrendingUp', description: m.an_cat_growth_desc() },
    { id: 'moderation', label: m.an_cat_moderation(), icon: 'Gavel', description: m.an_cat_moderation_desc() },
    { id: 'invitations', label: m.an_cat_invitations(), icon: 'MailOpen', description: m.an_cat_invitations_desc() },
  ]);

  const tabsByCategory: Record<string, Array<{ id: string; label: string; icon: string; badge?: string; disabled?: boolean }>> = $derived({
    overview: [
      { id: 'overview', label: m.an_tab_overview(), icon: 'Grid' },
    ],
    engagement: [
      { id: 'messages', label: m.an_tab_messages(), icon: 'ChatCircleDots' },
      { id: 'voice', label: m.an_tab_voice(), icon: 'Microphone' },
      { id: 'interactions', label: m.an_tab_network(), icon: 'Compass' },
      { id: 'commands', label: m.an_tab_commands(), icon: 'Code' },
      { id: 'members', label: m.an_tab_members(), icon: 'UsersFour' },
    ],
    community: [
      { id: 'pulse', label: m.an_tab_pulse(), icon: 'Activity' },
      { id: 'channels', label: m.an_tab_channels(), icon: 'ChatBubbles' },
      { id: 'social', label: m.an_tab_social(), icon: 'Users' },
      { id: 'words', label: m.an_tab_words(), icon: 'ChatCircleDots' },
      { id: 'ghosts', label: m.ghost_tab(), icon: 'Ghost' },
    ],
    moderation: [
      { id: 'moderation', label: m.an_tab_moderation(), icon: 'Gavel' },
      { id: 'mod-advanced', label: m.an_tab_mod_advanced(), icon: 'ChartLineUp' },
      { id: 'staff', label: m.an_tab_staff_directory(), icon: 'Users' },
      { id: 'performance', label: m.an_tab_staff_performance(), icon: 'TrendUp' },
    ],
    invitations: [
      { id: 'invitations', label: m.an_tab_invitations(), icon: 'MailOpen' },
    ],
    growth: [
      { id: 'cohorts', label: m.an_tab_cohorts(), icon: 'UsersFour' },
      { id: 'churn', label: m.an_tab_churn(), icon: 'Warning' },
      { id: 'heatmap', label: m.an_tab_heatmap(), icon: 'Fire' },
      { id: 'weekly', label: m.an_tab_weekly(), icon: 'Calendar' },
      { id: 'algo', label: m.an_tab_algo(), icon: 'Code' },
    ],
  });

  /** Onglets servis par AdvancedAnalyticsPanel (chargent leurs propres données). */
  const ADVANCED_TABS: Record<string, AdvancedAnalyticsSection> = {
    pulse: 'activity',
    channels: 'channels',
    social: 'social',
    words: 'words',
    cohorts: 'retention',
    churn: 'churn',
    'mod-advanced': 'moderation',
  };

  const allValidTabs = $derived(Object.values(tabsByCategory).flatMap(tabs => tabs.map(t => t.id)));

  function categoryForTab(tabId: string): string {
    for (const [catId, tabs] of Object.entries(tabsByCategory)) {
      if (tabs.some(t => t.id === tabId)) return catId;
    }
    return 'overview';
  }

  $effect(() => {
    const _path = $router.path;
    const tab = resolveTabFromUrl('/analytics', allValidTabs, 'overview');
    activeTab = tab;
    activeCategory = categoryForTab(tab);
  });

  function selectTab(tab: { id: string; disabled?: boolean }) {
    if (tab.disabled) return;
    gotoTab('/analytics', tab.id, 'overview');
  }

  const currentTabs = $derived(tabsByCategory[activeCategory] || []);

  let invitesData: any = $state(null);
  
  // Member Case Modal state
  let modalOpen = $state(false);
  let selectedUserId = $state<string | null>(null);
  let selectedUserName = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  async function openMemberDetails(memberId: string, memberName: string) {
    selectedUserId = memberId;
    selectedUserName = memberName || m.an_member_fallback();
    modalOpen = true;
    loadingCase = true;
    caseError = '';
    caseData = null;

    try {
      caseData = await fetchMemberCase(memberId, authStore.selectedGuildId);
    } catch (e: any) {
      console.error(e);
      caseError = e.message || m.an_case_load_error();
    } finally {
      loadingCase = false;
    }
  }

  const fmt = (n: number) => n?.toLocaleString(dateLocale()) ?? '0';
  const fmtH = (mins: number) => { 
    const h = Math.floor((mins || 0) / 60); 
    const m = Math.round((mins || 0) % 60); 
    if (h > 0) return `${h}h${m > 0 ? String(m).padStart(2, '0') : ''}`;
    return `${m}min`;
  };
  const isWeeklyView = $derived(!isCustomPeriod && period > 90);
  const chartLabels = $derived(data?.dailyTrend?.map((d: any) => {
    if (isWeeklyView) {
      // dateKey is already the Monday of the week
      const parts = d.dateKey?.slice(5)?.split('-');
      return { ...d, label: parts ? m.an_week_short({ date: `${parts[1]}/${parts[0]}` }) : d.dateKey?.slice(5) };
    }
    return { ...d, label: d.dateKey?.slice(5) };
  }) ?? []);
</script>

<div id="analytics-export-root" class="analytics-page space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20 max-w-7xl mx-auto px-0 sm:px-4 md:px-8">
  <!-- Header -->
  <div class="relative overflow-hidden bg-surface-container-low/30 p-5 md:p-6 rounded-xl border border-outline-variant/10 group">
    <div class="absolute top-0 right-0 -translate-y-1/2 translate-x-1/4 w-64 h-64 bg-primary/5 rounded-full blur-3xl group-hover:bg-primary/10 transition-colors duration-1000"></div>

    <div class="relative flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
      <div class="analytics-page__identity flex min-w-0 items-center gap-4">
        <div class="bg-primary/10 p-2 rounded-xl text-primary">
          <Papicon icon="ChartLineUp" size={20} />
        </div>
        <div class="min-w-0">
          <span class="text-xs font-medium text-primary">{m.an_header_eyebrow()}</span>
          <h2 class="text-lg font-semibold tracking-tight text-on-surface font-headline leading-tight">
            {m.an_header_title_lead()} <span class="text-primary">{m.an_header_title_accent()}</span>
          </h2>
          <p class="text-on-surface-variant/60 text-sm max-w-md">{m.an_header_desc()}</p>
        </div>
      </div>

      <div class="analytics-page__actions flex flex-col items-end gap-3 w-full md:w-auto">
        <div class="flex w-full flex-wrap items-center justify-end gap-2">
          <ExportDropdown
            onExportCSV={exportAllToCSV}
            onExportXLSX={exportAllToXLSX}
            onExportImage={exportAllChartsAsImages}
          />

          <div class="flex flex-col gap-2">
            <div class="analytics-period-presets flex gap-1 bg-surface-container-high/40 p-1.5 rounded-lg border border-outline-variant/10 overflow-x-auto no-scrollbar">
              {#each periodPresets as p}
                <button
                  onclick={() => changePeriod(p.value as any)}
                  class="px-3 py-2 rounded-lg text-xs font-medium transition-all duration-300 whitespace-nowrap { (isCustomPeriod ? p.value === 'custom' : period === p.value) ? 'bg-on-surface text-surface shadow-sm' : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high'}"
                >
                  {p.label}
                </button>
              {/each}
            </div>

            {#if isCustomPeriod}
              <div class="analytics-custom-range flex flex-wrap items-center gap-2 animate-in fade-in zoom-in-95 duration-300">
                <input
                  type="datetime-local"
                  bind:value={startDate}
                  class="bg-surface-container-low border border-outline-variant/10 rounded-lg px-3 py-1.5 text-xs text-on-surface focus:outline-none focus:border-primary transition-colors"
                />
                <span class="text-[10px] font-bold text-on-surface-variant/40">{m.an_range_to()}</span>
                <input
                  type="datetime-local"
                  bind:value={endDate}
                  class="bg-surface-container-low border border-outline-variant/10 rounded-lg px-3 py-1.5 text-xs text-on-surface focus:outline-none focus:border-primary transition-colors"
                />
                <button
                  onclick={applyCustomRange}
                  class="bg-primary text-on-primary px-3 py-1.5 rounded-lg text-xs font-medium hover:brightness-110 transition-all"
                >
                  {m.an_apply()}
                </button>
              </div>
            {/if}
          </div>
        </div>
        {#if data?.totals}
          <div class="flex items-center gap-3 text-xs font-bold text-on-surface-variant/40 bg-surface-container-low/40 px-3 py-1.5 rounded-lg border border-outline-variant/5">
             <div class="flex items-center gap-2">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>{m.an_live_feed()}</span>
             </div>
             <span class="w-px h-3 bg-outline-variant/20"></span>
             <span>{m.an_last_update({ time: new Date().toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Navigation Catégories -->
  <div class="analytics-category-nav sticky flex justify-center">
    <div class="analytics-category-list flex gap-1 bg-surface-container-low/60 p-1.5 rounded-xl border border-outline-variant/10 shadow-sm shadow-surface/20 overflow-x-auto no-scrollbar max-w-full">
      {#each categories as cat}
        <button 
          onclick={() => { const firstTab = tabsByCategory[cat.id]?.[0]?.id || cat.id; gotoTab('/analytics', firstTab, 'overview'); }}
          class="flex items-center gap-2.5 px-6 py-3.5 rounded-xl text-xs font-medium transition-all duration-400 whitespace-nowrap group {activeCategory === cat.id ? 'bg-primary text-on-primary shadow-sm scale-[1.02]' : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high'}"
          title={cat.description}
        >
          <div class="transition-transform group-hover:scale-110 {activeCategory === cat.id ? 'text-on-primary' : 'text-primary'}">
            <Papicon icon={cat.icon} size={16} />
          </div>
          {cat.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Navigation Onglets (sous-catégories) -->
  {#if currentTabs.length > 1}
    <div class="flex justify-center">
      <div class="analytics-subcategory-list flex max-w-full gap-1 overflow-x-auto bg-surface-container p-1.5 rounded-lg border border-outline-variant no-scrollbar">
        {#each currentTabs as tab}
          <button 
            onclick={() => selectTab(tab)}
            disabled={tab.disabled}
            aria-disabled={tab.disabled}
            class="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-medium transition-all duration-300 whitespace-nowrap {tab.disabled ? 'bg-surface-container-high/40 text-on-surface-variant/30 cursor-not-allowed opacity-70' : activeTab === tab.id ? 'bg-primary text-on-primary shadow-lg' : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high'}"
          >
            <div class="transition-transform {tab.disabled ? 'text-on-surface-variant/30' : activeTab === tab.id ? 'text-on-primary' : 'text-primary'}">
              <Papicon icon={tab.icon} size={14} />
            </div>
            {tab.label}
            {#if tab.badge}
              <span class="ml-1 rounded-full border border-current/20 bg-current/10 px-2 py-0.5 text-xs font-medium {tab.disabled ? 'text-on-surface-variant/35' : 'text-current/80'}">
                {tab.badge}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}


  {#if activeTab === 'ghosts'}
    <!-- Audit de présence silencieuse : autonome, charge ses propres données -->
    <GhostMembersPanel onOpenMember={openMemberDetails} />
  {:else if ADVANCED_TABS[activeTab]}
    <!-- Sections avancées : autonomes, elles chargent et cachent leurs propres données -->
    <AdvancedAnalyticsPanel section={ADVANCED_TABS[activeTab]} onOpenMember={openMemberDetails} />
  {:else if loading}
    <AnalyticsSkeleton />
    <div class="flex justify-center mt-4">
      <LoadingHint context="analytics" />
    </div>
  {:else if error}

    <div class="bg-error-container/10 border border-error/20 p-5 rounded-xl text-error text-sm font-bold flex items-center gap-3">
      <Papicon icon="alert-octagon" size={20} />{error}
    </div>
  {:else if data}

    {#if activeTab === 'overview'}
      <StatsOverview {data} {chartLabels} />
    {:else if activeTab === 'messages' || activeTab === 'voice'}
      <EngagementMetrics {data} mode={activeTab} onOpenMember={openMemberDetails} />
    {:else if activeTab === 'interactions'}
      {#if loadingInteractions}
        <div class="w-full h-155 rounded-xl border border-white/5 bg-surface-container-low/50 flex flex-col items-center justify-center gap-4 text-on-surface-variant p-8">
          <div class="relative w-16 h-16 flex items-center justify-center">
            <div class="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary animate-spin"></div>
            <div class="absolute inset-2 rounded-full border-4 border-secondary/10 border-t-secondary animate-spin" style="animation-direction: reverse; animation-duration: 1.5s;"></div>
          </div>
          <div class="flex flex-col items-center text-center mt-2">
            <span class="text-sm font-semibold uppercase tracking-wider text-primary animate-pulse">{m.an_network_loading()}</span>
            <LoadingHint context="network" />
          </div>
        </div>
      {:else if interactionsError}
        <div class="w-full h-155 rounded-xl border border-error/10 bg-error-container/5 flex flex-col items-center justify-center gap-4 text-error p-8 text-center">
          <div class="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center text-error mb-2">
            <Papicon icon="alert-octagon" size={24} />
          </div>
          <span class="text-sm font-semibold uppercase tracking-wider">{m.an_network_error()}</span>
          <span class="text-xs text-on-surface-variant/60 max-w-md">{interactionsError}</span>
          <button 
            onclick={loadInteractions}
            class="mt-2 px-5 py-2.5 bg-error/10 hover:bg-error/20 border border-error/20 hover:border-error/30 rounded-full text-[13px] font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            {m.an_retry()}
          </button>
        </div>
      {:else if interactionsData}
        <GlobalInteractionGraph 
          nodes={interactionsData.nodes || []} 
          edges={interactionsData.edges || []} 
          hiddenMembersCount={interactionsData.hiddenMembersCount || 0} 
          onSelectNode={(userId) => openMemberDetails(userId, m.an_loading_short())}
        />
      {/if}
    {:else if activeTab === 'members'}
      <MembersStats {data} {chartLabels} onOpenMember={openMemberDetails} />
    {:else if activeTab === 'invitations'}
      <InvitationsStats {invitesData} />
    {:else if activeTab === 'moderation'}
      <ModerationAudit {data} {chartLabels} onOpenMember={openMemberDetails} />
    {:else if activeTab === 'staff'}
      <StaffAudit {data} onOpenMember={openMemberDetails} {fmt} {fmtH} />
    {:else if activeTab === 'heatmap' && heatmapData}
      <HourlyHeatmap data={heatmapData} />
    {:else if activeTab === 'weekly' && weeklyData}
      <WeeklyComparison data={weeklyData} />
    {:else if activeTab === 'algo' && algoData}
      <DailyAlgoAnalyticsCard data={algoData} />
    {:else if activeTab === 'commands'}
      {#if data?.commandUsage && data.commandUsage.length > 0}
        <CommandUsage data={data.commandUsage} />
      {:else}
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-10 text-center">
          <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Papicon icon="Code" size={26} />
          </div>
          <h3 class="text-lg font-semibold text-on-surface">{m.an_commands_empty_title()}</h3>
          <p class="mt-2 text-sm text-on-surface-variant/70">
            {m.an_commands_empty_desc()}
          </p>
        </div>
      {/if}
    {:else if activeTab === 'performance' && data?.staffPerformance}
      <StaffPerformance data={data.staffPerformance} onOpenMember={openMemberDetails} />
    {/if}
  {/if}

  <!-- Member Case Modal -->
  <MemberCaseModal
    bind:open={modalOpen}
    userId={selectedUserId}
    userName={selectedUserName}
    {caseData}
    loading={loadingCase}
    error={caseError}
    onClose={() => {
      modalOpen = false;
    }}
    onSelectUser={(userId) => {
      openMemberDetails(userId, m.an_loading_short());
    }}
  />
</div>

<style>
  /* La navbar du dashboard est `fixed` : sans cet offset la barre de catégories
     se colle au bord de la fenêtre et se retrouve masquée derrière, boutons
     compris. Le z-index passe devant la navbar pour les quelques pixels où les
     deux se chevauchent pendant le scroll. */
  .analytics-category-nav {
    top: calc(var(--app-navbar-height) + 0.75rem);
    z-index: calc(var(--app-navbar-z) + 1);
  }

  @media (max-width: 767px) {
    .analytics-page__identity {
      align-items: flex-start;
    }

    .analytics-page__actions {
      align-items: stretch;
    }

    .analytics-custom-range > input {
      min-width: min(100%, 12rem);
      flex: 1 1 12rem;
    }

    .analytics-custom-range > button {
      min-height: 2.75rem;
      flex: 1 1 100%;
    }

    .analytics-category-nav {
      top: calc(var(--mobile-topbar-height) + env(safe-area-inset-top) + 0.5rem);
      margin-right: -0.5rem;
      margin-left: -0.5rem;
    }

    /* A horizontal scroller hides how many categories exist. Wrapping them into
       a grid shows the whole set at once, which matters more than compactness
       when the user is hunting for one report. */
    .analytics-period-presets,
    .analytics-category-list {
      display: grid;
      width: 100%;
      overflow: visible;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .analytics-period-presets > button {
      min-width: 0;
      padding-right: 0.5rem;
      padding-left: 0.5rem;
      white-space: normal;
    }

    .analytics-category-list > button {
      min-width: 0;
      justify-content: center;
      gap: 0.25rem;
      padding: 0.75rem 0.35rem;
      font-size: 0.6875rem;
      white-space: normal;
    }

    .analytics-category-list > button > div {
      display: none;
    }

    .analytics-subcategory-list {
      display: grid;
      width: 100%;
      overflow: visible;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .analytics-subcategory-list > button {
      min-width: 0;
      justify-content: center;
      padding-right: 0.5rem;
      padding-left: 0.5rem;
      white-space: normal;
    }
  }
</style>
