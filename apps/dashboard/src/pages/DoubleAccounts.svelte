<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { fetchLinkedAccounts, updateLinkedAccountStatus, deleteLinkedAccount, fetchMemberCase, fetchFeatureConfigurations, updateFeatureConfiguration, updateModuleStatus, scanSuspectedDetections, fetchSuspectedDetections, fetchChannelsManagementConfig, updateChannelsManagementConfig, linkDetectedAccount, dismissDetection, restoreDetection, fetchMessageLogStats, updateMessageLogConfig } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m } from '../lib/i18n';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';

  // ── Tabs ──
  type Tab = 'links' | 'detections' | 'network' | 'verification' | 'config';
  const daTabs = ['links', 'detections', 'network', 'verification', 'config'] as const;
  let activeTab = $state<Tab>('links');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/security/accounts', daTabs, 'links') as Tab;
  });

  // ── Scanning ──
  let scanning = $state(false);
  let thresholdDays = $state(3);

  async function triggerRescan() {
    if (!authStore.selectedGuildId) return;
    scanning = true;
    try {
      const res = await scanSuspectedDetections(thresholdDays, authStore.selectedGuildId);
      if (res?.success) {
        toast.success(m.da_scan_done({ scanned: res.scannedCount, flagged: res.flaggedCount }));
      }
      await Promise.all([loadData(), loadDetections()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.da_scan_error());
    } finally {
      scanning = false;
    }
  }

  // ── Détection intelligente : opt-in logging des messages (télémétrie) ──
  let messageLoggingEnabled = $state<boolean | null>(null);
  let showLoggingModal = $state(false);
  let loggingBusy = $state(false);

  async function checkMessageLogging() {
    if (!authStore.selectedGuildId) return;
    try {
      const stats = await fetchMessageLogStats(authStore.selectedGuildId);
      messageLoggingEnabled = stats?.enabled ?? false;
      // Propose l'activation une seule fois (par serveur) si c'est désactivé.
      const dismissKey = `dc_logging_prompt_dismissed_${authStore.selectedGuildId}`;
      if (!messageLoggingEnabled && !localStorage.getItem(dismissKey)) {
        showLoggingModal = true;
      }
    } catch {
      messageLoggingEnabled = null;
    }
  }

  async function enableMessageLogging() {
    if (!authStore.selectedGuildId) return;
    loggingBusy = true;
    try {
      const res = await updateMessageLogConfig({ enabled: true }, authStore.selectedGuildId);
      if (res?.enabled) {
        messageLoggingEnabled = true;
        showLoggingModal = false;
        toast.success(m.da_telemetry_on());
      } else {
        toast.error(m.da_logging_error());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.da_logging_error());
    } finally {
      loggingBusy = false;
    }
  }

  function dismissLoggingModal() {
    showLoggingModal = false;
    try {
      if (authStore.selectedGuildId) {
        localStorage.setItem(`dc_logging_prompt_dismissed_${authStore.selectedGuildId}`, '1');
      }
    } catch { /* localStorage indisponible */ }
  }

  // ── Linked Accounts ──
  let linkedAccounts = $state<any[]>([]);
  let loading = $state(true);
  let error = $state('');
  let filterStatus = $state<'ALL' | 'PENDING' | 'VALIDATED' | 'REJECTED'>('ALL');

  const filteredAccounts = $derived(
    Array.isArray(linkedAccounts)
      ? filterStatus === 'ALL' ? linkedAccounts : linkedAccounts.filter(a => a.status === filterStatus)
      : []
  );

  async function loadData() {
    loading = true;
    error = '';
    try {
      const res = await fetchLinkedAccounts();
      linkedAccounts = res?.data ?? [];
    }
    catch (err: any) { error = err.message || m.da_error_load(); }
    finally { loading = false; }
  }

  // ── Detections ──
  type DetectionReason = { type: string; label: string; score: number; matchedUserId?: string; detail?: string };
  type SuspectedAlt = { userId: string; username: string | null; avatarUrl: string | null };
  type DetectionItem = {
    id: string; userId: string; username: string | null; displayName: string | null; avatarUrl: string | null;
    isBot: boolean; accountCreatedAt: string | null; guildJoinedAt: string | null;
    guildLeftAt: string | null; lastSeenAt: string | null; messageCount: number;
    isOnServer: boolean; presenceStatus: string | null; accountAgeMs: number | null; accountAgeLabel: string;
    suspectedAlts: SuspectedAlt[];
    evidence: { reasons: DetectionReason[]; totalScore: number } | null;
  };

  let detections = $state<DetectionItem[]>([]);
  let loadingDetections = $state(true);
  let reportModalDetection = $state<DetectionItem | null>(null);

  const detectionStats = $derived({
    total: detections.length,
    onServer: detections.filter(d => d.isOnServer).length,
    left: detections.filter(d => !d.isOnServer).length,
  });

  function scoreColor(score: number): string {
    if (score >= 60) return 'text-rose-500';
    if (score >= 30) return 'text-amber-500';
    return 'text-yellow-500';
  }

  function scoreBg(score: number): string {
    if (score >= 60) return 'bg-rose-500/10 border-rose-500/20';
    if (score >= 30) return 'bg-amber-500/10 border-amber-500/20';
    return 'bg-yellow-500/10 border-yellow-500/20';
  }

  async function handleLinkDetection(detection: DetectionItem, altUserId: string) {
    await saveAction.run(async () => {
      const ok = await linkDetectedAccount(detection.id, altUserId);
      if (!ok) throw new Error(m.da_error());
      await Promise.all([loadData(), loadDetections()]);
      return true;
    }, { successMessage: m.da_linked_success() });
  }

  async function handleDismissDetection(detection: DetectionItem) {
    const index = detections.findIndex(d => d.id === detection.id);
    const done = await saveAction.run(async () => {
      const ok = await dismissDetection(detection.id);
      if (!ok) throw new Error(m.da_error());
      detections = detections.filter(d => d.id !== detection.id);
      return true;
    }, { successMessage: '' });
    if (!done) return;

    // Toast de confirmation avec possibilité d'annuler (durée allongée).
    toast.success(m.da_detection_dismissed(), 10000, {
      label: m.da_undo(),
      onClick: async () => {
        const ok = await restoreDetection(detection.id);
        if (!ok) {
          toast.error(m.da_undo_error());
          return;
        }
        // Réinsère la détection à sa position d'origine si elle a disparu.
        if (!detections.some(d => d.id === detection.id)) {
          const at = Math.min(index < 0 ? detections.length : index, detections.length);
          detections = [...detections.slice(0, at), detection, ...detections.slice(at)];
        }
        toast.info(m.da_detection_restored());
      },
    });
  }

  async function loadDetections() {
    if (!authStore.selectedGuildId) return;
    loadingDetections = true;
    try {
      const res = await fetchSuspectedDetections(authStore.selectedGuildId);
      detections = res?.detections ?? [];
    } catch { detections = []; }
    finally { loadingDetections = false; }
  }

  function formatRelative(value: string | null) {
    if (!value) return 'Inconnue';
    const diffMs = Date.now() - new Date(value).getTime();
    if (Number.isNaN(diffMs)) return 'Inconnue';
    const minutes = Math.max(1, Math.floor(diffMs / 60000));
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `il y a ${days}j`;
    return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── Modal ──
  let modalOpen = $state(false);
  let selectedUserId = $state<string | null>(null);
  let selectedUserName = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  async function openMemberCase(userId: string, userName?: string) {
    selectedUserId = userId;
    selectedUserName = userName || 'Membre';
    modalOpen = true;
    loadingCase = true;
    caseData = null;
    caseError = '';
    try { caseData = await fetchMemberCase(userId); }
    catch (err: any) { caseError = err.message || m.da_error_load_case(); }
    finally { loadingCase = false; }
  }

  // ── Config ──
  let doubleAccountsConfig = $state<any>(null);
  let workflowDraft = $state({ validationRoleId: '', sanctionRoleId: '', dsRoleId: '', autoDetectionEnabled: true });
  let savedConfig = $state({ enabled: false, validationRoleId: '', sanctionRoleId: '', dsRoleId: '', autoDetectionEnabled: true });
  const saveAction = createAsyncActionState();

  $effect(() => {
    if (!doubleAccountsConfig) return;
    const current = JSON.stringify({ enabled: doubleAccountsConfig.enabled, ...workflowDraft });
    const saved = JSON.stringify(savedConfig);
    if (current !== saved) {
      untrack(() => {
        unsavedChanges.register({
          id: 'double-accounts',
          label: m.da_unsaved_label(),
          onSave: () => saveConfig(),
          onReset: () => {
            doubleAccountsConfig.enabled = savedConfig.enabled;
            workflowDraft = { validationRoleId: savedConfig.validationRoleId, sanctionRoleId: savedConfig.sanctionRoleId, dsRoleId: savedConfig.dsRoleId, autoDetectionEnabled: savedConfig.autoDetectionEnabled };
          }
        });
      });
    } else {
      untrack(() => { unsavedChanges.release('double-accounts'); });
    }
  });

  onDestroy(() => { unsavedChanges.release('double-accounts'); });

  async function loadConfig() {
    try {
      const configs = await fetchFeatureConfigurations();
      doubleAccountsConfig = configs?.features?.find((c: any) => c.featureKey === 'double_accounts') || null;
      if (doubleAccountsConfig) {
        // `meta` et non `m` : ce nom masquait les messages i18n dans toute la
        // fonction, et le premier `m.xxx()` ajoute ici aurait lu la metadonnee.
        const meta = doubleAccountsConfig.metadata || {};
        workflowDraft = { validationRoleId: meta.validationRoleId || '', sanctionRoleId: meta.sanctionRoleId || '', dsRoleId: meta.dsRoleId || '', autoDetectionEnabled: meta.autoDetectionEnabled ?? true };
        savedConfig = { enabled: doubleAccountsConfig.enabled, ...workflowDraft };
      }
    } catch {}
  }

  async function saveConfig(): Promise<boolean> {
    if (!doubleAccountsConfig) return false;
    let success = false;
    await saveAction.run(async () => {
      // L'activation part par sa propre route : le serveur y attache la cascade
      // des dependances, le controle de l'offre et la purge du cache d'etats. La
      // route de configuration ne fait qu'ecrire la colonne, ce qui donnait une
      // pastille juste et un bot qui n'avait rien change.
      if (doubleAccountsConfig.enabled !== savedConfig.enabled) {
        const toggled = await updateModuleStatus(
          'double_accounts',
          doubleAccountsConfig.enabled ? 'active' : 'inactive'
        );
        if (!toggled) throw new Error(m.da_error_api());
      }

      const ok = await updateFeatureConfiguration('double_accounts', {
        channelId: doubleAccountsConfig.channelId, secondaryChannelId: doubleAccountsConfig.secondaryChannelId,
        notificationRoleId: doubleAccountsConfig.notificationRoleId,
        notifyViaDiscordChannel: doubleAccountsConfig.notifyViaDiscordChannel, notifyViaDM: doubleAccountsConfig.notifyViaDM,
        metadata: workflowDraft,
      });
      if (!ok) throw new Error(m.da_error_api());
      await loadConfig();
      success = true;
      return true;
    }, { successMessage: m.da_config_updated() });
    return success;
  }

  async function handleUpdateStatus(id: string, status: 'VALIDATED' | 'REJECTED') {
    await saveAction.run(async () => {
      const updated = await updateLinkedAccountStatus(id, status);
      if (!updated) return false;
      await loadData();
      return true;
    }, { successMessage: m.da_status_updated() });
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog.danger(m.da_delete_link_confirm()))) return;
    await saveAction.run(async () => {
      const ok = await deleteLinkedAccount(id);
      if (!ok) return false;
      linkedAccounts = linkedAccounts.filter(a => a.id !== id);
      return true;
    }, { successMessage: m.da_link_deleted() });
  }
  // ── Verification Config ──
  let verifConfig = $state<{
    verificationEnabled: boolean;
    verificationMode: string;
    verificationAction: string;
    verificationChannelId: string | null;
    verificationFallbackChannelId: string | null;
    verificationRoleId: string | null;
    verificationLogChannelId: string | null;
    verificationEmbedTitle: string;
    verificationEmbedDesc: string;
    verificationEmbedColor: string;
    verificationOnJoin: boolean;
    verificationSaveIp: boolean;
    verificationSaveDevice: boolean;
    verificationLevelCommand: string;
    verificationLevelJoin: string;
    verificationWarnThreshold: number | null;
    warnWeightingEnabled: boolean;
    warnDecayDays: number | null;
    countArchivedInWarnScore: boolean;
    warnAutoArchiveDays: number | null;
    wordStatsEnabled: boolean;
    banHygieneEnabled: boolean;
    verificationWarnAutoMode: string;
    verificationWarnReason: string;
  } | null>(null);
  let deployingEmbed = $state(false);

  async function loadVerifConfig() {
    try {
      const data = await fetchChannelsManagementConfig();
      if (data) {
        verifConfig = {
          verificationEnabled: data.verificationEnabled ?? false,
          verificationMode: data.verificationMode ?? 'EMBED',
          verificationAction: data.verificationAction ?? 'NOTIFY_STAFF',
          verificationChannelId: data.verificationChannelId ?? null,
          verificationFallbackChannelId: data.verificationFallbackChannelId ?? null,
          verificationRoleId: data.verificationRoleId ?? null,
          verificationLogChannelId: data.verificationLogChannelId ?? null,
          verificationEmbedTitle: data.verificationEmbedTitle ?? m.da_default_embed_title(),
          verificationEmbedDesc: data.verificationEmbedDesc ?? '',
          verificationEmbedColor: data.verificationEmbedColor ?? '#5865F2',
          verificationOnJoin: data.verificationOnJoin ?? true,
          verificationSaveIp: data.verificationSaveIp ?? true,
          verificationSaveDevice: data.verificationSaveDevice ?? true,
          verificationLevelCommand: data.verificationLevelCommand ?? 'HIGH',
          verificationLevelJoin: data.verificationLevelJoin ?? 'HIGH',
          verificationWarnThreshold: data.verificationWarnThreshold ?? null,
          warnWeightingEnabled: data.warnWeightingEnabled ?? false,
          warnDecayDays: data.warnDecayDays ?? null,
          countArchivedInWarnScore: data.countArchivedInWarnScore ?? false,
          warnAutoArchiveDays: data.warnAutoArchiveDays ?? null,
          wordStatsEnabled: data.wordStatsEnabled ?? false,
          banHygieneEnabled: data.banHygieneEnabled ?? true,
          verificationWarnAutoMode: data.verificationWarnAutoMode ?? 'FULL_AUTO',
          verificationWarnReason: data.verificationWarnReason ?? m.da_default_warn_reason(),
        };
      }
    } catch {}
  }

  async function saveVerifConfig() {
    if (!verifConfig) return;
    await saveAction.run(async () => {
      const ok = await updateChannelsManagementConfig(verifConfig!);
      if (!ok) throw new Error(m.da_error_api());
      return true;
    }, { successMessage: m.da_verif_updated() });
  }

  async function deployVerifEmbed() {
    if (!verifConfig?.verificationChannelId || !authStore.selectedGuildId) return;
    deployingEmbed = true;
    try {
      const res = await fetch(`${(import.meta.env.VITE_API_URL ?? '').trim().replace(/\/$/, '')}/api/verify/${authStore.selectedGuildId}/deploy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authStore.token}` },
        body: JSON.stringify({ channelId: verifConfig.verificationChannelId }),
      });
      const data = await res.json();
      if (res.ok) toast.success(m.da_embed_sent());
      else toast.error(data.error || m.da_embed_send_error());
    } catch { toast.error(m.da_embed_deploy_error()); }
    finally { deployingEmbed = false; }
  }

  // ── Network Graph states ──
  type GraphNode = { id: string; label: string; avatar: string | null; score: number; type: 'suspect' | 'alt'; x: number; y: number; vx: number; vy: number };
  type GraphLink = { source: string; target: string; reasons: DetectionReason[]; score: number };

  let graphNodes = $state<GraphNode[]>([]);
  let graphLinks = $state<GraphLink[]>([]);
  let draggedNode = $state<GraphNode | null>(null);
  let hoveredLink = $state<GraphLink | null>(null);
  let hoveredNode = $state<GraphNode | null>(null);
  let simulationActive = $state(false);
  let svgElement = $state<SVGElement | null>(null);

  function initNetworkGraph() {
    const nodesMap = new Map<string, GraphNode>();
    const linksList: GraphLink[] = [];

    // 1. Collect nodes
    for (const d of detections) {
      if (!nodesMap.has(d.userId)) {
        nodesMap.set(d.userId, {
          id: d.userId,
          label: d.displayName || d.username || d.userId,
          avatar: d.avatarUrl,
          score: d.evidence?.totalScore || 0,
          type: 'suspect',
          x: 200 + Math.random() * 400,
          y: 150 + Math.random() * 200,
          vx: 0,
          vy: 0
        });
      }

      if (d.suspectedAlts) {
        for (const alt of d.suspectedAlts) {
          if (!nodesMap.has(alt.userId)) {
            nodesMap.set(alt.userId, {
              id: alt.userId,
              label: alt.username || alt.userId,
              avatar: alt.avatarUrl,
              score: 0,
              type: 'alt',
              x: 200 + Math.random() * 400,
              y: 150 + Math.random() * 200,
              vx: 0,
              vy: 0
            });
          }

          // 2. Build link if not exists
          const exists = linksList.some(l => 
            (l.source === d.userId && l.target === alt.userId) || 
            (l.source === alt.userId && l.target === d.userId)
          );
          if (!exists) {
            const reasonsForAlt = d.evidence?.reasons.filter(r => r.matchedUserId === alt.userId) || [];
            linksList.push({
              source: d.userId,
              target: alt.userId,
              reasons: reasonsForAlt,
              score: d.evidence?.totalScore || 0
            });
          }
        }
      }
    }

    graphNodes = Array.from(nodesMap.values());
    graphLinks = linksList;

    // Start simulation
    if (graphNodes.length > 0) {
      simulationActive = true;
      runSimulation();
    }
  }

  function runSimulation() {
    if (!simulationActive) return;
    
    // Simple force layout
    const cx = 400;
    const cy = 250;
    const kAttraction = 0.04; // Spring constant
    const targetDist = 140; // Target distance

    // 1. Node repulsion
    for (let i = 0; i < graphNodes.length; i++) {
      for (let j = i + 1; j < graphNodes.length; j++) {
        const n1 = graphNodes[i];
        const n2 = graphNodes[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 180) {
          const force = (180 - dist) * 0.05;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          n1.vx -= fx;
          n1.vy -= fy;
          n2.vx += fx;
          n2.vy += fy;
        }
      }
    }

    // 2. Link attraction
    for (const link of graphLinks) {
      const s = graphNodes.find(n => n.id === link.source);
      const t = graphNodes.find(n => n.id === link.target);
      if (s && t) {
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - targetDist) * kAttraction;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
      }
    }

    // 3. Gravity to center & bounds clamp
    for (const n of graphNodes) {
      if (n === draggedNode) continue;
      
      const dx = cx - n.x;
      const dy = cy - n.y;
      n.vx += dx * 0.008;
      n.vy += dy * 0.008;

      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.82; // friction
      n.vy *= 0.82;

      // Boundaries
      n.x = Math.max(30, Math.min(770, n.x));
      n.y = Math.max(30, Math.min(470, n.y));
    }

    if (activeTab === 'network' && simulationActive) {
      requestAnimationFrame(runSimulation);
    }
  }

  function handleSvgMouseMove(e: MouseEvent) {
    if (draggedNode && svgElement) {
      const rect = svgElement.getBoundingClientRect();
      draggedNode.x = e.clientX - rect.left;
      draggedNode.y = e.clientY - rect.top;
      draggedNode.vx = 0;
      draggedNode.vy = 0;
    }
  }

  function handleNodeDragStart(node: GraphNode) {
    draggedNode = node;
  }

  function handleNodeDragEnd() {
    draggedNode = null;
  }

  $effect(() => {
    if (activeTab === 'network') {
      untrack(() => {
        initNetworkGraph();
      });
    } else {
      simulationActive = false;
    }
  });

  onMount(() => {
    loadData(); loadDetections(); loadConfig(); loadVerifConfig(); checkMessageLogging();
  });
