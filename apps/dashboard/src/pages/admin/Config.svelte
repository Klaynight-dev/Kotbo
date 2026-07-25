<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchMaintenanceConfig, updateMaintenanceConfig, fetchBotErrors, clearBotErrors } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminLayout from '../../lib/components/AdminLayout.svelte';
  import { m } from '../../lib/i18n';

  interface BotError {
    id: string;
    message: string;
    source: string | null;
    createdAt: string;
  }

  let maintenanceMode = $state(false);
  let botErrors = $state<BotError[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [configData, errorsData] = await Promise.all([
        fetchMaintenanceConfig(),
        fetchBotErrors()
      ]);
      maintenanceMode = configData.maintenance;
      botErrors = errorsData.errors;
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  });

  async function handleToggleMaintenance() {
    try {
      await updateMaintenanceConfig(!maintenanceMode);
      maintenanceMode = !maintenanceMode;
    } catch (err: any) { toast.error(err.message); }
  }

  async function handleClearErrors() {
    if (!(await confirmDialog.danger(m.d7_purge_logs_confirm(), '', m.d7_purge()))) return;
    try {
      await clearBotErrors();
      botErrors = [];
    } catch (err: any) { toast.error(err.message); }
  }
</script>

<AdminLayout>
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-container-low/40 p-5 rounded-xl border border-outline-variant/30">
    <div>
      <h2 class="text-lg font-semibold text-on-surface tracking-tight">{m.d7_advanced()}</h2>
      <p class="text-sm text-on-surface-variant/50 font-medium">{m.d7_system_config_desc()}</p>
    </div>
  </div>

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div class="premium-card rounded-[2.25rem] p-8 space-y-6 h-full">
        <div class="animate-pulse space-y-4">
          <div class="h-20 bg-surface/40 rounded-lg"></div>
          <div class="h-20 bg-surface/40 rounded-lg"></div>
          <div class="h-12 bg-surface/40 rounded-xl"></div>
        </div>
      </div>
      <div class="premium-card rounded-[2.25rem] p-6 h-100 flex flex-col bg-[#0d1117] border-red-500/20">
        <div class="animate-pulse space-y-3">
          <div class="h-4 bg-black/30 rounded"></div>
          <div class="h-4 bg-black/30 rounded"></div>
          <div class="h-4 bg-black/30 rounded"></div>
        </div>
      </div>
    </div>
  {:else if error}
    <div class="bg-error/10 border border-error/20 p-8 rounded-[2.25rem] text-center">
      <Papicon icon="AlertTriangle" size={48} class="text-error mx-auto mb-4" />
      <h2 class="text-xl font-bold text-on-error-container">{m.d7_loading_error()}</h2>
      <p class="text-on-error-container/70 mt-2">{error}</p>
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-in fade-in">
      <!-- Kill Switch -->
      <div class="space-y-6">
        <h2 class="text-xl font-semibold font-headline flex items-center gap-3 px-2">
          <Papicon icon="Power" size={24} class="text-amber-500" />
          {m.d7_kill_switch()}
        </h2>
        
        <div class="premium-card rounded-[2.25rem] p-8 flex flex-col justify-center items-center text-center space-y-6 h-full {maintenanceMode ? 'border-amber-500/50 bg-amber-500/5' : ''}">
          <div class="w-24 h-24 rounded-full flex items-center justify-center {maintenanceMode ? 'bg-amber-500/20 text-amber-500' : 'bg-surface-variant text-on-surface-variant'} shadow-inner">
            <Papicon icon="AlertOctagon" size={48} />
          </div>
          <div>
            <h3 class="text-xl font-bold text-on-surface mb-2">{m.d7_maintenance_mode()}</h3>
            <p class="text-sm text-on-surface-variant">
              {maintenanceMode
                ? m.d7_maintenance_on_desc()
                : m.d7_maintenance_off_desc()}
            </p>
          </div>
          <button 
            onclick={handleToggleMaintenance}
            class="px-8 py-4 rounded-xl font-semibold text-lg transition-all {maintenanceMode ? 'bg-success text-on-success shadow-success/20' : 'bg-amber-500 text-white shadow-amber-500/20'} shadow-lg"
          >
            {maintenanceMode ? m.d7_maintenance_deactivate() : m.d7_maintenance_activate()}
          </button>
        </div>
      </div>

      <!-- Error Logs -->
      <div class="space-y-6">
        <h2 class="text-xl font-semibold font-headline flex items-center gap-3 px-2">
          <Papicon icon="Terminal" size={24} class="text-red-400" />
          {m.d7_error_stream()}
        </h2>
        
        <div class="premium-card rounded-[2.25rem] p-6 h-100 flex flex-col bg-[#0d1117] border-red-500/20">
          <div class="flex items-center justify-between mb-4 px-2">
            <span class="text-xs font-mono text-on-surface-variant">{m.d7_last_uncaught_errors()}</span>
            <button onclick={handleClearErrors} class="text-xs text-error hover:underline flex items-center gap-1">
              <Papicon icon="Trash" size={12} /> {m.d7_purge()}
            </button>
          </div>
          
          <div class="flex-1 overflow-y-auto space-y-3 font-mono text-xs p-2 rounded-xl bg-black/50 border border-white/5">
            {#each botErrors as err}
              <div class="border-b border-white/5 pb-3">
                 <div class="flex justify-between text-[10px] text-white/40 mb-1">
                  <span>{new Date(err.createdAt).toLocaleString()}</span>
                  <span class="text-amber-400/80">{err.source || m.d7_unknown()}</span>
                </div>
                <div class="text-red-400 wrap-break-word">{err.message}</div>
              </div>
            {/each}
            {#if botErrors.length === 0}
              <div class="h-full flex items-center justify-center text-success/70 italic">
                {m.d7_no_errors_detected()}
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
  </div>
</AdminLayout>
