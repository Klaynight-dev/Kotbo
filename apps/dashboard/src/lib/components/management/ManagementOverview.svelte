<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import SettingsGroup from './SettingsGroup.svelte';
  import { categoryLabel, featureModuleState, groupByCategory } from './ManagementAccess.svelte';
  import { m } from '../../i18n';
  import { moduleName } from '../../moduleLabels';

  const {
    features = [],
    guildSettings = {} as any,
    modules = [] as any[],
    onNavigate = (_section: string) => {},
  }: {
    features?: any[];
    guildSettings?: any;
    modules?: any[];
    onNavigate?: (section: string) => void;
  } = $props();

  const modulesById = $derived(new Map(modules.map((mod: any) => [mod.id, mod])));

  // Compte les modules du registre, pas les lignes de configuration : celles-ci
  // ignorent la cascade des dependances et l'offre du serveur, et affichaient
  // « 47 / 47 actifs » sur une offre gratuite ou presque tout est verrouille.
  const togglableModules = $derived(modules.filter((mod: any) => !mod.isFixed));
  const enabledCount = $derived(togglableModules.filter((mod: any) => mod.status === 'active').length);
  const restrictedCount = $derived(features.filter((f: any) => (f.roleAccessByRole?.length ?? 0) > 0).length);

  const criticalChannels = $derived([
    { label: m.mgmt_chan_logs(), value: guildSettings.logChannelId },
    { label: m.mgmt_chan_regulation(), value: guildSettings.regulationChannelId },
    { label: m.mgmt_chan_meeting_announcements(), value: guildSettings.meetingAnnouncementChannelId },
    { label: m.mgmt_chan_digest(), value: guildSettings.digestChannelId },
  ]);

  const missingChannels = $derived(criticalChannels.filter((c) => !c.value));
  const healthScore = $derived(
    Math.round(((criticalChannels.length - missingChannels.length) / criticalChannels.length) * 100)
  );
  // Tailwind compile les classes qu'il lit dans la source : une classe montee
  // par interpolation n'existerait pas dans la feuille finale.
  const healthTone = $derived(
    healthScore >= 80
      ? { icon: 'bg-emerald-500/10 text-emerald-500', value: 'text-emerald-500' }
      : healthScore >= 50
        ? { icon: 'bg-amber-500/10 text-amber-500', value: 'text-amber-500' }
        : { icon: 'bg-red-500/10 text-red-500', value: 'text-red-500' }
  );

  const groupedFeatures = $derived(groupByCategory(features));
</script>

<div class="space-y-10">
  <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
    <a href="/modules" class="stat">
      <span class="stat__icon bg-primary/10 text-primary"><Papicon icon="Package" size={20} /></span>
      <span class="stat__label">{m.mgmt_active_modules()}</span>
      <span class="stat__value">{enabledCount} <span class="stat__unit">/ {togglableModules.length}</span></span>
    </a>

    <button type="button" class="stat" onclick={() => onNavigate('acces')}>
      <span class="stat__icon bg-tertiary/10 text-tertiary"><Papicon icon="Shield" size={20} /></span>
      <span class="stat__label">{m.mgmt_restricted_modules()}</span>
      <span class="stat__value">{restrictedCount} <span class="stat__unit">/ {features.length}</span></span>
    </button>

    <button type="button" class="stat" onclick={() => onNavigate('salons')}>
      <span class="stat__icon {healthTone.icon}"><Papicon icon="HeartBeat" size={20} /></span>
      <span class="stat__label">{m.mgmt_health_score()}</span>
      <span class="stat__value {healthTone.value}">{healthScore}%</span>
    </button>
  </div>

  {#if missingChannels.length > 0}
    <button
      type="button"
      class="w-full flex items-start gap-4 p-5 rounded-xl bg-amber-500/5 border border-amber-500/20 text-left hover:bg-amber-500/10 transition-colors"
      onclick={() => onNavigate('salons')}
    >
      <span class="bg-amber-500/10 p-2 rounded-lg text-amber-500 shrink-0"><Papicon icon="Warning" size={18} /></span>
      <span>
        <span class="block text-[11px] font-bold uppercase tracking-widest text-amber-500">{m.mgmt_incomplete_config()}</span>
        <span class="block text-xs text-on-surface-variant/60 mt-1">
          {m.mgmt_missing_channels({ list: missingChannels.map((c) => c.label).join(', ') })}
          <b>{m.mgmt_tab_channels_roles()}</b> {m.mgmt_to_configure()}
        </span>
      </span>
    </button>
  {/if}

  <SettingsGroup title={m.mgmt_features_status()}>
    {#snippet actions()}
      <div class="flex gap-4 text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40">
        <span class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> {m.common_active()}</span>
        <span class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-on-surface-variant/30"></span> {m.common_inactive()}</span>
      </div>
    {/snippet}

    <div class="space-y-6">
      {#each groupedFeatures as group}
        <section class="space-y-2">
          <p class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/50">{categoryLabel(group.category)}</p>
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {#each group.items as { feature } (feature.featureKey)}
              {@const moduleActive = featureModuleState(modulesById, feature.featureKey)}
              <div class="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-surface-container-high/20 border border-outline-variant/10">
                <span class="w-1.5 h-1.5 rounded-full shrink-0 {moduleActive === false ? 'bg-on-surface-variant/30' : 'bg-emerald-500'}"></span>
                <span class="text-[13px] font-medium flex-1 truncate">{moduleName(feature.featureKey, feature.featureName)}</span>
                <span class="flex items-center gap-1 text-[10px] font-semibold shrink-0">
                  {#if (feature.roleAccessByRole?.length ?? 0) > 0}<span class="px-1.5 py-0.5 rounded bg-tertiary/10 text-tertiary">{m.ma_state_restricted()}</span>{/if}
                </span>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </SettingsGroup>
</div>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.25rem;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--surface-container-low) 40%, transparent);
    border: 1px solid color-mix(in srgb, var(--outline-variant) 20%, transparent);
    text-align: left;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .stat:hover {
    /* `--primary-color`, et non `--primary` : c'est le nom que porte le jeton
       dans le theme, et une variable inconnue laisse la declaration tomber. */
    border-color: color-mix(in srgb, var(--primary-color) 30%, transparent);
    background: color-mix(in srgb, var(--surface-container-low) 70%, transparent);
  }

  .stat__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 0.5rem;
  }

  .stat__label {
    font-size: 0.75rem;
    font-weight: 600;
    color: color-mix(in srgb, var(--on-surface-variant) 75%, transparent);
  }

  .stat__value {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--on-surface);
  }

  .stat__unit {
    font-size: 0.8125rem;
    font-weight: 400;
    color: color-mix(in srgb, var(--on-surface-variant) 75%, transparent);
  }

  .stat__hint {
    font-size: 0.75rem;
    font-weight: 500;
    color: color-mix(in srgb, var(--on-surface-variant) 75%, transparent);
  }
</style>
