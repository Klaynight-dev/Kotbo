<script lang="ts">
  import { fade } from 'svelte/transition';
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { notificationsStore } from '../stores/notifications.svelte';
  import { sidebarStore } from '../stores/sidebar.svelte';
  import { navigationStore, isActiveNavItem as matchNavItem, type NavGroup } from '../stores/navigation.svelte';
  import { prefetchRoute } from '../lazyRoutes';
  import { portal } from '../actions/portal';
  import { lockBodyScroll, unlockBodyScroll } from '../scrollLock';
  import { isPageBeta, isPageWip, type PageConfig } from '../config/pages';
  import { resolveGuildIconSrc, resolveUserAvatarSrc } from '../discordMedia';
  import { m } from '../i18n';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';

  let isDesktop = $state(
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true,
  );

  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => { isDesktop = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  const collapsed  = $derived(sidebarStore.collapsed);
  const mobileOpen = $derived(sidebarStore.mobileOpen ?? false);
  const isCollapsed = $derived(collapsed && isDesktop);

  // Shared counter rather than a bare class toggle: a modal opened from the
  // drawer must not release the page when only one of the two closes.
  $effect(() => {
    if (isDesktop || !mobileOpen) return;
    lockBodyScroll();
    return unlockBodyScroll;
  });

  $effect(() => {
    $router.path;
    if (!isDesktop) sidebarStore.closeMobile?.();
  });

  let activeTooltip = $state<{ text: string; top: number } | null>(null);

  function showTooltip(e: MouseEvent, text: string): void {
    if (!isCollapsed) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    activeTooltip = { text, top: rect.top + rect.height / 2 };
  }

  const hideTooltip = (): void => { activeTooltip = null; };

  $effect(() => { if (!isCollapsed) activeTooltip = null; });

  const currentGuild = $derived(
    authStore.guilds.find((g) => g.id === authStore.selectedGuildId),
  );

  // Permissions, grouping and favourites live in navigationStore so the mobile
  // navigation sheet renders exactly the same set of pages.
  const isModuleDisabled = navigationStore.isModuleDisabled;
  const isStaffServerGuild = $derived(navigationStore.isStaffServer);
  const navGroups = $derived(navigationStore.groups);

  const itemLabel = (item: PageConfig): string => {
    if (isPageWip(item))  return `${item.name} (WIP)`;
    if (isPageBeta(item)) return `${item.name} (Bêta)`;
    return item.name;
  };

  function loadGroupStates(): Record<string, boolean> {
    try {
      const s = typeof localStorage !== 'undefined' && localStorage.getItem('sidebar_groups');
      return s ? (JSON.parse(s) as Record<string, boolean>) : {};
    } catch { return {}; }
  }

  let groupStates = $state<Record<string, boolean>>(loadGroupStates());

  // Progressive disclosure : les groupes secondaires démarrent repliés.
  // Le choix explicite de l'utilisateur (groupStates) reste prioritaire,
  // et le groupe contenant la page active s'ouvre toujours.
  const DEFAULT_COLLAPSED = new Set(['leveling', 'economy', 'community', 'crossserver']);

  const isGroupCollapsed = (key: string): boolean => {
    if (navGroups.find((g) => g.key === key)?.items.some((i) => isActiveNavItem(i.href))) {
      return false;
    }
    if (groupStates[key] === undefined) return DEFAULT_COLLAPSED.has(key);
    return groupStates[key] === true;
  };

  function toggleGroup(key: string): void {
    groupStates = { ...groupStates, [key]: !isGroupCollapsed(key) };
    try { localStorage.setItem('sidebar_groups', JSON.stringify(groupStates)); } catch {}
  }
  let searchQuery       = $state('');
  let showOnlyFavorites = $state(false);

  const favorites = $derived(navigationStore.favorites);

  function toggleFavorite(href: string, e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    navigationStore.toggleFavorite(href);
  }

  const filteredGroups = $derived.by((): NavGroup[] => {
    const groups = showOnlyFavorites
      ? navGroups
          .map((g) => ({ ...g, items: g.items.filter((i) => favorites.includes(i.href)) }))
          .filter((g) => g.items.length > 0)
      : navGroups;

    const q = searchQuery.trim().toLowerCase();
    if (!q) return groups;

    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => i.name.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  });

  function isActiveNavItem(href: string): boolean {
    return matchNavItem(href, $router.path, $router.url);
  }

  let swipeStartX = 0;
  let swipeStartY = 0;

  function onTouchStart(e: TouchEvent): void {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }

  function onTouchEnd(e: TouchEvent): void {
    const dx = swipeStartX - e.changedTouches[0].clientX;
    const dy = Math.abs(swipeStartY - e.changedTouches[0].clientY);

    if (dx > 60 && dy < 80) sidebarStore.closeMobile?.();
  }

  const profileHref = $derived(
    authStore.user?.id ? `/profile/${authStore.user.id}` : '/profile',
  );

  const userAvatar = $derived(
    resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar),
  );
  const currentGuildIcon = $derived(
    currentGuild ? resolveGuildIconSrc(currentGuild.id, currentGuild.icon) : null,
  );

  import { brandingStore } from '../stores/branding.svelte';
  const LOGO_URL = $derived(brandingStore.logoUrl || '/favicon.svg');
