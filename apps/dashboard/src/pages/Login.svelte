<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { API_BASE_URL } from '../lib/api';
  import { consumeLoginReturn } from '../lib/loginReturn';
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import { brandingStore } from '../lib/stores/branding.svelte';
  import PrivacyNotice from '../lib/components/PrivacyNotice.svelte';
  import { m } from '../lib/i18n';

  let errorMessage = $state(null);

  /**
   * Ou revenir apres le va-et-vient Discord.
   *
   * L'API sait deja reposer quelqu'un ou il allait - `?returnTo=`, garde en
   * cookie pendant l'echange et relu au retour. Sans ce parametre, tout le
   * monde atterrit sur `/` : le visiteur venu de « Ajouter le bot » se
   * retrouvait sur le tableau de bord d'un serveur quelconque, au lieu de la
   * liste ou il devait choisir celui a equiper.
   *
   * L'adresse est consommee a la construction du lien, pas au clic : la page
   * de connexion ne se traverse qu'une fois par tentative, et une intention
   * qui survivrait a un retour en arriere detournerait la connexion suivante.
   */
  const returnTo = consumeLoginReturn();
  const oauthLoginUrl = `${API_BASE_URL || ''}/api/auth/discord/login${
    returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
  }`;

  async function hydrateOAuthConfig() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/config`, {
        headers: { Accept: 'application/json' }
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        errorMessage = API_BASE_URL
          ? m.login_api_config_invalid_url({ url: API_BASE_URL })
          : m.login_api_config_invalid();
        return;
      }

      const data = await response.json() as { discordClientId?: string; error?: string; missing?: string[] };

      if (!response.ok) {
        if (data?.missing?.length) {
          errorMessage = m.login_oauth_invalid({ missing: data.missing.join(', ') });
        } else if (data?.error) {
          errorMessage = data.error;
        }
        return;
      }
    } catch {
      errorMessage = API_BASE_URL
        ? m.login_api_unreachable_url({ url: API_BASE_URL })
        : m.login_api_unreachable();
    }
  }

  const loginWithDiscord = async () => {
    await hydrateOAuthConfig();

    if (errorMessage) {
      return;
    }

    window.location.href = oauthLoginUrl;
  };

  onMount(async () => {
    await hydrateOAuthConfig();

    if (authStore.isAuthenticated) {
      router.goto('/');
    }

    const urlParams = new URLSearchParams(window.location.search);
    const errorParam = urlParams.get('error');
    if (errorParam) {
      if (errorParam === 'auth_failed') {
        errorMessage = m.login_auth_failed();
      } else if (errorParam === 'no_code') {
        errorMessage = m.login_no_code();
      } else {
        errorMessage = m.login_unexpected_error();
      }

      window.history.replaceState({}, document.title, window.location.pathname);
    }
  });

  const year = new Date().getFullYear();
</script>

<div class="min-h-screen w-full bg-background text-on-surface flex flex-col font-body">

  <!-- Header -->
  <header class="w-full px-6 py-6 max-w-5xl mx-auto">
    <nav class="flex justify-between items-center">
      <div class="flex items-center gap-3">
        <img src={brandingStore.logoUrl || '/favicon.svg'} alt={brandingStore.brandName} class="w-8 h-8 rounded-lg" />
        <span class="text-lg font-semibold text-on-surface">{brandingStore.brandName}</span>
      </div>

      <div class="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
        <span class="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{m.login_online()}</span>
      </div>
    </nav>
  </header>

  <!-- Main -->
  <main class="grow flex items-center justify-center px-6 py-12">
    <div class="w-full max-w-sm">

      <div class="section-card p-8 text-center">
        <div class="mb-6">
          <img src={brandingStore.logoUrl || '/favicon.svg'} alt="{brandingStore.brandName} Logo" class="w-16 h-16 mx-auto rounded-xl" />
        </div>

        <h1 class="text-xl font-semibold text-on-surface mb-1">{m.login_title()}</h1>
        <p class="text-sm text-on-surface-variant mb-6">
          {m.login_subtitle()}
        </p>

        {#if errorMessage}
          <div class="mb-5 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center gap-2.5">
            <Papicon icon="warning" size={15} class="text-red-600 dark:text-red-400 shrink-0" />
            <p class="text-xs text-red-700 dark:text-red-400 text-left">
              {errorMessage}
            </p>
          </div>
        {/if}

        <button
          onclick={loginWithDiscord}
          class="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 bg-primary text-on-primary rounded-lg font-medium text-sm hover:opacity-90 transition-opacity"
        >
          <Papicon icon="discord" size={18} />
          {m.login_with_discord()}
        </button>

        <div class="mt-4 text-left">
          <PrivacyNotice compact text={m.login_privacy_notice()} />
        </div>

        <div class="mt-6 pt-5 border-t border-outline-variant grid grid-cols-3 gap-3">
          <div class="text-center">
            <span class="text-[10px] text-on-surface-variant block">{m.login_protocol()}</span>
            <span class="text-[11px] font-medium text-on-surface">OAuth 2.0</span>
          </div>
          <div class="text-center border-x border-outline-variant">
            <span class="text-[10px] text-on-surface-variant block">{m.login_security()}</span>
            <span class="text-[11px] font-medium text-on-surface">AES-256</span>
          </div>
          <div class="text-center">
            <span class="text-[10px] text-on-surface-variant block">Uptime</span>
            <span class="text-[11px] font-medium text-on-surface">99.98%</span>
          </div>
        </div>
      </div>

      <p class="text-center text-xs text-on-surface-variant/50 mt-6">
        {brandingStore.brandName} &copy; {year}
      </p>
    </div>
  </main>
</div>
