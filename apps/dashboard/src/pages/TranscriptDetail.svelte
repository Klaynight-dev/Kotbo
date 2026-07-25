<script lang="ts">
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m } from '../lib/i18n';

  const { transcriptId } = $props<{ transcriptId: string }>();

  let iframeUrl = $state('');
  let error = $state('');
  let needsLogin = $state(false);

  const loginUrl = `${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(`/transcripts/${transcriptId}`)}`;

  onMount(async () => {
    await authStore.initialize();

    if (!authStore.isAuthenticated) {
      needsLogin = true;
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/public/transcripts/${transcriptId}/access`,
        { headers: { Authorization: `Bearer ${authStore.token}` }, credentials: 'include' },
      );
      if (response.status === 401) {
        needsLogin = true;
      } else if (response.status === 403) {
        error = m.d7_ts_no_access();
      } else if (response.status === 404) {
        error = m.d7_ts_not_found();
      } else if (response.ok) {
        const data = await response.json();
        iframeUrl = `${API_BASE_URL}${data.signedUrl}`;
      } else {
        error = m.d7_ts_load_fail();
      }
    } catch {
      error = m.d7_ts_load_error();
    }
  });
</script>

<div class="fixed inset-0 w-full h-full bg-[#313338] overflow-hidden flex flex-col">
  {#if needsLogin}
    <div class="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
      <p class="text-white/70 text-sm">
        {m.d7_ts_login_required()}
      </p>
      <a
        href={loginUrl}
        class="flex items-center justify-center gap-2.5 py-2.5 px-4 bg-primary text-on-primary rounded-lg font-medium text-sm hover:opacity-90 transition-opacity"
      >
        <Papicon icon="discord" size={18} />
        {m.d7_ts_login_discord()}
      </a>
    </div>
  {:else if error}
    <div class="flex items-center justify-center h-full text-white/50 text-sm">{error}</div>
  {:else if iframeUrl}
    <iframe
      src={iframeUrl}
      title={m.d7_ts_iframe_title()}
      class="w-full h-full border-none"
    ></iframe>
  {:else}
    <div class="flex items-center justify-center h-full">
      <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
    </div>
  {/if}
</div>
