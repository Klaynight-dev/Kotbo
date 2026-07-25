<script lang="ts">
  import Papicon from './Papicon.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import { updateModuleStatus } from '../api';
  import { createAsyncActionState } from '../asyncAction.svelte';
  import InlineFeedback from './InlineFeedback.svelte';
  import { m } from '../i18n';

  let { 
    title = '', 
    description = '', 
    icon = 'Grid', 
    featureKey = '', 
    children,
    actions = undefined
  } = $props();

  const saveAction = createAsyncActionState();

  const module = $derived((dashboardStore.state.modules as any[]).find((m) => m.id === featureKey));
  const isModuleEnabled = $derived(!module || module.status === 'active');
  const isFixed = $derived(module?.id === 'activity' || module?.id === 'dashboard');

  async function toggleModule() {
    if (!module || isFixed) return;
    const newStatus = isModuleEnabled ? 'inactive' : 'active';
    
    await saveAction.run(async () => {
      const ok = await updateModuleStatus(featureKey, newStatus);
      if (!ok) throw new Error(m.d7_api_error());
      await dashboardStore.refresh();
      return true;
    }, { successMessage: newStatus === 'active' ? m.d7_module_enabled() : m.d7_module_disabled() });
  }
</script>

<div class="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
  <InlineFeedback state={saveAction} />
  
  <!-- Header -->
  <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-container-low/40 p-5 rounded-xl border border-outline-variant/30 relative overflow-hidden group">
    <div class="absolute -top-24 -right-24 w-48 h-48 bg-primary/8 rounded-full blur-[60px] group-hover:bg-primary/15 transition-all duration-700"></div>

    <div class="flex items-center gap-4 relative">
      <div class="w-11 h-11 bg-linear-to-br from-primary to-primary-container rounded-lg flex items-center justify-center shadow-md shadow-primary/15">
        <Papicon {icon} size={22} class="text-white" />
      </div>
      <div>
        <h1 class="text-lg font-semibold tracking-tight text-on-surface font-headline leading-tight">{title}</h1>
        <p class="text-sm text-on-surface-variant/70 font-medium">{description}</p>
      </div>
    </div>

    <div class="flex items-center gap-3 relative">
      {#if actions}
        {@render actions()}
      {/if}

      {#if module && !isFixed}
        <div class="h-8 w-px bg-outline-variant/20 mx-1 hidden md:block"></div>
        <div class="flex items-center gap-2.5 px-3 py-1.5 bg-surface-container-low/40 rounded-lg border border-outline-variant/10">
          <span class="text-xs font-medium {isModuleEnabled ? 'text-primary' : 'text-on-surface-variant/40'}">
            {isModuleEnabled ? m.d7_enabled() : m.d7_disabled()}
          </span>
          <ToggleSwitch
            checked={isModuleEnabled}
            onToggle={toggleModule}
            disabled={saveAction.state.loading}
          />
        </div>
      {/if}
    </div>
  </header>

  <main class="flex-1 space-y-8 {isModuleEnabled || isFixed || featureKey === 'sanctions' || featureKey === 'channel_links' || featureKey === 'staff_server' ? '' : 'opacity-40 pointer-events-none grayscale-[0.5] transition-all duration-500'}">
    {@render children()}
  </main>
</div>
