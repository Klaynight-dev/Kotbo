<script lang="ts">
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { notificationsStore } from '../lib/stores/notifications.svelte';
  import { staffStore } from '../lib/stores/staff.svelte';
  import { fetchAnalytics, fetchUserSettings, updateUserSettings, fetchChangelog, fetchStaffServerLinks, fetchGuildLanguage, updateGuildLanguage, fetchGuildTimezone, updateGuildTimezone, fetchHomeWidgets } from '../lib/api';
  import type { ChangelogCommit, GuildLanguageState, GuildTimezoneState, HomeWidgetsData, HomeWidgetSection } from '../lib/api';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import { isMobile } from '../lib/stores/media.svelte';

  interface LayoutItem {
    id: string;
    colSpan: number;
    rowSpan: number;
    visible: boolean;
  }

  const DEFAULT_LAYOUT: LayoutItem[] = [
    { id: 'liveStats', colSpan: 3, rowSpan: 1, visible: true },
    { id: 'analytics', colSpan: 2, rowSpan: 1, visible: true },
    { id: 'system', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'channels', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'moderation', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'members', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'notifications', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'staff', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'audit', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'botLanguage', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'timezone', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'actions', colSpan: 3, rowSpan: 1, visible: true },
  ];

  const MODULE_CATALOG = [
    { id: 'liveStats', title: m.home_mod_livestats_title(), desc: m.home_mod_livestats_desc(), icon: 'users' },
    { id: 'analytics', title: m.home_mod_analytics_title(), desc: m.home_mod_analytics_desc(), icon: 'trending-up' },
    { id: 'system', title: m.home_mod_system_title(), desc: m.home_mod_system_desc(), icon: 'cpu' },
    { id: 'channels', title: m.home_mod_channels_title(), desc: m.home_mod_channels_desc(), icon: 'hash' },
    { id: 'moderation', title: m.home_mod_moderation_title(), desc: m.home_mod_moderation_desc(), icon: 'shield' },
    { id: 'members', title: m.home_mod_members_title(), desc: m.home_mod_members_desc(), icon: 'award' },
    { id: 'notifications', title: m.home_mod_notifications_title(), desc: m.home_mod_notifications_desc(), icon: 'inbox' },
    { id: 'staff', title: m.home_mod_staff_title(), desc: m.home_mod_staff_desc(), icon: 'users' },
    { id: 'audit', title: m.home_mod_audit_title(), desc: m.home_mod_audit_desc(), icon: 'activity' },
    { id: 'botLanguage', title: m.home_mod_botlanguage_title(), desc: m.home_mod_botlanguage_desc(), icon: 'globe' },
    { id: 'timezone', title: m.home_mod_timezone_title(), desc: m.home_mod_timezone_desc(), icon: 'clock' },
    { id: 'actions', title: m.home_mod_actions_title(), desc: m.home_mod_actions_desc(), icon: 'plus-circle' },
    { id: 'notes', title: m.home_mod_notes_title(), desc: m.home_mod_notes_desc(), icon: 'edit' },
    { id: 'serverInfo', title: m.home_mod_serverinfo_title(), desc: m.home_mod_serverinfo_desc(), icon: 'server' },
    { id: 'botHosting', title: m.home_mod_bothosting_title(), desc: m.home_mod_bothosting_desc(), icon: 'cpu' },
    { id: 'news', title: m.home_mod_news_title(), desc: m.home_mod_news_desc(), icon: 'book' },
    { id: 'quickGuide', title: m.home_mod_quickguide_title(), desc: m.home_mod_quickguide_desc(), icon: 'info' },
    { id: 'clockWeather', title: m.home_mod_clockweather_title(), desc: m.home_mod_clockweather_desc(), icon: 'clock' },
    { id: 'economy', title: m.home_mod_economy_title(), desc: m.home_mod_economy_desc(), icon: 'dollar-sign' },
    { id: 'leveling', title: m.home_mod_leveling_title(), desc: m.home_mod_leveling_desc(), icon: 'bar-chart-2' },
    { id: 'tickets', title: m.home_mod_tickets_title(), desc: m.home_mod_tickets_desc(), icon: 'message-square' },
    { id: 'invites', title: m.home_mod_invites_title(), desc: m.home_mod_invites_desc(), icon: 'user-plus' },
    { id: 'events', title: m.home_mod_events_title(), desc: m.home_mod_events_desc(), icon: 'calendar' },
    { id: 'polls', title: m.home_mod_polls_title(), desc: m.home_mod_polls_desc(), icon: 'bar-chart' },
    { id: 'staffServer', title: m.home_mod_staffserver_title(), desc: m.home_mod_staffserver_desc(), icon: 'shield' },
  ];

  let isEditing = $state(false);
  let showAddModuleModal = $state(false);
  let showResetConfirm = $state(false);
  let showPresetsModal = $state(false);
  let userLayout = $state<LayoutItem[]>([]);
  let dragOverIndex = $state<number | null>(null);
  let resizing = $state<{ id: string; axis: 'col' | 'row'; startX: number; startY: number; startSpan: number } | null>(null);
  let presets = $state<any[]>([]);
  let presetName = $state('');
  let presetDescription = $state('');
  let loadingPresets = $state(false);
  let presetImportJson = $state('');
  let changelogCommits = $state<ChangelogCommit[]>([]);
  let changelogLoading = $state(false);

  function getStorageKey(): string {
    const guildId = authStore.selectedGuildId || 'default';
    const userId = authStore.user?.id || 'default';
    return `bento_layout_${guildId}_${userId}`;
  }

  function ensureRowSpan(items: LayoutItem[]): LayoutItem[] {
    return items.map(item => ({ ...item, rowSpan: item.rowSpan || 1 }));
  }

  function completeLayout(items: LayoutItem[]): LayoutItem[] {
    const parsed = ensureRowSpan(items);
    const existingIds = new Set(parsed.map(item => item.id));
    const missingModules: LayoutItem[] = MODULE_CATALOG
      .filter(m => !existingIds.has(m.id))
      .map(m => ({ id: m.id, colSpan: 1, rowSpan: 1, visible: false }));
    return [...parsed, ...missingModules];
  }

  function defaultLayout(): LayoutItem[] {
    return completeLayout(DEFAULT_LAYOUT);
  }

  function loadLocalLayout(): LayoutItem[] {
    const key = getStorageKey();
    const saved = localStorage.getItem(key);

    if (saved) {
      try {
        return completeLayout(JSON.parse(saved) as LayoutItem[]);
      } catch (e) {
        console.error("Failed to parse saved layout, using default", e);
      }
    }

    return defaultLayout();
  }

  async function loadLayout() {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;

    // Le cache local permet de peindre la grille immédiatement. La version DB
    // est ensuite appliquée silencieusement dès qu'elle arrive.
    userLayout = loadLocalLayout();

    try {
      const data = await fetchUserSettings();
      if (authStore.selectedGuildId === guildId && data?.bentoLayout) {
        userLayout = completeLayout(data.bentoLayout as LayoutItem[]);
        localStorage.setItem(getStorageKey(), JSON.stringify(userLayout));
      }
    } catch (e) {
      console.warn("Failed to refresh layout from DB, keeping local layout", e);
    }
  }

  async function saveLayout() {
    // Save to DB
    try {
      await updateUserSettings({ bentoLayout: userLayout });
    } catch (e) {
      console.error("Failed to save layout to DB", e);
    }

    // Save to localStorage as redundancy
    const key = getStorageKey();
    localStorage.setItem(key, JSON.stringify(userLayout));
    
    isEditing = false;
    toast.success(m.home_layout_saved());
  }

  async function resetLayout() {
    const defaultIds = new Set(DEFAULT_LAYOUT.map(item => item.id));
    const hiddenItems: LayoutItem[] = MODULE_CATALOG
      .filter(m => !defaultIds.has(m.id))
      .map(m => ({
        id: m.id,
        colSpan: 1,
        rowSpan: 1,
        visible: false
      }));
    userLayout = [...DEFAULT_LAYOUT, ...hiddenItems];
    
    // Reset in DB
    try {
      await updateUserSettings({ bentoLayout: null });
    } catch (e) {
      console.error("Failed to reset layout in DB", e);
    }

    showResetConfirm = false;
    isEditing = false;
    
    // Reset in localStorage
    const key = getStorageKey();
    localStorage.removeItem(key);
    
    toast.success(m.home_layout_reset());
  }

  function toggleSize(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        let nextSpan = 1;
        if (item.colSpan === 1) nextSpan = 2;
        else if (item.colSpan === 2) nextSpan = 3;
        return { ...item, colSpan: nextSpan };
      }
      return item;
    });
  }

  function hideModule(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        return { ...item, visible: false };
      }
      return item;
    });
  }

  function addModule(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        return { ...item, visible: true, rowSpan: item.rowSpan || 1 };
      }
      return item;
    });
    toast.success(m.home_module_added());
  }

  function moveModule(index: number, direction: number) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= userLayout.length) return;
    const items = [...userLayout];
    const temp = items[index];
    items[index] = items[targetIndex];
    items[targetIndex] = temp;
    userLayout = items;
  }

  function toggleRowSize(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        let nextRowSpan = 1;
        if (item.rowSpan === 1) nextRowSpan = 2;
        else if (item.rowSpan === 2) nextRowSpan = 3;
        return { ...item, rowSpan: nextRowSpan };
      }
      return item;
    });
  }

  // HTML5 Drag & Drop handlers
  let draggedIndex = $state<number | null>(null);

  function handleDragStart(e: DragEvent, index: number) {
    draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
    const target = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => target.classList.add('opacity-40', 'scale-95'));
  }

  function handleDragEnd(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove('opacity-40', 'scale-95');
    draggedIndex = null;
    dragOverIndex = null;
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      dragOverIndex = index;
    }
  }

  function handleDragLeave(e: DragEvent) {
    dragOverIndex = null;
  }

  function handleDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    const items = [...userLayout];
    const [removed] = items.splice(draggedIndex, 1);
    items.splice(targetIndex, 0, removed);
    userLayout = items;
    draggedIndex = null;
    dragOverIndex = null;
  }

  // Border resize handlers
  function handleResizeStart(e: MouseEvent, itemId: string, axis: 'col' | 'row') {
    e.preventDefault();
    e.stopPropagation();
    const item = userLayout.find(i => i.id === itemId);
    if (!item) return;
    resizing = {
      id: itemId,
      axis,
      startX: e.clientX,
      startY: e.clientY,
      startSpan: axis === 'col' ? item.colSpan : (item.rowSpan || 1)
    };
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  }

  function handleResizeMove(e: MouseEvent) {
    if (!resizing) return;
    const { id, axis, startX, startY, startSpan } = resizing;
    const delta = axis === 'col' ? e.clientX - startX : e.clientY - startY;
    const cellSize = axis === 'col' ? 280 : 200;
    const spanDelta = Math.round(delta / cellSize);
    const newSpan = Math.max(1, Math.min(3, startSpan + spanDelta));
    userLayout = userLayout.map((item) => {
      if (item.id === id) {
        return axis === 'col' ? { ...item, colSpan: newSpan } : { ...item, rowSpan: newSpan };
      }
      return item;
    });
  }

  function handleResizeEnd() {
    resizing = null;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
  }

  // Preset management
  async function loadPresets() {
    loadingPresets = true;
    try {
      const { fetchLayoutPresets } = await import('../lib/api');
      presets = await fetchLayoutPresets();
    } catch (e) {
      console.error("Failed to load presets", e);
    } finally {
      loadingPresets = false;
    }
  }

  async function saveAsPreset() {
    if (!presetName.trim()) { toast.error(m.home_name_required()); return; }
    try {
      const { createLayoutPreset } = await import('../lib/api');
      const visible = userLayout.filter(i => i.visible);
      const preset = await createLayoutPreset({ name: presetName.trim(), description: presetDescription.trim(), layout: visible });
      if (preset) {
        presets = [preset, ...presets];
        presetName = '';
        presetDescription = '';
        toast.success(m.home_preset_saved());
      }
    } catch (e) {
      toast.error(m.home_preset_save_error());
    }
  }

  async function applyPreset(presetId: string) {
    try {
      const { applyLayoutPreset } = await import('../lib/api');
      const layout = await applyLayoutPreset(presetId);
      if (layout) {
        const parsed = ensureRowSpan(layout as LayoutItem[]);
        const existingIds = new Set(parsed.map(item => item.id));
        const missingModules: LayoutItem[] = MODULE_CATALOG
          .filter(m => !existingIds.has(m.id))
          .map(m => ({ id: m.id, colSpan: 1, rowSpan: 1, visible: false }));
        userLayout = [...parsed, ...missingModules];
        showPresetsModal = false;
        toast.success(m.home_preset_applied());
      }
    } catch (e) {
      toast.error(m.home_preset_apply_error());
    }
  }

  async function removePreset(presetId: string) {
    try {
      const { deleteLayoutPreset } = await import('../lib/api');
      const ok = await deleteLayoutPreset(presetId);
      if (ok) presets = presets.filter(p => p.id !== presetId);
    } catch (e) {
      toast.error(m.home_delete_error());
    }
  }

  async function sharePreset(presetId: string) {
    try {
      const { shareLayoutPreset } = await import('../lib/api');
      const result = await shareLayoutPreset(presetId);
      if (result?.shareToken) {
        const url = `${window.location.origin}/?importPreset=${result.shareToken}`;
        await navigator.clipboard.writeText(url);
        toast.success(m.home_link_copied());
      }
    } catch (e) {
      toast.error(m.home_share_error());
    }
  }

  function exportPreset(preset: any) {
    const data = JSON.stringify({ name: preset.name, description: preset.description || '', layout: preset.layout }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `preset-${preset.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(m.home_preset_exported());
  }

  async function importPresetFromJson() {
    if (!presetImportJson.trim()) return;
    try {
      const parsed = JSON.parse(presetImportJson);
      if (!parsed.name || !parsed.layout) { toast.error(m.home_invalid_format()); return; }
      const { importLayoutPreset } = await import('../lib/api');
      const preset = await importLayoutPreset({ name: parsed.name, description: parsed.description || m.home_imported_label(), layout: parsed.layout });
      if (preset) {
        presets = [preset, ...presets];
        presetImportJson = '';
        toast.success(m.home_preset_imported());
      }
    } catch (e) {
      toast.error(m.home_json_import_error());
    }
  }

  function exportCurrentLayout() {
    const visible = userLayout.filter(i => i.visible);
    const data = JSON.stringify({ name: m.home_my_layout(), description: m.home_current_export(), layout: visible }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'layout-courant.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success(m.home_layout_exported());
  }

  // Staff notes logic
  let staffNotes = $state('');

  function loadStaffNotes() {
    const guildId = authStore.selectedGuildId || 'default';
    const savedNotes = localStorage.getItem(`staff_notes_${guildId}`);
    staffNotes = savedNotes || '';
  }

  function saveStaffNotes(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    staffNotes = target.value;
    const guildId = authStore.selectedGuildId || 'default';
    localStorage.setItem(`staff_notes_${guildId}`, staffNotes);
  }

  function formatRelativeDate(isoDate: string): string {
    const diff = Date.now() - new Date(isoDate).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return m.home_rel_now();
    if (minutes < 60) return m.home_rel_min({ n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return m.home_rel_hours({ n: hours });
    const days = Math.floor(hours / 24);
    if (days === 1) return m.home_rel_yesterday();
    if (days < 30) return m.home_rel_days({ n: days });
    return new Date(isoDate).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  }

  // Clock & Weather logic
  let currentTime = $state('');
  let currentDate = $state('');

  // Alimente aussi l'apercu du fuseau : un second intervalle pour la meme
  // horloge ferait deux reveils par seconde pour rien.
  let clockTick = $state(Date.now());

  function updateDateTime() {
    const now = new Date();
    clockTick = now.getTime();
    currentTime = now.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    currentDate = now.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Widget "Serveur Staff" - état du lien de la paire
  const SYNC_MODE_LABELS: Record<string, string> = {
    MAIN_TO_STAFF: m.home_sync_main_to_staff(),
    STAFF_TO_MAIN: m.home_sync_staff_to_main(),
    BIDIRECTIONAL: m.home_sync_bidirectional(),
  };
  let staffServerLinks = $state<any[]>([]);
  let staffLinksGuildId: string | null = null;

  async function loadStaffServerLinks() {
    const guildId = authStore.selectedGuildId;
    if (!guildId || staffLinksGuildId === guildId) return;
    staffLinksGuildId = guildId;
    try {
      const data = await fetchStaffServerLinks();
      if (authStore.selectedGuildId === guildId) {
        staffServerLinks = Array.isArray(data) ? data : [];
      }
    } catch {
      staffLinksGuildId = null;
      staffServerLinks = [];
    }
  }

  $effect(() => {
    if (authStore.selectedGuildId) {
      loadLayout();
      loadStaffNotes();
      handleImportFromUrl();
    }
  });

  let changelogLoaded = false;

  async function loadChangelog() {
    if (changelogLoaded || changelogLoading) return;
    changelogLoading = true;
    try {
      changelogCommits = await fetchChangelog(10);
      changelogLoaded = true;
    } catch {
      changelogCommits = [];
    } finally {
      changelogLoading = false;
    }
  }

  async function handleImportFromUrl() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('importPreset');
    if (!token) return;
    try {
      const { fetchSharedLayoutPreset, importLayoutPreset } = await import('../lib/api');
      const shared = await fetchSharedLayoutPreset(token);
      if (shared?.layout) {
        const preset = await importLayoutPreset({ name: shared.name, description: shared.description || m.home_imported_via_link(), layout: shared.layout as any[] });
        if (preset) {
          const parsed = ensureRowSpan(shared.layout as LayoutItem[]);
          const existingIds = new Set(parsed.map(item => item.id));
          const missingModules: LayoutItem[] = MODULE_CATALOG
            .filter(m => !existingIds.has(m.id))
            .map(m => ({ id: m.id, colSpan: 1, rowSpan: 1, visible: false }));
          userLayout = [...parsed, ...missingModules];
          toast.success(m.home_preset_imported_applied({ name: shared.name }));
        }
      }
    } catch (e) {
      console.warn("Failed to import preset from URL", e);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }

  let timerInterval: any;
  $effect(() => {
    updateDateTime();
    timerInterval = setInterval(updateDateTime, 1000);
    return () => {
      clearInterval(timerInterval);
    };
  });

  function getSpanStyle(colSpan: number, rowSpan: number): string {
    const parts: string[] = [];
    if (colSpan === 2) parts.push('grid-column: span 2');
    else if (colSpan === 3) parts.push('grid-column: span 3');
    if (rowSpan >= 2) parts.push(`grid-row: span ${rowSpan}`);
    return parts.join('; ');
  }

  function displayColSpan(item: LayoutItem): number {
    return $isMobile ? 1 : item.colSpan;
  }

  function displayRowSpan(item: LayoutItem): number {
    return $isMobile ? 1 : (item.rowSpan || 1);
  }

  function getColSpanClass(colSpan: number): string {
    if (colSpan === 2) return "md:col-span-2";
    if (colSpan === 3) return "md:col-span-2 lg:col-span-3";
    return "col-span-1";
  }

  function getRowSpanClass(rowSpan: number): string {
    if (rowSpan === 2) return "row-span-2";
    if (rowSpan === 3) return "row-span-3";
    return "";
  }

  const COMPACT_MODULES = new Set(['actions', 'liveStats', 'clockWeather']);

  function getModuleMinHeight(id: string): string {
    if (COMPACT_MODULES.has(id)) return 'min-h-[80px]';
    return 'min-h-[180px]';
  }

  function getListCount(baseCount: number, colSpan: number, rowSpan: number): number {
    let count = baseCount;
    if (rowSpan >= 3) count += 6;
    else if (rowSpan >= 2) count += 3;
    if (colSpan >= 2) count += 2;
    return count;
  }

  let analyticsData = $state<any>(null);
  let analyticsLoading = $state(false);
  let analyticsGuildId: string | null = null;

  async function loadAnalytics(force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || analyticsLoading || (!force && analyticsGuildId === guildId)) return;
    analyticsLoading = true;
    try {
      analyticsData = await fetchAnalytics({ period: 7 });
      if (authStore.selectedGuildId === guildId) analyticsGuildId = guildId;
    } catch {
      analyticsData = null;
    } finally {
      analyticsLoading = false;
    }
  }

  let botLanguage = $state<GuildLanguageState | null>(null);
  let botLanguageLoading = $state(false);
  let botLanguageRerender = $state<GuildLanguageState['rerender']>(null);
  let botLanguageGuildId: string | null = null;

  async function loadBotLanguage(force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || botLanguageLoading || (!force && botLanguageGuildId === guildId)) return;
    botLanguageLoading = true;
    try {
      botLanguage = await fetchGuildLanguage();
      if (authStore.selectedGuildId === guildId) botLanguageGuildId = guildId;
    } finally {
      botLanguageLoading = false;
    }
  }

  async function setBotLanguage(payload: { mode: 'auto' } | { language: 'fr' | 'en' }) {
    if (botLanguageLoading) return;
    botLanguageLoading = true;
    botLanguageRerender = null;
    try {
      const state = await updateGuildLanguage(payload);
      if (state) {
        botLanguage = state;
        botLanguageRerender = state.rerender;
      }
    } catch {
      // dashboardRequest a deja notifie l'echec.
    } finally {
      botLanguageLoading = false;
    }
  }

  const botLanguageLabel = (code: 'fr' | 'en') =>
    code === 'fr' ? m.home_botlanguage_fr() : m.home_botlanguage_en();

  let timezone = $state<GuildTimezoneState | null>(null);
  let timezoneLoading = $state(false);
  let timezoneGuildId: string | null = null;

  async function loadTimezone(force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || timezoneLoading || (!force && timezoneGuildId === guildId)) return;
    timezoneLoading = true;
    try {
      timezone = await fetchGuildTimezone();
      if (authStore.selectedGuildId === guildId) timezoneGuildId = guildId;
    } finally {
      timezoneLoading = false;
    }
  }

  async function setTimezone(value: string) {
    if (timezoneLoading || !timezone || value === timezone.timezone) return;
    timezoneLoading = true;
    try {
      const state = await updateGuildTimezone(value);
      if (state) {
        timezone = state;
        // Home tient son propre etat pour la liste des fuseaux ; le store
        // partage sert aux formulaires ailleurs. Sans cette synchro, changer
        // le fuseau depuis l'accueil sans recharger laisserait Meetings et
        // Planning saisir dans l'ancien.
        timezoneStore.apply(state.timezone);
      }
    } catch {
      // dashboardRequest a deja notifie l'echec.
    } finally {
      timezoneLoading = false;
    }
  }

  const timezonePreview = $derived.by(() => {
    if (!timezone) return '';
    try {
      return new Intl.DateTimeFormat(dateLocale(), {
        timeZone: timezone.timezone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(clockTick));
    } catch {
      return '';
    }
  });

  const WIDGET_SECTIONS: Record<string, HomeWidgetSection> = {
    leveling: 'leveling',
    invites: 'invites',
    economy: 'economy',
    tickets: 'tickets',
    events: 'events',
    polls: 'polls',
    serverInfo: 'serverInfo',
    quickGuide: 'quickGuide',
    botHosting: 'hosting',
  };

  let homeWidgets = $state<HomeWidgetsData | null>(null);
  let homeWidgetsLoading = $state(false);
  let homeWidgetsKey: string | null = null;
  let homeWidgetsGuildId: string | null = null;

  function sectionsFor(visibleIds: Set<string>): HomeWidgetSection[] {
    return Object.entries(WIDGET_SECTIONS)
      .filter(([id]) => visibleIds.has(id))
      .map(([, section]) => section);
  }

  async function loadHomeWidgets(sections: HomeWidgetSection[], force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || sections.length === 0) return;

    if (homeWidgetsGuildId !== guildId) {
      homeWidgets = null;
      homeWidgetsGuildId = guildId;
    }

    const key = `${guildId}:${[...sections].sort().join(',')}`;
    if (homeWidgetsLoading || (!force && homeWidgetsKey === key)) return;

    homeWidgetsLoading = true;
    try {
      const data = await fetchHomeWidgets(sections);
      if (authStore.selectedGuildId !== guildId) return;
      homeWidgets = data;
      homeWidgetsKey = key;
    } catch {
      homeWidgets = null;
      homeWidgetsKey = null;
    } finally {
      homeWidgetsLoading = false;
    }
  }

  function formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    if (days >= 1) return m.home_uptime_days({ n: days });
    const hours = Math.floor(seconds / 3600);
    if (hours >= 1) return m.home_uptime_hours({ n: hours });
    return m.home_uptime_minutes({ n: Math.max(1, Math.floor(seconds / 60)) });
  }

  function formatMemory(megabytes: number): string {
    if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
    return `${megabytes} MB`;
  }

  function formatEventDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    const visibleIds = new Set(userLayout.filter((item) => item.visible).map((item) => item.id));
    if (!guildId || visibleIds.size === 0) return;

    // L'état léger de la page d'accueil doit garder la priorité sur ces
    // widgets secondaires. Les déclencher pendant le premier rendu mettait
    // immédiatement 5 à 8 requêtes en concurrence avec la requête critique.
    const loadSecondaryWidgets = () => {
      if (authStore.selectedGuildId !== guildId) return;
      if (['liveStats', 'analytics', 'channels', 'moderation', 'members'].some((id) => visibleIds.has(id))) {
        void loadAnalytics();
      }
      if (visibleIds.has('staff')) void staffStore.fetchAll();
      if (visibleIds.has('news')) void loadChangelog();
      if (visibleIds.has('staffServer')) void loadStaffServerLinks();
      if (visibleIds.has('botLanguage')) void loadBotLanguage();
      if (visibleIds.has('timezone')) void loadTimezone();
      void loadHomeWidgets(sectionsFor(visibleIds));
    };

    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(loadSecondaryWidgets, { timeout: 1_500 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(loadSecondaryWidgets, 250);
    return () => globalThis.clearTimeout(timeoutId);
  });

  const activeModulesCount = $derived(dashboardStore.state.modules.filter(m => m.status === 'active').length);
  const totalModulesCount = $derived(dashboardStore.state.modules.length);
  const errorModulesCount = $derived(dashboardStore.state.modules.filter(m => m.status === 'error').length);
  const errorModules = $derived(dashboardStore.state.modules.filter(m => m.status === 'error'));

  const pendingAbsences = $derived(staffStore.pendingAbsences);

  const dynamicGreeting = $derived.by(() => {
    const name = authStore.user?.username || m.home_manager();
    const hour = new Date().getHours();
    if (hour >= 18) return m.home_greeting_evening({ name });
    if (hour >= 12) return m.home_greeting_afternoon({ name });
    return m.home_greeting_morning({ name });
  });

  const dynamicSubtitle = $derived.by(() => {
    const guildName = dashboardStore.state.guildName || m.home_your_server();
    const parts: string[] = [];
    if (errorModulesCount > 0) parts.push(m.home_modules_error_count({ n: errorModulesCount }));
    if (notificationsStore.unreadCount > 0) parts.push(m.home_notifications_count({ n: notificationsStore.unreadCount }));
    if (parts.length > 0) return m.home_subtitle_issues({ parts: parts.join(' · '), guild: guildName });
    return m.home_all_good({ guild: guildName });
  });

  // Chart data from analytics
  let selectedStat = $state('messages');

  $effect(() => {
    if (authStore.selectedGuildId && authStore.user?.id) {
      const saved = localStorage.getItem(`fav_stat_${authStore.selectedGuildId}_${authStore.user.id}`);
      if (saved) selectedStat = saved;
    }
  });

  const handleStatChange = (stat: string) => {
    selectedStat = stat;
    if (authStore.selectedGuildId && authStore.user?.id) {
      localStorage.setItem(`fav_stat_${authStore.selectedGuildId}_${authStore.user.id}`, stat);
    }
  };

  const statConfig = $derived.by(() => {
    const trend = analyticsData?.dailyTrend || [];
    switch (selectedStat) {
      case 'voice':
        return { title: m.home_stat_voice_title(), subtitle: m.home_stat_voice_sub(), color: 'var(--color-secondary)', values: trend.map(d => d.voiceMinutes || 0), unit: ' min' };
      case 'joins':
        return { title: m.home_stat_joins_title(), subtitle: m.home_stat_joins_sub(), color: 'var(--color-primary)', values: trend.map(d => d.membersJoined || 0), unit: '' };
      case 'leaves':
        return { title: m.home_stat_leaves_title(), subtitle: m.home_stat_leaves_sub(), color: 'rgb(239, 68, 68)', values: trend.map(d => d.membersLeft || 0), unit: '' };
      case 'sanctions':
        return { title: m.nav_sanctions(), subtitle: m.home_stat_sanctions_sub(), color: 'rgb(245, 158, 11)', values: trend.map(d => d.sanctions || 0), unit: '' };
      default:
        return { title: 'Messages', subtitle: m.home_stat_messages_sub(), color: 'var(--color-tertiary)', values: trend.map(d => d.messages || 0), unit: '' };
    }
  });

  const activityData = $derived(
    (analyticsData?.dailyTrend || []).map((d, i) => ({
      name: formatDateLabel(d.dateKey),
      value: statConfig.values[i] || 0
    }))
  );

  function formatDateLabel(dateKey: string): string {
    try {
      const d = new Date(dateKey + 'T12:00:00Z');
      return d.toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric' });
    } catch {
      return `J-${dateKey}`;
    }
  }

  const statTotal = $derived(statConfig.values.reduce((a, b) => a + b, 0));

  // Live stats from analytics
  const liveStats = $derived(analyticsData?.live || null);
  const totals = $derived(analyticsData?.totals || null);

  // Top channels
  const topChannels = $derived((analyticsData?.topChannels || []).slice(0, 5));

  // Top members
  const topMembers = $derived((analyticsData?.topMessageMembers || []).slice(0, 5));

  // Moderation
  const moderation = $derived(analyticsData?.moderation || null);

  // Health status
  const healthStatus = $derived(dashboardStore.state.analytics.healthStatus ?? 100);
  const healthLabel = $derived(
    healthStatus >= 90 ? m.home_health_optimal() :
    healthStatus >= 70 ? m.home_health_good() :
    healthStatus >= 50 ? m.home_health_degraded() : m.home_health_critical()
  );
  const healthColor = $derived(
    healthStatus >= 90 ? 'text-emerald-400' :
    healthStatus >= 70 ? 'text-blue-400' :
    healthStatus >= 50 ? 'text-amber-400' : 'text-red-400'
  );

  const handleMarkAsRead = async (id: string) => {
    await notificationsStore.markAsRead(id);
  };

  const handleRefresh = () => {
    dashboardStore.refresh();
    notificationsStore.fetchNotifications(true);

    const visibleIds = new Set(userLayout.filter((item) => item.visible).map((item) => item.id));
    if (visibleIds.has('staff')) staffStore.fetchAll(true);
    if (['liveStats', 'analytics', 'channels', 'moderation', 'members'].some((id) => visibleIds.has(id))) {
      loadAnalytics(true);
    }
    void loadHomeWidgets(sectionsFor(visibleIds), true);
  };

  function formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  function relativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return m.home_rel_now_lower();
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return m.home_short_days({ n: days });
  }
</script>

<div class="space-y-5 pb-10">

  <!-- Header -->
  <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
    <div>
      <h1 class="text-xl font-semibold text-on-surface">{dynamicGreeting}</h1>
      <p class="text-sm text-on-surface-variant mt-0.5">{dynamicSubtitle}</p>
    </div>
    <RefreshButton
      onClick={handleRefresh}
      ariaLabel={m.home_refresh_aria()}
      className="rounded-lg! px-3.5! py-2! bg-primary text-white text-sm"
    />
  </div>

  <!-- API unreachable banner -->
  {#if dashboardStore.state.error === 'api_unreachable'}
    <div class="bg-amber-500/10 border border-amber-500/20 px-4 py-3 rounded-lg text-amber-400 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-md bg-amber-500/20 flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <div>
          <p class="text-sm font-medium">{m.home_api_restarting()}</p>
          <p class="text-xs opacity-70">{m.home_api_reconnect()}</p>
        </div>
      </div>
      <button
        onclick={() => dashboardStore.refresh()}
        class="px-3 py-1.5 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 rounded-md transition-colors cursor-pointer shrink-0"
      >
        {m.home_retry()}
      </button>
    </div>
  {/if}

  <!-- Error modules alert -->
  {#if errorModulesCount > 0}
    <div class="bg-red-500/10 border border-red-500/20 px-4 py-3 rounded-lg text-red-400 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-md bg-red-500/20 flex items-center justify-center">
          <Papicon icon="alert-octagon" size={16} />
        </div>
        <div>
          <p class="text-sm font-medium">{m.home_maintenance_required()}</p>
          <p class="text-xs opacity-70">{errorModules.map(m => m.name).join(', ')}</p>
        </div>
      </div>
      <button
        onclick={() => router.goto('/modules')}
        class="px-3 py-1.5 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 rounded-md transition-colors"
      >
        {m.home_repair()}
      </button>
    </div>
  {/if}

  <!-- Live Stats Row -->
  {#if isEditing}
    <div class="flex justify-center my-3 shrink-0">
      <button
        onclick={() => showAddModuleModal = true}
        class="flex items-center gap-2 px-4 py-2.5 bg-primary text-white rounded-full hover:bg-primary/95 transition-all active:scale-[0.98] shadow-lg font-medium text-xs border border-primary/20 cursor-pointer"
      >
        <Papicon icon="add" size={14} /> {m.home_add_module()}
      </button>
    </div>
  {/if}

  <!-- Bento Grid -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" role="list">
    {#each userLayout.filter(item => item.visible) as item, index (item.id)}
      <div
        role="listitem"
        draggable={isEditing && !$isMobile}
        ondragstart={(e) => handleDragStart(e, index)}
        ondragend={handleDragEnd}
        ondragover={(e) => handleDragOver(e, index)}
        ondragleave={handleDragLeave}
        ondrop={(e) => handleDrop(e, index)}
        class="home-bento-item section-card p-5 flex flex-col relative group transition-all duration-200 {getColSpanClass(displayColSpan(item))} {getRowSpanClass(displayRowSpan(item))} {getModuleMinHeight(item.id)} {isEditing ? 'border-dashed border-primary/50 hover:shadow-lg hover:border-primary bg-surface-container-lowest/80' : ''} {isEditing && dragOverIndex === index ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface scale-[1.02]' : ''}"
        style={isEditing ? `cursor: grab; ${getSpanStyle(displayColSpan(item), displayRowSpan(item))}` : getSpanStyle(displayColSpan(item), displayRowSpan(item))}
      >
        {#if isEditing}
          <!-- Grab handle indicator -->
          <div class="absolute top-1.5 left-1/2 -translate-x-1/2 z-10 opacity-40 group-hover:opacity-80 transition-opacity pointer-events-none">
            <div class="flex gap-0.5">
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
            </div>
            <div class="flex gap-0.5 mt-0.5">
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
            </div>
          </div>

          <!-- Edit toolbar -->
          <div class="absolute top-2.5 right-2.5 z-10 flex items-center gap-1 bg-surface-container/90 px-1.5 py-1 rounded-md shadow-sm border border-outline-variant/60">
            <button
              onclick={() => moveModule(index, -1)}
              disabled={index === 0}
              title={m.home_move_up()}
              aria-label={m.home_move_up()}
              class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            >
              <Papicon icon="arrow-up" size={12} />
            </button>
            <button
              onclick={() => moveModule(index, 1)}
              disabled={index === userLayout.length - 1}
              title={m.home_move_down()}
              aria-label={m.home_move_down()}
              class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            >
              <Papicon icon="arrow-down" size={12} />
            </button>
            {#if !$isMobile}
              <button
                onclick={() => toggleSize(item.id)}
                title={m.home_width_cols({ n: item.colSpan })}
                aria-label={m.home_width_cols({ n: item.colSpan })}
                class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors text-[10px] font-bold px-1.5 cursor-pointer"
              >
                {item.colSpan}c
              </button>
              <button
                onclick={() => toggleRowSize(item.id)}
                title={m.home_height_rows({ n: item.rowSpan || 1 })}
                aria-label={m.home_height_rows({ n: item.rowSpan || 1 })}
                class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors text-[10px] font-bold px-1.5 cursor-pointer"
              >
                {item.rowSpan || 1}r
              </button>
            {/if}
            <button
              onclick={() => hideModule(item.id)}
              title={m.home_hide_module()}
              aria-label={m.home_hide_module()}
              class="p-1 rounded text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <Papicon icon="trash" size={12} />
            </button>
          </div>

          {#if !$isMobile}
            <!-- Desktop-only precision resize handles -->
            <div
              role="button"
              tabindex="-1"
              aria-label={m.home_resize_width()}
              onmousedown={(e) => handleResizeStart(e, item.id, 'col')}
              class="absolute top-0 right-0 w-2 h-full cursor-col-resize z-20 group/resize hover:bg-primary/20 transition-colors rounded-r-lg"
              title={m.home_resize_width()}
            >
              <div class="absolute top-1/2 right-0.5 -translate-y-1/2 w-0.5 h-8 bg-primary/40 rounded-full opacity-0 group-hover/resize:opacity-100 transition-opacity"></div>
            </div>

            <div
              role="button"
              tabindex="-1"
              aria-label={m.home_resize_height()}
              onmousedown={(e) => handleResizeStart(e, item.id, 'row')}
              class="absolute bottom-0 left-0 w-full h-2 cursor-row-resize z-20 group/resize hover:bg-primary/20 transition-colors rounded-b-lg"
              title={m.home_resize_height()}
            >
              <div class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary/40 rounded-full opacity-0 group-hover/resize:opacity-100 transition-opacity"></div>
            </div>
          {/if}
        {/if}

        {#if item.id === 'liveStats'}
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 h-full">
            <MetricCard
              label={m.home_members_label()}
              value={liveStats ? formatNumber(liveStats.humansCount) : '-'}
              note={liveStats ? `${liveStats.botsCount} bot${liveStats.botsCount > 1 ? 's' : ''}` : ''}
              icon="users"
              toneClass="bg-primary/10 text-primary"
              loading={analyticsLoading}
            />
            <MetricCard
              label={m.home_online_label()}
              value={liveStats ? formatNumber(liveStats.onlineMembers + liveStats.idleMembers + liveStats.dndMembers) : '-'}
              note={liveStats ? m.home_actives_note({ n: liveStats.onlineMembers }) : ''}
              icon="wifi"
              toneClass="bg-emerald-500/10 text-emerald-400"
              loading={analyticsLoading}
            />
            <MetricCard
              label={m.home_in_voice()}
              value={liveStats ? String(liveStats.voiceConnected) : '-'}
              note={m.home_connected_now()}
              icon="headphones"
              toneClass="bg-secondary/10 text-secondary"
              loading={analyticsLoading}
            />
            <MetricCard
              label={m.home_growth_7d()}
              value={totals ? `${totals.netGrowth >= 0 ? '+' : ''}${totals.netGrowth}` : '-'}
              note={totals ? m.home_joins_leaves_note({ joins: totals.joins, leaves: totals.leaves }) : ''}
              icon="trending-up"
              toneClass={totals && totals.netGrowth >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}
              loading={analyticsLoading}
            />
          </div>
        {:else if item.id === 'analytics'}
          {#if dashboardStore.state.featureAccess.analytics?.canView}
            <div class="flex flex-col h-full justify-between">
              <div class="flex items-center justify-between mb-3 shrink-0">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-lg bg-tertiary/10 flex items-center justify-center text-tertiary">
                    <Papicon icon="trending-up" size={16} />
                  </div>
                  <div>
                    <div class="flex items-center gap-2">
                      <h3 class="font-medium text-on-surface">{statConfig.title}</h3>
                      <select
                        value={selectedStat}
                        onchange={(e) => handleStatChange(e.currentTarget.value)}
                        class="bg-surface-container text-[11px] text-on-surface-variant border border-outline-variant rounded-md px-1.5 py-0.5 outline-none cursor-pointer"
                      >
                        <option value="messages">Messages</option>
                        <option value="voice">{m.home_opt_voice()}</option>
                        <option value="joins">{m.home_stat_joins_title()}</option>
                        <option value="leaves">{m.home_stat_leaves_title()}</option>
                        <option value="sanctions">{m.nav_sanctions()}</option>
                      </select>
                    </div>
                    <p class="text-[11px] text-on-surface-variant">{statConfig.subtitle}</p>
                  </div>
                </div>
                <div class="text-right shrink-0">
                  {#if analyticsLoading}
                    <div class="h-7 w-16 animate-pulse bg-surface-container-high rounded"></div>
                  {:else}
                    <span class="text-xl font-semibold text-on-surface">{formatNumber(statTotal)}{statConfig.unit}</span>
                    <p class="text-[11px] text-emerald-400">{m.home_last_7_days()}</p>
                  {/if}
                </div>
              </div>
              <div class="w-full grow" style="min-height: {displayRowSpan(item) >= 3 ? 320 : displayRowSpan(item) >= 2 ? 220 : 128}px">
                {#if activityData.length > 0}
                  {#await import('../lib/components/LineChart.svelte')}
                    <div
                      class="w-full rounded-lg bg-surface-container animate-pulse"
                      style:height={`${displayRowSpan(item) >= 3 ? 320 : displayRowSpan(item) >= 2 ? 220 : 128}px`}
                      aria-hidden="true"
                    ></div>
                  {:then module}
                    {@const LineChart = module.default}
                    <LineChart
                      data={activityData}
                      height={displayRowSpan(item) >= 3 ? 320 : displayRowSpan(item) >= 2 ? 220 : 128}
                      labelKey="name"
                      valueKey="value"
                      color={statConfig.color}
                    />
                  {/await}
                {:else}
                  <div class="h-full flex items-center justify-center text-on-surface-variant/40 text-xs">
                    {analyticsLoading ? m.common_loading() : m.home_no_data()}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {:else if item.id === 'botLanguage'}
          <div class="flex flex-col gap-4 h-full">
            <div class="flex items-center gap-2.5 shrink-0">
              <div class="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-on-surface-variant">
                <Papicon icon="globe" size={16} />
              </div>
              <h3 class="font-medium text-on-surface">{m.home_botlanguage()}</h3>
            </div>

            {#if botLanguage}
              <div class="flex flex-col gap-3 grow">
                <div>
                  <p class="text-2xl font-semibold text-on-surface">{botLanguageLabel(botLanguage.locale)}</p>
                  <p class="text-xs text-on-surface-variant mt-0.5">
                    {botLanguage.mode === 'manual' ? m.home_botlanguage_mode_manual() : m.home_botlanguage_mode_auto()}
                  </p>
                </div>

                <p class="text-[11px] text-on-surface-variant">
                  {#if botLanguage.detected}
                    {m.home_botlanguage_detected({ lang: botLanguageLabel(botLanguage.detected) })}
                  {:else}
                    {m.home_botlanguage_detected_none()}
                  {/if}
                </p>

                <div class="flex flex-wrap gap-2 mt-auto">
                  {#each botLanguage.available as code}
                    <button
                      type="button"
                      disabled={botLanguageLoading}
                      onclick={() => setBotLanguage({ language: code })}
                      class="px-2.5 py-1 rounded-lg text-xs border transition-colors disabled:opacity-50 cursor-pointer
                        {botLanguage.mode === 'manual' && botLanguage.locale === code
                          ? 'border-primary text-primary bg-primary/10'
                          : 'border-outline-variant text-on-surface-variant hover:bg-surface-container'}"
                    >
                      {botLanguageLabel(code)}
                    </button>
                  {/each}
                  <button
                    type="button"
                    disabled={botLanguageLoading || botLanguage.mode === 'auto'}
                    onclick={() => setBotLanguage({ mode: 'auto' })}
                    class="px-2.5 py-1 rounded-lg text-xs border transition-colors disabled:opacity-50 cursor-pointer
                      {botLanguage.mode === 'auto'
                        ? 'border-primary text-primary bg-primary/10'
                        : 'border-outline-variant text-on-surface-variant hover:bg-surface-container'}"
                  >
                    {m.home_botlanguage_auto_action()}
                  </button>
                </div>

                {#if botLanguageRerender}
                  {#if botLanguageRerender.failed > 0}
                    <p class="text-[10px] text-amber-400">{m.home_botlanguage_panels_failed({ n: botLanguageRerender.failed })}</p>
                  {:else if botLanguageRerender.updated > 0}
                    <p class="text-[10px] text-emerald-400">{m.home_botlanguage_panels_updated({ n: botLanguageRerender.updated })}</p>
                  {:else}
                    <p class="text-[10px] text-on-surface-variant/70">{m.home_botlanguage_panels_none()}</p>
                  {/if}
                {:else}
                  <p class="text-[10px] text-on-surface-variant/70">{m.home_botlanguage_hint()}</p>
                {/if}
              </div>
            {:else}
              <div class="h-full flex items-center justify-center text-on-surface-variant/40 text-xs">
                {botLanguageLoading ? m.common_loading() : m.home_no_data()}
              </div>
            {/if}
          </div>
        {:else if item.id === 'timezone'}
          <div class="flex flex-col gap-4 h-full">
            <div class="flex items-center gap-2.5 shrink-0">
              <div class="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-on-surface-variant">
                <Papicon icon="clock" size={16} />
              </div>
              <h3 class="font-medium text-on-surface">{m.home_timezone()}</h3>
            </div>

            {#if timezone}
              <div class="flex flex-col gap-3 grow">
                <div>
                  <p class="text-2xl font-semibold text-on-surface">{timezonePreview}</p>
                  <p class="text-xs text-on-surface-variant mt-0.5">{timezone.timezone}</p>
                </div>

                <label class="flex flex-col gap-1 mt-auto">
                  <span class="text-[10px] uppercase font-medium text-on-surface-variant">{m.home_timezone_label()}</span>
                  <select
                    disabled={timezoneLoading}
                    value={timezone.timezone}
                    onchange={(e) => setTimezone((e.target as HTMLSelectElement).value)}
                    class="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary disabled:opacity-50 cursor-pointer"
                  >
                    {#each timezone.available as zone}
                      <option value={zone}>{zone.replace(/_/g, ' ')}</option>
                    {/each}
                  </select>
                </label>

                <p class="text-[10px] text-on-surface-variant/70">{m.home_timezone_hint()}</p>
              </div>
            {:else}
              <div class="h-full flex items-center justify-center text-on-surface-variant/40 text-xs">
                {timezoneLoading ? m.common_loading() : m.home_no_data()}
              </div>
            {/if}
          </div>
        {:else if item.id === 'system'}
          <div class="flex flex-col gap-4 h-full justify-between">
            <div class="flex items-center justify-between shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-on-surface-variant">
                  <Papicon icon="cpu" size={16} />
                </div>
                <h3 class="font-medium text-on-surface">{m.home_system()}</h3>
              </div>
              <button onclick={() => router.goto('/modules')} class="text-xs text-primary hover:underline cursor-pointer">{m.nav_modules()}</button>
            </div>

            <div class="flex {displayColSpan(item) >= 2 ? 'flex-row gap-6' : 'flex-col gap-4'} grow {displayColSpan(item) < 2 ? 'justify-center' : 'items-center'}">
              <div class="flex items-center gap-4 {displayColSpan(item) >= 2 ? '' : 'justify-center'}">
                <div class="relative w-16 h-16 shrink-0">
                  <svg class="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                    <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" class="text-surface-container-high" stroke-width="4" />
                    <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" class={healthColor} stroke-width="4" stroke-linecap="round"
                      stroke-dasharray={`${healthStatus * 1.76} 176`} />
                  </svg>
                  <span class="absolute inset-0 flex items-center justify-center text-sm font-semibold text-on-surface">{healthStatus}%</span>
                </div>
                <div>
                  <p class="text-sm font-medium {healthColor}">{healthLabel}</p>
                  <p class="text-xs text-on-surface-variant mt-0.5">{m.home_modules_active({ active: activeModulesCount, total: totalModulesCount })}</p>
                  {#if errorModulesCount > 0}
                    <p class="text-xs text-red-400 mt-0.5">{m.home_n_errors({ n: errorModulesCount })}</p>
                  {/if}
                </div>
              </div>

              {#if displayColSpan(item) >= 2 || displayRowSpan(item) >= 2}
                <div class="flex-1 space-y-1.5 {displayColSpan(item) >= 2 ? 'border-l border-outline-variant pl-6' : 'border-t border-outline-variant pt-3'}">
                  <span class="text-[10px] text-on-surface-variant">{m.home_active_modules()}</span>
                  {#each dashboardStore.state.modules.filter(m => m.status === 'active').slice(0, displayRowSpan(item) >= 2 ? 8 : 5) as mod}
                    <div class="flex items-center justify-between text-xs">
                      <span class="text-on-surface truncate">{mod.name}</span>
                      <span class="text-[10px] text-emerald-400 shrink-0">{m.home_active_lower()}</span>
                    </div>
                  {/each}
                  {#each dashboardStore.state.modules.filter(m => m.status === 'error') as mod}
                    <div class="flex items-center justify-between text-xs">
                      <span class="text-on-surface truncate">{mod.name}</span>
                      <span class="text-[10px] text-red-400 shrink-0">{m.home_error_lower()}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="border-t border-outline-variant pt-3 mt-auto shrink-0">
              <div class="flex items-center justify-between text-xs text-on-surface-variant mb-2">
                <span>Interactions</span>
                <span class="font-medium text-on-surface">{formatNumber(dashboardStore.state.analytics.totalAutomations)}</span>
              </div>
              <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                <div class="bg-secondary h-full rounded-full transition-all duration-500" style="width: {totalModulesCount > 0 ? (activeModulesCount / totalModulesCount) * 100 : 0}%"></div>
              </div>
            </div>
          </div>
        {:else if item.id === 'channels'}
          {@const channelCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          {@const channelsCols = displayColSpan(item) >= 2 ? 2 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-tertiary/10 flex items-center justify-center text-tertiary">
                  <Papicon icon="hash" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_active_channels()}</h3>
              </div>
              <span class="text-[10px] text-on-surface-variant">7 jours</span>
            </div>
            <div class="grow flex flex-col justify-center {channelsCols > 1 ? 'grid grid-cols-2 gap-x-4 gap-y-2 items-start' : 'space-y-2'}">
              {#if analyticsLoading}
                {#each Array(channelCount) as _}
                  <div class="h-7 animate-pulse bg-surface-container-high rounded"></div>
                {/each}
              {:else if topChannels.length > 0}
                {#each (analyticsData?.topChannels || []).slice(0, channelCount) as channel, i}
                  {@const maxMsgs = topChannels[0]?.messagesCount || 1}
                  <div class="flex items-center gap-2.5">
                    <span class="text-[10px] text-on-surface-variant w-4 text-right shrink-0">{i + 1}</span>
                    <div class="grow min-w-0">
                      <div class="flex items-center justify-between gap-2 mb-0.5">
                        <span class="text-xs text-on-surface truncate"># {channel.channelName}</span>
                        <span class="text-[10px] text-on-surface-variant shrink-0">{formatNumber(channel.messagesCount)}</span>
                      </div>
                      <div class="h-1 w-full bg-surface-container-high rounded-full overflow-hidden">
                        <div class="bg-tertiary/60 h-full rounded-full" style="width: {(channel.messagesCount / maxMsgs) * 100}%"></div>
                      </div>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant/40 {channelsCols > 1 ? 'col-span-2' : ''}">{m.home_no_data()}</div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'moderation'}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
                  <Papicon icon="shield" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_moderation_title()}</h3>
              </div>
              <button onclick={() => router.goto('/analytics')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_details()}</button>
            </div>
            <div class="space-y-2.5 grow flex flex-col justify-center">
              {#if analyticsLoading}
                {#each Array(4) as _}
                  <div class="h-6 animate-pulse bg-surface-container-high rounded"></div>
                {/each}
              {:else if moderation}
                <div class="grid {displayColSpan(item) >= 2 ? 'grid-cols-4' : 'grid-cols-2'} gap-2">
                  <div class="px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                    <p class="text-lg font-semibold text-on-surface">{moderation.totals.warns}</p>
                    <p class="text-[10px] text-on-surface-variant">Warns</p>
                  </div>
                  <div class="px-3 py-2 rounded-lg bg-orange-500/5 border border-orange-500/10">
                    <p class="text-lg font-semibold text-on-surface">{moderation.totals.timeouts}</p>
                    <p class="text-[10px] text-on-surface-variant">Timeouts</p>
                  </div>
                  <div class="px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/10">
                    <p class="text-lg font-semibold text-on-surface">{moderation.totals.kicks}</p>
                    <p class="text-[10px] text-on-surface-variant">Kicks</p>
                  </div>
                  <div class="px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/10">
                    <p class="text-lg font-semibold text-on-surface">{moderation.totals.bans}</p>
                    <p class="text-[10px] text-on-surface-variant">Bans</p>
                  </div>
                </div>
                {#if moderation.activeSanctions > 0}
                  <p class="text-[11px] text-amber-400 mt-1">{m.home_active_sanctions({ n: moderation.activeSanctions })}</p>
                {/if}
                {#if displayRowSpan(item) >= 2 && moderation.recentSanctions?.length > 0}
                  <div class="border-t border-outline-variant pt-2 mt-1 space-y-1.5">
                    <span class="text-[10px] text-on-surface-variant">{m.home_recent_sanctions()}</span>
                    {#each moderation.recentSanctions.slice(0, displayRowSpan(item) >= 3 ? 6 : 3) as sanction}
                      <div class="flex items-center justify-between text-xs">
                        <span class="text-on-surface truncate">{sanction.targetName || m.home_member()}</span>
                        <span class="text-[10px] text-on-surface-variant shrink-0">{sanction.type}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant/40">{m.home_no_data()}</div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'members'}
          {@const memberCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          {@const membersCols = displayColSpan(item) >= 2 ? 2 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Papicon icon="award" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_top_members()}</h3>
              </div>
              <span class="text-[10px] text-on-surface-variant">7 jours</span>
            </div>
            <div class="grow flex flex-col justify-center {membersCols > 1 ? 'grid grid-cols-2 gap-x-4 gap-y-2 items-start' : 'space-y-2'}">
              {#if analyticsLoading}
                {#each Array(memberCount) as _}
                  <div class="h-7 animate-pulse bg-surface-container-high rounded"></div>
                {/each}
              {:else if topMembers.length > 0}
                {#each (analyticsData?.topMessageMembers || []).slice(0, memberCount) as member, i}
                  <div class="flex items-center gap-2.5">
                    <span class="text-[10px] font-medium {i === 0 ? 'text-amber-400' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-400' : 'text-on-surface-variant'} w-4 text-right shrink-0">{i + 1}</span>
                    {#if member.avatarUrl}
                      <img src={member.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                    {:else}
                      <div class="w-6 h-6 rounded-full bg-surface-container-high shrink-0 flex items-center justify-center">
                        <Papicon icon="user" size={12} class="text-on-surface-variant" />
                      </div>
                    {/if}
                    <div class="grow min-w-0 flex items-center justify-between gap-2">
                      <span class="text-xs text-on-surface truncate">{member.name}</span>
                      <span class="text-[10px] text-on-surface-variant shrink-0">{formatNumber(member.messageCount)} msg</span>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant/40 {membersCols > 1 ? 'col-span-2' : ''}">{m.home_no_data()}</div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'notifications'}
          {@const notifCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          {@const notifCols = displayColSpan(item) >= 2 ? 2 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Papicon icon="inbox" size={14} />
                </div>
                <div>
                  <h3 class="text-sm font-medium text-on-surface">Notifications</h3>
                  <span class="text-[10px] text-on-surface-variant">{m.home_unread_count({ n: notificationsStore.unreadCount })}</span>
                </div>
              </div>
              <a href="/inbox" class="w-6 h-6 rounded-md bg-surface-container flex items-center justify-center hover:bg-surface-container-high transition-colors text-on-surface-variant">
                <Papicon icon="arrow-up-right" size={12} />
              </a>
            </div>
            <div class="grow flex flex-col justify-center {notifCols > 1 ? 'grid grid-cols-2 gap-1.5 items-start' : 'space-y-1.5'}">
              {#if notificationsStore.items.filter(n => !n.isRead).length > 0}
                {#each notificationsStore.items.filter(n => !n.isRead).slice(0, notifCount) as notif}
                  <div class="px-2.5 py-2 rounded-lg border border-outline-variant bg-surface-container-low flex items-center justify-between gap-2 hover:border-primary/30 transition-colors">
                    <div class="flex items-center gap-2 min-w-0">
                      <div class="w-1.5 h-1.5 rounded-full {notif.type === 'ERROR' ? 'bg-red-400' : notif.type === 'WARNING' ? 'bg-amber-400' : 'bg-primary'} shrink-0"></div>
                      <div class="min-w-0">
                        <p class="text-xs font-medium leading-tight truncate">{notif.title}</p>
                        <p class="text-[10px] text-on-surface-variant mt-0.5 line-clamp-1">{notif.message}</p>
                      </div>
                    </div>
                    <button
                      onclick={() => handleMarkAsRead(notif.id)}
                      class="w-5 h-5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors flex items-center justify-center shrink-0 cursor-pointer"
                    >
                      <Papicon icon="check" size={10} />
                    </button>
                  </div>
                {/each}
              {:else}
                <div class="flex flex-col items-center justify-center py-6 text-center text-on-surface-variant/40 {notifCols > 1 ? 'col-span-2' : ''}">
                  <Papicon icon="check-circle" size={18} class="mb-1 text-emerald-500/50" />
                  <p class="text-[11px]">{m.home_all_up_to_date()}</p>
                </div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'staff'}
          {@const staffAbsCount = displayRowSpan(item) >= 2 ? 3 : 1}
          {@const staffMeetCount = displayRowSpan(item) >= 2 ? 3 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
                  <Papicon icon="users" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">Staff</h3>
              </div>
              <div class="flex gap-1.5">
                <span class="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/10 text-amber-400">{pendingAbsences.length} abs.</span>
                <span class="px-1.5 py-0.5 text-[10px] rounded bg-surface-container text-on-surface-variant">{m.home_meetings_badge({ n: staffStore.upcomingMeetings.length })}</span>
              </div>
            </div>

            <div class="grow flex {displayColSpan(item) >= 2 ? 'flex-row gap-4' : 'flex-col'} justify-center">
              <div class="{displayColSpan(item) >= 2 ? 'flex-1' : ''} space-y-2.5">
                {#each pendingAbsences.slice(0, staffAbsCount) as absence, i}
                  <div class="p-2.5 rounded-lg border border-outline-variant bg-surface-container-low">
                    <span class="text-[10px] text-primary block mb-1">{i === 0 ? m.home_next_absence() : m.home_absence()}</span>
                    <p class="text-xs font-medium truncate">{absence.staffDisplayName || m.home_staff_member()}</p>
                    <p class="text-[10px] text-on-surface-variant mt-0.5 truncate">{absence.reason || 'N/A'}</p>
                  </div>
                {:else}
                  <div class="p-2.5 rounded-lg border border-outline-variant bg-surface-container-low">
                    <span class="text-[10px] text-primary block mb-1">{m.home_next_absence()}</span>
                    <p class="text-[11px] text-on-surface-variant/50">{m.home_none_f()}</p>
                  </div>
                {/each}
              </div>

              <div class="{displayColSpan(item) >= 2 ? 'flex-1' : ''} space-y-2.5 {displayColSpan(item) < 2 ? 'mt-2.5' : ''}">
                {#each staffStore.upcomingMeetings.slice(0, staffMeetCount) as meeting, i}
                  <div class="p-2.5 rounded-lg border border-outline-variant bg-surface-container-low">
                    <span class="text-[10px] text-secondary block mb-1">{i === 0 ? m.home_next_meeting() : m.home_meeting()}</span>
                    <p class="text-xs font-medium truncate">{meeting.title}</p>
                    <p class="text-[10px] text-on-surface-variant mt-0.5 text-on-surface">
                      {m.home_date_at_time({ date: new Date(meeting.scheduledAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }), time: new Date(meeting.scheduledAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })}
                    </p>
                  </div>
                {:else}
                  <div class="p-2.5 rounded-lg border border-outline-variant bg-surface-container-low">
                    <span class="text-[10px] text-secondary block mb-1">{m.home_next_meeting()}</span>
                    <p class="text-[11px] text-on-surface-variant/50">{m.home_none_f()}</p>
                  </div>
                {/each}
              </div>
            </div>

            <a href="/staff-management" class="mt-3 flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-surface-container text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors border border-outline-variant">
              {m.home_manage_team()} <Papicon icon="arrow-right" size={12} />
            </a>
          </div>
        {:else if item.id === 'audit'}
          {@const auditCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-surface-container flex items-center justify-center text-on-surface-variant">
                  <Papicon icon="activity" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_recent_activity()}</h3>
              </div>
              <a href="/activity" class="text-[10px] text-primary hover:underline">{m.home_see_all()}</a>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              {#each dashboardStore.state.auditTrail.slice(0, auditCount) as entry}
                <div class="flex gap-2 items-start">
                  <div class="w-6 h-6 rounded bg-surface-container flex items-center justify-center shrink-0 mt-0.5">
                    <Papicon icon={entry.source === 'discord' ? 'message-circle' : entry.user === 'Automatique' ? 'cpu' : 'user'} size={11} class="text-on-surface-variant" />
                  </div>
                  <div class="grow min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[10px] text-primary truncate">{entry.module}</span>
                      <span class="text-[9px] text-on-surface-variant shrink-0">{entry.dateIso ? relativeTime(entry.dateIso) : entry.time || ''}</span>
                    </div>
                    <p class="text-[11px] text-on-surface {displayColSpan(item) >= 2 ? '' : 'truncate'}">{@html entry.action}</p>
                    {#if displayColSpan(item) >= 2 && entry.user}
                      <p class="text-[10px] text-on-surface-variant">{m.home_by_user({ user: entry.user })}</p>
                    {/if}
                  </div>
                </div>
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant/40">{m.home_no_activity()}</div>
              {/each}
            </div>
          </div>
        {:else if item.id === 'actions'}
          <div class="flex flex-col h-full justify-center">
            <div class="flex flex-wrap gap-2 items-center">
              <span class="text-[10px] text-on-surface-variant mr-1">{m.home_shortcuts()}</span>
              <button onclick={() => router.goto('/planning')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="calendar-plus" size={12} class="text-primary" /> {m.home_absence()}
              </button>
              <button onclick={() => router.goto('/planning')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="video" size={12} class="text-secondary" /> {m.home_meeting()}
              </button>
              <button onclick={() => router.goto('/modules')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="plus-circle" size={12} class="text-tertiary" /> Module
              </button>
              <button onclick={() => router.goto('/analytics')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="bar-chart-2" size={12} class="text-amber-400" /> Analytics
              </button>
              <button onclick={() => router.goto('/staff-management')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="users" size={12} class="text-emerald-400" /> Staff
              </button>
            </div>
          </div>
        {:else if item.id === 'notes'}
          <div class="flex flex-col h-full min-h-[160px]">
            <div class="flex items-center gap-2.5 mb-2 shrink-0">
              <div class="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Papicon icon="edit" size={14} />
              </div>
              <h3 class="text-sm font-medium text-on-surface">{m.home_team_notes()}</h3>
            </div>
            <textarea
              value={staffNotes}
              oninput={saveStaffNotes}
              placeholder={m.home_notes_placeholder()}
              class="w-full grow p-2.5 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none resize-none focus:border-primary/50 text-on-surface min-h-[100px]"
            ></textarea>
          </div>
        {:else if item.id === 'serverInfo'}
          {@const serverInfo = homeWidgets?.serverInfo}
          {@const memberCount = serverInfo?.memberCount ?? (liveStats ? liveStats.humansCount + liveStats.botsCount : null)}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                  <Papicon icon="server" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_serverinfo_title()}</h3>
              </div>
            </div>
            <div class="space-y-2 text-xs grow flex flex-col justify-center">
              <div class="flex justify-between py-1 border-b border-outline-variant/30">
                <span class="text-on-surface-variant">{m.home_name_label()}</span>
                <span class="font-medium text-on-surface truncate max-w-[150px]">{serverInfo?.name || dashboardStore.state.guildName || '-'}</span>
              </div>
              <div class="flex justify-between py-1 border-b border-outline-variant/30">
                <span class="text-on-surface-variant">{m.home_members_label()}</span>
                <span class="font-medium text-on-surface">{memberCount === null ? '-' : formatNumber(memberCount)}</span>
              </div>
              <div class="flex justify-between py-1 border-b border-outline-variant/30">
                <span class="text-on-surface-variant">Boosts</span>
                {#if serverInfo?.boostLevel == null}
                  <span class="font-medium text-on-surface">-</span>
                {:else}
                  <span class="font-medium text-purple-400 flex items-center gap-1">
                    <Papicon icon="star" size={10} /> {m.home_boost_level({ n: serverInfo.boostLevel })} · {serverInfo.boostCount}
                  </span>
                {/if}
              </div>
              <div class="flex justify-between py-1">
                <span class="text-on-surface-variant">{m.home_owner()}</span>
                <span class="font-semibold text-on-surface truncate max-w-[150px]">{serverInfo?.ownerTag || '-'}</span>
              </div>
            </div>
          </div>
        {:else if item.id === 'botHosting'}
          {@const hosting = homeWidgets?.hosting}
          {@const memoryPercent = hosting && hosting.memoryTotalMb > 0 ? Math.min(100, Math.round((hosting.memoryUsedMb / hosting.memoryTotalMb) * 100)) : 0}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                  <Papicon icon="cpu" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_bothosting_title()}</h3>
              </div>
              {#if hosting}
                <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] bg-emerald-500/20 text-emerald-400 font-medium">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> {m.home_online_label()}
                </span>
              {/if}
            </div>
            <div class="space-y-3 grow flex flex-col justify-center">
              <div>
                <div class="flex justify-between text-[10px] text-on-surface-variant mb-1">
                  <span>{m.home_cpu()}</span>
                  <span class="font-medium text-on-surface">{hosting?.cpuPercent == null ? '-' : `${hosting.cpuPercent}%`}</span>
                </div>
                <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div class="bg-emerald-500 h-full rounded-full transition-all duration-500" style="width: {hosting?.cpuPercent ?? 0}%"></div>
                </div>
              </div>
              <div>
                <div class="flex justify-between text-[10px] text-on-surface-variant mb-1">
                  <span>{m.home_ram()}</span>
                  <span class="font-medium text-on-surface">{hosting ? `${formatMemory(hosting.memoryUsedMb)} / ${formatMemory(hosting.memoryTotalMb)}` : '-'}</span>
                </div>
                <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div class="bg-primary h-full rounded-full transition-all duration-500" style="width: {memoryPercent}%"></div>
                </div>
              </div>
              <div class="flex justify-between text-xs pt-1">
                <span class="text-on-surface-variant">{m.home_api_latency()}</span>
                <span class="font-medium {!hosting ? 'text-on-surface' : hosting.latencyMs < 200 ? 'text-emerald-400' : hosting.latencyMs < 500 ? 'text-amber-400' : 'text-red-400'}">
                  {hosting ? `${hosting.latencyMs} ms` : '-'}
                </span>
              </div>
              <div class="flex justify-between text-xs">
                <span class="text-on-surface-variant">{m.home_uptime()}</span>
                <span class="font-medium text-on-surface">{hosting ? formatDuration(hosting.uptimeSeconds) : '-'}</span>
              </div>
            </div>
          </div>
        {:else if item.id === 'news'}
          {@const maxNewsItems = displayRowSpan(item) >= 2 ? 6 : 3}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400">
                  <Papicon icon="book" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_kotbo_news()}</h3>
              </div>
            </div>
            <div class="space-y-2 grow text-xs flex flex-col overflow-y-auto" style="scrollbar-width: thin;">
              {#if changelogLoading}
                <div class="flex items-center justify-center grow">
                  <span class="text-on-surface-variant text-[11px]">{m.common_loading()}</span>
                </div>
              {:else if changelogCommits.length === 0}
                <div class="flex items-center justify-center grow">
                  <span class="text-on-surface-variant text-[11px]">{m.home_no_updates()}</span>
                </div>
              {:else}
                {#each changelogCommits.slice(0, maxNewsItems) as commit}
                  {@const typeColors: Record<string, string> = { feat: 'text-emerald-400', fix: 'text-amber-400', refactor: 'text-blue-400', perf: 'text-cyan-400', test: 'text-violet-400' }}
                  {@const typeBgColors: Record<string, string> = { feat: 'bg-emerald-500/15', fix: 'bg-amber-500/15', refactor: 'bg-blue-500/15', perf: 'bg-cyan-500/15', test: 'bg-violet-500/15' }}
                  {@const typeLabels: Record<string, string> = { feat: m.home_type_feat(), fix: m.home_type_fix(), refactor: m.home_type_refactor(), perf: 'Perf', test: 'Test' }}
                  {@const typeColor = typeColors[commit.type] || 'text-purple-400'}
                  {@const typeBg = typeBgColors[commit.type] || 'bg-purple-500/15'}
                  {@const typeLabel = typeLabels[commit.type] || commit.type}
                  {@const relDate = formatRelativeDate(commit.date)}
                  <div class="p-2 rounded-lg bg-surface-container/60 hover:bg-surface-container transition-colors">
                    <div class="flex items-center justify-between mb-0.5">
                      <span class="inline-flex items-center px-1.5 py-px rounded-full text-[9px] font-medium {typeBg} {typeColor}">
                        {typeLabel}{commit.scope ? ` (${commit.scope})` : ''}
                      </span>
                      <span class="text-[9px] text-on-surface-variant">{relDate}</span>
                    </div>
                    <p class="font-medium text-on-surface text-[11px] leading-snug">{commit.title}</p>
                    {#if commit.description}
                      <p class="text-[10px] text-on-surface-variant mt-0.5 leading-tight line-clamp-2">{commit.description}</p>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if item.id === 'quickGuide'}
          {@const guide = homeWidgets?.quickGuide}
          {@const guideSteps = [
            { label: m.home_guide_invite(), done: guide?.botInvited ?? false, href: '/modules' },
            { label: m.home_guide_logs(), done: guide?.logsConfigured ?? false, href: '/logs' },
            { label: m.home_guide_tickets(), done: guide?.ticketsConfigured ?? false, href: '/tickets' },
            { label: m.home_guide_roles(), done: guide?.staffRolesConfigured ?? false, href: '/staff-management/roles' },
          ]}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center gap-2.5 mb-3 shrink-0">
              <div class="w-7 h-7 rounded-lg bg-yellow-500/10 flex items-center justify-center text-yellow-500">
                <Papicon icon="info" size={14} />
              </div>
              <h3 class="text-sm font-medium text-on-surface">{m.home_quick_guide()}</h3>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              {#each guideSteps as step}
                <button
                  onclick={() => router.goto(step.href)}
                  disabled={!guide}
                  class="flex items-center gap-2 text-xs text-on-surface text-left disabled:cursor-default {guide ? 'cursor-pointer hover:text-primary' : ''}"
                >
                  <span class="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 {step.done ? 'bg-primary border-primary text-white' : 'border-outline-variant'}">
                    {#if step.done}
                      <Papicon icon="check" size={10} />
                    {/if}
                  </span>
                  <span class={step.done ? 'line-through text-on-surface-variant' : ''}>{step.label}</span>
                </button>
              {/each}
            </div>
          </div>
        {:else if item.id === 'clockWeather'}
          <div class="flex flex-col h-full justify-between min-h-[130px]">
            <div class="flex items-center gap-2.5 mb-2 shrink-0">
              <div class="w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400">
                <Papicon icon="clock" size={14} />
              </div>
              <h3 class="text-sm font-medium text-on-surface">{m.home_mod_clockweather_title()}</h3>
            </div>
            <div class="flex flex-col justify-center grow">
              <p class="text-2xl font-bold text-on-surface tracking-tight">{currentTime}</p>
              <p class="text-[10px] text-on-surface-variant capitalize">{currentDate}</p>
            </div>
          </div>
        {:else if item.id === 'economy'}
          {@const economy = homeWidgets?.economy}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
                  <Papicon icon="dollar-sign" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_economy_title()}</h3>
              </div>
              <button onclick={() => router.goto('/economy')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_manage()}</button>
            </div>
            <div class="space-y-2.5 grow flex flex-col justify-center">
              <div class="grid grid-cols-2 gap-2">
                <div class="px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                  <p class="text-lg font-semibold text-on-surface">{economy ? formatNumber(economy.totalBalance) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_in_circulation()}</p>
                </div>
                <div class="px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                  <p class="text-lg font-semibold text-on-surface">{economy ? formatNumber(economy.activePlayers) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_active_7d()}</p>
                </div>
              </div>
              <p class="text-[10px] text-on-surface-variant text-center">
                {#if !economy}
                  {m.home_economy_hint()}
                {:else if !economy.enabled}
                  {m.home_economy_disabled()}
                {:else}
                  {m.home_economy_players({ n: economy.players })}
                {/if}
              </p>
            </div>
          </div>
        {:else if item.id === 'leveling'}
          {@const leveling = homeWidgets?.leveling}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                  <Papicon icon="bar-chart-2" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_leveling_title()}</h3>
              </div>
              <button onclick={() => router.goto('/leveling')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_leaderboard()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              <div class="grid grid-cols-2 gap-2">
                <div class="px-3 py-2 rounded-lg bg-indigo-500/5 border border-indigo-500/10">
                  <p class="text-lg font-semibold text-on-surface">{leveling?.averageLevel ?? '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_avg_level()}</p>
                </div>
                <div class="px-3 py-2 rounded-lg bg-purple-500/5 border border-purple-500/10">
                  <p class="text-lg font-semibold text-on-surface">{leveling ? formatNumber(leveling.activeMembers) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_active_7d()}</p>
                </div>
              </div>
              <p class="text-[10px] text-on-surface-variant text-center">
                {#if !leveling}
                  {m.home_leveling_hint()}
                {:else if !leveling.enabled}
                  {m.home_leveling_disabled()}
                {:else}
                  {m.home_leveling_ranked({ n: leveling.rankedMembers })}
                {/if}
              </p>
            </div>
          </div>
        {:else if item.id === 'tickets'}
          {@const tickets = homeWidgets?.tickets}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
                  <Papicon icon="message-square" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">Tickets</h3>
              </div>
              <button onclick={() => router.goto('/tickets')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_see_everything()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              <div class="grid grid-cols-3 gap-2">
                <div class="px-2 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10 text-center">
                  <p class="text-lg font-semibold text-on-surface">{tickets ? formatNumber(tickets.open) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_open_tickets()}</p>
                </div>
                <div class="px-2 py-2 rounded-lg bg-amber-500/5 border border-amber-500/10 text-center">
                  <p class="text-lg font-semibold text-on-surface">{tickets ? formatNumber(tickets.claimed) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_in_progress()}</p>
                </div>
                <div class="px-2 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10 text-center">
                  <p class="text-lg font-semibold text-on-surface">{tickets ? formatNumber(tickets.closedRecently) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_closed_7d()}</p>
                </div>
              </div>
            </div>
          </div>
        {:else if item.id === 'invites'}
          {@const invites = homeWidgets?.invites}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-teal-500/10 flex items-center justify-center text-teal-400">
                  <Papicon icon="user-plus" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_invites_title()}</h3>
              </div>
              <button onclick={() => router.goto('/invitations')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_details()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              <div class="grid grid-cols-2 gap-2">
                <div class="px-3 py-2 rounded-lg bg-teal-500/5 border border-teal-500/10">
                  <p class="text-lg font-semibold text-on-surface">{invites ? formatNumber(invites.activeCodes) : '-'}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_active_invites()}</p>
                </div>
                <div class="px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                  <p class="text-lg font-semibold text-on-surface">{invites?.retentionPercent == null ? '-' : `${invites.retentionPercent}%`}</p>
                  <p class="text-[10px] text-on-surface-variant">{m.home_retention()}</p>
                </div>
              </div>
              <p class="text-[10px] text-on-surface-variant text-center">
                {#if invites}
                  {m.home_invites_joined({ n: invites.joinedRecently })}
                {:else}
                  {m.home_invites_hint()}
                {/if}
              </p>
            </div>
          </div>
        {:else if item.id === 'events'}
          {@const upcomingEvents = homeWidgets?.events?.upcoming ?? []}
          {@const maxEvents = displayRowSpan(item) >= 2 ? 5 : 3}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400">
                  <Papicon icon="calendar" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_events_title()}</h3>
              </div>
              <button onclick={() => router.goto('/events')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_see_everything()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col {upcomingEvents.length > 0 ? '' : 'justify-center'}">
              {#if upcomingEvents.length === 0}
                <div class="flex flex-col items-center justify-center py-4 text-center text-on-surface-variant/40">
                  <Papicon icon="calendar" size={18} class="mb-1 text-rose-500/50" />
                  <p class="text-[11px]">{m.home_no_upcoming_events()}</p>
                  <p class="text-[10px] mt-0.5">{m.home_create_event_hint()}</p>
                </div>
              {:else}
                {#each upcomingEvents.slice(0, maxEvents) as evt (evt.id)}
                  <button
                    onclick={() => router.goto('/events')}
                    class="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-rose-500/5 border border-rose-500/10 hover:border-rose-500/30 transition-colors text-left cursor-pointer"
                  >
                    <div class="min-w-0">
                      <p class="text-xs font-medium text-on-surface truncate">{evt.title}</p>
                      <p class="text-[10px] text-on-surface-variant">
                        {evt.startsAt ? formatEventDate(evt.startsAt) : evt.type}
                      </p>
                    </div>
                    <span class="text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 {evt.status === 'ONGOING' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400'}">
                      {evt.status === 'ONGOING' ? m.ev_status_ongoing() : m.ev_status_published()}
                    </span>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {:else if item.id === 'polls'}
          {@const openPolls = homeWidgets?.polls?.open ?? []}
          {@const maxPolls = displayRowSpan(item) >= 2 ? 5 : 3}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-400">
                  <Papicon icon="bar-chart" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_polls_title()}</h3>
              </div>
              <button onclick={() => router.goto('/staff-management/polls')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_see_everything()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col {openPolls.length > 0 ? '' : 'justify-center'}">
              {#if openPolls.length === 0}
                <div class="flex flex-col items-center justify-center py-4 text-center text-on-surface-variant/40">
                  <Papicon icon="bar-chart" size={18} class="mb-1 text-violet-500/50" />
                  <p class="text-[11px]">{m.home_no_active_polls()}</p>
                  <p class="text-[10px] mt-0.5">{m.home_polls_hint()}</p>
                </div>
              {:else}
                {#each openPolls.slice(0, maxPolls) as poll (poll.id)}
                  <div class="px-2.5 py-2 rounded-lg bg-violet-500/5 border border-violet-500/10">
                    <p class="text-xs font-medium text-on-surface truncate">{poll.title}</p>
                    <p class="text-[10px] text-on-surface-variant">
                      {m.home_poll_votes({ n: poll.voteCount })}{poll.closesAt ? ` · ${m.home_poll_closes({ date: formatEventDate(poll.closesAt) })}` : ''}
                    </p>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if item.id === 'staffServer'}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
                  <Papicon icon="shield" size={14} />
                </div>
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_staffserver_title()}</h3>
              </div>
              <button onclick={() => router.goto('/staff-server')} class="text-[10px] text-primary hover:underline cursor-pointer">{m.home_manage()}</button>
            </div>
            {#if staffServerLinks.length > 0}
              {@const link = staffServerLinks[0]}
              <div class="space-y-2 grow flex flex-col justify-center">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full {link.enabled ? 'bg-emerald-400' : 'bg-red-400'}"></span>
                  <p class="text-sm font-medium text-on-surface truncate">{link.otherGuildName}</p>
                  <span class="text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
                    {link.isMain ? 'Staff' : m.home_main_label()}
                  </span>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
                    <p class="text-xs font-semibold text-on-surface">{SYNC_MODE_LABELS[link.syncMode] ?? link.syncMode}</p>
                    <p class="text-[10px] text-on-surface-variant">{m.home_sync_mode()}</p>
                  </div>
                  <div class="px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                    <p class="text-lg font-semibold text-on-surface">{link.roleMappings?.length ?? 0}</p>
                    <p class="text-[10px] text-on-surface-variant">{m.home_mapped_roles()}</p>
                  </div>
                </div>
                <p class="text-[10px] text-on-surface-variant text-center">
                  {link.enabled ? m.home_link_active() : m.home_link_disabled()}
                </p>
              </div>
            {:else}
              <div class="space-y-2 grow flex flex-col justify-center">
                <div class="flex flex-col items-center justify-center py-4 text-center text-on-surface-variant/40">
                  <Papicon icon="shield" size={18} class="mb-1 text-blue-500/50" />
                  <p class="text-[11px]">{m.home_no_staff_server()}</p>
                  <p class="text-[10px] mt-0.5">{m.home_link_staff_hint()}</p>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Floating Actions -->
  <div class="home-floating-actions fixed bottom-6 right-6 z-100 flex items-center gap-3">
    {#if !isEditing}
      <button
        onclick={() => isEditing = true}
        class="w-14 h-14 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-lg hover:bg-primary/95 transition-all active:scale-[0.98] group relative cursor-pointer"
        title={m.home_edit_layout()}
      >
        <Papicon icon="edit" size={24} />
        <span class="absolute bottom-16 bg-surface-container border border-outline-variant px-2.5 py-1 rounded-md text-xs text-on-surface shadow-sm opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          {m.home_edit_layout()}
        </span>
      </button>
    {:else}
      <!-- Reset -->
      <button
        onclick={() => showResetConfirm = true}
        class="w-11 h-11 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 flex items-center justify-center shadow-lg hover:bg-red-500 hover:text-white transition-all active:scale-[0.98] group relative cursor-pointer"
        title={m.common_reset()}
      >
        <Papicon icon="rotate-ccw" size={18} />
        <span class="absolute bottom-14 bg-surface-container border border-outline-variant px-2.5 py-1 rounded-md text-xs text-on-surface shadow-sm opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          {m.common_reset()}
        </span>
      </button>

      <!-- Presets -->
      <button
        onclick={() => { showPresetsModal = true; loadPresets(); }}
        class="w-11 h-11 rounded-full bg-surface-container border border-outline-variant text-on-surface-variant flex items-center justify-center shadow-lg hover:bg-surface-container-high hover:text-on-surface transition-all active:scale-[0.98] group relative cursor-pointer"
        title="Presets"
      >
        <Papicon icon="layers" size={18} />
        <span class="absolute bottom-14 bg-surface-container border border-outline-variant px-2.5 py-1 rounded-md text-xs text-on-surface shadow-sm opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          Presets
        </span>
      </button>

      <!-- Export -->
      <button
        onclick={exportCurrentLayout}
        class="w-11 h-11 rounded-full bg-surface-container border border-outline-variant text-on-surface-variant flex items-center justify-center shadow-lg hover:bg-surface-container-high hover:text-on-surface transition-all active:scale-[0.98] group relative cursor-pointer"
        title={m.common_export()}
      >
        <Papicon icon="download" size={18} />
        <span class="absolute bottom-14 bg-surface-container border border-outline-variant px-2.5 py-1 rounded-md text-xs text-on-surface shadow-sm opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          {m.common_export()}
        </span>
      </button>

      <!-- Validate -->
      <button
        onclick={saveLayout}
        class="w-14 h-14 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-lg hover:bg-emerald-600 transition-all active:scale-[0.98] group relative cursor-pointer"
        title={m.home_validate_changes()}
      >
        <Papicon icon="check" size={24} />
        <span class="absolute bottom-16 bg-surface-container border border-outline-variant px-2.5 py-1 rounded-md text-xs text-on-surface shadow-sm opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          {m.common_save()}
        </span>
      </button>
    {/if}
  </div>

  <!-- Add Module Modal -->
  {#if showAddModuleModal}
    <div class="modal-backdrop" onclick={() => showAddModuleModal = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) showAddModuleModal = false; }}>
      <div class="modal-panel modal-panel-lg" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <div class="flex items-center justify-between border-b border-outline-variant pb-3 mb-4">
          <h2 class="text-base font-semibold text-on-surface flex items-center gap-2">
            <Papicon icon="plus-circle" size={18} class="text-primary" /> {m.home_module_library()}
          </h2>
          <button
            onclick={() => showAddModuleModal = false}
            class="p-1 rounded-full text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
          >
            <Papicon icon="close" size={16} />
          </button>
        </div>

        <p class="text-xs text-on-surface-variant mb-4">
          {m.home_library_hint()}
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
          {#each MODULE_CATALOG as mod}
            {@const isVisible = userLayout.find(item => item.id === mod.id)?.visible}
            <div class="p-4 rounded-xl border border-outline-variant bg-surface-container-lowest hover:border-primary/40 transition-all flex flex-col justify-between gap-3 {isVisible ? 'opacity-65' : ''}">
              <div>
                <div class="flex items-center gap-2.5 mb-1.5">
                  <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                    <Papicon icon={mod.icon} size={16} />
                  </div>
                  <h4 class="font-medium text-xs text-on-surface">{mod.title}</h4>
                </div>
                <p class="text-[11px] text-on-surface-variant leading-normal">{mod.desc}</p>
              </div>
              
              <div class="flex justify-end pt-1">
                {#if isVisible}
                  <span class="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-1 rounded">
                    <Papicon icon="check" size={10} /> {m.home_already_visible()}
                  </span>
                {:else}
                  <button
                    onclick={() => { addModule(mod.id); showAddModuleModal = false; }}
                    class="px-2.5 py-1 bg-primary text-white text-[10px] font-medium rounded hover:bg-primary-container hover:text-on-primary-container transition-colors cursor-pointer"
                  >
                    {m.common_add()}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <!-- Reset Confirmation Modal -->
  {#if showResetConfirm}
    <div class="modal-backdrop" onclick={() => showResetConfirm = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) showResetConfirm = false; }}>
      <div class="modal-panel max-w-sm" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <div class="flex items-center gap-3 text-amber-400 mb-3">
          <div class="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
            <Papicon icon="warning" size={20} />
          </div>
          <h3 class="font-semibold text-sm text-on-surface">{m.home_reset_layout_q()}</h3>
        </div>
        <p class="text-xs text-on-surface-variant leading-normal mb-5">
          {m.home_reset_layout_warn()}
        </p>
        <div class="flex justify-end gap-2.5">
          <button
            onclick={() => showResetConfirm = false}
            class="px-3.5 py-2 text-xs font-medium bg-surface-container hover:bg-surface-container-high rounded-lg text-on-surface transition-colors cursor-pointer"
          >
            {m.common_cancel()}
          </button>
          <button
            onclick={resetLayout}
            class="px-3.5 py-2 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors cursor-pointer"
          >
            {m.common_confirm()}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Presets Modal -->
  {#if showPresetsModal}
    <div class="modal-backdrop" onclick={() => showPresetsModal = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) showPresetsModal = false; }}>
      <div class="modal-panel modal-panel-lg" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <div class="flex items-center justify-between border-b border-outline-variant pb-3 mb-4">
          <h2 class="text-base font-semibold text-on-surface flex items-center gap-2">
            <Papicon icon="layers" size={18} class="text-primary" /> {m.home_layout_presets()}
          </h2>
          <button
            onclick={() => showPresetsModal = false}
            class="p-1 rounded-full text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
          >
            <Papicon icon="close" size={16} />
          </button>
        </div>

        <!-- Save current layout as preset -->
        <div class="p-4 rounded-xl border border-outline-variant bg-surface-container-lowest mb-4">
          <h3 class="text-xs font-medium text-on-surface mb-3 flex items-center gap-2">
            <Papicon icon="save" size={14} class="text-primary" /> {m.home_save_current_layout()}
          </h3>
          <div class="flex gap-2">
            <input
              type="text"
              bind:value={presetName}
              placeholder={m.home_preset_name_ph()}
              class="grow px-3 py-2 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none focus:border-primary/50 text-on-surface"
            />
            <input
              type="text"
              bind:value={presetDescription}
              placeholder={m.home_preset_desc_ph()}
              class="grow px-3 py-2 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none focus:border-primary/50 text-on-surface"
            />
            <button
              onclick={saveAsPreset}
              class="px-4 py-2 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary/90 transition-colors cursor-pointer shrink-0"
            >
              {m.common_save()}
            </button>
          </div>
        </div>

        <!-- Import section -->
        <div class="p-4 rounded-xl border border-outline-variant bg-surface-container-lowest mb-4">
          <h3 class="text-xs font-medium text-on-surface mb-3 flex items-center gap-2">
            <Papicon icon="upload" size={14} class="text-secondary" /> {m.home_import_preset_json()}
          </h3>
          <div class="flex gap-2">
            <textarea
              bind:value={presetImportJson}
              placeholder={m.home_paste_json_ph() + ' {"name": "...", "layout": [...]}'}
              class="grow px-3 py-2 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none focus:border-primary/50 text-on-surface min-h-[60px] resize-none"
            ></textarea>
            <button
              onclick={importPresetFromJson}
              class="px-4 py-2 bg-secondary text-white text-xs font-medium rounded-lg hover:bg-secondary/90 transition-colors cursor-pointer shrink-0 self-end"
            >
              {m.common_import()}
            </button>
          </div>
        </div>

        <!-- Saved presets list -->
        <h3 class="text-xs font-medium text-on-surface mb-3 flex items-center gap-2">
          <Papicon icon="list" size={14} class="text-on-surface-variant" /> {m.home_my_presets()}
        </h3>
        <div class="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
          {#if loadingPresets}
            {#each Array(3) as _}
              <div class="h-16 animate-pulse bg-surface-container-high rounded-xl"></div>
            {/each}
          {:else if presets.length > 0}
            {#each presets as preset}
              <div class="p-3 rounded-xl border border-outline-variant bg-surface-container-lowest hover:border-primary/30 transition-colors flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <h4 class="text-xs font-medium text-on-surface truncate">{preset.name}</h4>
                  {#if preset.description}
                    <p class="text-[10px] text-on-surface-variant truncate mt-0.5">{preset.description}</p>
                  {/if}
                  <p class="text-[9px] text-on-surface-variant/60 mt-0.5">
                    {Array.isArray(preset.layout) ? preset.layout.length : '?'} modules · {new Date(preset.createdAt).toLocaleDateString(dateLocale())}
                  </p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button
                    onclick={() => applyPreset(preset.id)}
                    title={m.us_apply()}
                    class="p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                  >
                    <Papicon icon="check" size={12} />
                  </button>
                  <button
                    onclick={() => sharePreset(preset.id)}
                    title={m.home_share_link()}
                    class="p-1.5 rounded-md bg-surface-container text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer"
                  >
                    <Papicon icon="share-2" size={12} />
                  </button>
                  <button
                    onclick={() => exportPreset(preset)}
                    title={m.home_export_json()}
                    class="p-1.5 rounded-md bg-surface-container text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer"
                  >
                    <Papicon icon="download" size={12} />
                  </button>
                  <button
                    onclick={() => removePreset(preset.id)}
                    title={m.common_delete()}
                    class="p-1.5 rounded-md text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                  >
                    <Papicon icon="trash" size={12} />
                  </button>
                </div>
              </div>
            {/each}
          {:else}
            <div class="flex flex-col items-center justify-center py-8 text-on-surface-variant/40">
              <Papicon icon="layers" size={24} class="mb-2" />
              <p class="text-xs">{m.home_no_presets()}</p>
              <p class="text-[10px] mt-0.5">{m.home_no_presets_hint()}</p>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
