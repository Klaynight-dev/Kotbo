<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchAdminShards, restartAdminShard, restartAllAdminShards, reconfigureAdminShards } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import Skeleton from '../../lib/components/Skeleton.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  type ShardSnapshot = {
    shardId: number;
    status: 'online' | 'offline' | 'starting' | 'restarting';
    guildCount: number;
    memberCount: number;
    ping: number;
    uptime: number;
    readyAt: string | null;
    memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  };

  type ShardingConfig = { mode: 'auto' | 'fixed'; shardCount: number | null };

  let shardState = $state<{ config: ShardingConfig; shards: ShardSnapshot[]; onlineShardCount: number } | null>(null);
  let shardLoading = $state(true);
  let shardActionLoading = $state('');
  let shardMode = $state<'auto' | 'fixed'>('auto');
  let shardCount = $state('');

  const shardRows = $derived(shardState?.shards ?? []);
  const shardConfiguredCount = $derived(
    shardState?.config.mode === 'fixed'
      ? (shardState?.config.shardCount ?? shardRows.length)
      : shardRows.length,
  );
  const shardAveragePing = $derived(
    shardRows.length > 0
      ? Math.round(shardRows.reduce((sum, shard) => sum + shard.ping, 0) / shardRows.length)
      : 0,
  );
  const maxShardGuildCount = $derived(
    shardRows.length > 0 ? Math.max(...shardRows.map((shard) => shard.guildCount)) : 0,
  );

  onMount(async () => { await refreshShards(); });

  function formatShardUptime(seconds: number) {
    if (!seconds || seconds <= 0) return '0m';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}j ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function shardStatusLabel(status: ShardSnapshot['status']) {
    if (status === 'online') return 'En ligne';
    if (status === 'starting') return 'Démarrage';
    if (status === 'restarting') return 'Redémarrage';
    return 'Hors ligne';
  }

  function shardStatusTone(status: ShardSnapshot['status']) {
    if (status === 'online') return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    if (status === 'starting') return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    if (status === 'restarting') return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    return 'bg-red-500/10 text-red-400 border-red-500/20';
  }

  async function refreshShards() {
    try {
      shardLoading = true;
      const data = await fetchAdminShards();
      shardState = {
        config: data.config ?? { mode: 'auto', shardCount: null },
        shards: data.shards ?? [],
        onlineShardCount: data.onlineShardCount ?? 0,
      };
      shardMode = shardState.config.mode;
      shardCount = shardState.config.shardCount ? String(shardState.config.shardCount) : '';
    } catch (err: any) {
      toast.error(err.message || 'Impossible de rafraîchir les shards.');
    } finally {
      shardLoading = false;
    }
  }

  async function handleRestartShard(shardId: number) {
    if (!(await confirmDialog.ask({ title: `Redémarrer le shard ${shardId} ?`, confirmLabel: 'Redémarrer', variant: 'warning' }))) return;
    try {
      shardActionLoading = `restart:${shardId}`;
      await restartAdminShard(shardId);
      toast.success(`Shard ${shardId} redémarré.`);
      await refreshShards();
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du redémarrage du shard.');
    } finally {
      shardActionLoading = '';
    }
  }

  async function handleRestartAllShards() {
    if (!(await confirmDialog.ask({ title: 'Redémarrer tous les shards ?', description: 'Le bot sera brièvement indisponible sur tous les serveurs.', confirmLabel: 'Tout redémarrer', variant: 'warning' }))) return;
    try {
      shardActionLoading = 'restart-all';
      await restartAllAdminShards();
      toast.success('Redémarrage global demandé.');
      await refreshShards();
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du redémarrage global.');
    } finally {
      shardActionLoading = '';
    }
  }

  async function handleReconfigureShards() {
    const payload = {
      mode: shardMode,
      shardCount: shardMode === 'fixed' ? Number(shardCount) : null,
    };
    if (payload.mode === 'fixed' && (!Number.isInteger(payload.shardCount) || (payload.shardCount ?? 0) < 1)) {
      toast.error('Le nombre de shards doit être supérieur à zéro.');
      return;
    }
    try {
      shardActionLoading = 'reconfigure';
      await reconfigureAdminShards(payload);
      toast.success('Configuration de sharding enregistrée. Le conteneur va redémarrer.');
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors de la reconfiguration des shards.');
    } finally {
      shardActionLoading = '';
    }
  }
