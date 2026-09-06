<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import MemberSearchSelect from '../lib/components/MemberSearchSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import {
    fetchClansData,
    fetchLevelingData,
    updateClanSettings,
    createClan,
    updateClan,
    deleteClan,
    distributeClans,
    clearClans,
    dedupeClans,
    resetClanSeason,
    resetAllClans,
    rollbackClanSeason,
    adjustClanPoints,
    updateGlobalSettings,
    fetchClanBets,
    clearClanPointDebt,
    type ClanEntry,
    type ClansDataResult,
    type ClanBetEntry,
    type ClanPointDebtEntry
  } from '../lib/api';

  import {
    computeClanLevelUpPoints,
    normalizeLevelCurve,
    DEFAULT_LEVEL_CURVE,
    MIN_CLAN_REFERENCE_LEVEL,
    DEFAULT_CLAN_BET_SETTINGS,
    BET_ACCEPT_WINDOW_HOURS_MAX,
    BET_ACCEPT_WINDOW_HOURS_MIN,
    BET_DEBT_CEILING,
    BET_OPEN_PER_MEMBER_CEILING,
    BET_PARTICIPANTS_CEILING,
    BET_PARTICIPANTS_MIN,
    BET_SEASON_REWARD_CEILING,
    BET_SIDES_CEILING,
    BET_SIDES_MIN,
    BET_STAKE_CEILING,
    BET_STAKE_FLOOR,
    type ClanBetSettings,
    type LevelCurve,
  } from '@kotbo/shared';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  let showModal = $state(false);
  let editingClan = $state<ClanEntry | null>(null);

  // States
  let clansEnabled = $state(false);
  let clanAutoAssignOnJoin = $state(false);
  let clanWeeklyDigest = $state(false);
  let currentClanSeason = $state(1);
  let clanXpFromLevelUp = $state(false);
  let clanXpPerLevelUp = $state(50);
  let clanXpLevelUpProportional = $state(false);
  let clanXpReferenceLevel = $state(25);

  // La courbe vient du module de progression : l'aperçu doit refléter le vrai
  // coût des niveaux du serveur, pas la courbe par défaut.
  let levelCurve = $state<LevelCurve>(DEFAULT_LEVEL_CURVE);

  const clanPointsPreview = $derived.by(() => {
    const reference = Math.max(MIN_CLAN_REFERENCE_LEVEL, clanXpReferenceLevel || MIN_CLAN_REFERENCE_LEVEL);
    const levels = [...new Set([2, 10, reference, 50, 100])]
      .filter((level) => level >= MIN_CLAN_REFERENCE_LEVEL && (levelCurve.maxLevel === 0 || level <= levelCurve.maxLevel))
      .sort((a, b) => a - b);
    return levels.map((level) => ({
      level,
      isReference: level === reference,
      points: computeClanLevelUpPoints(level - 1, level, {
        flatPerLevelUp: clanXpPerLevelUp,
        proportional: true,
        referenceLevel: reference,
      }, levelCurve),
    }));
  });
  let clanXpFromBoost = $state(false);
  let clanXpPerBoost = $state(100);
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
  let savedClanAutoAssignOnJoin = $state(false);
  let savedClanWeeklyDigest = $state(false);

  /** Clans sans QG : le bilan hebdomadaire n'a nulle part où être publié pour eux. */
  const clansWithoutHq = $derived(
    clans.filter((clan) => !clan.generalChannelId).map((clan) => clan.name),
  );
  let savedClanXpFromLevelUp = $state(false);
  let savedClanXpPerLevelUp = $state(50);
  let savedClanXpLevelUpProportional = $state(false);
  let savedClanXpReferenceLevel = $state(25);
  let savedClanXpFromBoost = $state(false);
  let savedClanXpPerBoost = $state(100);
  let savedClanAnnouncementChannelId = $state<string | null>(null);
  let savedClanRewardGiveaway = $state(false);
  let savedClanRewardLeaderRole = $state(false);
  let savedClanSeasonStartsAt = $state<string | null>(null);
  let savedClanSeasonEndsAt = $state<string | null>(null);

  // Tab routing
  let activeTab = $state<'clans' | 'seasons' | 'points' | 'bets' | 'admin'>('clans');

  let copySuccess = $state(false);
  const publicClanUrl = $derived(
    authStore.selectedGuildId
      ? `${window.location.origin}/${authStore.selectedGuildId}/dev`
      : ''
  );

  async function copyPublicClanUrl() {
    if (!publicClanUrl) return;
    await navigator.clipboard.writeText(publicClanUrl);
    copySuccess = true;
    setTimeout(() => { copySuccess = false; }, 2000);
  }

  // Form states
  let formName = $state('');
  let formDescription = $state('');
  let formRoleId = $state('');
  let formGeneralChannelId = $state('');
  let formLeaderRoleId = $state('');

  let availableChannels = $state<any[]>([]);

  // Part d'un ajout manuel partie en remboursement de dette, affichée après coup.
  let lastDebtRepaid = $state(0);

  // Points Management tab states & handlers
  // Même borne que l'API : au-delà, c'est une faute de frappe.
  const MAX_MANUAL_POINTS = 1_000_000;
  let selectedClanIdForPoints = $state('');
  let manualPointsAmountClan = $state(100);
  let manualPointsMemberUserId = $state('');
  let manualPointsAmountMember = $state(100);

  // La saisie reste un montant positif : c'est le bouton choisi qui donne le
  // sens, un champ signé se prête trop facilement à un retrait involontaire.
  function isValidPointsAmount(amount: number): boolean {
    return Number.isFinite(amount) && Math.round(amount) >= 1;
  }

  function sanitizePoints(amount: number, direction: 1 | -1): number {
    return direction * Math.max(1, Math.min(MAX_MANUAL_POINTS, Math.round(amount)));
  }

  async function handleClanPoints(direction: 1 | -1) {
    if (!canManageSettings || !selectedClanIdForPoints) return;
    // Un bouton qui ne fait rien passe pour une panne : on dit ce qui manque.
    if (!isValidPointsAmount(manualPointsAmountClan)) {
      actionState.setError(m.clan_err_invalid_amount());
      return;
    }
    await actionState.run(async () => {
      const res = await adjustClanPoints({
        clanId: selectedClanIdForPoints,
        amount: sanitizePoints(manualPointsAmountClan, direction),
      });
      if (!res) throw new Error(direction < 0 ? m.clan_err_remove_clan_points() : m.clan_err_add_clan_points());
      await refreshData(true);
      manualPointsAmountClan = 100;
      return true;
    }, { successMessage: m.clan_success_points_adjusted() });
  }

  async function handleMemberPoints(direction: 1 | -1) {
    if (!canManageSettings || !manualPointsMemberUserId) return;
    if (!isValidPointsAmount(manualPointsAmountMember)) {
      actionState.setError(m.clan_err_invalid_amount());
      return;
    }
    // Remis à zéro avant chaque ajustement : la valeur survit d'un appel à
    // l'autre, et un échec ferait réafficher le remboursement du précédent.
    lastDebtRepaid = 0;

    const adjusted = await actionState.run(async () => {
      const res = await adjustClanPoints({
        clanId: null,
        userId: manualPointsMemberUserId,
        amount: sanitizePoints(manualPointsAmountMember, direction),
      });
      if (!res) throw new Error(direction < 0 ? m.clan_err_remove_member_points() : m.clan_err_add_member_points());
      await refreshData(true);
      manualPointsMemberUserId = '';
      manualPointsAmountMember = 100;
      // Un ajout qui rembourse une dette n'arrive pas entier au classement :
      // sans ce message, la page annoncerait un succès muet et l'écart passerait
      // pour un bug.
      lastDebtRepaid = res.debtRepaid ?? 0;
      return true;
    }, { successMessage: m.clan_success_member_points_adjusted() });

    // Seulement après un succès : `setMessage` efface l'erreur posée par un
    // échec, et l'admin lirait un remboursement à la place de ce qui a raté.
    if (adjusted && lastDebtRepaid > 0) {
      actionState.setMessage(m.clan_points_debt_repaid({ amount: lastDebtRepaid.toLocaleString(dateLocale()) }));
    }
  }

  // ── Onglet Paris ────────────────────────────────────────────────────────────
  // Les réglages voyagent en bloc : ils sont validés ensemble côté API (les
  // mises mini et maxi sont réordonnées l'une par rapport à l'autre), les
  // suivre champ par champ ferait diverger le formulaire de ce qui est réellement
  // enregistré.
  let betSettings = $state<ClanBetSettings>({ ...DEFAULT_CLAN_BET_SETTINGS });
  let savedBetSettings = $state<ClanBetSettings>({ ...DEFAULT_CLAN_BET_SETTINGS });

  // Sélecteur d'ajout de rôle : le composant n'expose pas de callback de
  // changement, on réagit donc à la valeur puis on la vide pour qu'il redevienne
  // un bouton « ajouter » plutôt que d'afficher le dernier rôle choisi.
  let roleToAdd = $state<string | null>('');
  $effect(() => {
    const roleId = roleToAdd;
    if (!roleId) return;
    untrack(() => {
      if (!betSettings.betResolverRoleIds.includes(roleId)) {
        betSettings.betResolverRoleIds = [...betSettings.betResolverRoleIds, roleId];
      }
      roleToAdd = '';
    });
  });

  const betManagerRoles = $derived(
    betSettings.betResolverRoleIds
      .map((id) => availableRoles.find((role: { id: string }) => role.id === id) ?? { id, name: id })
  );

  function removeBetManagerRole(roleId: string) {
    betSettings.betResolverRoleIds = betSettings.betResolverRoleIds.filter((id) => id !== roleId);
  }

  let bets = $state<ClanBetEntry[]>([]);
  let debts = $state<ClanPointDebtEntry[]>([]);
  // Totaux en base : les deux listes s'arrêtent aux 50 premières lignes, et sans
  // eux rien ne dirait qu'il en existe d'autres.
  let betCount = $state(0);
  let debtCount = $state(0);
  let betsLoading = $state(false);
  const betsAction = createAsyncActionState();

  // Dérivé plutôt que constant : les libellés suivent la langue choisie, qui
  // peut changer sans rechargement de la page.
  const betStatusLabels = $derived<Record<string, string>>({
    PENDING: m.clan_bet_status_pending(),
    LOCKED: m.clan_bet_status_locked(),
    ACTIVE: m.clan_bet_status_active(),
    RESOLVED: m.clan_bet_status_resolved(),
    REFUNDED: m.clan_bet_status_refunded(),
    DECLINED: m.clan_bet_status_declined(),
    CANCELLED: m.clan_bet_status_cancelled(),
    EXPIRED: m.clan_bet_status_expired(),
  });

  function betStatusClass(status: string): string {
    if (status === 'ACTIVE') return 'bg-primary/15 text-primary';
    if (status === 'RESOLVED') return 'bg-emerald-500/15 text-emerald-500';
    if (status === 'PENDING' || status === 'LOCKED') return 'bg-amber-500/15 text-amber-600';
    return 'bg-surface-container-high/60 text-on-surface-variant/70';
  }

  // `silent` : un rafraîchissement déclenché par le serveur ne doit pas
  // remplacer la liste par un squelette sous les yeux de qui la lit.
  async function refreshBets(silent = false) {
    if (!silent) betsLoading = true;
    try {
      const res = await fetchClanBets();
      bets = res?.bets ?? [];
      debts = res?.debts ?? [];
      betCount = res?.betCount ?? bets.length;
      debtCount = res?.debtCount ?? debts.length;
    } finally {
      betsLoading = false;
    }
  }

  // Les paris ne sont chargés qu'à l'ouverture de l'onglet : la page est déjà
  // lourde, et la plupart des visites n'y passent jamais.
  $effect(() => {
    if (activeTab === 'bets') {
      untrack(() => { void refreshBets(); });
    }
  });

  // Effacement d'une dette : la part ferme part toujours, le crédit engagé dans
  // des paris en cours seulement si on le demande. Un pari toujours en jeu a été
  // misé en connaissance de cause, l'effacer le rendrait gratuit.
  let debtToClear = $state<ClanPointDebtEntry | null>(null);
  let clearEngagedDebt = $state(false);

  function openDebtClear(debt: ClanPointDebtEntry) {
    if (!canManageSettings) return;
    debtToClear = debt;
    clearEngagedDebt = false;
  }

  async function handleClearDebt() {
    if (!canManageSettings || !debtToClear) return;
    const target = debtToClear;
    const includeEngaged = clearEngagedDebt;
    debtToClear = null;
    let left = 0;
    const done = await betsAction.run(async () => {
      const ok = await clearClanPointDebt(target.userId, includeEngaged);
      if (!ok) return false;
      await refreshBets(true);
      // Ce qui reste dû est relu sur le serveur plutôt que repris du chiffre
      // affiché avant le clic : un pari réglé entre-temps l'aurait démenti.
      left = debts.find((debt) => debt.userId === target.userId)?.amount ?? 0;
      return true;
    }, { successMessage: m.clan_bets_debt_cleared() });

    if (done && left > 0) {
      betsAction.setMessage(m.clan_bets_debt_cleared_partial({ amount: left.toLocaleString(dateLocale()) }));
    }
  }

  // Confirmation state for reset/clear/distribute/reset-all/rollback
  let confirmInput = $state('');
  let confirmActionType = $state<'clear' | 'reset' | 'distribute' | 'dedupe' | 'reset-all' | 'rollback' | null>(null);
  let showConfirmModal = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.leveling?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  // ── Pont Daily Algo → Clans ──────────────────────────────────────────────────
  // Vue symétrique de celle de la page Daily Algo : un admin qui part des clans
  // doit trouver le lien ici, sans deviner qu'il est rangé dans l'autre onglet.
  // Ce panneau a sa propre sauvegarde (route /settings) et reste donc à l'écart du
  // suivi de modifications de la page, qui passe par updateClanSettings.
  const dailyAlgoEnabled = $derived(!!(dashboardStore.state as any).dailyAlgoEnabled);
  const bridgeAction = createAsyncActionState();

  const bridge = $state({
    clanPointsFromDailyAlgo: false,
    clanPointsFromDailyAlgoRate: 1,
    clanPointsDailyAlgoTop1: 30,
    clanPointsDailyAlgoTop2: 20,
    clanPointsDailyAlgoTop3: 10,
  });

  function syncBridgeFromStore() {
    const s = dashboardStore.state as any;
    bridge.clanPointsFromDailyAlgo = s.clanPointsFromDailyAlgo ?? false;
    bridge.clanPointsFromDailyAlgoRate = s.clanPointsFromDailyAlgoRate ?? 1;
    bridge.clanPointsDailyAlgoTop1 = s.clanPointsDailyAlgoTop1 ?? 30;
    bridge.clanPointsDailyAlgoTop2 = s.clanPointsDailyAlgoTop2 ?? 20;
    bridge.clanPointsDailyAlgoTop3 = s.clanPointsDailyAlgoTop3 ?? 10;
  }

  async function saveBridgeSettings() {
    await bridgeAction.run(async () => {
      const ok = await updateGlobalSettings({ ...bridge });
      if (!ok) return false;

      await dashboardStore.refresh();
      syncBridgeFromStore();
      return true;
    }, {
      successMessage: m.clan_da_save_success(),
      failureMessage: m.clan_da_save_error(),
    });
  }

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
      || clanAutoAssignOnJoin !== savedClanAutoAssignOnJoin
      || clanWeeklyDigest !== savedClanWeeklyDigest
      || clanXpFromLevelUp !== savedClanXpFromLevelUp
      || clanXpPerLevelUp !== savedClanXpPerLevelUp
      || clanXpLevelUpProportional !== savedClanXpLevelUpProportional
      || clanXpReferenceLevel !== savedClanXpReferenceLevel
      || clanXpFromBoost !== savedClanXpFromBoost
      || clanXpPerBoost !== savedClanXpPerBoost
      || clanAnnouncementChannelId !== savedClanAnnouncementChannelId
      || clanRewardGiveaway !== savedClanRewardGiveaway
      || clanRewardLeaderRole !== savedClanRewardLeaderRole
      || JSON.stringify(betSettings) !== JSON.stringify(savedBetSettings);

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'clans',
          label: m.clan_unsaved_label(),
          onSave: () => handleSaveSettings(),
          onReset: () => {
            clansEnabled = savedClansEnabled;
            clanAutoAssignOnJoin = savedClanAutoAssignOnJoin;
            clanWeeklyDigest = savedClanWeeklyDigest;
            clanXpFromLevelUp = savedClanXpFromLevelUp;
            clanXpPerLevelUp = savedClanXpPerLevelUp;
            clanXpLevelUpProportional = savedClanXpLevelUpProportional;
            clanXpReferenceLevel = savedClanXpReferenceLevel;
            clanXpFromBoost = savedClanXpFromBoost;
            clanXpPerBoost = savedClanXpPerBoost;
            clanAnnouncementChannelId = savedClanAnnouncementChannelId;
            clanRewardGiveaway = savedClanRewardGiveaway;
            clanRewardLeaderRole = savedClanRewardLeaderRole;
            betSettings = { ...savedBetSettings, betResolverRoleIds: [...savedBetSettings.betResolverRoleIds] };
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('clans');
      });
    }
  });

  let unsubscribeRealtime: (() => void) | null = null;

  // Polling mechanism while a background operation is active (kept as fallback)
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let taskWasRunning = false;
  $effect(() => {
    if (taskInProgress && !pollInterval) {
      pollInterval = setInterval(() => {
        void refreshData(true);
      }, 5000); // Polling plus espacé car doublé par les WebSockets
    } else if (!taskInProgress && pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }

    // « Retirer à tous » recrée les rôles de clan : sans recharger la liste des
    // rôles Discord, la colonne Rôle afficherait un identifiant brut jusqu'au
    // prochain rafraîchissement de la page.
    if (taskWasRunning && !taskInProgress) {
      void dashboardStore.refresh();
    }
    taskWasRunning = !!taskInProgress;
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
    unsavedChanges.release('clans');
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
          timeRemaining = m.clan_season_ended();
          return;
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        timeRemaining = m.clan_season_ends_in({ days, hours, minutes });
      };
      update();
      const interval = setInterval(update, 60000);
      return () => clearInterval(interval);
    } else {
      timeRemaining = m.clan_season_unplanned();
    }
  });

  async function refreshData(silent = false) {
    if (!silent) loading = true;
    try {
      const res = await fetchClansData();
      if (res) {
        clansEnabled = res.clansEnabled;
        clanAutoAssignOnJoin = res.clanAutoAssignOnJoin;
        clanWeeklyDigest = res.clanWeeklyDigest ?? false;
        currentClanSeason = res.currentClanSeason;
        clanXpFromLevelUp = res.clanXpFromLevelUp;
        clanXpPerLevelUp = res.clanXpPerLevelUp;
        clanXpLevelUpProportional = res.clanXpLevelUpProportional ?? false;
        clanXpReferenceLevel = res.clanXpReferenceLevel ?? 25;
        clanXpFromBoost = res.clanXpFromBoost;
        clanXpPerBoost = res.clanXpPerBoost;
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
        savedClanAutoAssignOnJoin = res.clanAutoAssignOnJoin;
        savedClanWeeklyDigest = res.clanWeeklyDigest ?? false;
        savedClanXpFromLevelUp = res.clanXpFromLevelUp;
        savedClanXpPerLevelUp = res.clanXpPerLevelUp;
        savedClanXpLevelUpProportional = res.clanXpLevelUpProportional ?? false;
        savedClanXpReferenceLevel = res.clanXpReferenceLevel ?? 25;
        savedClanXpFromBoost = res.clanXpFromBoost;
        savedClanXpPerBoost = res.clanXpPerBoost;
        savedClanAnnouncementChannelId = res.clanAnnouncementChannelId;
        savedClanRewardGiveaway = res.clanRewardGiveaway;
        savedClanRewardLeaderRole = res.clanRewardLeaderRole;
        savedClanSeasonStartsAt = res.clanSeasonStartsAt;
        savedClanSeasonEndsAt = res.clanSeasonEndsAt;
        const loadedBets: ClanBetSettings = {
          betsEnabled: res.betsEnabled ?? false,
          betChannelId: res.betChannelId ?? null,
          betAnnouncementChannelId: res.betAnnouncementChannelId ?? null,
          betMinStake: res.betMinStake ?? DEFAULT_CLAN_BET_SETTINGS.betMinStake,
          betMaxStake: res.betMaxStake ?? DEFAULT_CLAN_BET_SETTINGS.betMaxStake,
          betMaxOpenPerMember: res.betMaxOpenPerMember ?? DEFAULT_CLAN_BET_SETTINGS.betMaxOpenPerMember,
          betAcceptWindowHours: res.betAcceptWindowHours ?? DEFAULT_CLAN_BET_SETTINGS.betAcceptWindowHours,
          betAllowDebt: res.betAllowDebt ?? false,
          betMaxDebt: res.betMaxDebt ?? DEFAULT_CLAN_BET_SETTINGS.betMaxDebt,
          betDebtResetOnSeason: res.betDebtResetOnSeason ?? false,
          betResolverRoleIds: res.betResolverRoleIds ?? [],
          betAllowPool: res.betAllowPool ?? false,
          betAllowTeams: res.betAllowTeams ?? false,
          betAllowOpen: res.betAllowOpen ?? false,
          betStakeMode: res.betStakeMode ?? DEFAULT_CLAN_BET_SETTINGS.betStakeMode,
          betMaxParticipants: res.betMaxParticipants ?? DEFAULT_CLAN_BET_SETTINGS.betMaxParticipants,
          betMaxSides: res.betMaxSides ?? DEFAULT_CLAN_BET_SETTINGS.betMaxSides,
          betSeasonRewardEnabled: res.betSeasonRewardEnabled ?? false,
          betSeasonRewardRoleId: res.betSeasonRewardRoleId ?? null,
          betRewardTop1: res.betRewardTop1 ?? DEFAULT_CLAN_BET_SETTINGS.betRewardTop1,
          betRewardTop2: res.betRewardTop2 ?? DEFAULT_CLAN_BET_SETTINGS.betRewardTop2,
          betRewardTop3: res.betRewardTop3 ?? DEFAULT_CLAN_BET_SETTINGS.betRewardTop3,
        };
        betSettings = { ...loadedBets, betResolverRoleIds: [...loadedBets.betResolverRoleIds] };
        savedBetSettings = { ...loadedBets, betResolverRoleIds: [...loadedBets.betResolverRoleIds] };
      }
    } catch (err) {
      console.error(err);
    } finally {
      if (!silent) loading = false;
    }
  }

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      reasons: ['clans_updated', 'clan_bets_updated'],
      onUpdate: (event) => {
        const reason = event?.reason;
        if (!reason || reason === 'clans_updated') {
          void refreshData(true);
        }
        // Les paris et les dettes vivent sur leur propre annonce : ils bougent à
        // chaque clic sur Discord, bien plus souvent que les clans, et ne sont
        // rechargés que si l'onglet qui les montre est ouvert.
        if (
          (!reason || reason === 'clan_bets_updated' || reason === 'clans_updated')
          && activeTab === 'bets'
        ) {
          void refreshBets(true);
        }
      },
    });
    await dashboardStore.refresh();
    syncBridgeFromStore();
    await refreshData();
    const channelsData = await fetchDiscordChannels().catch(() => null);
    if (channelsData) {
      availableChannels = channelsData.textChannels || [];
    }

    // Sert uniquement à l'aperçu du barème proportionnel, qui dépend du coût
    // réel des niveaux : sans cette lecture il afficherait la courbe par défaut.
    const levelingData = await fetchLevelingData().catch(() => null);
    if (levelingData?.config) {
      levelCurve = normalizeLevelCurve({
        baseXp: levelingData.config.curveBaseXp,
        linearXp: levelingData.config.curveLinearXp,
        exponent: levelingData.config.curveExponent,
        maxLevel: levelingData.config.maxLevel,
      });
    }
  });

  // Dynamically import channels fetch
  import { fetchDiscordChannels } from '../lib/api';

  // Les dates de saison ne passent volontairement pas par ici : elles ont leur
  // propre enregistrement, avec sa validation. Les joindre à chaque sauvegarde
  // de réglage rognait leur seconde au passage, et une plage incohérente encore
  // en cours de saisie faisait échouer la sauvegarde d'un simple interrupteur.
  async function handleSaveSettings(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await actionState.run(async () => {
      const res = await updateClanSettings({
        clansEnabled,
        clanAutoAssignOnJoin,
        clanWeeklyDigest,
        clanXpFromLevelUp,
        clanXpPerLevelUp,
        clanXpLevelUpProportional,
        clanXpReferenceLevel,
        clanXpFromBoost,
        clanXpPerBoost,
        clanAnnouncementChannelId: clanAnnouncementChannelId || null,
        clanRewardGiveaway,
        clanRewardLeaderRole,
        clanRewardXpBoost,
        clanRewardXpBoostRate,
        ...betSettings,
        betChannelId: betSettings.betChannelId || null,
        betAnnouncementChannelId: betSettings.betAnnouncementChannelId || null
      });
      if (!res) throw new Error(m.clan_err_save());

      savedClansEnabled = res.clansEnabled;
      savedClanAutoAssignOnJoin = res.clanAutoAssignOnJoin;
      savedClanWeeklyDigest = res.clanWeeklyDigest ?? false;
      savedClanXpFromLevelUp = res.clanXpFromLevelUp;
      savedClanXpPerLevelUp = res.clanXpPerLevelUp;
      savedClanXpLevelUpProportional = res.clanXpLevelUpProportional ?? false;
      savedClanXpReferenceLevel = res.clanXpReferenceLevel ?? 25;
      savedClanXpFromBoost = res.clanXpFromBoost;
      savedClanXpPerBoost = res.clanXpPerBoost;
savedBetSettings = {
        betsEnabled: res.betsEnabled ?? false,
        betChannelId: res.betChannelId ?? null,
        betAnnouncementChannelId: res.betAnnouncementChannelId ?? null,
        betMinStake: res.betMinStake ?? DEFAULT_CLAN_BET_SETTINGS.betMinStake,
        betMaxStake: res.betMaxStake ?? DEFAULT_CLAN_BET_SETTINGS.betMaxStake,
        betMaxOpenPerMember: res.betMaxOpenPerMember ?? DEFAULT_CLAN_BET_SETTINGS.betMaxOpenPerMember,
        betAcceptWindowHours: res.betAcceptWindowHours ?? DEFAULT_CLAN_BET_SETTINGS.betAcceptWindowHours,
        betAllowDebt: res.betAllowDebt ?? false,
        betMaxDebt: res.betMaxDebt ?? DEFAULT_CLAN_BET_SETTINGS.betMaxDebt,
        betDebtResetOnSeason: res.betDebtResetOnSeason ?? false,
        betResolverRoleIds: res.betResolverRoleIds ?? [],
        betAllowPool: res.betAllowPool ?? false,
        betAllowTeams: res.betAllowTeams ?? false,
        betAllowOpen: res.betAllowOpen ?? false,
        betStakeMode: res.betStakeMode ?? DEFAULT_CLAN_BET_SETTINGS.betStakeMode,
        betMaxParticipants: res.betMaxParticipants ?? DEFAULT_CLAN_BET_SETTINGS.betMaxParticipants,
        betMaxSides: res.betMaxSides ?? DEFAULT_CLAN_BET_SETTINGS.betMaxSides,
        betSeasonRewardEnabled: res.betSeasonRewardEnabled ?? false,
        betSeasonRewardRoleId: res.betSeasonRewardRoleId ?? null,
        betRewardTop1: res.betRewardTop1 ?? DEFAULT_CLAN_BET_SETTINGS.betRewardTop1,
        betRewardTop2: res.betRewardTop2 ?? DEFAULT_CLAN_BET_SETTINGS.betRewardTop2,
        betRewardTop3: res.betRewardTop3 ?? DEFAULT_CLAN_BET_SETTINGS.betRewardTop3,
      };
      // L'API réordonne les mises mini et maxi : le formulaire doit repartir de
      // ce qui a réellement été enregistré, sinon il se croit encore modifié.
      betSettings = { ...savedBetSettings, betResolverRoleIds: [...savedBetSettings.betResolverRoleIds] };
            savedClanAnnouncementChannelId = res.clanAnnouncementChannelId;
      savedClanRewardGiveaway = res.clanRewardGiveaway;
      savedClanRewardLeaderRole = res.clanRewardLeaderRole;
      success = true;
      return true;
    }, { successMessage: m.clan_success_settings_saved() });
    return success;
  }

  async function handleSaveSeasonPlanning() {
    if (!canManageSettings) return;
    
    const startsAtIso = parseDateToIso(startDate, startTime);
    const endsAtIso = parseDateToIso(endDate, endTime);
    
    if (!startsAtIso || !endsAtIso) {
      actionState.setError(m.clan_err_invalid_dates());
      return;
    }
    
    if (new Date(startsAtIso) >= new Date(endsAtIso)) {
      actionState.setError(m.clan_err_end_before_start());
      return;
    }

    await actionState.run(async () => {
      const res = await updateClanSettings({
        clanSeasonStartsAt: startsAtIso,
        clanSeasonEndsAt: endsAtIso
      });
      if (!res) throw new Error(m.clan_err_save_planning());
      
      savedClanSeasonStartsAt = res.clanSeasonStartsAt;
      savedClanSeasonEndsAt = res.clanSeasonEndsAt;
      clanSeasonStartsAt = res.clanSeasonStartsAt;
      clanSeasonEndsAt = res.clanSeasonEndsAt;
      setSeasonDates(res.clanSeasonStartsAt, res.clanSeasonEndsAt);
      return true;
    }, { successMessage: m.clan_success_planning_saved() });
  }

  // Remplit les champs date/heure à partir de deux objets Date (heure locale)
  function applyDateRange(start: Date, end: Date) {
    const toLocal = (d: Date) => {
      const tzOffset = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - tzOffset).toISOString();
    };
    const s = toLocal(start);
    const e = toLocal(end);
    startDate = s.slice(0, 10);
    startTime = s.slice(11, 16);
    endDate = e.slice(0, 10);
    endTime = e.slice(11, 16);
  }

  // Presets de remplissage rapide : début = maintenant, fin = maintenant + N mois
  function applyQuickRange(months: number) {
    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    applyDateRange(start, end);
  }

  // Enchaîne la prochaine saison juste après la saison actuelle planifiée,
  // en conservant la même durée (fallback 3 mois si la durée est indéterminée).
  const canChainNextSeason = $derived(!!savedClanSeasonEndsAt);
  function applyChainAfterCurrent() {
    if (!savedClanSeasonEndsAt) return;
    const start = new Date(savedClanSeasonEndsAt);
    let durationMs = 1000 * 60 * 60 * 24 * 90; // ~3 mois par défaut
    if (savedClanSeasonStartsAt) {
      const d = new Date(savedClanSeasonEndsAt).getTime() - new Date(savedClanSeasonStartsAt).getTime();
      if (d > 0) durationMs = d;
    }
    const end = new Date(start.getTime() + durationMs);
    applyDateRange(start, end);
  }

  async function handleClearSeasonPlanning() {
    if (!canManageSettings) return;
    if (!confirm(m.clan_confirm_cancel_planning())) return;

    await actionState.run(async () => {
      const res = await updateClanSettings({
        clanSeasonStartsAt: null,
        clanSeasonEndsAt: null
      });
      if (!res) throw new Error(m.clan_err_cancel_planning());
      
      savedClanSeasonStartsAt = null;
      savedClanSeasonEndsAt = null;
      clanSeasonStartsAt = null;
      clanSeasonEndsAt = null;
      setSeasonDates(null, null);
      return true;
    }, { successMessage: m.clan_success_planning_reset() });
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
        if (!res) throw new Error(m.clan_err_edit());
        clans = clans.map(c => c.id === editingClan!.id ? { ...res.clan, memberCount: editingClan!.memberCount, totalXp: editingClan!.totalXp } : c);
      } else {
        const res = await createClan(payload);
        if (!res) throw new Error(m.clan_err_create());
        clans = [...clans, { ...res.clan, memberCount: 0, totalXp: 0 }];
      }
      showModal = false;
      await refreshData(true);
      return true;
    }, { successMessage: editingClan ? m.clan_success_edited() : m.clan_success_created() });
  }

  async function handleDeleteClan(clan: ClanEntry) {
    if (!canManageSettings) return;
    if (!confirm(m.clan_confirm_delete({ name: clan.name }))) return;

    await actionState.run(async () => {
      const success = await deleteClan(clan.id);
      if (!success) throw new Error(m.clan_err_delete());
      clans = clans.filter(c => c.id !== clan.id);
      return true;
    }, { successMessage: m.clan_success_deleted() });
  }

  function confirmWordFor(type: 'clear' | 'reset' | 'distribute' | 'dedupe' | 'reset-all' | 'rollback' | null): string {
    return type === 'clear' ? m.clan_confirm_word_clear()
      : type === 'reset' ? m.clan_confirm_word_reset()
      : type === 'distribute' ? m.clan_confirm_word_distribute()
      : type === 'dedupe' ? m.clan_confirm_word_dedupe()
      : type === 'reset-all' ? m.clan_confirm_word_resetall()
      : m.clan_confirm_word_rollback();
  }

  function openConfirmation(type: 'clear' | 'reset' | 'distribute' | 'dedupe' | 'reset-all' | 'rollback') {
    confirmActionType = type;
    confirmInput = '';
    showConfirmModal = true;
  }

  async function handleConfirmAction() {
    if (!canManageSettings || !confirmActionType) return;

    const expected = confirmWordFor(confirmActionType);

    if (confirmInput.toUpperCase() !== expected.toUpperCase()) {
      alert(m.clan_err_wrong_confirm_word());
      return;
    }

    showConfirmModal = false;

    await actionState.run(async () => {
      if (confirmActionType === 'clear') {
        const res = await clearClans();
        if (!res) throw new Error(m.clan_err_clear());
        await refreshData(true);
      } else if (confirmActionType === 'reset') {
        const res = await resetClanSeason();
        if (!res) throw new Error(m.clan_err_reset());
        currentClanSeason = res.currentClanSeason;
        await refreshData(true);
      } else if (confirmActionType === 'distribute') {
        const res = await distributeClans();
        if (!res) throw new Error(m.clan_err_distribute());
        await refreshData(true);
      } else if (confirmActionType === 'dedupe') {
        const res = await dedupeClans();
        if (!res) throw new Error(m.clan_err_dedupe());
        await refreshData(true);
      } else if (confirmActionType === 'reset-all') {
        const res = await resetAllClans();
        if (!res) throw new Error(m.clan_err_reset_all());
        clansEnabled = false;
        currentClanSeason = 1;
        await refreshData(true);
      } else if (confirmActionType === 'rollback') {
        const res = await rollbackClanSeason();
        if (!res) throw new Error(m.clan_err_rollback());
        currentClanSeason = res.currentClanSeason;
        await refreshData(true);
      }
      return true;
    }, {
      successMessage: confirmActionType === 'clear'
        ? m.clan_success_clear_started()
        : confirmActionType === 'reset'
        ? m.clan_success_season_started()
        : confirmActionType === 'distribute'
        ? m.clan_success_distribute_started()
        : confirmActionType === 'dedupe'
        ? m.clan_success_dedupe_started()
        : confirmActionType === 'reset-all'
        ? m.clan_success_reset_all()
        : m.clan_success_rollback()
    });
  }

  function handleDistribute() {
    if (!canManageSettings) return;
    if (clans.length === 0) {
      alert(m.clan_err_no_clan_for_distribute());
      return;
    }
    openConfirmation('distribute');
  }
