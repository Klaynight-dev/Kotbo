<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import {
    API_BASE_URL,
    updateModuleStatus,
    fetchDailyAlgoProblems,
    createDailyAlgoProblem,
    updateDailyAlgoProblem,
    deleteDailyAlgoProblem,
    fetchDailyAlgoSchedule,
    ensureDailyAlgoSchedule,
    swapTodayDailyAlgoProblem,
    fetchMyApiKeys,
    createOrResetDailyAlgoApiKey,
    deleteMyApiKey,
    fetchTodayDailyAlgoSubmissions,
    fetchDailyAlgoSubmissionHistory,
    reviewDailyAlgoSubmission,
    fetchGlobalDailyAlgoLeaderboard,
    fetchCurrentDailyAlgoWeek,
    fetchDailyAlgoWeekHistory,
    closeDailyAlgoWeek,
    fetchClansData,
    updateGlobalSettings,
  } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { router } from 'tinro';
  import { getModuleMeta } from '../lib/moduleMeta';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import ColumnSortFilter, { type ColumnFilterOption } from '../lib/components/sanctions/ColumnSortFilter.svelte';
  import DailyAlgoMiniIDE from '../lib/components/DailyAlgoMiniIDE.svelte';
  import {
    detectIdeLanguageFromCode,
    normalizeIdeLanguage,
    type IdeLanguage,
  } from '../lib/dailyAlgoIde';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import { fetchFeatureConfigurations, updateFeatureConfiguration } from '../lib/api';

  const moduleId = 'dailyalgo';

  const module = $derived((dashboardStore.state.modules as Array<{ id: string; name: string; description: string; status: string }>).find((m) => m.id === moduleId) || { 
    name: 'Daily Algo', 
    description: 'Défis algorithmiques quotidiens.', 
    status: 'inactive' 
  });
  
  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.modules?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );
  const canModerateContent = $derived(
    !!dashboardStore.state.featureAccess?.content?.canModerate
      || !!dashboardStore.state.access?.canModerateContent
  );
  const canModerateDailyAlgo = $derived(
    !!dashboardStore.state.featureAccess?.daily_algo?.canModerate
      || !!dashboardStore.state.access?.canModerateDailyAlgo
      || canModerateContent
  );

  const supportedDailyAlgoLanguages: IdeLanguage[] = ['javascript', 'typescript', 'python', 'c', 'lua', 'sqlite'];
  const dailyAlgoLanguageSuggestions = ['javascript', 'typescript', 'python', 'c', 'lua', 'sqlite', 'rust', 'go', 'java', 'php', 'ruby', 'c#'];

  type DailyAlgoFunctionArgDraft = {
    id: string;
    name: string;
    type: string;
  };

  type DailyAlgoUnitTestDraft = {
    id: string;
    name: string;
    argValues: string[];
    expectedValue: string;
  };

  function createDraftId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function serializeDraftValue(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === undefined) return 'null';
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' ? serialized : 'null';
    } catch {
      return 'null';
    }
  }

  function formatDate(value: string | number | Date | null | undefined): string {
    if (value === null || value === undefined || value === '') return 'Date inconnue';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date inconnue';
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function createFunctionArgDraft(name = 'input', type = 'string'): DailyAlgoFunctionArgDraft {
    return { id: createDraftId('arg'), name, type };
  }

  function createUnitTestDraft(argCount: number, name = 'Cas 1'): DailyAlgoUnitTestDraft {
    return {
      id: createDraftId('test'),
      name,
      argValues: Array.from({ length: argCount }, () => 'null'),
      expectedValue: 'null',
    };
  }

  function alignUnitTestsWithArgs(tests: DailyAlgoUnitTestDraft[], argCount: number): DailyAlgoUnitTestDraft[] {
    return tests.map((test) => {
      const nextArgs = [...test.argValues];
      if (nextArgs.length > argCount) nextArgs.length = argCount;
      while (nextArgs.length < argCount) nextArgs.push('null');
      return { ...test, argValues: nextArgs };
    });
  }

  function parseDraftJsonValue(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: 'Valeur vide' };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      return { ok: true, value: trimmed };
    }
  }

  const formAction = createAsyncActionState();
  const apiKeyAction = createAsyncActionState();
  const weekSettingsAction = createAsyncActionState();

  let dailyAlgoProblems = $state<any[]>([]);
  let dailyAlgoToday = $state<any | null>(null);
  let isFetchingAlgo = $state(false);
  let isFetchingAlgoSubmissions = $state(false);
  let isFetchingAlgoHistory = $state(false);
  let isFetchingAlgoSchedule = $state(false);
  let isFetchingApiKeys = $state(false);
  let dailyAlgoHistory = $state<any[]>([]);
  let dailyAlgoSchedule = $state<any[]>([]);
  let myApiKeys = $state<any[]>([]);
  let dailyAlgoApiKeyName = $state('Kotbo Daily Algo');
  let latestIssuedApiKey = $state('');
  let dailyAlgoApiModalOpen = $state(false);
  let createDailyAlgoProblemModalOpen = $state(false);
  let editingDailyAlgoProblemId = $state<string | null>(null);
  let ideFocusedSubmissionId = $state<string | null>(null);
  let ideModalOpen = $state(false);
  let dailyAlgoSubmissionStatusFilter = $state<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
  let dailyAlgoLibrarySearch = $state('');
  let dailyAlgoScheduleModalOpen = $state(false);
  
  let algoDraft = $state({
    title: '',
    description: '',
    difficulty: 'moyen',
    language: 'fr',
    functionName: '',
    allowedLanguages: [] as string[],
    languageInput: '',
    functionArgs: [createFunctionArgDraft('input', 'string')] as DailyAlgoFunctionArgDraft[],
    unitTests: [createUnitTestDraft(1, 'Cas 1')] as DailyAlgoUnitTestDraft[],
  });

  let scoreDraftBySubmissionId = $state<Record<string, any>>({});

  let featureConfig = $state<any>(null);
  let loadingConfig = $state(false);

  // ── Semaine compétitive & administration ────────────────────────────────────
  // `bareme` regroupe tout ce qui pilote les points (barème, podium, clans) ;
  // `admin` ne garde que les gestes d'exploitation (clôture, sanctions).
  let activeTab = $state<'defis' | 'semaine' | 'bareme' | 'admin'>('defis');
  let currentWeek = $state<any | null>(null);
  let weekHistory = $state<any[]>([]);
  let isFetchingWeek = $state(false);
  let isClosingWeek = $state(false);
  let closeWeekConfirmOpen = $state(false);

  // Les clans sont un module indépendant : le pont Daily Algo → Clans ne peut
  // être configuré que s'ils sont activés sur le serveur.
  let clansEnabled = $state(false);

  const weekSettings = $state({
    dailyAlgoTimezone: 'Europe/Paris',
    dailyAlgoParticipationPoints: 1,
    dailyAlgoWeekendMultiplier: 1.5,
    dailyAlgoWeeklyRewardsEnabled: false,
    dailyAlgoWeekRole1Id: '',
    dailyAlgoWeekRole2Id: '',
    dailyAlgoWeekRole3Id: '',
    dailyAlgoWeekRoleRotate: true,
    dailyAlgoWeekXp1: 500,
    dailyAlgoWeekXp2: 300,
    dailyAlgoWeekXp3: 150,
    dailyAlgoWeekParticipationXp: 100,
    dailyAlgoWeekAnnouncementChannelId: '',
    dailyAlgoSanctionType: 'WARN',
    dailyAlgoSanctionWeight: 1,
    dailyAlgoSanctionDurationMinutes: 60,
    clanPointsFromDailyAlgo: false,
    clanPointsFromDailyAlgoRate: 1,
    clanPointsDailyAlgoTop1: 30,
    clanPointsDailyAlgoTop2: 20,
    clanPointsDailyAlgoTop3: 10,
  });

  const roleOptions = $derived(
    ((dashboardStore.state.discordRoles as Array<{ id: string; name: string }>) ?? [])
      .map((role) => ({ id: role.id, name: `@${role.name}` }))
  );
  const channelOptions = $derived(
    ((dashboardStore.state.discordChannels as Array<{ id: string; name: string }>) ?? [])
      .map((channel) => ({ id: channel.id, name: `#${channel.name}` }))
  );

  const numberFieldClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all';
  const selectFieldClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm transition-all';

  /**
   * Aperçu du barème : ce que gagne un participant moyen (moyenne 3.4/5, hors
   * podium de rapidité), pour que l'admin voie l'effet de ses réglages sans avoir
   * à attendre une semaine entière.
   */
  const scorePreview = $derived.by(() => {
    const floor = Number(weekSettings.dailyAlgoParticipationPoints) || 0;
    const multiplier = Number(weekSettings.dailyAlgoWeekendMultiplier) || 1;
    const weekday = Math.ceil(floor + 3.4);
    const weekend = Math.ceil((floor + 3.4) * multiplier);
    return { weekday, weekend, week: weekday * 5 + weekend * 2 };
  });

  function syncWeekSettingsFromStore() {
    const s = dashboardStore.state as any;
    weekSettings.dailyAlgoTimezone = s.dailyAlgoTimezone ?? 'Europe/Paris';
    weekSettings.dailyAlgoParticipationPoints = s.dailyAlgoParticipationPoints ?? 1;
    weekSettings.dailyAlgoWeekendMultiplier = s.dailyAlgoWeekendMultiplier ?? 1.5;
    weekSettings.dailyAlgoWeeklyRewardsEnabled = s.dailyAlgoWeeklyRewardsEnabled ?? false;
    weekSettings.dailyAlgoWeekRole1Id = s.dailyAlgoWeekRole1Id ?? '';
    weekSettings.dailyAlgoWeekRole2Id = s.dailyAlgoWeekRole2Id ?? '';
    weekSettings.dailyAlgoWeekRole3Id = s.dailyAlgoWeekRole3Id ?? '';
    weekSettings.dailyAlgoWeekRoleRotate = s.dailyAlgoWeekRoleRotate ?? true;
    weekSettings.dailyAlgoWeekXp1 = s.dailyAlgoWeekXp1 ?? 500;
    weekSettings.dailyAlgoWeekXp2 = s.dailyAlgoWeekXp2 ?? 300;
    weekSettings.dailyAlgoWeekXp3 = s.dailyAlgoWeekXp3 ?? 150;
    weekSettings.dailyAlgoWeekParticipationXp = s.dailyAlgoWeekParticipationXp ?? 100;
    weekSettings.dailyAlgoWeekAnnouncementChannelId = s.dailyAlgoWeekAnnouncementChannelId ?? '';
    weekSettings.dailyAlgoSanctionType = s.dailyAlgoSanctionType ?? 'WARN';
    weekSettings.dailyAlgoSanctionWeight = s.dailyAlgoSanctionWeight ?? 1;
    weekSettings.dailyAlgoSanctionDurationMinutes = s.dailyAlgoSanctionDurationMinutes ?? 60;
    weekSettings.clanPointsFromDailyAlgo = s.clanPointsFromDailyAlgo ?? false;
    weekSettings.clanPointsFromDailyAlgoRate = s.clanPointsFromDailyAlgoRate ?? 1;
    weekSettings.clanPointsDailyAlgoTop1 = s.clanPointsDailyAlgoTop1 ?? 30;
    weekSettings.clanPointsDailyAlgoTop2 = s.clanPointsDailyAlgoTop2 ?? 20;
    weekSettings.clanPointsDailyAlgoTop3 = s.clanPointsDailyAlgoTop3 ?? 10;
  }

  async function loadWeekData() {
    isFetchingWeek = true;
    try {
      const [current, history] = await Promise.all([
        fetchCurrentDailyAlgoWeek(),
        fetchDailyAlgoWeekHistory(10),
      ]);
      currentWeek = current?.week ?? null;
      weekHistory = history?.weeks ?? [];
    } catch (err) {
      console.error('Error fetching daily algo week:', err);
    } finally {
      isFetchingWeek = false;
    }
  }

  async function loadClansEnabled() {
    try {
      const clans = await fetchClansData();
      clansEnabled = !!clans?.clansEnabled;
    } catch {
      clansEnabled = false;
    }
  }

  async function saveWeekSettings() {
    await weekSettingsAction.run(async () => {
      const ok = await updateGlobalSettings({ ...weekSettings });
      if (!ok) return false;

      // L'enregistrement est acquis dès que le PATCH répond. Le rafraîchissement
      // complet de l'état de guilde (salons, rôles, catégories, modules — une
      // grosse réponse construite depuis le cache Discord) ne fait que relire ce
      // qu'on vient d'écrire : l'attendre ici immobilisait le bouton une bonne
      // seconde après que tout était déjà sauvegardé. On le laisse tourner
      // derrière, il ne sert qu'à réafficher les valeurs bornées côté serveur.
      void dashboardStore.refresh().then(syncWeekSettingsFromStore);
      return true;
    }, {
      successMessage: 'Réglages enregistrés.',
      failureMessage: "Impossible d'enregistrer les réglages.",
    });
  }

  async function confirmCloseWeek() {
    isClosingWeek = true;
    try {
      await weekSettingsAction.run(async () => {
        const result = await closeDailyAlgoWeek();
        if (!result?.ok) {
          weekSettingsAction.setError(result?.error ?? 'Impossible de clôturer la semaine.');
          return false;
        }

        const clanPart = result.clanPointsGranted > 0
          ? `, ${result.clanPointsGranted} point(s) de clan`
          : '';
        weekSettingsAction.setMessage(
          `Semaine ${result.weekKey} clôturée : ${result.participants} participant(s), ${result.xpGranted} XP versée${clanPart}.`
        );
        closeWeekConfirmOpen = false;
        await loadWeekData();
        return true;
      }, { failureMessage: '' });
    } finally {
      isClosingWeek = false;
    }
  }

  async function loadFeatureConfig() {
    loadingConfig = true;
    try {
      const configs = await fetchFeatureConfigurations();
      featureConfig = configs?.features?.find((c: any) => c.featureKey === 'daily_algo') || null;
    } catch (err) {
      console.error('Error fetching daily algo config:', err);
    } finally {
      loadingConfig = false;
    }
  }

  /**
   * Temps réel : le bot diffuse déjà ses changements d'état sur la socket du
   * dashboard (`kotbo-ws-message`). On se contente d'écouter les raisons qui
   * concernent le Daily Algo et de recharger le strict nécessaire, pour qu'une
   * soumission postée sur Discord apparaisse sans que le staff clique
   * « Actualiser ».
   */
  let wsReloadTimer: ReturnType<typeof setTimeout> | null = null;

  function handleWsMessage(event: Event) {
    const detail = (event as CustomEvent).detail;
    if (detail?.type !== 'dashboard_state_changed') return;
    if (detail?.guildId !== authStore.selectedGuildId) return;

    const reason = String(detail?.reason ?? '');
    if (!reason.startsWith('daily_algo')) return;

    // Une rafale de soumissions déclenche une rafale d'évènements : on regroupe
    // les rechargements pour ne pas marteler l'API.
    if (wsReloadTimer) clearTimeout(wsReloadTimer);
    wsReloadTimer = setTimeout(() => {
      wsReloadTimer = null;

      if (reason === 'daily_algo_week_closed') {
        void loadWeekData();
        return;
      }

      if (reason === 'daily_algo_problems_updated') {
        void loadDailyAlgoProblems();
        return;
      }

      if (reason === 'daily_algo_schedule_updated') {
        void loadDailyAlgoSchedule();
        void loadTodayDailyAlgoSubmissions();
        return;
      }

      // Soumission créée ou notée : le classement de la semaine bouge aussi.
      void loadTodayDailyAlgoSubmissions();
      void loadDailyAlgoHistory();
      void loadWeekData();
    }, 400);
  }

  onMount(async () => {
    window.addEventListener('kotbo-ws-message', handleWsMessage);
    await dashboardStore.refresh();
    syncWeekSettingsFromStore();
    await Promise.all([
      loadDailyAlgoProblems(),
      loadTodayDailyAlgoSubmissions(),
      loadDailyAlgoHistory(),
      loadDailyAlgoSchedule(),
      loadMyApiKeys(),
      loadFeatureConfig(),
      loadWeekData(),
      loadClansEnabled()
    ]);
  });

  onDestroy(() => {
    window.removeEventListener('kotbo-ws-message', handleWsMessage);
    if (wsReloadTimer) clearTimeout(wsReloadTimer);
  });

  async function loadDailyAlgoProblems() {
    isFetchingAlgo = true;
    try { dailyAlgoProblems = await fetchDailyAlgoProblems(); } 
    catch (err) { formAction.setError('Erreur chargement exercices.'); } 
    finally { isFetchingAlgo = false; }
  }

  async function loadTodayDailyAlgoSubmissions() {
    isFetchingAlgoSubmissions = true;
    try { dailyAlgoToday = await fetchTodayDailyAlgoSubmissions(); } 
    catch (err) { formAction.setError('Erreur chargement soumissions.'); } 
    finally { isFetchingAlgoSubmissions = false; }
  }

  async function loadDailyAlgoHistory() {
    isFetchingAlgoHistory = true;
    try {
      const payload = await fetchDailyAlgoSubmissionHistory(7);
      dailyAlgoHistory = payload?.history ?? [];
    } finally { isFetchingAlgoHistory = false; }
  }

  async function loadDailyAlgoSchedule() {
    isFetchingAlgoSchedule = true;
    try {
      if (canManageSettings) await ensureDailyAlgoSchedule(21);
      const payload = await fetchDailyAlgoSchedule(7, 21);
      dailyAlgoSchedule = Array.isArray(payload?.runs) ? payload.runs : [];
    } finally { isFetchingAlgoSchedule = false; }
  }

  async function loadMyApiKeys() {
    isFetchingApiKeys = true;
    try {
      const payload = await fetchMyApiKeys();
      myApiKeys = Array.isArray(payload?.keys) ? payload.keys : [];
    } finally { isFetchingApiKeys = false; }
  }

  function openDailyAlgoProblemModal() {
    editingDailyAlgoProblemId = null;
    algoDraft = {
      title: '', description: '', difficulty: 'moyen', language: 'fr', functionName: '',
      allowedLanguages: [], languageInput: '',
      functionArgs: [createFunctionArgDraft('input', 'string')],
      unitTests: [createUnitTestDraft(1, 'Cas 1')],
    };
    createDailyAlgoProblemModalOpen = true;
  }

  async function submitDailyAlgoProblem() {
    if (!canManageSettings) return;
    await formAction.run(async () => {
      const payload = {
        title: algoDraft.title.trim(),
        description: algoDraft.description.trim(),
        difficulty: algoDraft.difficulty,
        functionName: algoDraft.functionName.trim(),
        functionArgs: algoDraft.functionArgs.map(a => ({ name: a.name.trim(), type: a.type.trim() })),
        unitTests: algoDraft.unitTests.map(t => ({
          name: t.name.trim(),
          args: t.argValues.map(v => parseDraftJsonValue(v).value),
          expected: parseDraftJsonValue(t.expectedValue).value
        })),
        allowedLanguages: algoDraft.allowedLanguages,
      };
      const ok = editingDailyAlgoProblemId 
        ? await updateDailyAlgoProblem(editingDailyAlgoProblemId, payload)
        : await createDailyAlgoProblem(payload);
      if (ok) {
        createDailyAlgoProblemModalOpen = false;
        await loadDailyAlgoProblems();
      }
      return ok;
    });
  }

  const filteredProblems = $derived(
    dailyAlgoProblems.filter(p => 
      p.title.toLowerCase().includes(dailyAlgoLibrarySearch.toLowerCase())
    )
  );

  const todaySubmissions = $derived(
    (dailyAlgoToday?.submissions ?? []).filter((s: any) => 
      dailyAlgoSubmissionStatusFilter === 'ALL' || s.status === dailyAlgoSubmissionStatusFilter
    )
  );

  function openSubmissionInIntegratedIde(submission: any) {
    const payload = {
      code: submission.solution,
      language: submission.language,
      authorName: submission.authorName,
      submissionId: submission.id,
      status: submission.status,
      scoreCorrectness: submission.scoreCorrectness || 5,
      scoreComments: submission.scoreComments || 5,
      scoreCompactness: submission.scoreCompactness || 5,
      scoreOptimization: submission.scoreOptimization || 5,
      scoreReadability: submission.scoreReadability || 5,
      reviewFeedback: submission.reviewFeedback || '',
    };
    
    const payloadKey = `daily_algo_payload_${submission.id}_${Date.now()}`;
    localStorage.setItem(payloadKey, JSON.stringify(payload));
    
    router.goto(`/dailyalgo/ide?payloadKey=${payloadKey}`);
  }

