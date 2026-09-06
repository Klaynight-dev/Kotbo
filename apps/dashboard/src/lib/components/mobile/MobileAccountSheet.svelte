<script lang="ts">
  import { router } from 'tinro';
  import { m } from '../../i18n';
  import { resolveGuildIconSrc, resolveUserAvatarSrc } from '../../discordMedia';
  import { authStore } from '../../stores/auth.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { feedbackModal } from '../../stores/feedbackModal.svelte';
  import { mobileNav } from '../../stores/mobileNav.svelte';
  import { navigationStore } from '../../stores/navigation.svelte';
  import { serverSwitcherStore } from '../../stores/serverSwitcher.svelte';
  import { themeStore } from '../../stores/theme.svelte';
  import { onboardingStore } from '../../stores/tutorial.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import { userPrefs } from '../../stores/userPreferences.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import Papicon from '../Papicon.svelte';

  /**
   * Everything about *you* rather than about the server, reachable from the
   * avatar in the top bar. It used to sit under eighty page links at the foot
   * of the navigation sheet, where nobody scrolled to find it.
   */
  const open = $derived(mobileNav.sheet === 'account');

  const guild = $derived(authStore.guilds.find((g) => g.id === authStore.selectedGuildId));
  const guildIcon = $derived(guild ? resolveGuildIconSrc(guild.id, guild.icon) : null);
  const userAvatar = $derived(resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar));
  const profileHref = $derived(authStore.user?.id ? `/profile/${authStore.user.id}` : '/profile');
  const canSwitchServer = $derived(authStore.guilds.length > 1);

  const languages = [
    { code: 'fr', flag: '🇫🇷', label: 'FR' },
    { code: 'en', flag: '🇬🇧', label: 'EN' },
  ] as const;

  async function go(href: string) {
    if (unsavedChanges.isDirty) {
      const confirmed = await confirmDialog.ask({
        title: m.banner_unsaved_title(),
        description: m.banner_unsaved_desc({ page: unsavedChanges.pageLabel }),
        confirmLabel: m.banner_unsaved_leave(),
        variant: 'warning',
      });
      if (!confirmed) return;
      unsavedChanges.clear();
    }

    mobileNav.close();
    router.goto(href);
  }

  function openServerSwitcher() {
    mobileNav.close();
    serverSwitcherStore.show();
  }

  function startTutorial() {
    if (authStore.selectedGuildId) onboardingStore.initialize(authStore.selectedGuildId);
    onboardingStore.restart();
    mobileNav.close();
  }

  function openFeedback() {
    mobileNav.close();
    feedbackModal.show();
  }
</script>

<BottomSheet
  {open}
  title={m.nav_account()}
  subtitle={authStore.user?.username}
  maxHeight="88dvh"
  onclose={() => mobileNav.close()}
