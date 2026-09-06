<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { fetchChannelsManagementConfig, updateChannelsManagementConfig, rescanChannelsManagementStats, fetchTempVoiceChannels, updateTempVoiceChannel, fetchStickyMessages, saveStickyMessage, deleteStickyMessage, repostStickyMessage, fetchChannelsByChannel, toggleChannelFeature, renameDiscordChannel, deleteDiscordChannel } from '../lib/api';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { m } from '../lib/i18n';

  // Config State
  let config = $state({
    autoThreadEnabled: false,
    autoThreadChannels: [] as string[],
    statsEnabled: false,
    statsConfig: {
      categoryId: '',
      memberEnabled: false,
      memberChannelId: '',
      memberTemplate: '👤 Membres : {count}',
      botEnabled: false,
      botChannelId: '',
      botTemplate: '🤖 Bots : {count}',
      roleEnabled: false,
      roleChannelId: '',
      roleTemplate: '👑 Staff : {count}',
      roleTargetId: '',
      channelEnabled: false,
      channelChannelId: '',
      channelTemplate: '💬 Salons : {count}',
      categoryEnabled: false,
      categoryChannelId: '',
      categoryTemplate: '📁 Catégories : {count}',
      activityEnabled: false,
      activityChannelId: '',
      activityTemplate: '📈 Actifs 24h : {count}',
      customStats: [] as any[],
    },
    tempVoiceEnabled: false,
    tempVoiceChannelId: '',
    tempVoiceCategoryId: '',
    tempVoiceNameTemplate: '🔊 Salon de {user}',
    tempVoiceRequiredRoleId: '',
    tempVoiceGenerators: [] as any[],
    honeypotEnabled: false,
    honeypotChannelId: '',
    honeypotSanction: 'TIMEOUT',
    honeypotReinvite: false,
  });

  // Snapshot of last-saved state
  let savedConfig = $state(JSON.parse(JSON.stringify({
    autoThreadEnabled: false,
    autoThreadChannels: [] as string[],
    statsEnabled: false,
    statsConfig: {
      categoryId: '',
      memberEnabled: false,
      memberChannelId: '',
      memberTemplate: '👤 Membres : {count}',
      botEnabled: false,
      botChannelId: '',
      botTemplate: '🤖 Bots : {count}',
      roleEnabled: false,
      roleChannelId: '',
      roleTemplate: '👑 Staff : {count}',
      roleTargetId: '',
      channelEnabled: false,
      channelChannelId: '',
      channelTemplate: '💬 Salons : {count}',
      categoryEnabled: false,
      categoryChannelId: '',
      categoryTemplate: '📁 Catégories : {count}',
      activityEnabled: false,
      activityChannelId: '',
      activityTemplate: '📈 Actifs 24h : {count}',
      customStats: [] as any[],
    },
    tempVoiceEnabled: false,
    tempVoiceChannelId: '',
    tempVoiceCategoryId: '',
    tempVoiceNameTemplate: '🔊 Salon de {user}',
    tempVoiceRequiredRoleId: '',
    tempVoiceGenerators: [] as any[],
    honeypotEnabled: false,
    honeypotChannelId: '',
    honeypotSanction: 'TIMEOUT',
    honeypotReinvite: false,
  })));

  $effect(() => {
    const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
    if (dirty) {
      untrack(() => {
        unsavedChanges.register({
          id: 'channels-management',
          label: m.cm_page_label(),
          onSave: () => handleSave(),
          onReset: () => {
            config = JSON.parse(JSON.stringify(savedConfig));
          }
        });
      });
    } else {
      untrack(() => {
        unsavedChanges.release('channels-management');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('channels-management');
  });

  let loading = $state(true);
  let loadError = $state('');
  // « Par salon » d'abord : c'est la question qu'on se pose en arrivant
  // (« qu'est-ce qui touche ce salon ? »), la ou les onglets par fonctionnalite
  // repondent a l'inverse (« quels salons ont cette fonctionnalite ? »).
  const channelTabs = ['by-channel', 'auto-thread', 'sticky', 'stats', 'temp-voice', 'honeypot'] as const;
  let activeTab = $state<'by-channel' | 'auto-thread' | 'sticky' | 'stats' | 'temp-voice' | 'honeypot'>('by-channel');
  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/channels-management', channelTabs, 'by-channel') as typeof activeTab;
  });
  let searchQuery = $state('');

  // ── Vue « Par salon » ──────────────────────────────────────────────────────
  type ChannelRow = {
    id: string;
    name: string;
    type: string;
    categoryId: string | null;
    categoryName: string | null;
    manageable: boolean;
    features: string[];
  };

  let byChannel = $state<ChannelRow[]>([]);
  let featureLabels = $state<Record<string, string>>({});
  let byChannelLoading = $state(false);
  let byChannelQuery = $state('');
  let expandedChannelId = $state<string | null>(null);
  /** Identifiant du salon en cours de bascule : evite les clics concurrents. */
  let featureBusy = $state<string | null>(null);

  /**
   * `sticky` et `tempVoiceGenerator` sont affiches mais pas cochables : ils
   * demandent un contenu (le texte colle, le gabarit de nom) qu'une case ne
   * peut pas saisir. Ils restent geres dans leur onglet.
   */
  const togglableFeatures = $derived(Object.keys(featureLabels));

  const featureLabel = (key: string) =>
    featureLabels[key]
      ?? (key === 'sticky' ? 'Message collé' : key === 'tempVoiceGenerator' ? 'Générateur vocal' : key);

  const visibleByChannel = $derived(
    byChannelQuery.trim()
      ? byChannel.filter((ch) => {
          const q = byChannelQuery.trim().toLowerCase();
          return ch.name.toLowerCase().includes(q) || (ch.categoryName ?? '').toLowerCase().includes(q);
        })
      : byChannel
  );

  async function loadByChannel() {
    byChannelLoading = true;
    try {
      const data = await fetchChannelsByChannel();
      byChannel = data?.channels ?? [];
      featureLabels = data?.features ?? {};
    } catch {
      toast.error('Chargement des salons impossible');
    } finally {
      byChannelLoading = false;
    }
  }

  async function setChannelFeature(ch: ChannelRow, feature: string, enabled: boolean) {
    if (featureBusy) return;
    featureBusy = ch.id;
    try {
      await toggleChannelFeature(ch.id, feature, enabled);
      // Rechargement complet plutot que mise a jour locale : activer une
      // fonctionnalite unique la retire d'un autre salon, que l'etat local
      // n'aurait aucun moyen de deviner.
      await loadByChannel();
    } catch (err: any) {
      toast.error(err?.message || 'Modification impossible');
    } finally {
      featureBusy = null;
    }
  }

  async function renameChannel(ch: ChannelRow) {
    const name = window.prompt(`Nouveau nom pour #${ch.name}`, ch.name);
    if (!name || name.trim() === ch.name) return;

    try {
      await renameDiscordChannel(ch.id, name.trim());
      toast.success('Salon renommé');
      await loadByChannel();
    } catch (err: any) {
      toast.error(err?.message || 'Renommage impossible');
    }
  }

  async function removeChannel(ch: ChannelRow) {
    const confirmed = await confirmDialog.ask({
      title: `Supprimer #${ch.name} ?`,
      description: 'Le salon et tous ses messages sont définitivement perdus. Cette action est irréversible.',
      confirmLabel: 'Supprimer',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await deleteDiscordChannel(ch.id);
      toast.success('Salon supprimé');
      expandedChannelId = null;
      await loadByChannel();
    } catch (err: any) {
      toast.error(err?.message || 'Suppression impossible');
    }
  }

  $effect(() => {
    if (activeTab === 'by-channel') void loadByChannel();
  });

  const saveAction = createAsyncActionState();
  const rescanAction = createAsyncActionState();

  async function handleRescanStats(force: boolean) {
    await rescanAction.run(async () => {
      const res = await rescanChannelsManagementStats({ force });
      if (!res || !res.ok) throw new Error(res?.error || m.cm_scan_launch_error());
      return true;
    }, { successMessage: m.cm_scan_launched() });
  }

  const availableChannels = $derived((dashboardStore.state.discordChannels || []) as any[]);
  const availableVoiceChannels = $derived((dashboardStore.state.discordVoiceChannels || []) as any[]);
  const availableCategories = $derived((dashboardStore.state.discordCategories || []) as any[]);
  const availableRoles = $derived((dashboardStore.state.discordRoles || []) as any[]);

  // Les fils ne sont pas configurables ici : le bot les ecarte a l'execution,
  // qu'il s'agisse des fils automatiques ou du sticky. Les proposer ne faisait
  // que promettre un reglage sans effet.
  const selectableChannels = $derived(availableChannels.filter(c => c.type !== 'thread'));

  const filteredChannels = $derived(
    selectableChannels.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  /**
   * Choix d'un selecteur, en gardant la valeur deja enregistree meme si elle ne
   * fait plus partie des choix proposes. Sans ca, un sticky configure sur un
   * fil avant ce filtrage s'affichait sur un selecteur vide, et on ne pouvait
   * plus voir ni changer ce qui etait en place.
   */
  function channelOptions(selectedId: string | null | undefined) {
    const options = selectableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }));
    if (!selectedId || options.some(o => o.id === selectedId)) return options;

    const current = availableChannels.find(c => c.id === selectedId);
    return current ? [...options, { id: current.id, name: channelDisplayName(current) }] : options;
  }

  let activeTempChannels = $state([] as any[]);
  let loadingTempChannels = $state(false);

  async function loadActiveTempChannels() {
    if (!config.tempVoiceEnabled) return;
    loadingTempChannels = true;
    try {
      const res = await fetchTempVoiceChannels();
      if (Array.isArray(res)) {
        activeTempChannels = res;
      }
    } catch (err) {
      console.error('Error fetching temp voice channels:', err);
    } finally {
      loadingTempChannels = false;
    }
  }

  $effect(() => {
    if (activeTab === 'temp-voice') {
      loadActiveTempChannels();
    }
  });

  // ── Sticky bot ────────────────────────────────────────────────────────────
  type StickyDraft = {
    id: string | null;
    channelId: string;
    enabled: boolean;
    content: string;
    embedEnabled: boolean;
    embedTitle: string;
    embedColor: string;
    messageThreshold: number;
    cooldownSeconds: number;
  };

  let stickies = $state([] as StickyDraft[]);
  let loadingStickies = $state(false);
  let stickyBusy = $state(null as string | null);
  let stickiesLoaded = $state(false);

  function toStickyDraft(raw: any): StickyDraft {
    return {
      id: raw.id ?? null,
      channelId: raw.channelId ?? '',
      enabled: raw.enabled ?? true,
      content: raw.content ?? '',
      embedEnabled: raw.embedEnabled ?? false,
      embedTitle: raw.embedTitle ?? '',
      embedColor: raw.embedColor ?? '#5865F2',
      messageThreshold: raw.messageThreshold ?? 5,
      cooldownSeconds: raw.cooldownSeconds ?? 10,
    };
  }

  async function loadStickies() {
    loadingStickies = true;
    try {
      const res = await fetchStickyMessages();
      if (res && Array.isArray(res.stickies)) {
        stickies = res.stickies.map(toStickyDraft);
      }
      stickiesLoaded = true;
    } catch (err) {
      console.error('Error fetching sticky messages:', err);
    } finally {
      loadingStickies = false;
    }
  }

  $effect(() => {
    if (activeTab === 'sticky' && !stickiesLoaded) {
      loadStickies();
    }
  });

  function addSticky() {
    stickies = [
      ...stickies,
      {
        id: null,
        channelId: '',
        enabled: true,
        content: '',
        embedEnabled: false,
        embedTitle: '',
        embedColor: '#5865F2',
        messageThreshold: 5,
        cooldownSeconds: 10,
      },
    ];
  }

  async function handleSaveSticky(index: number) {
    const sticky = stickies[index];
    if (!sticky.channelId) {
      toast.error(m.cm_sticky_channel_required());
      return;
    }
    if (!sticky.content.trim()) {
      toast.error(m.cm_sticky_content_required());
      return;
    }

    stickyBusy = sticky.channelId;
    try {
      const res = await saveStickyMessage({
        channelId: sticky.channelId,
        enabled: sticky.enabled,
        content: sticky.content,
        embedEnabled: sticky.embedEnabled,
        embedTitle: sticky.embedTitle || null,
        embedColor: sticky.embedColor,
        messageThreshold: sticky.messageThreshold,
        cooldownSeconds: sticky.cooldownSeconds,
      });
      if (!res || !res.ok) throw new Error(res?.error || m.cm_sticky_save_failed());
      stickies[index] = toStickyDraft(res.sticky);
      toast.success(m.cm_sticky_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.cm_sticky_save_failed());
    } finally {
      stickyBusy = null;
    }
  }

  async function handleDeleteSticky(index: number) {
    const sticky = stickies[index];
    // Brouillon jamais enregistré : rien à supprimer côté serveur.
    if (!sticky.id) {
      stickies = stickies.filter((_, i) => i !== index);
      return;
    }
    if (!(await confirmDialog.ask({
      title: m.cm_sticky_confirm_delete_title(),
      description: m.cm_sticky_confirm_delete_desc(),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    }))) return;

    stickyBusy = sticky.channelId;
    try {
      const res = await deleteStickyMessage(sticky.channelId);
      if (!res || !res.ok) throw new Error(res?.error || m.cm_sticky_delete_failed());
      stickies = stickies.filter((_, i) => i !== index);
      toast.success(m.cm_sticky_deleted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.cm_sticky_delete_failed());
    } finally {
      stickyBusy = null;
    }
  }

  async function handleRepostSticky(index: number) {
    const sticky = stickies[index];
    if (!sticky.id) return;
    stickyBusy = sticky.channelId;
    try {
      const res = await repostStickyMessage(sticky.channelId);
      if (!res || !res.ok) throw new Error(res?.error || m.cm_sticky_repost_failed());
      toast.success(m.cm_sticky_reposted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.cm_sticky_repost_failed());
    } finally {
      stickyBusy = null;
    }
  }

  let editingChannel = $state(null as string | null);
  let newChannelName = $state('');
  let actionInProgress = $state(false);

  async function handleRenameChannel(channelId: string) {
    if (!newChannelName.trim()) return;
    actionInProgress = true;
    try {
      const res = await updateTempVoiceChannel(channelId, { name: newChannelName.trim() });
      if (res && res.ok) {
        toast.success(m.cm_channel_renamed());
        await loadActiveTempChannels();
        editingChannel = null;
      }
    } catch (err) {
      toast.error(m.cm_rename_failed());
    } finally {
      actionInProgress = false;
    }
  }

  async function handleReserveChannel(channelId: string, roleId: string | null) {
    actionInProgress = true;
    try {
      const res = await updateTempVoiceChannel(channelId, { roleId });
      if (res && res.ok) {
        toast.success(roleId ? m.cm_channel_reserved() : m.cm_reservation_cancelled());
        await loadActiveTempChannels();
      }
    } catch (err) {
      toast.error(m.cm_reservation_update_failed());
    } finally {
      actionInProgress = false;
    }
  }

  async function handleDeleteChannel(channelId: string) {
    if (!(await confirmDialog.ask({ title: m.cm_confirm_close_temp_title(), description: m.cm_confirm_close_temp_desc(), confirmLabel: m.cm_close_channel(), variant: 'danger' }))) return;
    actionInProgress = true;
    try {
      const res = await updateTempVoiceChannel(channelId, { action: 'DELETE' });
      if (res && res.ok) {
        toast.success(m.cm_temp_channel_closed());
        await loadActiveTempChannels();
      }
    } catch (err) {
      toast.error(m.cm_close_failed());
    } finally {
      actionInProgress = false;
    }
  }

  onMount(async () => {
    try {
      await dashboardStore.refresh();
      const res = await fetchChannelsManagementConfig();
      if (res) {
        config.autoThreadEnabled = res.autoThreadEnabled ?? false;
        config.autoThreadChannels = res.autoThreadChannels ?? [];
        config.statsEnabled = res.statsEnabled ?? false;
        if (res.statsConfig) {
          config.statsConfig = {
            ...config.statsConfig,
            ...(res.statsConfig as any)
          };
          const sc = res.statsConfig as any;
          config.statsConfig.memberEnabled = sc.memberEnabled ?? !!sc.memberChannelId;
          config.statsConfig.botEnabled = sc.botEnabled ?? !!sc.botChannelId;
          config.statsConfig.roleEnabled = sc.roleEnabled ?? !!sc.roleChannelId;
          config.statsConfig.channelEnabled = sc.channelEnabled ?? !!sc.channelChannelId;
          config.statsConfig.categoryEnabled = sc.categoryEnabled ?? !!sc.categoryChannelId;
          config.statsConfig.activityEnabled = sc.activityEnabled ?? !!sc.activityChannelId;
          config.statsConfig.categoryId = sc.categoryId ?? '';
          config.statsConfig.customStats = sc.customStats || [];
        }
        config.tempVoiceEnabled = res.tempVoiceEnabled ?? false;
        config.tempVoiceChannelId = res.tempVoiceChannelId ?? '';
        config.tempVoiceCategoryId = res.tempVoiceCategoryId ?? '';
        config.tempVoiceNameTemplate = res.tempVoiceNameTemplate || '🔊 Salon de {user}';
        config.tempVoiceRequiredRoleId = res.tempVoiceRequiredRoleId ?? '';
        config.tempVoiceGenerators = Array.isArray(res.tempVoiceGenerators) ? res.tempVoiceGenerators : [];
        config.honeypotEnabled = res.honeypotEnabled ?? false;
        config.honeypotChannelId = res.honeypotChannelId ?? '';
        config.honeypotSanction = res.honeypotSanction ?? 'TIMEOUT';
        config.honeypotReinvite = res.honeypotReinvite ?? false;
        savedConfig = JSON.parse(JSON.stringify(config));
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : m.cm_config_load_failed();
    } finally {
      loading = false;
    }
  });

  // Keep toggle state in sync with module header in ModulePage.
  // L'interrupteur du module ecrit deja son etat cote serveur : le repercuter
  // sur la seule copie locale ferait apparaitre une modification a enregistrer,
  // et l'enregistrement serait refuse par la garde des modules.
  $effect(() => {
    const activeModule = (dashboardStore.state.modules as any[]).find(m => m.id === 'auto_thread');
    const enabled = activeModule?.status === 'active';
    untrack(() => {
      config.autoThreadEnabled = enabled;
      savedConfig.autoThreadEnabled = enabled;
    });
  });

  async function handleSave(): Promise<boolean> {
    let success = false;
    await saveAction.run(async () => {
      // Validate statistics role target only if role channel or auto-creation is requested
      if (config.statsConfig.roleEnabled && !config.statsConfig.roleTargetId) {
        toast.error(m.cm_role_target_required());
        throw new Error(m.cm_role_target_missing());
      }

      const res = await updateChannelsManagementConfig({
        autoThreadEnabled: config.autoThreadEnabled,
        autoThreadChannels: config.autoThreadChannels,
        statsEnabled: config.statsEnabled,
        statsConfig: config.statsConfig,
        tempVoiceEnabled: config.tempVoiceEnabled,
        tempVoiceChannelId: config.tempVoiceChannelId || null,
        tempVoiceCategoryId: config.tempVoiceCategoryId || null,
        tempVoiceNameTemplate: config.tempVoiceNameTemplate,
        tempVoiceRequiredRoleId: config.tempVoiceRequiredRoleId || null,
        tempVoiceGenerators: config.tempVoiceGenerators || [],
        honeypotEnabled: config.honeypotEnabled,
        honeypotChannelId: config.honeypotChannelId || null,
        honeypotSanction: config.honeypotSanction,
        honeypotReinvite: config.honeypotReinvite,
      } as any);

      if (!res || !res.ok) throw new Error(m.cm_save_api_error());

      // Update local state with resolved (auto-created) values from backend
      if (res.resolved) {
        if (res.resolved.tempVoiceChannelId) config.tempVoiceChannelId = res.resolved.tempVoiceChannelId;
        if (res.resolved.tempVoiceCategoryId) config.tempVoiceCategoryId = res.resolved.tempVoiceCategoryId;
        if (Array.isArray(res.resolved.tempVoiceGenerators)) config.tempVoiceGenerators = res.resolved.tempVoiceGenerators;
        if (res.resolved.honeypotChannelId) config.honeypotChannelId = res.resolved.honeypotChannelId;
        if (res.resolved.honeypotSanction) config.honeypotSanction = res.resolved.honeypotSanction;
        if (res.resolved.honeypotReinvite !== undefined) config.honeypotReinvite = res.resolved.honeypotReinvite;
        if (res.resolved.statsConfig) {
          config.statsConfig = {
            ...config.statsConfig,
            ...res.resolved.statsConfig
          };
        }
      }
      
      await dashboardStore.refresh();
      savedConfig = JSON.parse(JSON.stringify(config));
      success = true;
      return true;
    }, { successMessage: m.cm_config_saved() });
    return success;
  }

  function toggleChannel(channelId: string) {
    if (config.autoThreadChannels.includes(channelId)) {
      config.autoThreadChannels = config.autoThreadChannels.filter(id => id !== channelId);
    } else {
      config.autoThreadChannels = [...config.autoThreadChannels, channelId];
    }
  }

  function selectAll() {
    config.autoThreadChannels = filteredChannels.map(c => c.id);
  }

  function deselectAll() {
    config.autoThreadChannels = [];
  }
</script>

<ModulePage
  title={m.cm_page_label()}
  description={m.cm_page_description()}
  icon="hash"
  featureKey="auto_thread"
>

  <InlineFeedback message={saveAction.state.message} error={saveAction.state.error} />

  {#if loading}
    <div class="flex flex-col gap-6 animate-pulse">
      <div class="h-12 w-48 bg-surface-container-low/60 rounded-xl"></div>
      <div class="h-64 rounded-xl bg-surface-container-low/60"></div>
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else if loadError}
    <div class="rounded-xl bg-error/10 border border-error/20 p-6 text-error text-sm font-semibold">
      ⚠️ {loadError}
    </div>
  {:else}
    <!-- Tab Switcher -->
    <div class="flex border-b border-outline-variant/20 mb-8 overflow-x-auto no-scrollbar">
      <button
        onclick={() => gotoTab('/channels-management', 'by-channel', 'by-channel')}
        class="tab-button {activeTab === 'by-channel' ? 'active' : ''}"
      >
        Par salon
        {#if activeTab === 'by-channel'}
          <div class="absolute bottom-0 left-6 right-6 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>

      <button 
        onclick={() => gotoTab('/channels-management', 'auto-thread', 'by-channel')}
        class="tab-button {activeTab === 'auto-thread' ? 'active' : ''}"
      >
        Auto-Thread
        {#if activeTab === 'auto-thread'}
          <div class="absolute bottom-0 left-6 right-6 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>

      <button
        onclick={() => gotoTab('/channels-management', 'sticky', 'by-channel')}
        class="tab-button {activeTab === 'sticky' ? 'active' : ''}"
      >
        {m.cm_tab_sticky()}
        {#if activeTab === 'sticky'}
          <div class="absolute bottom-0 left-6 right-6 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>

      <button
        onclick={() => gotoTab('/channels-management', 'stats', 'by-channel')}
        class="tab-button {activeTab === 'stats' ? 'active' : ''}"
      >
        {m.cm_tab_stats()}
        {#if activeTab === 'stats'}
          <div class="absolute bottom-0 left-6 right-6 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>

      <button 
        onclick={() => gotoTab('/channels-management', 'temp-voice', 'by-channel')}
        class="tab-button {activeTab === 'temp-voice' ? 'active' : ''}"
      >
        {m.cm_tab_temp_voice()}
        {#if activeTab === 'temp-voice'}
          <div class="absolute bottom-0 left-6 right-6 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>

      <button 
        onclick={() => gotoTab('/channels-management', 'honeypot', 'by-channel')}
        class="tab-button {activeTab === 'honeypot' ? 'active' : ''}"
      >
        {m.cm_tab_honeypot()}
        {#if activeTab === 'honeypot'}
          <div class="absolute bottom-0 left-6 right-6 h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>
    </div>

    <!-- Active Content Tab -->
    <div class="grid grid-cols-1 gap-8">
      {#if activeTab === 'by-channel'}
        <!-- VUE PAR SALON -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-5 lg:p-6 rounded-xl space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-on-surface">Fonctionnalités par salon</h3>
              <p class="text-[13px] text-on-surface-variant mt-0.5">
                Chaque salon et ce qui y est actif. Les fonctionnalités uniques (comptage,
                salon piège…) se déplacent : les activer ici les retire du salon précédent.
              </p>
            </div>
            <input
              type="text"
              bind:value={byChannelQuery}
              placeholder="Filtrer un salon…"
              class="w-full sm:w-56 bg-surface-container-high text-sm px-4 py-2 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none"
            />
          </div>

          {#if byChannelLoading}
            <div class="flex justify-center py-8"><LoadingHint context="config" /></div>
          {:else if visibleByChannel.length === 0}
            <p class="text-[13px] text-on-surface-variant/70 py-8 text-center">Aucun salon ne correspond au filtre.</p>
          {:else}
            <div class="space-y-1.5">
              {#each visibleByChannel as ch (ch.id)}
                <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/3 transition-colors text-left"
                    onclick={() => (expandedChannelId = expandedChannelId === ch.id ? null : ch.id)}
                  >
                    <div class="flex items-center gap-2.5 min-w-0">
                      <Papicon icon={ch.type === 'voice' ? 'volume-2' : ch.type === 'forum' ? 'message-square' : 'hash'} size={15} class="text-on-surface-variant/60 shrink-0" />
                      <div class="min-w-0">
                        <p class="text-[13px] font-medium text-on-surface truncate">{ch.name}</p>
                        {#if ch.categoryName}
                          <p class="text-[11px] text-on-surface-variant/60 truncate">{ch.categoryName}</p>
                        {/if}
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      {#each ch.features.slice(0, 3) as key}
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">{featureLabel(key)}</span>
                      {/each}
                      {#if ch.features.length > 3}
                        <span class="text-[10px] text-on-surface-variant/60">+{ch.features.length - 3}</span>
                      {/if}
                      <Papicon icon={expandedChannelId === ch.id ? 'chevron-up' : 'chevron-down'} size={15} class="text-on-surface-variant/40" />
                    </div>
                  </button>

                  {#if expandedChannelId === ch.id}
                    <div class="px-4 pb-4 pt-1 border-t border-outline-variant/10 space-y-3">
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                        {#each togglableFeatures as key (key)}
                          <label class="flex items-center gap-2.5 cursor-pointer py-1.5">
                            <input
                              type="checkbox"
                              checked={ch.features.includes(key)}
                              disabled={featureBusy !== null}
                              onchange={(e) => setChannelFeature(ch, key, e.currentTarget.checked)}
                              class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30"
                            />
                            <span class="text-[12.5px] text-on-surface">{featureLabel(key)}</span>
                          </label>
                        {/each}
                      </div>

                      <!-- Le sticky et les générateurs vocaux ont leur propre
                           contenu à saisir : on renvoie vers leur onglet plutôt
                           que d'en faire une case à cocher trompeuse. -->
                      {#if ch.features.includes('sticky') || ch.features.includes('tempVoiceGenerator')}
                        <p class="text-[11.5px] text-on-surface-variant/70">
                          Ce salon porte aussi :
                          {#if ch.features.includes('sticky')}<span class="text-on-surface">un message collé</span>{/if}
                          {#if ch.features.includes('sticky') && ch.features.includes('tempVoiceGenerator')}, {/if}
                          {#if ch.features.includes('tempVoiceGenerator')}<span class="text-on-surface">un générateur de salon vocal</span>{/if}.
                          Ils se configurent dans leur onglet dédié.
                        </p>
                      {/if}

                      <div class="flex flex-wrap gap-2 pt-1 border-t border-outline-variant/10">
                        <button
                          type="button"
                          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                          bg-surface-container text-on-surface border border-outline-variant/40
                          hover:border-outline-variant disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          disabled={!ch.manageable}
                          title={ch.manageable ? '' : 'Le bot ne peut pas modifier ce salon'}
                          onclick={() => renameChannel(ch)}
                        >
                          <Papicon icon="pencil" size={13} />
                          Renommer
                        </button>
                        <button
                          type="button"
                          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                          bg-error/10 text-error border border-error/30 hover:bg-error/20
                          disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          disabled={!ch.manageable}
                          title={ch.manageable ? '' : 'Le bot ne peut pas supprimer ce salon'}
                          onclick={() => removeChannel(ch)}
                        >
                          <Papicon icon="trash" size={13} />
                          Supprimer
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeTab === 'auto-thread'}
        <!-- AUTO-THREAD TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="chat" size={20} class="text-primary" />
                {m.cm_eligible_channels_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_eligible_channels_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <button 
                onclick={selectAll}
                class="px-4 py-2 bg-surface-container-high/40 hover:bg-surface-container-high/80 border border-outline-variant/10 text-xs font-bold rounded-xl transition-all"
              >
                {m.cm_select_all_filtered()}
              </button>
              <button 
                onclick={deselectAll}
                class="px-4 py-2 bg-surface-container-high/40 hover:bg-surface-container-high/80 border border-outline-variant/10 text-xs font-bold rounded-xl transition-all"
              >
                {m.cm_deselect_all()}
              </button>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
            <div class="flex-1 relative">
              <input
                type="text"
                bind:value={searchQuery}
                placeholder={m.cm_search_channel_placeholder()}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg pl-11 pr-5 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-all outline-none"
              />
              <div class="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/50">
                <Papicon icon="search" size={16} />
              </div>
            </div>
            
            <div class="px-5 py-3 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 flex items-center gap-2 text-xs font-bold">
              <span class="text-primary">{config.autoThreadChannels.length}</span>
              <span class="text-on-surface-variant/60">{m.cm_channels_selected_count()}</span>
            </div>
          </div>

          {#if filteredChannels.length > 0}
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[450px] overflow-y-auto pr-2 no-scrollbar">
              {#each filteredChannels as channel}
                {@const isChecked = config.autoThreadChannels.includes(channel.id)}
                <button
                  onclick={() => toggleChannel(channel.id)}
                  class="flex items-center justify-between p-4 rounded-lg border transition-all text-left group
 {isChecked 
                      ? 'bg-primary/5 border-primary/30 text-primary hover:bg-primary/10' 
                      : 'bg-surface-container-high/10 border-outline-variant/5 hover:bg-surface-container-high/30'}"
                >
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg flex items-center justify-center {isChecked ? 'bg-primary/10' : 'bg-surface-container-highest'}">
                      <span class="text-sm font-semibold opacity-60">#</span>
                    </div>
                    <span class="text-sm font-semibold truncate max-w-[180px]">{channel.name}</span>
                  </div>
                  
                  <div class="w-5 h-5 rounded-md border flex items-center justify-center transition-all
 {isChecked 
                      ? 'bg-primary border-primary text-on-primary' 
                      : 'border-outline-variant/30 group-hover:border-outline-variant/60'}"
                  >
                    {#if isChecked}
                      <Papicon icon="check" size={12} class="text-white" />
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {:else}
            <div class="flex flex-col items-center justify-center py-12 text-on-surface-variant/30 bg-surface-container-high/10 border border-dashed border-outline-variant/10 rounded-lg gap-3">
              <Papicon icon="search" size={32} class="opacity-30" />
              <p class="text-sm font-bold">{m.cm_no_channel_matches_search()}</p>
            </div>
          {/if}
        </section>

      {:else if activeTab === 'sticky'}
        <!-- STICKY BOT TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/10 pb-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="notes" size={20} class="text-primary" />
                {m.cm_sticky_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_sticky_desc()}</p>
            </div>

            <button
              type="button"
              onclick={loadStickies}
              disabled={loadingStickies}
              class="px-3.5 py-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all flex items-center gap-2 shrink-0"
            >
              <Papicon icon="refresh" size={14} class={loadingStickies ? 'animate-spin' : ''} />
              {m.common_refresh()}
            </button>
          </div>

          <div class="flex items-start gap-2 p-3 rounded-lg bg-surface-container-high/20 border border-outline-variant/10">
            <span class="text-primary mt-0.5 shrink-0"><Papicon icon="Info" size={14} /></span>
            <p class="text-[11px] text-on-surface-variant/70 font-medium leading-relaxed">
              {m.cm_sticky_info()}
            </p>
          </div>

          {#if loadingStickies && stickies.length === 0}
            <div class="flex items-center justify-center py-12">
              <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
            </div>
          {:else}
            <div class="space-y-4">
              {#each stickies as sticky, index (sticky.id ?? `draft-${index}`)}
                <div class="rounded-xl border border-outline-variant/10 bg-surface-container/20 p-5 space-y-4">
                  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div class="flex-1 space-y-1.5">
                      <label for="sticky-channel-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_channel_label()}</label>
                      <SearchableSelect
                        id="sticky-channel-{index}"
                        options={channelOptions(sticky.channelId)}
                        bind:value={sticky.channelId}
                        placeholder={m.cm_select_channel_placeholder()}
                        disabled={!!sticky.id}
                      />
                      {#if sticky.id}
                        <p class="text-[10px] text-on-surface-variant/40">{m.cm_sticky_channel_locked_hint()}</p>
                      {/if}
                    </div>

                    <div class="flex items-center gap-3 sm:pt-6">
                      <span class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">{m.cm_sticky_enabled_label()}</span>
                      <input
                        type="checkbox"
                        aria-label={m.cm_sticky_enabled_label()}
                        bind:checked={sticky.enabled}
                        class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                      />
                    </div>
                  </div>

                  <div class="space-y-1.5">
                    <label for="sticky-content-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_content_label()}</label>
                    <textarea
                      id="sticky-content-{index}"
                      bind:value={sticky.content}
                      rows="4"
                      maxlength="2000"
                      placeholder={m.cm_sticky_content_placeholder()}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/30 transition-all resize-y"
                    ></textarea>
                    <p class="text-[10px] text-on-surface-variant/40">{m.cm_sticky_placeholders_hint()}</p>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                      <label for="sticky-threshold-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_threshold_label()}</label>
                      <input
                        id="sticky-threshold-{index}"
                        type="number"
                        min="1"
                        max="200"
                        bind:value={sticky.messageThreshold}
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                      />
                      <p class="text-[10px] text-on-surface-variant/40">{m.cm_sticky_threshold_hint()}</p>
                    </div>

                    <div class="space-y-1.5">
                      <label for="sticky-cooldown-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_cooldown_label()}</label>
                      <input
                        id="sticky-cooldown-{index}"
                        type="number"
                        min="0"
                        max="3600"
                        bind:value={sticky.cooldownSeconds}
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                      />
                      <p class="text-[10px] text-on-surface-variant/40">{m.cm_sticky_cooldown_hint()}</p>
                    </div>
                  </div>

                  <div class="flex items-center justify-between p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl">
                    <div class="space-y-0.5">
                      <label for="sticky-embed-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_embed_label()}</label>
                      <p class="text-[10px] text-on-surface-variant/60">{m.cm_sticky_embed_desc()}</p>
                    </div>
                    <input
                      id="sticky-embed-{index}"
                      type="checkbox"
                      bind:checked={sticky.embedEnabled}
                      class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                    />
                  </div>

                  {#if sticky.embedEnabled}
                    <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 animate-in fade-in duration-300">
                      <div class="space-y-1.5">
                        <label for="sticky-embed-title-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_embed_title_label()}</label>
                        <input
                          id="sticky-embed-title-{index}"
                          type="text"
                          maxlength="256"
                          bind:value={sticky.embedTitle}
                          placeholder={m.cm_sticky_embed_title_placeholder()}
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                        />
                      </div>
                      <div class="space-y-1.5">
                        <label for="sticky-embed-color-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_embed_color_label()}</label>
                        <input
                          id="sticky-embed-color-{index}"
                          type="color"
                          bind:value={sticky.embedColor}
                          class="h-[42px] w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-1 cursor-pointer"
                        />
                      </div>
                    </div>
                  {/if}

                  <div class="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-outline-variant/10">
                    {#if sticky.id}
                      <button
                        type="button"
                        onclick={() => handleRepostSticky(index)}
                        disabled={stickyBusy === sticky.channelId}
                        class="px-3.5 py-2 bg-surface-container-high/40 hover:bg-surface-container-high/80 border border-outline-variant/10 text-xs font-bold rounded-lg transition-all inline-flex items-center gap-2 disabled:opacity-50"
                      >
                        <Papicon icon="refresh" size={13} />
                        {m.cm_sticky_repost()}
                      </button>
                    {/if}
                    <button
                      type="button"
                      onclick={() => handleDeleteSticky(index)}
                      disabled={stickyBusy === sticky.channelId}
                      class="px-3.5 py-2 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-bold hover:bg-rose-500 hover:text-white transition-all inline-flex items-center gap-2 disabled:opacity-50"
                    >
                      <Papicon icon="trash-2" size={13} />
                      {m.common_delete()}
                    </button>
                    <button
                      type="button"
                      onclick={() => handleSaveSticky(index)}
                      disabled={stickyBusy === sticky.channelId}
                      class="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      {m.common_save()}
                    </button>
                  </div>
                </div>
              {/each}

              <button
                type="button"
                onclick={addSticky}
                class="w-full py-4 border border-dashed border-outline-variant/20 hover:border-primary/40 text-on-surface-variant/60 hover:text-primary transition-all rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
              >
                <Papicon icon="plus" size={16} />
                {m.cm_sticky_add()}
              </button>
            </div>
          {/if}
        </section>

      {:else if activeTab === 'stats'}
        <!-- STATS CHANNELS TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <InlineFeedback message={rescanAction.state.message} error={rescanAction.state.error} />

          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="bar-chart" size={20} class="text-primary" />
                {m.cm_stats_channels_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_stats_channels_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                bind:checked={config.statsEnabled} 
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.statsEnabled}
            <!-- Category Selection for Stats -->
            <div class="space-y-1.5 max-w-xl pb-4 border-b border-outline-variant/10">
              <label for="stats-category-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_stats_category_label()}</label>
              <div class="flex gap-2">
                <div class="flex-1">
                  <SearchableSelect 
                    id="stats-category-select"
                    options={availableCategories.map(c => ({ id: c.id, name: `📁 ${c.name}` }))} 
                    bind:value={config.statsConfig.categoryId} 
                    placeholder={m.cm_create_category_auto_placeholder()}
                  />
                </div>
                <button
                  type="button"
                  onclick={async () => {
                    config.statsConfig.categoryId = '';
                    await handleSave();
                  }}
                  disabled={saveAction.state.loading || loading}
                  class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {m.cm_create_category()}
                </button>
              </div>
            </div>

            <!-- Historical Scraping Trigger -->
            <div class="p-6 bg-primary/5 border border-primary/20 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div class="space-y-1">
                <h4 class="text-sm font-semibold flex items-center gap-2 text-primary">
                  <Papicon icon="history" size={16} />
                  {m.cm_rebuild_historical_stats_title()}
                </h4>
                <p class="text-xs text-on-surface-variant/60">
                  {m.cm_rebuild_historical_stats_desc()}
                </p>
              </div>
              <div class="flex gap-2 w-full md:w-auto">
                <button
                  type="button"
                  onclick={async () => {
                    await handleRescanStats(false);
                  }}
                  disabled={rescanAction.state.loading || loading}
                  class="px-5 py-3 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed flex-1 md:flex-none"
                >
                  {m.cm_launch_scan()}
                </button>
                <button
                  type="button"
                  onclick={async () => {
                    if (await confirmDialog.ask({ title: m.cm_confirm_recompute_title(), description: m.cm_confirm_recompute_desc(), confirmLabel: m.cm_recompute(), variant: 'warning' })) {
                      await handleRescanStats(true);
                    }
                  }}
                  disabled={rescanAction.state.loading || loading}
                  class="px-5 py-3 bg-error/10 hover:bg-error/20 text-error border border-error/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed flex-1 md:flex-none"
                >
                  {m.cm_force_rescan()}
                </button>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
              <!-- Member Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-member-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_member_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.memberEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.memberEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-member-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.memberChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.memberChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.memberTemplate} 
                    placeholder={m.cm_template_members_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Bot Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-bot-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_bot_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.botEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.botEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-bot-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.botChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.botChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.botTemplate} 
                    placeholder={m.cm_template_bots_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Role Member Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-role-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_role_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.roleEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.roleEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-role-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.roleChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.roleChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <SearchableSelect 
                    options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                    bind:value={config.statsConfig.roleTargetId} 
                    placeholder={m.cm_select_target_role_placeholder()}
                  />
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.roleTemplate} 
                    placeholder={m.cm_template_staff_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Channels Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-channel-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_channel_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.channelEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.channelEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-channel-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.channelChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.channelChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.channelTemplate} 
                    placeholder={m.cm_template_channels_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Categories Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-category-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_category_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.categoryEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.categoryEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-category-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.categoryChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.categoryChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.categoryTemplate} 
                    placeholder={m.cm_template_categories_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Activity Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-activity-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_activity_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.activityEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.activityEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-activity-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.activityChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.activityChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.activityTemplate} 
                    placeholder={m.cm_template_activity_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>
            </div>

            <!-- Custom stats channels -->
            <div class="border-t border-outline-variant/10 pt-6 mt-6 space-y-4">
              <div>
                <h4 class="text-sm font-semibold flex items-center gap-2">
                  <Papicon icon="plus-circle" size={16} class="text-primary" />
                  {m.cm_custom_stats_title()}
                </h4>
                <p class="text-xs text-on-surface-variant/60">{m.cm_custom_stats_desc()}</p>
              </div>

              {#if !config.statsConfig.customStats}
                {config.statsConfig.customStats = []}
              {/if}

              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                {#each config.statsConfig.customStats as custom, index}
                  <div class="p-5 bg-surface-container-high/10 border border-outline-variant/5 rounded-xl space-y-4 transition-all">
                    <div class="flex items-center justify-between border-b border-outline-variant/10 pb-3 mb-2">
                      <span class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.cm_counter_n({ n: index + 1 })}</span>
                      <button
                        type="button"
                        onclick={() => {
                          config.statsConfig.customStats = config.statsConfig.customStats.filter((_, i) => i !== index);
                        }}
                        class="text-on-surface-variant/60 hover:text-error transition-all flex items-center gap-1.5 text-xs font-bold"
                        title={m.cm_delete_counter_title()}
                      >
                        <Papicon icon="trash-2" size={14} />
                        {m.common_delete()}
                      </button>
                    </div>

                    <div class="space-y-4">
                      <!-- Enabled checkbox & Type -->
                      <div class="space-y-1.5">
                        <div class="flex items-center justify-between">
                          <label for="custom-type-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_stat_type_label()}</label>
                          <label class="flex items-center gap-2 text-xs font-bold text-on-surface/80 cursor-pointer">
                            {m.cm_enable_verb()}
                            <input 
                              type="checkbox" 
                              bind:checked={custom.enabled} 
                              class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                            />
                          </label>
                        </div>
                        <select
                          id="custom-type-{index}"
                          bind:value={custom.type}
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                        >
                          <option value="members">{m.cm_opt_members_total()}</option>
                          <option value="bots">{m.cm_opt_bots_total()}</option>
                          <option value="online">{m.cm_opt_members_online()}</option>
                          <option value="voice">{m.cm_opt_members_voice()}</option>
                          <option value="role">{m.cm_opt_specific_role()}</option>
                          <option value="channels">{m.cm_opt_channels_total()}</option>
                          <option value="categories">{m.cm_opt_categories_total()}</option>
                          <option value="activity">{m.cm_opt_activity_24h()}</option>
                          <option value="boosts">{m.cm_opt_server_boosts()}</option>
                          <option value="goal">{m.cm_opt_member_goal()}</option>
                        </select>
                      </div>

                      <!-- Channel Selection -->
                      <div class="space-y-1.5">
                        <label for="custom-channel-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_voice_channel_label()}</label>
                        {#if custom.enabled}
                          <div class="flex gap-2">
                            <div class="flex-1">
                              <SearchableSelect 
                                id="custom-channel-{index}"
                                options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                                bind:value={custom.channelId} 
                                placeholder={m.cm_create_channel_auto_placeholder()}
                              />
                            </div>
                            <button
                              type="button"
                              onclick={async () => {
                                custom.channelId = '';
                                await handleSave();
                              }}
                              disabled={saveAction.state.loading || loading}
                              class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {m.cm_create_short()}
                            </button>
                          </div>
                        {:else}
                          <div class="text-xs text-on-surface-variant/40 bg-surface-container-high/20 border border-outline-variant/10 rounded-lg px-4 py-2.5">
                            {m.cm_counter_disabled()}
                          </div>
                        {/if}
                      </div>

                      <!-- Conditional field: Role ID -->
                      {#if custom.type === 'role'}
                        <div class="space-y-1.5">
                          <label for="custom-role-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_target_role_label()}</label>
                          <SearchableSelect 
                            id="custom-role-select-{index}"
                            options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                            bind:value={custom.roleTargetId} 
                            placeholder={m.cm_select_target_role_placeholder()}
                          />
                        </div>
                      {/if}

                      <!-- Conditional field: Member Goal -->
                      {#if custom.type === 'goal'}
                        <div class="space-y-1.5">
                          <label for="custom-goal-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_goal_target_label()}</label>
                          <input 
                            id="custom-goal-{index}"
                            type="number"
                            bind:value={custom.goalTarget}
                            placeholder={m.cm_goal_example_placeholder()}
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                          />
                        </div>
                      {/if}

                      <!-- Template -->
                      <div class="space-y-1.5">
                        <label for="custom-template-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_name_template_label()}</label>
                        <input 
                          id="custom-template-{index}"
                          type="text" 
                          bind:value={custom.template} 
                          placeholder={custom.type === 'goal' ? m.cm_template_goal_placeholder() : m.cm_template_name_placeholder()} 
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                        />
                        <p class="text-[11px] text-on-surface-variant/40 mt-1">
                          {m.cm_count_placeholder_hint({ code: '{count}' })}
                          {#if custom.type === 'goal'}
                            {m.cm_goal_placeholder_hint({ code: '{goal}' })}
                          {/if}
                        </p>
                      </div>
                    </div>
                  </div>
                {/each}

                <button
                  type="button"
                  onclick={() => {
                    config.statsConfig.customStats = [
                      ...(config.statsConfig.customStats || []),
                      {
                        enabled: true,
                        type: 'members',
                        channelId: '',
                        template: '👤 Membres : {count}',
                        roleTargetId: '',
                        goalTarget: 1000
                      }
                    ];
                  }}
                  class="col-span-1 md:col-span-2 py-4 border border-dashed border-outline-variant/20 hover:border-primary/40 text-on-surface-variant/60 hover:text-primary transition-all rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
                >
                  <Papicon icon="plus" size={16} />
                  {m.cm_add_custom_counter()}
                </button>
              </div>
            </div>
            <p class="text-[10px] text-on-surface-variant/40 mt-4 block">{m.cm_stats_refresh_hint()}</p>
          {/if}
        </section>

      {:else if activeTab === 'temp-voice'}
        <!-- DYNAMIC VOCAL CREATORS TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="volume-2" size={20} class="text-primary" />
                {m.cm_temp_voice_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_temp_voice_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                bind:checked={config.tempVoiceEnabled} 
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.tempVoiceEnabled}
            <div class="space-y-4 pt-4 border-t border-outline-variant/10 max-w-xl">
              <!-- Generator Voice Channel Selection -->
              <div class="space-y-1.5">
                <label for="temp-voice-channel-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_generator_voice_channel_label()}</label>
                <div class="flex gap-2">
                  <div class="flex-1">
                    <SearchableSelect 
                      id="temp-voice-channel-select"
                      options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                      bind:value={config.tempVoiceChannelId} 
                      placeholder={m.cm_create_channel_auto_placeholder()}
                    />
                  </div>
                  <button
                    type="button"
                    onclick={async () => {
                      config.tempVoiceChannelId = '';
                      await handleSave();
                    }}
                    disabled={saveAction.state.loading || loading}
                    class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.cm_create_channel()}
                  </button>
                </div>
              </div>

              <!-- Target Category Selection -->
              <div class="space-y-1.5">
                <label for="temp-voice-category-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_creation_category_label()}</label>
                <div class="flex gap-2">
                  <div class="flex-1">
                    <SearchableSelect 
                      id="temp-voice-category-select"
                      options={availableCategories.map(c => ({ id: c.id, name: `📁 ${c.name}` }))} 
                      bind:value={config.tempVoiceCategoryId} 
                      placeholder={m.cm_create_category_auto_placeholder()}
                    />
                  </div>
                  <button
                    type="button"
                    onclick={async () => {
                      config.tempVoiceCategoryId = '';
                      await handleSave();
                    }}
                    disabled={saveAction.state.loading || loading}
                    class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.cm_create_category()}
                  </button>
                </div>
              </div>

              <!-- Name Template -->
              <div class="space-y-1.5">
                <label for="temp-voice-name-template-input" class="text-xs font-bold text-on-surface/80 block">{m.cm_name_template_channel_label()}</label>
                <input 
                  id="temp-voice-name-template-input"
                  type="text" 
                  bind:value={config.tempVoiceNameTemplate} 
                  placeholder={m.cm_template_user_placeholder()} 
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                />
                <p class="text-[10px] text-on-surface-variant/40 mt-1">{m.cm_user_placeholder_hint({ code: '{user}' })}</p>
              </div>

              <!-- Role Restriction Selection -->
              <div class="space-y-1.5">
                <label for="temp-voice-role-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_required_role_label()}</label>
                <SearchableSelect 
                  id="temp-voice-role-select"
                  options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                  bind:value={config.tempVoiceRequiredRoleId} 
                  placeholder={m.cm_no_role_required_open_placeholder()}
                />
              </div>

              {#if !config.tempVoiceGenerators}
                {config.tempVoiceGenerators = []}
              {/if}

              <!-- Secondary Voice Generators List -->
              <div class="border-t border-outline-variant/10 pt-6 mt-6 space-y-4">
                <div>
                  <h4 class="text-sm font-semibold flex items-center gap-2 text-primary">
                    <Papicon icon="plus-circle" size={16} />
                    {m.cm_additional_generators_title()}
                  </h4>
                  <p class="text-xs text-on-surface-variant/60">{m.cm_additional_generators_desc()}</p>
                </div>

                <div class="grid grid-cols-1 gap-6">
                  {#each config.tempVoiceGenerators as generator, index}
                    <div class="p-5 bg-surface-container-high/10 border border-outline-variant/5 rounded-xl space-y-4 transition-all">
                      <div class="flex items-center justify-between border-b border-outline-variant/10 pb-3 mb-2">
                        <span class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.cm_generator_n({ n: index + 2 })}</span>
                        <button
                          type="button"
                          onclick={() => {
                            config.tempVoiceGenerators = config.tempVoiceGenerators.filter((_, i) => i !== index);
                          }}
                          class="text-on-surface-variant/60 hover:text-error transition-all flex items-center gap-1.5 text-xs font-bold"
                          title={m.cm_delete_generator_title()}
                        >
                          <Papicon icon="trash-2" size={14} />
                          {m.common_delete()}
                        </button>
                      </div>

                      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <!-- Generator Voice Channel Selection -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-channel-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_generator_voice_channel_label()}</label>
                          <div class="flex gap-2">
                            <div class="flex-1">
                              <SearchableSelect 
                                id="temp-voice-channel-select-{index}"
                                options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                                bind:value={generator.channelId} 
                                placeholder={m.cm_create_auto_placeholder()}
                              />
                            </div>
                            <button
                              type="button"
                              onclick={async () => {
                                generator.channelId = '';
                                await handleSave();
                              }}
                              disabled={saveAction.state.loading || loading}
                              class="px-3 py-2.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all"
                            >
                              {m.cm_create_short()}
                            </button>
                          </div>
                        </div>

                        <!-- Target Category Selection -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-category-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_creation_category_label()}</label>
                          <div class="flex gap-2">
                            <div class="flex-1">
                              <SearchableSelect 
                                id="temp-voice-category-select-{index}"
                                options={availableCategories.map(c => ({ id: c.id, name: `📁 ${c.name}` }))} 
                                bind:value={generator.categoryId} 
                                placeholder={m.cm_create_auto_placeholder()}
                              />
                            </div>
                            <button
                              type="button"
                              onclick={async () => {
                                generator.categoryId = '';
                                await handleSave();
                              }}
                              disabled={saveAction.state.loading || loading}
                              class="px-3 py-2.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all"
                            >
                              {m.cm_create_short()}
                            </button>
                          </div>
                        </div>

                        <!-- Name Template -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-name-template-input-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_name_template_channel_label()}</label>
                          <input 
                            id="temp-voice-name-template-input-{index}"
                            type="text" 
                            bind:value={generator.nameTemplate} 
                            placeholder={m.cm_template_user_placeholder()} 
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                          />
                        </div>

                        <!-- Required Role Selector -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-role-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_required_role_short_label()}</label>
                          <SearchableSelect 
                            id="temp-voice-role-select-{index}"
                            options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                            bind:value={generator.requiredRoleId} 
                            placeholder={m.cm_no_role_public_placeholder()}
                          />
                        </div>
                      </div>
                    </div>
                  {/each}

                  <button
                    type="button"
                    onclick={() => {
                      config.tempVoiceGenerators = [
                        ...(config.tempVoiceGenerators || []),
                        {
                          channelId: '',
                          categoryId: '',
                          nameTemplate: '🔊 Salon de {user}',
                          requiredRoleId: ''
                        }
                      ];
                    }}
                    class="py-4 border border-dashed border-outline-variant/20 hover:border-primary/40 text-on-surface-variant/60 hover:text-primary transition-all rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
                  >
                    <Papicon icon="plus" size={16} />
                    {m.cm_add_extra_generator()}
                  </button>
                </div>
              </div>

              <!-- Description of Chat Control Embed -->
              <div class="p-5 bg-primary/5 border border-primary/20 rounded-xl mt-4">
                <h4 class="text-xs font-semibold text-primary uppercase tracking-wider mb-2">{m.cm_management_embed_title()}</h4>
                <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                  {m.cm_management_embed_intro()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_lock()}</strong> {m.cm_embed_bullet_lock_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_rename()}</strong> {m.cm_embed_bullet_rename_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_limit()}</strong> {m.cm_embed_bullet_limit_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_kick()}</strong> {m.cm_embed_bullet_kick_desc()}
                </p>
              </div>
            </div>
          {/if}
        </section>

        {#if config.tempVoiceEnabled}
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 mt-6">
            <div class="flex items-center justify-between border-b border-outline-variant/10 pb-4">
              <div>
                <h3 class="text-xl font-semibold flex items-center gap-3">
                  <Papicon icon="volume-2" size={20} class="text-primary" />
                  {m.cm_active_temp_channels_title()}
                </h3>
                <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_active_temp_channels_desc()}</p>
              </div>
              
              <button
                type="button"
                onclick={loadActiveTempChannels}
                disabled={loadingTempChannels}
                class="px-3.5 py-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all flex items-center gap-2"
              >
                <Papicon icon="refresh" size={14} class={loadingTempChannels ? "animate-spin" : ""} />
                {m.common_refresh()}
              </button>
            </div>

            {#if loadingTempChannels}
              <div class="flex items-center justify-center py-12">
                <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
              </div>
            {:else if activeTempChannels.length === 0}
              <div class="flex flex-col items-center justify-center py-12 text-on-surface-variant/30">
                <Papicon icon="volume-x" size={32} class="opacity-50 mb-2" />
                <p class="text-xs font-bold">{m.cm_no_active_temp_channel()}</p>
              </div>
            {:else}
              <!-- Desktop Table -->
              <div class="hidden md:block overflow-x-auto w-full">
                <table class="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr class="border-b border-outline-variant/15 text-xs font-medium text-on-surface-variant/70">
                      <th class="py-3 px-4">{m.cm_col_channel_name()}</th>
                      <th class="py-3 px-4">{m.cm_col_creator()}</th>
                      <th class="py-3 px-4 text-center">{m.cm_col_members()}</th>
                      <th class="py-3 px-4">{m.cm_col_reservation()}</th>
                      <th class="py-3 px-4 text-right">{m.cm_col_actions()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each activeTempChannels as chan}
                      <tr class="border-b border-outline-variant/10 hover:bg-white/5 transition-colors">
                        <td class="py-3 px-4">
                          {#if editingChannel === chan.id}
                            <div class="flex items-center gap-2">
                              <input 
                                type="text" 
                                bind:value={newChannelName}
                                class="bg-surface-container-high/40 border border-outline-variant/20 rounded-md px-2.5 py-1 text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary/50"
                              />
                              <button
                                type="button"
                                onclick={() => handleRenameChannel(chan.id)}
                                disabled={actionInProgress}
                                class="px-2 py-1 bg-primary text-white text-[10px] font-semibold rounded-md active:scale-[0.98] transition-transform"
                              >
                                {m.cm_validate()}
                              </button>
                              <button
                                type="button"
                                onclick={() => editingChannel = null}
                                class="px-2 py-1 bg-surface-container text-on-surface text-[10px] font-semibold rounded-md border border-outline-variant/20"
                              >
                                {m.common_cancel()}
                              </button>
                            </div>
                          {:else}
                            <div class="flex items-center gap-2">
                              <span class="font-mono text-sm font-bold text-on-surface">🔊 {chan.name}</span>
                              <button
                                type="button"
                                onclick={() => {
                                  editingChannel = chan.id;
                                  newChannelName = chan.name;
                                }}
                                class="text-on-surface-variant/40 hover:text-primary transition-colors"
                                title={m.cm_rename_title()}
                              >
                                <Papicon icon="edit" size={13} />
                              </button>
                            </div>
                          {/if}
                        </td>
                        <td class="py-3 px-4">
                          <div class="flex items-center gap-2">
                            {#if chan.creatorAvatar}
                              <img src={chan.creatorAvatar} alt={chan.creatorName} class="w-6 h-6 rounded-full border border-outline-variant/10" />
                            {:else}
                              <div class="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">
                                {chan.creatorName.slice(0, 1).toUpperCase()}
                              </div>
                            {/if}
                            <span class="text-xs text-on-surface-variant font-medium">{chan.creatorName}</span>
                          </div>
                        </td>
                        <td class="py-3 px-4 text-center">
                          <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                            👤 {chan.membersCount}
                          </span>
                        </td>
                        <td class="py-3 px-4">
                          <div class="max-w-[200px]">
                            <SearchableSelect 
                              options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                              value={chan.roleId || ''} 
                              on:change={(e) => handleReserveChannel(chan.id, e.detail.value || null)}
                              placeholder={m.cm_public_no_role_placeholder()}
                            />
                          </div>
                        </td>
                        <td class="py-3 px-4 text-right">
                          <button
                            type="button"
                            onclick={() => handleDeleteChannel(chan.id)}
                            disabled={actionInProgress}
                            class="px-2.5 py-1.5 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-rose-500 hover:text-white transition-all inline-flex items-center gap-1"
                          >
                            <Papicon icon="trash-2" size={12} />
                            {m.common_close()}
                          </button>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <!-- Mobile Cards -->
              <div class="md:hidden space-y-3">
                {#each activeTempChannels as chan}
                  <div class="rounded-xl border border-outline-variant/10 bg-surface-container/20 p-4 space-y-3">
                    <div class="flex items-center justify-between">
                      {#if editingChannel === chan.id}
                        <div class="flex items-center gap-2">
                          <input 
                            type="text" 
                            bind:value={newChannelName}
                            class="bg-surface-container-high/40 border border-outline-variant/20 rounded-md px-2.5 py-1 text-xs text-on-surface outline-none"
                          />
                          <button
                            type="button"
                            onclick={() => handleRenameChannel(chan.id)}
                            disabled={actionInProgress}
                            class="px-2 py-1 bg-primary text-white text-[10px] font-semibold rounded-md"
                          >
                            OK
                          </button>
                        </div>
                      {:else}
                        <span class="font-mono text-sm font-bold text-on-surface truncate">🔊 {chan.name}</span>
                        <button
                          type="button"
                          onclick={() => {
                            editingChannel = chan.id;
                            newChannelName = chan.name;
                          }}
                          class="text-on-surface-variant/40 hover:text-primary transition-colors"
                        >
                          <Papicon icon="edit" size={13} />
                        </button>
                      {/if}
                    </div>

                    <div class="flex items-center justify-between text-xs border-t border-b border-outline-variant/5 py-2">
                      <div class="flex items-center gap-1.5">
                        {#if chan.creatorAvatar}
                          <img src={chan.creatorAvatar} alt={chan.creatorName} class="w-5 h-5 rounded-full" />
                        {/if}
                        <span class="text-on-surface-variant">{chan.creatorName}</span>
                      </div>
                      <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold bg-primary/10 text-primary border border-primary/20">
                        👤 {chan.membersCount} {m.cm_members_connected_suffix()}
                      </span>
                    </div>

                    <div class="space-y-1">
                      <span class="text-[10px] font-bold text-on-surface-variant/60 block">{m.cm_reservation_label()}</span>
                      <SearchableSelect 
                        options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                        value={chan.roleId || ''} 
                        on:change={(e) => handleReserveChannel(chan.id, e.detail.value || null)}
                        placeholder={m.cm_public_no_role_placeholder()}
                      />
                    </div>

                    <div class="flex justify-end pt-1">
                      <button
                        type="button"
                        onclick={() => handleDeleteChannel(chan.id)}
                        disabled={actionInProgress}
                        class="px-2.5 py-1.5 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-lg text-[9px] font-semibold uppercase tracking-wider hover:bg-rose-500 hover:text-white transition-all inline-flex items-center gap-1"
                      >
                        <Papicon icon="trash-2" size={12} />
                        {m.cm_close_channel_full()}
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}

      {:else if activeTab === 'honeypot'}
        <!-- HONEYPOT TRAP TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="shield" size={20} class="text-primary" />
                {m.cm_honeypot_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_honeypot_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                bind:checked={config.honeypotEnabled} 
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.honeypotEnabled}
            <div class="space-y-6 pt-4 border-t border-outline-variant/10 max-w-xl">
              <!-- Honeypot Channel Selection -->
              <div class="space-y-1.5">
                <label for="honeypot-channel-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_honeypot_channel_label()}</label>
                <div class="flex gap-2">
                  <div class="grow">
                    <SearchableSelect
                      id="honeypot-channel-select"
                      options={channelOptions(config.honeypotChannelId)}
                      bind:value={config.honeypotChannelId}
                      placeholder={m.cm_select_channel_placeholder()}
                    />
                  </div>
                  <button
                    type="button"
                    onclick={async () => {
                      const res = await updateChannelsManagementConfig({
                        honeypotEnabled: true,
                        honeypotChannelId: null,
                        createHoneypotChannel: true,
                      } as any);
                      if (res?.resolved?.honeypotChannelId) {
                        config.honeypotChannelId = res.resolved.honeypotChannelId;
                        savedConfig = JSON.parse(JSON.stringify(config));
                        toast.success(m.cm_honeypot_created());
                      }
                    }}
                    disabled={saveAction.state.loading || loading}
                    class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.cm_create_automatically()}
                  </button>
                </div>
              </div>

              <!-- Honeypot Sanction Selection -->
              <div class="space-y-1.5">
                <label for="honeypot-sanction-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_sanction_to_apply_label()}</label>
                <select
                  id="honeypot-sanction-select"
                  bind:value={config.honeypotSanction}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                >
                  <option value="TIMEOUT">{m.cm_opt_timeout_default()}</option>
                  <option value="BAN">{m.cm_opt_ban_perm()}</option>
                  <option value="SOFTBAN">{m.cm_opt_softban()}</option>
                  <option value="KICK">{m.cm_opt_kick_simple()}</option>
                  <option value="WARN">{m.cm_opt_warn_simple()}</option>
                </select>
                <p class="text-[10px] text-on-surface-variant/40 mt-1">{m.cm_sanction_select_hint()}</p>
              </div>

              {#if config.honeypotSanction === 'KICK' || config.honeypotSanction === 'SOFTBAN'}
                <!-- Honeypot Auto Reinvite toggle -->
                <div class="flex items-center justify-between p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                  <div class="space-y-0.5">
                    <label for="honeypot-reinvite-toggle" class="text-xs font-bold text-on-surface/80 block">{m.cm_auto_reinvite_label()}</label>
                    <p class="text-[10px] text-on-surface-variant/60">{m.cm_auto_reinvite_desc()}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <input 
                      id="honeypot-reinvite-toggle"
                      type="checkbox" 
                      bind:checked={config.honeypotReinvite} 
                      class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                    />
                  </div>
                </div>
              {/if}

              <!-- Alert Warning Card -->
              <div class="p-5 bg-error/10 border border-error/20 text-error rounded-xl space-y-3">
                <h4 class="text-[13px] font-medium flex items-center gap-2">
                  <Papicon icon="alert-triangle" size={16} />
                  {m.cm_security_warning_title()}
                </h4>
                <p class="text-xs leading-relaxed opacity-90">
                  {m.cm_security_warning_body1()}
                  <br/><br/>
                  {m.cm_security_warning_body2({ strong: m.cm_security_warning_strong() })}
                </p>
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</ModulePage>

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
