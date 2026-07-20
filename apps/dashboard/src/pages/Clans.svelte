<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import {
    fetchClansData,
    updateClanSettings,
    createClan,
    updateClan,
    deleteClan,
    distributeClans,
    clearClans,
    resetClanSeason,
    resetAllClans,
    rollbackClanSeason,
    addClanPoints,
    type ClanEntry,
    type ClansDataResult
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  let showModal = $state(false);
  let editingClan = $state<ClanEntry | null>(null);

  // States
  let clansEnabled = $state(false);
  let clansUnique = $state(true);
  let currentClanSeason = $state(1);
  let clanXpFromLevelUp = $state(false);
  let clanXpPerLevelUp = $state(50);
  let clanAnnouncementChannelId = $state<string | null>(null);
  let clanRewardGiveaway = $state(false);
  let clanRewardLeaderRole = $state(false);
  let clanRewardXpBoost = $state(false); // needed for handleSaveSettings update
  let clanRewardXpBoostRate = $state(1.2); // needed for handleSaveSettings update
  let clans = $state<ClanEntry[]>([]);
  let taskInProgress = $state<ClansDataResult['taskInProgress']>(null);

  // Season dates states
  let clanSeasonStartsAt = $state<string | null>(null);
  let clanSeasonEndsAt = $state<string | null>(null);
  let startDate = $state('');
  let startTime = $state('00:00');
  let endDate = $state('');
  let endTime = $state('00:00');

  // Saved states (for dirty checking)
  let savedClansEnabled = $state(false);
  let savedClansUnique = $state(true);
  let savedClanXpFromLevelUp = $state(false);
  let savedClanXpPerLevelUp = $state(50);
  let savedClanAnnouncementChannelId = $state<string | null>(null);
  let savedClanRewardGiveaway = $state(false);
  let savedClanRewardLeaderRole = $state(false);
  let savedClanSeasonStartsAt = $state<string | null>(null);
  let savedClanSeasonEndsAt = $state<string | null>(null);

  // Tab routing
  let activeTab = $state<'clans' | 'seasons' | 'points' | 'admin'>('clans');

  // Form states
  let formName = $state('');
  let formDescription = $state('');
  let formRoleId = $state('');
  let formGeneralChannelId = $state('');
  let formLeaderRoleId = $state('');

  let availableChannels = $state<any[]>([]);

  // Points Management tab states & handlers
  let selectedClanIdForPoints = $state('');
  let manualPointsAmountClan = $state(100);
  let manualPointsMemberUserId = $state('');
  let manualPointsAmountMember = $state(100);

  async function handleAddClanPoints() {
    if (!canManageSettings || !selectedClanIdForPoints || !manualPointsAmountClan) return;
    await actionState.run(async () => {
      const res = await addClanPoints({
        clanId: selectedClanIdForPoints,
        amount: manualPointsAmountClan,
      });
      if (!res) throw new Error('Erreur lors de l\'ajout de points au clan.');
      await refreshData(true);
      manualPointsAmountClan = 100;
      return true;
    }, { successMessage: 'Points ajustés avec succès !' });
  }

  async function handleAddMemberPoints() {
    if (!canManageSettings || !manualPointsMemberUserId || !manualPointsAmountMember) return;
    await actionState.run(async () => {
      const res = await addClanPoints({
        clanId: null,
        userId: manualPointsMemberUserId,
        amount: manualPointsAmountMember,
      });
      if (!res) throw new Error('Erreur lors de l\'ajout de points au membre.');
      await refreshData(true);
      manualPointsMemberUserId = '';
      manualPointsAmountMember = 100;
      return true;
    }, { successMessage: 'Points du membre ajustés avec succès !' });
  }

  // Confirmation state for reset/clear/distribute/reset-all/rollback
  let confirmInput = $state('');
  let confirmActionType = $state<'clear' | 'reset' | 'distribute' | 'reset-all' | 'rollback' | null>(null);
  let showConfirmModal = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.welcome_goodbye?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  const formatLocal = (dateStr: string | null) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const tzOffset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
  };

  const formSeasonStartsAt = $derived(startDate ? `${startDate}T${startTime}` : '');
  const formSeasonEndsAt = $derived(endDate ? `${endDate}T${endTime}` : '');

  function parseDateToIso(dateVal: string, timeVal: string): string | null {
    if (!dateVal) return null;
    const combined = `${dateVal}T${timeVal || '00:00'}`;
    const d = new Date(combined);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function setSeasonDates(startsAt: string | null, endsAt: string | null) {
    if (startsAt) {
      const d = new Date(startsAt);
      if (!isNaN(d.getTime())) {
        const tzOffset = d.getTimezoneOffset() * 60000;
        const localIso = new Date(d.getTime() - tzOffset).toISOString();
        startDate = localIso.slice(0, 10);
        startTime = localIso.slice(11, 16);
      } else {
        startDate = '';
        startTime = '00:00';
      }
    } else {
      startDate = '';
      startTime = '00:00';
    }

    if (endsAt) {
      const d = new Date(endsAt);
      if (!isNaN(d.getTime())) {
        const tzOffset = d.getTimezoneOffset() * 60000;
        const localIso = new Date(d.getTime() - tzOffset).toISOString();
        endDate = localIso.slice(0, 10);
        endTime = localIso.slice(11, 16);
      } else {
        endDate = '';
        endTime = '00:00';
      }
    } else {
      endDate = '';
      endTime = '00:00';
    }
  }

  // Sync state changes with the unsaved changes bar
  $effect(() => {
    const dirty = clansEnabled !== savedClansEnabled 
      || clansUnique !== savedClansUnique
      || clanXpFromLevelUp !== savedClanXpFromLevelUp
      || clanXpPerLevelUp !== savedClanXpPerLevelUp
      || clanAnnouncementChannelId !== savedClanAnnouncementChannelId
      || clanRewardGiveaway !== savedClanRewardGiveaway
      || clanRewardLeaderRole !== savedClanRewardLeaderRole;

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          label: 'Configuration des Clans',
          onSave: () => handleSaveSettings(),
          onReset: () => {
            clansEnabled = savedClansEnabled;
            clansUnique = savedClansUnique;
            clanXpFromLevelUp = savedClanXpFromLevelUp;
            clanXpPerLevelUp = savedClanXpPerLevelUp;
            clanAnnouncementChannelId = savedClanAnnouncementChannelId;
            clanRewardGiveaway = savedClanRewardGiveaway;
            clanRewardLeaderRole = savedClanRewardLeaderRole;
            setSeasonDates(savedClanSeasonStartsAt, savedClanSeasonEndsAt);
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        if (unsavedChanges.isDirty && unsavedChanges.pageLabel === 'Configuration des Clans') {
          unsavedChanges.clear();
        }
      });
    }
  });

  function handleWsMessage(e: Event) {
    const detail = (e as CustomEvent).detail;
    if (
      detail?.type === 'dashboard_state_changed' &&
      detail?.guildId === authStore.selectedGuildId &&
      detail?.reason === 'clans_updated'
    ) {
      void refreshData(true);
    }
  }

  // Polling mechanism while a background operation is active (kept as fallback)
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (taskInProgress && !pollInterval) {
      pollInterval = setInterval(() => {
        void refreshData(true);
      }, 5000); // Polling plus espacé car doublé par les WebSockets
    } else if (!taskInProgress && pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  });

  onDestroy(() => {
    window.removeEventListener('kotbo-ws-message', handleWsMessage);
    if (unsavedChanges.pageLabel === 'Configuration des Clans') {
      unsavedChanges.clear();
    }
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  // Countdown helper
  let timeRemaining = $state('');
  $effect(() => {
    if (clanSeasonEndsAt) {
      const target = new Date(clanSeasonEndsAt).getTime();
      const update = () => {
        const diff = target - Date.now();
        if (diff <= 0) {
          timeRemaining = 'Saison terminée (clôture imminente par le Bot)';
          return;
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        timeRemaining = `Se termine dans ${days}j ${hours}h ${minutes}m`;
      };
      update();
      const interval = setInterval(update, 60000);
      return () => clearInterval(interval);
    } else {
      timeRemaining = 'Non planifiée (durée indéterminée)';
    }
  });

  async function refreshData(silent = false) {
    if (!silent) loading = true;
    try {
      const res = await fetchClansData();
      if (res) {
        clansEnabled = res.clansEnabled;
        clansUnique = res.clansUnique;
        currentClanSeason = res.currentClanSeason;
        clanXpFromLevelUp = res.clanXpFromLevelUp;
        clanXpPerLevelUp = res.clanXpPerLevelUp;
        clanAnnouncementChannelId = res.clanAnnouncementChannelId;
        clanRewardGiveaway = res.clanRewardGiveaway;
        clanRewardLeaderRole = res.clanRewardLeaderRole;
        clanRewardXpBoost = res.clanRewardXpBoost;
        clanRewardXpBoostRate = res.clanRewardXpBoostRate;
        clanSeasonStartsAt = res.clanSeasonStartsAt;
        clanSeasonEndsAt = res.clanSeasonEndsAt;
        clans = res.clans;
        taskInProgress = res.taskInProgress;

        // Formater les dates pour l'interface
        setSeasonDates(res.clanSeasonStartsAt, res.clanSeasonEndsAt);
        
        savedClansEnabled = res.clansEnabled;
        savedClansUnique = res.clansUnique;
        savedClanXpFromLevelUp = res.clanXpFromLevelUp;
        savedClanXpPerLevelUp = res.clanXpPerLevelUp;
        savedClanAnnouncementChannelId = res.clanAnnouncementChannelId;
        savedClanRewardGiveaway = res.clanRewardGiveaway;
        savedClanRewardLeaderRole = res.clanRewardLeaderRole;
        savedClanSeasonStartsAt = res.clanSeasonStartsAt;
        savedClanSeasonEndsAt = res.clanSeasonEndsAt;
      }
    } catch (err) {
      console.error(err);
    } finally {
      if (!silent) loading = false;
    }
  }

  onMount(async () => {
    window.addEventListener('kotbo-ws-message', handleWsMessage);
    await dashboardStore.refresh();
    await refreshData();
    const channelsData = await fetchDiscordChannels().catch(() => null);
    if (channelsData) {
      availableChannels = channelsData.textChannels || [];
    }
  });

  // Dynamically import channels fetch
  import { fetchDiscordChannels } from '../lib/api';

  async function handleSaveSettings(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await actionState.run(async () => {
      const res = await updateClanSettings({
        clansEnabled,
        clansUnique,
        clanXpFromLevelUp,
        clanXpPerLevelUp,
        clanAnnouncementChannelId: clanAnnouncementChannelId || null,
        clanRewardGiveaway,
        clanRewardLeaderRole,
        clanRewardXpBoost,
        clanRewardXpBoostRate,
        clanSeasonStartsAt: parseDateToIso(startDate, startTime),
        clanSeasonEndsAt: parseDateToIso(endDate, endTime)
      });
      if (!res) throw new Error('Erreur de sauvegarde');
      
      savedClansEnabled = res.clansEnabled;
      savedClansUnique = res.clansUnique;
      savedClanXpFromLevelUp = res.clanXpFromLevelUp;
      savedClanXpPerLevelUp = res.clanXpPerLevelUp;
      savedClanAnnouncementChannelId = res.clanAnnouncementChannelId;
      savedClanRewardGiveaway = res.clanRewardGiveaway;
      savedClanRewardLeaderRole = res.clanRewardLeaderRole;
      savedClanSeasonStartsAt = res.clanSeasonStartsAt;
      savedClanSeasonEndsAt = res.clanSeasonEndsAt;
      success = true;
      return true;
    }, { successMessage: 'Paramètres des clans sauvegardés avec succès !' });
    return success;
  }

  async function handleSaveSeasonPlanning() {
    if (!canManageSettings) return;
    
    const startsAtIso = parseDateToIso(startDate, startTime);
    const endsAtIso = parseDateToIso(endDate, endTime);
    
    if (!startsAtIso || !endsAtIso) {
      actionState.setError("Veuillez sélectionner des dates de début et de fin valides.");
      return;
    }
    
    if (new Date(startsAtIso) >= new Date(endsAtIso)) {
      actionState.setError("La date de fin doit être postérieure à la date de début.");
      return;
    }

    await actionState.run(async () => {
      const res = await updateClanSettings({
        clanSeasonStartsAt: startsAtIso,
        clanSeasonEndsAt: endsAtIso
      });
      if (!res) throw new Error("Erreur de sauvegarde de la planification.");
      
      savedClanSeasonStartsAt = res.clanSeasonStartsAt;
      savedClanSeasonEndsAt = res.clanSeasonEndsAt;
      clanSeasonStartsAt = res.clanSeasonStartsAt;
      clanSeasonEndsAt = res.clanSeasonEndsAt;
      setSeasonDates(res.clanSeasonStartsAt, res.clanSeasonEndsAt);
      return true;
    }, { successMessage: 'Planification de la saison enregistrée avec succès !' });
  }

  async function handleClearSeasonPlanning() {
    if (!canManageSettings) return;
    if (!confirm("Voulez-vous vraiment annuler la planification de la saison ?")) return;

    await actionState.run(async () => {
      const res = await updateClanSettings({
        clanSeasonStartsAt: null,
        clanSeasonEndsAt: null
      });
      if (!res) throw new Error("Erreur lors de l'annulation de la planification.");
      
      savedClanSeasonStartsAt = null;
      savedClanSeasonEndsAt = null;
      clanSeasonStartsAt = null;
      clanSeasonEndsAt = null;
      setSeasonDates(null, null);
      return true;
    }, { successMessage: 'Planification de la saison réinitialisée !' });
  }

  function openCreateModal() {
    editingClan = null;
    formName = '';
    formDescription = '';
    formRoleId = '';
    formGeneralChannelId = '';
    formLeaderRoleId = '';
    actionState.clearFeedback();
    showModal = true;
  }

  function openEditModal(clan: ClanEntry) {
    editingClan = clan;
    formName = clan.name;
    formDescription = clan.description || '';
    formRoleId = clan.roleId;
    formGeneralChannelId = clan.generalChannelId || '';
    formLeaderRoleId = clan.leaderRoleId || '';
    actionState.clearFeedback();
    showModal = true;
  }

  async function handleSaveClan() {
    if (!canManageSettings || !formName || !formRoleId) return;

    await actionState.run(async () => {
      const payload = {
        name: formName,
        description: formDescription || undefined,
        roleId: formRoleId,
        generalChannelId: formGeneralChannelId || null,
        leaderRoleId: formLeaderRoleId || null
      };

      if (editingClan) {
        const res = await updateClan(editingClan.id, payload);
        if (!res) throw new Error('Erreur lors de la modification');
        clans = clans.map(c => c.id === editingClan!.id ? { ...res.clan, memberCount: editingClan!.memberCount, totalXp: editingClan!.totalXp } : c);
      } else {
        const res = await createClan(payload);
        if (!res) throw new Error('Erreur lors de la création');
        clans = [...clans, { ...res.clan, memberCount: 0, totalXp: 0 }];
      }
      showModal = false;
      await refreshData(true);
      return true;
    }, { successMessage: editingClan ? 'Clan modifié avec succès !' : 'Clan créé avec succès !' });
  }

  async function handleDeleteClan(clan: ClanEntry) {
    if (!canManageSettings) return;
    if (!confirm(`Voulez-vous vraiment supprimer le clan "${clan.name}" ?`)) return;

    await actionState.run(async () => {
      const success = await deleteClan(clan.id);
      if (!success) throw new Error('Erreur de suppression');
      clans = clans.filter(c => c.id !== clan.id);
      return true;
    }, { successMessage: 'Clan supprimé.' });
  }

  function openConfirmation(type: 'clear' | 'reset' | 'distribute' | 'reset-all' | 'rollback') {
    confirmActionType = type;
    confirmInput = '';
    showConfirmModal = true;
  }

  async function handleConfirmAction() {
    if (!canManageSettings || !confirmActionType) return;

    const expected = confirmActionType === 'clear' 
      ? 'RETIRER' 
      : confirmActionType === 'reset' 
      ? 'RESET' 
      : confirmActionType === 'distribute'
      ? 'DISTRIBUER'
      : confirmActionType === 'reset-all'
      ? 'RESET ALL'
      : 'ANNULER';

    if (confirmInput.toUpperCase() !== expected.toUpperCase()) {
      alert('Veuillez saisir le mot de confirmation correct.');
      return;
    }

    showConfirmModal = false;

    await actionState.run(async () => {
      if (confirmActionType === 'clear') {
        const res = await clearClans();
        if (!res) throw new Error('Erreur lors du retrait');
        await refreshData(true);
      } else if (confirmActionType === 'reset') {
        const res = await resetClanSeason();
        if (!res) throw new Error('Erreur lors du reset');
        currentClanSeason = res.currentClanSeason;
        await refreshData(true);
      } else if (confirmActionType === 'distribute') {
        const res = await distributeClans();
        if (!res) throw new Error('Erreur lors du lancement');
        await refreshData(true);
      } else if (confirmActionType === 'reset-all') {
        const res = await resetAllClans();
        if (!res) throw new Error('Erreur lors de la réinitialisation complète');
        clansEnabled = false;
        currentClanSeason = 1;
        await refreshData(true);
      } else if (confirmActionType === 'rollback') {
        const res = await rollbackClanSeason();
        if (!res) throw new Error('Erreur lors de l\'annulation');
        currentClanSeason = res.currentClanSeason;
        await refreshData(true);
      }
      return true;
    }, {
      successMessage: confirmActionType === 'clear'
        ? 'Retrait de tous les rôles démarré en arrière-plan.'
        : confirmActionType === 'reset'
        ? 'Nouvelle saison de clans démarrée !'
        : confirmActionType === 'distribute'
        ? 'Distribution aléatoire lancée en arrière-plan.'
        : confirmActionType === 'reset-all'
        ? 'Toutes les données de clans ont été réinitialisées !'
        : 'La clôture de la saison a bien été annulée.'
    });
  }

  function handleDistribute() {
    if (!canManageSettings) return;
    if (clans.length === 0) {
      alert('Veuillez configurer au moins un clan avant de lancer la distribution.');
      return;
    }
    openConfirmation('distribute');
  }
</script>

<ModulePage
  title="Clans"
  description="Divisez votre communauté en clans basés sur des rôles Discord et suivez la compétition."
  icon="Shield"
  featureKey="welcome_goodbye"
>
  <InlineFeedback state={actionState} />

  <!-- Navigation par Onglets -->
  <div class="flex border-b border-outline-variant/15 mb-6">
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer {activeTab === 'clans' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'clans'}
    >
      🛡️ Clans & Rôles
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer {activeTab === 'seasons' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'seasons'}
    >
      📅 Gestion des Saisons
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer {activeTab === 'points' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'points'}
    >
      ⚡ Gestion des Points
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer {activeTab === 'admin' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'admin'}
    >
      ⚙️ Administration
    </button>
  </div>

  {#if loading}
    <div class="space-y-6">
      <Skeleton height="80px" />
      <Skeleton height="300px" />
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="clans" />
    </div>
  {:else}
    {#if activeTab === 'clans'}
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-8">
      
      <!-- Left side: General Settings -->
      <div class="xl:col-span-1 space-y-6">
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2">⚙️ Configuration</h3>
          
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-sm font-medium text-on-surface">Activer les clans</span>
                <p class="text-xs text-on-surface-variant/70">Active les commandes slash /clan et la sécurité.</p>
              </div>
              <ToggleSwitch checked={clansEnabled} onToggle={(v) => clansEnabled = v} disabled={!canManageSettings} />
            </div>

            <div class="flex items-center justify-between pt-4 border-t border-outline-variant/10">
              <div>
                <span class="text-sm font-medium text-on-surface">Clan Unique</span>
                <p class="text-xs text-on-surface-variant/70">Force un seul rôle de clan par membre Discord.</p>
              </div>
              <ToggleSwitch checked={clansUnique} onToggle={(v) => clansUnique = v} disabled={!canManageSettings} />
            </div>
          </div>
        </section>
 
        <!-- Season Rewards / Advantages -->
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2">🏆 Récompenses de fin de saison</h3>
          
          <div class="space-y-4">
            <div class="space-y-1.5">
              <label for="clan-announcement-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">Salon d'Annonces de Saison</label>
              <SearchableSelect
                id="clan-announcement-channel"
                bind:value={clanAnnouncementChannelId}
                options={[{ id: '', name: 'Aucun (Désactivé)' }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
                placeholder="Sélectionner le salon"
                disabled={!canManageSettings}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">Salon où est publiée l'annonce du vainqueur à la fin de la saison.</p>
            </div>

            <div class="space-y-4 pt-2 border-t border-outline-variant/10">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">Boost de Giveaways</span>
                  <p class="text-xs text-on-surface-variant/70">Augmente les chances du clan gagnant dans les giveaways.</p>
                </div>
                <ToggleSwitch checked={clanRewardGiveaway} onToggle={(v) => clanRewardGiveaway = v} disabled={!canManageSettings} />
              </div>

              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">Rôle de Chef de Clan</span>
                  <p class="text-xs text-on-surface-variant/70">Attribue le rôle de chef configuré sur le clan au meilleur contributeur.</p>
                </div>
                <ToggleSwitch checked={clanRewardLeaderRole} onToggle={(v) => clanRewardLeaderRole = v} disabled={!canManageSettings} />
              </div>
            </div>
          </div>
        </section>

        <!-- Seasons control -->
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-2">
            <h3 class="text-lg font-semibold">📅 Saison Actuelle</h3>
            <span class="px-3 py-1 bg-amber-500/10 text-amber-500 text-xs font-bold rounded-full">Saison {currentClanSeason}</span>
          </div>

          <div class="space-y-4">
            <p class="text-xs text-on-surface-variant/70">
              Passer à la saison suivante réinitialise l'XP active de tous les clans à 0. L'historique des contributions des anciennes saisons reste conservé en base de données.
            </p>
            {#if canManageSettings}
              <button
                onclick={() => openConfirmation('reset')}
                class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
              >
                <Papicon icon="Refresh" size={14} /> Réinitialiser la Saison (Reset)
              </button>
            {/if}
          </div>
        </section>

        <!-- Bulk Task Progress Bar -->
        {#if taskInProgress}
          <section class="bg-primary/5 border border-primary/20 p-6 rounded-xl space-y-4 animate-pulse">
            <h3 class="text-sm font-bold text-primary uppercase tracking-wider flex items-center gap-2">
              <svg class="animate-spin h-4 w-4 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Tâche en arrière-plan active
            </h3>
            
            <div class="space-y-2">
              <div class="flex justify-between text-xs font-medium text-on-surface-variant">
                <span>{taskInProgress.type === 'distribute' ? 'Distribution aléatoire' : 'Retrait des rôles'}</span>
                <span>{taskInProgress.processed} / {taskInProgress.total}</span>
              </div>
              <div class="w-full bg-surface-container-high rounded-full h-2">
                <div class="bg-primary h-2 rounded-full transition-all duration-300" style="width: {taskInProgress.total > 0 ? (taskInProgress.processed / taskInProgress.total) * 100 : 0}%"></div>
              </div>
            </div>
          </section>
        {/if}
      </div>

      <!-- Right side: Clans List & Leaderboard -->
      <div class="xl:col-span-2 space-y-6">
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-3">
            <h3 class="text-lg font-semibold">🛡️ Clans Configurés</h3>
            <div class="flex gap-2">
              {#if canManageSettings}
                <button
                  onclick={() => openConfirmation('clear')}
                  class="flex items-center gap-1.5 px-3 py-1.5 border border-rose-500/30 hover:bg-rose-500/10 text-rose-500 font-bold text-xs rounded-lg transition-colors cursor-pointer"
                  title="Retirer tous les rôles de clan du serveur"
                >
                  <Papicon icon="Trash" size={12} /> Retirer à tous
                </button>
                <button
                  onclick={handleDistribute}
                  class="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/15 hover:bg-secondary/25 text-secondary font-bold text-xs rounded-lg transition-colors cursor-pointer"
                  title="Distribuer aléatoirement les membres sans clan"
                >
                  <Papicon icon="Users" size={12} /> Distribuer
                </button>
                <button
                  onclick={openCreateModal}
                  class="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-on-primary font-bold text-xs rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <Papicon icon="Add" size={12} /> Nouveau clan
                </button>
              {/if}
            </div>
          </div>

          {#if clans.length === 0}
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <p class="text-sm text-on-surface-variant/60 font-medium">Aucun clan n'a été créé.</p>
              <p class="text-xs text-on-surface-variant/40">Cliquez sur « Nouveau clan » pour commencer la configuration.</p>
            </div>
          {:else}
            <!-- Clans table -->
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="border-b border-outline-variant/10 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-wider">
                    <th class="pb-3">Clan</th>
                    <th class="pb-3">Rôle Discord</th>
                    <th class="pb-3">Général de clan</th>
                    <th class="pb-3">Rôle du Chef</th>
                    <th class="pb-3 text-center">Membres</th>
                    <th class="pb-3 text-right">XP Cumulée</th>
                    {#if canManageSettings}
                      <th class="pb-3 text-right">Actions</th>
                    {/if}
                  </tr>
                </thead>
                <tbody class="divide-y divide-outline-variant/10">
                  {#each clans as clan}
                    <tr class="hover:bg-surface-container-low/20 transition-colors">
                      <td class="py-4">
                        <span class="font-bold text-sm text-on-surface">{clan.name}</span>
                        {#if clan.description}
                          <p class="text-xs text-on-surface-variant/70 max-w-[200px] truncate">{clan.description}</p>
                        {/if}
                      </td>
                      <td class="py-4">
                        <span class="px-2 py-1 bg-surface-container-high rounded text-xs text-on-surface-variant">
                          {availableRoles.find(r => r.id === clan.roleId)?.name || `ID: ${clan.roleId}`}
                        </span>
                      </td>
                      <td class="py-4">
                        {#if clan.generalChannelId}
                          <span class="text-xs text-on-surface-variant">
                            #{availableChannels.find(ch => ch.id === clan.generalChannelId)?.name || `ID: ${clan.generalChannelId}`}
                          </span>
                        {:else}
                          <span class="text-xs text-on-surface-variant/40 italic">Aucun</span>
                        {/if}
                      </td>
                      <td class="py-4">
                        {#if clan.leaderRoleId}
                          <span class="px-2 py-1 bg-primary/10 rounded text-xs text-primary font-medium">
                            {availableRoles.find(r => r.id === clan.leaderRoleId)?.name || `ID: ${clan.leaderRoleId}`}
                          </span>
                        {:else}
                          <span class="text-xs text-on-surface-variant/40 italic">Aucun</span>
                        {/if}
                      </td>
                      <td class="py-4 text-center font-medium text-xs text-on-surface">
                        {clan.memberCount ?? 0}
                      </td>
                      <td class="py-4 text-right font-bold text-xs text-amber-500">
                        {(clan.totalXp ?? 0).toLocaleString('fr-FR')} XP
                      </td>
                      {#if canManageSettings}
                        <td class="py-4 text-right space-x-2">
                          <button
                            onclick={() => openEditModal(clan)}
                            class="p-1.5 hover:bg-surface-container-high rounded-lg text-on-surface-variant transition-colors cursor-pointer inline-flex"
                            title="Modifier"
                          >
                            <Papicon icon="Edit" size={14} />
                          </button>
                          <button
                            onclick={() => handleDeleteClan(clan)}
                            class="p-1.5 hover:bg-rose-500/10 text-rose-500 rounded-lg transition-colors cursor-pointer inline-flex"
                            title="Supprimer"
                          >
                            <Papicon icon="Trash" size={14} />
                          </button>
                        </td>
                      {/if}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      </div>
    </div>

    {:else if activeTab === 'seasons'}
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-8">
        
        <!-- Left Column: Current Season Status Card -->
        <div class="xl:col-span-1 space-y-6">
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2">
                <Papicon icon="calendar" size={16} class="text-primary" />
                Saison Actuelle
              </h3>
              <span class="px-3 py-1 bg-amber-500/10 text-amber-500 text-xs font-bold rounded-full">Saison {currentClanSeason}</span>
            </div>

            <div class="space-y-4">
              <div class="p-4 bg-surface-container-high/20 rounded-xl border border-outline-variant/10 space-y-3">
                <span class="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest block">Temps Restant</span>
                <div class="flex items-center gap-2">
                  <span class="text-xl font-extrabold text-on-surface">{timeRemaining}</span>
                </div>
                {#if clanSeasonStartsAt && clanSeasonEndsAt}
                  <p class="text-[10px] text-on-surface-variant/50 leading-relaxed">
                    Début : {new Date(clanSeasonStartsAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                    <br />
                    Fin : {new Date(clanSeasonEndsAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                  </p>
                {/if}
              </div>

              <p class="text-xs text-on-surface-variant/70 leading-relaxed">
                La clôture de la saison calcule automatiquement le clan vainqueur, attribue les avantages, renomme le QG et réinitialise l'XP de clan active de tous les membres à 0.
              </p>

              {#if canManageSettings}
                <button
                  type="button"
                  onclick={() => openConfirmation('reset')}
                  class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                >
                  <Papicon icon="Refresh" size={14} /> Clôturer manuellement la Saison
                </button>
              {/if}
            </div>
          </section>
        </div>

        <!-- Right Column: Schedule / Planning Form -->
        <div class="xl:col-span-2 space-y-6">
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="flag" size={16} class="text-secondary" />
              Planifier la saison de clans
            </h3>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <!-- Début de saison -->
              <div class="space-y-2">
                <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">Début de la Saison</span>
                <div class="grid grid-cols-3 gap-2">
                  <input
                    type="date"
                    bind:value={startDate}
                    class="col-span-2 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-medium"
                    disabled={!canManageSettings}
                  />
                  <input
                    type="time"
                    bind:value={startTime}
                    class="col-span-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-medium"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>

              <!-- Fin de saison -->
              <div class="space-y-2">
                <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">Fin de la Saison</span>
                <div class="grid grid-cols-3 gap-2">
                  <input
                    type="date"
                    bind:value={endDate}
                    class="col-span-2 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-medium"
                    disabled={!canManageSettings}
                  />
                  <input
                    type="time"
                    bind:value={endTime}
                    class="col-span-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-medium"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>
            </div>

            <div class="p-4 bg-primary/5 border border-primary/20 rounded-xl text-xs text-primary leading-relaxed space-y-1">
              <p class="font-bold">💡 Fonctionnement Automatique</p>
              <p>Lorsque la date de fin est dépassée, le Bot lancera automatiquement le traitement de fin de saison. Si une date de début et de fin étaient configurées, le système calculera automatiquement l'intervalle et programmera la saison suivante pour la même durée.</p>
            </div>

            {#if canManageSettings}
              <div class="flex items-center justify-end gap-3 pt-4 border-t border-outline-variant/10">
                <button
                  type="button"
                  onclick={handleClearSeasonPlanning}
                  class="px-4 py-2 border border-outline-variant/30 text-on-surface hover:bg-surface-container-high/40 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                  disabled={!savedClanSeasonStartsAt && !savedClanSeasonEndsAt && !startDate && !endDate}
                >
                  Annuler la planification
                </button>
                <button
                  type="button"
                  onclick={handleSaveSeasonPlanning}
                  class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                  disabled={!startDate || !endDate}
                >
                  Enregistrer la planification
                </button>
              </div>
            {/if}
          </section>
        </div>

      </div>

    {:else if activeTab === 'points'}
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-8">
        
        <!-- Left Column: Points Configuration (Module Toggle) -->
        <div class="xl:col-span-1 space-y-6">
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="Settings" size={16} class="text-primary" />
              Configuration des Points
            </h3>

            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">Gain par passage de niveau</span>
                  <p class="text-xs text-on-surface-variant/70">Points bonus offerts lors d'un level up sur le serveur.</p>
                </div>
                <ToggleSwitch checked={clanXpFromLevelUp} onToggle={(v) => clanXpFromLevelUp = v} disabled={!canManageSettings} />
              </div>

              {#if clanXpFromLevelUp}
                <div class="space-y-1.5 pt-2 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
                  <label for="clan-xp-levelup-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">Points attribués par niveau</label>
                  <div class="flex items-center gap-2">
                    <input
                      id="clan-xp-levelup-amount"
                      type="number"
                      bind:value={clanXpPerLevelUp}
                      min="0"
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                      disabled={!canManageSettings}
                    />
                    <span class="text-xs text-on-surface-variant/60 font-semibold shrink-0">XP / niveau</span>
                  </div>
                </div>
              {/if}
            </div>
          </section>
        </div>

        <!-- Right Column: Manual Points Adjustments -->
        <div class="xl:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-6 items-start">
          
          <!-- Card 1: Add points to a Clan -->
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="Shield" size={16} class="text-amber-500" />
              Points de Clan (Global)
            </h3>

            <div class="space-y-4">
              <div class="space-y-1.5">
                <label for="manual-points-clan-select" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">Sélectionner le Clan</label>
                <SearchableSelect
                  id="manual-points-clan-select"
                  bind:value={selectedClanIdForPoints}
                  options={clans.map(c => ({ id: c.id, name: c.name }))}
                  placeholder="Choisir un clan"
                  disabled={!canManageSettings}
                />
              </div>

              <div class="space-y-1.5">
                <label for="manual-points-clan-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">Montant d'XP à ajouter (ou retirer)</label>
                <input
                  id="manual-points-clan-amount"
                  type="number"
                  bind:value={manualPointsAmountClan}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                  disabled={!canManageSettings}
                />
              </div>

              {#if canManageSettings}
                <button
                  type="button"
                  onclick={handleAddClanPoints}
                  class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/80 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                  disabled={!selectedClanIdForPoints}
                >
                  ⚡ Ajuster les points du Clan
                </button>
              {/if}
            </div>
          </section>

          <!-- Card 2: Add points to a Member -->
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="user" size={16} class="text-secondary" />
              Points d'un Membre
            </h3>

            <div class="space-y-4">
              <div class="space-y-1.5">
                <label for="manual-points-member-user-id" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">ID Discord du Membre</label>
                <input
                  id="manual-points-member-user-id"
                  type="text"
                  placeholder="Ex: 123456789012345678"
                  bind:value={manualPointsMemberUserId}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-medium"
                  disabled={!canManageSettings}
                />
              </div>

              <div class="space-y-1.5">
                <label for="manual-points-member-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">Montant d'XP à ajouter (ou retirer)</label>
                <input
                  id="manual-points-member-amount"
                  type="number"
                  bind:value={manualPointsAmountMember}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                  disabled={!canManageSettings}
                />
              </div>

              {#if canManageSettings}
                <button
                  type="button"
                  onclick={handleAddMemberPoints}
                  class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-secondary hover:bg-secondary/80 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                  disabled={!manualPointsMemberUserId}
                >
                  ⚡ Ajuster les points du Membre
                </button>
              {/if}
            </div>
          </section>

        </div>
      {:else if activeTab === 'admin'}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6" transition:fade={{ duration: 150 }}>
          
          <!-- Card 1: Recommencer à la Saison 1 (Reset All) -->
          <section class="bg-surface-container-low/40 border border-rose-500/20 p-6 rounded-xl space-y-6 flex flex-col justify-between">
            <div class="space-y-4">
              <h3 class="text-lg font-semibold border-b border-rose-500/10 pb-2 flex items-center gap-2 text-rose-500">
                <Papicon icon="AlertTriangle" size={16} />
                Réinitialisation Totale
              </h3>
              
              <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                Ce bouton permet de <strong>réinitialiser complètement toutes les données liées aux clans</strong>. Tous les clans configurés, les rôles Discord associés (dans la base de données) et l'ensemble de l'historique d'XP de toutes les saisons seront effacés définitivement.
              </p>
              
              <div class="p-3 bg-rose-500/10 rounded-lg border border-rose-500/10 text-rose-500 text-xs flex gap-2">
                <Papicon icon="Info" size={16} class="shrink-0 mt-0.5" />
                <span><strong>IMPORTANT :</strong> Si vous souhaitez simplement clore la saison active et passer à la saison suivante sans perdre vos clans, utilisez l'onglet <strong>📅 Gestion des Saisons</strong>.</span>
              </div>
            </div>

            {#if canManageSettings}
              <button
                type="button"
                onclick={() => openConfirmation('reset-all')}
                class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer mt-4"
              >
                💥 Réinitialiser toutes les données de Clans
              </button>
            {/if}
          </section>

          <!-- Card 2: Annuler la dernière saison (Rollback) -->
          <section class="bg-surface-container-low/40 border border-orange-500/20 p-6 rounded-xl space-y-6 flex flex-col justify-between">
            <div class="space-y-4">
              <h3 class="text-lg font-semibold border-b border-orange-500/10 pb-2 flex items-center gap-2 text-orange-500">
                <Papicon icon="RotateCcw" size={16} />
                Annuler la dernière saison
              </h3>
              
              <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                Ce bouton permet d'<strong>annuler la dernière clôture de saison</strong>. Si vous êtes actuellement à la Saison {currentClanSeason}, vous retournerez à la Saison {currentClanSeason - 1}.
              </p>
              
              <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                Toutes les contributions d'XP enregistrées pour la saison active (Saison {currentClanSeason}) seront supprimées. Le vainqueur de la saison précédente (Saison {currentClanSeason - 2}) ainsi que ses chefs de clans associés seront rétablis.
              </p>
            </div>

            {#if canManageSettings}
              <button
                type="button"
                onclick={() => openConfirmation('rollback')}
                class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer mt-4"
                disabled={currentClanSeason <= 1}
              >
                🔄 Annuler la dernière saison
              </button>
            {/if}
          </section>

        </div>
      {/if}
    {/if}
  {/if}
</ModulePage>

<!-- Modal: Créer / Éditer un Clan -->
{#if showModal}
  <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
    <div class="bg-surface-container-low/95 border border-outline-variant/20 max-w-lg w-full rounded-xl p-6 space-y-6 shadow-lg relative" transition:scale={{ start: 0.97, duration: 150 }}>
      
      <button
        onclick={() => showModal = false}
        class="absolute top-6 right-6 p-2 rounded-full bg-surface-container-high/40 hover:bg-rose-500/15 hover:text-rose-500 text-on-surface-variant transition-colors cursor-pointer"
      >
        <Papicon icon="Cross" size={18} />
      </button>

      <div>
        <h3 class="text-xl font-semibold">{editingClan ? 'Modifier le clan' : 'Créer un clan'}</h3>
        <p class="text-xs text-on-surface-variant/80">Liez un rôle Discord et configurez les détails de votre clan.</p>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleSaveClan(); }} class="space-y-4">
        <div class="space-y-1.5">
          <label for="clan-name" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">Nom du Clan</label>
          <input
            id="clan-name"
            type="text"
            bind:value={formName}
            placeholder="Ex: Griffondor, Guerriers, etc."
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
            required
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="clan-desc" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">Description</label>
          <textarea
            id="clan-desc"
            bind:value={formDescription}
            placeholder="Description du clan, son histoire ou sa devise..."
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-20"
            disabled={!canManageSettings}
          ></textarea>
        </div>

        <div class="space-y-1.5">
          <label for="clan-role" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">Rôle Discord Associé</label>
          <SearchableSelect
            id="clan-role"
            bind:value={formRoleId}
            options={availableRoles.map(r => ({ id: r.id, name: r.name }))}
            placeholder="Choisir le rôle Discord"
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="clan-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">Général de clan (QG)</label>
          <SearchableSelect
            id="clan-channel"
            bind:value={formGeneralChannelId}
            options={[{ id: '', name: 'Aucun (Désactivé)' }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
            placeholder="Choisir le salon général"
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="clan-leader-role" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">Rôle du Chef de Clan</label>
          <SearchableSelect
            id="clan-leader-role"
            bind:value={formLeaderRoleId}
            options={[{ id: '', name: 'Aucun (Désactivé)' }, ...availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))]}
            placeholder="Choisir le rôle du chef"
            disabled={!canManageSettings}
          />
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onclick={() => showModal = false}
            class="px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            Annuler
          </button>
          <button
            type="submit"
            class="px-4 py-2 bg-primary text-on-primary text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
          >
            Enregistrer
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Modal: Confirmation de Double Validation (Reset / Clear) -->
{#if showConfirmModal}
  <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
    <div class="bg-surface-container-low border border-outline-variant/20 max-w-md w-full rounded-xl p-6 space-y-6 shadow-lg relative" transition:scale={{ start: 0.97, duration: 150 }}>
      
      <button
        onclick={() => showConfirmModal = false}
        class="absolute top-6 right-6 p-2 rounded-full bg-surface-container-high/40 hover:bg-rose-500/15 hover:text-rose-500 text-on-surface-variant transition-colors cursor-pointer"
      >
        <Papicon icon="Cross" size={18} />
      </button>

      <div>
        <h3 class="text-lg font-semibold text-rose-500 flex items-center gap-2">
          <Papicon icon="AlertTriangle" size={20} />
          Validation requise
        </h3>
        <p class="text-xs text-on-surface-variant/80 mt-1">
          {#if confirmActionType === 'clear'}
            Vous vous apprêtez à <strong>retirer tous les rôles de clan</strong> de tous les membres du serveur. Cette action s'exécute progressivement en arrière-plan.
          {:else if confirmActionType === 'reset'}
            Vous vous apprêtez à <strong>clore la saison active</strong> de clans et à passer à la suivante. Les scores d'XP des clans repartiront à 0.
          {:else if confirmActionType === 'distribute'}
            Vous vous apprêtez à <strong>distribuer aléatoirement un clan</strong> à tous les membres sans clan. Cette action s'exécute progressivement en arrière-plan.
          {:else if confirmActionType === 'reset-all'}
            <span class="text-rose-500 font-bold">⚠️ ATTENTION :</span> Vous vous apprêtez à <strong>réinitialiser toutes les données de clans</strong> (suppression définitive de tous les clans configurés, de toutes les contributions de saison et retour à la saison 1). Cette action est totalement irréversible.
          {:else if confirmActionType === 'rollback'}
            Vous vous apprêtez à <strong>annuler la dernière clôture de saison</strong>. Vous retournerez à la saison {currentClanSeason - 1}. Les contributions de la saison active (Saison {currentClanSeason}) seront supprimées, et le vainqueur de la saison {currentClanSeason - 2} ainsi que ses chefs de clan associés seront rétablis.
          {/if}
        </p>
      </div>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <label for="confirm-word" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">
            Saisissez <strong>{#if confirmActionType === 'clear'}RETIRER{:else if confirmActionType === 'reset'}RESET{:else if confirmActionType === 'distribute'}DISTRIBUER{:else if confirmActionType === 'reset-all'}RESET ALL{:else}ANNULER{/if}</strong> pour confirmer
          </label>
          <input
            id="confirm-word"
            type="text"
            bind:value={confirmInput}
            placeholder={confirmActionType === 'clear' ? 'RETIRER' : confirmActionType === 'reset' ? 'RESET' : confirmActionType === 'distribute' ? 'DISTRIBUER' : confirmActionType === 'reset-all' ? 'RESET ALL' : 'ANNULER'}
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none font-bold uppercase tracking-wider"
          />
        </div>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            onclick={() => showConfirmModal = false}
            class="px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            Annuler
          </button>
          <button
            type="button"
            onclick={handleConfirmAction}
            class="px-4 py-2 bg-rose-500 text-white text-xs font-semibold rounded-lg hover:bg-rose-600 transition-colors cursor-pointer"
          >
            Confirmer
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
