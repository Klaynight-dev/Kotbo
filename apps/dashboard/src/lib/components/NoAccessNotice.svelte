<script lang="ts">
  /**
   * Ecran terminal pour une page que le compte connecte n'a pas le droit de voir.
   *
   * La garde de route renvoyait ces cas vers `/`, qui porte lui-meme la clef
   * `dashboard` : quand c'est cette clef qui manque, la redirection ne faisait
   * rien et l'accueil se rendait malgre le refus. Il faut donc un ecran, et pas
   * seulement une redirection.
   */
  import { router } from 'tinro';
  import { authStore } from '../stores/auth.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';

  const { reason = 'feature' }: { reason?: 'guild' | 'feature' } = $props();

  let retrying = $state(false);

  /**
   * Les deux refus se relisent a des endroits differents : la liste des
   * serveurs pour `guild`, les droits par fonctionnalite du store pour
   * `feature`. On relit les deux, un role fraichement attribue pouvant
   * debloquer l'un comme l'autre.
   */
  async function retry() {
    if (retrying) return;
    retrying = true;
    try {
      await authStore.fetchGuilds();
      await dashboardStore.refresh({ full: true });
    } finally {
      retrying = false;
    }
  }
</script>

<div class="max-w-lg mx-auto px-4 py-24 text-center space-y-5">
  <div class="w-14 h-14 mx-auto rounded-2xl bg-surface-container text-on-surface-variant/60 flex items-center justify-center">
    <Papicon icon="Lock" size={26} />
  </div>

  <div class="space-y-2">
    <h1 class="text-lg font-semibold text-on-surface">
      {reason === 'guild' ? m.no_guild_access_title() : m.no_feature_access_title()}
    </h1>
    <p class="text-[13px] text-on-surface-variant leading-relaxed">
      {reason === 'guild' ? m.no_guild_access_desc() : m.no_feature_access_desc()}
    </p>
  </div>

  <div class="flex items-center justify-center gap-2">
    {#if reason === 'guild'}
      <!-- Aucun serveur equipe : la sortie utile n'est pas « reessayer », c'est
           d'aller inviter le bot quelque part. -->
      <button
        type="button"
        onclick={() => router.goto('/servers')}
        class="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-primary text-on-primary text-sm font-medium hover:bg-primary/90 transition-colors"
      >
        <Papicon icon="Plus" size={15} />
        {m.d7_add_to_server()}
      </button>
    {/if}
    <button
      type="button"
      onclick={retry}
      disabled={retrying}
      class="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50
      {reason === 'guild'
        ? 'border border-outline-variant/40 text-on-surface hover:bg-surface-container'
        : 'bg-primary text-on-primary hover:bg-primary/90'}"
    >
      {retrying ? m.common_loading() : m.common_retry()}
    </button>
    <button
      type="button"
      onclick={() => authStore.logout()}
      class="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-outline-variant/40 text-sm font-medium text-on-surface hover:bg-surface-container transition-colors"
    >
      {m.navbar_logout()}
    </button>
  </div>
</div>
