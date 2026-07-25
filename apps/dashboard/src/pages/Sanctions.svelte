<script lang="ts">
  import { m } from '../lib/i18n';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { portal } from '../lib/actions/portal';
  import { authStore } from '../lib/stores/auth.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import ReportRuleSelector from '../lib/components/sanctions/ReportRuleSelector.svelte';
  import SelectedRuleChips from '../lib/components/sanctions/SelectedRuleChips.svelte';
  import ColumnSortFilter, { type ColumnFilterOption } from '../lib/components/sanctions/ColumnSortFilter.svelte';
  import {
    createSanctionReport,
    deleteSanction,
    updateSanctionReport,
    fetchMemberCase,
    runMemberCaseAction,
    updateGlobalSettings,
    fetchFeatureConfigurations,
    updateFeatureConfiguration,
    updateSanctionTables,
    API_BASE_URL
  } from '../lib/api';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import {
    buildBrokenRulesPayload,
    buildReportRuleOptions,
    getRuleIdsFromBrokenRules,
    getRulesFromBrokenRules,
  } from '../lib/sanctions/reportRules';
  import EvidenceInputList from '../lib/components/sanctions/EvidenceInputList.svelte';
  import { normalizeEvidenceLinks, sanitizeEvidenceLinks } from '../lib/sanctions/evidenceLinks';
  import { durationLabel, statusLabel, toDateTimeLocal, typeLabel } from '../lib/sanctions/formatters';
  import { filterAndSortSanctions, type SanctionFilters, type SortField, type SortOption, type Sanction } from '../lib/sanctions/filterSort';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { downloadSingleSheetXlsx } from '../lib/xlsxExport';

  const sanctionTabs = ['sanctions', 'settings'] as const;
  let activeTab = $state('sanctions');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/sanctions', sanctionTabs, 'sanctions');
  });

  const saveAction = createAsyncActionState();

  // Config partagée avec le module Appels de bannissement (BanAppealConfig.notifyOnBanDM) :
  // même valeur, éditable depuis les deux écrans.
  let banAppealNotifyOnBanDM = $state(false);
  let banAppealNotifySaving = $state(false);

  async function loadBanAppealNotifyConfig() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/appeals/config`, {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        banAppealNotifyOnBanDM = data.config?.notifyOnBanDM ?? false;
      }
    } catch { /* ignore */ }
  }

  async function toggleBanAppealNotify(value: boolean) {
    const previous = banAppealNotifyOnBanDM;
    banAppealNotifyOnBanDM = value;
    banAppealNotifySaving = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/appeals/config`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifyOnBanDM: value }),
      });
      if (!res.ok) throw new Error();
    } catch {
      banAppealNotifyOnBanDM = previous;
      toast.error(m.sc_update_error());
    } finally {
      banAppealNotifySaving = false;
    }
  }

  let selectedTableIndex = $state(0);
  let newTableName = $state('');
  let showAddTableField = $state(false);

  function addSanctionTable() {
    const name = newTableName.trim();
    if (!name) return;
    if (guildSettings.sanctionTables.some((t: any) => t.name.toLowerCase() === name.toLowerCase())) {
      toast.error(m.sc_scale_exists());
      return;
    }

    guildSettings.sanctionTables.push({
      id: '',
      name,
      tiers: [
        {
          id: '',
          level: 1,
          action: 'WARN',
          durationSeconds: null,
          customReason: m.sc_auto_warn_reason({ name })
        }
      ]
    });
    newTableName = '';
    showAddTableField = false;
    selectedTableIndex = guildSettings.sanctionTables.length - 1;
  }

  async function deleteSanctionTable(index: number) {
    if (!(await confirmDialog.danger(m.sc_delete_table_q(), m.sc_delete_table_warn()))) {
      return;
    }
    guildSettings.sanctionTables.splice(index, 1);
    if (selectedTableIndex >= guildSettings.sanctionTables.length) {
      selectedTableIndex = Math.max(0, guildSettings.sanctionTables.length - 1);
    }
  }

  function addTier(tableIndex: number) {
    const table = guildSettings.sanctionTables[tableIndex];
    if (!table) return;
    const nextLevel = table.tiers.length + 1;
    
    let defaultAction = 'WARN';
    let defaultDuration = null;
    if (table.tiers.length > 0) {
      const prevTier = table.tiers[table.tiers.length - 1];
      defaultAction = prevTier.action === 'WARN' ? 'TIMEOUT' : prevTier.action === 'TIMEOUT' ? 'KICK' : 'BAN';
      defaultDuration = defaultAction === 'TIMEOUT' ? 3600 : null;
    }

    table.tiers.push({
      id: '',
      level: nextLevel,
      action: defaultAction,
      durationSeconds: defaultDuration,
      customReason: m.sc_repeat_reason({ name: table.name, level: nextLevel })
    });
  }

  function removeTier(tableIndex: number, tierIndex: number) {
    const table = guildSettings.sanctionTables[tableIndex];
    if (!table) return;
    table.tiers.splice(tierIndex, 1);
    table.tiers.forEach((tier: any, i: number) => {
      tier.level = i + 1;
    });
  }

  function getDurationValue(seconds: number | null): number {
    if (!seconds) return 1;
    if (seconds % 86400 === 0) return seconds / 86400;
    if (seconds % 3600 === 0) return seconds / 3600;
    if (seconds % 60 === 0) return seconds / 60;
    return seconds;
  }

  function getDurationUnit(seconds: number | null): 'm' | 'h' | 'd' {
    if (!seconds) return 'h';
    if (seconds % 86400 === 0) return 'd';
    if (seconds % 3600 === 0) return 'h';
    return 'm';
  }

  function updateTierDuration(tableIndex: number, tierIndex: number, value: number, unit: 'm' | 'h' | 'd') {
    const table = guildSettings.sanctionTables[tableIndex];
    const tier = table?.tiers[tierIndex];
    if (!tier) return;

    let multiplier = 60;
    if (unit === 'h') multiplier = 3600;
    if (unit === 'd') multiplier = 86400;

    tier.durationSeconds = value * multiplier;
  }

  function exportTableToImage(table: any) {
    if (!table) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 600;
    const headerHeight = 140;
    const tierHeight = 110;
    const footerHeight = 60;
    const height = headerHeight + (table.tiers.length * tierHeight) + footerHeight;

    const scale = window.devicePixelRatio || 2;
    canvas.width = width * scale;
    canvas.height = height * scale;
    ctx.scale(scale, scale);

    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#0a192f');
    bgGrad.addColorStop(0.5, '#020c1b');
    bgGrad.addColorStop(1, '#001a33');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    const glow1 = ctx.createRadialGradient(100, 100, 50, 200, 200, 500);
    glow1.addColorStop(0, 'rgba(79, 70, 229, 0.25)');
    glow1.addColorStop(1, 'rgba(79, 70, 229, 0)');
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, width, height);

    const glow2 = ctx.createRadialGradient(width - 100, height - 100, 50, width - 200, height - 200, 400);
    glow2.addColorStop(0, 'rgba(0, 229, 255, 0.2)');
    glow2.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, width, height);

    ctx.font = 'bold 32px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(table.name, 40, 65);

    ctx.font = '900 10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#00E5FF';
    ctx.fillText(m.sc_canvas_title(), 40, 95);
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 115);
    ctx.lineTo(width - 40, 115);
    ctx.stroke();

    let y = 140;
    table.tiers.forEach((tier: any, index: number) => {
      const cardX = 40;
      const cardY = y;
      const cardW = width - 80;
      const cardH = 80;
      const radius = 16;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, radius);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const badgeX = cardX + 20;
      const badgeY = cardY + 20;
      const badgeW = 40;
      const badgeH = 40;
      const badgeRadius = 10;

      let badgeColor = 'rgba(79, 70, 229, 0.2)';
      let badgeTextColor = '#818cf8';
      let badgeStroke = 'rgba(79, 70, 229, 0.4)';

      if (tier.action === 'WARN') {
        badgeColor = 'rgba(245, 158, 11, 0.1)';
        badgeTextColor = '#fbbf24';
        badgeStroke = 'rgba(245, 158, 11, 0.3)';
      } else if (tier.action === 'TIMEOUT') {
        badgeColor = 'rgba(59, 130, 246, 0.1)';
        badgeTextColor = '#60a5fa';
        badgeStroke = 'rgba(59, 130, 246, 0.3)';
      } else if (['KICK', 'BAN', 'TEMP_BAN', 'SOFTBAN'].includes(tier.action)) {
        badgeColor = 'rgba(239, 68, 68, 0.1)';
        badgeTextColor = '#f87171';
        badgeStroke = 'rgba(239, 68, 68, 0.3)';
      }

      ctx.fillStyle = badgeColor;
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeRadius);
      ctx.fill();
      ctx.strokeStyle = badgeStroke;
      ctx.stroke();

      ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = badgeTextColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`T${tier.level}`, badgeX + badgeW / 2, badgeY + badgeH / 2);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      
      let actionLabel = tier.action;
      if (tier.action === 'WARN') actionLabel = m.sc_action_warn();
      else if (tier.action === 'TIMEOUT') actionLabel = `TIMEOUT (${formatSeconds(tier.durationSeconds)})`;
      else if (tier.action === 'TEMP_BAN') actionLabel = m.sc_action_temp_ban({ d: formatSeconds(tier.durationSeconds) });
      else if (tier.action === 'KICK') actionLabel = m.sc_action_kick();
      else if (tier.action === 'BAN') actionLabel = m.sc_action_ban();
      else if (tier.action === 'SOFTBAN') actionLabel = 'SOFTBAN';

      ctx.fillText(actionLabel, cardX + 80, cardY + 20);

      ctx.font = '13px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      const reason = tier.customReason || m.sc_default_reason();
      ctx.fillText(reason, cardX + 80, cardY + 45);

      if (index < table.tiers.length - 1) {
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(width / 2, cardY + cardH);
        ctx.lineTo(width / 2, cardY + cardH + 30);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(0, 229, 255, 0.6)';
        ctx.beginPath();
        ctx.moveTo(width / 2 - 5, cardY + cardH + 25);
        ctx.lineTo(width / 2 + 5, cardY + cardH + 25);
        ctx.lineTo(width / 2, cardY + cardH + 30);
        ctx.fill();
      }

      y += tierHeight;
    });

    ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.textAlign = 'center';
    ctx.fillText(m.sc_canvas_footer(), width / 2, height - 35);

    const link = document.createElement('a');
    link.download = `kotbo_tableau_${table.name.toLowerCase()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  function formatSeconds(secs: number | null): string {
    if (!secs) return 'N/A';
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return m.home_short_days({ n: days });
  }

  async function exportTableToXlsx(table: any) {
    if (!table) return;
    const data = table.tiers.map((tier: any) => ({
      [m.sc_xlsx_table()]: table.name,
      [m.sc_xlsx_tier()]: `T${tier.level}`,
      "Action": tier.action,
      [m.sc_xlsx_duration()]: tier.durationSeconds || 'N/A',
      [m.sc_xlsx_custom_reason()]: tier.customReason || ''
    }));
    await downloadSingleSheetXlsx(
      `kotbo_tableau_${table.name.toLowerCase()}.xlsx`,
      `${m.sc_xlsx_table()} ${table.name}`,
      data,
    );
  }

  function exportTableToCsv(table: any) {
    if (!table) return;
    const headers = ["Tableau", "Niveau", "Action", "Duree_Secondes", "Raison"];
    const rows = [headers.join(",")];
    for (const tier of table.tiers) {
      const row = [
        `"${table.name.replace(/"/g, '""')}"`,
        `"T${tier.level}"`,
        `"${tier.action}"`,
        `"${tier.durationSeconds || ''}"`,
        `"${(tier.customReason || '').replace(/"/g, '""')}"`
      ];
      rows.push(row.join(","));
    }
    const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `kotbo_tableau_${table.name.toLowerCase()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function exportTableToJson(table: any) {
    if (!table) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(table, null, 2));
    const link = document.createElement("a");
    link.href = dataStr;
    link.download = `kotbo_tableau_${table.name.toLowerCase()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  let creatingReport = $state(false);
  let reportMessage = $state('');
  let reportMessageIsError = $state(false);
  let deletingSanctionId = $state<string | null>(null);
  let deletionMessage = $state('');
  let deletionMessageIsError = $state(false);
  let deleteModalOpen = $state(false);
  let pendingDeletion = $state<{ id: string; type: string; targetTag: string } | null>(null);
  let deleteConfirmationText = $state('');

  let modalOpen = $state(false);
  let modalMode = $state<'create' | 'view'>('create');
  let searchQuery = $state('');

  // Filter and sort state
  let filters = $state<SanctionFilters>({
    statuses: [],
    types: [],
    moderators: [],
    targets: [],
  });

  let sortOptions = $state<SortOption[]>([
    { field: 'date', direction: 'desc' },
  ]);

  let selectedSanctionId = $state('');
  let incidentAt = $state(new Date().toISOString().slice(0, 16));
  let sanctionDurationLabel = $state('');
  let brokenRules = $state('');
  let selectedRuleIds = $state<string[]>([]);
  let detailedReason = $state('');
  let evidenceLinks = $state<string[]>(['']);
  let additionalNotes = $state('');

  let isEditing = $state(false);
  let updateReportBusy = $state(false);

  // Member Case Modal State
  let caseModalOpen = $state(false);
  let selectedCaseUser = $state<{ name: string; id: string | null } | null>(null);
  let selectedCaseData = $state<any>(null);
  let selectedCaseLoading = $state(false);
  let selectedCaseError = $state('');
  let memberActionReason = $state(m.sc_member_action_reason());
  let memberActionDuration = $state('30m');
  let memberActionBusy = $state(false);
  let memberActionFeedback = $state('');
  let memberActionIsError = $state(false);

  async function loadMemberCase(userId: string) {
    selectedCaseLoading = true;
    selectedCaseError = '';
    try {
      selectedCaseData = await fetchMemberCase(userId);
    } catch (error) {
      selectedCaseError = error instanceof Error ? error.message : m.sc_member_load_error();
      selectedCaseData = null;
    } finally {
      selectedCaseLoading = false;
    }
  }

  function openCaseModal(userId: string, userName: string) {
    selectedCaseUser = { name: userName, id: userId };
    selectedCaseData = null;
    selectedCaseError = '';
    memberActionReason = m.sc_member_action_reason();
    memberActionDuration = '30m';
    memberActionFeedback = '';
    memberActionIsError = false;
    caseModalOpen = true;

    if (userId) {
      void loadMemberCase(userId);
    }
  }

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.settings?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  let guildSettings = $state({
    moderatorRoleId: '',
    propagateSanctions: false,
    sanctionReportEnabled: true,
    sanctionTables: [] as any[]
  });

  let savedSettings = $state({
    moderatorRoleId: '',
    propagateSanctions: false,
    sanctionReportEnabled: true,
    sanctionTables: [] as any[]
  });

  onMount(async () => {
    loadingConfig = true;
    try {
      const configs = await fetchFeatureConfigurations();
      featureConfig = configs?.features?.find((c: any) => c.featureKey === 'sanctions') || null;
    } catch (err) {
      console.error('Error fetching sanctions config:', err);
    } finally {
      loadingConfig = false;
    }
    await loadBanAppealNotifyConfig();
  });

  $effect(() => {
    if (dashboardStore.state.moderatorRoleId !== undefined) {
      const loaded = {
        moderatorRoleId: dashboardStore.state.moderatorRoleId || '',
        propagateSanctions: (dashboardStore.state as any).propagateSanctions || false,
        sanctionReportEnabled: (dashboardStore.state as any).sanctionReportEnabled ?? true,
        sanctionTables: JSON.parse(JSON.stringify(dashboardStore.state.sanctionTables || []))
      };
      guildSettings = { ...loaded };
      savedSettings = JSON.parse(JSON.stringify(loaded));
    }
  });

  $effect(() => {
    const dirty = JSON.stringify(guildSettings) !== JSON.stringify(savedSettings);
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          label: 'Sanctions (Configuration)',
          onSave: () => handleSaveSettings(),
          onReset: () => {
            guildSettings = JSON.parse(JSON.stringify(savedSettings));
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        if (unsavedChanges.isDirty && unsavedChanges.pageLabel === 'Sanctions (Configuration)') {
          unsavedChanges.clear();
        }
      });
    }
  });

  onDestroy(() => {
    if (unsavedChanges.pageLabel === 'Sanctions (Configuration)') {
      unsavedChanges.clear();
    }
  });

  let featureConfig = $state<any>(null);
  let loadingConfig = $state(false);

  async function toggleConfig(key: string, value: boolean) {
    if (!featureConfig) return;
    
    await saveAction.run(async () => {
      const ok = await updateFeatureConfiguration('sanctions', { [key]: value });
      if (!ok) throw new Error(m.sc_api_error());
      featureConfig[key] = value;
      return true;
    }, { successMessage: m.sc_config_updated() });
  }

  async function handleSaveSettings(): Promise<boolean> {
    let success = false;
    await saveAction.run(async () => {
      const ok1 = await updateGlobalSettings({
        moderatorRoleId: guildSettings.moderatorRoleId,
        propagateSanctions: guildSettings.propagateSanctions,
        sanctionReportEnabled: guildSettings.sanctionReportEnabled
      });
      if (!ok1) throw new Error(m.sc_api_error_general());

      const ok2 = await updateSanctionTables(guildSettings.sanctionTables);
      if (!ok2) throw new Error(m.sc_api_error_tables());

      await dashboardStore.refresh();
      savedSettings = JSON.parse(JSON.stringify(guildSettings));
      success = true;
      return true;
    }, { successMessage: m.sc_settings_saved() });
    return success;
  }

  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  function closeCaseModal() {
    caseModalOpen = false;
    selectedCaseUser = null;
    selectedCaseData = null;
    selectedCaseError = '';
  }

  async function executeMemberAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!selectedCaseUser?.id) return;

    memberActionBusy = true;
    memberActionFeedback = '';
    memberActionIsError = false;

    try {
      // Note: simple duration parsing can be improved, but matches existing patterns
      const durationMs = action === 'TIMEOUT' ? 30 * 60 * 1000 : null; // 30m default for simplicity here
      
      await runMemberCaseAction(selectedCaseUser.id, action, { 
        reason: memberActionReason.trim() || m.sc_action_from_sanctions(),
        durationMs: durationMs ?? undefined 
      });
      memberActionFeedback = m.sc_action_applied();
      await loadMemberCase(selectedCaseUser.id);
    } catch (error) {
      memberActionIsError = true;
      memberActionFeedback = error instanceof Error ? error.message : m.sc_action_failed();
    } finally {
      memberActionBusy = false;
    }
  }

  function toggleRuleSelection(ruleId: string, checked: boolean) {
    if (checked) {
      selectedRuleIds = [...new Set([...selectedRuleIds, ruleId])];
      return;
    }
    selectedRuleIds = selectedRuleIds.filter((entry) => entry !== ruleId);
  }

  // Filter and sort helper functions
  function toggleFilter(filterType: keyof SanctionFilters, value: string) {
    const filterList = filters[filterType];
    if (filterList.includes(value)) {
      filters[filterType] = filterList.filter((v) => v !== value);
    } else {
      filters[filterType] = [...filterList, value];
    }
  }

  function toggleSort(field: SortField) {
    const existingIndex = sortOptions.findIndex((opt) => opt.field === field);

    if (existingIndex >= 0) {
      // Toggle direction if already sorting by this field
      const option = sortOptions[existingIndex];
      const newDirection = option.direction === 'asc' ? 'desc' : 'asc';
      sortOptions[existingIndex] = { field: option.field, direction: newDirection };
    } else {
      // Add new sort if not already sorting
      sortOptions = [...sortOptions, { field, direction: 'asc' }];
    }
  }

  function sortDirectionFor(field: SortField) {
    return sortOptions.find((entry) => entry.field === field)?.direction ?? null;
  }

  function resetFiltersAndSort() {
    filters = {
      statuses: [],
      types: [],
      moderators: [],
      targets: [],
    };
    sortOptions = [{ field: 'date', direction: 'desc' }];
  }


  const regulationRules = $derived(dashboardStore.state.regulationRules || []);
  const reportRuleOptions = $derived(buildReportRuleOptions(regulationRules));
  const sanctions = $derived((dashboardStore.state.sanctions || []) as Sanction[]);
  const sanctionReports = $derived((dashboardStore.state.sanctionReports || []) as any[]);
  const showSanctionsSkeleton = $derived(dashboardStore.state.loading && sanctions.length === 0);

  // Get unique values for filter options
  const uniqueStatuses = $derived([...new Set(sanctions.map((s) => s.status))].sort());
  const uniqueTypes = $derived([...new Set(sanctions.map((s) => s.type))].sort());
  const uniqueModerators = $derived(
    [...new Set(sanctions.map((s) => s.moderatorUserId))].sort((a, b) => {
      const tagA = sanctions.find((s) => s.moderatorUserId === a)?.moderatorTag || a;
      const tagB = sanctions.find((s) => s.moderatorUserId === b)?.moderatorTag || b;
      return tagA.localeCompare(tagB);
    })
  );
  const uniqueTargets = $derived(
    [...new Set(sanctions.map((s) => s.targetUserId))].sort((a, b) => {
      const tagA = sanctions.find((s) => s.targetUserId === a)?.targetTag || a;
      const tagB = sanctions.find((s) => s.targetUserId === b)?.targetTag || b;
      return tagA.localeCompare(tagB);
    })
  );

  const hasActiveFiltersOrSort = $derived(
    searchQuery.trim().length > 0 ||
    filters.statuses.length > 0 ||
      filters.types.length > 0 ||
      filters.moderators.length > 0 ||
      filters.targets.length > 0 ||
      sortOptions.length > 1 ||
      (sortOptions.length === 1 && (sortOptions[0].field !== 'date' || sortOptions[0].direction !== 'desc'))
  );

  const statusFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueStatuses.map((status) => ({ value: status, label: statusLabel(status) }))
  );
  const typeFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueTypes.map((type) => ({ value: type, label: typeLabel(type) }))
  );
  const moderatorFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueModerators.map((moderatorId) => ({
      value: moderatorId,
      label: sanctions.find((entry) => entry.moderatorUserId === moderatorId)?.moderatorTag || moderatorId,
    }))
  );
  const targetFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueTargets.map((targetId) => ({
      value: targetId,
      label: sanctions.find((entry) => entry.targetUserId === targetId)?.targetTag || targetId,
    }))
  );

  const searchedSanctions = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sanctions;

    return sanctions.filter((entry) => {
      return [
        entry.type,
        entry.targetTag,
        entry.moderatorTag,
        entry.reason,
        statusLabel(entry.status),
      ]
        .map((value) => (value || '').toLowerCase())
        .some((value) => value.includes(query));
    });
  });

  // Apply filters and sorting
  const filteredAndSortedSanctions = $derived(filterAndSortSanctions(searchedSanctions, filters, sortOptions));

  const selectedSanction = $derived(sanctions.find((entry) => entry.id === selectedSanctionId) || null);
  const selectedReport = $derived(sanctionReports.find((entry) => entry.sanctionId === selectedSanctionId) || null);
  const selectedReportRuleIds = $derived(selectedReport ? getRuleIdsFromBrokenRules(selectedReport.brokenRules) : []);
  const selectedReportRules = $derived(selectedReport ? getRulesFromBrokenRules(selectedReport.brokenRules, reportRuleOptions) : []);
  const selectedDraftRules = $derived(
    selectedRuleIds
      .map((ruleId) => reportRuleOptions.find((rule) => rule.id === ruleId))
      .filter((rule): rule is (typeof reportRuleOptions)[number] => Boolean(rule))
  );
  const canDeleteSanctions = $derived(dashboardStore.state.access?.level === 'admin');
  const canCreateSelectedReport = $derived(
    Boolean(selectedSanction && !selectedReport && selectedSanction.moderatorUserId === authStore.user?.id && reportRuleOptions.length > 0)
  );
  const canEditSelectedReport = $derived(
    Boolean(selectedReport && (selectedReport.createdByUserId === authStore.user?.id || authStore.isAdmin))
  );

  type SanctionListItem = {
    id: string;
    moderatorUserId: string;
  };

  type SanctionReportListItem = {
    sanctionId: string | null;
  };

  type ReportActionState = {
    label: string;
    icon: string;
    disabled: boolean;
    variant: 'primary' | 'success' | 'muted' | 'warning';
    hint: string;
  };

  function getReportActionState(entry: SanctionListItem, linkedReport: SanctionReportListItem | any): ReportActionState {
    const canCreate = entry.moderatorUserId === authStore.user?.id;

    if (linkedReport) {
      const isMissingProof = !linkedReport.evidenceLinks || linkedReport.evidenceLinks.length === 0;
      if (isMissingProof) {
        return {
          label: m.sc_add_proof(),
          icon: 'alert-triangle',
          disabled: false,
          variant: 'warning',
          hint: m.sc_add_proof_hint(),
        };
      }
      return {
        label: m.sc_view_report(),
        icon: 'paper',
        disabled: false,
        variant: 'success',
        hint: m.sc_view_report_hint(),
      };
    }

    if (canCreate) {
      return {
        label: m.sc_create_report(),
        icon: 'plus',
        disabled: false,
        variant: 'primary',
        hint: m.sc_create_report_hint(),
      };
    }

    return {
      label: m.sc_report_reserved(),
      icon: 'lock',
      disabled: true,
      variant: 'muted',
      hint: m.sc_report_reserved_hint(),
    };
  }


  function prepareDraftFromSanction(sanction: { id: string; createdAt: string; reason: string; durationSeconds: number | null }) {
    selectedSanctionId = sanction.id;
    incidentAt = toDateTimeLocal(sanction.createdAt);
    sanctionDurationLabel = durationLabel(sanction.durationSeconds);
    brokenRules = '';
    selectedRuleIds = [];
    detailedReason = sanction.reason;
    evidenceLinks = [''];
    additionalNotes = sanction.reason ? m.sc_initial_reason({ reason: sanction.reason }) : '';
    reportMessage = '';
    reportMessageIsError = false;
    isEditing = false;
  }

  function startEditing() {
    if (!selectedReport) return;
    
    incidentAt = toDateTimeLocal(selectedReport.incidentAt);
    sanctionDurationLabel = selectedReport.sanctionDurationLabel || '';
    selectedRuleIds = getRuleIdsFromBrokenRules(selectedReport.brokenRules);
    detailedReason = selectedReport.detailedReason;
    evidenceLinks = normalizeEvidenceLinks(selectedReport.evidenceLinks, true);
    additionalNotes = selectedReport.additionalNotes || '';
    isEditing = true;
  }

  function openReportModal(sanction: any) {
    prepareDraftFromSanction(sanction);
    const linkedReport = sanctionReports.find((entry) => entry.sanctionId === sanction.id);
    modalOpen = true;
    if (linkedReport) {
      const isMissingProof = !linkedReport.evidenceLinks || linkedReport.evidenceLinks.length === 0;
      if (isMissingProof && (sanction.moderatorUserId === authStore.user?.id || canManageSettings)) {
        modalMode = 'view';
        startEditing();
      } else {
        modalMode = 'view';
      }
    } else {
      modalMode = 'create';
    }
  }

  function closeModal() {
    modalOpen = false;
    isEditing = false;
    reportMessage = '';
    reportMessageIsError = false;
  }

  async function submitReport() {
    reportMessage = '';
    reportMessageIsError = false;

    if (!selectedSanction) {
      reportMessage = m.sc_select_sanction_first();
      reportMessageIsError = true;
      return;
    }

    if (selectedReport) {
      reportMessage = m.sc_report_exists();
      reportMessageIsError = true;
      return;
    }

    if (reportRuleOptions.length === 0) {
      reportMessage = m.sc_no_rules_configured();
      reportMessageIsError = true;
      return;
    }

    if (selectedRuleIds.length === 0) {
      reportMessage = m.sc_select_rule();
      reportMessageIsError = true;
      return;
    }

    if (selectedSanction.moderatorUserId !== authStore.user?.id) {
      reportMessage = m.sc_report_reserved_hint();
      reportMessageIsError = true;
      return;
    }

    if (!sanctionDurationLabel.trim()) {
      reportMessage = m.sc_enter_duration();
      reportMessageIsError = true;
      return;
    }

    const sanitizedLinks = sanitizeEvidenceLinks(evidenceLinks);
    if (sanitizedLinks.length === 0) {
      reportMessage = m.sc_add_proof_link();
      reportMessageIsError = true;
      return;
    }

    brokenRules = buildBrokenRulesPayload(selectedRuleIds, reportRuleOptions, selectedReportRules);

    if (!brokenRules.trim() || !detailedReason.trim()) {
      reportMessage = m.sc_fill_required();
      reportMessageIsError = true;
      return;
    }

    creatingReport = true;
    try {
      const ok = await createSanctionReport({
        sanctionId: selectedSanction.id,
        incidentAt: new Date(incidentAt).toISOString(),
        sanctionDurationLabel: sanctionDurationLabel.trim(),
        brokenRules: brokenRules.trim(),
        detailedReason: detailedReason.trim(),
        evidenceLinks: sanitizedLinks,
        additionalNotes: additionalNotes || null,
      });

      if (!ok) {
        reportMessage = m.sc_create_report_error();
        reportMessageIsError = true;
        return;
      }

      await dashboardStore.refresh();
      modalMode = 'view';
      reportMessage = '';
      reportMessageIsError = false;
    } finally {
      creatingReport = false;
    }
  }

  async function handleUpdateReport() {
    if (!selectedReport) return;
    
    const sanitizedLinks = sanitizeEvidenceLinks(evidenceLinks);
    if (sanitizedLinks.length === 0) {
      reportMessage = m.sc_add_proof_link();
      reportMessageIsError = true;
      return;
    }

    if (selectedRuleIds.length === 0) {
      reportMessage = m.sc_select_rule();
      reportMessageIsError = true;
      return;
    }

    updateReportBusy = true;
    reportMessage = '';
    reportMessageIsError = false;

    try {
      const ok = await updateSanctionReport(selectedReport.id, {
        incidentAt: new Date(incidentAt).toISOString(),
        sanctionDurationLabel: sanctionDurationLabel.trim(),
        brokenRules: buildBrokenRulesPayload(selectedRuleIds, reportRuleOptions, selectedReportRules),
        detailedReason: detailedReason.trim(),
        evidenceLinks: sanitizedLinks,
        additionalNotes: additionalNotes || null,
      });

      if (!ok) {
        reportMessage = m.sc_update_report_error();
        reportMessageIsError = true;
        return;
      }

      await dashboardStore.refresh();
      isEditing = false;
      reportMessage = m.sc_report_updated();
      reportMessageIsError = false;
    } catch (e) {
      reportMessage = m.sc_update_error_generic();
      reportMessageIsError = true;
    } finally {
      updateReportBusy = false;
    }
  }

  function openDeleteModal(entry: { id: string; type: string; targetTag: string }) {
    deletionMessage = '';
    deletionMessageIsError = false;

    if (!canDeleteSanctions) {
      deletionMessage = m.sc_only_admins_delete();
      deletionMessageIsError = true;
      return;
    }

    pendingDeletion = entry;
    deleteConfirmationText = '';
    deleteModalOpen = true;
  }

  function closeDeleteModal() {
    deleteModalOpen = false;
    pendingDeletion = null;
    deleteConfirmationText = '';
  }

  async function confirmDeleteSanction() {
    if (!pendingDeletion) return;

    if (deleteConfirmationText.trim().toUpperCase() !== m.sc_delete_keyword()) {
      deletionMessage = 'Suppression annulee: validation finale non confirmee.';
      deletionMessageIsError = true;
      return;
    }

    const sanctionToDelete = pendingDeletion;
    deletingSanctionId = sanctionToDelete.id;
    closeDeleteModal();
    try {
      const ok = await deleteSanction(sanctionToDelete.id);
      if (!ok) {
        deletionMessage = m.sc_delete_infraction_error();
        deletionMessageIsError = true;
        return;
      }

      if (selectedSanctionId === sanctionToDelete.id) {
        closeModal();
      }

      await dashboardStore.refresh();
      deletionMessage = m.sc_infraction_deleted();
      deletionMessageIsError = false;
    } finally {
      deletingSanctionId = null;
    }
  }
