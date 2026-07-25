<script lang="ts">
  import { reportDashboardError } from '../api';
  import { authStore } from '../stores/auth.svelte';
  import { toast } from '../stores/toast.svelte';
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';

  let { errorMsg, errorStack } = $props<{ errorMsg: string; errorStack?: string }>();

  let isRefreshed = sessionStorage.getItem('error_refreshed') === 'true';
  let isSending = $state(false);
  let isSent = $state(false);

  function handleRefresh() {
    sessionStorage.setItem('error_refreshed', 'true');
    window.location.reload();
  }

  async function handleTransmitError() {
    isSending = true;
    try {
      await reportDashboardError({
        error: errorMsg,
        stack: errorStack,
        url: window.location.href,
        userAgent: navigator.userAgent,
        guildId: authStore.selectedGuildId
      });
      isSent = true;
      toast.success(m.d6_error_report_sent());
    } catch (err: any) {
      console.error(err);
      toast.error(m.d6_error_report_failed());
    } finally {
      isSending = false;
    }
  }
</script>

<div class="fixed inset-0 z-[10000] flex items-center justify-center bg-background p-6 md:p-12 overflow-y-auto">
  <!-- Dynamic mesh-like background grid to make it look premium -->
  <div class="absolute inset-0 opacity-[0.03] dark:opacity-[0.05] pointer-events-none bg-[radial-gradient(#3b82f6_1px,transparent_1px)] [background-size:24px_24px]"></div>
  
  <div class="relative w-full max-w-2xl bg-surface-container-lowest border border-outline-variant rounded-xl p-8 md:p-10 shadow-sm flex flex-col items-center text-center gap-5 animate-in fade-in">
    <div class="w-12 h-12 rounded-lg bg-error/10 text-error flex items-center justify-center">
      <Papicon icon="warning" size={28} />
    </div>

    <!-- Title and Subtitle -->
    <div>
      <h1 class="text-xl md:text-2xl font-semibold text-on-surface tracking-tight">
        {m.d6_error_title()}
      </h1>
      <p class="text-on-surface-variant text-sm md:text-base mt-2 max-w-md mx-auto">
        {m.d6_error_subtitle()}
      </p>
    </div>

    <!-- Error Message Snippet -->
    <div class="w-full text-left bg-surface-container border border-outline-variant rounded-lg p-4 overflow-hidden">
      <div class="flex items-center justify-between border-b border-outline-variant/50 pb-2 mb-3">
        <span class="text-xs font-medium uppercase tracking-wider text-on-surface-variant">{m.d6_error_details()}</span>
        <span class="text-xs text-error font-semibold font-mono text-right">CRITICAL</span>
      </div>
      <p class="font-mono text-xs md:text-sm text-error break-words whitespace-pre-wrap font-semibold leading-relaxed">
        {errorMsg}
      </p>
      {#if errorStack}
        <div class="mt-4 pt-3 border-t border-outline-variant/30">
          <details class="group">
            <summary class="text-xs font-bold uppercase tracking-wider text-on-surface-variant cursor-pointer select-none hover:text-on-surface transition-colors flex items-center gap-2">
              <Papicon icon="chevron-right" size={14} class="transition-transform group-open:rotate-90" />
              Stack Trace
            </summary>
            <pre class="mt-2 text-[10px] md:text-xs font-mono text-on-surface-variant/80 overflow-x-auto max-h-40 bg-surface-container-low border border-outline-variant/30 rounded-lg p-3 whitespace-pre scrollbar-thin">
              {errorStack}
            </pre>
          </details>
        </div>
      {/if}
    </div>

    <!-- Actions -->
    <div class="flex flex-col sm:flex-row items-center gap-3 w-full justify-center mt-4">
      <button
        onclick={handleRefresh}
        class="w-full sm:w-auto px-5 py-2.5 bg-primary hover:opacity-90 text-on-primary font-medium text-sm rounded-lg transition-opacity cursor-pointer flex items-center justify-center gap-2"
      >
        <Papicon icon="refresh-cw" size={18} />
        {m.d6_error_refresh_page()}
      </button>

      {#if isRefreshed}
        {#if isSent}
          <button
            disabled
            class="w-full sm:w-auto px-5 py-2.5 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium text-sm rounded-lg cursor-default flex items-center justify-center gap-2"
          >
            <Papicon icon="check-circle" size={18} />
            {m.d6_error_reported()}
          </button>
        {:else}
          <button
            onclick={handleTransmitError}
            disabled={isSending}
            class="w-full sm:w-auto px-5 py-2.5 bg-surface-container hover:bg-surface-container-high border border-outline-variant text-on-surface font-medium text-sm rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {#if isSending}
              <div class="w-4 h-4 border-2 border-on-surface border-t-transparent rounded-full animate-spin"></div>
              {m.d6_error_sending()}
            {:else}
              <Papicon icon="send" size={18} />
              {m.d6_error_transmit()}
            {/if}
          </button>
        {/if}
      {/if}
    </div>
  </div>
</div>