</script>

<AdminShell title="Shards" description="Répartition des serveurs sur les shards Discord, latence et redémarrages contrôlés.">
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">

    <div class="flex justify-end">
      <button
        type="button"
        onclick={refreshShards}
        disabled={shardLoading}
        class="inline-flex items-center gap-2 h-9 px-3.5 rounded-xl text-[13px] font-semibold bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-on-surface-variant hover:text-on-surface transition disabled:opacity-40"
      >
        <Papicon icon="RefreshCw" size={13} />
        Rafraîchir
      </button>
    </div>

    {#if shardLoading && !shardState}
      <div class="grid grid-cols-3 gap-4">
        {#each Array(3) as _}
          <Skeleton height="90px" class="rounded-xl" />
        {/each}
      </div>
      <Skeleton height="300px" class="rounded-xl" />
    {:else}
      <!-- KPI row -->
      <div class="grid grid-cols-3 gap-4">
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-xl p-4">
          <p class="text-2xl font-semibold font-mono text-on-surface">{shardConfiguredCount}</p>
          <p class="text-xs font-medium text-on-surface-variant/40 mt-1">Shards total</p>
        </div>
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-xl p-4">
          <p class="text-2xl font-semibold font-mono text-emerald-400">{shardState?.onlineShardCount ?? 0}</p>
          <p class="text-xs font-medium text-on-surface-variant/40 mt-1">En ligne</p>
        </div>
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-xl p-4">
          <p class="text-2xl font-semibold font-mono text-blue-400">{shardAveragePing} ms</p>
          <p class="text-xs font-medium text-on-surface-variant/40 mt-1">Ping moyen</p>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <!-- Config panel -->
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-6 space-y-5">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl bg-primary/10 border border-primary/15 flex items-center justify-center text-primary">
              <Papicon icon="Settings" size={16} />
            </div>
            <div>
              <p class="font-semibold text-on-surface text-sm">Configuration</p>
              <p class="text-[10px] text-on-surface-variant/40 font-medium">Mode de sharding</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div class="bg-on-surface/4 rounded-xl p-3 space-y-0.5">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/30">Mode actif</p>
              <p class="text-sm font-semibold text-on-surface uppercase">{shardState?.config.mode ?? 'auto'}</p>
            </div>
            <div class="bg-on-surface/4 rounded-xl p-3 space-y-0.5">
              <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/30">En ligne</p>
              <p class="text-sm font-semibold text-emerald-400">{shardState?.onlineShardCount ?? 0}/{shardConfiguredCount}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <p class="text-xs font-medium text-on-surface-variant/40">Mode de sharding</p>
            <select
              bind:value={shardMode}
              class="w-full bg-on-surface/4 border border-outline-variant/10 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/30 transition-all"
            >
              <option value="auto">Automatique</option>
              <option value="fixed">Fixe</option>
            </select>
          </div>

          <div class="space-y-1.5">
            <p class="text-xs font-medium text-on-surface-variant/40">Nombre de shards</p>
            <input
              type="number"
              min="1"
              bind:value={shardCount}
              placeholder="Auto si vide"
              disabled={shardMode !== 'fixed'}
              class="w-full bg-on-surface/4 border border-outline-variant/10 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            />
          </div>

          <div class="flex flex-col gap-2 pt-2">
            <button
              type="button"
              onclick={handleReconfigureShards}
              disabled={shardActionLoading === 'reconfigure'}
              class="w-full py-2.5 rounded-xl bg-primary text-on-primary font-semibold text-xs uppercase tracking-widest transition-all hover: disabled:opacity-40"
            >
              {shardActionLoading === 'reconfigure' ? 'Enregistrement...' : 'Appliquer'}
            </button>
            <button
              type="button"
              onclick={handleRestartAllShards}
              disabled={shardActionLoading === 'restart-all'}
              class="w-full py-2.5 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/20 font-semibold text-xs uppercase tracking-widest transition-all hover:bg-amber-500/25 disabled:opacity-40"
            >
              {shardActionLoading === 'restart-all' ? 'Redémarrage...' : 'Redémarrer tout'}
            </button>
          </div>
        </div>

        <!-- Shards table + bar chart -->
        <div class="xl:col-span-2 space-y-5">
          <!-- Visual bar chart -->
          <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-5">
            <p class="text-[13px] font-medium text-on-surface-variant/30 mb-4">Répartition par shard</p>
            <div class="flex items-end gap-3 h-24">
              {#each shardRows as shard (shard.shardId)}
                <div class="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                  <div class="w-full relative h-20">
                    <div
                      class="absolute bottom-0 w-full rounded-t-lg transition-all duration-700
 {shard.status === 'online' ? 'bg-linear-to-t from-emerald-600 to-emerald-400'
                        : shard.status === 'starting' ? 'bg-linear-to-t from-amber-600 to-amber-400'
                        : shard.status === 'restarting' ? 'bg-linear-to-t from-blue-600 to-blue-400'
                        : 'bg-linear-to-t from-red-700 to-red-500'}"
                      style="height: {maxShardGuildCount > 0 ? Math.max(10, (shard.guildCount / maxShardGuildCount) * 100) : 10}%"
                    ></div>
                  </div>
                  <p class="text-[11px] font-semibold text-on-surface-variant/40 truncate w-full text-center">#{shard.shardId}</p>
                </div>
              {/each}
            </div>
          </div>

          <!-- Shards table -->
          <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full">
                <thead>
                  <tr class="border-b border-outline-variant/10 bg-on-surface/3">
                    <th class="text-left text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">Shard</th>
                    <th class="text-left text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">État</th>
                    <th class="text-left text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">Serveurs</th>
                    <th class="text-left text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">Membres</th>
                    <th class="text-left text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">Ping</th>
                    <th class="text-left text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">Uptime</th>
                    <th class="text-right text-xs font-medium text-on-surface-variant/30 px-5 py-3.5">Action</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-outline-variant/8">
                  {#each shardRows as shard (shard.shardId)}
                    <tr class="group hover:bg-on-surface/3 transition-colors duration-150">
                      <td class="px-5 py-3.5">
                        <p class="font-semibold text-on-surface text-sm">#{shard.shardId}</p>
                        <p class="text-[11px] font-mono text-on-surface-variant/30">{shard.readyAt ? new Date(shard.readyAt).toLocaleTimeString('fr-FR') : '-'}</p>
                      </td>
                      <td class="px-5 py-3.5">
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border {shardStatusTone(shard.status)}">
                          <span class="w-1.5 h-1.5 rounded-full {shard.status === 'online' ? 'bg-emerald-400' : shard.status === 'starting' ? 'bg-amber-400 animate-pulse' : shard.status === 'restarting' ? 'bg-blue-400 animate-pulse' : 'bg-red-400'}"></span>
                          {shardStatusLabel(shard.status)}
                        </span>
                      </td>
                      <td class="px-5 py-3.5 font-bold text-sm text-on-surface">{shard.guildCount}</td>
                      <td class="px-5 py-3.5 font-bold text-sm text-on-surface">{shard.memberCount.toLocaleString()}</td>
                      <td class="px-5 py-3.5">
                        <span class="font-semibold font-mono text-sm {shard.ping > 200 ? 'text-amber-400' : shard.ping > 100 ? 'text-yellow-400' : 'text-emerald-400'}">{shard.ping} ms</span>
                      </td>
                      <td class="px-5 py-3.5 font-medium text-sm text-on-surface-variant/60">{formatShardUptime(shard.uptime)}</td>
                      <td class="px-5 py-3.5 text-right">
                        <button
                          type="button"
                          onclick={() => handleRestartShard(shard.shardId)}
                          disabled={shardActionLoading === `restart:${shard.shardId}`}
                          class="px-3 py-1.5 rounded-lg text-xs font-medium bg-on-surface/5 hover:bg-amber-500/15 text-on-surface-variant hover:text-amber-400 border border-outline-variant/10 hover:border-amber-500/20 transition-all disabled:opacity-40"
                        >
                          {shardActionLoading === `restart:${shard.shardId}` ? '...' : 'Restart'}
                        </button>
                      </td>
                    </tr>
                  {/each}
                  {#if shardRows.length === 0}
                    <tr>
                      <td colspan="7" class="px-5 py-10 text-center text-sm text-on-surface-variant/40">
                        {shardLoading ? 'Chargement...' : 'Aucun shard disponible.'}
                      </td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</AdminShell>
