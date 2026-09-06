<script lang="ts">
  /**
   * Chassis de la console admin globale.
   *
   * Remplace l'ancien `AdminLayout`, dont il corrige les defauts
   * structurels :
   *   - texte de navigation a 30-40 % d'opacite, illisible en theme clair ;
   *   - en-tete non collant : la navigation disparaissait sur les pages
   *     longues (Serveurs, Broadcast) ;
   *   - hauteur de colonne calee sur une constante magique (`100vh - 73px`)
   *     qui cassait des que l'en-tete changeait de hauteur ;
   *   - navigation mobile dupliquee en bandeau d'onglets illisible ;
   *   - aucun titre de page : chaque page reimplementait le sien.
   */
  import type { Snippet } from 'svelte';
  import { onMount, onDestroy } from 'svelte';
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import CommandPalette from '../CommandPalette.svelte';
  import AdminSparkline from './AdminSparkline.svelte';
  import { fetchAdminStats } from '../../api';
  import { brandingStore } from '../../stores/branding.svelte';
  import { searchStore } from '../../stores/search.svelte';
  import { m } from '../../i18n';

  const {
    title = '',
    description = '',
    actions,
    children,
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    children?: Snippet;
  } = $props();

  interface NavItem {
    path: string;
    label: string;
    icon: string;
    exact?: boolean;
  }

  const navGroups: { label: string; items: NavItem[] }[] = [
    {
      label: m.d4_nav_supervision(),
      items: [
        { path: '/admin', label: m.d4_nav_overview(), icon: 'activity', exact: true },
        { path: '/admin/servers', label: m.d4_nav_servers(), icon: 'Server' },
        { path: '/admin/shards', label: m.d4_nav_shards(), icon: 'Zap' },
        { path: '/admin/modules', label: m.d4_nav_modules(), icon: 'Box' },
        { path: '/admin/billing', label: 'Facturation', icon: 'CreditCard' },
        { path: '/admin/analytics', label: 'Acquisition & Revenus', icon: 'TrendingUp' },
      ],
    },
    {
      label: 'Communication',
      items: [
        { path: '/admin/broadcast', label: m.d4_nav_broadcast(), icon: 'Megaphone' },
      ],
    },
    {
      label: m.d4_nav_security_filtering(),
      items: [
        { path: '/admin/security', label: m.d4_nav_security(), icon: 'ShieldCheck' },
        { path: '/admin/content', label: m.d4_nav_global_words(), icon: 'filter' },
        { path: '/admin/activation', label: m.d4_nav_activation_codes(), icon: 'Key' },
        { path: '/admin/whitelabel', label: m.d4_nav_whitelabel(), icon: 'Layers' },
      ],
    },
    {
      label: 'Exploitation',
      items: [
        { path: '/admin/audit', label: 'Journal d’audit', icon: 'ClipboardList' },
        { path: '/admin/gdpr', label: m.d4_nav_gdpr_export(), icon: 'ShieldCheck' },
        { path: '/admin/config', label: m.d4_nav_advanced(), icon: 'Settings' },
      ],
    },
  ];

  const allItems = navGroups.flatMap((group) => group.items);

  // ── Sante affichee en pied de barre laterale ──────────────────────────────
  interface HealthStats {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    averageShardPing: number;
    onlineShardCount: number;
    shardCount: number;
  }

  let health = $state<HealthStats | null>(null);
  let heapHistory = $state<number[]>([]);
  let pingHistory = $state<number[]>([]);
  let healthError = $state(false);
  let healthInterval: ReturnType<typeof setInterval> | null = null;

  let sidebarCollapsed = $state(false);
  let mobileNavOpen = $state(false);

  const COLLAPSE_KEY = 'kotbo.admin.sidebarCollapsed';

  async function refreshHealth() {
    try {
      const data = (await fetchAdminStats()) as Record<string, any>;
      health = {
        heapUsed: data.memoryUsage?.heapUsed ?? 0,
        heapTotal: data.memoryUsage?.heapTotal ?? 1,
        rss: data.memoryUsage?.rss ?? 0,
        averageShardPing: data.averageShardPing ?? 0,
        onlineShardCount: data.onlineShardCount ?? 0,
        shardCount: data.shardCount ?? 0,
      };
      // Historique court, uniquement pour l'etincelle du pied de barre.
      heapHistory = [...heapHistory, health.heapUsed].slice(-24);
      pingHistory = [...pingHistory, health.averageShardPing].slice(-24);
      healthError = false;
    } catch {
      healthError = true;
    }
  }

  onMount(() => {
    try {
      sidebarCollapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      // Navigation privee ou stockage bloque : la barre reste depliee.
    }
    void refreshHealth();
    healthInterval = setInterval(refreshHealth, 30_000);
  });

  onDestroy(() => {
    if (healthInterval) clearInterval(healthInterval);
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // Preference non persistee : sans consequence sur la session en cours.
    }
  }

  const heapPercent = $derived(health ? Math.round((health.heapUsed / health.heapTotal) * 100) : 0);
  const shardsHealthy = $derived(health ? health.onlineShardCount === health.shardCount && health.shardCount > 0 : false);

  const heapTone = $derived(heapPercent > 85 ? 'danger' : heapPercent > 65 ? 'warning' : 'ok');
  const pingTone = $derived(
    !health ? 'ok' : health.averageShardPing > 250 ? 'danger' : health.averageShardPing > 130 ? 'warning' : 'ok',
  );

  const toneText: Record<string, string> = {
    ok: 'text-emerald-500',
    warning: 'text-amber-500',
    danger: 'text-red-500',
  };
  const toneBar: Record<string, string> = {
    ok: 'bg-emerald-500',
    warning: 'bg-amber-500',
    danger: 'bg-red-500',
  };

  function isActive(path: string, exact = false): boolean {
    return exact ? $router.path === path : $router.path.startsWith(path);
  }

  const currentItem = $derived(allItems.find((item) => isActive(item.path, item.exact)));
  const pageTitle = $derived(title || currentItem?.label || m.d4_admin());

  // La navigation mobile se ferme a chaque changement de route, sinon le
  // panneau reste ouvert par-dessus la page qui vient de s'afficher.
  $effect(() => {
    void $router.path;
    mobileNavOpen = false;
  });

  function formatMb(bytes: number): string {
    return `${Math.round(bytes / 1024 / 1024)} Mo`;
  }
