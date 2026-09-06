<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    fetchGlobalBannedWords,
    saveGlobalBannedWords,
    cleanupGlobalBannedWords,
    updateGlobalBannedWord,
    deleteGlobalBannedWord,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import Skeleton from '../../lib/components/Skeleton.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  type BannedWordEntry = {
    id: string;
    word: string;
    category: string;
    enabled: boolean;
    guildId: string | null;
  };

  type ImportDraft = {
    id: string;
    word: string;
    category: string;
    enabled: boolean;
  };

  const BANNED_WORD_CATEGORIES = {
    custom: 'Personnalisé',
    racism: 'Racisme',
    threat: 'Menace',
    sexual: 'Sexuel',
    lgbtphobia: 'LGBTphobie',
    hate: 'Haine',
    insult: 'Insulte',
  } as const;

  const BANNED_WORD_CATEGORY_KEYS = Object.keys(BANNED_WORD_CATEGORIES) as Array<keyof typeof BANNED_WORD_CATEGORIES>;

  let globalBannedWords = $state<BannedWordEntry[]>([]);
  let globalBannedWordsLoading = $state(false);
  let globalBannedWordsLoaded = $state(false);
  let globalBannedWordsError = $state('');
  let globalBannedWordsPage = $state(1);
  let globalImportText = $state('');
  let globalImportFileName = $state('');
  let globalImportDrafts = $state<ImportDraft[]>([]);
  let globalImportError = $state('');
  let globalImportLoading = $state(false);
  let globalWordSavingId = $state('');
  const globalWordSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let globalCleanupLoading = $state(false);
  const GLOBAL_BANNED_WORDS_PAGE_SIZE = 12;

  const globalBannedWordsTotalPages = $derived(
    Math.max(1, Math.ceil(globalBannedWords.length / GLOBAL_BANNED_WORDS_PAGE_SIZE))
  );

  const paginatedGlobalBannedWords = $derived(
    globalBannedWords.slice(
      (globalBannedWordsPage - 1) * GLOBAL_BANNED_WORDS_PAGE_SIZE,
      globalBannedWordsPage * GLOBAL_BANNED_WORDS_PAGE_SIZE
    )
  );

  async function loadGlobalBannedWords() {
    globalBannedWordsLoading = true;
    globalBannedWordsError = '';
    try {
      const data = await fetchGlobalBannedWords();
      globalBannedWords = data.words ?? [];
      globalBannedWordsLoaded = true;
      globalBannedWordsPage = 1;
    } catch (err: any) {
      globalBannedWordsError = err?.message || 'Impossible de charger les mots globaux.';
    } finally {
      globalBannedWordsLoading = false;
    }
  }

  onMount(() => {
    void loadGlobalBannedWords();
  });

  $effect(() => {
    const maxPage = globalBannedWordsTotalPages;
    if (globalBannedWordsPage > maxPage) globalBannedWordsPage = maxPage;
    if (globalBannedWordsPage < 1) globalBannedWordsPage = 1;
  });

  function normalizeGlobalWordValue(value: string) {
    return value.trim().toLowerCase().slice(0, 100);
  }

  function parseGlobalWordRows(text: string): ImportDraft[] {
    const source = text.trim();
    if (!source) return [];

    const drafts: ImportDraft[] = [];

    const addDraft = (word: string, category = 'custom', enabled = true) => {
      const normalizedWord = normalizeGlobalWordValue(word);
      if (!normalizedWord) return;

      const safeCategory = BANNED_WORD_CATEGORY_KEYS.includes(category as keyof typeof BANNED_WORD_CATEGORIES)
        ? category
        : 'custom';

      drafts.push({
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        word: normalizedWord,
        category: safeCategory,
        enabled,
      });
    };

    const parsedJson = (() => {
      try {
        return JSON.parse(source);
      } catch {
        return null;
      }
    })();

    if (parsedJson) {
      const rows = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray(parsedJson?.words)
          ? parsedJson.words
          : [];

      for (const row of rows) {
        if (typeof row === 'string') {
          addDraft(row);
          continue;
        }

        if (row && typeof row === 'object') {
          addDraft(
            String((row as any).word ?? ''),
            String((row as any).category ?? 'custom'),
            (row as any).enabled !== false,
          );
        }
      }

      return drafts;
    }

    const rows = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const row of rows) {
      const line = row.replace(/^\uFEFF/, '');
      const parts = line.split(/[;,\t]/).map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      if (/^word$/i.test(parts[0]) && parts.length > 1) continue;

      const enabledToken = parts[2];
      drafts.push({
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        word: normalizeGlobalWordValue(parts[0]),
        category: BANNED_WORD_CATEGORY_KEYS.includes((parts[1] ?? 'custom') as keyof typeof BANNED_WORD_CATEGORIES)
          ? (parts[1] ?? 'custom')
          : 'custom',
        enabled: enabledToken ? !/^(false|0|off|no|non)$/i.test(enabledToken) : true,
      });
    }

    return drafts.filter((draft) => draft.word.length > 0);
  }

  function ingestGlobalImport(text: string, fileName = '') {
    globalImportText = text;
    globalImportFileName = fileName;
    globalImportDrafts = parseGlobalWordRows(text);
    globalImportError = globalImportDrafts.length === 0 ? 'Aucun mot valide détecté.' : '';
  }

  async function handleImportFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    ingestGlobalImport(await file.text(), file.name);
    input.value = '';
  }

  function handleAnalyzeGlobalImport() {
    ingestGlobalImport(globalImportText, globalImportFileName);
  }

  function updateDraft(id: string, patch: Partial<ImportDraft>) {
    globalImportDrafts = globalImportDrafts.map((draft) => draft.id === id ? { ...draft, ...patch } : draft);
    globalImportError = globalImportDrafts.length > 0 ? '' : globalImportError;
  }

  function removeDraft(id: string) {
    globalImportDrafts = globalImportDrafts.filter((draft) => draft.id !== id);
    if (globalImportDrafts.length === 0) {
      globalImportError = 'Aucun mot valide détecté.';
    }
  }

  function resetGlobalImport() {
    globalImportText = '';
    globalImportFileName = '';
    globalImportDrafts = [];
    globalImportError = '';
  }

  async function handleSaveGlobalImport() {
    const payload = globalImportDrafts
      .map((draft) => ({ word: normalizeGlobalWordValue(draft.word), category: draft.category, enabled: draft.enabled }))
      .filter((draft) => draft.word.length > 0);

    if (payload.length === 0) {
      globalImportError = 'Ajoutez au moins un mot valide avant d\'enregistrer.';
      return;
    }

    globalImportLoading = true;
    try {
      const result = await saveGlobalBannedWords(payload);
      globalBannedWords = result.words ?? [];
      globalBannedWordsLoaded = true;
      globalBannedWordsPage = 1;
      toast.success(`Mots globaux mis à jour (${result.createdCount ?? 0} créés, ${result.updatedCount ?? 0} mis à jour).`);
      resetGlobalImport();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      globalImportLoading = false;
    }
  }

  function updateGlobalWordField(id: string, patch: Partial<BannedWordEntry>) {
    globalBannedWords = globalBannedWords.map((word) => word.id === id ? { ...word, ...patch } : word);
    const previousTimer = globalWordSaveTimers.get(id);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(() => {
      void handleSaveGlobalWord(id);
    }, 650);

    globalWordSaveTimers.set(id, timer);
  }

  async function handleSaveGlobalWord(id: string) {
    const entry = globalBannedWords.find((word) => word.id === id);
    if (!entry) return;

    const nextWord = normalizeGlobalWordValue(entry.word);
    if (!nextWord) {
      globalImportError = 'Le mot ne peut pas être vide.';
      return;
    }

    const previousTimer = globalWordSaveTimers.get(id);
    if (previousTimer) {
      clearTimeout(previousTimer);
      globalWordSaveTimers.delete(id);
    }

    globalWordSavingId = id;
    try {
      const result = await updateGlobalBannedWord(id, {
        word: nextWord,
        category: entry.category,
        enabled: entry.enabled,
      });

      if (result?.word) {
        globalBannedWords = globalBannedWords.map((word) => word.id === id ? result.word : word);
      } else {
        const refreshed = await fetchGlobalBannedWords();
        globalBannedWords = refreshed.words ?? [];
      }

      globalBannedWordsLoaded = true;

      toast.success('Mot global mis à jour.');
    } catch (err: any) {
      globalImportError = err.message;
      const refreshed = await fetchGlobalBannedWords().catch(() => null);
      if (refreshed?.words) {
        globalBannedWords = refreshed.words;
        globalBannedWordsLoaded = true;
      }
    } finally {
      globalWordSavingId = '';
    }
  }

  async function handleDeleteGlobalWord(entry: BannedWordEntry) {
    if (!(await confirmDialog.danger(`Supprimer le mot global « ${entry.word} » ?`))) return;
    try {
      const timer = globalWordSaveTimers.get(entry.id);
      if (timer) clearTimeout(timer);
      globalWordSaveTimers.delete(entry.id);
      await deleteGlobalBannedWord(entry.id);
      globalBannedWords = globalBannedWords.filter((word) => word.id !== entry.id);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleCleanupGlobalWords() {
    if (!(await confirmDialog.ask({ title: 'Nettoyer les mots globaux ?', description: 'Les doublons seront supprimés automatiquement.', confirmLabel: 'Nettoyer', variant: 'warning' }))) return;

    globalCleanupLoading = true;
    globalImportError = '';
    try {
      const result = await cleanupGlobalBannedWords();
      globalBannedWords = result.words ?? [];
      globalBannedWordsLoaded = true;
      globalBannedWordsPage = 1;
      toast.success(`Nettoyage terminé: ${result.cleanedCount ?? 0} mot(s) conservé(s), ${result.duplicateCount ?? 0} doublon(s) supprimé(s).`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      globalCleanupLoading = false;
    }
  }

  function goToGlobalBannedWordsPage(nextPage: number) {
    globalBannedWordsPage = Math.min(globalBannedWordsTotalPages, Math.max(1, nextPage));
  }
</script>

<AdminShell title="Mots globaux" description="Liste de mots interdits appliquée à tous les serveurs.">
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">
  <div class="flex items-center justify-end">
    <div class="px-3 py-1.5 rounded-lg bg-on-surface/6 border border-outline-variant/25 text-xs font-semibold text-on-surface-variant">
      {globalBannedWords.length} mot{globalBannedWords.length > 1 ? 's' : ''}
    </div>
  </div>

  <div class="grid grid-cols-1 gap-6">
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/15 flex items-center justify-center text-cyan-400">
          <Papicon icon="filter" size={16} />
        </div>
        <p class="font-semibold text-on-surface text-sm">Importer des mots</p>
      </div>

      <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-6 space-y-4">
        <div class="space-y-2">
          <p class="text-sm text-on-surface-variant leading-relaxed">
            Collez un CSV, un JSON ou une liste de mots. Vous choisissez les catégories à la main, puis le système ne fait que nettoyer les doublons.
          </p>
          <p class="text-xs text-on-surface-variant/50">
            Format accepté: <span class="font-mono">mot</span>, <span class="font-mono">mot,catégorie</span>, <span class="font-mono">mot,catégorie,true/false</span> ou JSON avec <span class="font-mono">word</span>, <span class="font-mono">category</span>, <span class="font-mono">enabled</span>.
          </p>
        </div>

        <input
          type="file"
          accept=".csv,.json,.txt,.tsv"
          onchange={handleImportFileChange}
          class="block w-full text-sm text-on-surface-variant file:mr-4 file:rounded-xl file:border-0 file:bg-primary file:px-4 file:py-2.5 file:text-sm file:font-bold file:text-white hover:file:bg-primary/90"
        />

        <textarea
          bind:value={globalImportText}
          rows="10"
          placeholder="word,category\nmenace,threat\ninsulte,insult"
          class="w-full rounded-lg border border-outline-variant/20 bg-surface/60 px-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/50"
        ></textarea>

        <div class="flex flex-wrap gap-3">
          <button onclick={handleAnalyzeGlobalImport} class="px-5 py-3 rounded-lg bg-primary text-white font-bold text-sm hover:bg-primary/90 transition-colors">Analyser</button>
          <button onclick={resetGlobalImport} class="px-5 py-3 rounded-lg border border-outline-variant/20 text-sm font-bold text-on-surface-variant hover:bg-on-surface/5 transition-colors">Réinitialiser</button>
          <button onclick={handleSaveGlobalImport} disabled={globalImportLoading || globalImportDrafts.length === 0} class="px-5 py-3 rounded-lg bg-emerald-500 text-white font-bold text-sm hover:bg-emerald-500/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {globalImportLoading ? 'Enregistrement...' : 'Enregistrer les mots'}
          </button>
        </div>

        {#if globalImportFileName}
          <p class="text-xs text-on-surface-variant/50">Fichier chargé : {globalImportFileName}</p>
        {/if}

        {#if globalImportError}
          <div class="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">
            {globalImportError}
          </div>
        {/if}
      </div>

      {#if globalImportDrafts.length > 0}
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-5 space-y-4">
          <div class="flex items-center justify-between gap-4">
            <h3 class="text-lg font-semibold text-on-surface">Prévisualisation ({globalImportDrafts.length})</h3>
            <p class="text-xs text-on-surface-variant/50">Modifiez les catégories avant validation.</p>
          </div>

          <div class="overflow-hidden rounded-lg border border-outline-variant/10">
            <table class="w-full text-sm">
              <thead class="bg-surface/40 text-left text-[10px] uppercase tracking-wider text-on-surface-variant/50">
                <tr>
                  <th class="px-4 py-3">Mot</th>
                  <th class="px-4 py-3">Catégorie</th>
                  <th class="px-4 py-3 text-center">Actif</th>
                  <th class="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/10">
                {#each globalImportDrafts as draft (draft.id)}
                  <tr class="bg-surface/10">
                    <td class="px-4 py-3">
                      <input
                        type="text"
                        value={draft.word}
                        oninput={(event) => updateDraft(draft.id, { word: (event.currentTarget as HTMLInputElement).value })}
                        class="w-full rounded-xl border border-outline-variant/20 bg-surface/70 px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
                      />
                    </td>
                    <td class="px-4 py-3">
                      <select
                        value={draft.category}
                        onchange={(event) => updateDraft(draft.id, { category: (event.currentTarget as HTMLSelectElement).value })}
                        class="w-full rounded-xl border border-outline-variant/20 bg-surface/70 px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
                      >
                        {#each Object.entries(BANNED_WORD_CATEGORIES) as [key, label]}
                          <option value={key}>{label}</option>
                        {/each}
                      </select>
                    </td>
                    <td class="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onchange={(event) => updateDraft(draft.id, { enabled: (event.currentTarget as HTMLInputElement).checked })}
                        class="h-4 w-4 rounded border-outline-variant/40 text-primary focus:ring-primary/30"
                      />
                    </td>
                    <td class="px-4 py-3 text-right">
                      <button onclick={() => removeDraft(draft.id)} class="rounded-xl p-2 text-on-surface-variant/40 hover:bg-error/10 hover:text-error transition-colors" title="Retirer">
                        <Papicon icon="Trash" size={16} />
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </div>

    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center text-indigo-400">
          <Papicon icon="ShieldAlert" size={16} />
        </div>
        <p class="font-semibold text-on-surface text-sm">Mots actifs ({globalBannedWords.length})</p>
      </div>

      <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-5 space-y-4">
        <p class="text-sm text-on-surface-variant/70">
          Ces mots sont appliqués à tous les serveurs et peuvent être désactivés ou supprimés depuis cette interface d'administration.
        </p>

        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            onclick={handleCleanupGlobalWords}
            disabled={globalCleanupLoading}
            class="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-3 text-sm font-bold text-white hover:bg-cyan-500/90 transition-colors disabled:opacity-40"
          >
            <Papicon icon="Sparkles" size={16} />
            {globalCleanupLoading ? 'Nettoyage...' : 'Dédupliquer seulement'}
          </button>
          <button
            type="button"
              onclick={loadGlobalBannedWords}
            class="inline-flex items-center gap-2 rounded-lg border border-outline-variant/20 px-4 py-3 text-sm font-bold text-on-surface-variant hover:bg-on-surface/5 transition-colors"
          >
            <Papicon icon="RefreshCw" size={16} />
            Rafraîchir
          </button>
        </div>

          {#if globalBannedWordsLoading && !globalBannedWordsLoaded}
            <div class="space-y-3 rounded-lg border border-outline-variant/10 p-4">
              {#each [1, 2, 3, 4, 5, 6] as _}
                <Skeleton height="64px" class="rounded-xl" />
              {/each}
            </div>
          {:else if globalBannedWordsError}
            <div class="rounded-lg border border-error/20 bg-error/10 p-4 text-sm text-error flex items-center justify-between gap-4">
              <span>{globalBannedWordsError}</span>
              <button onclick={loadGlobalBannedWords} class="rounded-xl bg-error px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-error/90">
                Réessayer
              </button>
            </div>
          {:else}
            <div class="overflow-hidden rounded-xl border border-outline-variant/10">
              <table class="w-full text-sm">
                <thead class="bg-on-surface/3 text-left text-[13px] text-on-surface-variant/30 border-b border-outline-variant/10">
                  <tr>
                    <th class="px-4 py-3">Mot</th>
                    <th class="px-4 py-3">Catégorie</th>
                    <th class="px-4 py-3 text-center">Actif</th>
                    <th class="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-outline-variant/10">
                  {#each paginatedGlobalBannedWords as entry (entry.id)}
                    <tr class="{entry.enabled ? 'bg-surface/10' : 'bg-surface/5 opacity-60'}">
                      <td class="px-4 py-3">
                        <input
                          type="text"
                          value={entry.word}
                          oninput={(event) => updateGlobalWordField(entry.id, { word: (event.currentTarget as HTMLInputElement).value })}
                          class="w-full rounded-xl border border-outline-variant/20 bg-surface/70 px-3 py-2 text-sm font-mono font-semibold text-on-surface focus:outline-none focus:border-primary/50"
                          maxlength="100"
                        />
                      </td>
                      <td class="px-4 py-3">
                        <select
                          value={entry.category}
                          onchange={(event) => updateGlobalWordField(entry.id, { category: (event.currentTarget as HTMLSelectElement).value })}
                          class="w-full rounded-xl border border-outline-variant/20 bg-surface/70 px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/50"
                        >
                          {#each Object.entries(BANNED_WORD_CATEGORIES) as [key, label]}
                            <option value={key}>{label}</option>
                          {/each}
                        </select>
                      </td>
                      <td class="px-4 py-3 text-center">
                        <label class="inline-flex items-center gap-2 cursor-pointer text-xs font-bold {entry.enabled ? 'text-emerald-500' : 'text-on-surface-variant/40'}">
                          <input
                            type="checkbox"
                            checked={entry.enabled}
                            onchange={(event) => updateGlobalWordField(entry.id, { enabled: (event.currentTarget as HTMLInputElement).checked })}
                            class="h-4 w-4 rounded border-outline-variant/40 text-primary focus:ring-primary/30"
                          />
                          <span class="h-2.5 w-2.5 rounded-full {entry.enabled ? 'bg-emerald-500' : 'bg-on-surface-variant/30'}"></span>
                          {entry.enabled ? 'Actif' : 'Inactif'}
                        </label>
                      </td>
                      <td class="px-4 py-3 text-right whitespace-nowrap">
                        <div class="flex items-center justify-end gap-2">
                          <button onclick={() => handleDeleteGlobalWord(entry)} class="rounded-xl p-2 text-on-surface-variant/40 hover:bg-error/10 hover:text-error transition-colors" title="Supprimer">
                            <Papicon icon="Trash" size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            {#if globalBannedWords.length === 0}
              <p class="py-4 text-center text-sm text-on-surface-variant/50">Aucun mot global configuré.</p>
            {:else}
              <div class="flex flex-col gap-3 rounded-lg border border-outline-variant/10 bg-surface/20 px-4 py-3 md:flex-row md:items-center md:justify-between">
                <p class="text-xs text-on-surface-variant/60">
                  Page {globalBannedWordsPage} sur {globalBannedWordsTotalPages} · {globalBannedWords.length} mot(s) global(aux)
                </p>
                {#if globalBannedWordsTotalPages > 1}
                  <div class="flex items-center gap-2">
                    <button
                      onclick={() => goToGlobalBannedWordsPage(globalBannedWordsPage - 1)}
                      disabled={globalBannedWordsPage === 1}
                      class="rounded-xl border border-outline-variant/20 px-3 py-2 text-xs font-bold text-on-surface-variant transition-colors hover:bg-on-surface/5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Précédent
                    </button>
                    <button
                      onclick={() => goToGlobalBannedWordsPage(globalBannedWordsPage + 1)}
                      disabled={globalBannedWordsPage === globalBannedWordsTotalPages}
                      class="rounded-xl border border-outline-variant/20 px-3 py-2 text-xs font-bold text-on-surface-variant transition-colors hover:bg-on-surface/5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Suivant
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
      </div>
    </div>
  </div>
</div>
</AdminShell>
