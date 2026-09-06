<script lang="ts">
  /**
   * Inbox : les notifications persistantes du staff.
   *
   * La page utilisait ses propres formes - pastilles de 56 px, rayons de 32 a
   * 40 px, onglets en gelules a fond plein - la ou le reste du dashboard tient
   * en cartes discretes. Elle reprend ici les composants communs (ModulePage,
   * SectionCard, EmptyState, RefreshButton) et l'onglet souligne des autres
   * pages, pour qu'on la reconnaisse comme faisant partie du meme produit.
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { notificationsStore } from '../lib/stores/notifications.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { m, dateLocale } from '../lib/i18n';

  const inboxTabs = ['tous', 'modération', 'recrutement', 'staff', 'système'] as const;
  let currentTab = $state('tous');

  $effect(() => {
    const _path = $router.path;
    currentTab = resolveTabFromUrl('/inbox', inboxTabs, 'tous');
  });

  onMount(() => {
    notificationsStore.fetchNotifications();
  });

  const TYPE_META: Record<string, { icon: string; text: string; bg: string }> = {
    SUCCESS: { icon: 'check-circle', text: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    WARNING: { icon: 'alert-triangle', text: 'text-amber-500', bg: 'bg-amber-500/10' },
    ERROR: { icon: 'alert-circle', text: 'text-error', bg: 'bg-error/10' },
    INFO: { icon: 'info', text: 'text-primary', bg: 'bg-primary/10' },
  };

  const typeMeta = (type: string) => TYPE_META[type] ?? TYPE_META.INFO;

  /**
   * Classement par mots du titre et par destination du lien. Faute de champ
   * `category` sur la notification, c'est le seul signal disponible ; une
   * notification non reconnue reste visible dans « Tout ».
   */
  const getCategory = (notif: any) => {
    const title = notif.title.toLowerCase();
    const link = (notif.link || '').toLowerCase();

    if (title.includes('sanction') || title.includes('bannissement') || title.includes('exclusion') || title.includes('timeout') || title.includes('avertissement')) return 'modération';
    if (title.includes('candidature') || link.includes('recruitment')) return 'recrutement';
    if (title.includes('staff') || title.includes('management') || title.includes('note') || link.includes('absences') || link.includes('meeting')) return 'staff';
    if (title.includes('bot') || title.includes('système') || title.includes('erreur')) return 'système';
    return 'tous';
  };

  const filteredNotifications = $derived(
    currentTab === 'tous'
      ? notificationsStore.items
      : notificationsStore.items.filter(n => getCategory(n) === currentTab)
  );

  const tabLabel = (id: string) => {
    switch (id) {
      case 'modération': return m.inbox_tab_moderation();
      case 'recrutement': return m.inbox_tab_recruitment();
      case 'staff': return m.inbox_tab_staff();
      case 'système': return m.inbox_tab_system();
      default: return m.inbox_tab_all();
    }
  };

  const tabs = [
    { id: 'tous', icon: 'layers' },
    { id: 'modération', icon: 'shield' },
    { id: 'recrutement', icon: 'users' },
    { id: 'staff', icon: 'user-check' },
    { id: 'système', icon: 'cpu' },
  ];

  /** Non lues par onglet : le compteur guide vers ce qui reste a traiter. */
  const unreadByTab = $derived.by(() => {
    const counts: Record<string, number> = { tous: 0, 'modération': 0, recrutement: 0, staff: 0, 'système': 0 };
    for (const notif of notificationsStore.items) {
      if (notif.isRead) continue;
      counts.tous += 1;
      counts[getCategory(notif)] = (counts[getCategory(notif)] ?? 0) + 1;
    }
    return counts;
  });

  function formatDate(value: string): string {
    return new Date(value).toLocaleString(dateLocale(), {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }
</script>

<ModulePage
  title={m.nav_inbox()}
  description={m.inbox_page_desc()}
  icon="inbox"
  featureKey="inbox"
>
  {#snippet actions()}
    {#if notificationsStore.unreadCount > 0}
      <ActionButton
        variant="primary"
        size="sm"
        icon="check"
        label={m.inbox_mark_all_read()}
        onclick={() => notificationsStore.markAllAsRead()}
      />
    {/if}
    <RefreshButton
      onclick={() => notificationsStore.fetchNotifications()}
      loading={notificationsStore.loading}
    />
  {/snippet}

  <!-- Sur téléphone, le filtre natif reste entièrement lisible et ne demande
       pas de deviner qu'une rangée d'onglets continue hors écran. -->
  <label class="inbox-mobile-filter">
    <span>{m.common_filter()}</span>
    <select
      value={currentTab}
      onchange={(event) => gotoTab('/inbox', event.currentTarget.value, 'tous')}
    >
      {#each tabs as tab (tab.id)}
        <option value={tab.id}>{tabLabel(tab.id)}</option>
      {/each}
    </select>
  </label>

  <div class="inbox-tabs border-b border-outline-variant/10 mb-5 overflow-x-auto no-scrollbar">
    {#each tabs as tab (tab.id)}
      <button
        onclick={() => gotoTab('/inbox', tab.id, 'tous')}
        class="tab-button {currentTab === tab.id ? 'active' : ''}"
      >
        <span class="inline-flex items-center gap-2">
          <Papicon icon={tab.icon} size={15} />
          {tabLabel(tab.id)}
          {#if unreadByTab[tab.id] > 0}
            <span class="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary/15 text-primary">
              {unreadByTab[tab.id]}
            </span>
          {/if}
        </span>
        {#if currentTab === tab.id}
          <div class="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>
    {/each}
  </div>

  <SectionCard
    title={tabLabel(currentTab)}
    description="{filteredNotifications.length} notification(s){unreadByTab[currentTab] > 0 ? ` · ${unreadByTab[currentTab]} non lue(s)` : ''}"
    flush
  >
    {#if notificationsStore.loading && notificationsStore.items.length === 0}
      <div class="p-5 space-y-2">
        {#each Array(4) as _}
          <Skeleton height="h-16" />
        {/each}
      </div>
    {:else if filteredNotifications.length === 0}
      <EmptyState
        icon="inbox"
        title={m.inbox_empty_title()}
        description="{m.inbox_empty_desc_before()}{tabLabel(currentTab)}{m.inbox_empty_desc_after()}"
      />
    {:else}
      <!--
        Une ligne par notification plutot qu'une carte : l'inbox se parcourt de
        haut en bas, et la barre laterale suffit a distinguer une non lue.
      -->
      <ul class="divide-y divide-outline-variant/10">
        {#each filteredNotifications as notif (notif.id)}
          {@const meta = typeMeta(notif.type)}
          <li
            class="relative flex items-start gap-3 px-5 py-4 transition-colors hover:bg-white/2
            {notif.isRead ? '' : 'before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.5 before:bg-primary before:rounded-full'}"
          >
            <div class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center {meta.bg} {meta.text}">
              <Papicon icon={meta.icon} size={14} />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <h3 class="text-[13.5px] font-semibold text-on-surface leading-snug wrap-break-word">
                  {notif.title}
                </h3>
                <span class="text-[11px] text-on-surface-variant/60 whitespace-nowrap shrink-0 tabular-nums">
                  {formatDate(notif.createdAt)}
                </span>
              </div>

              <p class="mt-1 text-[12.5px] text-on-surface-variant leading-relaxed">
                {notif.message}
              </p>

              <div class="mt-2.5 flex flex-wrap items-center gap-2">
                {#if notif.link}
                  <a
                    href={notif.link}
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                    bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors"
                  >
                    <Papicon icon="external-link" size={13} />
                    {m.inbox_notification_view()}
                  </a>
                {/if}

                {#if !notif.isRead}
                  <button
                    type="button"
                    onclick={() => notificationsStore.markAsRead(notif.id)}
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                    bg-surface-container text-on-surface border border-outline-variant/40
                    hover:border-outline-variant transition-colors"
                  >
                    <Papicon icon="check" size={13} />
                    {m.inbox_notification_mark_read()}
                  </button>
                {/if}

                {#if currentTab === 'tous'}
                  <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                    {tabLabel(getCategory(notif))}
                  </span>
                {/if}
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </SectionCard>
</ModulePage>

<style>
  .inbox-tabs {
    display: flex;
  }

  .inbox-mobile-filter {
    display: none;
  }

  /* A row of tabs cannot hold every notification category on a phone, so the
     same filter becomes a native select the OS renders full screen. */
  @media (max-width: 767px) {
    .inbox-tabs {
      display: none;
    }

    .inbox-mobile-filter {
      display: grid;
      gap: 0.4rem;
      margin-bottom: 1.25rem;
      color: var(--on-surface-variant);
      font-size: 0.75rem;
      font-weight: 700;
    }

    .inbox-mobile-filter select {
      width: 100%;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--outline-variant);
      border-radius: 0.75rem;
      background: var(--surface-container-lowest);
      color: var(--on-surface);
      font-weight: 650;
    }
  }

  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