</script>

<CommandPalette />

<div class="min-h-screen bg-surface">
  <!-- Halo d'ambiance, purement decoratif -->
  <div class="fixed inset-0 pointer-events-none overflow-hidden z-0" aria-hidden="true">
    <div class="absolute -top-40 -left-32 w-[520px] h-[520px] bg-primary/6 rounded-full blur-[130px]"></div>
    <div class="absolute -bottom-40 -right-32 w-[420px] h-[420px] bg-purple-500/5 rounded-full blur-[110px]"></div>
  </div>

  <!-- En-tete collant : la navigation reste atteignable sur les pages longues -->
  <header class="sticky top-0 z-30 border-b border-outline-variant/25 bg-surface-container-lowest/85 backdrop-blur-xl">
    <div class="flex items-center gap-3 px-4 sm:px-6 h-16">
      <button
        type="button"
        onclick={() => (mobileNavOpen = true)}
        aria-label="Ouvrir la navigation"
        class="lg:hidden w-9 h-9 rounded-xl flex items-center justify-center bg-on-surface/6 text-on-surface-variant hover:bg-on-surface/10 hover:text-on-surface transition"
      >
        <Papicon icon="Menu" size={16} />
      </button>

      <a href="/admin" class="flex items-center gap-3 min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-primary">
        <div class="w-9 h-9 shrink-0 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center">
          <Papicon icon="Lock" size={16} class="text-primary" />
        </div>
        <div class="min-w-0 hidden sm:block">
          <p class="text-[12px] font-medium text-primary leading-none truncate">{brandingStore.brandName}</p>
          <h1 class="text-[15px] font-semibold text-on-surface leading-none mt-1 truncate">{m.d4_admin_console()}</h1>
        </div>
      </a>

      <button
        onclick={() => searchStore.show()}
        class="hidden md:flex items-center gap-3 ml-4 px-3.5 h-9 rounded-xl bg-on-surface/5 hover:bg-on-surface/8 border border-outline-variant/25
          text-on-surface-variant hover:text-on-surface transition min-w-64 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Papicon icon="Search" size={14} />
        <span class="flex-1 text-left text-[13px]">{m.d4_search_or_navigate()}</span>
        <kbd class="px-1.5 py-0.5 rounded bg-on-surface/8 border border-outline-variant/25 text-[10px] font-semibold font-mono leading-none">⌘K</kbd>
      </button>

      <div class="flex items-center gap-2 ml-auto">
        <!-- Etat de sante synthetique, toujours visible -->
        <div
          class="hidden sm:flex items-center gap-2 h-8 px-3 rounded-full border text-[12px] font-medium
            {healthError
              ? 'bg-red-500/10 border-red-500/25 text-red-500'
              : shardsHealthy
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 border-amber-500/25 text-amber-600 dark:text-amber-400'}"
          title={health ? `${health.onlineShardCount}/${health.shardCount} shards · ${health.averageShardPing} ms` : ''}
        >
          <span class="w-1.5 h-1.5 rounded-full {healthError ? 'bg-red-500' : shardsHealthy ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse"></span>
          {#if healthError}
            API injoignable
          {:else if health}
            {health.onlineShardCount}/{health.shardCount} shards
          {:else}
            {m.d4_operational()}
          {/if}
        </div>

        <button
          onclick={() => searchStore.show()}
          aria-label={m.d4_search_or_navigate()}
          class="md:hidden w-9 h-9 flex items-center justify-center rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-on-surface-variant transition"
        >
          <Papicon icon="Search" size={14} />
        </button>

        <a
          href="/"
          class="flex items-center gap-2 h-9 px-3 rounded-xl text-[13px] font-semibold bg-on-surface/6 hover:bg-on-surface/10
            text-on-surface-variant hover:text-on-surface border border-outline-variant/25 transition focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Papicon icon="ArrowLeft" size={13} />
          <span class="hidden sm:block">{m.d4_dashboard()}</span>
        </a>
      </div>
    </div>
  </header>

  <div class="relative z-10 flex">
    <!-- Barre laterale (desktop) -->
    <aside
      class="hidden lg:flex flex-col shrink-0 sticky top-16 h-[calc(100vh-4rem)] border-r border-outline-variant/25
        bg-surface-container-lowest/50 transition-[width] duration-200 {sidebarCollapsed ? 'w-[76px]' : 'w-64'}"
    >
      <nav class="flex-1 overflow-y-auto flex flex-col gap-5 p-3" aria-label="Navigation administration">
        {#each navGroups as group (group.label)}
          <div class="space-y-0.5">
            {#if !sidebarCollapsed}
              <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant px-3 pb-1.5">{group.label}</p>
            {:else}
              <div class="h-px bg-outline-variant/25 mx-3 mb-2"></div>
            {/if}

            {#each group.items as item (item.path)}
              {@const active = isActive(item.path, item.exact)}
              <a
                href={item.path}
                title={sidebarCollapsed ? item.label : undefined}
                aria-current={active ? 'page' : undefined}
                class="group relative flex items-center gap-3 h-10 rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-primary
                  {sidebarCollapsed ? 'justify-center px-0' : 'px-2.5'}
                  {active
                    ? 'bg-primary/12 text-primary'
                    : 'text-on-surface-variant hover:bg-on-surface/6 hover:text-on-surface'}"
              >
                {#if active}
                  <span class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full"></span>
                {/if}
                <span
                  class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center transition-colors
                    {active ? 'bg-primary/15 text-primary' : 'text-on-surface-variant group-hover:text-on-surface'}"
                >
                  <Papicon icon={item.icon} size={15} />
                </span>
                {#if !sidebarCollapsed}
                  <span class="text-[13.5px] font-semibold leading-none truncate">{item.label}</span>
                {/if}
              </a>
            {/each}
          </div>
        {/each}
      </nav>

      <div class="shrink-0 border-t border-outline-variant/25 p-3 space-y-3">
        {#if health && !sidebarCollapsed}
          <div class="space-y-2">
            <div class="flex items-center justify-between text-[11px]">
              <span class="font-semibold uppercase tracking-wider text-on-surface-variant">Mémoire</span>
              <span class="font-mono font-semibold tabular-nums {toneText[heapTone]}">{heapPercent}%</span>
            </div>
            <div class="h-1.5 bg-on-surface/8 rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all duration-700 {toneBar[heapTone]}" style="width: {heapPercent}%"></div>
            </div>
            <div class="flex items-center justify-between text-[11px] text-on-surface-variant">
              <span class="tabular-nums">{formatMb(health.heapUsed)} / {formatMb(health.heapTotal)}</span>
              <AdminSparkline values={heapHistory} color="var(--primary-color)" width={48} height={14} />
            </div>

            <div class="flex items-center justify-between pt-1 border-t border-outline-variant/20">
              <span class="flex items-center gap-1.5 text-[11px]">
                <span class="w-1.5 h-1.5 rounded-full {toneBar[pingTone]}"></span>
                <span class="font-semibold tabular-nums {toneText[pingTone]}">{health.averageShardPing} ms</span>
              </span>
              <AdminSparkline values={pingHistory} color="#0ea5e9" width={48} height={14} />
            </div>
          </div>
        {/if}

        <button
          type="button"
          onclick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Déplier la navigation' : 'Replier la navigation'}
          class="w-full h-9 rounded-xl flex items-center justify-center gap-2 bg-on-surface/5 hover:bg-on-surface/10
            text-on-surface-variant hover:text-on-surface text-[12px] font-semibold transition focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Papicon icon={sidebarCollapsed ? 'ChevronRight' : 'ChevronLeft'} size={13} />
          {#if !sidebarCollapsed}Replier{/if}
        </button>
      </div>
    </aside>

    <!-- Navigation mobile en panneau, au lieu du bandeau d'onglets serre -->
    {#if mobileNavOpen}
      <div class="lg:hidden fixed inset-0 z-40 flex">
        <button
          type="button"
          aria-label="Fermer la navigation"
          onclick={() => (mobileNavOpen = false)}
          class="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        ></button>
        <nav
          class="relative w-72 max-w-[85vw] h-full bg-surface-container-lowest border-r border-outline-variant/25 overflow-y-auto p-4 space-y-5 animate-in slide-in-from-left duration-200"
          aria-label="Navigation administration"
        >
          <div class="flex items-center justify-between">
            <p class="text-sm font-semibold text-on-surface">{m.d4_admin_console()}</p>
            <button
              type="button"
              onclick={() => (mobileNavOpen = false)}
              aria-label="Fermer"
              class="w-8 h-8 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-on-surface/8"
            >
              <Papicon icon="X" size={15} />
            </button>
          </div>

          {#each navGroups as group (group.label)}
            <div class="space-y-0.5">
              <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant px-2 pb-1">{group.label}</p>
              {#each group.items as item (item.path)}
                {@const active = isActive(item.path, item.exact)}
                <a
                  href={item.path}
                  aria-current={active ? 'page' : undefined}
                  class="flex items-center gap-3 h-11 px-2.5 rounded-xl transition-colors
                    {active ? 'bg-primary/12 text-primary' : 'text-on-surface-variant hover:bg-on-surface/6 hover:text-on-surface'}"
                >
                  <Papicon icon={item.icon} size={16} />
                  <span class="text-sm font-semibold">{item.label}</span>
                </a>
              {/each}
            </div>
          {/each}
        </nav>
      </div>
    {/if}

    <!-- Contenu -->
    <main class="flex-1 min-w-0">
      <div class="px-4 sm:px-6 lg:px-8 py-6 space-y-6 max-w-[1600px]">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <nav class="flex items-center gap-1.5 text-[12px] text-on-surface-variant mb-1.5" aria-label="Fil d'Ariane">
              <a href="/admin" class="font-semibold hover:text-on-surface transition-colors">{m.d4_admin()}</a>
              <Papicon icon="ChevronRight" size={11} />
              <span class="font-semibold text-on-surface">{currentItem?.label ?? pageTitle}</span>
            </nav>
            <h1 class="text-[22px] sm:text-2xl font-semibold text-on-surface tracking-tight leading-tight">{pageTitle}</h1>
            {#if description}
              <p class="text-[13.5px] text-on-surface-variant mt-1 max-w-2xl leading-relaxed">{description}</p>
            {/if}
          </div>

          {#if actions}
            <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
          {/if}
        </div>

        {@render children?.()}
      </div>
    </main>
  </div>
</div>
