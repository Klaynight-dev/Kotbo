<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
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
  } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { router } from 'tinro';
  import { getModuleMeta } from '../lib/moduleMeta';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import DailyAlgoMiniIDE from '../lib/components/DailyAlgoMiniIDE.svelte';
  import {
    detectIdeLanguageFromCode,
    normalizeIdeLanguage,
    type IdeLanguage,
  } from '../lib/dailyAlgoIde';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { m } from '../lib/i18n';

  const { moduleId } = $props();

  const module = $derived((dashboardStore.state.modules as Array<{ id: string; name: string; description: string; status: string }>).find((m) => m.id === moduleId) || { 
    name: m.ms_module_loading_name(), 
    description: m.ms_module_loading_desc(), 
    status: 'inactive' 
  });
  const moduleMeta = $derived(getModuleMeta(moduleId));
  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.[moduleId]?.canConfigure
      || !!dashboardStore.state.featureAccess?.modules?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );
  const canModerateContent = $derived(
    !!(dashboardStore.state.featureAccess as any)?.content?.canModerate
      || !!dashboardStore.state.access?.canModerateContent
  );
  const canModerateDailyAlgo = $derived(() => {
    if (moduleId === 'daily_algo') {
      return !!(dashboardStore.state.featureAccess as any)?.daily_algo?.canModerate
        || !!dashboardStore.state.access?.canModerateDailyAlgo
        || canModerateContent;
    }
    return canModerateContent;
  });
  const supportedDailyAlgoLanguages: IdeLanguage[] = ['javascript', 'typescript', 'python', 'c', 'lua', 'sqlite'];
  const dailyAlgoLanguageSuggestions = ['javascript', 'typescript', 'python', 'c', 'lua', 'sqlite', 'rust', 'go', 'java', 'php', 'ruby', 'c#'];


  type DailyAlgoUnitTest = {
    name: string;
    args: unknown[];
    expected: unknown;
  };

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

  type DailyAlgoSubmission = {
    id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
    submittedAt: string | number | Date;
    validatedAt?: string | number | Date | null;
    reviewFeedback?: string | null;
    authorName?: string | null;
    authorId?: string | null;
    speedRank?: number | null;
    speedBonusPoints?: number | null;
    scoreFinal?: number | null;
    totalPoints?: number | null;
    validatedByName?: string | null;
    solution?: string;
  };

  type DailyAlgoChallengeTypeKey =
    | 'time-complexity'
    | 'space-complexity'
    | 'code-golf'
    | 'absurd-constraints'
    | 'debug'
    | 'language-imposed'
    | 'classic';

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
    if (value === null || value === undefined || value === '') return m.ms_date_unknown();

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return m.ms_date_unknown();

    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function createFunctionArgDraft(name = 'input', type = 'string'): DailyAlgoFunctionArgDraft {
    return {
      id: createDraftId('arg'),
      name,
      type,
    };
  }

  function createUnitTestDraft(argCount: number, name = m.ms_da_case_n({ n: 1 })): DailyAlgoUnitTestDraft {
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
      if (nextArgs.length > argCount) {
        nextArgs.length = argCount;
      }
      while (nextArgs.length < argCount) {
        nextArgs.push('null');
      }
      return {
        ...test,
        argValues: nextArgs,
      };
    });
  }

  function normalizeEditableLanguageList(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const value = entry.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(value);
    }

    return normalized;
  }

  function parseDraftJsonValue(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, error: 'Valeur vide' };
    }

    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      return { ok: true, value: trimmed };
    }
  }

  async function copyToClipboard(text: string, successMessage = m.ms_da_copied_clipboard()) {
    if (!text.trim()) {
      apiKeyAction.setError(m.ms_da_nothing_to_copy());
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      apiKeyAction.setMessage(successMessage);
    } catch (error) {
      console.error(error);
      apiKeyAction.setError(m.ms_da_copy_manual_fallback());
    }
  }

  function openDailyAlgoApiModal() {
    dailyAlgoApiModalOpen = true;
  }

  function closeDailyAlgoApiModal() {
    dailyAlgoApiModalOpen = false;
  }

  let desiredModuleStatus = $state('inactive');
  let createDailyAlgoProblemModalOpen = $state(false);
  let editingDailyAlgoProblemId = $state<string | null>(null);
  const formAction = createAsyncActionState();
  const apiKeyAction = createAsyncActionState();

  // Daily Algo state
  let dailyAlgoProblems = $state<any[]>([]);
  let dailyAlgoToday = $state<any | null>(null);
  let isFetchingAlgo = $state(false);
  let isFetchingAlgoSubmissions = $state(false);
  let isFetchingAlgoHistory = $state(false);
  let isFetchingAlgoSchedule = $state(false);
  let isFetchingGlobalLeaderboard = $state(false);
  let isEnsuringAlgoSchedule = $state(false);
  let dailyAlgoHistory = $state<any[]>([]);
  let dailyAlgoSchedule = $state<any[]>([]);
  let globalLeaderboard = $state<any | null>(null);
  let myApiKeys = $state<any[]>([]);
  let dailyAlgoApiKeyName = $state('Kotbo Daily Algo');
  let latestIssuedApiKey = $state('');
  let isFetchingApiKeys = $state(false);
  let dailyAlgoApiModalOpen = $state(false);
  let dailyAlgoSubmissionStatusFilter = $state<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
  let dailyAlgoLibrarySearch = $state('');
  let dailyAlgoLibraryMode = $state<'ALL' | 'AVAILABLE' | 'USED'>('ALL');
  let switchingTodayProblemId = $state<string | null>(null);
  let deletingDailyAlgoProblemId = $state<string | null>(null);
  let ideFocusedSubmissionId = $state<string | null>(null);
  let ideModalOpen = $state(false);
  let scoreDraftBySubmissionId = $state<Record<string, {
    correctness: number;
    comments: number;
    compactness: number;
    optimization: number;
    readability: number;
    feedback: string;
  }>>({});
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

  onMount(async () => {
    await dashboardStore.refresh();
    if (moduleId === 'daily_algo') {
      await Promise.all([
        loadDailyAlgoProblems(), 
        loadTodayDailyAlgoSubmissions(), 
        loadDailyAlgoHistory(), 
        loadDailyAlgoSchedule(), 
        loadMyApiKeys(),
        loadGlobalLeaderboard()
      ]);
      
      // Auto-open submission IDE if submissionId is present in URL
      const params = new URLSearchParams(window.location.search);
      const submissionId = params.get('submissionId');
      if (submissionId && dailyAlgoToday?.submissions) {
        const submission = dailyAlgoToday.submissions.find((s: any) => s.id === submissionId);
        if (submission) {
          openSubmissionInIntegratedIde(submission);
          // Clear query param to avoid re-opening on refresh if user closed it
          const url = new URL(window.location.href);
          url.searchParams.delete('submissionId');
          window.history.replaceState({}, '', url.toString());
        }
      }
    }
  });

  async function loadDailyAlgoProblems() {
    isFetchingAlgo = true;
    try {
      dailyAlgoProblems = await fetchDailyAlgoProblems();
    } catch (err) {
      console.error(err);
      formAction.setError(m.ms_da_err_load_problems());
    } finally {
      isFetchingAlgo = false;
    }
  }

  async function loadTodayDailyAlgoSubmissions() {
    isFetchingAlgoSubmissions = true;
    try {
      dailyAlgoToday = await fetchTodayDailyAlgoSubmissions();
    } catch (err) {
      console.error(err);
      formAction.setError(m.ms_da_err_load_today_submissions());
    } finally {
      isFetchingAlgoSubmissions = false;
    }
  }

  async function loadGlobalLeaderboard() {
    isFetchingGlobalLeaderboard = true;
    try {
      globalLeaderboard = await fetchGlobalDailyAlgoLeaderboard();
    } catch (err) {
      console.error(err);
    } finally {
      isFetchingGlobalLeaderboard = false;
    }
  }

  async function loadDailyAlgoHistory() {
    isFetchingAlgoHistory = true;
    try {
      const payload = await fetchDailyAlgoSubmissionHistory(7);
      dailyAlgoHistory = payload?.history ?? [];
    } catch (err) {
      console.error(err);
      formAction.setError(m.ms_da_err_load_history());
    } finally {
      isFetchingAlgoHistory = false;
    }
  }

  async function loadDailyAlgoSchedule() {
    isFetchingAlgoSchedule = true;
    try {
      if (canManageSettings) {
        isEnsuringAlgoSchedule = true;
        try {
          await ensureDailyAlgoSchedule(21);
        } finally {
          isEnsuringAlgoSchedule = false;
        }
      }
      const payload = await fetchDailyAlgoSchedule(7, 21);
      dailyAlgoSchedule = Array.isArray(payload?.runs) ? payload.runs : [];
    } catch (err) {
      console.error(err);
      formAction.setError(m.ms_da_err_load_schedule());
    } finally {
      isEnsuringAlgoSchedule = false;
      isFetchingAlgoSchedule = false;
    }
  }

  async function loadMyApiKeys() {
    isFetchingApiKeys = true;
    try {
      const payload = await fetchMyApiKeys();
      myApiKeys = Array.isArray(payload?.keys) ? payload.keys : [];
    } catch (err) {
      console.error(err);
      apiKeyAction.setError(m.ms_da_err_load_api_key());
    } finally {
      isFetchingApiKeys = false;
    }
  }

  async function createOrResetMyApiKey() {
    if (!canManageSettings) {
      apiKeyAction.setError(m.ms_da_admin_only_api_key());
      return;
    }

    await apiKeyAction.run(
      async () => {
        const payload = await createOrResetDailyAlgoApiKey(dailyAlgoApiKeyName.trim() || 'Kotbo Daily Algo');
        const fullKey = typeof payload?.fullKey === 'string' ? payload.fullKey.trim() : '';
        latestIssuedApiKey = fullKey;
        await loadMyApiKeys();
        return Boolean(fullKey);
      },
      {
        successMessage: m.ms_da_api_key_created(),
        failureMessage: m.ms_da_api_key_create_failed(),
      }
    );
  }

  async function deleteCurrentApiKey(keyId: string) {
    if (!canManageSettings) {
      apiKeyAction.setError(m.ms_da_admin_only_api_key());
      return;
    }

    await apiKeyAction.run(
      async () => {
        const ok = await deleteMyApiKey(keyId);
        if (!ok) return false;
        latestIssuedApiKey = '';
        await loadMyApiKeys();
        return true;
      },
      {
        successMessage: m.ms_da_api_key_disabled(),
        failureMessage: m.ms_da_api_key_disable_failed(),
      }
    );
  }

  function resetDailyAlgoDraft() {
    algoDraft = {
      title: '',
      description: '',
      difficulty: 'moyen',
      language: 'fr',
      functionName: '',
      allowedLanguages: [],
      languageInput: '',
      functionArgs: [createFunctionArgDraft('input', 'string')],
      unitTests: [createUnitTestDraft(1, 'Cas 1')],
    };
  }

  function openDailyAlgoProblemModal() {
    if (!canManageSettings) {
      formAction.setError(m.ms_da_admin_only_add_exercise());
      return;
    }

    editingDailyAlgoProblemId = null;
    resetDailyAlgoDraft();
    createDailyAlgoProblemModalOpen = true;
  }

  function openDailyAlgoProblemEditModal(problem: any) {
    if (!canManageSettings) {
      formAction.setError(m.ms_da_admin_only_edit_exercise());
      return;
    }

    const functionArgs = Array.isArray(problem?.functionArgs)
      ? (problem.functionArgs as unknown[])
        .map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const candidate = entry as { name?: unknown; type?: unknown };
          const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
          const type = typeof candidate.type === 'string' ? candidate.type.trim() : '';
          if (!name) return null;
          return createFunctionArgDraft(name, type || 'unknown');
        })
        .filter((entry): entry is DailyAlgoFunctionArgDraft => Boolean(entry))
      : [];

    const argsCount = functionArgs.length;
    const unitTests = Array.isArray(problem?.unitTests)
      ? (problem.unitTests as unknown[])
        .map((entry: unknown, index: number) => {
          if (!entry || typeof entry !== 'object') return null;
          const candidate = entry as { name?: unknown; args?: unknown[]; expected?: unknown };
          const args = Array.isArray(candidate.args) ? candidate.args : [];
          const name = typeof candidate.name === 'string' ? candidate.name.trim() : m.ms_da_case_n({ n: index + 1 });

          return {
            id: createDraftId('test'),
            name: name || m.ms_da_case_n({ n: index + 1 }),
            argValues: Array.from({ length: argsCount }, (_, argIndex) => serializeDraftValue(args[argIndex])),
            expectedValue: serializeDraftValue(candidate.expected),
          } as DailyAlgoUnitTestDraft;
        })
        .filter((entry): entry is DailyAlgoUnitTestDraft => Boolean(entry))
      : [];

    editingDailyAlgoProblemId = problem.id;
    algoDraft = {
      title: typeof problem?.title === 'string' ? problem.title : '',
      description: typeof problem?.description === 'string' ? problem.description : '',
      difficulty: typeof problem?.difficulty === 'string' ? problem.difficulty : 'moyen',
      language: typeof problem?.language === 'string' ? problem.language : 'fr',
      functionName: typeof problem?.functionName === 'string' ? problem.functionName : '',
      allowedLanguages: normalizeEditableLanguageList(problem?.allowedLanguages),
      languageInput: '',
      functionArgs,
      unitTests: unitTests.length > 0 ? alignUnitTestsWithArgs(unitTests, argsCount) : [createUnitTestDraft(argsCount, 'Cas 1')],
    };
    createDailyAlgoProblemModalOpen = true;
  }

  function closeDailyAlgoProblemModal() {
    createDailyAlgoProblemModalOpen = false;
    editingDailyAlgoProblemId = null;
    resetDailyAlgoDraft();
  }

  function addDraftAllowedLanguage() {
    const value = algoDraft.languageInput.trim();
    if (!value) return;

    const exists = algoDraft.allowedLanguages.some((entry) => entry.toLowerCase() === value.toLowerCase());
    if (!exists) {
      algoDraft.allowedLanguages = [...algoDraft.allowedLanguages, value];
    }
    algoDraft.languageInput = '';
  }

  function addSuggestedLanguage(language: string) {
    const value = language.trim();
    if (!value) return;
    const exists = algoDraft.allowedLanguages.some((entry) => entry.toLowerCase() === value.toLowerCase());
    if (!exists) {
      algoDraft.allowedLanguages = [...algoDraft.allowedLanguages, value];
    }
  }

  function removeDraftAllowedLanguage(language: string) {
    algoDraft.allowedLanguages = algoDraft.allowedLanguages.filter((entry) => entry !== language);
  }

  function enableFreeLanguageMode() {
    algoDraft.allowedLanguages = [];
    algoDraft.languageInput = '';
  }

  function handleLanguageInputKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addDraftAllowedLanguage();
  }

  function addFunctionArg() {
    const nextArgs = [...algoDraft.functionArgs, createFunctionArgDraft(`arg${algoDraft.functionArgs.length + 1}`, 'unknown')];
    algoDraft.functionArgs = nextArgs;
    algoDraft.unitTests = alignUnitTestsWithArgs(algoDraft.unitTests, nextArgs.length);
  }

  function removeFunctionArg(index: number) {
    if (index < 0 || index >= algoDraft.functionArgs.length) return;
    const nextArgs = algoDraft.functionArgs.filter((_, argIndex) => argIndex !== index);
    algoDraft.functionArgs = nextArgs;
    algoDraft.unitTests = alignUnitTestsWithArgs(algoDraft.unitTests, nextArgs.length);
  }

  function updateFunctionArgName(index: number, value: string) {
    const nextArgs = [...algoDraft.functionArgs];
    if (!nextArgs[index]) return;
    nextArgs[index] = {
      ...nextArgs[index],
      name: value,
    };
    algoDraft.functionArgs = nextArgs;
  }

  function updateFunctionArgType(index: number, value: string) {
    const nextArgs = [...algoDraft.functionArgs];
    if (!nextArgs[index]) return;
    nextArgs[index] = {
      ...nextArgs[index],
      type: value,
    };
    algoDraft.functionArgs = nextArgs;
  }

  function addUnitTest() {
    algoDraft.unitTests = [
      ...algoDraft.unitTests,
      createUnitTestDraft(algoDraft.functionArgs.length, `Cas ${algoDraft.unitTests.length + 1}`),
    ];
  }

  function removeUnitTest(index: number) {
    if (index < 0 || index >= algoDraft.unitTests.length) return;
    algoDraft.unitTests = algoDraft.unitTests.filter((_, testIndex) => testIndex !== index);
  }

  function updateUnitTestName(index: number, value: string) {
    const nextTests = [...algoDraft.unitTests];
    if (!nextTests[index]) return;
    nextTests[index] = {
      ...nextTests[index],
      name: value,
    };
    algoDraft.unitTests = nextTests;
  }

  function updateUnitTestArgValue(testIndex: number, argIndex: number, value: string) {
    const nextTests = [...algoDraft.unitTests];
    const target = nextTests[testIndex];
    if (!target) return;
    const nextArgs = [...target.argValues];
    nextArgs[argIndex] = value;
    nextTests[testIndex] = {
      ...target,
      argValues: nextArgs,
    };
    algoDraft.unitTests = nextTests;
  }

  function updateUnitTestExpectedValue(index: number, value: string) {
    const nextTests = [...algoDraft.unitTests];
    if (!nextTests[index]) return;
    nextTests[index] = {
      ...nextTests[index],
      expectedValue: value,
    };
    algoDraft.unitTests = nextTests;
  }

  async function submitDailyAlgoProblem() {
    if (!canManageSettings) {
      formAction.setError(m.ms_da_admin_only_add_algo());
      return;
    }

    if (!algoDraft.title.trim() || !algoDraft.description.trim()) {
      formAction.setError(m.ms_da_title_desc_required());
      return;
    }

    if (!algoDraft.functionName.trim()) {
      formAction.setError(m.ms_da_function_name_required());
      return;
    }

    const functionArgs = algoDraft.functionArgs
      .map((entry) => ({
        name: entry.name.trim(),
        type: entry.type.trim() || 'unknown',
      }))
      .filter((entry) => entry.name.length > 0);

    const duplicatedArg = functionArgs.find(
      (arg, index) => functionArgs.findIndex((candidate) => candidate.name.toLowerCase() === arg.name.toLowerCase()) !== index,
    );
    if (duplicatedArg) {
      formAction.setError(m.ms_da_duplicate_arg_name({ name: duplicatedArg.name }));
      return;
    }

    if (algoDraft.unitTests.length === 0) {
      formAction.setError(m.ms_da_min_one_test());
      return;
    }

    const unitTests: DailyAlgoUnitTest[] = [];
    for (let testIndex = 0; testIndex < algoDraft.unitTests.length; testIndex += 1) {
      const draftTest = algoDraft.unitTests[testIndex];
      if (draftTest.argValues.length !== functionArgs.length) {
        formAction.setError(m.ms_da_test_arg_count_mismatch({ n: testIndex + 1 }));
        return;
      }

      const args: unknown[] = [];
      for (let argIndex = 0; argIndex < draftTest.argValues.length; argIndex += 1) {
        const parsed = parseDraftJsonValue(draftTest.argValues[argIndex] ?? '');
        if ('error' in parsed) {
          formAction.setError(m.ms_da_test_arg_parse_error({ arg: argIndex + 1, n: testIndex + 1, error: parsed.error }));
          return;
        }
        args.push(parsed.value);
      }

      const parsedExpected = parseDraftJsonValue(draftTest.expectedValue ?? '');
      if ('error' in parsedExpected) {
        formAction.setError(m.ms_da_test_expected_parse_error({ n: testIndex + 1, error: parsedExpected.error }));
        return;
      }

      unitTests.push({
        name: draftTest.name.trim() || m.ms_da_test_n({ n: testIndex + 1 }),
        args,
        expected: parsedExpected.value,
      });
    }

    const allowedLanguages = normalizeEditableLanguageList(algoDraft.allowedLanguages);

    const payload = {
      title: algoDraft.title.trim(),
      description: algoDraft.description.trim(),
      difficulty: algoDraft.difficulty,
      language: algoDraft.language || 'fr',
      functionName: algoDraft.functionName.trim(),
      functionArgs,
      unitTests,
      allowedLanguages,
      solution: '',
    };

    const isEdition = Boolean(editingDailyAlgoProblemId);

    await formAction.run(
      async () => {
        const ok = isEdition
          ? await updateDailyAlgoProblem(editingDailyAlgoProblemId, payload)
          : await createDailyAlgoProblem(payload);
        if (!ok) return false;

        resetDailyAlgoDraft();
        editingDailyAlgoProblemId = null;
        createDailyAlgoProblemModalOpen = false;
        await Promise.all([loadDailyAlgoProblems(), loadTodayDailyAlgoSubmissions(), loadDailyAlgoSchedule()]);
        return true;
      },
      {
        successMessage: isEdition
          ? m.ms_da_updated_edit()
          : m.ms_da_added_success(),
        failureMessage: isEdition
          ? m.ms_da_update_failed()
          : m.ms_da_add_failed()
      }
    );
  }

  function getDefaultScoreDraft() {
    return {
      correctness: 5,
      comments: 5,
      compactness: 5,
      optimization: 5,
      readability: 5,
      feedback: '',
    };
  }

  function buildDraftFromSubmission(submission: any) {
    const hasPersistedScores = [
      submission?.scoreCorrectness,
      submission?.scoreComments,
      submission?.scoreCompactness,
      submission?.scoreOptimization,
      submission?.scoreReadability,
    ].every((value) => Number.isFinite(Number(value)));

    const fallback = getDefaultScoreDraft();
    return {
      correctness: hasPersistedScores ? Number(submission.scoreCorrectness) : fallback.correctness,
      comments: hasPersistedScores ? Number(submission.scoreComments) : fallback.comments,
      compactness: hasPersistedScores ? Number(submission.scoreCompactness) : fallback.compactness,
      optimization: hasPersistedScores ? Number(submission.scoreOptimization) : fallback.optimization,
      readability: hasPersistedScores ? Number(submission.scoreReadability) : fallback.readability,
      feedback: submission?.reviewFeedback && submission.reviewFeedback !== 'Rien à redire.'
        ? submission.reviewFeedback
        : '',
    };
  }

  function ensureSubmissionDraft(submission: any) {
    if (scoreDraftBySubmissionId[submission.id]) return;
    scoreDraftBySubmissionId = {
      ...scoreDraftBySubmissionId,
      [submission.id]: buildDraftFromSubmission(submission),
    };
  }

  function ideLanguageForSubmission(submission: any): IdeLanguage {
    if (typeof submission?.language === 'string' && submission.language.trim()) {
      return normalizeIdeLanguage(submission.language);
    }
    return detectIdeLanguageFromCode(submission?.solution ?? '');
  }

  function openSubmissionInIntegratedIde(submission: any) {
    ensureSubmissionDraft(submission);
    ideFocusedSubmissionId = submission.id;
    ideModalOpen = true;
  }

  function closeIntegratedIde() {
    ideModalOpen = false;
    ideFocusedSubmissionId = null;
  }

  function updateSubmissionScore(
    submissionId: string,
    field: 'correctness' | 'comments' | 'compactness' | 'optimization' | 'readability',
    value: number,
  ) {
    const score = Number.isFinite(value) ? Math.max(1, Math.min(5, Math.trunc(value))) : 1;
    scoreDraftBySubmissionId = {
      ...scoreDraftBySubmissionId,
      [submissionId]: {
        ...(scoreDraftBySubmissionId[submissionId] ?? getDefaultScoreDraft()),
        [field]: score,
      },
    };
  }

  function updateSubmissionFeedback(submissionId: string, value: string) {
    scoreDraftBySubmissionId = {
      ...scoreDraftBySubmissionId,
      [submissionId]: {
        ...(scoreDraftBySubmissionId[submissionId] ?? getDefaultScoreDraft()),
        feedback: value,
      },
    };
  }

  function reviewAverage(submissionId: string) {
    const draft = scoreDraftBySubmissionId[submissionId] ?? getDefaultScoreDraft();
    const total = draft.correctness + draft.comments + draft.compactness + draft.optimization + draft.readability;
    return (total / 5).toFixed(1);
  }

  async function rejectSubmission(submissionId: string) {
    if (!canModerateDailyAlgo) {
      formAction.setError(m.ms_da_no_moderate_rights());
      return;
    }

    await formAction.run(
      async () => {
        const ok = await reviewDailyAlgoSubmission(submissionId, { action: 'reject' });
        if (!ok) return false;
        closeIntegratedIde();
        await Promise.all([loadTodayDailyAlgoSubmissions(), loadDailyAlgoHistory(), dashboardStore.refresh()]);
        return true;
      },
      {
        successMessage: m.ms_da_submission_rejected(),
        failureMessage: 'Impossible de rejeter cette soumission.'
      }
    );
  }

  async function approveSubmission(submissionId: string) {
    if (!canModerateDailyAlgo) {
      formAction.setError(m.ms_da_no_moderate_rights());
      return;
    }

    const draft = scoreDraftBySubmissionId[submissionId] ?? getDefaultScoreDraft();
    const feedback = draft.feedback?.trim() ?? '';
    const hasLowScore = [draft.correctness, draft.comments, draft.compactness, draft.optimization, draft.readability].some((score) => score < 5);

    if (hasLowScore && !feedback) {
      formAction.setError(m.ms_da_explanation_required_low_score());
      return;
    }

    const currentSubmission = getDailyAlgoSubmissions().find((submission) => submission.id === submissionId);
    const isEdition = currentSubmission?.status !== 'PENDING';

    await formAction.run(
      async () => {
        const ok = await reviewDailyAlgoSubmission(submissionId, {
          action: 'approve',
          scores: {
            correctness: draft.correctness,
            comments: draft.comments,
            compactness: draft.compactness,
            optimization: draft.optimization,
            readability: draft.readability,
          },
          feedback: feedback || undefined,
        });
        if (!ok) return false;

        closeIntegratedIde();
        await Promise.all([loadTodayDailyAlgoSubmissions(), loadDailyAlgoHistory(), dashboardStore.refresh()]);
        return true;
      },
      {
        successMessage: isEdition ? m.ms_da_scores_updated() : m.ms_da_submission_validated(),
        failureMessage: 'Impossible de valider cette soumission.'
      }
    );
  }

  async function setProblemAsToday(problemId: string) {
    if (!canManageSettings) {
      formAction.setError(m.ms_da_admin_only_change_today());
      return;
    }

    switchingTodayProblemId = problemId;
    try {
      await formAction.run(
        async () => {
          const payload = await swapTodayDailyAlgoProblem(problemId);
          if (!payload?.ok) return false;

          await Promise.all([
            loadTodayDailyAlgoSubmissions(),
            loadDailyAlgoProblems(),
            loadDailyAlgoHistory(),
            loadDailyAlgoSchedule(),
            dashboardStore.refresh(),
          ]);
          return true;
        },
        {
          successMessage: m.ms_da_today_updated(),
          failureMessage: m.ms_da_today_update_failed(),
        },
      );
    } finally {
      switchingTodayProblemId = null;
    }
  }

  async function deleteDailyAlgoProblemFromLibrary(problem: any) {
    if (!canManageSettings) {
      formAction.setError(m.ms_da_admin_only_delete_exercise());
      return;
    }

    if (!(await confirmDialog.danger(m.ms_da_confirm_delete_title({ title: problem.title }), m.ms_da_confirm_delete_body()))) return;

    deletingDailyAlgoProblemId = problem.id;
    try {
      await formAction.run(
        async () => {
          const payload = await deleteDailyAlgoProblem(problem.id);
          if (!payload?.ok) return false;

          if (editingDailyAlgoProblemId === problem.id) {
            closeDailyAlgoProblemModal();
          }

          await Promise.all([
            loadDailyAlgoProblems(),
            loadTodayDailyAlgoSubmissions(),
            loadDailyAlgoHistory(),
            loadDailyAlgoSchedule(),
            dashboardStore.refresh(),
          ]);
          return true;
        },
        {
          successMessage: m.ms_da_deleted(),
          failureMessage: m.ms_da_delete_failed(),
        },
      );
    } finally {
      deletingDailyAlgoProblemId = null;
    }
  }

  function submissionStatusMeta(status: string) {
    if (status === 'APPROVED') {
      return {
        label: m.ms_da_status_validated(),
        classes: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
      };
    }
    if (status === 'REJECTED') {
      return {
        label: m.ms_da_status_rejected(),
        classes: 'bg-red-500/10 text-red-700 border-red-500/20',
      };
    }
    return {
      label: m.ms_da_status_pending(),
      classes: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
    };
  }

  const todaySubmissionStats = $derived.by(() => {
    const submissions = getDailyAlgoSubmissions();
    return {
      total: submissions.length,
      pending: submissions.filter((submission) => submission.status === 'PENDING').length,
      approved: submissions.filter((submission) => submission.status === 'APPROVED').length,
      rejected: submissions.filter((submission) => submission.status === 'REJECTED').length,
    };
  });

  const filteredTodaySubmissions = $derived.by(() => {
    const submissions = getDailyAlgoSubmissions();
    if (dailyAlgoSubmissionStatusFilter === 'ALL') {
      return submissions;
    }
    return submissions.filter((submission) => submission.status === dailyAlgoSubmissionStatusFilter);
  });

  function submissionStatusSortWeight(status: string) {
    if (status === 'PENDING') return 0;
    if (status === 'APPROVED') return 1;
    if (status === 'REJECTED') return 2;
    return 3;
  }

  const sortedFilteredTodaySubmissions = $derived.by(() => {
    return [...filteredTodaySubmissions].sort((left, right) => {
      const statusDelta = submissionStatusSortWeight(left.status) - submissionStatusSortWeight(right.status);
      if (statusDelta !== 0) return statusDelta;
      return new Date(left.submittedAt).getTime() - new Date(right.submittedAt).getTime();
    });
  });

  const focusedSubmission = $derived.by(() => {
    if (!ideModalOpen || !ideFocusedSubmissionId) return null;
    return getDailyAlgoSubmissions().find((submission) => submission.id === ideFocusedSubmissionId) ?? null;
  });

  $effect(() => {
    if (!ideModalOpen || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeIntegratedIde();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    if (!ideModalOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    if (!dailyAlgoApiModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDailyAlgoApiModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function historyDateLabel(dateKey?: string | null) {
    if (!dateKey) return m.ms_date_unknown();
    const [year, month, day] = dateKey.split('-').map((value) => Number(value));
    if (!year || !month || !day) return dateKey;
    return new Date(year, month - 1, day).toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  function difficultyLabel(value: string) {
    if (value === 'facile') return m.ms_da_difficulty_easy();
    if (value === 'moyen') return m.ms_da_difficulty_medium();
    if (value === 'difficile') return m.ms_da_difficulty_hard();
    return value;
  }

  function dailyAlgoDateKeyFromDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dailyAlgoDetectChallengeTypeKey(title: string, description: string): DailyAlgoChallengeTypeKey {
    const text = `${title ?? ''} ${description ?? ''}`.toLowerCase();

    if (/débog|debug|corrig|fix|bug/.test(text)) return 'debug';
    if (/complexité|o\(n|o\(log|temps d'exécution|runtime/.test(text)) return 'time-complexity';
    if (/mémoire|espace|space complexity|in-place|sans allocation/.test(text)) return 'space-complexity';
    if (/plus court|code golf|minimum de caractères|moins de caractères/.test(text)) return 'code-golf';
    if (/obligatoirement|en python|en rust|en javascript|en go|en typescript|en c\+\+|en c#|en sql|en bash|langage/.test(text)) {
      return 'language-imposed';
    }
    if (/sans la lettre|interdit|absurde|contraintes absurdes|uniquement|sans utiliser/.test(text)) return 'absurd-constraints';
    return 'classic';
  }

  function dailyAlgoChallengeTypeLabel(type: DailyAlgoChallengeTypeKey): string {
    if (type === 'debug') return m.ms_da_type_debug();
    if (type === 'time-complexity') return m.ms_da_type_time_complexity();
    if (type === 'space-complexity') return m.ms_da_type_space_complexity();
    if (type === 'code-golf') return m.ms_da_type_code_golf();
    if (type === 'language-imposed') return m.ms_da_type_language_imposed();
    if (type === 'absurd-constraints') return m.ms_da_type_constraints();
    return m.ms_da_type_classic();
  }

  function dailyAlgoProblemFunctionSignature(problem: { functionName?: unknown; functionArgs?: unknown } | null | undefined) {
    const functionName = typeof problem?.functionName === 'string' && problem.functionName.trim()
      ? problem.functionName.trim()
      : 'solve';

    const args = Array.isArray(problem?.functionArgs)
      ? (problem.functionArgs as unknown[])
        .filter((entry: unknown) => entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')
        .map((entry: unknown) => {
          const candidate = entry as { name?: string; type?: string };
          return `${candidate.name}${candidate.type ? `: ${candidate.type}` : ''}`;
        })
      : [];

    return `${functionName}(${args.join(', ')})`;
  }

  function getDailyAlgoSubmissions(): DailyAlgoSubmission[] {
    return Array.isArray(dailyAlgoToday?.submissions) ? (dailyAlgoToday.submissions as DailyAlgoSubmission[]) : [];
  }

  function toKnownIdeLanguage(input: string): IdeLanguage | null {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'javascript' || normalized === 'js') return 'javascript';
    if (normalized === 'typescript' || normalized === 'ts') return 'typescript';
    if (normalized === 'python' || normalized === 'py') return 'python';
    if (normalized === 'c' || normalized === 'cpp' || normalized === 'c++') return 'c';
    if (normalized === 'lua') return 'lua';
    if (normalized === 'sqlite' || normalized === 'sql') return 'sqlite';
    return null;
  }

  function dailyAlgoProblemAllowedLanguages(problem: any): string[] {
    const raw = Array.isArray(problem?.allowedLanguages) ? problem.allowedLanguages : [];
    return normalizeEditableLanguageList(raw);
  }

  function dailyAlgoProblemAllowedIdeLanguages(problem: any): IdeLanguage[] {
    const raw = dailyAlgoProblemAllowedLanguages(problem);
    const known = raw
      .map((entry) => toKnownIdeLanguage(entry))
      .filter((entry): entry is IdeLanguage => Boolean(entry))
      .filter((value, index, array) => supportedDailyAlgoLanguages.includes(value) && array.indexOf(value) === index);

    return known;
  }

  const selectedGuildId = $derived(authStore.selectedGuildId ?? '');
  const publicApiBaseUrl = $derived.by(() => {
    const fromEnv = typeof API_BASE_URL === 'string' ? API_BASE_URL.trim() : '';
    if (fromEnv) return `${fromEnv}/api/public`;
    if (typeof window !== 'undefined') return `${window.location.origin}/api/public`;
    return '/api/public';
  });
  const dailyAlgoPublicApiProblemsUrl = $derived.by(() => {
    if (!selectedGuildId) return '';
    return `${publicApiBaseUrl}/guilds/${selectedGuildId}/daily-algo-problems`;
  });
  const currentApiKey = $derived(myApiKeys.length > 0 ? myApiKeys[0] : null);
  const apiDocPayloadExample = $derived('{"title":"Somme","description":"Retourner a+b","difficulty":"facile","language":"fr","functionName":"solve","functionArgs":[{"name":"a","type":"number"},{"name":"b","type":"number"}],"unitTests":[{"name":"Cas 1","args":[1,2],"expected":3}],"allowedLanguages":["javascript","python"],"solution":""}');
  const apiDocGetCurl = $derived.by(() => {
    if (!dailyAlgoPublicApiProblemsUrl) return m.ms_da_select_guild_for_commands();
    return `curl -H "X-API-Key: kb_..." "${dailyAlgoPublicApiProblemsUrl}"`;
  });
  const apiDocPostCurl = $derived.by(() => {
    if (!dailyAlgoPublicApiProblemsUrl) return m.ms_da_select_guild_for_commands();
    return `curl -X POST "${dailyAlgoPublicApiProblemsUrl}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-Key: kb_..." \\\n  -d '${apiDocPayloadExample}'`;
  });
  const apiDocPatchCurl = $derived.by(() => {
    if (!dailyAlgoPublicApiProblemsUrl) return m.ms_da_select_guild_for_commands();
    return `curl -X PATCH "${dailyAlgoPublicApiProblemsUrl}/PROBLEM_ID" \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-Key: kb_..." \\\n  -d '${apiDocPayloadExample}'`;
  });

  const todayDateKey = $derived.by(() => dailyAlgoDateKeyFromDate(new Date()));
  const todayRunProblemId = $derived.by(() => {
    const problemId = dailyAlgoToday?.run?.problem?.id;
    return typeof problemId === 'string' && problemId.trim() ? problemId : null;
  });

  const dailyAlgoScheduleRuns = $derived.by(() => {
    const runs = Array.isArray(dailyAlgoSchedule) ? [...dailyAlgoSchedule] : [];
    return runs
      .filter((run) => typeof run?.dateKey === 'string' && run.dateKey.trim().length > 0)
      .sort((left, right) => String(left.dateKey).localeCompare(String(right.dateKey)))
      .map((run) => {
        const dateKey = String(run.dateKey);
        const status = dateKey < todayDateKey
          ? 'past'
          : dateKey > todayDateKey
            ? 'future'
            : 'today';

        return {
          ...run,
          dateKey,
          status,
          challengeType: dailyAlgoDetectChallengeTypeKey(
            run?.problem?.title ?? '',
            run?.problem?.description ?? '',
          ),
        };
      });
  });

  const dailyAlgoUpcomingRuns = $derived.by(() => dailyAlgoScheduleRuns.filter((run) => run.status !== 'past'));
  const dailyAlgoFutureRunsCount = $derived.by(() => dailyAlgoScheduleRuns.filter((run) => run.status === 'future').length);

  const dailyAlgoScheduleDateByProblemId = $derived.by(() => {
    const entries = dailyAlgoScheduleRuns
      .filter((run) => typeof run?.problem?.id === 'string' && run.problem.id.trim())
      .map((run) => [run.problem.id as string, run.dateKey as string] as const);
    return Object.fromEntries(entries);
  });

  function dailyAlgoPlannedDateForProblem(problemId: string): string | null {
    return dailyAlgoScheduleDateByProblemId[problemId] ?? null;
  }

  const filteredDailyAlgoLibrary = $derived.by(() => {
    const query = dailyAlgoLibrarySearch.trim().toLowerCase();
    const filtered = [...dailyAlgoProblems].filter((problem) => {
      if (dailyAlgoLibraryMode === 'AVAILABLE' && problem?.usedAt) return false;
      if (dailyAlgoLibraryMode === 'USED' && !problem?.usedAt) return false;

      if (!query) return true;

      const haystack = [
        problem?.title ?? '',
        problem?.description ?? '',
        problem?.difficulty ?? '',
        dailyAlgoProblemFunctionSignature(problem),
        ...(dailyAlgoProblemAllowedLanguages(problem) ?? []),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });

    return filtered.sort((left, right) => {
      const leftUsed = Boolean(left?.usedAt);
      const rightUsed = Boolean(right?.usedAt);
      if (leftUsed !== rightUsed) return leftUsed ? 1 : -1;

      if (!leftUsed) {
        const leftPlanned = dailyAlgoScheduleDateByProblemId[left.id] ?? '9999-99-99';
        const rightPlanned = dailyAlgoScheduleDateByProblemId[right.id] ?? '9999-99-99';
        if (leftPlanned !== rightPlanned) return leftPlanned.localeCompare(rightPlanned);
      } else {
        const leftUsedAt = left?.usedAt ? new Date(left.usedAt).getTime() : 0;
        const rightUsedAt = right?.usedAt ? new Date(right.usedAt).getTime() : 0;
        if (leftUsedAt !== rightUsedAt) return rightUsedAt - leftUsedAt;
      }

      const leftCreatedAt = left?.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightCreatedAt = right?.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightCreatedAt - leftCreatedAt;
    });
  });

  let savedStatus = $state('inactive');

  $effect(() => {
    if (module) {
      savedStatus = module.status === 'active' ? 'active' : 'inactive';
      desiredModuleStatus = savedStatus;
    }
  });

  $effect(() => {
    const dirty = desiredModuleStatus !== savedStatus;
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'module-settings',
          label: `Module ${module.name}`,
          onSave: () => handleSave(),
          onReset: () => {
            desiredModuleStatus = savedStatus;
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('module-settings');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('module-settings');
  });



  async function handleSave(): Promise<boolean> {
    formAction.clearFeedback();

    if (!canManageSettings) {
      formAction.setError(m.ms_admin_only_edit_module());
      return false;
    }

    let success = false;
    await formAction.run(
      async () => {
        const successRes = await updateModuleStatus(moduleId, desiredModuleStatus);
        if (!successRes) return false;
        await dashboardStore.refresh();
        savedStatus = desiredModuleStatus;
        success = true;
        return true;
      },
      {
        successMessage: m.ms_config_saved_success(),
        failureMessage: m.ms_config_save_failed()
      }
    );
    return success;
  }


</script>

<div class="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
  
  <div class="flex items-center gap-3 px-2">
    <a href="/modules" class="text-[10px] font-semibold text-on-surface-variant/40 hover:text-primary uppercase tracking-wider transition-colors">{m.ms_breadcrumb_catalog()}</a>
    <Papicon icon="chevron_right" size={14} class="text-slate-400 opacity-30" />
    <span class="text-[10px] font-semibold text-primary uppercase tracking-wider">{module.name}</span>
  </div>

  
  <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-5 border-b border-outline-variant/20">
    <div class="flex items-center gap-4">
      <div class="w-11 h-11 rounded-xl {moduleMeta.headerToneClasses} flex items-center justify-center shadow-inner border group hover:rotate-6 transition-transform">
        <Papicon icon={moduleMeta.icon} size={22} />
      </div>
      <div>
        <h2 class="text-lg font-semibold font-headline tracking-tight leading-tight">{module.name}</h2>
        <div class="flex items-center gap-2 mt-1 px-2.5 py-0.5 bg-emerald-500/5 rounded-full border border-emerald-500/10 w-fit">
          <span class="w-1.5 h-1.5 rounded-full {module.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}"></span>
          <span class="text-[11px] font-semibold {module.status === 'active' ? 'text-emerald-600' : 'text-slate-500'} uppercase tracking-widest whitespace-nowrap">
            {module.status === 'active' ? m.common_active() : m.common_inactive()}
          </span>
        </div>
      </div>
    </div>
    
    <div class="flex items-center gap-4">
      <RefreshButton
        onClick={() => dashboardStore.refresh()}
        loading={dashboardStore.state.loading}
        label={m.common_refresh()}
        className="px-6 py-3.5 text-[13px] font-medium rounded-lg bg-surface-container-low hover:bg-surface-container-high border border-outline-variant/30 text-on-surface-variant/60 hover:text-on-surface shadow-none"
        iconClass="text-base"
      />
      <!-- Save button removed since global bottom bar handles saving -->
    </div>
  </div>

  <InlineFeedback message={formAction.state.message} error={formAction.state.error} />

  {#if moduleId !== 'dailyalgo'}
    <div class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-700">
      {m.ms_moderator_readonly_notice()}
    </div>
  {/if}

  <div class="grid grid-cols-12 gap-12">
    
    <div class="col-span-12 space-y-12 pb-24">
      
      {#if moduleId !== 'dailyalgo'}
        <section class="space-y-8">
          <h3 class="text-xl font-semibold tracking-tight flex items-center gap-4">
            <div class="w-1.5 h-8 bg-primary rounded-full"></div>
            {m.ms_general_config()}
          </h3>
          <div class="premium-card p-10 rounded-xl space-y-10 group">
            <div class="space-y-4">
              <label class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider ml-2 block" for="name">{m.ms_module_description_label()}</label>
              <p class="px-6 py-4 bg-surface-container-low border border-outline-variant/5 rounded-lg text-sm italic opacity-70">
                {module.description}
              </p>
            </div>
          </div>
        </section>
      {:else if moduleId === 'dailyalgo'}
        <section class="space-y-8">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 class="text-xl font-semibold tracking-tight flex items-center gap-4">
                <div class="w-1.5 h-8 bg-emerald-500 rounded-full"></div>
                {m.ms_da_control_room_title()}
              </h3>
              <p class="mt-2 text-xs text-on-surface-variant">
                {m.ms_da_control_room_subtitle()}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <RefreshButton
                onClick={async () => {
                  await Promise.all([loadTodayDailyAlgoSubmissions(), loadDailyAlgoProblems(), loadDailyAlgoHistory(), loadDailyAlgoSchedule(), loadMyApiKeys()]);
                }}
                loading={isFetchingAlgoSubmissions || isFetchingAlgo || isFetchingAlgoHistory || isFetchingAlgoSchedule || isEnsuringAlgoSchedule || isFetchingApiKeys}
                label={m.ms_refresh_all()}
                className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider rounded-xl bg-surface-container-low hover:bg-surface-container-high border border-outline-variant/20 text-on-surface-variant"
                iconClass="text-sm"
              />
              <button
                type="button"
                onclick={openDailyAlgoApiModal}
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-outline-variant/30 bg-surface-container-low text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
              >
                <Papicon icon="key" size={14} />
                {m.ms_da_external_api()}
              </button>
              {#if canManageSettings}
                <button
                  type="button"
                  onclick={openDailyAlgoProblemModal}
                  class="px-4 py-2 rounded-xl bg-emerald-600 text-white text-[10px] font-semibold uppercase tracking-wide shadow-sm hover:bg-emerald-700"
                >
                  {m.ms_da_add_exercise()}
                </button>
              {/if}
            </div>
          </div>

          <div class="premium-card rounded-xl p-6 md:p-7 bg-linear-to-br from-emerald-500/10 via-surface to-sky-500/10 border border-emerald-500/15">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div class="rounded-lg bg-slate-500/10 border border-slate-500/20 p-4">
                <p class="text-[11px] uppercase tracking-wider font-semibold text-slate-700/80">{m.ms_da_stat_submissions()}</p>
                <p class="text-2xl font-semibold text-slate-700 mt-1">{todaySubmissionStats.total}</p>
              </div>
              <div class="rounded-lg bg-amber-500/10 border border-amber-500/20 p-4">
                <p class="text-[11px] uppercase tracking-wider font-semibold text-amber-700/80">{m.ms_da_status_pending()}</p>
                <p class="text-2xl font-semibold text-amber-700 mt-1">{todaySubmissionStats.pending}</p>
              </div>
              <div class="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4">
                <p class="text-[11px] uppercase tracking-wider font-semibold text-emerald-700/80">{m.ms_da_status_validated()}</p>
                <p class="text-2xl font-semibold text-emerald-700 mt-1">{todaySubmissionStats.approved}</p>
              </div>
              <div class="rounded-lg bg-sky-500/10 border border-sky-500/20 p-4">
                <p class="text-[11px] uppercase tracking-wider font-semibold text-sky-700/80">{m.ms_da_stat_safe_dates()}</p>
                <p class="text-2xl font-semibold text-sky-700 mt-1">{dailyAlgoFutureRunsCount}</p>
              </div>
            </div>
          </div>

          <div class="premium-card p-8 rounded-xl space-y-6">
            <div class="flex items-center justify-between gap-4">
              <h4 class="text-lg font-semibold text-on-surface">{m.ms_da_section1_title()}</h4>
              <RefreshButton
                onClick={loadTodayDailyAlgoSubmissions}
                loading={isFetchingAlgoSubmissions}
                label={m.common_refresh()}
                className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider rounded-xl bg-surface-container-low hover:bg-surface-container-high border border-outline-variant/20 text-on-surface-variant"
                iconClass="text-sm"
              />
            </div>

            {#if isFetchingAlgoSubmissions}
              <div class="space-y-2">
                {#each Array(3) as _}
                  <div class="p-4 rounded-lg border border-outline-variant/20 bg-surface-container-low space-y-3">
                    <div class="flex items-center justify-between gap-2">
                      <Skeleton width="w-32" height="h-4" />
                      <Skeleton width="w-20" height="h-4" />
                    </div>
                    <Skeleton width="w-full" height="h-3" />
                    <div class="flex gap-2">
                      <Skeleton width="w-24" height="h-3" />
                      <Skeleton width="w-24" height="h-3" />
                    </div>
                  </div>
                {/each}
              </div>
            {:else if !dailyAlgoToday?.run}
              <div class="p-8 rounded-lg border border-outline-variant/20 bg-surface-container-low text-sm text-on-surface-variant">
                {m.ms_da_none_launched_today()}
              </div>
            {:else}
              <div class="rounded-lg bg-surface-container-low border border-outline-variant/15 p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">{m.ms_da_current_challenge()}</p>
                  <span class="px-2 py-1 rounded-md border border-outline-variant/25 bg-surface text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                    {dailyAlgoChallengeTypeLabel(dailyAlgoDetectChallengeTypeKey(dailyAlgoToday.run.problem.title, dailyAlgoToday.run.problem.description))}
                  </span>
                </div>
                <p class="mt-1 text-sm font-semibold text-on-surface">{dailyAlgoToday.run.problem.title}</p>
                <p class="mt-2 text-xs text-on-surface-variant line-clamp-3">{dailyAlgoToday.run.problem.description}</p>
              </div>

              <div class="rounded-lg border border-outline-variant/15 bg-surface-container-low p-4">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60 mr-2">{m.ms_da_filter_by_status()}</span>
                  {#each [
                    { value: 'ALL', label: 'Tous' },
                    { value: 'PENDING', label: 'En attente' },
                    { value: 'APPROVED', label: m.ms_da_status_validated() },
                    { value: 'REJECTED', label: m.ms_da_status_rejected() },
                  ] as option}
                    <button
                      type="button"
                      onclick={() => (dailyAlgoSubmissionStatusFilter = option.value as 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED')}
                      class="px-3 py-1.5 rounded-lg border text-[10px] font-semibold uppercase tracking-wide transition-colors {dailyAlgoSubmissionStatusFilter === option.value
 ? 'bg-primary text-on-primary border-primary'
                        : 'bg-surface text-on-surface-variant border-outline-variant/30 hover:text-on-surface'}"
                    >
                      {option.label}
                    </button>
                  {/each}
                </div>
              </div>

              {#if (dailyAlgoToday.submissions ?? []).length === 0}
                <div class="p-8 rounded-lg border border-outline-variant/20 bg-surface-container-low text-sm text-on-surface-variant">
                  {m.ms_da_none_submitted_yet()}
                </div>
              {:else if filteredTodaySubmissions.length === 0}
                <div class="p-8 rounded-lg border border-outline-variant/20 bg-surface-container-low text-sm text-on-surface-variant">
                  {m.ms_da_none_matches_filter()}
                </div>
              {:else}
                <div class="space-y-3">
                  <p class="text-xs font-bold text-on-surface-variant">
                    {m.ms_da_submissions_shown_count({ shown: sortedFilteredTodaySubmissions.length, total: dailyAlgoToday.submissions.length })}
                  </p>
                  <div class="rounded-lg border border-outline-variant/15 bg-surface-container-low overflow-x-auto">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_member()}</th>
                          <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_status()}</th>
                          <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_submission()}</th>
                          <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_score_total()}</th>
                          <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_moderation()}</th>
                          <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_actions()}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each sortedFilteredTodaySubmissions as submission}
                          <tr>
                            <td>
                              <p class="text-sm font-semibold text-on-surface">{submission.authorName}</p>
                              <p class="text-[10px] text-on-surface-variant">ID: {submission.authorId}</p>
                            </td>
                            <td>
                              <span class="px-2.5 py-1 rounded-lg border text-[10px] font-semibold uppercase tracking-wide {submissionStatusMeta(submission.status).classes}">
                                {submissionStatusMeta(submission.status).label}
                              </span>
                              {#if submission.speedRank}
                                <p class="mt-1 text-[10px] text-on-surface-variant">
                                  {m.ms_da_rank_n({ n: submission.speedRank })}
                                  {#if (submission.speedBonusPoints ?? 0) > 0}
                                    (+{submission.speedBonusPoints})
                                  {/if}
                                </p>
                              {/if}
                            </td>
                            <td>
                              <p class="text-xs font-bold text-on-surface">{formatDate(submission.submittedAt)}</p>
                              <div class="mt-1 flex flex-wrap items-center gap-3">
                                <button
                                  type="button"
                                  onclick={() => openSubmissionInIntegratedIde(submission)}
                                  class="text-xs font-medium text-emerald-700 hover:text-emerald-600"
                                >
                                  {m.ms_da_integrated_ide()}
                                </button>
                              </div>
                            </td>
                            <td>
                              {#if submission.status === 'APPROVED'}
                                <p class="text-xs font-semibold text-emerald-700">{submission.scoreFinal ?? 0}/5</p>
                                <p class="text-[10px] text-emerald-700/80">{m.ms_da_total_pts({ n: submission.totalPoints ?? submission.scoreFinal ?? 0 })}</p>
                              {:else if submission.status === 'REJECTED'}
                                <p class="text-xs font-semibold text-red-700">{m.ms_da_status_rejected()}</p>
                              {:else}
                                <p class="text-xs font-semibold text-amber-700">{m.ms_da_pending_score()}</p>
                              {/if}
                              {#if submission.reviewFeedback}
                                <p class="mt-1 text-[10px] text-on-surface-variant line-clamp-2">{submission.reviewFeedback}</p>
                              {/if}
                            </td>
                            <td>
                              {#if submission.validatedByName}
                                <p class="text-xs font-bold text-on-surface">{submission.validatedByName}</p>
                                <p class="text-[10px] text-on-surface-variant">{submission.validatedAt ? formatDate(submission.validatedAt) : m.ms_date_unknown()}</p>
                              {:else}
                                <p class="text-[10px] font-bold text-on-surface-variant">{m.ms_da_not_moderated_yet()}</p>
                              {/if}
                            </td>
                            <td>
                              {#if canModerateDailyAlgo && (submission.status === 'PENDING' || submission.status === 'APPROVED' || submission.status === 'REJECTED')}
                                <div class="flex flex-col gap-2">
                                  <button
                                    type="button"
                                    onclick={() => openSubmissionInIntegratedIde(submission)}
                                    class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium"
                                  >
                                    {submission.status === 'PENDING' ? m.ms_da_action_score_ide() : submission.status === 'APPROVED' ? m.ms_da_action_edit_ide() : m.ms_da_action_reeval_ide()}
                                  </button>
                                  {#if submission.status === 'PENDING'}
                                    <button
                                      type="button"
                                      onclick={() => rejectSubmission(submission.id)}
                                      class="px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-700 text-xs font-medium"
                                    >
                                      Rejeter
                                    </button>
                                  {/if}
                                </div>
                              {:else}
                                <span class="text-[10px] text-on-surface-variant">Aucune action</span>
                              {/if}
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </div>
              {/if}
            {/if}
          </div>

          {#if globalLeaderboard?.submissions?.length > 0}
            <div class="premium-card p-8 rounded-xl border-sky-500/10 bg-sky-500/5 space-y-6">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-600 shadow-inner">
                    <Papicon icon="Globe" size={24} />
                  </div>
                  <div>
                    <h4 class="text-lg font-semibold text-on-surface">{m.ms_da_global_leaderboard()}</h4>
                    <p class="text-xs text-on-surface-variant">{m.ms_da_global_leaderboard_subtitle()}</p>
                  </div>
                </div>
                <div class="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-500/10 border border-sky-500/20">
                  <Papicon icon="Server" size={14} class="text-sky-600" />
                  <span class="text-xs font-medium text-sky-700">{m.ms_da_guilds_synced({ n: globalLeaderboard.guildsCount })}</span>
                </div>
              </div>

              <div class="overflow-x-auto rounded-lg border border-sky-500/15 bg-surface/60">
                <table class="w-full text-left">
                  <thead class="bg-sky-500/5 text-sky-800 text-xs font-medium">
                    <tr>
                      <th class="px-6 py-4">{m.ms_da_col_rank()}</th>
                      <th class="px-6 py-4">{m.ms_da_col_user()}</th>
                      <th class="px-6 py-4">{m.ms_da_col_server()}</th>
                      <th class="px-6 py-4 text-center">{m.ms_da_col_average()}</th>
                      <th class="px-6 py-4 text-right">{m.ms_da_col_points()}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-sky-500/5">
                    {#each globalLeaderboard.submissions.slice(0, 10) as sub, i}
                      <tr class="hover:bg-sky-500/5 transition-colors">
                        <td class="px-6 py-4">
                          <span class="w-6 h-6 flex items-center justify-center rounded-lg font-semibold text-xs {i === 0 ? 'bg-amber-400 text-amber-900' : i === 1 ? 'bg-slate-300 text-slate-800' : i === 2 ? 'bg-amber-700/30 text-amber-900' : 'text-on-surface-variant'}">
                            {i + 1}
                          </span>
                        </td>
                        <td class="px-6 py-4">
                          <div class="flex items-center gap-3">
                            <img src={memberAvatarSrc(sub.avatarUrl, sub.displayName, sub.userId)} alt="" class="w-8 h-8 rounded-full border border-sky-500/20" />
                            <span class="font-bold text-on-surface">{sub.displayName}</span>
                          </div>
                        </td>
                        <td class="px-6 py-4">
                          <span class="text-xs font-medium text-on-surface-variant">{sub.guildName}</span>
                        </td>
                        <td class="px-6 py-4 text-center">
                          <span class="text-xs font-semibold text-sky-700">{sub.scoreFinal}/5</span>
                        </td>
                        <td class="px-6 py-4 text-right">
                          <span class="text-sm font-semibold text-sky-900">{sub.totalPoints} pts</span>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}

          <div class="premium-card p-8 rounded-xl space-y-6">
            <h4 class="text-lg font-semibold text-on-surface">{m.ms_da_section23_title()}</h4>

            <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
              <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low p-4 space-y-4">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">{m.ms_da_mini_calendar_title()}</p>
                  <span class="text-[10px] font-bold text-on-surface-variant">{m.ms_da_dates_shown_count({ n: dailyAlgoUpcomingRuns.length })}</span>
                </div>
                {#if isFetchingAlgoSchedule || isEnsuringAlgoSchedule}
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {#each Array(6) as _}
                      <article class="rounded-xl border border-outline-variant/25 bg-surface px-3 py-3 space-y-2">
                        <div class="flex items-center justify-between gap-2">
                          <Skeleton width="w-24" height="h-3" rounded="rounded-md" />
                          <Skeleton width="w-16" height="h-3" rounded="rounded-md" />
                        </div>
                        <Skeleton width="w-full" height="h-4" rounded="rounded-lg" />
                        <div class="flex flex-wrap items-center gap-1.5">
                          <Skeleton width="w-16" height="h-3" rounded="rounded-md" />
                          <Skeleton width="w-20" height="h-3" rounded="rounded-md" />
                          <Skeleton width="w-12" height="h-3" rounded="rounded-md" />
                        </div>
                      </article>
                    {/each}
                  </div>
                {:else if dailyAlgoUpcomingRuns.length === 0}
                  <div class="rounded-xl border border-outline-variant/20 bg-surface px-3 py-3 text-xs text-on-surface-variant">
                    {m.ms_da_no_future_date()}
                  </div>
                {:else}
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {#each dailyAlgoUpcomingRuns.slice(0, 14) as run}
                      <article class="rounded-xl border border-outline-variant/25 bg-surface px-3 py-3 space-y-1">
                        <div class="flex items-center justify-between gap-2">
                          <p class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                            {historyDateLabel(run.dateKey)}
                          </p>
                          <span class="px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-[0.08em] {run.status === 'today'
 ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
                            : 'border-sky-500/25 bg-sky-500/10 text-sky-700'}">
                            {run.status === 'today' ? m.ms_da_today() : m.ms_da_scheduled()}
                          </span>
                        </div>
                        <p class="text-sm font-semibold text-on-surface line-clamp-1">{run.problem?.title ?? m.ms_da_unknown_exercise()}</p>
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="px-2 py-0.5 rounded-md border border-outline-variant/20 bg-surface-container-low text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                            {difficultyLabel(run.problem?.difficulty ?? 'moyen')}
                          </span>
                          <span class="px-2 py-0.5 rounded-md border border-sky-500/25 bg-sky-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700">
                            {dailyAlgoChallengeTypeLabel(run.challengeType)}
                          </span>
                          <span class="px-2 py-0.5 rounded-md border border-outline-variant/20 bg-surface-container-low text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                            {run.submissionsCount ?? 0} soum.
                          </span>
                        </div>
                      </article>
                    {/each}
                  </div>
                {/if}
              </div>

              <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low p-4 space-y-3">
                <p class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">{m.ms_da_recent_history()}</p>
                {#if isFetchingAlgoHistory}
                  <div class="space-y-2 max-h-72 overflow-auto pr-1">
                    {#each Array(5) as _}
                      <div class="rounded-lg border border-outline-variant/20 bg-surface px-3 py-2 space-y-2">
                        <Skeleton width="w-20" height="h-3" />
                        <Skeleton width="w-full" height="h-3" />
                        <Skeleton width="w-32" height="h-2" />
                      </div>
                    {/each}
                  </div>
                {:else if dailyAlgoHistory.length === 0}
                  <p class="text-xs text-on-surface-variant">{m.ms_da_no_history_yet()}</p>
                {:else}
                  <div class="space-y-2 max-h-72 overflow-auto pr-1">
                    {#each dailyAlgoHistory.slice(0, 8) as run}
                      <div class="rounded-lg border border-outline-variant/20 bg-surface px-3 py-2">
                        <p class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{historyDateLabel(run.dateKey)}</p>
                        <p class="text-xs font-bold text-on-surface line-clamp-1 mt-0.5">{run.problem.title}</p>
                        <p class="text-[10px] text-on-surface-variant mt-1">{m.ms_da_history_stats_line({ total: run.stats.total, approved: run.stats.approved, rejected: run.stats.rejected })}</p>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>

            <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low p-4 space-y-4">
              <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  {#each [
                    { value: 'ALL', label: 'Tous' },
                    { value: 'AVAILABLE', label: 'Disponibles' },
                    { value: 'USED', label: m.ms_da_filter_used() },
                  ] as mode}
                    <button
                      type="button"
                      onclick={() => (dailyAlgoLibraryMode = mode.value as 'ALL' | 'AVAILABLE' | 'USED')}
                      class="px-3 py-1.5 rounded-lg border text-[10px] font-semibold uppercase tracking-wide transition-colors {dailyAlgoLibraryMode === mode.value
 ? 'bg-primary text-on-primary border-primary'
                        : 'bg-surface text-on-surface-variant border-outline-variant/30 hover:text-on-surface'}"
                    >
                      {mode.label}
                    </button>
                  {/each}
                </div>
                <input
                  type="search"
                  bind:value={dailyAlgoLibrarySearch}
                  placeholder={m.ms_da_search_placeholder()}
                  class="w-full lg:max-w-lg rounded-xl border border-outline-variant/30 bg-surface px-4 py-2 text-sm text-on-surface outline-none focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                />
              </div>

              {#if isFetchingAlgo}
                <div class="p-8 text-center text-sm font-bold text-on-surface-variant/50 animate-pulse">
                  Chargement des exercices...
                </div>
              {:else if filteredDailyAlgoLibrary.length === 0}
                <div class="p-8 rounded-xl border border-outline-variant/20 bg-surface text-sm text-on-surface-variant">
                  Aucun exercice ne correspond au filtre actuel.
                </div>
              {:else}
                <div class="overflow-x-auto rounded-lg border border-outline-variant/15 bg-surface">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_real_date()}</th>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_exercise()}</th>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_difficulty()}</th>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_type()}</th>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_languages()}</th>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_tests()}</th>
                        <th class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">{m.ms_da_col_actions()}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each filteredDailyAlgoLibrary as problem}
                        <tr>
                          <td>
                            {#if dailyAlgoPlannedDateForProblem(problem.id)}
                              {#if (dailyAlgoPlannedDateForProblem(problem.id) || '') === todayDateKey}
                                <span class="inline-flex px-2 py-0.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">{m.ms_da_today()}</span>
                              {:else if (dailyAlgoPlannedDateForProblem(problem.id) || '') > todayDateKey}
                                <span class="inline-flex px-2 py-0.5 rounded-md border border-sky-500/25 bg-sky-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700">{m.ms_da_scheduled()}</span>
                              {:else}
                                <span class="inline-flex px-2 py-0.5 rounded-md border border-slate-500/25 bg-slate-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-700">{m.ms_da_played()}</span>
                              {/if}
                              <p class="mt-1 text-[11px] font-bold text-on-surface-variant">{historyDateLabel(dailyAlgoPlannedDateForProblem(problem.id) || '')}</p>
                            {:else if problem.usedAt}
                              <span class="inline-flex px-2 py-0.5 rounded-md border border-slate-500/25 bg-slate-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-700">{m.ms_da_played()}</span>
                              <p class="mt-1 text-[11px] font-bold text-on-surface-variant">{formatDate(problem.usedAt)}</p>
                            {:else}
                              <span class="inline-flex px-2 py-0.5 rounded-md border border-amber-500/25 bg-amber-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700">{m.ms_da_backlog()}</span>
                              <p class="mt-1 text-[11px] font-bold text-on-surface-variant">{m.ms_da_status_pending()}</p>
                            {/if}
                          </td>
                          <td>
                            <p class="text-sm font-semibold text-on-surface">{problem.title}</p>
                            <p class="text-[11px] font-mono text-on-surface-variant mt-1 line-clamp-1">{dailyAlgoProblemFunctionSignature(problem)}</p>
                          </td>
                          <td>
                            <span class="inline-flex px-2.5 py-1 rounded-lg border text-[10px] font-semibold uppercase tracking-wide {problem.difficulty === 'facile' ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20' : problem.difficulty === 'moyen' ? 'bg-amber-500/10 text-amber-700 border-amber-500/20' : 'bg-red-500/10 text-red-700 border-red-500/20'}">
                              {difficultyLabel(problem.difficulty)}
                            </span>
                          </td>
                          <td>
                            <span class="inline-flex px-2 py-0.5 rounded-md border border-outline-variant/20 bg-surface-container-low text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                              {dailyAlgoChallengeTypeLabel(dailyAlgoDetectChallengeTypeKey(problem.title, problem.description))}
                            </span>
                          </td>
                          <td>
                            {#if dailyAlgoProblemAllowedLanguages(problem).length === 0}
                              <span class="px-2 py-0.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
                                Libre
                              </span>
                            {:else}
                              <div class="flex flex-wrap gap-1">
                                {#each dailyAlgoProblemAllowedLanguages(problem) as lang}
                                  <span class="px-2 py-0.5 rounded-md border border-outline-variant/25 bg-surface text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                                    {lang}
                                  </span>
                                {/each}
                              </div>
                            {/if}
                          </td>
                          <td>
                            <p class="text-xs font-semibold text-emerald-700">{Array.isArray(problem.unitTests) ? problem.unitTests.length : 0}</p>
                          </td>
                          <td>
                            {#if canManageSettings}
                              <div class="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onclick={() => openDailyAlgoProblemEditModal(problem)}
                                  class="px-3 py-1.5 rounded-lg border border-outline-variant/30 bg-surface text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
                                >
                                  Éditer
                                </button>
                                <button
                                  type="button"
                                  onclick={() => setProblemAsToday(problem.id)}
                                  disabled={switchingTodayProblemId === problem.id || deletingDailyAlgoProblemId === problem.id || todayRunProblemId === problem.id}
                                  class="px-3 py-1.5 rounded-lg border text-[10px] font-semibold uppercase tracking-wide disabled:opacity-50 disabled:cursor-not-allowed {todayRunProblemId === problem.id
 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
                                    : 'border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20'}"
                                >
                                  {todayRunProblemId === problem.id ? m.ms_da_today_exercise() : m.ms_da_set_as_today()}
                                </button>
                                <button
                                  type="button"
                                  onclick={() => deleteDailyAlgoProblemFromLibrary(problem)}
                                  disabled={deletingDailyAlgoProblemId === problem.id || switchingTodayProblemId === problem.id}
                                  class="px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-700 text-[10px] font-semibold uppercase tracking-wide hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  Supprimer
                                </button>
                              </div>
                            {:else}
                              <span class="text-[10px] text-on-surface-variant">Lecture seule</span>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          </div>
        </section>
      {:else}
        <section class="space-y-8">
            <h3 class="text-xl font-semibold tracking-tight flex items-center gap-4">
              <div class="w-1.5 h-8 bg-primary rounded-full"></div>
              {m.ms_module_settings_title()}
            </h3>
            <div class="premium-card p-10 rounded-xl space-y-8">
              <div class="flex items-center justify-between gap-6 p-6 rounded-lg bg-surface-container-low border border-outline-variant/20">
                <div>
                  <p class="text-sm font-semibold text-on-surface">{m.ms_module_activation()}</p>
                  <p class="text-xs text-on-surface-variant/70 mt-1">{m.ms_module_activation_desc()}</p>
                </div>
                <ToggleSwitch
                  checked={desiredModuleStatus === 'active'}
                  disabled={!canManageSettings}
                  onToggle={() => (desiredModuleStatus = desiredModuleStatus === 'active' ? 'inactive' : 'active')}
                />
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <button
                  onclick={() => router.goto('/management')}
                  disabled={!canManageSettings}
                  class="px-5 py-4 rounded-lg border border-outline-variant/30 bg-surface-container-low text-sm font-semibold uppercase tracking-wider text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all"
                >
                  {m.ms_open_global_settings()}
                </button>
                <button
                  onclick={() => router.goto('/activity')}
                  class="px-5 py-4 rounded-lg border border-outline-variant/30 bg-surface-container-low text-sm font-semibold uppercase tracking-wider text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all"
                >
                  {m.ms_view_recent_activity()}
                </button>
              </div>
            </div>
        </section>
      {/if}
    </div>
  </div>
</div>

{#if dailyAlgoApiModalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="dailyalgo-api-title" tabindex="-1" onclick={closeDailyAlgoApiModal}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dailyalgo-api-popover" onclick={(event) => event.stopPropagation()}>
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">{m.ms_da_label()}</p>
          <h3 id="dailyalgo-api-title" class="mt-1 text-lg font-semibold text-on-surface">{m.ms_da_external_api_config()}</h3>
          <p class="mt-1 text-xs text-on-surface-variant">
            {m.ms_da_api_key_subtitle()}
          </p>
        </div>
        <button
          type="button"
          onclick={closeDailyAlgoApiModal}
          class="p-2 rounded-lg border border-outline-variant/30 text-on-surface-variant hover:text-on-surface"
          aria-label={m.ms_da_close_api_config()}
        >
          <Papicon icon="close" size={16} />
        </button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low p-4 space-y-4">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[10px] uppercase tracking-[0.16em] font-semibold text-on-surface-variant/70">{m.ms_da_key_management()}</p>
            <RefreshButton
              onClick={loadMyApiKeys}
              loading={isFetchingApiKeys}
              label={m.common_refresh()}
              className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide rounded-lg bg-surface border border-outline-variant/20 text-on-surface-variant"
              iconClass="text-sm"
            />
          </div>

          <label for="dailyalgo-api-key-name" class="text-[10px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant/70">
            {m.ms_da_key_name()}
          </label>
          <input
            id="dailyalgo-api-key-name"
            type="text"
            bind:value={dailyAlgoApiKeyName}
            placeholder="Kotbo Daily Algo"
            class="w-full rounded-xl border border-outline-variant/30 bg-surface px-4 py-2 text-sm text-on-surface outline-none focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          />

          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="px-4 py-2 rounded-xl bg-emerald-600 text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-emerald-700 disabled:opacity-60"
              onclick={createOrResetMyApiKey}
              disabled={!canManageSettings || apiKeyAction.state.loading}
            >
              {currentApiKey ? m.ms_da_reset_api_key() : m.ms_da_create_api_key()}
            </button>

            {#if currentApiKey}
              <button
                type="button"
                class="px-4 py-2 rounded-xl border border-red-500/30 bg-red-500/10 text-red-700 text-[10px] font-semibold uppercase tracking-wide hover:bg-red-500/20 disabled:opacity-60"
                onclick={() => deleteCurrentApiKey(currentApiKey.id)}
                disabled={!canManageSettings || apiKeyAction.state.loading}
              >
                {m.ms_da_disable()}
              </button>
            {/if}
          </div>

          <InlineFeedback message={apiKeyAction.state.message} error={apiKeyAction.state.error} />

          <div class="space-y-2 rounded-xl border border-outline-variant/20 bg-surface px-4 py-3">
            <p class="text-[10px] uppercase tracking-[0.16em] font-semibold text-on-surface-variant/70">{m.ms_da_active_key()}</p>
            <p class="text-sm font-mono text-on-surface">{currentApiKey?.displayKey ?? m.ms_da_no_active_key()}</p>
            {#if currentApiKey?.lastUsedAt}
              <p class="text-[11px] text-on-surface-variant">{m.ms_da_last_used({ date: formatDate(currentApiKey.lastUsedAt) })}</p>
            {/if}
          </div>

          {#if latestIssuedApiKey}
            <div class="space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <p class="text-[10px] uppercase tracking-[0.16em] font-semibold text-emerald-700">{m.ms_da_new_key_visible_once()}</p>
              <p class="text-sm font-mono text-emerald-800 break-all">{latestIssuedApiKey}</p>
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg border border-emerald-600/30 bg-white text-emerald-700 text-[10px] font-semibold uppercase tracking-wide hover:bg-emerald-50"
                onclick={() => copyToClipboard(latestIssuedApiKey, m.ms_da_api_key_copied())}
              >
                {m.ms_da_copy_key()}
              </button>
            </div>
          {/if}
        </div>

        <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low p-4 space-y-4">
          <div>
            <p class="text-[10px] uppercase tracking-[0.16em] font-semibold text-on-surface-variant/70">{m.ms_da_mini_doc_title()}</p>
            <p class="mt-1 text-xs text-on-surface-variant break-all">Guild ID: {selectedGuildId || m.ms_da_no_guild_selected()}</p>
          </div>

          <div class="space-y-2">
            <p class="text-[10px] uppercase tracking-[0.16em] font-semibold text-on-surface-variant/70">{m.ms_da_base_url()}</p>
            <div class="rounded-lg border border-outline-variant/20 bg-surface px-3 py-2 text-xs font-mono break-all">
              {dailyAlgoPublicApiProblemsUrl || m.ms_da_select_guild_for_url()}
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-[10px] uppercase tracking-[0.16em] font-semibold text-on-surface-variant/70">{m.ms_da_curl_examples()}</p>
            <pre class="rounded-lg border border-outline-variant/20 bg-surface px-3 py-2 text-[11px] font-mono overflow-auto">{apiDocGetCurl}</pre>
            <pre class="rounded-lg border border-outline-variant/20 bg-surface px-3 py-2 text-[11px] font-mono overflow-auto">{apiDocPostCurl}</pre>
            <pre class="rounded-lg border border-outline-variant/20 bg-surface px-3 py-2 text-[11px] font-mono overflow-auto">{apiDocPatchCurl}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if ideModalOpen && focusedSubmission}
  <div class="modal-backdrop dailyalgo-ide-overlay" role="dialog" aria-modal="true" aria-labelledby="dailyalgo-ide-title" tabindex="-1">
    <div class="modal-panel modal-panel-dailyalgo-ide">
      <div class="dailyalgo-ide-menubar">
        <div class="dailyalgo-ide-window-controls">
          <span class="dot red"></span>
          <span class="dot amber"></span>
          <span class="dot green"></span>
        </div>
        <p id="dailyalgo-ide-title" class="dailyalgo-ide-menubar-title">
          Review: {focusedSubmission.authorName}
        </p>
        <button
          type="button"
          onclick={closeIntegratedIde}
          class="dailyalgo-ide-close"
          aria-label={m.ms_da_close_integrated_ide()}
        >
          <Papicon icon="close" size={16} />
        </button>
      </div>

      <div class="dailyalgo-ide-modal-grid">
        <section class="dailyalgo-ide-editor-pane">
          <div class="dailyalgo-ide-context-strip">
            <span>Challenge: {dailyAlgoToday?.run?.problem?.title ?? 'Daily Algo'}</span>
            <span class="dot">•</span>
            <span>{submissionStatusMeta(focusedSubmission.status).label}</span>
            <span class="dot">•</span>
            <span>Score: {focusedSubmission.scoreFinal ?? '-'}/5</span>
            <span class="dot">•</span>
            <span>Total: {focusedSubmission.totalPoints ?? '-'} pts</span>
            <span class="dot">•</span>
            <span>{m.ms_da_submitted_at({ date: formatDate(focusedSubmission.submittedAt) })}</span>
          </div>
          <div class="dailyalgo-ide-host">
            <DailyAlgoMiniIDE
              initialCode={focusedSubmission?.solution ?? undefined}
              initialLanguage={ideLanguageForSubmission(focusedSubmission)}
              allowedLanguages={dailyAlgoProblemAllowedIdeLanguages(dailyAlgoToday?.run?.problem)}
              functionName={typeof dailyAlgoToday?.run?.problem?.functionName === 'string' ? dailyAlgoToday.run.problem.functionName : ''}
              functionArgs={Array.isArray(dailyAlgoToday?.run?.problem?.functionArgs) ? dailyAlgoToday.run.problem.functionArgs : []}
              unitTests={Array.isArray(dailyAlgoToday?.run?.problem?.unitTests) ? dailyAlgoToday.run.problem.unitTests : []}
              languagePersistenceKey={`submission:${focusedSubmission.id}`}
              height="100%"
              showPopoutButton={false}
              fileLabel={focusedSubmission.authorName?.replace(/\s+/g, '-').toLowerCase() || 'solution'}
            />
          </div>
        </section>

        <aside class="dailyalgo-ide-score-panel">
          <h4 class="text-[11px] font-semibold uppercase tracking-[0.14em] text-on-surface-variant">{m.ms_da_review_panel()}</h4>

          {#if canModerateDailyAlgo && (focusedSubmission.status === 'PENDING' || focusedSubmission.status === 'APPROVED' || focusedSubmission.status === 'REJECTED')}
            <div class="grid grid-cols-2 gap-3">
              <label class="text-[11px] font-bold text-on-surface-variant space-y-1" for={`modal-score-correctness-${focusedSubmission.id}`}>
                Correctitude
                <input
                  id={`modal-score-correctness-${focusedSubmission.id}`}
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={scoreDraftBySubmissionId[focusedSubmission.id]?.correctness ?? 5}
                  onchange={(event) => updateSubmissionScore(focusedSubmission.id, 'correctness', Number((event.currentTarget as HTMLInputElement).value))}
                  class="w-full px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface text-sm text-on-surface"
                />
              </label>
              <label class="text-[11px] font-bold text-on-surface-variant space-y-1" for={`modal-score-comments-${focusedSubmission.id}`}>
                Commentaires
                <input
                  id={`modal-score-comments-${focusedSubmission.id}`}
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={scoreDraftBySubmissionId[focusedSubmission.id]?.comments ?? 5}
                  onchange={(event) => updateSubmissionScore(focusedSubmission.id, 'comments', Number((event.currentTarget as HTMLInputElement).value))}
                  class="w-full px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface text-sm text-on-surface"
                />
              </label>
              <label class="text-[11px] font-bold text-on-surface-variant space-y-1" for={`modal-score-compactness-${focusedSubmission.id}`}>
                {m.ms_da_score_compactness()}
                <input
                  id={`modal-score-compactness-${focusedSubmission.id}`}
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={scoreDraftBySubmissionId[focusedSubmission.id]?.compactness ?? 5}
                  onchange={(event) => updateSubmissionScore(focusedSubmission.id, 'compactness', Number((event.currentTarget as HTMLInputElement).value))}
                  class="w-full px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface text-sm text-on-surface"
                />
              </label>
              <label class="text-[11px] font-bold text-on-surface-variant space-y-1" for={`modal-score-optimization-${focusedSubmission.id}`}>
                Optimisation
                <input
                  id={`modal-score-optimization-${focusedSubmission.id}`}
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={scoreDraftBySubmissionId[focusedSubmission.id]?.optimization ?? 5}
                  onchange={(event) => updateSubmissionScore(focusedSubmission.id, 'optimization', Number((event.currentTarget as HTMLInputElement).value))}
                  class="w-full px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface text-sm text-on-surface"
                />
              </label>
              <label class="text-[11px] font-bold text-on-surface-variant space-y-1 col-span-2" for={`modal-score-readability-${focusedSubmission.id}`}>
                {m.ms_da_score_readability()}
                <input
                  id={`modal-score-readability-${focusedSubmission.id}`}
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  value={scoreDraftBySubmissionId[focusedSubmission.id]?.readability ?? 5}
                  onchange={(event) => updateSubmissionScore(focusedSubmission.id, 'readability', Number((event.currentTarget as HTMLInputElement).value))}
                  class="w-full px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface text-sm text-on-surface"
                />
              </label>
            </div>

            <div class="space-y-2">
              <label class="text-[11px] font-bold text-on-surface-variant space-y-1" for={`modal-score-feedback-${focusedSubmission.id}`}>
                {m.ms_da_feedback_label()}
                <textarea
                  id={`modal-score-feedback-${focusedSubmission.id}`}
                  rows="5"
                  maxlength="1000"
                  value={scoreDraftBySubmissionId[focusedSubmission.id]?.feedback ?? ''}
                  oninput={(event) => updateSubmissionFeedback(focusedSubmission.id, (event.currentTarget as HTMLTextAreaElement).value)}
                  class="w-full px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface text-sm text-on-surface"
                  placeholder={m.ms_da_feedback_placeholder()}
                ></textarea>
              </label>
              {#if [scoreDraftBySubmissionId[focusedSubmission.id]?.correctness ?? 5, scoreDraftBySubmissionId[focusedSubmission.id]?.comments ?? 5, scoreDraftBySubmissionId[focusedSubmission.id]?.compactness ?? 5, scoreDraftBySubmissionId[focusedSubmission.id]?.optimization ?? 5, scoreDraftBySubmissionId[focusedSubmission.id]?.readability ?? 5].some((score) => score < 5)}
                <p class="text-[10px] font-bold text-amber-700">{m.ms_da_feedback_required_notice()}</p>
              {/if}
            </div>

            <div class="dailyalgo-ide-score-actions">
              <p class="text-xs font-semibold text-emerald-700">{m.ms_da_average_score({ n: reviewAverage(focusedSubmission.id) })}</p>
              <div class="flex items-center gap-2">
                {#if focusedSubmission.status === 'PENDING'}
                  <button
                    type="button"
                    onclick={() => rejectSubmission(focusedSubmission.id)}
                    class="px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-700 text-[10px] font-semibold uppercase tracking-wide"
                  >
                    Rejeter
                  </button>
                {/if}
                <button
                  type="button"
                  onclick={() => approveSubmission(focusedSubmission.id)}
                  class="px-4 py-2 rounded-lg bg-emerald-700 text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-emerald-800"
                >
                  {focusedSubmission.status === 'PENDING' ? m.ms_da_confirm_validation() : focusedSubmission.status === 'APPROVED' ? m.ms_da_save_changes() : m.ms_da_validate_reeval()}
                </button>
              </div>
            </div>
          {:else}
            <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low p-3 text-xs text-on-surface-variant">
              {m.ms_da_readonly_for_role()}
            </div>
          {/if}
        </aside>
      </div>
    </div>
  </div>
{/if}



{#if createDailyAlgoProblemModalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="dailyalgo-create-title" tabindex="-1" onclick={closeDailyAlgoProblemModal}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-panel modal-panel-lg space-y-5" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">{m.ms_da_label()}</p>
          <h3 id="dailyalgo-create-title" class="mt-1 text-xl font-semibold text-on-surface">
            {editingDailyAlgoProblemId ? m.ms_da_edit_exercise_title() : m.ms_da_add_new_exercise_title()}
          </h3>
          <p class="mt-1 text-sm text-on-surface-variant">
            {editingDailyAlgoProblemId
              ? m.ms_da_edit_exercise_subtitle()
              : m.ms_da_add_exercise_subtitle()}
          </p>
        </div>
        <button
          type="button"
          onclick={closeDailyAlgoProblemModal}
          class="p-2 rounded-lg border border-outline-variant/30 text-on-surface-variant hover:text-on-surface"
          aria-label={m.common_close()}
        >
          <Papicon icon="close" size={16} />
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="space-y-2">
          <label for="modal-dailyalgo-title" class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">{m.ms_da_field_title()}</label>
          <FormInput
            id="modal-dailyalgo-title"
            bind:value={algoDraft.title}
            className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant/10 rounded-xl text-sm font-semibold outline-none focus:border-emerald-500/40"
            placeholder={m.ms_da_title_placeholder()}
          />
        </div>
        <div class="space-y-2">
          <label for="modal-dailyalgo-difficulty" class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">{m.ms_da_col_difficulty()}</label>
          <select
            id="modal-dailyalgo-difficulty"
            bind:value={algoDraft.difficulty}
            class="w-full px-4 py-3 bg-surface-container-low border border-outline-variant/10 rounded-xl text-sm font-semibold outline-none focus:border-emerald-500/40 text-on-surface appearance-none"
          >
            <option value="facile">{m.ms_da_difficulty_easy()}</option>
            <option value="moyen">{m.ms_da_difficulty_medium()}</option>
            <option value="difficile">{m.ms_da_difficulty_hard()}</option>
          </select>
        </div>
        <div class="space-y-2 md:col-span-2">
          <label for="modal-dailyalgo-function-name" class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">{m.ms_da_function_name_label()}</label>
          <FormInput
            id="modal-dailyalgo-function-name"
            bind:value={algoDraft.functionName}
            className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant/10 rounded-xl text-sm font-mono outline-none focus:border-emerald-500/40"
            placeholder="ex: reverseString"
          />
        </div>
        <div class="space-y-2 md:col-span-2">
          <p class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">{m.ms_da_allowed_languages_label()}</p>
          <div class="rounded-lg border border-outline-variant/15 bg-surface-container-low p-4 space-y-3">
            <div class="flex flex-wrap gap-2">
              {#if algoDraft.allowedLanguages.length === 0}
                <span class="px-2.5 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  {m.ms_da_free_language()}
                </span>
              {:else}
                {#each algoDraft.allowedLanguages as lang}
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-outline-variant/25 bg-surface text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                    {lang}
                    <button
                      type="button"
                      onclick={() => removeDraftAllowedLanguage(lang)}
                      class="w-4 h-4 rounded-full bg-surface-container-high text-on-surface-variant hover:text-on-surface leading-none"
                      aria-label={m.ms_da_remove_lang({ lang })}
                    >
                      ×
                    </button>
                  </span>
                {/each}
              {/if}
            </div>

            <div class="flex flex-col md:flex-row gap-2">
              <input
                type="text"
                bind:value={algoDraft.languageInput}
                onkeydown={handleLanguageInputKeydown}
                class="flex-1 px-3 py-2 rounded-xl border border-outline-variant/20 bg-surface text-sm text-on-surface outline-none focus:border-emerald-500/40"
                placeholder={m.ms_da_add_language_placeholder()}
              />
              <button
                type="button"
                onclick={addDraftAllowedLanguage}
                class="px-4 py-2 rounded-xl bg-emerald-600 text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-emerald-700"
              >
                {m.common_add()}
              </button>
              <button
                type="button"
                onclick={enableFreeLanguageMode}
                class="px-4 py-2 rounded-xl border border-outline-variant/30 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant hover:text-on-surface hover:bg-surface"
              >
                {m.ms_da_free_mode()}
              </button>
            </div>

            <div class="flex flex-wrap gap-2">
              {#each dailyAlgoLanguageSuggestions as suggestion}
                <button
                  type="button"
                  onclick={() => addSuggestedLanguage(suggestion)}
                  class="px-2.5 py-1 rounded-lg border border-outline-variant/25 bg-surface text-xs font-medium text-on-surface-variant hover:text-on-surface"
                >
                  {suggestion}
                </button>
              {/each}
            </div>

            <p class="text-[11px] text-on-surface-variant">
              {m.ms_da_languages_hint()}
            </p>
          </div>
        </div>
        <div class="space-y-2 md:col-span-2">
          <label for="modal-dailyalgo-description" class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">{m.ms_da_description_markdown_label()}</label>
          <textarea
            id="modal-dailyalgo-description"
            bind:value={algoDraft.description}
            class="w-full px-4 py-3 bg-surface-container-low border border-outline-variant/10 rounded-xl text-sm font-mono outline-none focus:border-emerald-500/40 min-h-30"
            placeholder={m.ms_da_description_placeholder()}
          ></textarea>
        </div>
        <div class="space-y-2 md:col-span-2">
          <div class="flex items-center justify-between gap-3">
            <p class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">{m.ms_da_function_args_label()}</p>
            <button
              type="button"
              onclick={addFunctionArg}
              class="px-3 py-1.5 rounded-lg bg-surface border border-outline-variant/25 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
            >
              {m.ms_da_add_argument()}
            </button>
          </div>
          <div class="rounded-lg border border-outline-variant/15 bg-surface-container-low p-4 space-y-3">
            {#if algoDraft.functionArgs.length === 0}
              <p class="text-xs text-on-surface-variant">{m.ms_da_no_argument_hint()}</p>
            {:else}
              {#each algoDraft.functionArgs as arg, argIndex}
                <div class="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2 items-center">
                  <input
                    type="text"
                    value={arg.name}
                    oninput={(event) => updateFunctionArgName(argIndex, (event.currentTarget as HTMLInputElement).value)}
                    class="px-3 py-2 rounded-xl border border-outline-variant/20 bg-surface text-sm text-on-surface outline-none focus:border-emerald-500/40"
                    placeholder={`arg${argIndex + 1}`}
                  />
                  <input
                    type="text"
                    value={arg.type}
                    oninput={(event) => updateFunctionArgType(argIndex, (event.currentTarget as HTMLInputElement).value)}
                    class="px-3 py-2 rounded-xl border border-outline-variant/20 bg-surface text-sm text-on-surface outline-none focus:border-emerald-500/40"
                    placeholder="string | number | array | object..."
                  />
                  <button
                    type="button"
                    onclick={() => removeFunctionArg(argIndex)}
                    class="px-3 py-2 rounded-xl border border-red-500/20 bg-red-500/10 text-[10px] font-semibold uppercase tracking-wide text-red-700 hover:bg-red-500/20"
                  >
                    {m.common_delete()}
                  </button>
                </div>
              {/each}
            {/if}
          </div>
        </div>
        <div class="space-y-2 md:col-span-2">
          <div class="flex items-center justify-between gap-3">
            <p class="text-[10px] font-semibold text-on-surface-variant/40 uppercase tracking-wider">Tests unitaires</p>
            <button
              type="button"
              onclick={addUnitTest}
              class="px-3 py-1.5 rounded-lg bg-surface border border-outline-variant/25 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
            >
              {m.ms_da_add_test()}
            </button>
          </div>
          <div class="rounded-lg border border-outline-variant/15 bg-surface-container-low p-4 space-y-3">
            {#if algoDraft.unitTests.length === 0}
              <p class="text-xs text-on-surface-variant">{m.ms_da_no_test_defined()}</p>
            {:else}
              {#each algoDraft.unitTests as test, testIndex}
                <div class="rounded-xl border border-outline-variant/20 bg-surface p-3 space-y-3">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <input
                      type="text"
                      value={test.name}
                      oninput={(event) => updateUnitTestName(testIndex, (event.currentTarget as HTMLInputElement).value)}
                      class="flex-1 min-w-55 px-3 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-low text-sm text-on-surface outline-none focus:border-emerald-500/40"
                      placeholder={`Cas ${testIndex + 1}`}
                    />
                    <button
                      type="button"
                      onclick={() => removeUnitTest(testIndex)}
                      class="px-3 py-2 rounded-xl border border-red-500/20 bg-red-500/10 text-[10px] font-semibold uppercase tracking-wide text-red-700 hover:bg-red-500/20"
                    >
                      {m.common_delete()}
                    </button>
                  </div>

                  {#if algoDraft.functionArgs.length === 0}
                    <p class="text-[11px] text-on-surface-variant">{m.ms_da_no_argument_run_hint()}</p>
                  {:else}
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {#each algoDraft.functionArgs as arg, argIndex}
                        <label class="space-y-1">
                          <span class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant/60">{arg.name || `arg${argIndex + 1}`}</span>
                          <input
                            type="text"
                            value={test.argValues[argIndex] ?? 'null'}
                            oninput={(event) => updateUnitTestArgValue(testIndex, argIndex, (event.currentTarget as HTMLInputElement).value)}
                            class="w-full px-3 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-low text-sm font-mono text-on-surface outline-none focus:border-emerald-500/40"
                            placeholder={'"hello" | 123 | true | [1,2] | {"k":"v"}'}
                          />
                        </label>
                      {/each}
                    </div>
                  {/if}

                  <label class="space-y-1">
                    <span class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant/60">{m.ms_da_expected_value()}</span>
                    <input
                      type="text"
                      value={test.expectedValue}
                      oninput={(event) => updateUnitTestExpectedValue(testIndex, (event.currentTarget as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-low text-sm font-mono text-on-surface outline-none focus:border-emerald-500/40"
                      placeholder={'"olleh" | 42 | false | null | {"ok":true}'}
                    />
                  </label>
                </div>
              {/each}
            {/if}
          </div>
          <p class="text-[11px] text-on-surface-variant">{m.ms_da_json_values_hint()}</p>
        </div>
      </div>

      {#if formAction.state.error}
        <div class="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-700">
          {formAction.state.error}
        </div>
      {:else if formAction.state.message}
        <div class="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-700">
          {formAction.state.message}
        </div>
      {/if}

      <div class="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onclick={closeDailyAlgoProblemModal}
          class="px-4 py-2 rounded-xl border border-outline-variant/30 text-xs font-semibold uppercase tracking-wide text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low"
        >
          {m.common_cancel()}
        </button>
        <button
          type="button"
          onclick={submitDailyAlgoProblem}
          disabled={formAction.state.loading}
          class="px-5 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold uppercase tracking-wide shadow-sm hover:bg-emerald-700"
        >
          {formAction.state.loading
            ? (editingDailyAlgoProblemId ? m.ms_da_saving() : m.ms_da_adding())
            : (editingDailyAlgoProblemId ? m.ms_da_save_changes() : m.ms_da_add_exercise_short())}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

  .dailyalgo-api-popover {
    width: min(980px, calc(100vw - 1.5rem));
    max-height: calc(100vh - 1.5rem);
    margin: 0.75rem 0.75rem 0 auto;
    border-radius: 1.4rem;
    border: 1px solid var(--outline-variant);
    background: color-mix(in srgb, var(--surface-container) 92%, transparent);
    box-shadow:
      0 24px 55px rgba(0, 0, 0, 0.28),
      inset 0 1px 0 color-mix(in srgb, var(--surface) 55%, transparent);
    padding: 1rem;
    overflow: auto;
  }

  .dailyalgo-ide-overlay {
    inset: 0;
    padding: 0;
    align-items: stretch;
    justify-content: stretch;
    background: rgba(2, 6, 23, 0.72);
  }

  .modal-panel-dailyalgo-ide {
    width: 100vw;
    height: 100vh;
    max-width: none;
    max-height: none;
    margin: 0;
    border-radius: 0;
    border: none;
    padding: 0;
    background: var(--background);
    color: var(--on-surface);
    overflow: hidden;
    box-shadow: none;
    display: flex;
    flex-direction: column;
  }

  .dailyalgo-ide-menubar {
    height: 44px;
    padding: 0 0.9rem;
    border-bottom: 1px solid var(--outline-variant);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--surface-container-high) 84%, transparent),
      color-mix(in srgb, var(--surface-container-low) 92%, transparent)
    );
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .dailyalgo-ide-window-controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .dailyalgo-ide-window-controls .dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--outline) 70%, black 30%);
  }

  .dailyalgo-ide-window-controls .dot.red { background: #f87171; }
  .dailyalgo-ide-window-controls .dot.amber { background: #fbbf24; }
  .dailyalgo-ide-window-controls .dot.green { background: #34d399; }

  .dailyalgo-ide-menubar-title {
    margin: 0;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-primary);
    flex: 1;
  }

  .dailyalgo-ide-close {
    width: 30px;
    height: 30px;
    border-radius: 0.5rem;
    border: 1px solid var(--outline-variant);
    color: var(--on-surface-variant);
    background: var(--surface-container-low);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .dailyalgo-ide-close:hover {
    color: var(--on-surface);
    border-color: color-mix(in srgb, var(--color-error) 45%, transparent);
    background: color-mix(in srgb, var(--color-error) 12%, transparent);
  }

  .dailyalgo-ide-modal-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 350px;
    gap: 0.75rem;
    padding: 0.75rem;
    background:
      radial-gradient(circle at 15% 0%, color-mix(in srgb, var(--color-primary) 18%, transparent), transparent 35%),
      radial-gradient(circle at 85% 10%, color-mix(in srgb, var(--color-secondary) 12%, transparent), transparent 35%),
      var(--background);
  }

  .dailyalgo-ide-editor-pane {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .dailyalgo-ide-host {
    min-height: 0;
    flex: 1;
    display: flex;
  }

  .dailyalgo-ide-host :global(.ide-root) {
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .dailyalgo-ide-context-strip {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-low);
    color: var(--on-surface-variant);
    border-radius: 0.75rem;
    padding: 0.45rem 0.6rem;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .dailyalgo-ide-context-strip .dot {
    opacity: 0.55;
  }

  .dailyalgo-ide-score-panel {
    border: 1px solid var(--outline-variant);
    background: color-mix(in srgb, var(--surface-container-lowest) 88%, transparent);
    border-radius: 0.9rem;
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow: auto;
  }

  .dailyalgo-ide-score-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  @media (max-width: 1500px) {
    .dailyalgo-ide-modal-grid {
      grid-template-columns: minmax(0, 1fr) 320px;
    }
  }

  @media (max-width: 1220px) {
    .dailyalgo-ide-modal-grid {
      grid-template-columns: minmax(0, 1fr) 320px;
    }
  }

  @media (max-width: 920px) {
    .dailyalgo-api-popover {
      width: calc(100vw - 1rem);
      max-height: calc(100vh - 1rem);
      margin: 0.5rem auto;
      border-radius: 1rem;
    }

    .dailyalgo-ide-modal-grid {
      grid-template-columns: minmax(0, 1fr);
      padding: 0.55rem;
      gap: 0.55rem;
    }

    .dailyalgo-ide-score-panel {
      max-height: 42vh;
    }
  }
</style>