>
  {#snippet footer()}
    <button
      type="button"
      class="account__logout"
      onclick={() => {
        mobileNav.close();
        authStore.logout();
      }}
    >
      <Papicon icon="log-out" size={17} />
      <span>{m.navbar_logout()}</span>
    </button>
  {/snippet}

  <div class="account">
    <button type="button" class="account__identity" onclick={() => go(profileHref)}>
      <img src={userAvatar} alt="" referrerpolicy="no-referrer" width="48" height="48" />
      <span class="account__identity-text">
        <span class="account__identity-name">{authStore.user?.username ?? '…'}</span>
        <span class="account__identity-link">{m.navbar_my_profile()}</span>
      </span>
      <Papicon icon="chevron-right" size={16} class="account__chevron" />
    </button>

    {#if canSwitchServer}
      <h3 class="account__label">{m.nav_current_server()}</h3>
      <button type="button" class="account__row account__row--server" onclick={openServerSwitcher}>
        {#if guildIcon}
          <img class="account__server-icon" src={guildIcon} alt="" referrerpolicy="no-referrer" />
        {:else}
          <span class="account__server-icon account__server-icon--fallback">
            {guild?.name?.charAt(0) ?? '?'}
          </span>
        {/if}
        <span class="account__row-label">{guild?.name ?? '-'}</span>
        <span class="account__row-action">{m.common_change()}</span>
        <Papicon icon="chevron-right" size={16} class="account__chevron" />
      </button>
    {/if}

    <h3 class="account__label">{m.nav_appearance()}</h3>

    <div class="account__setting">
      <span class="account__setting-name">{m.nav_theme()}</span>
      <div class="account__segmented" role="group" aria-label={m.nav_theme()}>
        <button
          type="button"
          class:account__segment--on={!themeStore.dark}
          aria-pressed={!themeStore.dark}
          onclick={() => (themeStore.dark = false)}
        >
          <Papicon icon="sun" size={15} />
          <span>{m.nav_theme_light_short()}</span>
        </button>
        <button
          type="button"
          class:account__segment--on={themeStore.dark}
          aria-pressed={themeStore.dark}
          onclick={() => (themeStore.dark = true)}
        >
          <Papicon icon="moon" size={15} />
          <span>{m.nav_theme_dark_short()}</span>
        </button>
      </div>
    </div>

    <div class="account__setting">
      <span class="account__setting-name">{m.nav_language()}</span>
      <div class="account__segmented" role="group" aria-label={m.navbar_lang_switch()}>
        {#each languages as lang (lang.code)}
          <button
            type="button"
            class:account__segment--on={userPrefs.prefs.language === lang.code}
            aria-pressed={userPrefs.prefs.language === lang.code}
            onclick={() => userPrefs.set('language', lang.code)}
          >
            <span class="account__flag" aria-hidden="true">{lang.flag}</span>
            <span>{lang.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <h3 class="account__label">{m.nav_preferences()}</h3>

    <ul class="account__list">
      <li>
        <button type="button" class="account__row" onclick={() => mobileNav.open('tabs')}>
          <span class="account__row-icon"><Papicon icon="tune" size={18} /></span>
          <span class="account__row-label">{m.nav_customize_tabbar()}</span>
          <Papicon icon="chevron-right" size={16} class="account__chevron" />
        </button>
      </li>

      {@render action('settings', m.navbar_settings(), () => go('/userSettings'))}
      {@render action('history', m.navbar_my_activity(), () => go('/activity'))}
      {@render action('school', m.navbar_tutorial(), startTutorial)}
      {@render action('bug_report', m.navbar_feedback(), openFeedback)}

      <li>
        <a
          class="account__row"
          href="https://docs.kotbo.fr/"
          target="_blank"
          rel="noopener noreferrer"
          onclick={() => mobileNav.close()}
        >
          <span class="account__row-icon"><Papicon icon="pronote" size={18} /></span>
          <span class="account__row-label">{m.navbar_documentation()}</span>
          <Papicon icon="external-link" size={15} class="account__chevron" />
        </a>
      </li>

      <!-- Même règle que la barre latérale : la facturation n'apparaît que pour
           l'administrateur, le payeur, ou tout le staff quand le serveur l'a
           autorisé. -->
      {#if navigationStore.canViewBilling}
        {@render action('credit-card', m.nav_billing(), () => go('/billing'))}
      {/if}

      {#if authStore.isBotAdmin}
        {@render action('lock', m.nav_administration(), () => go('/admin'))}
      {/if}
    </ul>
  </div>
</BottomSheet>

{#snippet action(icon: string, label: string, onclick: () => void)}
  <li>
    <button type="button" class="account__row" {onclick}>
      <span class="account__row-icon"><Papicon {icon} size={18} /></span>
      <span class="account__row-label">{label}</span>
      <Papicon icon="chevron-right" size={16} class="account__chevron" />
    </button>
  </li>
{/snippet}

<style>
  .account {
    padding-bottom: 0.5rem;
  }

  .account__identity {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--outline-variant);
    border-radius: 1rem;
    background: var(--surface-container);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }

  .account__identity:active {
    background: var(--surface-container-high, var(--surface-container));
  }

  .account__identity img {
    width: 3rem;
    height: 3rem;
    flex: none;
    border-radius: 0.875rem;
    object-fit: cover;
  }

  .account__identity-text {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .account__identity-name {
    overflow: hidden;
    color: var(--on-surface);
    font-family: var(--font-headline);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -0.015em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account__identity-link {
    color: var(--primary-color);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .account__label {
    margin: 1.25rem 0 0.375rem;
    padding-left: 0.25rem;
    color: var(--on-surface-variant);
    font-family: var(--font-label);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .account__list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .account__row {
    display: flex;
    width: 100%;
    min-height: 3rem;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.5rem 0 0.625rem;
    border-radius: 0.75rem;
    color: var(--on-surface);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }

  .account__row:active {
    background: var(--surface-container);
  }

  .account__row--server {
    border: 1px solid var(--outline-variant);
    background: var(--surface-container);
  }

  .account__row-icon {
    display: grid;
    width: 1.75rem;
    flex: none;
    place-items: center;
    color: inherit;
    opacity: 0.75;
  }

  .account__row-label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    font-size: 0.9375rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account__row-action {
    flex: none;
    color: var(--primary-color);
    font-size: 0.8125rem;
    font-weight: 650;
  }

  .account__row :global(.account__chevron),
  .account__identity :global(.account__chevron) {
    flex: none;
    color: var(--on-surface-variant);
    opacity: 0.5;
  }

  .account__server-icon {
    display: grid;
    width: 1.75rem;
    height: 1.75rem;
    flex: none;
    place-items: center;
    border-radius: 0.5rem;
    object-fit: cover;
  }

  .account__server-icon--fallback {
    background: color-mix(in srgb, var(--primary-color) 14%, transparent);
    color: var(--primary-color);
    font-size: 0.75rem;
    font-weight: 700;
  }

  .account__setting {
    display: flex;
    min-height: 3rem;
    align-items: center;
    gap: 0.75rem;
    padding-left: 0.625rem;
  }

  .account__setting-name {
    flex: 1 1 auto;
    color: var(--on-surface);
    font-size: 0.9375rem;
    font-weight: 500;
  }

  /* Two states, both visible: a lone toggle never says what the other one is. */
  .account__segmented {
    display: flex;
    flex: none;
    gap: 0.125rem;
    padding: 0.1875rem;
    border: 1px solid var(--outline-variant);
    border-radius: 999px;
    background: var(--surface-container);
  }

  .account__segmented > button {
    display: flex;
    min-height: 2.25rem;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    border-radius: 999px;
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
    font-weight: 600;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .account__segmented > button.account__segment--on {
    background: var(--surface-container-lowest);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
    color: var(--primary-color);
  }

  .account__flag {
    font-size: 0.9375rem;
    line-height: 1;
  }

  .account__logout {
    display: flex;
    width: 100%;
    min-height: 2.75rem;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border-radius: 0.875rem;
    background: color-mix(in srgb, #dc2626 10%, transparent);
    color: #dc2626;
    font-size: 0.9375rem;
    font-weight: 650;
    -webkit-tap-highlight-color: transparent;
  }

  :global(.dark) .account__logout {
    background: color-mix(in srgb, #f87171 14%, transparent);
    color: #f87171;
  }

  @media (prefers-reduced-motion: reduce) {
    .account__segmented > button {
      transition: none;
    }
  }
</style>