</script>

<ModulePage 
  title="Sanctions & Rapports" 
  description={m.sc_page_desc()} 
  icon="alert-triangle"
  featureKey="sanctions"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <RefreshButton
        onClick={() => dashboardStore.refresh()}
        loading={dashboardStore.state.loading}
        label={m.common_refresh()}
        className="px-5 py-2.5 font-bold "
        iconClass="text-lg"
      />
    </div>
  {/snippet}

  <div class="space-y-8">
    <div class="tab-group w-fit">
      <button
        onclick={() => gotoTab('/sanctions', 'sanctions', 'sanctions')}
        class="tab-button {activeTab === 'sanctions' ? 'active' : ''}"
      >
        {m.sc_tab_history()}
      </button>
      {#if canManageSettings}
        <button
          onclick={() => gotoTab('/sanctions', 'settings', 'sanctions')}
          class="tab-button {activeTab === 'settings' ? 'active' : ''}"
        >
          Configuration
        </button>
      {/if}
    </div>

    {#if activeTab === 'sanctions'}
      <section class="section-card-flush font-inter">
        <div class="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 class="text-lg font-semibold">{m.sc_sanctions_list()}</h3>
          <div class="flex items-center gap-3">
            <span class="text-xs font-bold text-on-surface-variant">{m.sc_entries_count({ a: filteredAndSortedSanctions.length, b: sanctions.length })}</span>
            {#if hasActiveFiltersOrSort}
              <button
                onclick={resetFiltersAndSort}
                class="text-xs font-bold text-primary hover:text-primary/80 transition"
              >
                {m.sc_reset_filters()}
              </button>
            {/if}
          </div>
        </div>
        <div class="px-6 pb-4">
          <label class="relative block w-full top-1.5 md:max-w-xl">
            <Papicon icon="search" size={18} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <FormInput
              type="search"
              bind:value={searchQuery}
              placeholder={m.sc_search_ph()}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-4 py-2.5 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-primary/10 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
        </div>
        {#if deletionMessage}
          <div class="px-6 pt-4 text-sm font-semibold {deletionMessageIsError ? 'text-red-600' : 'text-emerald-600'}">{deletionMessage}</div>
        {/if}
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
        <tr class="bg-slate-50 dark:bg-white/5">
          <th class="px-4 py-4">
            <ColumnSortFilter
              label="Date"
              sortField="date"
              sortDirection={sortDirectionFor('date')}
              onToggleSort={() => toggleSort('date')}
            />
          </th>
          <th class="px-4 py-4">
            <ColumnSortFilter
              label="Type"
              sortField="type"
              sortDirection={sortDirectionFor('type')}
              onToggleSort={() => toggleSort('type')}
              options={typeFilterOptions}
              selectedValues={filters.types}
              onToggleValue={(value) => toggleFilter('types', value)}
            />
          </th>
          <th class="px-4 py-4">
            <ColumnSortFilter
              label={m.sc_col_target()}
              sortField="target"
              sortDirection={sortDirectionFor('target')}
              onToggleSort={() => toggleSort('target')}
              options={targetFilterOptions}
              selectedValues={filters.targets}
              onToggleValue={(value) => toggleFilter('targets', value)}
              searchable={true}
            />
          </th>
          <th class="px-4 py-4">
            <ColumnSortFilter
              label="Staff"
              sortField="moderator"
              sortDirection={sortDirectionFor('moderator')}
              onToggleSort={() => toggleSort('moderator')}
              options={moderatorFilterOptions}
              selectedValues={filters.moderators}
              onToggleValue={(value) => toggleFilter('moderators', value)}
              searchable={true}
            />
          </th>
          <th class="px-4 py-4">
            <ColumnSortFilter
              label={m.sc_col_duration()}
              sortField="duration"
              sortDirection={sortDirectionFor('duration')}
              onToggleSort={() => toggleSort('duration')}
            />
          </th>
          <th class="px-4 py-4">
            <ColumnSortFilter
              label={m.sc_col_status()}
              sortField="status"
              sortDirection={sortDirectionFor('status')}
              onToggleSort={() => toggleSort('status')}
              options={statusFilterOptions}
              selectedValues={filters.statuses}
              onToggleValue={(value) => toggleFilter('statuses', value)}
            />
          </th>
          <th class="px-4 py-4 text-[13px] font-bold text-on-surface-variant">Rapport</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-50 dark:divide-slate-800">
        {#if showSanctionsSkeleton}
          {#each Array(6) as _, index (index)}
            <tr class="animate-pulse">
              <td class="px-4 py-4"><div class="h-3.5 w-32 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
              <td class="px-4 py-4"><div class="h-3.5 w-28 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
              <td class="px-4 py-4"><div class="h-3.5 w-24 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
              <td class="px-4 py-4"><div class="h-3.5 w-24 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
              <td class="px-4 py-4"><div class="h-3.5 w-16 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
              <td class="px-4 py-4"><div class="h-5 w-20 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
              <td class="px-4 py-4"><div class="h-8 w-36 rounded-full bg-slate-200 dark:bg-slate-700"></div></td>
            </tr>
          {/each}
        {:else}
          {#each filteredAndSortedSanctions as entry}
            {@const linkedReport = sanctionReports.find((report) => report.sanctionId === entry.id)}
            {@const reportAction = getReportActionState(entry, linkedReport)}
            <tr class="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
              <td class="px-4 py-4 text-xs font-medium">{new Date(entry.createdAt).toLocaleString('fr-FR')}</td>
              <td class="px-4 py-4 text-xs font-bold text-primary">{typeLabel(entry.type)}</td>
              <td class="px-4 py-4 text-xs">
                <button 
                  onclick={() => openCaseModal(entry.targetUserId, entry.targetTag)}
                  class="hover:text-primary transition-colors font-bold text-left"
                >
                  @{entry.targetTag}
                </button>
              </td>
              <td class="px-4 py-4 text-xs">
                <button 
                  onclick={() => openCaseModal(entry.moderatorUserId, entry.moderatorTag)}
                  class="hover:text-primary transition-colors font-bold text-left"
                >
                  @{entry.moderatorTag}
                </button>
              </td>
              <td class="px-4 py-4 text-xs">{durationLabel(entry.durationSeconds)}</td>
              <td class="px-4 py-4 text-xs">
                <span class="inline-flex items-center rounded-full px-3 py-1 text-[10px] font-bold {entry.status === 'ACTIVE' ? 'bg-amber-100 text-amber-700' : entry.status === 'RESOLVED' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}">
                  {statusLabel(entry.status)}
                </span>
              </td>
              <td class="px-4 py-4 text-xs">
                <div class="flex flex-wrap items-center gap-2">
                  <ActionButton
                    onClick={() => openReportModal(entry)}
                    disabled={reportAction.disabled}
                    title={reportAction.hint}
                    variant={reportAction.variant}
                    icon={reportAction.icon}
                    label={reportAction.label}
                    className="min-w-42.5"
                  />
                  {#if canDeleteSanctions}
                    <ActionButton
                      onClick={() => openDeleteModal(entry)}
                      disabled={deletingSanctionId === entry.id}
                      title={m.sc_delete_infraction_title()}
                      variant="danger"
                      icon="trash"
                      label={deletingSanctionId === entry.id ? m.sc_deleting() : m.common_delete()}
                      className="min-w-42.5"
                    />
                  {/if}
                </div>
                <p class="mt-2 text-[10px] font-semibold text-on-surface-variant">{reportAction.hint}</p>
              </td>
            </tr>
          {/each}
        {/if}
        {#if !showSanctionsSkeleton && sanctions.length === 0}
          <tr>
            <td colspan="7" class="px-6 py-14 text-center text-on-surface-variant">{m.sc_no_sanctions()}</td>
          </tr>
        {:else if !showSanctionsSkeleton && filteredAndSortedSanctions.length === 0}
          <tr>
            <td colspan="7" class="px-6 py-14 text-center text-on-surface-variant">
              Aucune sanction ne correspond aux filtres appliques.
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
</section>
    {/if}
    
    {#if activeTab === 'settings'}
      <section class="space-y-8 animate-in fade-in duration-500">
        <div class="premium-card p-10 rounded-xl space-y-8">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-4">
              <div>
                <p class="text-sm font-semibold text-on-surface">{m.sc_mod_role()}</p>
                <p class="text-xs text-on-surface-variant/70 mt-1">{m.sc_mod_role_desc()}</p>
              </div>
              <SearchableSelect bind:value={guildSettings.moderatorRoleId} options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.sc_no_role_ph()} className="w-full rounded-lg bg-surface-container-high/40 border border-outline-variant/10 px-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary/30 transition-all" />
            </div>

            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-semibold text-on-surface">{m.sc_propagation()}</p>
                  <p class="text-xs text-on-surface-variant/70 mt-1">{m.sc_propagation_desc()}</p>
                </div>
                 <ToggleSwitch
                  checked={guildSettings.propagateSanctions}
                  onToggle={(v: boolean) => {
                    guildSettings.propagateSanctions = v;
                  }}
                />
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-semibold text-on-surface">{m.sc_reports()}</p>
                  <p class="text-xs text-on-surface-variant/70 mt-1">{m.sc_reports_desc()}</p>
                </div>
                <ToggleSwitch
                  checked={guildSettings.sanctionReportEnabled}
                  onToggle={(v: boolean) => {
                    guildSettings.sanctionReportEnabled = v;
                  }}
                />
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-semibold text-on-surface">{m.sc_dm_appeal()}</p>
                  <p class="text-xs text-on-surface-variant/70 mt-1">
                    Envoie automatiquement le lien public de l'appel de bannissement par DM (hors bannissements temporaires).
                    {m.sc_same_setting()}
                  </p>
                </div>
                <ToggleSwitch
                  checked={banAppealNotifyOnBanDM}
                  disabled={banAppealNotifySaving}
                  onToggle={(v: boolean) => toggleBanAppealNotify(v)}
                />
              </div>
            </div>
          </div>

          {#if featureConfig}
          <div class="pt-8 border-t border-outline-variant/10">
            <RolePermissionSettings 
              featureKey="sanctions" 
              roleAccess={featureConfig.roleAccessByRole} 
            />
          </div>
          {/if}

          <!-- Save button removed since global bottom bar handles saving -->
          {#if saveAction.state.message}
            <p class="text-xs font-bold text-emerald-600 text-center">{saveAction.state.message}</p>
          {/if}
          {#if saveAction.state.error}
            <p class="text-xs font-bold text-red-600 text-center">{saveAction.state.error}</p>
          {/if}
        </div>
      </section>

      <!-- Échelles de Sanctions Progressives -->
      <section class="section-card-flush font-inter mt-8">
        <div class="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
          <h3 class="text-lg font-semibold">{m.sc_scales_title()}</h3>
          <p class="text-xs text-on-surface-variant/70 mt-1">{m.sc_scales_desc()}</p>
        </div>

        <div class="premium-card p-10 rounded-xl">
          <div class="flex flex-col lg:flex-row gap-10">
            <!-- Left panel: scales list -->
            <div class="w-full lg:w-1/3 space-y-4 border-r border-outline-variant/10 lg:pr-8">
              <div class="flex items-center justify-between">
                <span class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">{m.sc_my_scales()}</span>
                {#if !showAddTableField}
                  <button 
                    onclick={() => showAddTableField = true}
                    class="text-xs font-semibold text-primary hover:text-primary/80 transition uppercase tracking-wider"
                  >
                    + Ajouter
                  </button>
                {/if}
              </div>

              {#if showAddTableField}
                <div class="flex gap-2 p-2 bg-surface-container-high/40 rounded-lg border border-outline-variant/10">
                  <FormInput 
                    bind:value={newTableName} 
                    placeholder={m.sc_scale_name_ph()} 
                    className="flex-1 text-xs px-3 py-2 bg-transparent outline-none border-none text-on-surface"
                  />
                  <button 
                    onclick={addSanctionTable}
                    class="px-3 py-1 bg-primary text-on-primary rounded-xl text-[10px] font-semibold uppercase tracking-wider"
                  >
                    Ok
                  </button>
                  <button 
                    onclick={() => { showAddTableField = false; newTableName = ''; }}
                    class="px-2 text-on-surface-variant/70 text-xs"
                  >
                    Annuler
                  </button>
                </div>
              {/if}

              <div class="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                {#each guildSettings.sanctionTables as table, i}
                  <button
                    type="button"
                    class="flex items-center justify-between w-full text-left p-4 rounded-lg transition-all cursor-pointer {selectedTableIndex === i ? 'bg-primary/10 border border-primary/20 text-primary' : 'bg-surface-container-high/30 border border-transparent text-on-surface hover:bg-surface-container-high/60'}"
                    onclick={() => selectedTableIndex = i}
                  >
                    <span class="text-sm font-bold truncate">{table.name}</span>
                    <div class="flex items-center gap-3">
                      <span class="text-[10px] font-semibold bg-on-surface/5 px-2 py-0.5 rounded-md text-on-surface-variant/80">{table.tiers.length} palier(s)</span>
                      <span
                        role="button"
                        tabindex="0"
                        onclick={(e) => { e.stopPropagation(); deleteSanctionTable(i); }}
                        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); deleteSanctionTable(i); } }}
                        class="text-on-surface-variant/40 hover:text-red-500 transition-colors cursor-pointer"
                      >
                        <Papicon icon="trash" size={14} />
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </div>

            <!-- Right panel: scale editor -->
            <div class="flex-1 space-y-6">
              {#if guildSettings.sanctionTables.length === 0}
                <div class="h-full min-h-[200px] flex flex-col items-center justify-center text-center space-y-2">
                  <Papicon icon="alert-triangle" size={32} class="text-on-surface-variant/40 animate-pulse" />
                  <p class="text-sm font-bold text-on-surface-variant">{m.sc_no_scales()}</p>
                  <p class="text-xs text-on-surface-variant/60">{m.sc_add_scale_hint()}</p>
                </div>
              {:else}
                {@const currentTable = guildSettings.sanctionTables[selectedTableIndex]}
                {#if currentTable}
                  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/10 pb-4">
                    <div class="flex items-center gap-4">
                      <FormInput 
                        bind:value={currentTable.name} 
                        className="text-lg font-semibold bg-transparent border-none text-on-surface focus:ring-0 px-0 py-0 w-60"
                      />
                      <span class="text-xs text-on-surface-variant/60 italic font-medium">{m.sc_click_rename()}</span>
                    </div>

                    <!-- Exporter -->
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60 mr-2">{m.sc_export_scale()}</span>
                      <button 
                        onclick={() => exportTableToImage(currentTable)}
                        class="p-2 rounded-xl bg-surface-container-high/40 hover:bg-primary/10 hover:text-primary transition-all text-on-surface-variant flex items-center justify-center cursor-pointer"
                        title="Exporter en Image (Style Kotbo Landing)"
                      >
                        <Papicon icon="image" size={16} />
                      </button>
                      <button 
                        onclick={() => exportTableToXlsx(currentTable)}
                        class="p-2 rounded-xl bg-surface-container-high/40 hover:bg-emerald-500/10 hover:text-emerald-500 transition-all text-on-surface-variant flex items-center justify-center cursor-pointer"
                        title="Exporter en Excel (.xlsx)"
                      >
                        <Papicon icon="file-spreadsheet" size={16} />
                      </button>
                      <button 
                        onclick={() => exportTableToCsv(currentTable)}
                        class="p-2 rounded-xl bg-surface-container-high/40 hover:bg-amber-500/10 hover:text-amber-500 transition-all text-on-surface-variant flex items-center justify-center cursor-pointer"
                        title="Exporter en CSV"
                      >
                        <Papicon icon="file-text" size={16} />
                      </button>
                      <button 
                        onclick={() => exportTableToJson(currentTable)}
                        class="p-2 rounded-xl bg-surface-container-high/40 hover:bg-indigo-500/10 hover:text-indigo-500 transition-all text-on-surface-variant flex items-center justify-center cursor-pointer"
                        title="Exporter en JSON"
                      >
                        <Papicon icon="code" size={16} />
                      </button>
                    </div>
                  </div>

                  <!-- Grille éditable de Tiers (Style Google Sheets) -->
                  <div class="max-h-[500px] overflow-y-auto pr-2">
                    <div class="overflow-x-auto rounded-lg border border-outline-variant/10 bg-surface-container-low/20">
                      <table class="w-full text-left border-collapse font-inter text-xs">
                        <thead>
                          <tr class="bg-surface-container-high/40 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/70 border-b border-outline-variant/15 select-none">
                            <th class="py-3 px-4 w-20 text-center border-r border-outline-variant/10">Palier</th>
                            <th class="py-3 px-4 w-48 border-r border-outline-variant/10">Action</th>
                            <th class="py-3 px-4 w-48 border-r border-outline-variant/10">{m.sc_col_duration()}</th>
                            <th class="py-3 px-4 border-r border-outline-variant/10">{m.sc_col_custom_reason()}</th>
                            <th class="py-3 px-2 w-12 text-center"></th>
                          </tr>
                        </thead>
                        <tbody class="divide-y divide-outline-variant/10">
                          {#each currentTable.tiers as tier, tierIdx}
                            <tr class="group hover:bg-surface-hover/10 transition-colors">
                              <!-- Palier -->
                              <td class="py-2.5 px-4 font-semibold text-center text-primary/80 select-none bg-surface-container-high/15 border-r border-outline-variant/10">
                                T{tier.level}
                              </td>
                              
                              <!-- Action -->
                              <td class="py-2 px-3 border-r border-outline-variant/10">
                                <select 
                                  bind:value={tier.action}
                                  class="w-full bg-transparent font-bold py-1.5 px-2 rounded-lg cursor-pointer outline-hidden focus:bg-surface-container-high/40 border border-transparent focus:border-primary/20 transition-all
 {tier.action === 'WARN' ? 'text-amber-500 dark:text-amber-400' : ''}
                                    {tier.action === 'TIMEOUT' ? 'text-blue-500 dark:text-blue-400' : ''}
                                    {tier.action === 'KICK' ? 'text-rose-500 dark:text-rose-400' : ''}
                                    {tier.action === 'TEMP_BAN' ? 'text-red-500 dark:text-red-400 font-semibold' : ''}
                                    {tier.action === 'BAN' ? 'text-red-600 dark:text-red-500 font-semibold' : ''}
                                    {tier.action === 'SOFTBAN' ? 'text-purple-500 dark:text-purple-400' : ''}"
                                >
                                  <option value="WARN" class="text-on-surface bg-surface-container-lowest">Warn</option>
                                  <option value="TIMEOUT" class="text-on-surface bg-surface-container-lowest">Timeout</option>
                                  <option value="KICK" class="text-on-surface bg-surface-container-lowest">Kick</option>
                                  <option value="TEMP_BAN" class="text-on-surface bg-surface-container-lowest">Ban Temp</option>
                                  <option value="BAN" class="text-on-surface bg-surface-container-lowest font-bold">Ban Perm</option>
                                  <option value="SOFTBAN" class="text-on-surface bg-surface-container-lowest">Softban</option>
                                </select>
                              </td>

                              <!-- Durée -->
                              <td class="py-2 px-3 border-r border-outline-variant/10">
                                {#if ['TIMEOUT', 'TEMP_BAN'].includes(tier.action)}
                                  {@const initialVal = getDurationValue(tier.durationSeconds)}
                                  {@const initialUnit = getDurationUnit(tier.durationSeconds)}
                                  <div class="flex items-center gap-1.5 w-full">
                                    <input 
                                      type="number" 
                                      value={initialVal} 
                                      oninput={(e) => updateTierDuration(selectedTableIndex, tierIdx, Number((e.target as HTMLInputElement).value), initialUnit)}
                                      class="w-16 text-center py-1 px-1.5 rounded-lg bg-surface-container-high/30 text-on-surface border border-outline-variant/10 focus:border-primary/40 focus:bg-surface-container-high/60 outline-hidden transition-all text-xs font-bold"
                                      min="1"
                                    />
                                    <select 
                                      value={initialUnit}
                                      onchange={(e) => updateTierDuration(selectedTableIndex, tierIdx, initialVal, (e.target as HTMLSelectElement).value as any)}
                                      class="flex-1 bg-transparent py-1 px-1.5 rounded-lg border border-transparent hover:border-outline-variant/10 focus:border-primary/30 outline-hidden transition-all text-xs font-semibold cursor-pointer"
                                    >
                                      <option value="m" class="text-on-surface bg-surface-container-lowest">min</option>
                                      <option value="h" class="text-on-surface bg-surface-container-lowest">h</option>
                                      <option value="d" class="text-on-surface bg-surface-container-lowest">j</option>
                                    </select>
                                  </div>
                                {:else}
                                  <div class="h-7 flex items-center justify-center text-[10px] font-semibold tracking-wider text-on-surface-variant/30 select-none bg-linear-to-br from-outline-variant/5 to-transparent rounded-lg">
                                    N/A
                                  </div>
                                {/if}
                              </td>

                              <!-- Raison Personnalisée -->
                              <td class="py-2 px-3 border-r border-outline-variant/10">
                                <input 
                                  type="text"
                                  bind:value={tier.customReason}
                                  placeholder={m.sc_reason_ph()}
                                  class="w-full bg-transparent py-1.5 px-2 rounded-lg border border-transparent hover:border-outline-variant/10 focus:border-primary/30 focus:bg-surface-container-high/30 outline-hidden transition-all text-xs text-on-surface"
                                />
                              </td>

                              <!-- Supprimer -->
                              <td class="py-2 px-2 text-center">
                                {#if currentTable.tiers.length > 1}
                                  <button 
                                    onclick={() => removeTier(selectedTableIndex, tierIdx)}
                                    class="text-on-surface-variant/40 hover:text-red-500 active:scale-95 transition-all p-1.5 rounded-lg hover:bg-red-500/10 opacity-0 group-hover:opacity-100 cursor-pointer flex items-center justify-center mx-auto"
                                    title={m.sc_delete_tier()}
                                  >
                                    <Papicon icon="trash" size={13} />
                                  </button>
                                {/if}
                              </td>
                            </tr>
                          {/each}
                          
                          <!-- Insérer une ligne -->
                          <tr class="bg-surface-container-low/10">
                            <td colspan="5" class="p-0">
                              <button 
                                onclick={() => addTier(selectedTableIndex)}
                                class="w-full py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-primary hover:text-primary/80 hover:bg-primary/5 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                              >
                                <Papicon icon="plus" size={12} />
                                {m.sc_insert_tier()}
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        </div>
      </section>
    {/if}
  </div>

{#if modalOpen && selectedSanction}
  <div 
    use:portal
    class="modal-backdrop" 
    onclick={closeModal}
    onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) closeModal(); }}
    aria-label={m.sc_close_modal()}
    role="button"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div 
      class="modal-panel modal-panel-lg space-y-0 p-0 font-inter overflow-hidden rounded-xl" 
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Hero Header Style -->
      <div class="relative bg-linear-to-br from-primary/10 via-surface to-surface p-8 border-b border-outline-variant/5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.sc_sanction_file()}</p>
            <h3 id="modal-title" class="text-2xl font-semibold text-on-surface mt-1">{typeLabel(selectedSanction.type)}</h3>
            <p class="text-xs font-bold text-on-surface-variant/60 mt-1">
              {m.sc_applied_to()}
              <button onclick={() => openCaseModal(selectedSanction.targetUserId, selectedSanction.targetTag)} class="text-on-surface hover:text-primary transition-colors font-semibold">
                @{selectedSanction.targetTag}
              </button> 
              par 
              <button onclick={() => openCaseModal(selectedSanction.moderatorUserId, selectedSanction.moderatorTag)} class="text-on-surface hover:text-primary transition-colors font-semibold">
                @{selectedSanction.moderatorTag}
              </button>
            </p>
          </div>
          <button
            onclick={closeModal}
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-on-surface/5 text-on-surface-variant hover:bg-on-surface/10 hover:text-on-surface transition-all"
          >
            <Papicon icon="x" size={20} />
          </button>
        </div>
      </div>

      <div class="p-8 space-y-8 max-h-[70vh] overflow-y-auto">
        {#if modalMode === 'view' && selectedReport && !isEditing}
          <!-- View Mode -->
          <div class="space-y-8 animate-in fade-in duration-300">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div class="space-y-1.5">
                <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.sc_incident_date()}</p>
                <div class="rounded-lg bg-surface-container-high/40 px-5 py-3 text-sm font-bold text-on-surface">
                  {new Date(selectedReport.incidentAt).toLocaleString('fr-FR')}
                </div>
              </div>
              <div class="space-y-1.5">
                <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.sc_announced_duration()}</p>
                <div class="rounded-lg bg-surface-container-high/40 px-5 py-3 text-sm font-bold text-on-surface">
                  {selectedReport.sanctionDurationLabel || 'N/A'}
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.sc_broken_rules()}</p>
              <SelectedRuleChips selectedRules={selectedReportRules} />
            </div>

            <div class="space-y-3">
              <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.sc_detailed_reason()}</p>
              <div class="rounded-xl bg-surface-container-high/30 p-6 text-sm text-on-surface-variant leading-relaxed italic border border-outline-variant/5">
                "{selectedReport.detailedReason}"
              </div>
            </div>

            {#if selectedReport.evidenceLinks && selectedReport.evidenceLinks.length > 0}
              <div class="space-y-3">
                <p class="text-xs font-medium text-on-surface-variant/40 px-1">Preuves</p>
                <div class="flex flex-wrap gap-2">
                  {#each selectedReport.evidenceLinks as link}
                    <a href={link} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 rounded-xl bg-primary/5 px-4 py-2.5 text-[11px] font-semibold text-primary uppercase tracking-widest transition-all hover:bg-primary/10">
                      <Papicon icon="external-link" size={14} />
                      Lien de preuve
                    </a>
                  {/each}
                </div>
              </div>
            {/if}

            {#if selectedReport.additionalNotes}
              <div class="space-y-3">
                <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.sc_additional_notes()}</p>
                <p class="text-sm text-on-surface-variant/70 leading-relaxed bg-surface-container-low p-4 rounded-lg border border-outline-variant/10">{selectedReport.additionalNotes}</p>
              </div>
            {/if}

            <div class="pt-6 flex flex-col items-center gap-4 border-t border-outline-variant/10">
              <p class="text-[10px] font-bold text-on-surface-variant/30 text-center">
                {m.sc_report_by()}
                <button 
                  onclick={() => openCaseModal(selectedReport.createdByUserId, selectedReport.createdByTag || selectedReport.createdByUserId)}
                  class="hover:text-primary transition-colors font-bold"
                >
                  @{selectedReport.createdByTag || selectedReport.createdByUserId}
                </button>
              </p>
              
              {#if canEditSelectedReport}
                <button
                  onclick={startEditing}
                  class="inline-flex items-center gap-2 rounded-lg bg-primary px-8 py-3 text-[11px] font-semibold text-on-primary uppercase tracking-widest transition-all hover: active:scale-95 "
                >
                  <Papicon icon="edit-3" size={16} />
                  {m.sc_edit_report()}
                </button>
              {/if}
            </div>
          </div>
        {:else}
          <!-- Create / Edit Form -->
          <div class="space-y-8 animate-in fade-in duration-300">
            {#if !canCreateSelectedReport && !isEditing}
              <div class="rounded-lg bg-amber-500/10 border border-amber-500/20 p-4 flex items-center gap-4">
                <Papicon icon="lock" class="text-amber-500" />
                <p class="text-xs font-bold text-amber-700">{m.sc_report_reserved_hint()}</p>
              </div>
            {/if}

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div class="space-y-1.5">
                <label for="report-incident-at" class="field-label">{m.sc_incident_datetime()}</label>
                <input id="report-incident-at" type="datetime-local" bind:value={incidentAt} class="w-full rounded-lg bg-surface-container-high px-5 py-3 text-sm font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all" />
              </div>
              <div class="space-y-1.5">
                <label for="report-duration" class="field-label">{m.sc_applied_duration()}</label>
                <input id="report-duration" type="text" bind:value={sanctionDurationLabel} placeholder="Ex: 2h, 1j, Permanent" class="w-full rounded-lg bg-surface-container-high px-5 py-3 text-sm font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all" />
              </div>
            </div>

            <div class="space-y-3">
              <label for="report-rules" class="field-label">{m.sc_broken_rules()}</label>
              <ReportRuleSelector
                id="report-rules"
                options={reportRuleOptions}
                selectedIds={selectedRuleIds}
                placeholder={m.sc_select_rules_ph()}
                onToggle={toggleRuleSelection}
              />
              <SelectedRuleChips selectedRules={isEditing ? selectedDraftRules : selectedDraftRules} />
            </div>

            <div class="space-y-1.5">
              <label for="report-reason" class="field-label">{m.sc_detailed_reason()}</label>
              <textarea id="report-reason" bind:value={detailedReason} rows={4} placeholder={m.sc_describe_facts_ph()} class="w-full rounded-xl bg-surface-container-high px-5 py-4 text-sm font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all resize-none"></textarea>
            </div>

            <div class="space-y-3">
              <p id="report-evidence-label" class="text-xs font-medium text-on-surface-variant/40 px-1">Preuves (URLs)</p>
              <EvidenceInputList
                bind:links={evidenceLinks}
                labelId="report-evidence-label"
                inputIdPrefix="report-evidence"
                sanctionId={selectedSanctionId}
              />
            </div>

            <div class="space-y-1.5">
              <label for="report-notes" class="field-label">Notes contextuelles</label>
              <textarea id="report-notes" bind:value={additionalNotes} rows={2} placeholder={m.sc_context_ph()} class="w-full rounded-lg bg-surface-container-high px-5 py-3 text-sm font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all resize-none"></textarea>
            </div>

            {#if reportMessage}
              <div class="rounded-xl p-4 text-[13px] font-medium {reportMessageIsError ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'}">
                {reportMessage}
              </div>
            {/if}

            <div class="flex gap-4 pt-4">
              {#if isEditing}
                <button
                  onclick={() => isEditing = false}
                  class="flex-1 py-4 rounded-lg bg-on-surface/5 text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant transition-all hover:bg-on-surface/10"
                >
                  Annuler
                </button>
                <button
                  onclick={handleUpdateReport}
                  disabled={updateReportBusy}
                  class="flex-2 py-4 rounded-lg bg-primary text-on-primary text-[11px] font-semibold uppercase tracking-widest transition-all hover: active:scale-95 disabled:opacity-50"
                >
                  {updateReportBusy ? m.sc_saving() : m.sc_update_report()}
                </button>
              {:else}
                <button
                  onclick={submitReport}
                  disabled={creatingReport || !canCreateSelectedReport}
                  class="w-full py-4 rounded-lg bg-primary text-on-primary text-[11px] font-semibold uppercase tracking-widest transition-all hover: active:scale-95 disabled:opacity-50"
                >
                  {creatingReport ? m.sc_creating() : m.sc_finalize_report()}
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if deleteModalOpen && pendingDeletion}
  <div 
    use:portal
    class="modal-backdrop" 
    onclick={closeDeleteModal}
    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && closeDeleteModal()}
    aria-label={m.sc_close_modal()}
    role="button"
    tabindex="-1"
  >
    <div 
      class="modal-panel max-w-lg space-y-4 font-inter" 
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-sanction-title"
      tabindex="-1"
    >
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-wider text-red-500">Action sensible</p>
        <h3 id="delete-sanction-title" class="mt-1 text-xl font-semibold text-on-surface">{m.sc_confirm_deletion()}</h3>
        <p class="mt-2 text-sm text-on-surface-variant">
          {m.sc_delete_confirm_pre()} <span class="font-bold text-on-surface">{typeLabel(pendingDeletion.type)}</span>
          {m.sc_for_target()} <span class="font-bold text-on-surface">{pendingDeletion.targetTag}</span>. {m.sc_irreversible()}
        </p>
      </div>

      <div>
        <label for="delete-confirmation" class="field-label">{m.sc_type_delete({ word: m.sc_delete_keyword() })}</label>
        <FormInput
          id="delete-confirmation"
          type="text"
          bind:value={deleteConfirmationText}
          autocomplete="off"
          className="mt-1 w-full rounded-xl px-3 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm focus:ring-2 focus:ring-red-400/40 focus:border-red-400 dark:focus:border-red-500 transition-all"
          placeholder={m.sc_delete_keyword()}
        />
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2">
        <ActionButton onClick={closeDeleteModal} variant="neutral" label={m.common_cancel()} />
        <ActionButton
          onClick={confirmDeleteSanction}
          variant="danger"
          label={deletingSanctionId ? m.sc_deleting() : m.sc_delete_permanently()}
          disabled={Boolean(deletingSanctionId)}
        />
      </div>
    </div>
  </div>
{/if}
</ModulePage>
