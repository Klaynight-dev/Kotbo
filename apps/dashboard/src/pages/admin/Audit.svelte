<script lang="ts">
  /**
   * Journal d'audit de la console admin.
   *
   * Page nouvelle : jusqu'ici, les actions globales (départ forcé d'un serveur,
   * redémarrage de shard, envoi d'annonce, blacklist) ne laissaient aucune
   * trace horodatée nommant leur auteur. Une action destructrice était donc
   * indistinguable d'un bug.
   */
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import {
    fetchAdminAudit,
    fetchAdminAuditActions,
    type AdminAuditEntry,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import type { AdminTone } from '../../lib/components/admin/types';

  let entries = $state<AdminAuditEntry[]>([]);
  let actionTypes = $state<{ action: string; count: number }[]>([]);
  let nextCursor = $state<string | null>(null);

  let loading = $state(true);
  let loadingMore = $state(false);

  let search = $state('');
  let actionFilter = $state('');
  let outcomeFilter = $state('ALL');
  let windowHours = $state(168);

  let detailOpen = $state(false);
  let selected = $state<AdminAuditEntry | null>(null);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const windows = [
    { value: 24, label: '24 h' },
    { value: 168, label: '7 j' },
    { value: 720, label: '30 j' },
    { value: 0, label: 'Tout' },
  ];

  async function load() {
    loading = true;
    try {
      const result = await fetchAdminAudit({
        search: search.trim() || undefined,
        action: actionFilter || undefined,
        outcome: outcomeFilter === 'ALL' ? undefined : (outcomeFilter as 'OK' | 'FAILED'),
        sinceHours: windowHours || undefined,
        limit: 60,
      });
      entries = result.entries;
      nextCursor = result.nextCursor;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const result = await fetchAdminAudit({
        search: search.trim() || undefined,
        action: actionFilter || undefined,
        outcome: outcomeFilter === 'ALL' ? undefined : (outcomeFilter as 'OK' | 'FAILED'),
        sinceHours: windowHours || undefined,
        limit: 60,
        cursor: nextCursor,
      });
      entries = [...entries, ...result.entries];
      nextCursor = result.nextCursor;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      loadingMore = false;
    }
  }

  onMount(async () => {
    await Promise.all([
      load(),
      fetchAdminAuditActions().then((data) => { actionTypes = data.actions; }).catch(() => {}),
    ]);
  });

  // Le filtrage se fait côté serveur : on temporise la frappe pour ne pas
  // déclencher une requête par caractère.
  $effect(() => {
    void search;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 350);
    return () => { if (searchTimer) clearTimeout(searchTimer); };
  });

  function applyFilter(action: string) {
    actionFilter = actionFilter === action ? '' : action;
    void load();
  }

  function applyOutcome(outcome: string) {
    outcomeFilter = outcome;
    void load();
  }

  function applyWindow(hours: number) {
    windowHours = hours;
    void load();
  }

  // ── Dérivés ───────────────────────────────────────────────────────────────
  const failedCount = $derived(entries.filter((entry) => entry.outcome === 'FAILED').length);
  const actorCount = $derived(new Set(entries.map((entry) => entry.actorId)).size);

  /** Regroupe par jour : un journal brut de 60 lignes se lit mal sans repères. */
  const grouped = $derived.by(() => {
    const map = new Map<string, AdminAuditEntry[]>();
    for (const entry of entries) {
      const day = new Date(entry.createdAt).toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
      const bucket = map.get(day);
      if (bucket) bucket.push(entry);
      else map.set(day, [entry]);
    }
    return [...map.entries()];
  });

  // ── Affichage ─────────────────────────────────────────────────────────────
  /** Ton et icône déduits du domaine de l'action (`domaine.verbe`). */
  function actionVisual(action: string): { tone: AdminTone; icon: string } {
    const domain = action.split('.')[0];
    switch (domain) {
      case 'broadcast': return { tone: 'warning', icon: 'Megaphone' };
      case 'guild': return { tone: 'primary', icon: 'Server' };
      case 'shard': return { tone: 'info', icon: 'Zap' };
      case 'admin': return { tone: 'danger', icon: 'ShieldCheck' };
      case 'blacklist': return { tone: 'danger', icon: 'Ban' };
      case 'whitelabel': return { tone: 'info', icon: 'Layers' };
      case 'gdpr': return { tone: 'neutral', icon: 'ShieldCheck' };
      default: return { tone: 'neutral', icon: 'ClipboardList' };
    }
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatFull(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function openDetail(entry: AdminAuditEntry) {
    selected = entry;
    detailOpen = true;
  }

  /** Export CSV de la fenêtre affichée, pour archivage ou analyse externe. */
  function exportCsv() {
    const header = ['date', 'action', 'auteur', 'cible', 'resultat', 'resume', 'ip'];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = entries.map((entry) => [
      entry.createdAt,
      entry.action,
      entry.actorName ?? entry.actorId,
      entry.targetId ?? '',
      entry.outcome,
      entry.summary,
      entry.ip ?? '',
    ].map(escape).join(','));

    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kotbo-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`${entries.length} entrée(s) exportée(s)`);
  }
</script>

<AdminShell
  title="Journal d’audit"
  description="Trace horodatée des actions sensibles réalisées depuis la console admin globale."
>
  {#snippet actions()}
    <button
      type="button"
      onclick={exportCsv}
      disabled={entries.length === 0}
      class="h-9 px-3.5 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-40 inline-flex items-center gap-2"
    >
      <Papicon icon="Download" size={13} />
      Exporter en CSV
    </button>
    <button
      type="button"
      onclick={load}
      class="h-9 px-3.5 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition inline-flex items-center gap-2"
    >
      <Papicon icon="RefreshCw" size={13} />
      Actualiser
    </button>
  {/snippet}

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <AdminStat label="Entrées affichées" value={entries.length} icon="ClipboardList" tone="primary" {loading} />
    <AdminStat label="Échecs" value={failedCount} icon="AlertTriangle" tone={failedCount > 0 ? 'danger' : 'neutral'} {loading} />
    <AdminStat label="Auteurs distincts" value={actorCount} icon="Users" tone="info" {loading} />
    <AdminStat label="Types d’action" value={actionTypes.length} icon="filter" tone="neutral" {loading} />
  </div>

  <div class="flex flex-col gap-3">
    <AdminToolbar bind:search placeholder="Rechercher un résumé, une action, un auteur ou un ID cible…">
      {#snippet actions()}
        <div class="flex items-center gap-1 p-0.5 rounded-lg bg-on-surface/6">
          {#each windows as option (option.value)}
            <button
              type="button"
              onclick={() => applyWindow(option.value)}
              class="h-8 px-2.5 rounded-md text-[12px] font-semibold transition
                {windowHours === option.value ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}"
            >
              {option.label}
            </button>
          {/each}
        </div>
        <div class="flex items-center gap-1 p-0.5 rounded-lg bg-on-surface/6">
          {#each [
            { value: 'ALL', label: 'Tous' },
            { value: 'OK', label: 'Réussis' },
            { value: 'FAILED', label: 'Échecs' },
          ] as option (option.value)}
            <button
              type="button"
              onclick={() => applyOutcome(option.value)}
              class="h-8 px-2.5 rounded-md text-[12px] font-semibold transition
                {outcomeFilter === option.value ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}"
            >
              {option.label}
            </button>
          {/each}
        </div>
      {/snippet}
    </AdminToolbar>

    {#if actionTypes.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each actionTypes as entry (entry.action)}
          <button
            type="button"
            onclick={() => applyFilter(entry.action)}
            aria-pressed={actionFilter === entry.action}
            class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-mono font-medium transition
              {actionFilter === entry.action
                ? 'bg-primary/12 text-primary border border-primary/30'
                : 'bg-on-surface/5 text-on-surface-variant border border-transparent hover:bg-on-surface/8 hover:text-on-surface'}"
          >
            {entry.action}
            <span class="tabular-nums text-[10.5px] opacity-70">{entry.count}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="space-y-2">
      {#each Array(8) as _, index (index)}
        <div class="h-16 rounded-xl bg-on-surface/6 animate-pulse"></div>
      {/each}
    </div>
  {:else if entries.length === 0}
    <AdminCard>
      <div class="py-14 flex flex-col items-center gap-2 text-center">
        <div class="w-11 h-11 rounded-2xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant">
          <Papicon icon="ClipboardList" size={20} />
        </div>
        <p class="text-sm font-semibold text-on-surface">Aucune entrée</p>
        <p class="text-[13px] text-on-surface-variant max-w-md">
          Le journal est alimenté à partir de cette mise à jour : les actions antérieures n’y figurent pas.
          Élargissez la fenêtre ou retirez les filtres si vous cherchez une action précise.
        </p>
      </div>
    </AdminCard>
  {:else}
    <div class="space-y-5">
      {#each grouped as [day, dayEntries] (day)}
        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <p class="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">{day}</p>
            <div class="flex-1 h-px bg-outline-variant/25"></div>
            <span class="text-[11px] text-on-surface-variant tabular-nums">{dayEntries.length}</span>
          </div>

          <ul class="space-y-1.5">
            {#each dayEntries as entry (entry.id)}
              {@const visual = actionVisual(entry.action)}
              <li>
                <button
                  type="button"
                  onclick={() => openDetail(entry)}
                  class="w-full text-left rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3 flex items-start gap-3
                    hover:border-primary/35 hover:bg-surface-container-low/60 transition focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <div
                    class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center
                      {visual.tone === 'danger' ? 'bg-red-500/12 text-red-500'
                        : visual.tone === 'warning' ? 'bg-amber-500/12 text-amber-500'
                          : visual.tone === 'info' ? 'bg-sky-500/12 text-sky-500'
                            : visual.tone === 'primary' ? 'bg-primary/12 text-primary'
                              : 'bg-on-surface/8 text-on-surface-variant'}"
                  >
                    <Papicon icon={visual.icon} size={14} />
                  </div>

                  <div class="min-w-0 flex-1">
                    <p class="text-[13.5px] text-on-surface leading-snug">{entry.summary}</p>
                    <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1">
                      <span class="text-[11px] font-mono text-on-surface-variant">{entry.action}</span>
                      <span class="text-[11px] text-on-surface-variant">·</span>
                      <span class="text-[11px] text-on-surface-variant">{entry.actorName ?? entry.actorId}</span>
                      {#if entry.targetId}
                        <span class="text-[11px] text-on-surface-variant">·</span>
                        <span class="text-[11px] font-mono text-on-surface-variant truncate max-w-40">{entry.targetId}</span>
                      {/if}
                    </div>
                  </div>

                  <div class="shrink-0 flex flex-col items-end gap-1">
                    <span class="text-[11.5px] text-on-surface-variant tabular-nums">{formatTime(entry.createdAt)}</span>
                    {#if entry.outcome === 'FAILED'}
                      <AdminBadge size="sm" label="Échec" tone="danger" />
                    {/if}
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/each}

      {#if nextCursor}
        <button
          type="button"
          onclick={loadMore}
          disabled={loadingMore}
          class="w-full h-11 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          {#if loadingMore}
            <span class="w-3.5 h-3.5 rounded-full border-2 border-on-surface-variant/30 border-t-on-surface-variant animate-spin"></span>
            Chargement…
          {:else}
            Charger plus d’entrées
          {/if}
        </button>
      {/if}
    </div>
  {/if}
</AdminShell>

<AdminDrawer bind:open={detailOpen} width="sm" title="Détail de l’action" subtitle={selected?.action ?? ''}>
  {#if selected}
    {@const entry = selected}
    <div class="space-y-4">
      <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5">
        <p class="text-[13.5px] text-on-surface leading-relaxed">{entry.summary}</p>
      </div>

      <dl class="space-y-2.5">
        {#each [
          { label: 'Action', value: entry.action, mono: true },
          { label: 'Résultat', value: entry.outcome === 'OK' ? 'Réussie' : 'En échec', mono: false },
          { label: 'Auteur', value: entry.actorName ?? '-', mono: false },
          { label: 'ID auteur', value: entry.actorId, mono: true },
          { label: 'Type de cible', value: entry.targetType ?? '-', mono: false },
          { label: 'ID cible', value: entry.targetId ?? '-', mono: true },
          { label: 'Adresse IP', value: entry.ip ?? '-', mono: true },
          { label: 'Horodatage', value: formatFull(entry.createdAt), mono: false },
        ] as field (field.label)}
          <div class="flex items-start justify-between gap-3">
            <dt class="text-[12.5px] text-on-surface-variant shrink-0">{field.label}</dt>
            <dd class="text-[12.5px] text-on-surface text-right break-all {field.mono ? 'font-mono' : 'font-medium'}">
              {field.value}
            </dd>
          </div>
        {/each}
      </dl>

      {#if entry.metadata}
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">Métadonnées</p>
          <pre class="text-[11.5px] font-mono text-on-surface-variant bg-surface-container-low/60 border border-outline-variant/25 rounded-xl p-3 overflow-x-auto">{JSON.stringify(entry.metadata, null, 2)}</pre>
        </div>
      {/if}
    </div>
  {/if}
</AdminDrawer>