</script>

{#if !isDesktop && mobileOpen}
  <div
    role="presentation"
    class="mobile-sidebar-backdrop fixed inset-0 bg-black/30 z-40"
    transition:fade={{ duration: 150 }}
    onclick={() => sidebarStore.closeMobile?.()}
  ></div>
{/if}

<aside
  id="dashboard-sidebar"
  inert={!isDesktop && !mobileOpen}
  aria-hidden={!isDesktop && !mobileOpen}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  class="
 fixed left-0 top-0 h-dvh flex flex-col z-50
    bg-surface-container-lowest
    border-r border-outline-variant
    will-change-transform transition-[transform,width] duration-200 ease-in-out
    app-sidebar w-72
    {!isDesktop && mobileOpen ? 'translate-x-0 shadow-lg' : ''}
    {!isDesktop && !mobileOpen ? '-translate-x-full' : ''}
    lg:translate-x-0 lg:shadow-none
    {isCollapsed ? 'lg:w-[4.5rem]' : 'lg:w-60'}
  "
>

  <button
    type="button"
    onclick={() => sidebarStore.toggle()}
    class="
 absolute -right-3 top-14 z-10
      w-6 h-6 rounded-full border border-outline-variant
      bg-surface-container-lowest shadow-sm
      hidden lg:flex items-center justify-center
      transition-colors duration-150
      hover:bg-surface-container hover:text-primary
      text-on-surface-variant
    "
    aria-label={isCollapsed ? 'Étendre la sidebar' : 'Réduire la sidebar'}
  >
    <div class="transition-transform duration-200 {isCollapsed ? 'rotate-180' : ''}">
      <Papicon icon="chevrons-left" size={12} />
    </div>
  </button>

  <div class="flex items-center gap-3 px-4 pt-4 pb-3 {isCollapsed ? 'lg:justify-center' : ''}">
    <div class="w-8 h-8 shrink-0">
      <img alt={brandingStore.brandName} src={LOGO_URL} class="w-full h-full object-cover rounded-lg" />
    </div>

    {#if !isCollapsed}
      <div class="flex flex-col min-w-0 flex-1">
        <span class="text-sm font-semibold text-on-surface leading-none truncate">{brandingStore.brandName}</span>
        {#if isStaffServerGuild}
          <span class="inline-flex items-center gap-1 mt-0.5 w-fit px-1.5 py-0.5 rounded text-[9px] font-medium tracking-wide uppercase bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
            Serveur Staff
          </span>
        {:else}
          <span class="text-[10px] text-on-surface-variant mt-0.5">Dashboard</span>
        {/if}
      </div>

      {#if navigationStore.isAdmin}
        <a
          href="/management"
          title={m.mgmt_page_title()}
          aria-label={m.mgmt_page_title()}
          aria-current={isActiveNavItem('/management') ? 'page' : undefined}
          onmouseenter={() => prefetchRoute('/management')}
          onfocus={() => prefetchRoute('/management')}
          class="flex items-center justify-center w-8 h-8 shrink-0 rounded-md transition-colors {isActiveNavItem('/management')
            ? 'text-primary bg-primary/10'
            : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}"
        >
          <Papicon icon="settings" size={16} />
        </a>
      {/if}

      <button
        type="button"
        onclick={() => sidebarStore.closeMobile?.()}
        class="flex items-center justify-center w-8 h-8 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors lg:hidden"
        aria-label="Fermer la navigation"
      >
        <Papicon icon="x" size={16} />
      </button>
    {/if}
  </div>

  {#if !isDesktop && !isCollapsed}
    <button
      type="button"
      onclick={() => {
        sidebarStore.closeMobile();
        serverSwitcherStore.show();
      }}
      disabled={authStore.guilds.length <= 1}
      class="mx-3 mb-3 flex min-h-12 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 text-left transition-colors hover:bg-surface-container-high disabled:cursor-default"
      aria-label={authStore.guilds.length > 1 ? 'Changer de serveur' : 'Serveur actuel'}
    >
      {#if currentGuildIcon}
        <img src={currentGuildIcon} alt="" width="32" height="32" class="h-8 w-8 shrink-0 rounded-lg object-cover" />
      {:else}
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
          {currentGuild?.name?.charAt(0) ?? '?'}
        </span>
      {/if}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-on-surface">{currentGuild?.name ?? 'Serveur'}</span>
        <span class="block text-[11px] text-on-surface-variant">
          {authStore.guilds.length > 1 ? 'Toucher pour changer' : 'Serveur actuel'}
        </span>
      </span>
      {#if authStore.guilds.length > 1}
        <Papicon icon="chevron-right" size={16} class="shrink-0 text-on-surface-variant/60" />
      {/if}
    </button>
  {/if}

  {#if !isCollapsed}
    <div class="px-3 pb-2 flex items-center gap-1.5">
      <div class="relative flex-1">
        <input
          type="search"
          placeholder={m.sidebar_search_placeholder()}
          bind:value={searchQuery}
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          class="
 w-full pl-8 pr-8 py-1.5 text-xs rounded-md
            bg-surface-container border border-outline-variant
            text-on-surface placeholder:text-on-surface-variant/50
            focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20
            transition-all duration-150
          "
        />
        <div class="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/40 pointer-events-none">
          <Papicon icon="search" size={13} />
        </div>
        {#if searchQuery}
          <button
            type="button"
            onclick={() => (searchQuery = '')}
            class="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-on-surface-variant/40 hover:text-on-surface transition-colors"
            aria-label="Effacer la recherche"
          >
            <Papicon icon="x" size={11} />
          </button>
        {:else}
          <kbd class="absolute right-2 top-1/2 -translate-y-1/2 px-1 py-0.5 rounded bg-surface-container-high text-[9px] font-medium font-mono leading-none text-on-surface-variant/40 pointer-events-none hidden lg:block">
            /
          </kbd>
        {/if}
      </div>

      <button
        type="button"
        onclick={() => (showOnlyFavorites = !showOnlyFavorites)}
        aria-label="Filtrer par favoris"
        aria-pressed={showOnlyFavorites}
        title={showOnlyFavorites ? 'Afficher tout' : 'Favoris'}
        class="
 flex items-center justify-center w-7 h-7 rounded-md border
          transition-colors duration-150 shrink-0
          {showOnlyFavorites
            ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-600 dark:text-amber-400'
            : 'bg-surface-container border-outline-variant text-on-surface-variant/50 hover:text-on-surface hover:bg-surface-container-high'}
        "
      >
        <Papicon icon="star" size={13} class={showOnlyFavorites ? 'fill-amber-500 text-amber-500' : ''} />
      </button>
    </div>
  {/if}

  <nav
    class="flex-1 overflow-y-auto overscroll-contain scrollbar-hide pb-2 {isCollapsed ? 'lg:px-2' : 'px-3'}"
    aria-label="Navigation principale"
  >
    {#each filteredGroups as group, gi (group.key)}

      {#if isCollapsed}
        {#if gi > 0}<div class="h-2" aria-hidden="true"></div>{/if}

        {#each group.items as item (item.href)}
          <a
            href={item.href}
            onmouseenter={(e) => { showTooltip(e, itemLabel(item)); prefetchRoute(item.href); }}
            onfocus={() => prefetchRoute(item.href)}
            onmouseleave={hideTooltip}
            aria-label={itemLabel(item)}
            aria-current={isActiveNavItem(item.href) ? 'page' : undefined}
            class="
 relative flex items-center justify-center w-full py-2 rounded-md
              transition-colors duration-150 group
              {isActiveNavItem(item.href)
                ? 'text-primary bg-primary/8'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}
              {isModuleDisabled(item.featureKey, item.href) ? 'opacity-40' : ''}
            "
          >
            {#if isActiveNavItem(item.href)}
              <div class="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-full" aria-hidden="true"></div>
            {/if}

            <div class="relative">
              <Papicon icon={item.icon} size={18} />
              {#if isPageWip(item)}
                <span class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="WIP"></span>
              {:else if isPageBeta(item)}
                <span class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-purple-500" aria-label="Bêta"></span>
              {/if}
            </div>

            {#if item.name === 'Inbox' && notificationsStore.unreadCount > 0}
              <div
                class="absolute top-0.5 right-1 min-w-[14px] h-[14px] px-0.5 bg-primary text-white text-[8px] font-semibold rounded-full flex items-center justify-center"
                aria-label="{notificationsStore.unreadCount} notifications non lues"
              >
                {notificationsStore.unreadCount > 9 ? '9+' : notificationsStore.unreadCount}
              </div>
            {/if}
          </a>
        {/each}

      {:else}
        {#if gi > 0}
          <div class="my-1.5 border-t border-outline-variant" role="separator"></div>
        {/if}

        <button
          type="button"
          onclick={() => toggleGroup(group.key)}
          aria-expanded={!isGroupCollapsed(group.key)}
          aria-controls="nav-group-{group.key}"
          class="
 w-full flex items-center gap-2 px-2 py-1.5 mb-0.5 rounded-md
            transition-colors hover:bg-surface-container
            group/label sticky top-0 z-10
            bg-surface-container-lowest
          "
        >
          <span class="flex-1 text-left text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">
            {group.label}
          </span>
          <div
            aria-hidden="true"
            class="text-on-surface-variant/30 group-hover/label:text-on-surface-variant transition-transform duration-150 {isGroupCollapsed(group.key) ? '-rotate-90' : ''}"
          >
            <Papicon icon="chevron-down" size={11} />
          </div>
        </button>

        {#if !isGroupCollapsed(group.key)}
          <div id="nav-group-{group.key}" class="space-y-px mb-1">
            {#each group.items as item (item.href)}
              <div
                class="
 relative flex items-center rounded-md
                  transition-colors duration-150 group
                  {isActiveNavItem(item.href)
                    ? 'text-primary bg-primary/6 font-medium'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}
                  {isModuleDisabled(item.featureKey, item.href) ? 'opacity-40' : ''}
                "
              >
                {#if isActiveNavItem(item.href)}
                  <div class="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-full" aria-hidden="true"></div>
                {/if}

                <a
                  href={item.href}
                  onmouseenter={() => prefetchRoute(item.href)}
                  onfocus={() => prefetchRoute(item.href)}
                  aria-current={isActiveNavItem(item.href) ? 'page' : undefined}
                  class="flex-1 flex items-center gap-2.5 pl-3 pr-2 py-2 min-w-0"
                >
                  <Papicon
                    icon={item.icon}
                    size={16}
                    class="shrink-0 transition-colors duration-150 {isActiveNavItem(item.href) ? 'text-primary' : 'text-on-surface-variant/60 group-hover:text-on-surface/70'}"
                  />
                  <span class="flex-1 min-w-0 text-[13px] leading-none truncate">{item.name}</span>
                </a>

                <div class="flex items-center gap-1 pr-2 shrink-0">
                  {#if isPageWip(item)}
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-medium tracking-wide uppercase bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/20">
                      WIP
                    </span>
                  {:else if isPageBeta(item)}
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-medium tracking-wide uppercase bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20">
                      BETA
                    </span>
                  {/if}

                  {#if item.name === 'Inbox' && notificationsStore.unreadCount > 0}
                    <div
                      class="min-w-[16px] h-[16px] px-0.5 bg-primary text-white text-[9px] font-medium rounded-full flex items-center justify-center"
                      aria-label="{notificationsStore.unreadCount} messages non lus"
                    >
                      {notificationsStore.unreadCount > 99 ? '99+' : notificationsStore.unreadCount}
                    </div>
                  {/if}

                  <button
                    type="button"
                    onclick={(e) => toggleFavorite(item.href, e)}
                    aria-label={favorites.includes(item.href) ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                    aria-pressed={favorites.includes(item.href)}
                    class="
 flex items-center justify-center w-6 h-6 rounded
                      transition-all duration-150
                      text-on-surface-variant/30 hover:text-amber-500
                      {favorites.includes(item.href)
                        ? 'opacity-100 text-amber-500'
                        : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}
                    "
                  >
                    <Papicon icon="star" size={12} class={favorites.includes(item.href) ? 'fill-amber-500 text-amber-500' : ''} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}

    {:else}
      {#if !isCollapsed}
        <div class="flex flex-col items-center py-8 text-center text-on-surface-variant/50 px-4">
          {#if showOnlyFavorites}
            <Papicon icon="star" size={20} class="mb-2 text-amber-400" />
            <p class="text-xs">{m.sidebar_no_favorites()}</p>
          {:else}
            <Papicon icon="search" size={20} class="mb-2" />
            <p class="text-xs">{m.sidebar_no_results({ query: searchQuery })}</p>
          {/if}
        </div>
      {/if}
    {/each}
  </nav>

  <div class="border-t border-outline-variant {isCollapsed ? 'lg:px-2 py-2' : 'px-3 py-2'} space-y-0.5">

    {#if authStore.isBotAdmin}
      <a
        href="/admin"
        onmouseenter={(e) => showTooltip(e, 'Administration')}
        onmouseleave={hideTooltip}
        aria-label={isCollapsed ? 'Administration' : undefined}
        aria-current={isActiveNavItem('/admin') ? 'page' : undefined}
        class="
 relative flex items-center rounded-md
          transition-colors duration-150 group
          {isCollapsed ? 'lg:justify-center py-2' : 'gap-2.5 px-3 py-2'}
          {isActiveNavItem('/admin')
            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/8'
            : 'text-on-surface-variant hover:text-amber-600 dark:hover:text-amber-400 hover:bg-surface-container'}
        "
      >
        <Papicon icon="lock" size={isCollapsed ? 18 : 16} class="shrink-0" />
        {#if !isCollapsed}
          <span class="text-[13px]">{m.nav_administration()}</span>
        {/if}
      </a>
    {/if}

    <!-- Facturation : au-dessus du profil et hors des groupes de modules, comme
         l'entrée Administration. Elle n'apparaît que pour ceux qui ont à la
         voir - l'administrateur, celui qui paie, ou tout le staff quand le
         serveur a choisi de leur ouvrir (`billingAccess`, calculé par l'API). -->
    {#if navigationStore.canViewBilling}
      <a
        href="/billing"
        onmouseenter={(e) => showTooltip(e, m.nav_billing())}
        onmouseleave={hideTooltip}
        aria-label={isCollapsed ? m.nav_billing() : undefined}
        aria-current={isActiveNavItem('/billing') ? 'page' : undefined}
        class="
          relative flex items-center rounded-md
          transition-colors duration-150 group
          {isCollapsed ? 'lg:justify-center py-2' : 'gap-2.5 px-3 py-2'}
          {isActiveNavItem('/billing')
            ? 'text-primary bg-primary/8'
            : 'text-on-surface-variant hover:text-primary hover:bg-surface-container'}
        "
      >
        <Papicon icon="credit-card" size={isCollapsed ? 18 : 16} class="shrink-0" />
        {#if !isCollapsed}
          <span class="text-[13px]">{m.nav_billing()}</span>
        {/if}
      </a>
    {/if}

    <a
      href={profileHref}
      onmouseenter={(e) => showTooltip(e, authStore.user?.username ?? 'Mon Profil')}
      onmouseleave={hideTooltip}
      aria-current={isActiveNavItem(profileHref) ? 'page' : undefined}
      class="flex items-center {isCollapsed ? 'lg:justify-center py-2' : 'gap-2.5 px-2 py-2'} rounded-md transition-colors duration-150 hover:bg-surface-container group"
    >
      <div class="shrink-0 w-7 h-7">
        <img
          src={userAvatar}
          alt="Avatar de {authStore.user?.username ?? 'utilisateur'}"
          referrerpolicy="no-referrer"
          class="w-full h-full rounded-md object-cover ring-1 ring-outline-variant"
        />
      </div>
      {#if !isCollapsed}
        <div class="flex flex-col min-w-0">
          <span class="text-[12px] font-medium text-on-surface truncate leading-none">
            {authStore.user?.username ?? '…'}
          </span>
          <span class="text-[10px] text-on-surface-variant mt-0.5">{m.nav_my_profile()}</span>
        </div>
      {/if}
    </a>

  </div>
</aside>

{#if activeTooltip && isCollapsed}
  <div
    use:portal
    role="tooltip"
    class="fixed z-100 -translate-y-1/2 pointer-events-none bg-surface-container-highest text-on-surface border border-outline-variant rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap shadow-sm animate-in fade-in"
    style="left: calc(4.5rem + 8px); top: {activeTooltip.top}px"
  >
    {activeTooltip.text}
  </div>
{/if}

<style>
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
</style>