</script>

<ModulePage
  title={m.da_page_title()}
  description={m.da_page_desc()}
  icon="shield"
  featureKey="double_accounts"
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
      <button
        onclick={triggerRescan}
        disabled={scanning || loading}
        class="flex items-center gap-1.5 bg-primary text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:opacity-90 transition-all disabled:opacity-50"
      >
        {#if scanning}
          <div class="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
        {:else}
          <Papicon icon="ShieldAlert" size={13} />
        {/if}
        <span class="hidden sm:inline">{m.da_rescan()}</span>
      </button>
      <RefreshButton onClick={() => { loadData(); loadDetections(); }} loading={loading} label={m.da_refresh()} />
    </div>
  {/snippet}

  <!-- Tab Navigation -->
  <div class="flex gap-1 rounded-lg border border-outline-variant/10 bg-surface-container-low/70 p-1 mb-6 overflow-x-auto">
    {#each [
      { key: 'links', label: m.da_tab_links(), icon: 'Link2' },
      { key: 'detections', label: m.da_tab_detections(), icon: 'ShieldAlert', count: detections.length },
      { key: 'network', label: m.da_tab_network(), icon: 'GitMerge' },
      { key: 'verification', label: m.da_tab_verification(), icon: 'ShieldCheck' },
      { key: 'config', label: m.da_tab_config(), icon: 'Settings' },
    ] as tab (tab.key)}
      <button
        onclick={() => gotoTab('/security/accounts', tab.key, 'links')}
        class="tab-button {activeTab === tab.key ? 'active' : ''}"
      >
        <Papicon icon={tab.icon} size={14} />
        <span>{tab.label}</span>
        {#if tab.count}
          <span class="tab-button {activeTab === tab.key ? 'active' : ''}">{tab.count}</span>
        {/if}
      </button>
    {/each}
  </div>

  <!-- ═══ TAB: Liaisons ═══ -->
  {#if activeTab === 'links'}
    <div class="flex flex-wrap items-center gap-2 mb-6">
      {#each [
        { key: 'ALL', label: m.da_filter_all(), color: 'text-primary' },
        { key: 'PENDING', label: m.da_filter_pending(), color: 'text-amber-500' },
        { key: 'VALIDATED', label: m.da_filter_validated(), color: 'text-emerald-500' },
        { key: 'REJECTED', label: m.da_filter_rejected(), color: 'text-rose-500' },
      ] as f (f.key)}
        <button
          onclick={() => filterStatus = f.key as any}
          class="rounded-lg px-3 py-1.5 text-xs font-bold transition-all {filterStatus === f.key ? `bg-surface ${f.color} shadow-sm` : 'text-on-surface-variant/50 hover:text-on-surface'}"
        >
          {f.label}
        </button>
      {/each}
    </div>

    {#if loading}
      <div class="flex flex-col items-center py-20 gap-3">
        <div class="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent"></div>
        <p class="text-xs text-on-surface-variant/50">{m.da_loading()}</p>
        <LoadingHint context="data" />
      </div>
    {:else if error}
      <div class="rounded-lg border border-rose-500/20 bg-rose-500/5 p-6 text-center">
        <p class="text-rose-500 font-bold text-sm">{error}</p>
        <button onclick={loadData} class="mt-3 text-xs font-semibold text-primary">{m.da_retry()}</button>
      </div>
    {:else if filteredAccounts.length === 0}
      <div class="flex flex-col items-center py-20 text-center">
        <div class="h-14 w-14 rounded-xl bg-surface-container-low flex items-center justify-center text-on-surface-variant/20">
          <Papicon icon="link-2-off" size={28} />
        </div>
        <h3 class="mt-5 text-base font-bold text-on-surface">{m.da_no_link()}</h3>
        <p class="mt-1 text-xs text-on-surface-variant/50 max-w-xs">
          {filterStatus === 'ALL' ? m.da_no_linked_account() : m.da_no_link_filtered({ status: filterStatus })}
        </p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each filteredAccounts as link (link.id)}
          <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4 transition-all hover:border-primary/20">
            <!-- Header: status + date -->
            <div class="flex items-center justify-between mb-3">
              <span class="px-2 py-0.5 rounded text-xs font-medium
 {link.status === 'VALIDATED' ? 'bg-emerald-500/10 text-emerald-500' : link.status === 'PENDING' ? 'bg-amber-500/10 text-amber-500' : 'bg-rose-500/10 text-rose-500'}">
                {link.status === 'VALIDATED' ? m.da_link_validated() : link.status === 'PENDING' ? m.da_link_pending() : m.da_link_rejected()}
              </span>
              <span class="text-[10px] text-on-surface-variant/30">{new Date(link.createdAt).toLocaleDateString('fr-FR')}</span>
            </div>

            <!-- Users link -->
            <div class="flex items-center gap-2 bg-surface-container-low/50 rounded-lg p-3 mb-3">
              <button onclick={() => openMemberCase(link.user1Id, link.user1.tag)} class="flex items-center gap-1.5 flex-1 min-w-0 text-sm font-semibold text-on-surface hover:text-primary transition-colors">
                {#if link.user1.avatar}<img src={link.user1.avatar} alt="" class="w-5 h-5 rounded-full shrink-0" />{/if}
                <span class="truncate">@{link.user1.tag}</span>
              </button>
              <Papicon icon="ArrowLeftRight" size={14} class="text-on-surface-variant/20 shrink-0" />
              <button onclick={() => openMemberCase(link.user2Id, link.user2.tag)} class="flex items-center justify-end gap-1.5 flex-1 min-w-0 text-sm font-semibold text-on-surface hover:text-primary transition-colors">
                <span class="truncate">@{link.user2.tag}</span>
                {#if link.user2.avatar}<img src={link.user2.avatar} alt="" class="w-5 h-5 rounded-full shrink-0" />{/if}
              </button>
            </div>

            {#if link.reason}
              <p class="text-[11px] text-on-surface-variant/60 italic mb-3 px-1">"{link.reason}"</p>
            {/if}

            <!-- Actions -->
            <div class="flex items-center gap-2 pt-3 border-t border-outline-variant/5">
              {#if link.status === 'PENDING'}
                <button onclick={() => handleUpdateStatus(link.id, 'VALIDATED')} disabled={saveAction.state.loading}
                  class="flex-1 py-2 rounded-lg bg-emerald-500/10 text-emerald-500 text-xs font-medium hover:bg-emerald-500 hover:text-white transition-all flex items-center justify-center gap-1.5 disabled:opacity-50">
                  <Papicon icon="Check" size={12} /> {m.da_validate()}
                </button>
                <button onclick={() => handleUpdateStatus(link.id, 'REJECTED')} disabled={saveAction.state.loading}
                  class="flex-1 py-2 rounded-lg bg-rose-500/10 text-rose-500 text-xs font-medium hover:bg-rose-500 hover:text-white transition-all flex items-center justify-center gap-1.5 disabled:opacity-50">
                  <Papicon icon="X" size={12} /> {m.da_reject()}
                </button>
              {:else}
                <span class="flex-1 text-xs font-medium text-on-surface-variant/20">{link.type}</span>
                <button onclick={() => handleDelete(link.id)} disabled={saveAction.state.loading}
                  class="p-2 rounded-lg text-rose-500 hover:bg-rose-500/10 transition-colors disabled:opacity-50" title={m.da_delete()}>
                  <Papicon icon="Trash2" size={14} />
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

  <!-- ═══ TAB: Détections ═══ -->
  {:else if activeTab === 'detections'}
    <!-- Stats -->
    <div class="grid grid-cols-3 gap-3 mb-6">
      <div class="rounded-lg border border-outline-variant/10 bg-surface-container-low/40 p-4 text-center">
        <p class="text-xs font-medium text-on-surface-variant/40">{m.da_suspects()}</p>
        <p class="mt-1 text-xl font-bold text-on-surface">{detectionStats.total}</p>
      </div>
      <div class="rounded-lg border border-outline-variant/10 bg-surface-container-low/40 p-4 text-center">
        <p class="text-xs font-medium text-on-surface-variant/40">{m.da_present()}</p>
        <p class="mt-1 text-xl font-bold text-emerald-500">{detectionStats.onServer}</p>
      </div>
      <div class="rounded-lg border border-outline-variant/10 bg-surface-container-low/40 p-4 text-center">
        <p class="text-xs font-medium text-on-surface-variant/40">{m.da_left()}</p>
        <p class="mt-1 text-xl font-bold text-amber-500">{detectionStats.left}</p>
      </div>
    </div>

    <!-- Scan controls -->
    <div class="flex flex-wrap items-center gap-3 mb-6 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-low/30">
      <div class="flex items-center gap-2">
        <Papicon icon="SlidersHorizontal" size={14} class="text-on-surface-variant/40" />
        <label for="threshold" class="text-xs font-bold text-on-surface-variant/50">{m.da_threshold()}</label>
        <select id="threshold" bind:value={thresholdDays} class="bg-transparent border-none text-xs font-bold text-on-surface focus:outline-none cursor-pointer">
          {#each Array.from({ length: 30 }, (_, i) => i + 1) as day}
            <option value={day} class="bg-surface">{day > 1 ? m.da_day_other({ n: day }) : m.da_day_one({ n: day })}</option>
          {/each}
        </select>
      </div>
      <button onclick={triggerRescan} disabled={scanning}
        class="flex items-center gap-1.5 bg-primary text-white px-4 py-2 rounded-lg text-xs font-bold hover:opacity-90 transition-all disabled:opacity-50">
        {#if scanning}
          <div class="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
          {m.da_scanning()}
        {:else}
          <Papicon icon="ShieldAlert" size={13} /> {m.da_rescan()}
        {/if}
      </button>

      <!-- Statut de la détection intelligente (télémétrie) -->
      {#if messageLoggingEnabled === true}
        <span class="flex items-center gap-1.5 text-xs font-bold text-emerald-500">
          <Papicon icon="Sparkles" size={13} /> {m.da_smart_detection_active()}
        </span>
      {:else if messageLoggingEnabled === false}
        <button onclick={() => showLoggingModal = true}
          class="flex items-center gap-1.5 border border-primary/30 text-primary px-3 py-2 rounded-lg text-xs font-bold hover:bg-primary/10 transition-all">
          <Papicon icon="Sparkles" size={13} /> {m.da_enable_advanced()}
        </button>
      {/if}
    </div>

    {#if loadingDetections}
      <div class="space-y-3">
        {#each Array.from({ length: 4 }) as _, i (i)}
          <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
            <div class="flex items-start gap-3">
              <Skeleton width="w-10" height="h-10" rounded="rounded-lg" class="shrink-0" />
              <div class="min-w-0 flex-1 space-y-2">
                <div class="flex items-center gap-1.5">
                  <Skeleton width="w-32" height="h-4" />
                  <Skeleton width="w-12" height="h-4" rounded="rounded" />
                  <Skeleton width="w-14" height="h-4" rounded="rounded" />
                </div>
                <Skeleton width="w-48" height="h-3" />
                <Skeleton width="w-24" height="h-3" />
                <div class="flex items-center gap-1.5 pt-1">
                  <Skeleton width="w-16" height="h-4" rounded="rounded" />
                  <Skeleton width="w-20" height="h-4" rounded="rounded" />
                </div>
              </div>
            </div>
            <div class="flex gap-2 mt-3 pt-3 border-t border-outline-variant/5">
              <Skeleton width="w-full" height="h-8" class="flex-1" />
              <Skeleton width="w-full" height="h-8" class="flex-1" />
              <Skeleton width="w-16" height="h-8" />
            </div>
          </div>
        {/each}
      </div>
    {:else if detections.length === 0}
      <div class="flex flex-col items-center py-20 text-center rounded-lg border border-outline-variant/10 bg-surface-container-low/30">
        <div class="h-14 w-14 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-500">
          <Papicon icon="ShieldCheck" size={28} />
        </div>
        <h3 class="mt-5 text-base font-bold text-on-surface">{m.da_no_detection()}</h3>
        <p class="mt-1 text-xs text-on-surface-variant/50 max-w-sm">{m.da_no_suspect()}</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each detections as d (d.id)}
          <article class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4 transition-all hover:border-primary/20">
            <div class="flex items-start gap-3">
              {#if d.avatarUrl}
                <img src={d.avatarUrl} alt="" class="h-10 w-10 rounded-lg object-cover shrink-0" />
              {:else}
                <div class="h-10 w-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant/30 shrink-0">
                  <Papicon icon="User" size={18} />
                </div>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <h4 class="text-sm font-bold text-on-surface truncate">{d.displayName || d.username || d.id}</h4>
                  {#if d.evidence}
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold border {scoreBg(d.evidence.totalScore)} {scoreColor(d.evidence.totalScore)}">
                      {d.evidence.totalScore}/100
                    </span>
                  {/if}
                  <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {d.isOnServer ? 'bg-emerald-500/10 text-emerald-500' : 'bg-zinc-500/10 text-zinc-400'}">
                    {d.isOnServer ? m.da_member_present() : m.da_member_left()}
                  </span>
                </div>
                <p class="text-[11px] text-on-surface-variant/50 mt-0.5">@{d.username || m.da_unknown()} · {d.id}</p>
                <p class="text-xs text-amber-500 font-bold mt-1.5">{d.accountAgeLabel}</p>

                <!-- Suspected alts inline -->
                {#if d.suspectedAlts && d.suspectedAlts.length > 0}
                  <div class="flex flex-wrap items-center gap-1.5 mt-2">
                    <Papicon icon="Link2" size={11} class="text-on-surface-variant/30" />
                    <span class="text-[10px] font-bold text-on-surface-variant/40">Alt(s) :</span>
                    {#each d.suspectedAlts as alt}
                      <button onclick={() => openMemberCase(alt.userId, alt.username || alt.userId)}
                        class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-container-high/50 text-[10px] font-bold text-on-surface hover:text-primary transition-colors">
                        {#if alt.avatarUrl}<img src={alt.avatarUrl} alt="" class="w-3.5 h-3.5 rounded-full" />{/if}
                        @{alt.username || alt.userId}
                      </button>
                    {/each}
                  </div>
                {/if}

                <!-- Top reasons preview -->
                {#if d.evidence && d.evidence.reasons.length > 0}
                  <div class="mt-2 space-y-0.5">
                    {#each d.evidence.reasons.slice(0, 2) as r}
                      <p class="text-[10px] text-on-surface-variant/50"><span class="font-mono {scoreColor(r.score)}">{r.score}pts</span> {r.label.replace(/<@\d+>/g, (m) => { const alt = d.suspectedAlts?.find(a => m.includes(a.userId)); return alt?.username ? `@${alt.username}` : m; })}</p>
                    {/each}
                    {#if d.evidence.reasons.length > 2}
                      <p class="text-[10px] text-on-surface-variant/30">{m.da_more_signals({ count: d.evidence.reasons.length - 2 })}</p>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>

            <!-- Actions -->
            <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-outline-variant/5">
              {#if d.suspectedAlts && d.suspectedAlts.length > 0}
                <button onclick={() => { const alt = d.suspectedAlts?.[0]; if (alt) handleLinkDetection(d, alt.userId); }}
                  disabled={saveAction.state.loading}
                  class="flex-1 py-2 rounded-lg bg-emerald-500/10 text-emerald-500 text-xs font-medium hover:bg-emerald-500 hover:text-white transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 min-w-25">
                  <Papicon icon="Link2" size={12} /> {m.da_link()}
                </button>
              {/if}
              <button onclick={() => reportModalDetection = d}
                class="flex-1 py-2 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary hover:text-white transition-all flex items-center justify-center gap-1.5 min-w-25">
                <Papicon icon="FileSearch" size={12} /> {m.da_report()}
              </button>
              <button onclick={() => handleDismissDetection(d)}
                disabled={saveAction.state.loading}
                class="py-2 px-3 rounded-lg border border-outline-variant/10 text-xs font-medium text-on-surface-variant/40 hover:text-on-surface hover:border-primary/20 transition-all flex items-center justify-center gap-1.5 disabled:opacity-50">
                <Papicon icon="X" size={12} /> {m.da_ignore()}
              </button>
            </div>
          </article>
        {/each}
      </div>
    {/if}

  <!-- ═══ TAB: Réseau Visuel ═══ -->
  {:else if activeTab === 'network'}
    <div class="rounded-lg border border-outline-variant/10 bg-surface-container-low/20 p-4 mb-6">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-sm font-bold text-on-surface">{m.da_suspicious_network()}</h3>
          <p class="text-xs text-on-surface-variant/60">{m.da_graph_hint()}</p>
        </div>
        <button onclick={initNetworkGraph} class="flex items-center gap-1.5 border border-outline-variant/20 bg-surface-container-low px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-surface-container-high transition-all">
          <Papicon icon="RefreshCw" size={12} /> {m.da_reorganize()}
        </button>
      </div>

      <div class="relative w-full aspect-[8/5] bg-surface-container-lowest/80 rounded-lg overflow-hidden border border-outline-variant/10">
        <!-- SVG container -->
        <!-- Le deplacement des noeuds est une commodite souris ; la meme
             information est disponible dans le tableau ci-dessous. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <svg
          bind:this={svgElement}
          role="img"
          aria-label={m.da_graph_aria()}
          class="w-full h-full cursor-grab active:cursor-grabbing"
          onmousemove={handleSvgMouseMove}
          onmouseup={handleNodeDragEnd}
          onmouseleave={handleNodeDragEnd}
        >
          <!-- Grid lines background -->
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.02)" stroke-width="1"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />

          <!-- Link lines -->
          {#each graphLinks as link}
            {@const sourceNode = graphNodes.find(n => n.id === link.source)}
            {@const targetNode = graphNodes.find(n => n.id === link.target)}
            {#if sourceNode && targetNode}
              {@const isHovered = hoveredLink === link}
              <line
                role="img"
                aria-label={m.da_link_aria({ source: sourceNode.label, target: targetNode.label })}
                x1={sourceNode.x}
                y1={sourceNode.y}
                x2={targetNode.x}
                y2={targetNode.y}
                stroke={isHovered ? '#5865F2' : 'rgba(88, 101, 242, 0.2)'}
                stroke-width={isHovered ? 3 : 1.5}
                class="transition-all duration-150 cursor-pointer"
                onmouseenter={() => hoveredLink = link}
                onmouseleave={() => hoveredLink = null}
              />
            {/if}
          {/each}

          <!-- Nodes -->
          {#each graphNodes as node}
            {@const isHovered = hoveredNode === node}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              transform="translate({node.x}, {node.y})"
              class="cursor-pointer select-none"
              onmousedown={() => handleNodeDragStart(node)}
              onmouseenter={() => hoveredNode = node}
              onmouseleave={() => hoveredNode = null}
            >
              <!-- Outer Glow ring -->
              <circle
                r={node.type === 'suspect' ? 24 : 18}
                fill="none"
                stroke={node.type === 'suspect' ? '#ED4245' : '#3ba55d'}
                stroke-width={isHovered ? 4 : 2}
                class="transition-all duration-150"
                style="filter: drop-shadow(0 0 {isHovered ? 8 : 3}px {node.type === 'suspect' ? 'rgba(237,66,69,0.4)' : 'rgba(59,165,93,0.4)'});"
              />
              <!-- Circle background -->
              <circle r={node.type === 'suspect' ? 22 : 16} fill="#0f1219" />
              
              <!-- Avatar image if available, else letter -->
              {#if node.avatar}
                <clipPath id="clip-{node.id}">
                  <circle r={node.type === 'suspect' ? 22 : 16} />
                </clipPath>
                <image
                  href={node.avatar}
                  x={node.type === 'suspect' ? -22 : -16}
                  y={node.type === 'suspect' ? -22 : -16}
                  width={node.type === 'suspect' ? 44 : 32}
                  height={node.type === 'suspect' ? 44 : 32}
                  clip-path="url(#clip-{node.id})"
                />
              {:else}
                <text
                  text-anchor="middle"
                  dy=".3em"
                  fill="#ffffff"
                  font-size={node.type === 'suspect' ? '12' : '9'}
                  font-weight="bold"
                >
                  {node.label.slice(0, 2).toUpperCase()}
                </text>
              {/if}

              <!-- Label text -->
              <text
                y={node.type === 'suspect' ? 36 : 28}
                text-anchor="middle"
                fill={isHovered ? '#ffffff' : 'rgba(255,255,255,0.7)'}
                font-size="10"
                font-weight="600"
                class="transition-colors duration-150"
              >
                {node.label}
              </text>
            </g>
          {/each}
        </svg>

        <!-- Hover Link Tooltip overlay -->
        {#if hoveredLink}
          {@const sourceNode = graphNodes.find(n => n.id === hoveredLink.source)}
          {@const targetNode = graphNodes.find(n => n.id === hoveredLink.target)}
          {#if sourceNode && targetNode}
            <div class="absolute bottom-4 left-4 p-4 rounded-lg bg-surface-container-high/95 border border-outline-variant/20 shadow-xl max-w-sm pointer-events-none backdrop-blur-md">
              <p class="text-xs font-bold text-primary mb-1">{m.da_suspicion_proof()}</p>
              <p class="text-xs text-on-surface font-semibold mb-2">{m.da_link_label()} {sourceNode.label} ↔ {targetNode.label}</p>
              {#if hoveredLink.reasons && hoveredLink.reasons.length > 0}
                <ul class="space-y-1.5">
                  {#each hoveredLink.reasons as reason}
                    <li class="text-[10px] text-on-surface-variant leading-relaxed">
                      <span class="font-bold text-amber-500">[{reason.score}pts]</span> {reason.label}
                      {#if reason.detail}
                        <br/><span class="text-on-surface-variant/50 text-[9px]">{reason.detail}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="text-[10px] text-on-surface-variant/60 italic">{m.da_no_detail({ score: hoveredLink.score })}</p>
              {/if}
            </div>
          {/if}
        {/if}

        <!-- Hover Node Tooltip overlay -->
        {#if hoveredNode}
          <div class="absolute top-4 right-4 p-3 rounded-lg bg-surface-container-high/95 border border-outline-variant/20 shadow-xl pointer-events-none backdrop-blur-md">
            <div class="flex items-center gap-2">
              {#if hoveredNode.avatar}
                <img src={hoveredNode.avatar} alt={hoveredNode.label} class="h-8 w-8 rounded-full border border-outline-variant/20" />
              {/if}
              <div>
                <p class="text-xs font-bold text-on-surface">{hoveredNode.label}</p>
                <p class="text-[9px] text-on-surface-variant/60">ID: {hoveredNode.id}</p>
                <p class="text-[10px] mt-0.5 font-bold {hoveredNode.type === 'suspect' ? 'text-rose-400' : 'text-emerald-400'}">
                  {hoveredNode.type === 'suspect' ? m.da_suspect_score({ score: hoveredNode.score }) : m.da_alt_suspected()}
                </p>
              </div>
            </div>
          </div>
        {/if}
      </div>
    </div>

  <!-- ═══ TAB: Vérification ═══ -->
  {:else if activeTab === 'verification'}
    {#if verifConfig}
      <div class="space-y-6">
        <!-- Enable toggle -->
        <div class="flex items-center justify-between gap-4 p-4 rounded-xl border border-outline-variant/10 bg-surface-container-low/30">
          <div class="flex items-center gap-3">
            <div class="h-9 w-9 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0">
              <Papicon icon="ShieldCheck" size={18} />
            </div>
            <div>
              <p class="font-bold text-on-surface text-sm">{m.da_verification()}</p>
              <p class="text-xs text-on-surface-variant/50">{m.da_oauth_verify()}</p>
            </div>
          </div>
          <ToggleSwitch
            checked={verifConfig.verificationEnabled}
            onToggle={(v) => { verifConfig!.verificationEnabled = v; }}
            activeClass="bg-indigo-500"
          />
        </div>

        {#if verifConfig.verificationEnabled}
          <!-- Mode & Action -->
          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_send_mode()}</span>
              <select bind:value={verifConfig.verificationMode} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
                <option value="DM">{m.da_mode_dm()}</option>
                <option value="EMBED">{m.da_embed_button()}</option>
              </select>
            </label>
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_action_if_dc()}</span>
              <select bind:value={verifConfig.verificationAction} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
                <option value="NOTIFY_STAFF">{m.da_notify_staff()}</option>
                <option value="AUTO_LINK">{m.da_auto_link()}</option>
              </select>
            </label>
          </div>

          <!-- Niveaux de vérification -->
          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_level_command()}</span>
              <select bind:value={verifConfig.verificationLevelCommand} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
                <option value="LOW">{m.da_level_low()}</option>
                <option value="MEDIUM">{m.da_level_medium()}</option>
                <option value="HIGH">{m.da_level_high()}</option>
              </select>
            </label>
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_level_join()}</span>
              <select bind:value={verifConfig.verificationLevelJoin} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
                <option value="LOW">{m.da_level_low()}</option>
                <option value="MEDIUM">{m.da_level_medium()}</option>
                <option value="HIGH">{m.da_level_high()}</option>
              </select>
            </label>
          </div>


          <!-- Channels & Roles -->
          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_verify_channel()}</span>
              <SearchableSelect bind:value={verifConfig.verificationChannelId} options={dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.da_no_channel()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
            </label>
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_verified_role()}</span>
              <SearchableSelect bind:value={verifConfig.verificationRoleId} options={dashboardStore.state.discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.da_no_role()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
            </label>
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_log_channel()}</span>
              <SearchableSelect bind:value={verifConfig.verificationLogChannelId} options={dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.da_default()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
            </label>
            <label class="space-y-1.5 sm:col-span-2 lg:col-span-3">
              <span class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/40">{m.da_fallback_channel()}</span>
              <SearchableSelect bind:value={verifConfig.verificationFallbackChannelId} options={dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.da_default_verify_channel()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
              <span class="block text-[11px] text-on-surface-variant/50">{m.da_fallback_channel_desc()}</span>
            </label>
          </div>

          <!-- Embed customization -->
          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_embed_title()}</span>
              <input type="text" bind:value={verifConfig.verificationEmbedTitle} maxlength="256" class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
            </label>
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_color()}</span>
              <div class="flex items-center gap-2">
                <input type="color" bind:value={verifConfig.verificationEmbedColor} class="h-9.5 w-9.5 rounded-lg border border-outline-variant/10 bg-transparent cursor-pointer shrink-0" />
                <input type="text" bind:value={verifConfig.verificationEmbedColor} maxlength="7" class="flex-1 rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm font-mono" />
              </div>
            </label>
          </div>

          <label class="space-y-1.5">
            <span class="text-xs font-medium text-on-surface-variant/40">{m.da_description()}</span>
            <textarea bind:value={verifConfig.verificationEmbedDesc} rows="3" maxlength="2048" class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm resize-y"></textarea>
          </label>

          <!-- Auto on join -->
          <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
            <div>
              <p class="font-bold text-on-surface text-sm">{m.da_verify_on_join()}</p>
              <p class="text-xs text-on-surface-variant/50">{m.da_verify_on_join_desc()}</p>
            </div>
            <ToggleSwitch
              checked={verifConfig.verificationOnJoin}
              onToggle={(v) => { verifConfig!.verificationOnJoin = v; }}
              activeClass="bg-indigo-500"
            />
          </div>

          <!-- Save IP -->
          <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
            <div>
              <p class="font-bold text-on-surface text-sm">{m.da_save_ip()}</p>
              <p class="text-xs text-on-surface-variant/50">{m.da_save_ip_desc()}</p>
            </div>
            <ToggleSwitch
              checked={verifConfig.verificationSaveIp}
              onToggle={(v) => { verifConfig!.verificationSaveIp = v; }}
              activeClass="bg-indigo-500"
            />
          </div>

          <!-- Save Device Info -->
          <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
            <div>
              <p class="font-bold text-on-surface text-sm">{m.da_save_device_full()}</p>
              <p class="text-xs text-on-surface-variant/50">{m.da_save_device_desc()}</p>
            </div>
            <ToggleSwitch
              checked={verifConfig.verificationSaveDevice}
              onToggle={(v) => { verifConfig!.verificationSaveDevice = v; }}
              activeClass="bg-indigo-500"
            />
          </div>

          <!-- Warn Threshold Auto-Verification -->
          <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-4 space-y-4">
            <div class="flex items-center gap-2 mb-1">
              <div class="h-7 w-7 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-400 shrink-0">
                <Papicon icon="AlertTriangle" size={15} />
              </div>
              <div>
                <p class="font-bold text-on-surface text-sm">{m.da_verify_on_warns()}</p>
                <p class="text-xs text-on-surface-variant/50">{m.da_verify_on_warns_desc()}</p>
              </div>
            </div>

            <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
              <label class="space-y-1.5">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_threshold()}</span>
                <div class="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="99"
                    placeholder={m.da_disabled_zero()}
                    value={verifConfig.verificationWarnThreshold ?? ''}
                    oninput={(e) => {
                      const v = parseInt((e.target as HTMLInputElement).value);
                      verifConfig!.verificationWarnThreshold = isNaN(v) || v <= 0 ? null : v;
                    }}
                    class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
                  />
                  {#if !verifConfig.verificationWarnThreshold}
                    <span class="text-xs text-on-surface-variant/40 whitespace-nowrap">{m.da_disabled()}</span>
                  {/if}
                </div>
                <p class="text-[10px] text-on-surface-variant/40">{m.da_empty_to_disable()}</p>
              </label>

              <label class="space-y-1.5">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.da_trigger_mode()}</span>
                <select bind:value={verifConfig.verificationWarnAutoMode} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" disabled={!verifConfig.verificationWarnThreshold}>
                  <option value="FULL_AUTO">{m.da_mode_full_auto_opt()}</option>
                  <option value="NOTIFY_STAFF">{m.da_mode_notify_opt()}</option>
                </select>
              </label>
            </div>

            {#if verifConfig.verificationWarnThreshold}
              <label class="space-y-1.5 block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_reason_label()}</span>
                <input
                  type="text"
                  maxlength="512"
                  bind:value={verifConfig.verificationWarnReason}
                  class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
                />
              </label>

              <div class="flex items-start gap-2 p-3 rounded-lg bg-orange-500/5 border border-orange-500/15 text-xs text-orange-300">
                <Papicon icon="Info" size={13} class_="shrink-0 mt-0.5" />
                <span>
                  {#if verifConfig.verificationWarnAutoMode === 'FULL_AUTO'}
                    {m.da_in_mode()} <strong>{m.da_full_auto()}</strong>{m.da_full_auto_desc_1()} <strong>{verifConfig.verificationWarnThreshold > 1 ? m.da_warn_other({ n: verifConfig.verificationWarnThreshold }) : m.da_warn_one({ n: verifConfig.verificationWarnThreshold })}</strong>.
                  {:else}
                    {m.da_in_mode()} <strong>{m.da_notify_staff_mode()}</strong>{m.da_full_auto_desc_2()}
                  {/if}
                </span>
              </div>
            {/if}

            <!-- Archivage des warns : expiration automatique + poids au score -->
            <div class="pt-4 mt-2 border-t border-outline-variant/10 space-y-4">
              <label class="space-y-1.5 block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_auto_archive()}</span>
                <input
                  type="number"
                  min="0"
                  max="3650"
                  placeholder={m.da_never_zero()}
                  value={verifConfig.warnAutoArchiveDays ?? ''}
                  oninput={(e) => {
                    const v = parseInt((e.target as HTMLInputElement).value);
                    verifConfig!.warnAutoArchiveDays = isNaN(v) || v <= 0 ? null : v;
                  }}
                  class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
                />
                <p class="text-[10px] text-on-surface-variant/40">{m.da_warn_auto_archive_hint()}</p>
              </label>

              <label class="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" bind:checked={verifConfig.countArchivedInWarnScore} class="mt-0.5 accent-indigo-500" />
                <span>
                  <span class="text-sm font-medium text-on-surface block">{m.da_count_archived()}</span>
                  <span class="text-[11px] text-on-surface-variant/50 block mt-0.5">{m.da_count_archived_desc()}</span>
                </span>
              </label>
            </div>

            <!-- Warns pondérés -->
            <div class="pt-4 mt-2 border-t border-outline-variant/10 space-y-4">
              <label class="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" bind:checked={verifConfig.warnWeightingEnabled} class="mt-0.5 accent-indigo-500" />
                <span>
                  <span class="text-sm font-medium text-on-surface block">{m.da_weighted_warns()}</span>
                  <span class="text-[11px] text-on-surface-variant/50 block mt-0.5">
                    {m.da_weighted_warns_desc_1()} <code class="text-indigo-400">/sanction warn</code>. {m.da_weighted_warns_desc_2()}
                    <strong>{m.da_weighted_warns_score()}</strong> {m.da_weighted_warns_desc_3()}
                  </span>
                </span>
              </label>

              {#if verifConfig.warnWeightingEnabled}
                <label class="space-y-1.5 block">
                  <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_decay()}</span>
                  <input
                    type="number"
                    min="0"
                    max="3650"
                    placeholder={m.da_never_zero()}
                    value={verifConfig.warnDecayDays ?? ''}
                    oninput={(e) => {
                      const v = parseInt((e.target as HTMLInputElement).value);
                      verifConfig!.warnDecayDays = isNaN(v) || v <= 0 ? null : v;
                    }}
                    class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
                  />
                  <p class="text-[10px] text-on-surface-variant/40">
                    {m.da_warn_decay_hint()}
                  </p>
                </label>

                <div class="flex items-start gap-2 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/15 text-xs text-indigo-300">
                  <Papicon icon="Info" size={13} class_="shrink-0 mt-0.5" />
                  <span>
                    {m.da_threshold_hint()} <strong>{verifConfig.verificationWarnThreshold ?? '-'}</strong>,
                    {verifConfig.verificationWarnThreshold ? m.da_threshold_needed({ light: verifConfig.verificationWarnThreshold, severe: Math.ceil(verifConfig.verificationWarnThreshold / 3) }) : m.da_threshold_configure()}{verifConfig.warnDecayDays ? m.da_threshold_decay({ days: verifConfig.warnDecayDays }) : ''}.
                    {m.da_existing_warns_hint()}
                  </span>
                </div>
              {/if}
            </div>

            <!-- Statistiques de mots -->
            <div class="pt-4 mt-2 border-t border-outline-variant/10">
              <label class="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" bind:checked={verifConfig.wordStatsEnabled} class="mt-0.5 accent-indigo-500" />
                <span>
                  <span class="text-sm font-medium text-on-surface block">{m.da_word_stats()}</span>
                  <span class="text-[11px] text-on-surface-variant/50 block mt-0.5">
                    {m.da_word_stats_desc_1()} <strong>{m.da_word_stats_tab()}</strong> {m.da_word_stats_of_stats()}
                    {m.da_word_stats_privacy()}
                  </span>
                </span>
              </label>
            </div>

            <!-- Hygiène des bans -->
            <div class="pt-4 mt-2 border-t border-outline-variant/10">
              <label class="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" bind:checked={verifConfig.banHygieneEnabled} class="mt-0.5 accent-indigo-500" />
                <span>
                  <span class="text-sm font-medium text-on-surface block">{m.da_ban_hygiene()}</span>
                  <span class="text-[11px] text-on-surface-variant/50 block mt-0.5">
                    {m.da_ban_hygiene_desc_1()}
                    <strong>{m.da_ban_hygiene_deleted()}</strong>{m.da_ban_hygiene_desc_2()}
                  </span>
                </span>
              </label>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap gap-2">
            <button onclick={saveVerifConfig}
              class="px-5 py-2.5 bg-indigo-600 text-white rounded-lg text-[13px] font-medium hover:bg-indigo-500 transition-all flex items-center gap-1.5">
              <Papicon icon="Save" size={13} /> {m.da_save()}
            </button>
            {#if verifConfig.verificationMode === 'EMBED' && verifConfig.verificationChannelId}
              <button onclick={deployVerifEmbed} disabled={deployingEmbed}
                class="px-5 py-2.5 border border-indigo-500/20 text-indigo-400 rounded-lg text-[13px] font-medium hover:bg-indigo-500 hover:text-white transition-all disabled:opacity-50 flex items-center gap-1.5">
                {#if deployingEmbed}
                  <div class="h-3 w-3 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent"></div>
                  {m.da_sending()}
                {:else}
                  <Papicon icon="Send" size={13} /> {m.da_deploy_embed()}
                {/if}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex flex-col items-center py-20 gap-3">
        <div class="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent"></div>
        <p class="text-xs text-on-surface-variant/50">{m.da_loading()}</p>
      </div>
    {/if}

  <!-- ═══ TAB: Configuration ═══ -->
  {:else if activeTab === 'config'}
    {#if doubleAccountsConfig}
      <div class="space-y-6">
        <!-- Module toggle -->
        <div class="flex items-center justify-between gap-4 p-4 rounded-xl border border-outline-variant/10 bg-surface-container-low/30">
          <div class="flex items-center gap-3">
            <div class="h-9 w-9 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500 shrink-0">
              <Papicon icon="Users" size={18} />
            </div>
            <div>
              <p class="font-bold text-on-surface text-sm">{m.da_module()}</p>
              <p class="text-xs text-on-surface-variant/50">{m.da_module_desc()}</p>
            </div>
          </div>
          <ToggleSwitch
            checked={doubleAccountsConfig.enabled}
            onToggle={(v) => (doubleAccountsConfig.enabled = v)}
            activeClass="bg-emerald-500"
          />
        </div>

        <!-- Roles -->
        <div class="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <label class="space-y-1.5">
            <span class="text-xs font-medium text-on-surface-variant/40">{m.da_validation_role()}</span>
            <SearchableSelect bind:value={workflowDraft.validationRoleId} options={dashboardStore.state.discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.da_no_role()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
          </label>
          <label class="space-y-1.5">
            <span class="text-xs font-medium text-on-surface-variant/40">{m.da_sanction_role()}</span>
            <SearchableSelect bind:value={workflowDraft.sanctionRoleId} options={dashboardStore.state.discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.da_no_role()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
          </label>
          <label class="space-y-1.5">
            <span class="text-xs font-medium text-on-surface-variant/40">{m.da_ds_role()}</span>
            <SearchableSelect bind:value={workflowDraft.dsRoleId} options={dashboardStore.state.discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.da_no_role()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
          </label>
        </div>

        <!-- Auto detection toggle -->
        <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
          <div>
            <p class="font-bold text-on-surface text-sm">{m.da_auto_detection()}</p>
            <p class="text-xs text-on-surface-variant/50">{m.da_auto_detection_desc()}</p>
          </div>
          <ToggleSwitch
            checked={workflowDraft.autoDetectionEnabled}
            onToggle={(v) => (workflowDraft.autoDetectionEnabled = v)}
          />
        </div>

        <!-- Role permissions -->
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-5">
          <RolePermissionSettings
            featureKey="double_accounts"
            roleAccess={doubleAccountsConfig.roleAccessByRole}
          />
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center py-20 gap-3">
        <div class="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent"></div>
        <p class="text-xs text-on-surface-variant/50">{m.da_loading()}</p>
      </div>
    {/if}
  {/if}
</ModulePage>

<!-- Detection Report Modal -->
{#if reportModalDetection}
  {@const det = reportModalDetection}
  <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60" onclick={(e) => { if (e.target === e.currentTarget) reportModalDetection = null; }} role="button" tabindex="-1" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (e.target === e.currentTarget) reportModalDetection = null; } }}>
    <div class="bg-surface border border-outline-variant/20 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl animate-in slide-in-from-bottom-4 duration-300">
      <!-- Header -->
      <div class="sticky top-0 bg-surface border-b border-outline-variant/10 px-5 py-4 flex items-center justify-between z-10">
        <div class="flex items-center gap-3">
          {#if det.avatarUrl}
            <img src={det.avatarUrl} alt="" class="h-8 w-8 rounded-lg" />
          {:else}
            <div class="h-8 w-8 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant/30">
              <Papicon icon="User" size={16} />
            </div>
          {/if}
          <div>
            <h3 class="text-sm font-bold text-on-surface">{m.da_detection_report()}</h3>
            <p class="text-[11px] text-on-surface-variant/50">@{det.username || det.id}</p>
          </div>
        </div>
        <button onclick={() => reportModalDetection = null} class="p-1.5 rounded-lg hover:bg-surface-container-high transition-colors text-on-surface-variant/40">
          <Papicon icon="X" size={16} />
        </button>
      </div>

      <div class="p-5 space-y-5">
        <!-- Score -->
        {#if det.evidence}
          <div class="flex items-center gap-3 p-4 rounded-xl border {scoreBg(det.evidence.totalScore)}">
            <div class="text-2xl font-bold {scoreColor(det.evidence.totalScore)}">{det.evidence.totalScore}</div>
            <div>
              <p class="text-xs font-bold text-on-surface">{m.da_trust_score()}</p>
              <p class="text-[10px] text-on-surface-variant/50">{det.evidence.totalScore >= 60 ? m.da_risk_high() : det.evidence.totalScore >= 30 ? m.da_risk_medium() : m.da_risk_low()} - {det.evidence.reasons.length > 1 ? m.da_signal_other({ count: det.evidence.reasons.length }) : m.da_signal_one({ count: det.evidence.reasons.length })}</p>
            </div>
          </div>
        {/if}

        <!-- Suspected alts -->
        {#if det.suspectedAlts && det.suspectedAlts.length > 0}
          <div>
            <h4 class="text-xs font-medium text-on-surface-variant/40 mb-2">{m.da_associated_alts()}</h4>
            <div class="space-y-2">
              {#each det.suspectedAlts as alt}
                <div class="flex items-center justify-between gap-2 p-3 rounded-lg bg-surface-container-low/50 border border-outline-variant/5">
                  <button onclick={() => { reportModalDetection = null; openMemberCase(alt.userId, alt.username || alt.userId); }}
                    class="flex items-center gap-2 text-sm font-semibold text-on-surface hover:text-primary transition-colors min-w-0">
                    {#if alt.avatarUrl}<img src={alt.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />{/if}
                    <span class="truncate">@{alt.username || alt.userId}</span>
                  </button>
                  <button onclick={() => { handleLinkDetection(det, alt.userId); reportModalDetection = null; }}
                    disabled={saveAction.state.loading}
                    class="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-500 text-xs font-medium hover:bg-emerald-500 hover:text-white transition-all disabled:opacity-50 flex items-center gap-1">
                    <Papicon icon="Link2" size={11} /> {m.da_link()}
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Heuristics detail -->
        {#if det.evidence && det.evidence.reasons.length > 0}
          <div>
            <h4 class="text-xs font-medium text-on-surface-variant/40 mb-2">{m.da_heuristics_detail()}</h4>
            <div class="space-y-1.5">
              {#each [...det.evidence.reasons].sort((a, b) => b.score - a.score) as reason}
                <div class="p-3 rounded-lg bg-surface-container-low/40 border border-outline-variant/5">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0 flex-1">
                      <p class="text-xs font-bold text-on-surface">{reason.label.replace(/<@\d+>/g, (m) => { const alt = det.suspectedAlts?.find(a => m.includes(a.userId)); return alt?.username ? `@${alt.username}` : m; })}</p>
                      {#if reason.detail}
                        <p class="text-[10px] text-on-surface-variant/40 mt-0.5">{reason.detail}</p>
                      {/if}
                    </div>
                    <span class="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold {scoreColor(reason.score)} {scoreBg(reason.score)}">{reason.score}pts</span>
                  </div>
                  <div class="mt-1.5">
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-surface-container-high text-on-surface-variant/30">{reason.type.replace(/_/g, ' ')}</span>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Member info -->
        <div>
          <h4 class="text-xs font-medium text-on-surface-variant/40 mb-2">{m.da_information()}</h4>
          <div class="grid grid-cols-2 gap-2 text-[11px]">
            <div class="p-2.5 rounded-lg bg-surface-container-low/40">
              <span class="text-on-surface-variant/40">{m.da_created()}</span>
              <p class="font-bold text-on-surface">{formatRelative(det.accountCreatedAt)}</p>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-container-low/40">
              <span class="text-on-surface-variant/40">{m.da_joined()}</span>
              <p class="font-bold text-on-surface">{formatRelative(det.guildJoinedAt)}</p>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-container-low/40">
              <span class="text-on-surface-variant/40">{m.da_account_age()}</span>
              <p class="font-bold text-amber-500">{det.accountAgeLabel}</p>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-container-low/40">
              <span class="text-on-surface-variant/40">{m.da_messages()}</span>
              <p class="font-bold text-on-surface">{det.messageCount}</p>
            </div>
          </div>
        </div>

        <!-- Bottom actions -->
        <div class="flex flex-wrap gap-2 pt-2">
          <button onclick={() => { reportModalDetection = null; openMemberCase(det.id, det.displayName || det.username || m.da_member_fallback()); }}
            class="flex-1 py-2.5 rounded-lg bg-primary/10 text-primary text-xs font-bold hover:bg-primary hover:text-white transition-all flex items-center justify-center gap-1.5">
            <Papicon icon="FileText" size={13} /> {m.da_open_case()}
          </button>
          <button onclick={() => { handleDismissDetection(det); reportModalDetection = null; }}
            disabled={saveAction.state.loading}
            class="py-2.5 px-4 rounded-lg border border-outline-variant/10 text-xs font-bold text-on-surface-variant/50 hover:text-on-surface transition-all flex items-center justify-center gap-1.5 disabled:opacity-50">
            <Papicon icon="X" size={13} /> {m.da_false_positive()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<MemberCaseModal
  open={modalOpen}
  userId={selectedUserId}
  userName={selectedUserName}
  {caseData}
  loading={loadingCase}
  error={caseError}
  onClose={() => modalOpen = false}
  onSelectUser={(newUserId) => {
    const foundNode = caseData?.interactionGraph?.nodes?.find((n: any) => n.id === newUserId);
    openMemberCase(newUserId, foundNode?.label || 'Membre');
  }}
/>

<!-- Modal : activer le logging des messages (télémétrie pour la détection intelligente) -->
{#if showLoggingModal}
  <div class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    role="dialog" aria-modal="true" aria-labelledby="dc-logging-title"
    onclick={(e) => { if (e.target === e.currentTarget) dismissLoggingModal(); }}
    onkeydown={(e) => { if (e.key === 'Escape') dismissLoggingModal(); }}
    tabindex="-1">
    <div class="w-full max-w-md rounded-2xl border border-outline-variant/15 bg-surface-container shadow-2xl overflow-hidden">
      <!-- En-tête -->
      <div class="relative p-6 bg-gradient-to-br from-primary/15 to-transparent">
        <div class="h-12 w-12 rounded-xl bg-primary/15 flex items-center justify-center text-primary mb-3">
          <Papicon icon="Sparkles" size={22} />
        </div>
        <h2 id="dc-logging-title" class="text-lg font-bold text-on-surface">{m.da_modal_title()}</h2>
        <p class="text-xs text-on-surface-variant/60 mt-1">
          {m.da_modal_subtitle()}
        </p>
      </div>

      <!-- Corps -->
      <div class="px-6 pb-2 space-y-3">
        <p class="text-sm text-on-surface-variant/80">
          {m.da_modal_body_1()} <strong>{m.da_telemetry()}</strong> {m.da_modal_body_2()}
        </p>
        <ul class="text-xs text-on-surface-variant/70 space-y-1.5">
          <li class="flex items-start gap-2"><Papicon icon="Check" size={13} class="text-emerald-500 shrink-0 mt-0.5" /> {m.da_modal_bullet_1()}</li>
          <li class="flex items-start gap-2"><Papicon icon="Check" size={13} class="text-emerald-500 shrink-0 mt-0.5" /> {m.da_modal_bullet_2()}</li>
          <li class="flex items-start gap-2"><Papicon icon="Check" size={13} class="text-emerald-500 shrink-0 mt-0.5" /> {m.da_modal_bullet_3()}</li>
        </ul>
        <div class="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15 text-[11px] text-amber-300/90">
          <Papicon icon="Info" size={13} class="shrink-0 mt-0.5" />
          <span>{m.da_modal_retention()}</span>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-end gap-2 p-4">
        <button onclick={dismissLoggingModal} disabled={loggingBusy}
          class="px-4 py-2 rounded-lg text-xs font-bold text-on-surface-variant/70 hover:bg-surface-container-high/50 transition-all disabled:opacity-50">
          {m.da_later()}
        </button>
        <button onclick={enableMessageLogging} disabled={loggingBusy}
          class="flex items-center gap-1.5 bg-primary text-white px-4 py-2 rounded-lg text-xs font-bold hover:opacity-90 transition-all disabled:opacity-50">
          {#if loggingBusy}
            <div class="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
            {m.da_enabling()}
          {:else}
            <Papicon icon="Sparkles" size={13} /> {m.da_enable_telemetry()}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
