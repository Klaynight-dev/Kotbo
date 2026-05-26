<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import {
    fetchNicknameModerationConfig,
    updateNicknameModerationConfig,
    fetchBannedWords,
    addBannedWord,
    deleteBannedWord,
    toggleBannedWord,
  } from '../lib/api';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  type BannedWordEntry = {
    id: string;
    word: string;
    category: string;
    enabled: boolean;
    guildId: string | null;
  };

  type CategoryMeta = {
    label: string;
    color: string;
    bg: string;
  };

  const CATEGORIES: Record<string, CategoryMeta> = {
    custom:     { label: 'Personnalisé', color: 'text-primary',      bg: 'bg-primary/10 border-primary/20' },
    racism:     { label: 'Racisme',      color: 'text-error',        bg: 'bg-error/10 border-error/20' },
    threat:     { label: 'Menace',       color: 'text-orange-400',   bg: 'bg-orange-400/10 border-orange-400/20' },
    sexual:     { label: 'Sexuel',       color: 'text-pink-400',     bg: 'bg-pink-400/10 border-pink-400/20' },
    lgbtphobia: { label: 'LGBTphobie',  color: 'text-purple-400',   bg: 'bg-purple-400/10 border-purple-400/20' },
    hate:       { label: 'Haine',        color: 'text-red-600',      bg: 'bg-red-600/10 border-red-600/20' },
    insult:     { label: 'Insulte',      color: 'text-yellow-400',   bg: 'bg-yellow-400/10 border-yellow-400/20' },
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let enabled = $state(false);
  let globalWords = $state<BannedWordEntry[]>([]);
  let customWords = $state<BannedWordEntry[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  let newWord = $state('');
  let newCategory = $state('custom');
  let activeTab = $state<'custom' | 'global'>('custom');

  const saveToggleAction = createAsyncActionState();
  const wordAction = createAsyncActionState();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(async () => {
    try {
      const [config, words] = await Promise.all([
        fetchNicknameModerationConfig(),
        fetchBannedWords(),
      ]);
      if (config) enabled = config.enabled ?? false;
      if (words) {
        globalWords = words.global ?? [];
        customWords = words.custom ?? [];
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Impossible de charger la configuration.';
    } finally {
      loading = false;
    }

    // Écoute les événements WebSocket pour les mots bannis personnalisés du serveur courant
    // Un autre admin a peut-être ajouté/supprimé/modifié un mot en temps réel sur ce serveur
    async function handleWsMessage(event: Event) {
      const { detail } = event as CustomEvent;
      if (detail?.type !== 'banned_words_changed') return;
      if (detail?.guildId !== authStore.selectedGuildId) return;
      try {
        const words = await fetchBannedWords();
        if (words) {
          globalWords = words.global ?? [];
          customWords = words.custom ?? [];
        }
      } catch {
        // Silencieux — la liste sera mise à jour au prochain chargement
      }
    }

    window.addEventListener('kotbo-ws-message', handleWsMessage);
    return () => window.removeEventListener('kotbo-ws-message', handleWsMessage);
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function saveToggle() {
    await saveToggleAction.run(
      async () => {
        const ok = await updateNicknameModerationConfig({ enabled });
        if (!ok) throw new Error('Erreur API');
        return true;
      },
      { successMessage: `Module ${enabled ? 'activé' : 'désactivé'}.` }
    );
  }

  async function addWord() {
    const trimmed = newWord.trim().toLowerCase();
    if (!trimmed) return;
    if (customWords.some((w) => w.word === trimmed)) {
      wordAction.setError('Ce mot est déjà dans votre liste.');
      return;
    }

    await wordAction.run(
      async () => {
        const res = await addBannedWord(trimmed, newCategory);
        if (!res?.id) throw new Error('Erreur lors de l\'ajout');
        customWords = [...customWords, { id: res.id, word: trimmed, category: newCategory, enabled: true, guildId: authStore.selectedGuildId }];
        newWord = '';
        return true;
      },
      { successMessage: `"${trimmed}" ajouté.` }
    );
  }

  async function handleDelete(entry: BannedWordEntry) {
    await wordAction.run(
      async () => {
        const ok = await deleteBannedWord(entry.id);
        if (!ok) throw new Error('Erreur lors de la suppression');
        customWords = customWords.filter((w) => w.id !== entry.id);
        return true;
      },
      { successMessage: `"${entry.word}" supprimé.` }
    );
  }

  async function handleToggle(entry: BannedWordEntry) {
    const newEnabled = !entry.enabled;
    await wordAction.run(
      async () => {
        const ok = await toggleBannedWord(entry.id, newEnabled);
        if (!ok) throw new Error('Erreur');
        customWords = customWords.map((w) => w.id === entry.id ? { ...w, enabled: newEnabled } : w);
        return true;
      },
      {}
    );
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); addWord(); }
  }

  function getCat(key: string): CategoryMeta {
    return CATEGORIES[key] ?? CATEGORIES.custom;
  }
</script>

<ModulePage
  title="Modération des pseudos"
  description="Renomme automatiquement les pseudos non conformes dès qu'un membre rejoint ou modifie son pseudo."
  icon="filter"
  featureKey="nickname_moderation"
>
  <InlineFeedback state={saveToggleAction} />

  {#if loading}
    <div class="flex flex-col gap-6 animate-pulse">
      {#each [1, 2] as _}
        <div class="h-32 rounded-3xl bg-surface-container-low/60"></div>
      {/each}
    </div>
  {:else if loadError}
    <div class="rounded-3xl bg-error/10 border border-error/20 p-6 text-error text-sm font-semibold">
      ⚠️ {loadError}
    </div>
  {:else}
    <!-- ============================================================ -->
    <!-- Section 1 — Toggle principal                                   -->
    <!-- ============================================================ -->
    <section class="bg-surface-container-low/40 backdrop-blur-xl rounded-4xl border border-outline-variant/30 p-8 flex flex-col gap-6">
      <div class="flex items-start justify-between gap-6">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-black tracking-tight text-on-surface">Activation</h2>
          <p class="text-sm text-on-surface-variant/70">
            Lorsqu'activé, le bot vérifie les pseudos à l'arrivée et lors des modifications.
            Un pseudo non conforme est remplacé par
            <code class="font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded-lg text-xs">pseudo non conforme | automod</code>.
          </p>
        </div>
        <div class="flex-shrink-0">
          <ToggleSwitch checked={enabled} onToggle={() => { enabled = !enabled; saveToggle(); }} disabled={saveToggleAction.state.loading} />
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-surface-container/30 border border-outline-variant/20 flex flex-col gap-2">
        <p class="text-xs font-black uppercase tracking-widest text-on-surface-variant/50">Ce que le bot surveille</p>
        <ul class="text-sm text-on-surface-variant/70 flex flex-col gap-1.5">
          <li class="flex items-center gap-2"><span class="text-primary">→</span> Nouveaux membres rejoignant le serveur</li>
          <li class="flex items-center gap-2"><span class="text-primary">→</span> Membres modifiant leur pseudo</li>
          <li class="flex items-center gap-2"><span class="text-primary">→</span> Pseudos composés uniquement de caractères invisibles</li>
          <li class="flex items-center gap-2"><span class="text-primary">→</span> Mots de la liste globale (racisme, menaces, insultes…)</li>
          <li class="flex items-center gap-2"><span class="text-primary">→</span> Vos mots personnalisés ci-dessous</li>
        </ul>
        <p class="text-xs text-on-surface-variant/40 italic mt-1">
          Le bot ne peut pas renommer le propriétaire du serveur (limitation Discord).
        </p>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- Section 2 — Mots bannis                                       -->
    <!-- ============================================================ -->
    <section class="bg-surface-container-low/40 backdrop-blur-xl rounded-4xl border border-outline-variant/30 p-8 flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-black tracking-tight text-on-surface">Mots bannis</h2>
        <p class="text-sm text-on-surface-variant/70">
          Gérez les mots déclenchant un renommage automatique. Les mots <strong>globaux</strong> sont gérés
          par les administrateurs du bot et sont en lecture seule. Les mots <strong>personnalisés</strong> sont
          propres à ce serveur et partagés en temps réel entre tous les modérateurs de ce serveur.
        </p>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 p-1 bg-surface-container/40 rounded-2xl w-fit">
        {#each [{ key: 'custom', label: `Personnalisés (${customWords.length})` }, { key: 'global', label: `Globaux (${globalWords.length})` }] as tab}
          <button
            onclick={() => activeTab = tab.key as 'custom' | 'global'}
            class="px-4 py-2 rounded-xl text-sm font-bold transition-all {activeTab === tab.key ? 'bg-primary text-white shadow-sm' : 'text-on-surface-variant/60 hover:text-on-surface'}"
          >
            {tab.label}
          </button>
        {/each}
      </div>

      {#if activeTab === 'custom'}
        <!-- Formulaire d'ajout -->
        <div class="flex gap-3 items-start flex-wrap">
          <div class="flex-1 min-w-[200px] relative">
            <input
              id="banned-word-input"
              type="text"
              bind:value={newWord}
              onkeydown={handleKeydown}
              maxlength={100}
              placeholder="Entrer un mot ou fragment..."
              class="w-full bg-surface-container/60 border border-outline-variant/30 rounded-2xl px-5 py-3.5 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-all"
            />
          </div>
          <select
            bind:value={newCategory}
            class="bg-surface-container/60 border border-outline-variant/30 rounded-2xl px-4 py-3.5 text-sm text-on-surface focus:outline-none focus:border-primary/60 transition-all"
          >
            {#each Object.entries(CATEGORIES) as [key, meta]}
              <option value={key}>{meta.label}</option>
            {/each}
          </select>
          <button
            onclick={addWord}
            disabled={!newWord.trim() || wordAction.state.loading}
            class="flex items-center gap-2 px-5 py-3.5 bg-primary text-white rounded-2xl text-sm font-bold transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Papicon icon="plus" size={16} />
            Ajouter
          </button>
        </div>

        <InlineFeedback state={wordAction} />

        <!-- Liste des mots personnalisés -->
        {#if customWords.length > 0}
          <div class="rounded-2xl border border-outline-variant/20 overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-surface-container/40 text-left">
                  <th class="px-5 py-3 text-xs font-black uppercase tracking-widest text-on-surface-variant/50">Mot</th>
                  <th class="px-5 py-3 text-xs font-black uppercase tracking-widest text-on-surface-variant/50">Catégorie</th>
                  <th class="px-5 py-3 text-xs font-black uppercase tracking-widest text-on-surface-variant/50 text-center">Actif</th>
                  <th class="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/10">
                {#each customWords as entry (entry.id)}
                  {@const cat = getCat(entry.category)}
                  <tr class="hover:bg-surface-container/20 transition-colors {entry.enabled ? '' : 'opacity-40'}">
                    <td class="px-5 py-3 font-mono font-semibold text-on-surface">{entry.word}</td>
                    <td class="px-5 py-3">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border {cat.bg} {cat.color}">
                        {cat.label}
                      </span>
                    </td>
                    <td class="px-5 py-3 text-center">
                      <ToggleSwitch checked={entry.enabled} onToggle={() => handleToggle(entry)} disabled={wordAction.state.loading} />
                    </td>
                    <td class="px-3 py-3 text-right">
                      <button
                        onclick={() => handleDelete(entry)}
                        disabled={wordAction.state.loading}
                        aria-label="Supprimer {entry.word}"
                        class="p-2 rounded-xl text-on-surface-variant/40 hover:text-error hover:bg-error/10 transition-all disabled:opacity-30"
                      >
                        <Papicon icon="trash" size={15} />
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-on-surface-variant/40 text-right">
            {customWords.length} mot(s) personnalisé(s)
          </p>
        {:else}
          <div class="flex flex-col items-center gap-3 py-10 text-on-surface-variant/30">
            <Papicon icon="filter" size={36} class="opacity-20" />
            <p class="text-sm font-semibold">Aucun mot personnalisé.</p>
            <p class="text-xs">La liste globale est toujours active.</p>
          </div>
        {/if}

      {:else}
        <!-- Liste globale (read-only) -->
        {#if globalWords.length > 0}
          <div class="rounded-2xl border border-outline-variant/20 overflow-hidden">
            <div class="bg-surface-container/30 px-5 py-3 flex items-center gap-2 text-xs text-on-surface-variant/50 border-b border-outline-variant/10">
              <Papicon icon="lock" size={12} />
              <span>Ces mots sont gérés globalement et ne peuvent pas être modifiés ici.</span>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-surface-container/40 text-left">
                  <th class="px-5 py-3 text-xs font-black uppercase tracking-widest text-on-surface-variant/50">Mot</th>
                  <th class="px-5 py-3 text-xs font-black uppercase tracking-widest text-on-surface-variant/50">Catégorie</th>
                  <th class="px-5 py-3 text-xs font-black uppercase tracking-widest text-on-surface-variant/50 text-center">Actif</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/10">
                {#each globalWords as entry (entry.id)}
                  {@const cat = getCat(entry.category)}
                  <tr class="hover:bg-surface-container/20 transition-colors {entry.enabled ? '' : 'opacity-40'}">
                    <td class="px-5 py-3 font-mono font-semibold text-on-surface">{entry.word}</td>
                    <td class="px-5 py-3">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border {cat.bg} {cat.color}">
                        {cat.label}
                      </span>
                    </td>
                    <td class="px-5 py-3 text-center">
                      <span class="inline-flex items-center gap-1.5 text-xs font-bold {entry.enabled ? 'text-primary' : 'text-on-surface-variant/30'}">
                        <span class="w-2 h-2 rounded-full {entry.enabled ? 'bg-primary' : 'bg-on-surface-variant/20'}"></span>
                        {entry.enabled ? 'Actif' : 'Inactif'}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-on-surface-variant/40 text-right">{globalWords.length} mot(s) global/globaux</p>
        {:else}
          <div class="flex flex-col items-center gap-3 py-10 text-on-surface-variant/30">
            <Papicon icon="filter" size={36} class="opacity-20" />
            <p class="text-sm font-semibold">Aucun mot global configuré.</p>
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</ModulePage>
