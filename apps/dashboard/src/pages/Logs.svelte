<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { refreshDashboardOnMount } from '../lib/dashboardLifecycle';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import ColumnSortFilter, { type ColumnFilterOption } from '../lib/components/sanctions/ColumnSortFilter.svelte';
  import {
    fetchMemberCase,
    runMemberCaseAction,
    updateGlobalSettings,
    updateModuleStatus,
    fetchFeatureConfigurations,
    updateFeatureConfiguration,
    fetchLogEventConfigs,
    updateLogEventConfigs
  } from '../lib/api';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';


  type LogsSortField = 'date' | 'user' | 'module' | 'action' | 'type';


  type MemberCaseResponse = {
    profile: {
      userId: string;
      userTag: string | null;
      username: string | null;
      globalName: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      bannerUrl: string | null;
      accentColor: number | null;
      locale: string | null;
      isBot: boolean;
      accountCreatedAt: string | null;
      guildJoinedAt: string | null;
      guildLeftAt: string | null;
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      lastMessageAt: string | null;
      lastMessageChannelId: string | null;
      messageCount: number;
      voiceSessionCount: number;
      voiceTimeSeconds: number;
      voiceLastChannelId: string | null;
      voiceLastJoinedAt: string | null;
      voiceLastLeftAt: string | null;
      rolesSnapshot: string[];
      presenceStatus: string | null;
      pronouns: string | null;
      isTutor: boolean;
      staffGrade: string | null;
      isSuspectedDC: boolean;
    } | null;
    invite: {
      code: string | null;
      inviterId: string | null;
      inviterTag: string | null;
      joinedAt: string | null;
    } | null;
    roles: Array<{ id: string; name: string; mention: string; permissions: string[] }>;
    effectivePermissions: string[];
    sanctions: Array<{
      id: string;
      type: string;
      status: string;
      targetUserId: string;
      targetTag: string;
      moderatorUserId: string;
      moderatorTag: string;
      reason: string;
      durationSeconds: number | null;
      expiresAt: string | null;
      createdAt: string;
      resolvedAt: string | null;
      resolutionNote: string | null;
    }>;
    logs: Array<{
      id: string;
      user: string;
      action: string;
      context: string;
      module: string;
      eventType: string;
      source: 'dashboard' | 'discord';
      details: string;
      dateIso: string;
      channelId: string | null;
    }>;
    messagesByChannel: Array<{
      channelId: string;
      channelName: string;
      count: number;
      lastMessageAt: string | null;
      recentMessages: Array<{ id: string; channelId: string; channelName: string; content: string; dateIso: string }>;
    }>;
    recentMessageCount: number;
    recentLogCount: number;
    connections: Array<{ name: string; type: string; visible: boolean }>;
    connectionsNote: string;
    candidatures: Array<{
      id: string;
      status: string;
      notes: string;
      createdAt: string;
      data: any;
      autoRejected: boolean;
      autoRejectReason: string | null;
      rejectionReason: string | null;
      oralResult: string | null;
      reapplyAfter: string | null;
    }>;
    sanctionReports?: Array<{
      id: string;
      sanctionId: string | null;
      staffPseudo: string;
      incidentAt: string;
      memberPseudo: string;
      memberReference: string;
      sanctionType: string;
      sanctionDurationLabel: string | null;
      brokenRules: string;
      detailedReason: string;
      evidenceLinks: string[];
      additionalNotes: string | null;
      createdByUserId: string;
      createdByTag: string | null;
      createdAt: string;
    }>;
    linkedAccounts: Array<{
      userId: string;
      userTag: string | null;
      avatarUrl: string | null;
      type: string;
      status: string;
    }>;
    isSuspectedDC: boolean;
    interactionGraph: {
      nodes: Array<{ id: string; label: string; type: 'user' | 'target'; avatar?: string | null }>;
      edges: Array<{ from: string; to: string; type: 'mention' | 'reply' | 'reaction'; count: number }>;
    };
  };

  let searchQuery = $state('');
  let filters = $state({
    users: [] as string[],
    modules: [] as string[],
    actions: [] as string[],
    types: [] as string[],
    channels: [] as string[],
  });
  let caseModalOpen = $state(false);
  let selectedCaseUser = $state<{ name: string; id: string | null } | null>(null);

  let selectedCaseData = $state<any>(null);
  let selectedCaseLoading = $state(false);
  let selectedCaseError = $state('');
  let memberActionReason = $state(m.lg_member_action_reason());
  let memberActionDuration = $state('30m');
  let memberActionBusy = $state(false);
  let memberActionFeedback = $state('');
  let memberActionIsError = $state(false);
  let sortField = $state<LogsSortField>('date');
  let sortDirection = $state<'asc' | 'desc'>('desc');

  const saveAction = createAsyncActionState();
  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.logs?.canConfigure
      || !!dashboardStore.state.featureAccess?.settings?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  let selectedLogChannelId = $state('');

  $effect(() => {
    selectedLogChannelId = dashboardStore.state.logChannelId || '';
  });

  const logCategories = [
    {
      id: 'messages',
      label: 'Messages',
      icon: 'Chat',
      events: [
        { type: 'message_delete', label: m.lg_ev_message_delete(), desc: m.lg_ev_message_delete_d() },
        { type: 'message_edit', label: m.lg_ev_message_edit(), desc: m.lg_ev_message_edit_d() },
        { type: 'message_bulk_delete', label: m.lg_ev_bulk_delete(), desc: m.lg_ev_bulk_delete_d() }
      ]
    },
    {
      id: 'members',
      label: m.lg_cat_members(),
      icon: 'Users',
      events: [
        { type: 'member_join', label: m.lg_ev_member_join(), desc: m.lg_ev_member_join_d() },
        { type: 'member_leave', label: m.lg_ev_member_leave(), desc: m.lg_ev_member_leave_d() },
        { type: 'member_roles_update', label: m.lg_ev_roles_update(), desc: m.lg_ev_roles_update_d() },
        { type: 'member_timeout', label: m.lg_ev_member_timeout(), desc: m.lg_ev_member_timeout_d() }
      ]
    },
    {
      id: 'moderation',
      label: m.lg_cat_moderation(),
      icon: 'Shield',
      events: [
        { type: 'moderation_kick', label: m.lg_ev_kick(), desc: m.lg_ev_kick_d() },
        { type: 'moderation_ban', label: m.lg_ev_ban(), desc: m.lg_ev_ban_d() },
        { type: 'moderation_unban', label: m.lg_ev_unban(), desc: m.lg_ev_unban_d() },
        { type: 'moderation_timeout', label: 'Timeout (Audit)', desc: m.lg_ev_timeout_audit_d() }
      ]
    },
    {
      id: 'voice',
      label: m.lg_cat_voice(),
      icon: 'Microphone',
      events: [
        { type: 'voice_join', label: m.lg_ev_voice_join(), desc: m.lg_ev_voice_join_d() },
        { type: 'voice_leave', label: m.lg_ev_voice_leave(), desc: m.lg_ev_voice_leave_d() },
        { type: 'voice_move', label: m.lg_ev_voice_move(), desc: m.lg_ev_voice_move_d() }
      ]
    },
    {
      id: 'lifecycle',
      label: m.lg_cat_lifecycle(),
      icon: 'Folder',
      events: [
        { type: 'channel_lifecycle', label: m.lg_ev_channel_lifecycle(), desc: m.lg_ev_channel_lifecycle_d() },
        { type: 'role_lifecycle', label: m.lg_ev_role_lifecycle(), desc: m.lg_ev_role_lifecycle_d() }
      ]
    }
  ];

  let logsConfig = $state<any>(null);
  let loadingConfig = $state(false);
  let eventConfigs = $state<Array<{ eventType: string; enabled: boolean; channelId: string | null }>>([]);
  let savedEventConfigs = $state<Array<{ eventType: string; enabled: boolean; channelId: string | null }>>([]);

  $effect(() => {
    const current = JSON.stringify(eventConfigs);
    const saved = JSON.stringify(savedEventConfigs);
    const dirty = current !== saved;

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          label: m.lg_page_title(),
          onSave: () => handleSaveEventConfigs(),
          onReset: () => {
            eventConfigs = JSON.parse(JSON.stringify(savedEventConfigs));
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        if (unsavedChanges.isDirty && unsavedChanges.pageLabel === m.lg_page_title()) {
          unsavedChanges.clear();
        }
      });
    }
  });

  onDestroy(() => {
    if (unsavedChanges.pageLabel === m.lg_page_title()) {
      unsavedChanges.clear();
    }
  });

  onMount(async () => {
    loadingConfig = true;
    try {
      const [configs, eventConfigsRes] = await Promise.all([
        fetchFeatureConfigurations(),
        fetchLogEventConfigs()
      ]);
      logsConfig = configs?.features?.find((c: any) => c.featureKey === 'logs') || null;
      eventConfigs = eventConfigsRes?.configs || [];
      savedEventConfigs = JSON.parse(JSON.stringify(eventConfigs));
    } catch (err) {
      console.error('Error fetching logs config:', err);
    } finally {
      loadingConfig = false;
    }
  });

  async function handleSaveEventConfigs(): Promise<boolean> {
    let success = false;
    await saveAction.run(async () => {
      const ok = await updateLogEventConfigs(eventConfigs);
      if (!ok) throw new Error(m.sc_api_error());
      savedEventConfigs = JSON.parse(JSON.stringify(eventConfigs));
      success = true;
      return true;
    }, { successMessage: m.lg_events_saved() });
    return success;
  }

  async function toggleConfig(key: string, value: boolean) {
    if (!logsConfig) return;
    
    await saveAction.run(async () => {
      const ok = await updateFeatureConfiguration('logs', { [key]: value });
      if (!ok) throw new Error(m.sc_api_error());
      logsConfig[key] = value;
      return true;
    }, { successMessage: m.sc_config_updated() });
  }

  async function handleLogChannelChange() {
    const channelId = selectedLogChannelId || '';
    
    await saveAction.run(async () => {
      const ok = await updateGlobalSettings({ logChannelId: channelId });
      if (!ok) throw new Error(m.sc_api_error());
      
      // Also update the feature config channelId if logsConfig exists
      if (logsConfig) {
        await updateFeatureConfiguration('logs', { channelId });
        logsConfig.channelId = channelId;
      }

      await dashboardStore.refresh();
      return true;
    }, { successMessage: m.lg_log_channel_updated() });
  }

  // Filter to only Discord logs
  const discordLogs = $derived((dashboardStore.state.auditTrail as any[]).filter(entry => entry.source === 'discord'));

  function extractUserIdFromText(value: string | null | undefined) {
    if (!value) return null;

    const mentionMatch = value.match(/<@!?(\d{15,25})>/);
    if (mentionMatch?.[1]) return mentionMatch[1];

    const parenthesizedIdMatch = value.match(/\((\d{15,25})\)/);
    if (parenthesizedIdMatch?.[1]) return parenthesizedIdMatch[1];

    return null;
  }

  function hideUserIds(value: string) {
    return value
      .replace(/\(<@!?\d{15,25}>\)/g, '')
      .replace(/<@!?\d{15,25}>/g, '@utilisateur')
      .replace(/\((\d{15,25})\)/g, '');
  }

  function replaceEntityMentions(value: string) {
    return value
      .replace(/<#(\d{15,25})>/g, (_, channelId: string) => {
        const channel = dashboardStore.state.discordChannels.find((entry) => entry.id === channelId);
        const name = channel ? channel.name : m.lg_unknown_channel_name();
        return `<a href="https://discord.com/channels/${authStore.selectedGuildId}/${channelId}" target="_blank" class="mention-link">#${name}</a>`;
      })
      .replace(/<@&(\d{15,25})>/g, (_, roleId: string) => {
        const role = dashboardStore.state.discordRoles.find((entry) => entry.id === roleId);
        const name = role ? role.name : 'role-inconnu';
        return `<span class="mention">@${name}</span>`;
      });
  }

  function parseDetailsMetadata(details: string, user?: string) {
    const userMatch = details.match(/^([^|]+?\(<@!?\d{15,25}>\))/);
    const userIdMatch = extractUserIdFromText(details) ?? extractUserIdFromText(user);
    const channelMatch = details.match(/Salon:\s*<#(\d+)>/i);

    let cleanDetails = details;
    if (userMatch) {
      cleanDetails = cleanDetails.replace(userMatch[0], '').trim();
    }
    // Remove salon info from details once it is displayed in its own column.
    cleanDetails = cleanDetails.replace(/\|?\s*Salon:\s*<#\d+>\s*/gi, '');
    cleanDetails = cleanDetails.replace(/^\|\s*/, '').trim();
    cleanDetails = cleanDetails.replace(/\s*\|\s*/g, ' | ').trim();

    return {
      extractedUser: userMatch?.[1]?.trim() ?? null,
      extractedUserId: userIdMatch,
      extractedChannelId: channelMatch?.[1] ?? null,
      cleanDetails: replaceEntityMentions(hideUserIds(cleanDetails)),
    };
  }

  function parseDetailsStructure(details: string) {
    if (!details) return { badges: [], blocks: [] };
    
    let clean = details;
    const userMatch = clean.match(/^([^|]+?\(<@!?\d{15,25}>\))/);
    if (userMatch) {
      clean = clean.replace(userMatch[0], '').trim();
    }
    clean = clean.replace(/\|?\s*Salon:\s*<#\d+>\s*/gi, '');
    clean = clean.replace(/^\|\s*/, '').trim();

    const parts = clean.split(/\s*\|\s*/);
    const badges: Array<{ key: string | null; value: string }> = [];
    const blocks: Array<{ key: string; value: string }> = [];

    for (const part of parts) {
      const colIndex = part.indexOf(':');
      if (colIndex > -1) {
        const key = part.slice(0, colIndex).trim();
        const value = part.slice(colIndex + 1).trim();
        const cleanKey = replaceEntityMentions(hideUserIds(key));
        const cleanVal = replaceEntityMentions(hideUserIds(value));
        
        if (['contenu', 'raison', 'description', 'reason', 'contenu d\'origine', 'nouveau contenu', 'arguments'].includes(key.toLowerCase()) || value.length > 50) {
          blocks.push({ key: cleanKey, value: cleanVal });
        } else {
          badges.push({ key: cleanKey, value: cleanVal });
        }
      } else {
        const cleanVal = replaceEntityMentions(hideUserIds(part));
        if (cleanVal) {
          if (cleanVal.length > 50) {
            blocks.push({ key: m.lg_details(), value: cleanVal });
          } else {
            badges.push({ key: null, value: cleanVal });
          }
        }
      }
    }
    
    return { badges, blocks };
  }

  function getLogChannelId(entry: { details: string; channelId: string | null }) {
    return parseDetailsMetadata(entry.details, '').extractedChannelId ?? entry.channelId;
  }

  function displayUser(entry: { user: string; details: string }) {
    const parsed = parseDetailsMetadata(entry.details, entry.user);
    if (!parsed.extractedUser) {
      return hideUserIds(entry.user).trim() || entry.user;
    }
    const normalized = parsed.extractedUser.replace(/\s*\(<@!?\d{15,25}>\)\s*$/, '').trim();
    return normalized || hideUserIds(entry.user).trim() || entry.user;
  }

  const uniqueUsers = $derived([...new Set(discordLogs.map((entry) => displayUser(entry)))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueModules = $derived([...new Set(discordLogs.map((entry) => entry.module))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueActions = $derived([...new Set(discordLogs.map((entry) => entry.action))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueTypes = $derived([...new Set(discordLogs.map((entry) => entry.eventType))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueChannels = $derived(
    [...new Set(discordLogs.map((entry) => getLogChannelId(entry)).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'fr'))
  );

  const userFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueUsers.map((user) => ({ value: user, label: user }))
  );
  const moduleFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueModules.map((moduleName) => ({ value: moduleName, label: moduleName }))
  );
  const actionFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueActions.map((actionName) => ({ value: actionName, label: actionName }))
  );
  const typeFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueTypes.map((eventType) => ({ value: eventType, label: eventType }))
  );
  const channelFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueChannels.map((channelId) => ({ value: channelId, label: formatChannelLabel(channelId) }))
  );

  const hasActiveFiltersOrSort = $derived(
    filters.users.length > 0
      || filters.modules.length > 0
      || filters.actions.length > 0
      || filters.types.length > 0
      || filters.channels.length > 0
      || sortField !== 'date'
      || sortDirection !== 'desc'
  );

  function toggleFilter(filterType: 'users' | 'modules' | 'actions' | 'types' | 'channels', value: string) {
    const list = filters[filterType];
    if (list.includes(value)) {
      filters[filterType] = list.filter((entry) => entry !== value);
      return;
    }
    filters[filterType] = [...list, value];
  }

  function toggleSort(field: LogsSortField) {
    if (sortField === field) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortField = field;
    sortDirection = 'asc';
  }

  function sortDirectionFor(field: LogsSortField) {
    return sortField === field ? sortDirection : null;
  }

  function resetFiltersAndSort() {
    filters = {
      users: [],
      modules: [],
      actions: [],
      types: [],
      channels: [],
    };
    sortField = 'date';
    sortDirection = 'desc';
  }

  function formatChannelLabel(channelId: string | null | undefined) {
    if (!channelId) return m.lg_not_specified();
    const channel = dashboardStore.state.discordChannels.find((item) => item.id === channelId);
    if (!channel) return m.lg_unknown_channel();
    return channelDisplayName(channel);
  }

  function formatDateTime(value: string | null | undefined) {
    if (!value) return m.pf_unknown();
    return new Date(value).toLocaleString(dateLocale());
  }

  function formatDurationFromSeconds(seconds: number | null | undefined) {
    if (!seconds || seconds <= 0) return m.lg_zero_second();
    const totalSeconds = Math.floor(seconds);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts: string[] = [];
    if (days) parts.push(m.lg_days_unit({ n: days }));
    if (hours) parts.push(m.lg_hours_unit({ n: hours }));
    if (minutes) parts.push(m.lg_minutes_unit({ n: minutes }));
    if (parts.length === 0) parts.push(m.lg_seconds_unit({ n: totalSeconds }));
    return parts.join(' ');
  }

  function parseDurationToMs(input: string) {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;
    const match = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*(s|sec|secs|seconde|secondes|m|min|mins|minute|minutes|h|heure|heures|d|j|jour|jours|w|semaine|semaines)$/i);
    if (!match) return null;
    const value = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = match[2].toLowerCase();
    const unitMs: Record<string, number> = {
      s: 1000,
      sec: 1000,
      secs: 1000,
      seconde: 1000,
      secondes: 1000,
      m: 60 * 1000,
      min: 60 * 1000,
      mins: 60 * 1000,
      minute: 60 * 1000,
      minutes: 60 * 1000,
      h: 60 * 60 * 1000,
      heure: 60 * 60 * 1000,
      heures: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      j: 24 * 60 * 60 * 1000,
      jour: 24 * 60 * 60 * 1000,
      jours: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      semaine: 7 * 24 * 60 * 60 * 1000,
      semaines: 7 * 24 * 60 * 60 * 1000,
    };
    return Math.round(value * (unitMs[unit] ?? 0)) || null;
  }

  function sanitizeLogSnippet(value: string) {
    return value.replace(/^Contenu:\s*/i, '').replace(/^\s+|\s+$/g, '');
  }

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

  async function executeMemberAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!selectedCaseUser?.id) return;
    const userId = selectedCaseUser.id;

    const reason = memberActionReason.trim() || m.lg_member_action_reason();
    const durationMs = action === 'TIMEOUT' ? parseDurationToMs(memberActionDuration) : null;

    if (action === 'TIMEOUT' && !durationMs) {
      memberActionFeedback = m.lg_invalid_timeout();
      memberActionIsError = true;
      return;
    }

    memberActionBusy = true;
    memberActionFeedback = '';
    memberActionIsError = false;

    try {
      await runMemberCaseAction(userId, action, { reason, durationMs: durationMs ?? undefined });
      memberActionFeedback = m.sc_action_applied();
      await loadMemberCase(userId);
    } catch (error) {
      memberActionIsError = true;
      memberActionFeedback = error instanceof Error ? error.message : m.sc_action_failed();
    } finally {
      memberActionBusy = false;
    }
  }

  function openCaseModal(entry: { user: string; details: string; action: string }) {
    const parsed = parseDetailsMetadata(entry.details, entry.user);
    selectedCaseUser = {
      name: displayUser(entry),
      id: parsed.extractedUserId,
    };
    selectedCaseData = null;
    selectedCaseError = '';
    memberActionReason = m.lg_action_from_log({ action: entry.action });
    memberActionDuration = '30m';
    memberActionFeedback = '';
    memberActionIsError = false;
    caseModalOpen = true;

    if (parsed.extractedUserId) {
      void loadMemberCase(parsed.extractedUserId);
    }
  }

  function closeCaseModal() {
    caseModalOpen = false;
    selectedCaseUser = null;
    selectedCaseData = null;
    selectedCaseError = '';
  }

  const sanctions = $derived((dashboardStore.state.sanctions as any[]) || []);
  const selectedCaseSanctions = $derived.by(() => {
    if (selectedCaseData?.sanctions) {
      return [...selectedCaseData.sanctions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    const userId = selectedCaseUser?.id;
    if (!userId) return [];
    return sanctions
      .filter((entry) => entry.targetUserId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  });

  const filteredLogs = $derived(
    [...discordLogs]
    .filter(log => {
      const matchesSearch = searchQuery === '' || 
        log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.details.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.module.toLowerCase().includes(searchQuery.toLowerCase()) ||
        displayUser(log).toLowerCase().includes(searchQuery.toLowerCase());
      const matchesModule = filters.modules.length === 0 || filters.modules.includes(log.module);
      const matchesAction = filters.actions.length === 0 || filters.actions.includes(log.action);
      const matchesType = filters.types.length === 0 || filters.types.includes(log.eventType);
      const matchesUser = filters.users.length === 0 || filters.users.includes(displayUser(log));
      const matchesChannel = filters.channels.length === 0 || filters.channels.includes(getLogChannelId(log) ?? '');
      return matchesSearch && matchesModule && matchesAction && matchesType && matchesUser && matchesChannel;
    })
    .sort((left, right) => {
      let result = 0;
      switch (sortField) {
        case 'date':
          result = new Date(left.dateIso).getTime() - new Date(right.dateIso).getTime();
          break;
        case 'user':
          result = displayUser(left).localeCompare(displayUser(right), 'fr');
          break;
        case 'module':
          result = left.module.localeCompare(right.module, 'fr');
          break;
        case 'action':
          result = left.action.localeCompare(right.action, 'fr');
          break;
        case 'type':
          result = left.eventType.localeCompare(right.eventType, 'fr');
          break;
      }
      return sortDirection === 'asc' ? result : -result;
    })
  );

  const logsTabs = ['logs', 'config'] as const;
  let activeTab = $state<'logs' | 'config'>('logs');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/logs', logsTabs, 'logs') as typeof activeTab;
  });

  const stats = $derived([
    { label: m.lg_discord_events(), val: discordLogs.length, sub: m.lg_total(), subClass: 'text-blue-500' },
    { label: m.nav_modules(), val: new Set(discordLogs.map(l => l.module)).size, sub: m.lg_sources(), subClass: 'text-green-600' },
    { label: m.lg_users(), val: new Set(discordLogs.map(l => l.user)).size, sub: m.lg_unique(), subClass: 'text-purple-600' }
  ]);
</script>


<ModulePage 
  title={m.lg_page_title()}
  description={m.lg_page_desc()}
  icon="List"
  featureKey="logs"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <!-- Tabs Selector -->
      <div class="inline-flex bg-surface-container-high/60 border border-outline-variant/10 rounded-lg p-1 gap-1">
        <button
          type="button"
          onclick={() => gotoTab('/logs', 'logs', 'logs')}
          class="tab-button {activeTab === 'logs' ? 'active' : ''}"
        >
          {m.lg_tab_journal()}
        </button>
        {#if canManageSettings}
          <button
            type="button"
            onclick={() => gotoTab('/logs', 'config', 'logs')}
            class="tab-button {activeTab === 'config' ? 'active' : ''}"
          >
            Configuration
          </button>
        {/if}
      </div>

      <RefreshButton
        onClick={() => dashboardStore.refresh()}
        loading={dashboardStore.state.loading}
        label="Actualiser"
        className="px-5 py-2.5 font-bold "
        iconClass="text-lg"
      />
    </div>
  {/snippet}

{#if activeTab === 'config' && canManageSettings}
<div class="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
  <!-- General Configuration -->
  <div class="bg-surface-container-low/30 p-8 rounded-xl border border-outline-variant/10 space-y-6">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
      <div class="flex items-center gap-4">
        <div class="bg-primary/10 p-3 rounded-lg text-primary">
          <Papicon icon="Settings" size={24} />
        </div>
        <div>
          <h3 class="text-sm font-semibold uppercase tracking-widest text-on-surface">{m.lg_default_channel()}</h3>
          <p class="text-xs text-on-surface-variant/70 mt-1">{m.lg_default_channel_desc()}</p>
        </div>
      </div>
      <div class="w-full md:w-72">
        <SearchableSelect bind:value={selectedLogChannelId} on:change={() => handleLogChannelChange()} options={(dashboardStore.state.discordChannels || []).map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.lg_select_channel_ph()} className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all" />
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 pt-6 border-t border-outline-variant/10">
      <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-low/50 border border-outline-variant/10">
        <div>
          <p class="text-xs font-medium text-on-surface">Journalisation</p>
          <p class="text-[11px] text-on-surface-variant/60 mt-0.5">Activer l'audit global</p>
        </div>
        <ToggleSwitch 
          checked={logsConfig?.loggingEnabled ?? true} 
          disabled={loadingConfig}
          onToggle={() => toggleConfig('loggingEnabled', !(logsConfig?.loggingEnabled ?? true))} 
        />
      </div>

      <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-low/50 border border-outline-variant/10">
        <div>
          <p class="text-xs font-medium text-on-surface">{m.lg_activity_tracking()}</p>
          <p class="text-[11px] text-on-surface-variant/60 mt-0.5">{m.lg_tracking_desc()}</p>
        </div>
        <ToggleSwitch 
          checked={logsConfig?.userActivityTracking ?? true} 
          disabled={loadingConfig}
          onToggle={() => toggleConfig('userActivityTracking', !(logsConfig?.userActivityTracking ?? true))} 
        />
      </div>

      <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-low/50 border border-outline-variant/10">
        <div>
          <p class="text-xs font-medium text-on-surface">{m.lg_channel_notifs()}</p>
          <p class="text-[11px] text-on-surface-variant/60 mt-0.5">{m.lg_channel_notifs_desc()}</p>
        </div>
        <ToggleSwitch 
          checked={logsConfig?.notifyViaDiscordChannel ?? true} 
          disabled={loadingConfig}
          onToggle={() => toggleConfig('notifyViaDiscordChannel', !(logsConfig?.notifyViaDiscordChannel ?? true))} 
        />
      </div>

      <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-low/50 border border-outline-variant/10">
        <div>
          <p class="text-xs font-medium text-on-surface">Notifs MP</p>
          <p class="text-[11px] text-on-surface-variant/60 mt-0.5">{m.lg_dm_notifs_desc()}</p>
        </div>
        <ToggleSwitch 
          checked={logsConfig?.notifyViaDM ?? false} 
          disabled={loadingConfig}
          onToggle={() => toggleConfig('notifyViaDM', !(logsConfig?.notifyViaDM ?? false))} 
        />
      </div>
    </div>
    
    {#if logsConfig}
    <div class="pt-8 border-t border-outline-variant/10">
      <RolePermissionSettings 
        featureKey="logs" 
        roleAccess={logsConfig.roleAccessByRole} 
      />
    </div>
    {/if}
  </div>

  <!-- Events Granular Configurations -->
  <div class="space-y-6">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
      <div>
        <h4 class="text-sm font-semibold uppercase tracking-widest text-on-surface">{m.lg_per_event_config()}</h4>
        <p class="text-xs text-on-surface-variant/60 mt-1">{m.lg_per_event_desc()}</p>
      </div>
    </div>

    {#if saveAction.state.message}
      <div class="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-bold rounded-lg animate-pulse">
        {saveAction.state.message}
      </div>
    {/if}

    <div class="space-y-8">
      {#each logCategories as cat}
        <div class="bg-surface-container-low/20 rounded-xl p-6 md:p-8 border border-outline-variant/5 space-y-6">
          <div class="flex items-center gap-3 border-b border-outline-variant/10 pb-4">
            <div class="text-primary bg-primary/10 p-2.5 rounded-lg">
              <Papicon icon={cat.icon} size={20} />
            </div>
            <div>
              <h5 class="text-[13px] font-medium text-on-surface">{cat.label}</h5>
              <p class="text-[10px] text-on-surface-variant/60">{m.lg_manage_category_alerts()}</p>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {#each cat.events as ev}
              {@const confIdx = eventConfigs.findIndex(c => c.eventType === ev.type)}
              {#if confIdx !== -1}
                <div class="flex flex-col justify-between p-5 rounded-xl bg-surface-container-high/10 border border-outline-variant/10 hover:border-primary/25 transition-all duration-300 space-y-4">
                  <div class="flex justify-between items-start gap-4">
                    <div class="space-y-1">
                      <p class="text-xs font-bold text-on-surface">{ev.label}</p>
                      <p class="text-[10px] text-on-surface-variant/60 leading-relaxed">{ev.desc}</p>
                    </div>
                    <ToggleSwitch 
                      checked={eventConfigs[confIdx].enabled}
                      onToggle={(v: boolean) => {
                        eventConfigs[confIdx].enabled = v;
                        eventConfigs = [...eventConfigs];
                      }}
                    />
                  </div>

                  {#if eventConfigs[confIdx].enabled}
                    <div class="space-y-1.5 pt-3 border-t border-outline-variant/10">
                      <label for="select-{ev.type}" class="text-[11px] font-bold text-on-surface-variant/60 uppercase tracking-wider">{m.lg_dest_channel()}</label>
                      <select
                        id="select-{ev.type}"
                        bind:value={eventConfigs[confIdx].channelId}
                        class="w-full bg-surface-container-high/40 text-xs px-3 py-2 rounded-xl border border-outline-variant/10 focus:ring-1 focus:ring-primary/20 transition-all outline-none"
                      >
                        <option value={null}>{m.lg_default_log_channel()}</option>
                        {#each dashboardStore.state.discordChannels as c}
                          <option value={c.id}>#{c.name}</option>
                        {/each}
                      </select>
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>
{/if}

{#if activeTab === 'logs'}
<div class="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
  <!-- Search & Filter Options -->
  <div class="bg-surface-container-low/20 p-6 rounded-xl border border-outline-variant/5 space-y-4">
    <div class="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
      <div class="space-y-2 w-full lg:max-w-2xl">
        <label class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest ml-1" for="search">{m.lg_quick_search()}</label>
        <div class="relative top-1.5">
          <Papicon icon="search" size={18} class="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <FormInput
            id="search"
            type="text"
            bind:value={searchQuery}
            placeholder={m.lg_search_ph()}
            className="w-full pl-11 pr-4 py-3 bg-surface-container-low border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 transition-all outline-none"
          />
        </div>
      </div>

      <div class="flex items-center gap-3 self-end lg:self-center">
        <span class="text-xs font-bold text-on-surface-variant bg-surface-container-high/40 px-3 py-1.5 rounded-full">{m.lg_events_count({ a: filteredLogs.length, b: discordLogs.length })}</span>
        {#if hasActiveFiltersOrSort}
          <button
            type="button"
            onclick={resetFiltersAndSort}
            class="text-xs font-semibold text-primary hover:underline transition"
          >
            {m.common_reset()}
          </button>
        {/if}
      </div>
    </div>
  </div>

  <!-- Audit Table -->
  <div class="section-card-flush rounded-xl border border-outline-variant/10 overflow-hidden bg-surface-container-low/20">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-high/30 border-b border-outline-variant/10">
            <th class="px-6 py-5">
              <ColumnSortFilter
                label="Heure"
                sortDirection={sortDirectionFor('date')}
                onToggleSort={() => toggleSort('date')}
              />
            </th>
            <th class="px-6 py-5">
              <ColumnSortFilter
                label={m.lg_col_actor()}
                sortDirection={sortDirectionFor('user')}
                onToggleSort={() => toggleSort('user')}
                options={userFilterOptions}
                selectedValues={filters.users}
                onToggleValue={(value) => toggleFilter('users', value)}
                searchable={true}
              />
            </th>
            <th class="px-6 py-5">
              <ColumnSortFilter
                label={m.lg_col_channel()}
                options={channelFilterOptions}
                selectedValues={filters.channels}
                onToggleValue={(value) => toggleFilter('channels', value)}
                searchable={true}
              />
            </th>
            <th class="px-6 py-5">
              <ColumnSortFilter
                label={m.lg_col_category()}
                sortDirection={sortDirectionFor('module')}
                onToggleSort={() => toggleSort('module')}
                options={moduleFilterOptions}
                selectedValues={filters.modules}
                onToggleValue={(value) => toggleFilter('modules', value)}
              />
            </th>
            <th class="px-6 py-5">
              <ColumnSortFilter
                label="Action"
                sortDirection={sortDirectionFor('action')}
                onToggleSort={() => toggleSort('action')}
                options={actionFilterOptions}
                selectedValues={filters.actions}
                onToggleValue={(value) => toggleFilter('actions', value)}
                searchable={true}
              />
            </th>
            <th class="px-6 py-5 text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.lg_col_details()}</th>
            <th class="px-6 py-5">
              <div class="flex justify-center">
                <ColumnSortFilter
                  label="Type"
                  sortDirection={sortDirectionFor('type')}
                  onToggleSort={() => toggleSort('type')}
                  options={typeFilterOptions}
                  selectedValues={filters.types}
                  onToggleValue={(value) => toggleFilter('types', value)}
                />
              </div>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/10">
          {#each filteredLogs as entry}
            {@const parsed = parseDetailsStructure(entry.details)}
            <tr class="hover:bg-surface-container-low transition-colors group">
              <td class="px-6 py-5">
                <div class="text-xs">
                  <p class="font-bold text-on-surface">{new Date(entry.dateIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                  <p class="text-[10px] text-on-surface-variant/60 font-medium">{new Date(entry.dateIso).toLocaleDateString()}</p>
                </div>
              </td>
              <td class="px-6 py-5">
                <button
                  type="button"
                  onclick={() => openCaseModal(entry)}
                  class="inline-flex max-w-40 truncate rounded-full border border-outline-variant/10 bg-surface-container-high/40 px-3 py-1 text-[11px] font-bold text-on-surface-variant hover:border-primary/50 hover:text-primary transition-all"
                  title={m.lg_open_case()}
                >
                  {displayUser(entry)}
                </button>
              </td>
              <td class="px-6 py-5 max-w-xs">
                <span class="text-xs text-on-surface-variant/80">
                  {formatChannelLabel(getLogChannelId(entry))}
                </span>
              </td>
              <td class="px-6 py-5 font-bold text-xs text-primary uppercase tracking-wider">
                {entry.module}
              </td>
              <td class="px-6 py-5 font-bold text-xs text-on-surface">
                {entry.action}
              </td>
              <td class="px-6 py-5 max-w-sm">
                <div class="space-y-2">
                  {#if parsed.badges.length > 0}
                    <div class="flex flex-wrap gap-1.5">
                      {#each parsed.badges as item}
                        {#if item.key}
                          <div class="inline-flex items-center gap-1 bg-surface-container-high border border-outline-variant/10 rounded-lg px-2 py-0.5 text-[10px] text-on-surface-variant font-medium">
                            <span class="text-on-surface-variant/70 font-semibold">{item.key}:</span>
                            <span class="text-on-surface break-all">{@html item.value}</span>
                          </div>
                        {:else}
                          <div class="inline-flex items-center bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-2 py-0.5 text-[10px] text-on-surface-variant break-all">
                            {@html item.value}
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                  {#each parsed.blocks as block}
                    <div class="bg-surface-container-low border-l-2 border-primary/50 rounded-r-lg px-3 py-1.5 text-xs text-on-surface-variant space-y-0.5 max-w-full overflow-hidden">
                      <p class="text-[11px] font-semibold uppercase tracking-wider text-primary/80">{block.key}</p>
                      <p class="break-all whitespace-pre-wrap leading-relaxed text-on-surface">{@html block.value}</p>
                    </div>
                  {/each}
                </div>
              </td>
              <td class="px-6 py-5 text-center">
                <span class="inline-flex items-center justify-center w-24 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider
 {entry.eventType === 'Automatique' ? 'bg-blue-500/10 text-blue-500' : 'bg-amber-500/10 text-amber-500'}">
                  {entry.eventType}
                </span>
              </td>
            </tr>
          {/each}

          {#if filteredLogs.length === 0}
            <tr>
              <td colspan="7" class="px-6 py-20 text-center text-on-surface-variant opacity-60">
                <div class="flex flex-col items-center justify-center">
                  <Papicon icon="Info" size={40} class="mb-3 text-on-surface-variant/40" />
                  <p class="text-sm font-bold">{m.lg_no_events()}</p>
                  <p class="text-xs text-on-surface-variant/60 mt-1">{m.lg_no_events_hint()}</p>
                </div>
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  <!-- KPI summary -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
    {#each stats as kpi}
      <div class="bg-surface-container-low/40 p-6 rounded-xl border border-outline-variant/10 hover:shadow-lg transition-all duration-300">
        <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">{kpi.label}</p>
        <div class="flex items-end justify-between mt-2">
          <p class="text-lg font-semibold text-on-surface">{kpi.val}</p>
          <span class="text-[10px] font-bold {kpi.subClass}">{kpi.sub}</span>
        </div>
      </div>
    {/each}
  </div>
</div>
{/if}

{#if caseModalOpen && selectedCaseUser}
  <MemberCaseModal 
    open={caseModalOpen}
    userId={selectedCaseUser?.id}
    caseData={selectedCaseData}
    loading={selectedCaseLoading}
    error={selectedCaseError}
    actionReason={memberActionReason}
    actionDuration={memberActionDuration}
    actionBusy={memberActionBusy}
    actionFeedback={memberActionFeedback}
    actionIsError={memberActionIsError}
    onAction={executeMemberAction}
    onClose={closeCaseModal}
    onSelectUser={(userId) => {
      selectedCaseUser = { name: m.common_loading(), id: userId };
      void loadMemberCase(userId);
    }}
  />
{/if}

</ModulePage>