</script>

<ModulePage 
  title="Daily Algo" 
  description="Gérez les défis algorithmiques quotidiens, corrigez les soumissions et gérez votre bibliothèque." 
  icon="Code"
  featureKey="daily_algo"
>
  {#snippet actions()}
    <div class="flex gap-3">
      <RefreshButton
        onClick={() => { loadDailyAlgoProblems(); loadTodayDailyAlgoSubmissions(); }}
        loading={isFetchingAlgo || isFetchingAlgoSubmissions}
        label="Actualiser"
      />
      {#if canManageSettings}
        <button
          onclick={openDailyAlgoProblemModal}
          class="px-4 py-2 bg-primary text-on-primary rounded-xl font-medium text-[13px] transition-transform"
        >
          Nouvel Exercice
        </button>
      {/if}
    </div>
  {/snippet}

  <!-- Navigation par Onglets -->
  <div class="flex border-b border-outline-variant/15 mb-6">
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'defis' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'defis'}
    >
      <Papicon icon="Code" size={15} /> Défis & Notation
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'semaine' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'semaine'}
    >
      <Papicon icon="Award" size={15} /> Semaine & Podium
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'bareme' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'bareme'}
    >
      <Papicon icon="Sparkles" size={15} /> Barème & récompenses
    </button>
    <button
      class="px-5 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer inline-flex items-center gap-2 {activeTab === 'admin' ? 'border-primary text-primary font-bold bg-primary/5 rounded-t-lg' : 'border-transparent text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-low/30'}"
      onclick={() => activeTab = 'admin'}
    >
      <Papicon icon="Settings" size={15} /> Administration
    </button>
  </div>

  <div class="space-y-10 pb-20" class:hidden={activeTab !== 'defis'}>
    
    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="bg-surface-container-low/40 rounded-xl p-8 border border-outline-variant/10">
        <p class="text-xs font-medium text-on-surface-variant/40">Soumissions du jour</p>
        <p class="text-lg font-semibold text-on-surface mt-2">{dailyAlgoToday?.submissions?.length ?? 0}</p>
      </div>
      <div class="bg-surface-container-low/40 rounded-xl p-8 border border-outline-variant/10">
        <p class="text-xs font-medium text-on-surface-variant/40">Bibliothèque</p>
        <p class="text-lg font-semibold text-on-surface mt-2">{dailyAlgoProblems.length}</p>
      </div>
      <button 
        onclick={() => dailyAlgoScheduleModalOpen = true}
        class="bg-surface-container-low/40 rounded-xl p-8 border border-outline-variant/10 text-left hover:bg-surface-container-high/60 transition-colors group"
      >
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-on-surface-variant/40">Planning</p>
          <Papicon icon="Calendar" size={14} class="text-on-surface-variant/20 group-hover:text-primary transition-colors" />
        </div>
        <p class="text-lg font-semibold text-on-surface mt-2">{dailyAlgoSchedule.length} jours</p>
        <p class="text-[10px] font-bold text-primary mt-4 flex items-center gap-2">
          Voir le programme <Papicon icon="ArrowRight" size={10} />
        </p>
      </button>
    </div>

    <!-- Active Challenge -->
    <section class="bg-primary/5 rounded-xl p-10 border border-primary/10">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <div class="flex items-center gap-3">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-xs font-medium text-primary">Défi en cours</span>
          </div>
          <h3 class="text-lg font-semibold text-on-surface mt-2">{dailyAlgoToday?.run?.problem?.title ?? 'Aucun défi actif'}</h3>
          <p class="text-on-surface-variant/60 mt-2 max-w-2xl line-clamp-2">{dailyAlgoToday?.run?.problem?.description ?? 'Planifiez un défi pour commencer.'}</p>
        </div>
        {#if canManageSettings}
          <button class="px-6 py-3 bg-surface-container-high rounded-lg text-xs font-medium border border-outline-variant/10 hover:bg-surface-container-highest transition-colors">
            Changer le défi
          </button>
        {/if}
      </div>
    </section>

    <!-- Submissions Table -->
    <section class="space-y-6">
      <div class="flex items-center justify-between px-2">
        <h3 class="text-xl font-semibold text-on-surface">Soumissions Récentes</h3>
        <div class="flex gap-2">
          {#each ['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as f}
            <button 
              onclick={() => dailyAlgoSubmissionStatusFilter = f as any}
              class="px-4 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-widest border border-outline-variant/10 {dailyAlgoSubmissionStatusFilter === f ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant/60 hover:bg-surface-container-high'}"
            >
              {f === 'ALL' ? 'Tout' : f}
            </button>
          {/each}
        </div>
      </div>

      <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-surface-container-high/50 border-b border-outline-variant/10">
            <tr>
              <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">Auteur</th>
              <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">Statut</th>
              <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">Date</th>
              <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/5">
            {#each todaySubmissions as sub}
              <tr class="hover:bg-surface-container-low/50 transition-colors group">
                <td class="px-8 py-5">
                  <p class="font-semibold text-on-surface">{sub.authorName}</p>
                  <p class="text-[10px] text-on-surface-variant/40">ID: {sub.authorId}</p>
                </td>
                <td class="px-8 py-5">
                  <span class="px-3 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-widest {sub.status === 'APPROVED' ? 'bg-emerald-500/10 text-emerald-600' : sub.status === 'PENDING' ? 'bg-amber-500/10 text-amber-600' : 'bg-red-500/10 text-red-600'}">
                    {sub.status}
                  </span>
                </td>
                <td class="px-8 py-5 text-xs text-on-surface-variant">{formatDate(sub.submittedAt)}</td>
                <td class="px-8 py-5">
                  <button 
                    onclick={() => openSubmissionInIntegratedIde(sub)}
                    class="p-2 rounded-xl bg-primary/10 text-primary transition-transform"
                  >
                    <Papicon icon="Code" size={18} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Configuration Section -->
    {#if canManageSettings && featureConfig}
      <section class="bg-surface-container-low/30 rounded-xl p-10 border border-outline-variant/10 animate-in fade-in duration-500">
        <h3 class="text-xl font-semibold text-on-surface mb-8">Configuration & Permissions</h3>
        <RolePermissionSettings 
          featureKey="daily_algo" 
          roleAccess={featureConfig.roleAccessByRole} 
        />
      </section>
    {/if}

  </div>

  <!-- ═══ Onglet Semaine & Podium ═══ -->
  {#if activeTab === 'semaine'}
    <div class="space-y-10 pb-20">
      <div class="flex items-center justify-between px-2">
        <div>
          <h3 class="text-xl font-semibold text-on-surface">Semaine en cours</h3>
          <p class="text-xs text-on-surface-variant/60 mt-1">
            {#if currentWeek}
              {currentWeek.weekKey} · {currentWeek.label}
            {:else}
              Aucune semaine ouverte pour le moment.
            {/if}
          </p>
        </div>
        <RefreshButton onClick={loadWeekData} loading={isFetchingWeek} label="Actualiser" />
      </div>

      {#if isFetchingWeek && !currentWeek}
        <Skeleton height="220px" />
      {:else if !currentWeek || currentWeek.ranking.length === 0}
        <section class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-10 text-center">
          <Papicon icon="Calendar" size={24} class="text-on-surface-variant/40" />
          <h4 class="text-sm font-semibold text-on-surface mt-3">Aucune participation cette semaine</h4>
          <p class="text-xs text-on-surface-variant/60 mt-1 max-w-md mx-auto">
            Le classement se remplit à mesure que le staff note les soumissions. Toute
            participation validée rapporte au moins le plancher de points.
          </p>
        </section>
      {:else}
        <section class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-[10px] font-bold text-on-surface-variant/50 uppercase tracking-widest border-b border-outline-variant/10">
                  <th class="px-6 py-4">#</th>
                  <th class="px-6 py-4">Membre</th>
                  <th class="px-6 py-4 text-right">Défis validés</th>
                  <th class="px-6 py-4 text-right">Bonus manuels</th>
                  <th class="px-6 py-4 text-right">Points</th>
                </tr>
              </thead>
              <tbody>
                {#each currentWeek.ranking as entry (entry.userId)}
                  <tr class="text-sm border-b border-outline-variant/5 last:border-0">
                    <td class="px-6 py-3 font-bold text-on-surface-variant/70">
                      #{entry.rank}
                    </td>
                    <td class="px-6 py-3 font-semibold text-on-surface">{entry.userName}</td>
                    <td class="px-6 py-3 text-right text-on-surface-variant/70">{entry.participations}</td>
                    <td class="px-6 py-3 text-right text-on-surface-variant/70">
                      {entry.bonusPoints > 0 ? `+${entry.bonusPoints}` : '—'}
                    </td>
                    <td class="px-6 py-3 text-right font-black text-primary">{entry.points}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}

      <section class="space-y-4">
        <h3 class="text-xl font-semibold text-on-surface px-2">Semaines clôturées</h3>
        {#if weekHistory.length === 0}
          <p class="text-xs text-on-surface-variant/50 italic px-2">
            Aucune semaine clôturée pour l'instant. La première clôture a lieu le lundi
            suivant, ou immédiatement via l'onglet Administration.
          </p>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            {#each weekHistory as week (week.weekKey)}
              <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-bold text-on-surface">{week.weekKey}</span>
                  <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                    {week.participants} participant{week.participants > 1 ? 's' : ''}
                  </span>
                </div>
                <p class="text-[11px] text-on-surface-variant/50">{week.label}</p>
                {#if week.podium.length > 0}
                  <div class="space-y-1 pt-2 border-t border-outline-variant/10">
                    {#each week.podium as entry (entry.rank)}
                      <p class="text-xs text-on-surface-variant/80 flex items-center justify-between gap-2">
                        <span>#{entry.rank} <code class="text-[10px]">{entry.userId}</code></span>
                        <span class="font-bold">{entry.points} pts{entry.xpGranted > 0 ? ` · ${entry.xpGranted} XP` : ''}{entry.clanPointsGranted > 0 ? ` · ${entry.clanPointsGranted} pts clan` : ''}</span>
                      </p>
                    {/each}
                  </div>
                {/if}
                {#if week.closedById}
                  <p class="text-[10px] text-on-surface-variant/40 italic">Clôturée manuellement</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}

  <!-- ═══ Onglet Barème & récompenses ═══ -->
  {#if activeTab === 'bareme'}
    <div class="space-y-10 pb-20">
      <InlineFeedback state={weekSettingsAction} />

      {#if !canManageSettings}
        <section class="bg-surface-container-high/20 rounded-xl border border-outline-variant/10 p-10 flex flex-col items-center text-center gap-3">
          <Papicon icon="Lock" size={24} class="text-on-surface-variant/40" />
          <h4 class="text-sm font-semibold text-on-surface">Réservé aux administrateurs</h4>
          <p class="text-xs text-on-surface-variant/70 max-w-md">
            Vous n'avez pas la permission de configurer le barème de ce module.
          </p>
        </section>
      {:else}
        <!-- Barème & points -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Sparkles" size={20} class="text-primary" />
            Barème & points
          </h3>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div class="space-y-1.5">
              <label for="daPartPoints" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Plancher de participation (pts)</label>
              <input id="daPartPoints" type="number" min="0" max="50" step="1" bind:value={weekSettings.dailyAlgoParticipationPoints} disabled={!canManageSettings} class={numberFieldClass} />
            </div>
            <div class="space-y-1.5">
              <label for="daWeekendMult" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Multiplicateur du week-end</label>
              <input id="daWeekendMult" type="number" min="1" max="10" step="0.1" bind:value={weekSettings.dailyAlgoWeekendMultiplier} disabled={!canManageSettings} class={numberFieldClass} />
            </div>
            <div class="space-y-1.5">
              <label for="daTimezone" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Fuseau horaire (IANA)</label>
              <input id="daTimezone" type="text" placeholder="Europe/Paris" bind:value={weekSettings.dailyAlgoTimezone} disabled={!canManageSettings} class={numberFieldClass} />
            </div>
          </div>

          <div class="p-4 bg-primary/5 border border-primary/10 rounded-lg text-xs text-on-surface-variant/80">
            <strong class="text-on-surface">Aperçu :</strong> un participant moyen (moyenne 3,4/5,
            hors podium de rapidité) gagne <strong>{scorePreview.weekday} pts</strong> en semaine,
            <strong>{scorePreview.weekend} pts</strong> le week-end, soit environ
            <strong>{scorePreview.week} pts</strong> sur une semaine complète.
            Les points sont toujours des entiers, arrondis à l'unité supérieure.
          </div>
        </section>

        <!-- Semaine & podium -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Award" size={20} class="text-secondary" />
            Semaine & podium
          </h3>

          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm font-medium text-on-surface">Activer les récompenses hebdomadaires</span>
              <p class="text-xs text-on-surface-variant/70">
                Verse XP et rôles à la clôture du lundi. Désactivé, le classement est
                quand même figé et archivé.
              </p>
            </div>
            <ToggleSwitch
              checked={weekSettings.dailyAlgoWeeklyRewardsEnabled}
              onToggle={(v) => weekSettings.dailyAlgoWeeklyRewardsEnabled = v}
              disabled={!canManageSettings}
            />
          </div>

          {#if weekSettings.dailyAlgoWeeklyRewardsEnabled}
            <div class="space-y-6 pt-4 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
              <p class="text-[11px] text-on-surface-variant/60">
                Les trois rôles sont <strong>facultatifs</strong> : laisser un champ vide
                signifie « pas de rôle », et le reste des récompenses est versé quand même.
              </p>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div class="space-y-1.5">
                  <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Rôle 1er</span>
                  <SearchableSelect
                    bind:value={weekSettings.dailyAlgoWeekRole1Id}
                    options={roleOptions}
                    placeholder="Aucun rôle"
                    disabled={!canManageSettings}
                    className={selectFieldClass}
                  />
                </div>
                <div class="space-y-1.5">
                  <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Rôle 2e</span>
                  <SearchableSelect
                    bind:value={weekSettings.dailyAlgoWeekRole2Id}
                    options={roleOptions}
                    placeholder="Aucun rôle"
                    disabled={!canManageSettings}
                    className={selectFieldClass}
                  />
                </div>
                <div class="space-y-1.5">
                  <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Rôle 3e</span>
                  <SearchableSelect
                    bind:value={weekSettings.dailyAlgoWeekRole3Id}
                    options={roleOptions}
                    placeholder="Aucun rôle"
                    disabled={!canManageSettings}
                    className={selectFieldClass}
                  />
                </div>
              </div>

              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">Rôles tournants</span>
                  <p class="text-xs text-on-surface-variant/70">
                    Retire les rôles du podium précédent à chaque clôture. Sans rotation,
                    un rôle de champion s'accumule et perd son sens.
                  </p>
                </div>
                <ToggleSwitch
                  checked={weekSettings.dailyAlgoWeekRoleRotate}
                  onToggle={(v) => weekSettings.dailyAlgoWeekRoleRotate = v}
                  disabled={!canManageSettings}
                />
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-4 gap-6">
                <div class="space-y-1.5">
                  <label for="daXp1" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">XP 1er</label>
                  <input id="daXp1" type="number" min="0" step="10" bind:value={weekSettings.dailyAlgoWeekXp1} disabled={!canManageSettings} class={numberFieldClass} />
                </div>
                <div class="space-y-1.5">
                  <label for="daXp2" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">XP 2e</label>
                  <input id="daXp2" type="number" min="0" step="10" bind:value={weekSettings.dailyAlgoWeekXp2} disabled={!canManageSettings} class={numberFieldClass} />
                </div>
                <div class="space-y-1.5">
                  <label for="daXp3" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">XP 3e</label>
                  <input id="daXp3" type="number" min="0" step="10" bind:value={weekSettings.dailyAlgoWeekXp3} disabled={!canManageSettings} class={numberFieldClass} />
                </div>
                <div class="space-y-1.5">
                  <label for="daXpPart" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">XP participation</label>
                  <input id="daXpPart" type="number" min="0" step="10" bind:value={weekSettings.dailyAlgoWeekParticipationXp} disabled={!canManageSettings} class={numberFieldClass} />
                </div>
              </div>
              <p class="text-[11px] text-on-surface-variant/50">
                Le podium reçoit son XP dédiée <strong>à la place</strong> de l'XP de
                participation, pas en plus.
              </p>

              <div class="space-y-1.5">
                <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon d'annonce</span>
                <SearchableSelect
                  bind:value={weekSettings.dailyAlgoWeekAnnouncementChannelId}
                  options={channelOptions}
                  placeholder="Par défaut : le salon du Daily Algo"
                  disabled={!canManageSettings}
                  className={selectFieldClass}
                />
              </div>
            </div>
          {/if}
        </section>

        <!-- Points de clan (verrouillé si les clans sont inactifs) -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Shield" size={20} class="text-tertiary" />
            Points de clan
          </h3>

          {#if !clansEnabled}
            <div class="p-6 bg-surface-container-high/20 rounded-xl border border-outline-variant/10 flex flex-col items-center justify-center text-center space-y-3">
              <Papicon icon="Lock" size={24} class="text-on-surface-variant/40" />
              <div>
                <h4 class="text-sm font-semibold text-on-surface">Les clans ne sont pas activés</h4>
                <p class="text-xs text-on-surface-variant/70 max-w-md mt-1">
                  Les clans ne sont pas activés sur ce serveur. Activez-les dans l'onglet
                  Clans pour configurer ce lien. Le Daily Algo fonctionne parfaitement sans.
                </p>
              </div>
            </div>
          {:else}
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">Convertir les points en points de clan</span>
                  <p class="text-xs text-on-surface-variant/70">
                    À la clôture, chaque participant convertit ses points de la semaine en
                    points de clan. Sans ce réglage, les deux modules tournent sans lien.
                  </p>
                </div>
                <ToggleSwitch
                  checked={weekSettings.clanPointsFromDailyAlgo}
                  onToggle={(v) => weekSettings.clanPointsFromDailyAlgo = v}
                  disabled={!canManageSettings}
                />
              </div>

              {#if weekSettings.clanPointsFromDailyAlgo}
                <div class="grid grid-cols-1 sm:grid-cols-4 gap-6 pt-4 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
                  <div class="space-y-1.5">
                    <label for="daClanRate" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Taux de conversion</label>
                    <input id="daClanRate" type="number" min="0.1" max="100" step="0.1" bind:value={weekSettings.clanPointsFromDailyAlgoRate} disabled={!canManageSettings} class={numberFieldClass} />
                  </div>
                  <div class="space-y-1.5">
                    <label for="daClanTop1" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Bonus clan 1er</label>
                    <input id="daClanTop1" type="number" min="0" step="5" bind:value={weekSettings.clanPointsDailyAlgoTop1} disabled={!canManageSettings} class={numberFieldClass} />
                  </div>
                  <div class="space-y-1.5">
                    <label for="daClanTop2" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Bonus clan 2e</label>
                    <input id="daClanTop2" type="number" min="0" step="5" bind:value={weekSettings.clanPointsDailyAlgoTop2} disabled={!canManageSettings} class={numberFieldClass} />
                  </div>
                  <div class="space-y-1.5">
                    <label for="daClanTop3" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Bonus clan 3e</label>
                    <input id="daClanTop3" type="number" min="0" step="5" bind:value={weekSettings.clanPointsDailyAlgoTop3} disabled={!canManageSettings} class={numberFieldClass} />
                  </div>
                </div>
                <p class="text-[11px] text-on-surface-variant/50">
                  Taux 1 = 1 point de Daily Algo donne 1 point de clan. Un participant assidu
                  pèse alors environ 70 points de clan par semaine, soit un peu plus qu'un
                  passage de niveau.
                </p>
              {/if}
            </div>
          {/if}
        </section>

        <div class="flex justify-end">
          <button
            onclick={saveWeekSettings}
            disabled={weekSettingsAction.state.loading}
            class="px-8 py-3 bg-primary text-on-primary rounded-xl font-medium text-[13px] transition-transform disabled:opacity-50"
          >
            {weekSettingsAction.state.loading ? 'Enregistrement…' : 'Enregistrer les réglages'}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ═══ Onglet Administration ═══ -->
  {#if activeTab === 'admin'}
    <div class="space-y-10 pb-20">
      <InlineFeedback state={weekSettingsAction} />

      {#if !canManageSettings}
        <section class="bg-surface-container-high/20 rounded-xl border border-outline-variant/10 p-10 flex flex-col items-center text-center gap-3">
          <Papicon icon="Lock" size={24} class="text-on-surface-variant/40" />
          <h4 class="text-sm font-semibold text-on-surface">Réservé aux administrateurs</h4>
          <p class="text-xs text-on-surface-variant/70 max-w-md">
            Vous n'avez pas la permission de configurer ce module.
          </p>
        </section>
      {:else}
        <!-- Clôture anticipée -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Award" size={20} class="text-amber-500" />
            Clôturer la semaine maintenant
          </h3>
          <p class="text-xs text-on-surface-variant/70 max-w-2xl">
            Déclenche immédiatement ce que fait le cron du lundi : le classement est figé,
            les récompenses versées, les rôles du podium attribués et l'annonce publiée.
            Utile pour tester le cycle complet sans attendre sept jours.
            <strong class="text-on-surface">Cette action ne s'annule pas.</strong>
          </p>

          {#if currentWeek?.status === 'CLOSED'}
            <div class="p-4 bg-surface-container-high/20 rounded-lg border border-outline-variant/10 text-xs text-on-surface-variant/70 space-y-3">
              <p>
                La semaine <strong>{currentWeek.weekKey}</strong> est déjà clôturée.
                Les participations arrivées depuis seront rattrapées par le cron du
                lundi, ou tout de suite avec le bouton ci-dessous.
              </p>
              <button
                onclick={confirmCloseWeek}
                disabled={isClosingWeek}
                class="px-5 py-2.5 bg-surface-container-high rounded-lg text-[13px] font-medium border border-outline-variant/10 disabled:opacity-50"
              >
                {isClosingWeek ? 'Rattrapage en cours…' : 'Rattraper les points de la semaine'}
              </button>
            </div>
          {:else if !closeWeekConfirmOpen}
            <button
              onclick={() => closeWeekConfirmOpen = true}
              disabled={!currentWeek}
              class="px-6 py-3 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded-lg text-[13px] font-medium transition-colors hover:bg-amber-500/20 disabled:opacity-50"
            >
              Clôturer la semaine {currentWeek?.weekKey ?? ''}
            </button>
          {:else}
            <div class="p-6 bg-amber-500/5 border border-amber-500/20 rounded-xl space-y-4">
              <p class="text-sm font-semibold text-on-surface">
                Confirmer la clôture de {currentWeek?.weekKey} ?
              </p>
              <ul class="text-xs text-on-surface-variant/70 space-y-1 list-disc list-inside">
                <li>{currentWeek?.ranking?.length ?? 0} participant(s) seront récompensés</li>
                <li>
                  {#if weekSettings.dailyAlgoWeeklyRewardsEnabled}
                    XP et rôles du podium attribués
                  {:else}
                    Récompenses désactivées : le classement sera seulement archivé
                  {/if}
                </li>
                <li>
                  {#if clansEnabled && weekSettings.clanPointsFromDailyAlgo}
                    Les points de la semaine seront convertis en points de clan
                  {:else}
                    Aucun point de clan ne sera versé
                  {/if}
                </li>
                <li>
                  Les participations qui arriveront d'ici dimanche seront rattrapées
                  par le cron du lundi — rien ne sera perdu
                </li>
              </ul>
              <div class="flex gap-3">
                <button
                  onclick={confirmCloseWeek}
                  disabled={isClosingWeek}
                  class="px-5 py-2.5 bg-amber-500 text-white rounded-lg text-[13px] font-medium disabled:opacity-50"
                >
                  {isClosingWeek ? 'Clôture en cours…' : 'Oui, clôturer'}
                </button>
                <button
                  onclick={() => closeWeekConfirmOpen = false}
                  disabled={isClosingWeek}
                  class="px-5 py-2.5 bg-surface-container-high rounded-lg text-[13px] font-medium border border-outline-variant/10 disabled:opacity-50"
                >
                  Annuler
                </button>
              </div>
            </div>
          {/if}
        </section>

        <!-- Sanctions -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Shield" size={20} class="text-red-500" />
            Sanctions
          </h3>
          <p class="text-xs text-on-surface-variant/70 max-w-2xl">
            Applique à la sanction déclenchée depuis le message de validation, en cas de
            dérapage dans une soumission.
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div class="space-y-1.5">
              <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Type de sanction</span>
              <select
                bind:value={weekSettings.dailyAlgoSanctionType}
                disabled={!canManageSettings}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
              >
                <option value="WARN">Avertissement</option>
                <option value="TIMEOUT">Exclusion temporaire</option>
              </select>
            </div>
            <div class="space-y-1.5">
              <label for="daSanctionWeight" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Poids de l'avertissement (1-3)</label>
              <input id="daSanctionWeight" type="number" min="1" max="3" step="1" bind:value={weekSettings.dailyAlgoSanctionWeight} disabled={!canManageSettings} class={numberFieldClass} />
            </div>
            <div class="space-y-1.5">
              <label for="daSanctionDuration" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Durée du timeout (minutes)</label>
              <input id="daSanctionDuration" type="number" min="1" max="40320" step="5" bind:value={weekSettings.dailyAlgoSanctionDurationMinutes} disabled={!canManageSettings} class={numberFieldClass} />
            </div>
          </div>
        </section>

        <div class="flex justify-end">
          <button
            onclick={saveWeekSettings}
            disabled={weekSettingsAction.state.loading}
            class="px-8 py-3 bg-primary text-on-primary rounded-xl font-medium text-[13px] transition-transform disabled:opacity-50"
          >
            {weekSettingsAction.state.loading ? 'Enregistrement…' : 'Enregistrer les réglages'}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if dailyAlgoScheduleModalOpen}
    <div class="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-background/80 animate-in fade-in duration-300">
      <div class="bg-surface-container-low border border-outline-variant/10 w-full max-w-2xl rounded-xl shadow-sm overflow-hidden flex flex-col max-h-[85vh]">
        <header class="p-10 border-b border-outline-variant/5 flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold text-on-surface tracking-tight">Programme Daily Algo</h2>
            <p class="text-on-surface-variant/60 mt-1 font-medium">Les prochains défis prévus pour la guilde.</p>
          </div>
          <button onclick={() => dailyAlgoScheduleModalOpen = false} class="p-3 rounded-lg bg-on-surface/5 hover:bg-on-surface/10 transition-colors">
            <Papicon icon="X" size={20} />
          </button>
        </header>

        <div class="flex-1 overflow-y-auto p-10 space-y-4">
          {#if isFetchingAlgoSchedule}
            {#each Array(5) as _}
              <div class="h-20 bg-on-surface/5 rounded-xl animate-pulse"></div>
            {/each}
          {:else if dailyAlgoSchedule.length === 0}
            <div class="py-20 text-center">
              <div class="w-16 h-16 bg-on-surface/5 rounded-full flex items-center justify-center mx-auto mb-4 text-on-surface-variant/20">
                <Papicon icon="Calendar" size={32} />
              </div>
              <p class="text-on-surface-variant/60 font-bold">Aucun programme généré pour l'instant.</p>
              <button 
                onclick={loadDailyAlgoSchedule}
                class="mt-6 px-4 py-2 bg-primary text-on-primary rounded-lg font-medium text-[13px]"
              >
                Générer le planning
              </button>
            </div>
          {:else}
            {#each dailyAlgoSchedule as run}
              <div class="group flex items-center justify-between p-6 bg-surface-container-high/40 border border-outline-variant/5 rounded-xl hover:border-primary/20 hover:bg-primary/5 transition-all">
                <div class="flex items-center gap-6">
                  <div class="w-14 h-14 bg-surface-container-highest rounded-lg flex flex-col items-center justify-center text-center border border-outline-variant/10">
                    <span class="text-[10px] font-semibold uppercase text-on-surface-variant/40 leading-none mb-1">
                      {new Date(run.dateKey).toLocaleDateString('fr-FR', { month: 'short' })}
                    </span>
                    <span class="text-xl font-semibold text-on-surface leading-none">
                      {new Date(run.dateKey).getDate()}
                    </span>
                  </div>
                  <div>
                    <h4 class="font-semibold text-on-surface">{run.problem?.title ?? 'Problème inconnu'}</h4>
                    <div class="flex items-center gap-3 mt-1">
                      <span class="px-2 py-0.5 bg-on-surface/5 rounded-lg text-xs font-medium text-on-surface-variant/60 border border-outline-variant/5">
                        {run.problem?.difficulty ?? 'normal'}
                      </span>
                      <span class="text-[10px] font-bold text-on-surface-variant/40">
                        {run.submissionsCount ?? 0} soumissions
                      </span>
                    </div>
                  </div>
                </div>
                
                {#if run.dateKey === new Date().toISOString().split('T')[0]}
                  <span class="px-3 py-1 bg-emerald-500/10 text-emerald-500 rounded-lg text-xs font-medium border border-emerald-500/20">Aujourd'hui</span>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        {#if canManageSettings}
          <footer class="p-8 bg-surface-container-high/30 border-t border-outline-variant/5">
            <button 
              onclick={() => ensureDailyAlgoSchedule(21).then(loadDailyAlgoSchedule)}
              class="w-full py-4 bg-primary text-on-primary rounded-xl font-medium text-[13px] shadow-sm shadow-primary/20 hover: transition-transform flex items-center justify-center gap-3"
            >
              <Papicon icon="RefreshCw" size={14} />
              Étendre le planning de 3 semaines
            </button>
          </footer>
        {/if}
      </div>
    </div>
  {/if}
</ModulePage>

<style>
  /* Styles minimaux pour la structure, le reste est en Tailwind */
</style>
