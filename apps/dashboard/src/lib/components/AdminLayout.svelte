<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount, onDestroy } from 'svelte';
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import { fetchAdminStats } from '../api';
  import { brandingStore } from '../stores/branding.svelte';
  import { m } from '../i18n';

  let { children }: { children?: Snippet } = $props();

  interface NavItem {
    path: string;
    label: string;
    icon: string;
    exact?: boolean;
  }

  interface NavGroup {
    label: string;
    items: NavItem[];
  }

  // ── Feature 10: sidebar health state ──────────────────────
  interface HealthStats {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    averageShardPing: number;
    onlineShardCount: number;
    shardCount: number;
  }

  let health = $state<HealthStats | null>(null);
  let healthInterval: ReturnType<typeof setInterval> | null = null;
  let paletteOpen = $state(false);

  async function fetchHealth() {
    try {
      const data = await fetchAdminStats() as any;
      health = {
        heapUsed: data.memoryUsage?.heapUsed ?? 0,
        heapTotal: data.memoryUsage?.heapTotal ?? 1,
        rss: data.memoryUsage?.rss ?? 0,
        averageShardPing: data.averageShardPing ?? 0,
        onlineShardCount: data.onlineShardCount ?? 0,
        shardCount: data.shardCount ?? 0,
      };
    } catch {}
  }

  onMount(() => {
    void fetchHealth();
    healthInterval = setInterval(fetchHealth, 30_000);
  });

  onDestroy(() => {
    if (healthInterval) clearInterval(healthInterval);
  });

  const heapPercent = $derived(
    health ? Math.round((health.heapUsed / health.heapTotal) * 100) : 0
  );

  function formatBytes(b: number): string {
    if (b === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(0)) + ' ' + sizes[i];
  }
  // ─────────────────────────────────────────────────────────

  const navGroups: NavGroup[] = [
    {
      label: m.d4_nav_supervision(),
      items: [
        { path: '/admin', label: m.d4_nav_overview(), icon: 'activity', exact: true },
        { path: '/admin/servers', label: m.d4_nav_servers(), icon: 'Server' },
        { path: '/admin/shards', label: m.d4_nav_shards(), icon: 'Zap' },
        { path: '/admin/modules', label: m.d4_nav_modules(), icon: 'Box' },
        { path: '/admin/broadcast', label: m.d4_nav_broadcast(), icon: 'Megaphone' },
      ]
    },
    {
      label: m.d4_nav_security_filtering(),
      items: [
        { path: '/admin/security', label: m.d4_nav_security(), icon: 'ShieldCheck' },
        { path: '/admin/content', label: m.d4_nav_global_words(), icon: 'filter' },
        { path: '/admin/activation', label: m.d4_nav_activation_codes(), icon: 'Key' },
        { path: '/admin/whitelabel', label: m.d4_nav_whitelabel(), icon: 'Layers' },
      ]
    },
    {
      label: m.d4_nav_compliance(),
      items: [
        { path: '/admin/gdpr', label: m.d4_nav_gdpr_export(), icon: 'ShieldCheck' },
      ]
    },
    {
      label: m.d4_nav_system(),
      items: [
        { path: '/admin/config', label: m.d4_nav_advanced(), icon: 'Settings' },
      ]
    }
  ];

  const allItems: NavItem[] = navGroups.flatMap(g => g.items);

  function isActive(path: string, exact = false): boolean {
    if (exact) return $router.path === path;
    return $router.path.startsWith(path);
  }

  const currentLabel = $derived(
    allItems.find(item => isActive(item.path, item.exact))?.label ?? m.d4_admin()
  );
</script>

<CommandPalette bind:open={paletteOpen} />