</script>

<ModulePage
  title={m.clan_page_title()}
  description={m.clan_page_desc()}
  icon="Shield"
  featureKey="clans"
>
  <InlineFeedback state={actionState} />

  <!-- Navigation par Onglets -->
  <div class="flex border-b border-outline-variant/15 mb-6">
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'clans' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'clans'}
    >
      <Papicon icon="Shield" size={15} /> {m.clan_tab_clans()}
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'seasons' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'seasons'}
    >
      <Papicon icon="Calendar" size={15} /> {m.clan_tab_seasons()}
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'points' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'points'}
    >
      <Papicon icon="Sparkles" size={15} /> {m.clan_tab_points()}
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'bets' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'bets'}
    >
      <Papicon icon="Coins" size={15} /> {m.clan_tab_bets()}
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'admin' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'admin'}
    >
      <Papicon icon="Settings" size={15} /> {m.clan_tab_admin()}
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
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-linear-to-r from-tertiary/10 to-secondary/10 border border-tertiary/20 rounded-xl p-6 px-8 shadow-xs relative overflow-hidden group mb-8">
      <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700" style="background: radial-gradient(circle, color-mix(in srgb, var(--color-tertiary) 5%, transparent) 0%, transparent 70%);"></div>
      <div class="flex items-center gap-4 relative z-10">
        <div class="w-12 h-12 rounded-lg bg-tertiary/10 border border-tertiary/20 flex items-center justify-center text-tertiary shadow-inner transition-transform duration-350">
          <Papicon icon="Globe" size={22} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.clan_public_banner_title()}</p>
          <p class="text-xs text-on-surface-variant/70 font-medium">{m.clan_public_page_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-3 shrink-0 relative z-10 w-full sm:w-auto">
        <a
          href={publicClanUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center justify-center gap-2 px-5 py-3 bg-tertiary/20 text-tertiary border border-tertiary/25 rounded-lg text-xs font-semibold hover:bg-tertiary/30 transition-all hover:scale-103 w-full sm:w-auto text-center"
        >
          <Papicon icon="ExternalLink" size={14} />
          {m.clan_public_page_view()}
        </a>
        <button
          onclick={copyPublicClanUrl}
          class="flex items-center justify-center gap-2 px-5 py-3 rounded-lg text-xs font-semibold transition-all hover:scale-103 w-full sm:w-auto {copySuccess ? 'bg-green-500/15 text-green-400 border border-green-500/20' : 'bg-surface-container-high/40 text-on-surface-variant border border-outline-variant/10 hover:bg-surface-container-high/60'}"
        >
          {#if copySuccess}
            <Papicon icon="Check" size={14} />
            {m.clan_public_page_copied()}
          {:else}
            <Papicon icon="Copy" size={14} />
            {m.clan_public_page_copy()}
          {/if}
        </button>
      </div>
    </div>
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-8">
      
      <!-- Left side: General Settings -->
      <div class="xl:col-span-1 space-y-6">
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2"><Papicon icon="Settings" size={18} /> {m.clan_config_heading()}</h3>

          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_enable_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_enable_desc()}</p>
              </div>
              <ToggleSwitch checked={clansEnabled} onToggle={(v) => clansEnabled = v} disabled={!canManageSettings} />
            </div>

            <div class="flex items-center justify-between pt-4 border-t border-outline-variant/10">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_autoassign_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_autoassign_desc()}</p>
              </div>
              <ToggleSwitch checked={clanAutoAssignOnJoin} onToggle={(v) => clanAutoAssignOnJoin = v} disabled={!canManageSettings} />
            </div>

            <div class="flex items-center justify-between pt-4 border-t border-outline-variant/10">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_digest_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_digest_desc()}</p>
              </div>
              <ToggleSwitch checked={clanWeeklyDigest} onToggle={(v) => clanWeeklyDigest = v} disabled={!canManageSettings} />
            </div>

            <!-- Le bilan est publie dans le QG : sans salon, un clan n'en recevra jamais,
                 et rien ne le dirait sans ce rappel. -->
            {#if clanWeeklyDigest && clansWithoutHq.length > 0}
              <div class="flex items-start gap-2.5 rounded-xl bg-amber-500/8 border border-amber-500/25 px-4 py-3">
                <Papicon icon="Warning" size={14} class="text-amber-500 shrink-0 mt-0.5" />
                <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                  {m.clan_digest_missing_hq({ clans: clansWithoutHq.join(', ') })}
                </p>
              </div>
            {/if}
          </div>
        </section>
 
        <!-- Season Rewards / Advantages -->
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2"><Papicon icon="Trophy" size={18} class="text-amber-500" /> {m.clan_rewards_heading()}</h3>

          <div class="space-y-4">
            <div class="space-y-1.5">
              <label for="clan-announcement-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_announcement_channel_label()}</label>
              <SearchableSelect
                id="clan-announcement-channel"
                bind:value={clanAnnouncementChannelId}
                options={[{ id: '', name: m.clan_option_none_disabled() }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
                placeholder={m.clan_select_channel_placeholder()}
                disabled={!canManageSettings}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_announcement_channel_desc()}</p>
            </div>

            <div class="space-y-4 pt-2 border-t border-outline-variant/10">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">{m.clan_boost_giveaways_title()}</span>
                  <p class="text-xs text-on-surface-variant/70">{m.clan_boost_giveaways_desc()}</p>
                </div>
                <ToggleSwitch checked={clanRewardGiveaway} onToggle={(v) => clanRewardGiveaway = v} disabled={!canManageSettings} />
              </div>

              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">{m.clan_leader_role_reward_title()}</span>
                  <p class="text-xs text-on-surface-variant/70">{m.clan_leader_role_reward_desc()}</p>
                </div>
                <ToggleSwitch checked={clanRewardLeaderRole} onToggle={(v) => clanRewardLeaderRole = v} disabled={!canManageSettings} />
              </div>
            </div>
          </div>
        </section>

        <!-- Seasons control -->
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-2">
            <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Calendar" size={18} /> {m.clan_current_season_heading()}</h3>
            <span class="px-3 py-1 bg-amber-500/10 text-amber-500 text-xs font-bold rounded-full">{m.clan_season_badge({ n: currentClanSeason })}</span>
          </div>

          <div class="space-y-4">
            <p class="text-xs text-on-surface-variant/70">
              {m.clan_season_reset_desc()}
            </p>
            {#if canManageSettings}
              <button
                onclick={() => openConfirmation('reset')}
                class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
              >
                <Papicon icon="Refresh" size={14} /> {m.clan_reset_season_btn()}
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
              {m.clan_bg_task_active()}
            </h3>

            <div class="space-y-2">
              <div class="flex justify-between text-xs font-medium text-on-surface-variant">
                <span>{taskInProgress.type === 'distribute' ? m.clan_task_type_distribute() : taskInProgress.type === 'dedupe' ? m.clan_task_type_dedupe() : m.clan_task_type_clear()}</span>
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
            <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Shield" size={18} /> {m.clan_list_heading()}</h3>
            <div class="flex gap-2">
              {#if canManageSettings}
                <button
                  onclick={() => openConfirmation('clear')}
                  disabled={!!taskInProgress}
                  class="flex items-center gap-1.5 px-3 py-1.5 border border-rose-500/30 hover:bg-rose-500/10 text-rose-500 font-bold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  title={taskInProgress ? m.clan_task_running_hint() : m.clan_clear_all_title()}
                >
                  <Papicon icon="Trash" size={12} /> {m.clan_clear_all_btn()}
                </button>
                <button
                  onclick={handleDistribute}
                  disabled={!!taskInProgress}
                  class="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/15 hover:bg-secondary/25 text-secondary font-bold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-secondary/15"
                  title={taskInProgress ? m.clan_task_running_hint() : m.clan_distribute_title()}
                >
                  <Papicon icon="Users" size={12} /> {m.clan_distribute_btn()}
                </button>
                {#if clans.length > 1}
                  <button
                    onclick={() => openConfirmation('dedupe')}
                    disabled={!!taskInProgress}
                    class="flex items-center gap-1.5 px-3 py-1.5 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface-variant font-bold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    title={taskInProgress ? m.clan_task_running_hint() : m.clan_dedupe_title()}
                  >
                    <Papicon icon="Refresh" size={12} /> {m.clan_dedupe_btn()}
                  </button>
                {/if}
                <button
                  onclick={openCreateModal}
                  class="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-on-primary font-bold text-xs rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <Papicon icon="Add" size={12} /> {m.clan_new_btn()}
                </button>
              {/if}
            </div>
          </div>

          {#if clans.length === 0}
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <p class="text-sm text-on-surface-variant/60 font-medium">{m.clan_empty_title()}</p>
              <p class="text-xs text-on-surface-variant/40">{m.clan_empty_desc()}</p>
            </div>
          {:else}
            <!-- Clans table -->
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="border-b border-outline-variant/10 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-wider">
                    <th class="pb-3">{m.clan_col_name()}</th>
                    <th class="pb-3">{m.clan_col_role()}</th>
                    <th class="pb-3">{m.clan_col_general_channel()}</th>
                    <th class="pb-3">{m.clan_col_leader_role()}</th>
                    <th class="pb-3 text-center">{m.clan_col_members()}</th>
                    <th class="pb-3 text-right">{m.clan_col_total_xp()}</th>
                    {#if canManageSettings}
                      <th class="pb-3 text-right">{m.clan_col_actions()}</th>
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
                          {availableRoles.find(r => r.id === clan.roleId)?.name || m.clan_id_fallback({ id: clan.roleId })}
                        </span>
                      </td>
                      <td class="py-4">
                        {#if clan.generalChannelId}
                          <span class="text-xs text-on-surface-variant">
                            #{availableChannels.find(ch => ch.id === clan.generalChannelId)?.name || m.clan_id_fallback({ id: clan.generalChannelId })}
                          </span>
                        {:else}
                          <span class="text-xs text-on-surface-variant/40 italic">{m.clan_none_label()}</span>
                        {/if}
                      </td>
                      <td class="py-4">
                        {#if clan.leaderRoleId}
                          <span class="px-2 py-1 bg-primary/10 rounded text-xs text-primary font-medium">
                            {availableRoles.find(r => r.id === clan.leaderRoleId)?.name || m.clan_id_fallback({ id: clan.leaderRoleId })}
                          </span>
                        {:else}
                          <span class="text-xs text-on-surface-variant/40 italic">{m.clan_none_label()}</span>
                        {/if}
                      </td>
                      <td class="py-4 text-center font-medium text-xs text-on-surface">
                        {clan.memberCount ?? 0}
                      </td>
                      <td class="py-4 text-right font-bold text-xs text-amber-500">
                        {(clan.totalXp ?? 0).toLocaleString(dateLocale())} XP
                      </td>
                      {#if canManageSettings}
                        <td class="py-4 text-right space-x-2">
                          <button
                            onclick={() => openEditModal(clan)}
                            class="p-1.5 hover:bg-surface-container-high rounded-lg text-on-surface-variant transition-colors cursor-pointer inline-flex"
                            title={m.clan_edit_title()}
                          >
                            <Papicon icon="Edit" size={14} />
                          </button>
                          <button
                            onclick={() => handleDeleteClan(clan)}
                            class="p-1.5 hover:bg-rose-500/10 text-rose-500 rounded-lg transition-colors cursor-pointer inline-flex"
                            title={m.clan_delete_title()}
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
                {m.clan_current_season_heading()}
              </h3>
              <span class="px-3 py-1 bg-amber-500/10 text-amber-500 text-xs font-bold rounded-full">{m.clan_season_badge({ n: currentClanSeason })}</span>
            </div>

            <div class="space-y-4">
              <div class="p-4 bg-surface-container-high/20 rounded-xl border border-outline-variant/10 space-y-3">
                <span class="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest block">{m.clan_time_remaining_label()}</span>
                <div class="flex items-center gap-2">
                  <span class="text-xl font-extrabold text-on-surface">{timeRemaining}</span>
                </div>
                {#if clanSeasonStartsAt && clanSeasonEndsAt}
                  <p class="text-[10px] text-on-surface-variant/50 leading-relaxed">
                    {m.clan_season_start_label({ date: new Date(clanSeasonStartsAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) })}
                    <br />
                    {m.clan_season_end_label({ date: new Date(clanSeasonEndsAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) })}
                  </p>
                {/if}
              </div>

              <p class="text-xs text-on-surface-variant/70 leading-relaxed">
                {m.clan_season_close_desc()}
              </p>

              {#if canManageSettings}
                <button
                  type="button"
                  onclick={() => openConfirmation('reset')}
                  class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                >
                  <Papicon icon="Refresh" size={14} /> {m.clan_close_season_btn()}
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
              {m.clan_plan_season_heading()}
            </h3>

            {#if canManageSettings}
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest mr-1">{m.clan_quick_fill_label()}</span>
                <button type="button" onclick={() => applyQuickRange(1)} class="px-2.5 py-1 bg-surface-container-high/50 hover:bg-primary/15 hover:text-primary text-on-surface-variant text-[11px] font-semibold rounded-md transition-colors cursor-pointer">{m.clan_month_1()}</button>
                <button type="button" onclick={() => applyQuickRange(3)} class="px-2.5 py-1 bg-surface-container-high/50 hover:bg-primary/15 hover:text-primary text-on-surface-variant text-[11px] font-semibold rounded-md transition-colors cursor-pointer">{m.clan_quarter()}</button>
                <button type="button" onclick={() => applyQuickRange(6)} class="px-2.5 py-1 bg-surface-container-high/50 hover:bg-primary/15 hover:text-primary text-on-surface-variant text-[11px] font-semibold rounded-md transition-colors cursor-pointer">{m.clan_month_6()}</button>
                <button type="button" onclick={() => applyQuickRange(12)} class="px-2.5 py-1 bg-surface-container-high/50 hover:bg-primary/15 hover:text-primary text-on-surface-variant text-[11px] font-semibold rounded-md transition-colors cursor-pointer">{m.clan_year_1()}</button>
                {#if canChainNextSeason}
                  <button type="button" onclick={applyChainAfterCurrent} class="px-2.5 py-1 bg-secondary/15 hover:bg-secondary/25 text-secondary text-[11px] font-semibold rounded-md transition-colors cursor-pointer flex items-center gap-1" title={m.clan_chain_title()}>
                    <Papicon icon="Refresh" size={11} /> {m.clan_chain_btn()}
                  </button>
                {/if}
              </div>
            {/if}

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <!-- Début de saison -->
              <div class="space-y-2">
                <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_start_date_label()}</span>
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
                <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_end_date_label()}</span>
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
              <p class="font-bold flex items-center gap-1.5"><Papicon icon="Lightbulb" size={13} /> {m.clan_auto_renew_title()}</p>
              <p>{m.clan_auto_renew_desc()}</p>
              {#if savedClanSeasonStartsAt && savedClanSeasonEndsAt}
                <p class="pt-1 flex items-center gap-1.5 text-primary/90">
                  <Papicon icon="Refresh" size={12} /> {m.clan_auto_renew_active()}
                </p>
              {:else}
                <p class="pt-1 text-primary/70">{m.clan_auto_renew_inactive()}</p>
              {/if}
            </div>

            {#if canManageSettings}
              <div class="flex items-center justify-end gap-3 pt-4 border-t border-outline-variant/10">
                <button
                  type="button"
                  onclick={handleClearSeasonPlanning}
                  class="px-4 py-2 border border-outline-variant/30 text-on-surface hover:bg-surface-container-high/40 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                  disabled={!savedClanSeasonStartsAt && !savedClanSeasonEndsAt && !startDate && !endDate}
                >
                  {m.clan_cancel_planning_btn()}
                </button>
                <button
                  type="button"
                  onclick={handleSaveSeasonPlanning}
                  class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                  disabled={!startDate || !endDate}
                >
                  {m.clan_save_planning_btn()}
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
              {m.clan_points_config_heading()}
            </h3>

            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">{m.clan_levelup_gain_title()}</span>
                  <p class="text-xs text-on-surface-variant/70">{m.clan_levelup_gain_desc()}</p>
                </div>
                <ToggleSwitch checked={clanXpFromLevelUp} onToggle={(v) => clanXpFromLevelUp = v} disabled={!canManageSettings} />
              </div>

              {#if clanXpFromLevelUp}
                <div class="space-y-1.5 pt-2 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
                  <label for="clan-xp-levelup-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_levelup_points_label()}</label>
                  <div class="flex items-center gap-2">
                    <input
                      id="clan-xp-levelup-amount"
                      type="number"
                      bind:value={clanXpPerLevelUp}
                      min="0"
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                      disabled={!canManageSettings}
                    />
                    <span class="text-xs text-on-surface-variant/60 font-semibold shrink-0">{m.clan_xp_per_level_unit()}</span>
                  </div>
                </div>

                <div class="flex items-center justify-between pt-3 border-t border-outline-variant/10">
                  <div>
                    <span class="text-sm font-medium text-on-surface">{m.clan_proportional_title()}</span>
                    <p class="text-xs text-on-surface-variant/70">{m.clan_proportional_desc()}</p>
                  </div>
                  <ToggleSwitch checked={clanXpLevelUpProportional} onToggle={(v) => clanXpLevelUpProportional = v} disabled={!canManageSettings} />
                </div>

                {#if clanXpLevelUpProportional}
                  <div class="space-y-3 pt-2 animate-in slide-in-from-top-2 duration-200">
                    <div class="space-y-1.5">
                      <label for="clan-xp-reference-level" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_reference_level_label()}</label>
                      <input
                        id="clan-xp-reference-level"
                        type="number"
                        bind:value={clanXpReferenceLevel}
                        min={MIN_CLAN_REFERENCE_LEVEL}
                        max="1000"
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                        disabled={!canManageSettings}
                      />
                      <p class="text-[11px] text-on-surface-variant/50 ml-1">{m.clan_reference_level_hint({ level: clanXpReferenceLevel, points: clanXpPerLevelUp })}</p>
                    </div>

                    <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/20 overflow-hidden">
                      <table class="w-full text-left">
                        <thead>
                          <tr class="border-b border-outline-variant/10">
                            <th class="px-4 py-2 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.clan_preview_level()}</th>
                            <th class="px-4 py-2 text-right text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.clan_preview_points()}</th>
                          </tr>
                        </thead>
                        <tbody class="divide-y divide-outline-variant/5">
                          {#each clanPointsPreview as row}
                            <tr class:font-bold={row.isReference}>
                              <td class="px-4 py-2 text-xs text-on-surface-variant">{m.clan_preview_level_n({ level: row.level })}</td>
                              <td class="px-4 py-2 text-right text-xs text-primary font-semibold">{row.points.toLocaleString()}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    </div>
                  </div>
                {/if}
              {/if}

              <div class="flex items-center justify-between pt-4 border-t border-outline-variant/10">
                <div>
                  <span class="text-sm font-medium text-on-surface">{m.clan_boost_gain_title()}</span>
                  <p class="text-xs text-on-surface-variant/70">{m.clan_boost_gain_desc()}</p>
                </div>
                <ToggleSwitch checked={clanXpFromBoost} onToggle={(v) => clanXpFromBoost = v} disabled={!canManageSettings} />
              </div>

              {#if clanXpFromBoost}
                <div class="space-y-1.5 pt-2 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
                  <label for="clan-xp-boost-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_boost_points_label()}</label>
                  <div class="flex items-center gap-2">
                    <input
                      id="clan-xp-boost-amount"
                      type="number"
                      bind:value={clanXpPerBoost}
                      min="0"
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                      disabled={!canManageSettings}
                    />
                    <span class="text-xs text-on-surface-variant/60 font-semibold shrink-0">{m.clan_boost_points_unit()}</span>
                  </div>
                </div>
              {/if}
            </div>
          </section>

          <!-- Lien avec le Daily Algo : verrouillé si le module est inactif -->
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="Code" size={16} class="text-amber-500" />
              {m.clan_da_bridge_heading()}
            </h3>

            {#if !dailyAlgoEnabled}
              <div class="p-5 bg-surface-container-high/20 rounded-xl border border-outline-variant/10 flex flex-col items-center justify-center text-center space-y-3">
                <span class="text-2xl">🔒</span>
                <div>
                  <h4 class="text-sm font-semibold text-on-surface">{m.clan_da_disabled_title()}</h4>
                  <p class="text-xs text-on-surface-variant/70 mt-1">
                    {m.clan_da_disabled_desc()}
                  </p>
                </div>
              </div>
            {:else}
              <InlineFeedback state={bridgeAction} />

              <div class="space-y-4">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-sm font-medium text-on-surface">{m.clan_da_convert_title()}</span>
                    <p class="text-xs text-on-surface-variant/70">
                      {m.clan_da_convert_desc()}
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={bridge.clanPointsFromDailyAlgo}
                    onToggle={(v) => bridge.clanPointsFromDailyAlgo = v}
                    disabled={!canManageSettings}
                  />
                </div>

                {#if bridge.clanPointsFromDailyAlgo}
                  <div class="space-y-4 pt-2 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
                    <div class="space-y-1.5">
                      <label for="clan-da-rate" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_da_rate_label()}</label>
                      <input
                        id="clan-da-rate"
                        type="number"
                        min="0.1"
                        max="100"
                        step="0.1"
                        bind:value={bridge.clanPointsFromDailyAlgoRate}
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                        disabled={!canManageSettings}
                      />
                      <p class="text-[10px] text-on-surface-variant/50 ml-1">
                        {m.clan_da_rate_hint()}
                      </p>
                    </div>

                    <div class="grid grid-cols-3 gap-3">
                      <div class="space-y-1.5">
                        <label for="clan-da-top1" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">🥇 {m.clan_da_bonus_label()}</label>
                        <input id="clan-da-top1" type="number" min="0" step="5" bind:value={bridge.clanPointsDailyAlgoTop1} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold" disabled={!canManageSettings} />
                      </div>
                      <div class="space-y-1.5">
                        <label for="clan-da-top2" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">🥈 {m.clan_da_bonus_label()}</label>
                        <input id="clan-da-top2" type="number" min="0" step="5" bind:value={bridge.clanPointsDailyAlgoTop2} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold" disabled={!canManageSettings} />
                      </div>
                      <div class="space-y-1.5">
                        <label for="clan-da-top3" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">🥉 {m.clan_da_bonus_label()}</label>
                        <input id="clan-da-top3" type="number" min="0" step="5" bind:value={bridge.clanPointsDailyAlgoTop3} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold" disabled={!canManageSettings} />
                      </div>
                    </div>
                  </div>
                {/if}

                {#if canManageSettings}
                  <button
                    onclick={saveBridgeSettings}
                    disabled={bridgeAction.state.loading}
                    class="w-full py-3 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded-lg text-[13px] font-medium transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    {bridgeAction.state.loading ? m.clan_da_saving_btn() : m.clan_da_save_btn()}
                  </button>
                {/if}
              </div>
            {/if}
          </section>
        </div>

        <!-- Right Column: Manual Points Adjustments -->
        <div class="xl:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-6 items-start">

          <!-- Card 1: Add points to a Clan -->
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="Shield" size={16} class="text-amber-500" />
              {m.clan_points_clan_heading()}
            </h3>

            <div class="space-y-4">
              <div class="space-y-1.5">
                <label for="manual-points-clan-select" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_select_clan_label()}</label>
                <SearchableSelect
                  id="manual-points-clan-select"
                  bind:value={selectedClanIdForPoints}
                  options={clans.map(c => ({ id: c.id, name: c.name }))}
                  placeholder={m.clan_choose_clan_placeholder()}
                  disabled={!canManageSettings}
                />
              </div>

              <div class="space-y-1.5">
                <label for="manual-points-clan-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_xp_amount_label()}</label>
                <input
                  id="manual-points-clan-amount"
                  type="number"
                  step="1"
                  min="1"
                  max={MAX_MANUAL_POINTS}
                  bind:value={manualPointsAmountClan}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                  disabled={!canManageSettings}
                />
              </div>

              {#if canManageSettings}
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onclick={() => handleClanPoints(1)}
                    class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/80 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                    disabled={!selectedClanIdForPoints}
                  >
                    <Papicon icon="Sparkles" size={14} /> {m.clan_adjust_clan_points_btn()}
                  </button>
                  <button
                    type="button"
                    onclick={() => handleClanPoints(-1)}
                    class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/20 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                    disabled={!selectedClanIdForPoints}
                  >
                    <Papicon icon="Minus" size={14} /> {m.clan_remove_clan_points_btn()}
                  </button>
                </div>
              {/if}
            </div>
          </section>

          <!-- Card 2: Add points to a Member -->
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2">
              <Papicon icon="user" size={16} class="text-secondary" />
              {m.clan_points_member_heading()}
            </h3>

            <div class="space-y-4">
              <div class="space-y-1.5">
                <label for="manual-points-member-user-id" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_member_id_label()}</label>
                <MemberSearchSelect
                  id="manual-points-member-user-id"
                  bind:value={manualPointsMemberUserId}
                  placeholder={m.clan_id_placeholder()}
                  disabled={!canManageSettings}
                />
              </div>

              <div class="space-y-1.5">
                <label for="manual-points-member-amount" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest block ml-1">{m.clan_xp_amount_label()}</label>
                <input
                  id="manual-points-member-amount"
                  type="number"
                  step="1"
                  min="1"
                  max={MAX_MANUAL_POINTS}
                  bind:value={manualPointsAmountMember}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                  disabled={!canManageSettings}
                />
              </div>

              {#if canManageSettings}
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onclick={() => handleMemberPoints(1)}
                    class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/80 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                    disabled={!manualPointsMemberUserId}
                  >
                    <Papicon icon="Sparkles" size={14} /> {m.clan_adjust_member_points_btn()}
                  </button>
                  <button
                    type="button"
                    onclick={() => handleMemberPoints(-1)}
                    class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/20 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                    disabled={!manualPointsMemberUserId}
                  >
                    <Papicon icon="Minus" size={14} /> {m.clan_remove_member_points_btn()}
                  </button>
                </div>
              {/if}
            </div>
          </section>

        </div>
      </div>
    {:else if activeTab === 'bets'}
      <div class="space-y-6" transition:fade={{ duration: 150 }}>
        <InlineFeedback state={betsAction} />

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
            <div>
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Coins" size={18} /> {m.clan_bets_heading()}</h3>
              <p class="text-xs text-on-surface-variant/70 mt-1">{m.clan_bets_desc()}</p>
            </div>
            <ToggleSwitch checked={betSettings.betsEnabled} onToggle={(v) => betSettings.betsEnabled = v} disabled={!canManageSettings} />
          </div>

          {#if !clansEnabled}
            <p class="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
              {m.clan_bets_requires_clans()}
            </p>
          {/if}

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="space-y-1.5">
              <label for="bet-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_channel_label()}</label>
              <SearchableSelect
                id="bet-channel"
                bind:value={betSettings.betChannelId}
                options={[{ id: '', name: m.clan_option_none_disabled() }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
                placeholder={m.clan_select_channel_placeholder()}
                disabled={!canManageSettings}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_channel_desc()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="bet-announcement-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_announcement_label()}</label>
              <SearchableSelect
                id="bet-announcement-channel"
                bind:value={betSettings.betAnnouncementChannelId}
                options={[{ id: '', name: m.clan_option_none_disabled() }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
                placeholder={m.clan_select_channel_placeholder()}
                disabled={!canManageSettings}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_announcement_desc()}</p>
            </div>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-2 border-t border-outline-variant/10">
            <div class="space-y-1.5">
              <label for="bet-min-stake" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_min_stake_label()}</label>
              <input
                id="bet-min-stake"
                type="number"
                bind:value={betSettings.betMinStake}
                min={BET_STAKE_FLOOR}
                max={BET_STAKE_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5">
              <label for="bet-max-stake" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_max_stake_label()}</label>
              <input
                id="bet-max-stake"
                type="number"
                bind:value={betSettings.betMaxStake}
                min={BET_STAKE_FLOOR}
                max={BET_STAKE_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5">
              <label for="bet-max-open" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_max_open_label()}</label>
              <input
                id="bet-max-open"
                type="number"
                bind:value={betSettings.betMaxOpenPerMember}
                min="1"
                max={BET_OPEN_PER_MEMBER_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5">
              <label for="bet-window" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_window_label()}</label>
              <input
                id="bet-window"
                type="number"
                bind:value={betSettings.betAcceptWindowHours}
                min={BET_ACCEPT_WINDOW_HOURS_MIN}
                max={BET_ACCEPT_WINDOW_HOURS_MAX}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings}
              />
            </div>
          </div>

        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
          <div class="border-b border-outline-variant/15 pb-3">
            <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Shield" size={18} /> {m.clan_bets_managers_heading()}</h3>
            <p class="text-xs text-on-surface-variant/70 mt-1">{m.clan_bets_managers_desc()}</p>
          </div>

          <ul class="text-xs text-on-surface-variant/70 space-y-1 list-disc list-inside">
            <li>{m.clan_bets_managers_scope_winner()}</li>
            <li>{m.clan_bets_managers_scope_cancel()}</li>
          </ul>

          {#if betManagerRoles.length > 0}
            <div class="flex flex-wrap gap-2">
              {#each betManagerRoles as role (role.id)}
                <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-primary/15 border border-primary/40 text-primary">
                  @{role.name}
                  <button
                    type="button"
                    class="cursor-pointer hover:text-on-surface disabled:opacity-40"
                    aria-label={m.clan_bets_managers_remove({ role: role.name })}
                    disabled={!canManageSettings}
                    onclick={() => removeBetManagerRole(role.id)}
                  >
                    ×
                  </button>
                </span>
              {/each}
            </div>
          {:else}
            <p class="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
              {m.clan_bets_managers_empty()}
            </p>
          {/if}

          <div class="space-y-1.5">
            <label for="bet-manager-add" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_managers_add_label()}</label>
            <SearchableSelect
              id="bet-manager-add"
              bind:value={roleToAdd}
              options={availableRoles
                .filter((role: { id: string }) => !betSettings.betResolverRoleIds.includes(role.id))
                .map((role: { id: string; name: string }) => ({ id: role.id, name: `@${role.name}` }))}
              placeholder={m.clan_bets_managers_add_placeholder()}
              disabled={!canManageSettings}
            />
            <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_managers_admin_note()}</p>
          </div>
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="border-b border-outline-variant/15 pb-3">
            <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Users" size={18} /> {m.clan_bets_shapes_heading()}</h3>
            <p class="text-xs text-on-surface-variant/70 mt-1">{m.clan_bets_shapes_desc()}</p>
          </div>

          <div class="space-y-4">
            <div class="flex items-center justify-between gap-4">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_bets_allow_pool_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_bets_allow_pool_desc()}</p>
              </div>
              <ToggleSwitch checked={betSettings.betAllowPool} onToggle={(v) => betSettings.betAllowPool = v} disabled={!canManageSettings} />
            </div>

            <div class="flex items-center justify-between gap-4">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_bets_allow_teams_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_bets_allow_teams_desc()}</p>
              </div>
              <ToggleSwitch checked={betSettings.betAllowTeams} onToggle={(v) => betSettings.betAllowTeams = v} disabled={!canManageSettings} />
            </div>

            <div class="flex items-center justify-between gap-4">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_bets_allow_open_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_bets_allow_open_desc()}</p>
              </div>
              <ToggleSwitch checked={betSettings.betAllowOpen} onToggle={(v) => betSettings.betAllowOpen = v} disabled={!canManageSettings} />
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="bet-stake-mode" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_stake_mode_label()}</label>
            <select
              id="bet-stake-mode"
              bind:value={betSettings.betStakeMode}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
              disabled={!canManageSettings}
            >
              <option value="PER_MEMBER">{m.clan_bets_stake_mode_per_member()}</option>
              <option value="PER_SIDE">{m.clan_bets_stake_mode_per_side()}</option>
            </select>
            <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_stake_mode_desc()}</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="space-y-1.5">
              <label for="bet-max-participants" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_max_participants_label()}</label>
              <input
                id="bet-max-participants"
                type="number"
                bind:value={betSettings.betMaxParticipants}
                min={BET_PARTICIPANTS_MIN}
                max={BET_PARTICIPANTS_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_max_participants_desc()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="bet-max-sides" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_max_sides_label()}</label>
              <input
                id="bet-max-sides"
                type="number"
                bind:value={betSettings.betMaxSides}
                min={BET_SIDES_MIN}
                max={BET_SIDES_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings || !betSettings.betAllowTeams}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_max_sides_desc()}</p>
            </div>
          </div>
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
            <div>
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Trophy" size={18} /> {m.clan_bets_reward_heading()}</h3>
              <p class="text-xs text-on-surface-variant/70 mt-1">{m.clan_bets_reward_desc()}</p>
            </div>
            <ToggleSwitch checked={betSettings.betSeasonRewardEnabled} onToggle={(v) => betSettings.betSeasonRewardEnabled = v} disabled={!canManageSettings} />
          </div>

          <div class="space-y-1.5">
            <label for="bet-reward-role" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_reward_role_label()}</label>
            <SearchableSelect
              id="bet-reward-role"
              bind:value={betSettings.betSeasonRewardRoleId}
              options={availableRoles.map((role: { id: string; name: string }) => ({ id: role.id, name: `@${role.name}` }))}
              placeholder={m.clan_bets_reward_role_placeholder()}
              disabled={!canManageSettings || !betSettings.betSeasonRewardEnabled}
            />
            <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_reward_role_desc()}</p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="space-y-1.5">
              <label for="bet-reward-1" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_reward_top1_label()}</label>
              <input
                id="bet-reward-1"
                type="number"
                bind:value={betSettings.betRewardTop1}
                min="0"
                max={BET_SEASON_REWARD_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings || !betSettings.betSeasonRewardEnabled}
              />
            </div>
            <div class="space-y-1.5">
              <label for="bet-reward-2" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_reward_top2_label()}</label>
              <input
                id="bet-reward-2"
                type="number"
                bind:value={betSettings.betRewardTop2}
                min="0"
                max={BET_SEASON_REWARD_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings || !betSettings.betSeasonRewardEnabled}
              />
            </div>
            <div class="space-y-1.5">
              <label for="bet-reward-3" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_reward_top3_label()}</label>
              <input
                id="bet-reward-3"
                type="number"
                bind:value={betSettings.betRewardTop3}
                min="0"
                max={BET_SEASON_REWARD_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings || !betSettings.betSeasonRewardEnabled}
              />
            </div>
          </div>
          <p class="text-[10px] text-on-surface-variant/60">{m.clan_bets_reward_amounts_desc()}</p>
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
            <div>
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="AlertTriangle" size={18} class="text-amber-500" /> {m.clan_bets_debt_heading()}</h3>
              <p class="text-xs text-on-surface-variant/70 mt-1">{m.clan_bets_debt_desc()}</p>
            </div>
            <ToggleSwitch checked={betSettings.betAllowDebt} onToggle={(v) => betSettings.betAllowDebt = v} disabled={!canManageSettings} />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="space-y-1.5">
              <label for="bet-max-debt" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_bets_max_debt_label()}</label>
              <input
                id="bet-max-debt"
                type="number"
                bind:value={betSettings.betMaxDebt}
                min="0"
                max={BET_DEBT_CEILING}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold"
                disabled={!canManageSettings || !betSettings.betAllowDebt}
              />
              <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.clan_bets_max_debt_desc()}</p>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div>
                <span class="text-sm font-medium text-on-surface">{m.clan_bets_debt_reset_title()}</span>
                <p class="text-xs text-on-surface-variant/70">{m.clan_bets_debt_reset_desc()}</p>
              </div>
              <ToggleSwitch checked={betSettings.betDebtResetOnSeason} onToggle={(v) => betSettings.betDebtResetOnSeason = v} disabled={!canManageSettings || !betSettings.betAllowDebt} />
            </div>
          </div>

          {#if debts.length > 0}
            <div class="space-y-2 pt-2 border-t border-outline-variant/10">
              <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.clan_bets_debt_list_label()}</p>
              {#each debts as debt (debt.userId)}
                <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 rounded-lg px-4 py-2.5">
                  <span class="text-sm text-on-surface truncate">{debt.displayName ?? debt.userId}</span>
                  <div class="flex items-center gap-3 shrink-0">
                    <span class="text-sm font-bold text-amber-600 text-right">
                      {debt.amount.toLocaleString(dateLocale())} pts
                      {#if debt.engaged > 0}
                        <span class="block text-[10px] font-medium text-on-surface-variant/60">
                          {m.clan_bets_debt_engaged_hint({ amount: debt.engaged.toLocaleString(dateLocale()) })}
                        </span>
                      {/if}
                    </span>
                    <button
                      type="button"
                      class="text-xs font-semibold text-rose-500 hover:underline cursor-pointer disabled:opacity-40"
                      disabled={!canManageSettings}
                      onclick={() => openDebtClear(debt)}
                    >
                      {m.clan_bets_debt_clear()}
                    </button>
                  </div>
                </div>
              {/each}
              {#if debtCount > debts.length}
                <p class="text-[11px] text-on-surface-variant/60 italic pt-1">
                  {m.clan_bets_list_truncated({ shown: debts.length, total: debtCount })}
                </p>
              {/if}
            </div>
          {:else}
            <p class="text-xs text-on-surface-variant/60 pt-2 border-t border-outline-variant/10">{m.clan_bets_debt_empty()}</p>
          {/if}
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-2 flex items-center gap-2"><Papicon icon="Calendar" size={18} /> {m.clan_bets_history_heading()}</h3>

          {#if betsLoading}
            <Skeleton height="160px" />
          {:else if bets.length === 0}
            <p class="text-xs text-on-surface-variant/60">{m.clan_bets_history_empty()}</p>
          {:else}
            <div class="space-y-2">
              {#each bets as bet (bet.id)}
                <div class="bg-surface-container-high/30 rounded-lg px-4 py-3 space-y-1.5">
                  <div class="flex items-start justify-between gap-4">
                    <span class="text-sm font-medium text-on-surface">{bet.subject}</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 {betStatusClass(bet.status)}">
                      {betStatusLabels[bet.status] ?? bet.status}
                    </span>
                  </div>
                  <div class="text-xs text-on-surface-variant/70 space-y-0.5">
                    {#each bet.sides as side (side.id)}
                      <p class:font-semibold={side.won} class:text-primary={side.won}>
                        {#if side.won}🏆 {/if}{side.label}{side.capacity ? ` (${side.members.length}/${side.capacity})` : ''} ·
                        {#if side.members.length === 0}
                          <span class="opacity-60">-</span>
                        {:else}
                          {side.members
                            .map((entry) => (entry.displayName ?? entry.userId) + (entry.clanName ? ` (${entry.clanName})` : ''))
                            .join(', ')}
                        {/if}
                      </p>
                    {/each}
                  </div>
                  <p class="text-[11px] text-on-surface-variant/60">
                    {m.clan_bets_history_line({
                      stake: bet.stake.toLocaleString(dateLocale()),
                      pot: bet.pot.toLocaleString(dateLocale()),
                      season: bet.season,
                    })}
                    {#if bet.creditUsed > 0}· 💳 {bet.creditUsed.toLocaleString(dateLocale())}{/if}
                  </p>
                </div>
              {/each}
              {#if betCount > bets.length}
                <p class="text-[11px] text-on-surface-variant/60 italic pt-1">
                  {m.clan_bets_list_truncated({ shown: bets.length, total: betCount })}
                </p>
              {/if}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeTab === 'admin'}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6" transition:fade={{ duration: 150 }}>
          
          <!-- Card 1: Recommencer à la Saison 1 (Reset All) -->
          <section class="bg-surface-container-low/40 border border-rose-500/20 p-6 rounded-xl space-y-6 flex flex-col justify-between">
            <div class="space-y-4">
              <h3 class="text-lg font-semibold border-b border-rose-500/10 pb-2 flex items-center gap-2 text-rose-500">
                <Papicon icon="AlertTriangle" size={16} />
                {m.clan_reset_all_heading()}
              </h3>

              <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                {m.clan_reset_all_desc()}
              </p>

              <div class="p-3 bg-rose-500/10 rounded-lg border border-rose-500/10 text-rose-500 text-xs flex gap-2">
                <Papicon icon="Info" size={16} class="shrink-0 mt-0.5" />
                <span><strong>{m.clan_reset_all_warning_prefix()}</strong> {m.clan_reset_all_warning({ tab: m.clan_tab_seasons() })}</span>
              </div>
            </div>

            {#if canManageSettings}
              <button
                type="button"
                onclick={() => openConfirmation('reset-all')}
                class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer mt-4"
              >
                <Papicon icon="Trash" size={14} /> {m.clan_reset_all_btn()}
              </button>
            {/if}
          </section>

          <!-- Card 2: Annuler la dernière saison (Rollback) -->
          <section class="bg-surface-container-low/40 border border-orange-500/20 p-6 rounded-xl space-y-6 flex flex-col justify-between">
            <div class="space-y-4">
              <h3 class="text-lg font-semibold border-b border-orange-500/10 pb-2 flex items-center gap-2 text-orange-500">
                <Papicon icon="RotateCcw" size={16} />
                {m.clan_rollback_heading()}
              </h3>

              <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                {m.clan_rollback_desc1({ current: currentClanSeason, prev: currentClanSeason - 1 })}
              </p>

              <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                {m.clan_rollback_desc2({ current: currentClanSeason, prevprev: currentClanSeason - 2 })}
              </p>
            </div>

            {#if canManageSettings}
              <button
                type="button"
                onclick={() => openConfirmation('rollback')}
                class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer mt-4"
                disabled={currentClanSeason <= 1}
              >
                <Papicon icon="RotateCcw" size={14} /> {m.clan_rollback_heading()}
              </button>
            {/if}
          </section>

        </div>
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
        <h3 class="text-xl font-semibold">{editingClan ? m.clan_modal_edit_title() : m.clan_modal_create_title()}</h3>
        <p class="text-xs text-on-surface-variant/80">{m.clan_modal_desc()}</p>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleSaveClan(); }} class="space-y-4">
        <div class="space-y-1.5">
          <label for="clan-name" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_name_label()}</label>
          <input
            id="clan-name"
            type="text"
            bind:value={formName}
            placeholder={m.clan_name_placeholder()}
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
            required
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="clan-desc" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_desc_label()}</label>
          <textarea
            id="clan-desc"
            bind:value={formDescription}
            placeholder={m.clan_desc_placeholder()}
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-20"
            disabled={!canManageSettings}
          ></textarea>
        </div>

        <div class="space-y-1.5">
          <label for="clan-role" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_role_label()}</label>
          <SearchableSelect
            id="clan-role"
            bind:value={formRoleId}
            options={availableRoles.map(r => ({ id: r.id, name: r.name }))}
            placeholder={m.clan_role_placeholder()}
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="clan-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_general_channel_label()}</label>
          <SearchableSelect
            id="clan-channel"
            bind:value={formGeneralChannelId}
            options={[{ id: '', name: m.clan_option_none_disabled() }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
            placeholder={m.clan_general_channel_placeholder()}
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="clan-leader-role" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">{m.clan_leader_role_label()}</label>
          <SearchableSelect
            id="clan-leader-role"
            bind:value={formLeaderRoleId}
            options={[{ id: '', name: m.clan_option_none_disabled() }, ...availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))]}
            placeholder={m.clan_leader_role_placeholder()}
            disabled={!canManageSettings}
          />
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onclick={() => showModal = false}
            class="px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            {m.clan_cancel_btn()}
          </button>
          <button
            type="submit"
            class="px-4 py-2 bg-primary text-on-primary text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
          >
            {m.clan_save_btn()}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Modal: Effacement d'une dette -->
{#if debtToClear}
  {@const target = debtToClear}
  <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
    <div class="bg-surface-container-low border border-outline-variant/20 max-w-md w-full rounded-xl p-6 space-y-6 shadow-lg" transition:scale={{ start: 0.97, duration: 150 }}>
      <div>
        <h3 class="text-lg font-semibold text-on-surface">
          {m.clan_bets_debt_clear_title()}
        </h3>
        <p class="text-sm font-bold text-amber-600 mt-2">
          {target.displayName ?? target.userId} · {target.amount.toLocaleString(dateLocale())} pts
        </p>
        <p class="text-xs text-on-surface-variant/80 mt-2">{m.clan_bets_debt_clear_desc()}</p>
      </div>

      {#if target.engaged > 0}
        <div class="space-y-3 bg-surface-container-high/40 rounded-lg p-4">
          <p class="text-xs text-on-surface-variant/80">
            {m.clan_bets_debt_clear_engaged_note({ amount: target.engaged.toLocaleString(dateLocale()) })}
          </p>
          <label class="flex items-center gap-3 text-sm text-on-surface cursor-pointer">
            <input type="checkbox" bind:checked={clearEngagedDebt} class="w-4 h-4 accent-rose-500 cursor-pointer" />
            {m.clan_bets_debt_clear_include_engaged()}
          </label>
        </div>
      {/if}

      <div class="flex justify-end gap-2">
        <button
          type="button"
          onclick={() => debtToClear = null}
          class="px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface text-xs font-semibold rounded-lg transition-colors cursor-pointer"
        >
          {m.clan_cancel_btn()}
        </button>
        <button
          type="button"
          onclick={handleClearDebt}
          disabled={target.firm <= 0 && !clearEngagedDebt}
          class="px-4 py-2 bg-rose-500 text-white text-xs font-semibold rounded-lg hover:bg-rose-600 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {m.clan_bets_debt_clear()}
        </button>
      </div>
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
          {m.clan_validation_required_title()}
        </h3>
        <p class="text-xs text-on-surface-variant/80 mt-1">
          {#if confirmActionType === 'clear'}
            {m.clan_confirm_desc_clear()}
          {:else if confirmActionType === 'reset'}
            {m.clan_confirm_desc_reset()}
          {:else if confirmActionType === 'distribute'}
            {m.clan_confirm_desc_distribute()}
          {:else if confirmActionType === 'dedupe'}
            {m.clan_confirm_desc_dedupe()}
          {:else if confirmActionType === 'reset-all'}
            <span class="text-rose-500 font-bold inline-flex items-center gap-1 align-[-2px]"><Papicon icon="AlertTriangle" size={13} /> {m.clan_confirm_desc_resetall_warning()}</span> {m.clan_confirm_desc_resetall()}
          {:else if confirmActionType === 'rollback'}
            {m.clan_confirm_desc_rollback({ prev: currentClanSeason - 1, current: currentClanSeason, prevprev: currentClanSeason - 2 })}
          {/if}
        </p>
      </div>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <label for="confirm-word" class="text-[10px] font-bold text-on-surface-variant/60 ml-1 uppercase tracking-widest">
            {m.clan_type_to_confirm_label({ word: confirmWordFor(confirmActionType) })}
          </label>
          <input
            id="confirm-word"
            type="text"
            bind:value={confirmInput}
            placeholder={confirmWordFor(confirmActionType)}
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none font-bold uppercase tracking-wider"
          />
        </div>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            onclick={() => showConfirmModal = false}
            class="px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            {m.clan_cancel_btn()}
          </button>
          <button
            type="button"
            onclick={handleConfirmAction}
            class="px-4 py-2 bg-rose-500 text-white text-xs font-semibold rounded-lg hover:bg-rose-600 transition-colors cursor-pointer"
          >
            {m.clan_confirm_btn()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
