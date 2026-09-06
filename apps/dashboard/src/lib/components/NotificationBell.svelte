<script lang="ts">
  import { onMount } from 'svelte';
  import { notificationsStore } from '../stores/notifications.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { subscribeRealtime } from '../stores/realtime.svelte';
  import { slide } from 'svelte/transition';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';

  let open = $state(false);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId && authStore.token) {
      void notificationsStore.fetchNotifications();
    }
  });

  onMount(() => {
    const unsubscribe = subscribeRealtime({
      reasons: ['notifications_updated'],
      fallbackMs: 120_000,
      onUpdate: () => {
        void notificationsStore.fetchNotifications(true);
      },
    });

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.notif-container')) {
        open = false;
      }
    };
    window.addEventListener('click', handleClick);

    return () => {
      unsubscribe();
      window.removeEventListener('click', handleClick);
    };
  });

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    open = !open;
  };

  const getIconForType = (type: string) => {
    switch (type) {
      case 'SUCCESS': return 'check-circle';
      case 'WARNING': return 'alert-triangle';
      case 'ERROR': return 'alert-circle';
      default: return 'info';
    }
  };

  const getColorForType = (type: string) => {
    switch (type) {
      case 'SUCCESS': return 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/10';
      case 'WARNING': return 'text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/10';
      case 'ERROR': return 'text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-500/10';
      default: return 'text-primary bg-primary/10';
    }
  };
</script>

<div class="relative notif-container">
  <button
    onclick={toggle}
    class="notification-trigger relative w-8 h-8 rounded-md border border-outline-variant bg-surface-container-lowest flex items-center justify-center transition-colors hover:bg-surface-container"
    aria-label={m.notif_header_title()}
    aria-expanded={open}
  >
    <Papicon icon="bell" size={16} class="text-on-surface-variant" />

    {#if notificationsStore.unreadCount > 0}
      <div class="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-0.5 bg-primary rounded-full flex items-center justify-center">
        <span class="text-[9px] font-medium text-white leading-none">
          {notificationsStore.unreadCount > 99 ? '99+' : notificationsStore.unreadCount}
        </span>
      </div>
    {/if}
  </button>

  {#if open}
    <div
      transition:slide={{ duration: 150, axis: 'y' }}
      class="notification-panel absolute right-0 top-11 w-80 max-h-[400px] bg-surface-container-lowest rounded-lg border border-outline-variant shadow-lg flex flex-col overflow-hidden z-50"
    >
      <div class="px-3 py-2.5 border-b border-outline-variant flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-on-surface">{m.notif_header_title()}</span>
          {#if notificationsStore.unreadCount > 0}
            <span class="px-1.5 py-0.5 rounded-full bg-primary/10 text-[10px] font-medium text-primary">
              {notificationsStore.unreadCount}
            </span>
          {/if}
        </div>
        {#if notificationsStore.unreadCount > 0}
          <button
            onclick={() => notificationsStore.markAllAsRead()}
            class="text-[11px] text-on-surface-variant hover:text-primary transition-colors"
          >
            {m.notif_mark_all_read()}
          </button>
        {/if}
      </div>

      <div class="flex-1 overflow-y-auto">
        {#if notificationsStore.loading && notificationsStore.items.length === 0}
          <div class="p-6 flex flex-col items-center text-on-surface-variant/50">
            <Papicon icon="refresh-cw" size={20} class="animate-spin mb-2" />
            <span class="text-xs">{m.notif_loading()}</span>
          </div>
        {:else if notificationsStore.items.length === 0}
          <div class="p-6 flex flex-col items-center text-on-surface-variant/40">
            <Papicon icon="bell-off" size={24} class="mb-2" />
            <span class="text-xs">{m.notif_empty()}</span>
          </div>
        {:else}
          <div class="flex flex-col">
            {#each notificationsStore.items as notif}
              <div
                class="flex gap-3 px-3 py-2.5 border-b border-outline-variant last:border-0 hover:bg-surface-container transition-colors cursor-pointer {notif.isRead ? 'opacity-60' : ''}"
                onclick={() => {
                  if (!notif.isRead) notificationsStore.markAsRead(notif.id);
                  if (notif.link) window.location.href = notif.link;
                }}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    if (!notif.isRead) notificationsStore.markAsRead(notif.id);
                    if (notif.link) window.location.href = notif.link;
                  }
                }}
                role="button"
                tabindex="0"
              >
                <div class="shrink-0 w-7 h-7 rounded-md flex items-center justify-center {getColorForType(notif.type)}">
                  <Papicon icon={getIconForType(notif.type)} size={13} />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-start justify-between gap-2 mb-0.5">
                    <p class="text-xs text-on-surface truncate {notif.isRead ? '' : 'font-medium'}">
                      {notif.title}
                    </p>
                    <span class="text-[9px] text-on-surface-variant whitespace-nowrap shrink-0">
                      {new Date(notif.createdAt).toLocaleDateString('fr-FR')}
                    </span>
                  </div>
                  <p class="text-[11px] text-on-surface-variant leading-tight line-clamp-2">
                    {notif.message}
                  </p>
                </div>
                {#if !notif.isRead}
                  <div class="shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-1.5"></div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="px-2 py-1.5 border-t border-outline-variant shrink-0">
        <a
          href="/inbox"
          class="flex items-center justify-center w-full py-1.5 rounded-md text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors"
        >
          {m.notif_view_history()}
        </a>
      </div>
    </div>
  {/if}
</div>