<div class="min-h-screen animate-in fade-in duration-500">
  <!-- Ambient background glow -->
  <div class="fixed inset-0 pointer-events-none overflow-hidden z-0">
    <div class="absolute -top-32 -left-32 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[120px]"></div>
    <div class="absolute -bottom-32 -right-32 w-[400px] h-[400px] bg-purple-500/4 rounded-full blur-[100px]"></div>
    <div class="absolute top-1/2 left-1/3 w-[300px] h-[300px] bg-indigo-500/3 rounded-full blur-none hidden"></div>
  </div>

  <!-- Header -->
  <header class="relative z-10 border-b border-outline-variant/10 bg-surface-container-lowest/80">
    <div class="flex items-center justify-between px-6 py-4">
      <!-- Brand -->
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center shadow-inner">
          <Papicon icon="Lock" size={16} class="text-primary" />
        </div>
        <div>
          <p class="text-[13px] font-medium text-primary/80 leading-none">{brandingStore.brandName}</p>
          <h1 class="text-base font-semibold text-on-surface leading-none mt-0.5">{m.d4_admin_console()}</h1>
        </div>
      </div>

      <!-- Center: Cmd+K search trigger -->
      <button
        onclick={() => paletteOpen = true}
        class="hidden md:flex items-center gap-3 px-4 py-2 rounded-xl bg-on-surface/5 hover:bg-on-surface/8 border border-outline-variant/10 text-on-surface-variant/40 hover:text-on-surface/60 transition-all duration-200 text-sm font-medium min-w-52"
      >
        <Papicon icon="Search" size={14} />
        <span class="flex-1 text-left text-xs">{m.d4_search_or_navigate()}</span>
        <div class="flex items-center gap-1">
          <kbd class="px-1.5 py-0.5 rounded bg-on-surface/8 border border-outline-variant/10 text-[11px] font-semibold font-mono leading-none">⌘K</kbd>
        </div>
      </button>

      <!-- Right: Status badge + back button -->
      <div class="flex items-center gap-3">
        <div class="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-success/10 border border-success/20 text-success text-xs font-medium">
          <span class="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
          {m.d4_operational()}
        </div>
        <!-- Mobile Cmd+K -->
        <button
          onclick={() => paletteOpen = true}
          class="md:hidden w-8 h-8 flex items-center justify-center rounded-xl bg-on-surface/5 hover:bg-on-surface/10 border border-outline-variant/10 text-on-surface-variant transition-all"
        >
          <Papicon icon="Search" size={14} />
        </button>
        <a
          href="/"
          class="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold bg-on-surface/5 hover:bg-on-surface/10 text-on-surface-variant hover:text-on-surface border border-outline-variant/10 transition-all duration-200"
        >
          <Papicon icon="ArrowLeft" size={12} />
          <span class="hidden sm:block">{m.d4_dashboard()}</span>
        </a>
      </div>
    </div>

    <!-- Mobile scrollable tabs -->
    <div class="lg:hidden border-t border-outline-variant/10 overflow-x-auto scrollbar-none">
      <div class="flex items-center gap-1 px-4 py-2 w-max">
        {#each allItems as item}
          <a
            href={item.path}
            class="flex items-center gap-2 px-3.5 py-2 rounded-xl font-bold text-[11px] whitespace-nowrap transition-all duration-200
 {isActive(item.path, item.exact)
                ? 'bg-primary text-on-primary shadow-md shadow-primary/25'
                : 'text-on-surface-variant/60 hover:bg-on-surface/5 hover:text-on-surface'}"
          >
            <Papicon icon={item.icon} size={12} />
            {item.label}
          </a>
        {/each}
      </div>
    </div>
  </header>

  <!-- Main layout -->
  <div class="relative z-10 flex">
    <!-- Desktop sidebar -->
    <aside class="hidden lg:flex flex-col w-72 shrink-0 min-h-[calc(100vh-73px)] border-r border-outline-variant/10 bg-surface-container-lowest/50">
      <nav class="flex flex-col gap-6 p-5 flex-1">
        {#each navGroups as group}
          <div class="space-y-1">
            <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant/30 px-3 mb-2">{group.label}</p>

            {#each group.items as item}
              {@const active = isActive(item.path, item.exact)}
              <a
                href={item.path}
                class="group relative flex items-center gap-3 px-3.5 py-2.5 rounded-xl transition-all duration-200
 {active
                    ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                    : 'text-on-surface-variant/60 hover:bg-on-surface/5 hover:text-on-surface border border-transparent'}"
              >
                {#if active}
                  <div class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-r-full"></div>
                {/if}
                <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-200
 {active ? 'bg-primary/20 text-primary' : 'bg-on-surface/5 text-on-surface-variant/50 group-hover:bg-on-surface/10 group-hover:text-on-surface'}">
                  <Papicon icon={item.icon} size={15} />
                </div>
                <span class="font-bold text-sm leading-none">{item.label}</span>
                {#if active}
                  <Papicon icon="ChevronRight" size={14} class="ml-auto text-primary/60" />
                {/if}
              </a>
            {/each}
          </div>
        {/each}
      </nav>

      <!-- Feature 10: Sidebar health footer -->
      <div class="p-5 border-t border-outline-variant/10 space-y-3">
        {#if health}
          <!-- Heap bar -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-[10px]">
              <span class="font-semibold uppercase tracking-widest text-on-surface-variant/30">Heap</span>
              <span class="font-mono font-semibold {heapPercent > 80 ? 'text-red-400' : heapPercent > 60 ? 'text-amber-400' : 'text-emerald-400'}">
                {heapPercent}%
              </span>
            </div>
            <div class="h-1.5 bg-on-surface/5 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-1000
 {heapPercent > 80 ? 'bg-red-500' : heapPercent > 60 ? 'bg-amber-500' : 'bg-emerald-500'}"
                style="width: {heapPercent}%"
              ></div>
            </div>
          </div>

          <!-- Ping + shards row -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-1.5 text-[10px]">
              <div class="w-1.5 h-1.5 rounded-full {health.averageShardPing < 100 ? 'bg-emerald-400' : health.averageShardPing < 200 ? 'bg-amber-400' : 'bg-red-400'} animate-pulse"></div>
              <span class="font-semibold text-on-surface-variant/40">{health.averageShardPing}ms</span>
            </div>
            <div class="text-[10px] font-semibold text-on-surface-variant/30">
              {health.onlineShardCount}/{health.shardCount} shards
            </div>
          </div>
        {/if}

        <!-- Access notice -->
        <div class="px-3 py-3 rounded-xl bg-on-surface/3 border border-outline-variant/5 space-y-1">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/30">{m.d4_restricted_access()}</p>
          <p class="text-xs text-on-surface-variant/50 font-medium">{m.d4_kotbo_admins_only()}</p>
        </div>
      </div>
    </aside>

    <!-- Page content -->
    <main class="flex-1 min-w-0 p-6 lg:p-8">
      <!-- Breadcrumb -->
      <div class="flex items-center gap-2 mb-6 text-xs text-on-surface-variant/40 font-medium">
        <span class="font-bold text-on-surface-variant/30">{m.d4_admin()}</span>
        <Papicon icon="ChevronRight" size={12} class="text-on-surface-variant/20" />
        <span class="text-on-surface-variant/60 font-bold">{currentLabel}</span>
      </div>

      {@render children?.()}
    </main>
  </div>
</div>
