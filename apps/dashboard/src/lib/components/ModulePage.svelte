<script lang="ts">
  import Papicon from './Papicon.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import { updateModuleStatus } from '../api';
  import { createAsyncActionState } from '../asyncAction.svelte';
  import InlineFeedback from './InlineFeedback.svelte';
  import { toast } from '../stores/toast.svelte';
  import { m } from '../i18n';

  const { 
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

  /**
   * Verrouille par l'offre, et non eteint par choix. La distinction change le
   * bouton : un module eteint se rallume d'un clic, un module hors offre ne se
   * rallume pas du tout. L'interrupteur affiche jusqu'ici sur ces modules
   * ecrivait `enabled = true`, que la garde d'execution rebasculait aussitot a
   * `false` - le clic partait en boucle et la page restait grisee.
   */
  const lockedByPlan = $derived(!!module?.lockedByPlan);

  const PLAN_LABELS: Record<string, string> = {
    PLUS: 'Plus',
    PRO: 'Pro',
    ULTIMATE: 'Ultimate',
    CUSTOM: 'Sur mesure',
  };
  const requiredPlanLabel = $derived(
    module?.requiredPlan ? PLAN_LABELS[module.requiredPlan] ?? module.requiredPlan : 'payante',
  );

  async function toggleModule() {
    if (!module || isFixed || lockedByPlan) return;
    const newStatus = isModuleEnabled ? 'inactive' : 'active';
    
    await saveAction.run(async () => {
      const ok = await updateModuleStatus(featureKey, newStatus);
      if (!ok) throw new Error(m.d7_api_error());
      await dashboardStore.refresh();

      // Le remontage emporte cette bannière avec la page : la confirmation
      // passe donc par une notification, qui lui survit.
      if (newStatus === 'active') {
        toast.success(m.d7_module_enabled());
        dashboardStore.markModuleActivated();
      }
      return true;
    }, { successMessage: newStatus === 'active' ? '' : m.d7_module_disabled() });
  }
</script>

<div class="module-page flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
  <InlineFeedback state={saveAction} />
  
  <!-- Header -->
  <header class="module-page__header flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-container-low/40 p-5 rounded-xl border border-outline-variant/30 relative overflow-hidden group">
    <div class="absolute -top-24 -right-24 w-48 h-48 bg-primary/8 rounded-full blur-[60px] group-hover:bg-primary/15 transition-all duration-700"></div>

    <div class="module-page__identity flex min-w-0 items-center gap-4 relative">
      <div class="module-page__icon w-11 h-11 shrink-0 bg-linear-to-br from-primary to-primary-container rounded-lg flex items-center justify-center shadow-md shadow-primary/15">
        <Papicon {icon} size={22} class="text-white" />
      </div>
      <div class="min-w-0">
        <h1 class="text-lg font-semibold tracking-tight text-on-surface font-headline leading-tight">{title}</h1>
        <p class="text-sm text-on-surface-variant/70 font-medium">{description}</p>
      </div>
    </div>

    <div class="module-page__actions flex items-center gap-3 relative">
      {#if actions}
        {@render actions()}
      {/if}

      {#if module && !isFixed && lockedByPlan}
        <div class="h-8 w-px bg-outline-variant/20 mx-1 hidden md:block"></div>
        <a
          href="/billing"
          class="flex items-center gap-2 px-3.5 h-9 rounded-lg text-[13px] font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity"
        >
          <Papicon icon="Lock" size={14} />
          Offre {requiredPlanLabel}
        </a>
      {:else if module && !isFixed}
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

  <!-- Un module eteint ferme ses routes API : la page ne peut ni charger ni
       enregistrer quoi que ce soit. Le dire ici, une fois, evite que chaque
       appel refuse ne remonte en notification. -->
  {#if module && !isFixed && lockedByPlan}
    <div class="flex items-start gap-3 px-5 py-4 rounded-xl bg-primary/5 border border-primary/20">
      <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Papicon icon="Lock" size={18} />
      </div>
      <div class="space-y-1 min-w-0">
        <p class="text-sm font-semibold text-on-surface">
          « {title} » fait partie de l'offre {requiredPlanLabel}
        </p>
        <p class="text-[13px] text-on-surface-variant/70 leading-relaxed">
          Le serveur peut en voir la page, mais pas l'activer tant que son offre ne le comprend pas.
        </p>
        <a href="/billing" class="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline pt-1">
          Voir les offres <Papicon icon="ArrowRight" size={12} />
        </a>
      </div>
    </div>
  {:else if module && !isFixed && !isModuleEnabled}
    <div class="flex items-start gap-3 px-5 py-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
      <div class="w-9 h-9 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
        <Papicon icon="warning" size={18} />
      </div>
      <div class="space-y-0.5 min-w-0">
        <p class="text-sm font-semibold text-on-surface">{m.mp_module_off_title()}</p>
        <p class="text-[13px] text-on-surface-variant/70 leading-relaxed">{m.mp_module_off_desc()}</p>
      </div>
    </div>
  {/if}

  <main class="module-page__body flex-1 space-y-8 {isModuleEnabled || isFixed || featureKey === 'sanctions' || featureKey === 'channel_links' || featureKey === 'staff_server' ? '' : 'opacity-40 pointer-events-none grayscale-[0.5] transition-all duration-500'}">
    {@render children()}
  </main>
</div>
