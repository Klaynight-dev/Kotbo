<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import {
    fetchSocialFollows,
    addYoutubeFollow,
    deleteYoutubeFollow,
    addTwitchFollow,
    deleteTwitchFollow,
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  const socialTabs = ['youtube', 'twitch'] as const;
  let activeTab = $state<'youtube' | 'twitch'>('youtube');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/social-networks', socialTabs, 'youtube') as typeof activeTab;
  });

  let availableChannels = $state<Array<{ id: string; name: string }>>([]);

  let ytForm = $state({
    query: '',
    discordChannelId: '',
    mention: '',
    liveMessage: '',
    videoMessage: '',
    shortMessage: '',
  });

  let twitchForm = $state({
    query: '',
    discordChannelId: '',
    mention: '',
    liveMessage: '',
  });

  let youtubeFollows = $state<any[]>([]);
  let twitchFollows = $state<any[]>([]);

  const canManage = $derived(
    !!(dashboardStore.state.featureAccess as any)?.social_networks?.canConfigure ||
    !!dashboardStore.state.access?.canManageSettings
  );

  async function loadData() {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchSocialFollows();
      if (res) {
        youtubeFollows = res.youtube || [];
        twitchFollows = res.twitch || [];
      }
      availableChannels = (dashboardStore.state.discordChannels || []) as Array<{ id: string; name: string }>;
    } catch (e) {
      console.error('Failed to load social follows:', e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadData();
  });

  async function handleAddYoutube() {
    if (!ytForm.query.trim()) {
      actionState.setError('Veuillez renseigner le lien ou le nom de la chaîne YouTube.');
      return;
    }

    await actionState.run(async () => {
      const payload = {
        query: ytForm.query.trim(),
        discordChannelId: ytForm.discordChannelId || null,
        mention: ytForm.mention || null,
        liveMessage: ytForm.liveMessage || null,
        videoMessage: ytForm.videoMessage || null,
        shortMessage: ytForm.shortMessage || null,
      };

      const res = await addYoutubeFollow(payload);
      if (!res) throw new Error('Erreur API');

      ytForm = {
        query: '',
        discordChannelId: '',
        mention: '',
        liveMessage: '',
        videoMessage: '',
        shortMessage: '',
      };

      const updated = await fetchSocialFollows();
      if (updated) youtubeFollows = updated.youtube || [];
      return true;
    }, { successMessage: 'Chaîne YouTube ajoutée avec succès !' });
  }

  async function handleUpdateYoutube(follow: any) {
    await actionState.run(async () => {
      const payload = {
        channelId: follow.channelId,
        discordChannelId: follow.discordChannelId || null,
        mention: follow.mention || null,
        liveMessage: follow.liveMessage || null,
        videoMessage: follow.videoMessage || null,
        shortMessage: follow.shortMessage || null,
      };
      const res = await addYoutubeFollow(payload);
      if (!res) throw new Error('Erreur API');
      return true;
    }, { successMessage: 'Configuration YouTube mise à jour.' });
  }

  async function handleDeleteYoutube(id: string) {
    if (!(await confirmDialog.danger('Ne plus suivre cette chaîne YouTube ?', '', 'Ne plus suivre'))) return;

    await actionState.run(async () => {
      const ok = await deleteYoutubeFollow(id);
      if (!ok) throw new Error('Erreur API');

      youtubeFollows = youtubeFollows.filter(f => f.id !== id);
      return true;
    }, { successMessage: 'Chaîne YouTube supprimée du suivi.' });
  }

  async function handleAddTwitch() {
    if (!twitchForm.query.trim()) {
      actionState.setError('Veuillez renseigner le pseudo ou le lien Twitch.');
      return;
    }

    await actionState.run(async () => {
      const payload = {
        streamerName: twitchForm.query.trim(),
        discordChannelId: twitchForm.discordChannelId || null,
        mention: twitchForm.mention || null,
        liveMessage: twitchForm.liveMessage || null,
      };

      const res = await addTwitchFollow(payload);
      if (!res) throw new Error('Erreur API');

      twitchForm = {
        query: '',
        discordChannelId: '',
        mention: '',
        liveMessage: '',
      };

      const updated = await fetchSocialFollows();
      if (updated) twitchFollows = updated.twitch || [];
      return true;
    }, { successMessage: 'Streamer Twitch ajouté avec succès !' });
  }

  async function handleUpdateTwitch(follow: any) {
    await actionState.run(async () => {
      const payload = {
        streamerName: follow.streamerName,
        discordChannelId: follow.discordChannelId || null,
        mention: follow.mention || null,
        liveMessage: follow.liveMessage || null,
      };
      const res = await addTwitchFollow(payload);
      if (!res) throw new Error('Erreur API');
      return true;
    }, { successMessage: 'Configuration Twitch mise à jour.' });
  }

  async function handleDeleteTwitch(id: string) {
    if (!(await confirmDialog.danger('Ne plus suivre ce streamer Twitch ?', '', 'Ne plus suivre'))) return;

    await actionState.run(async () => {
      const ok = await deleteTwitchFollow(id);
      if (!ok) throw new Error('Erreur API');

      twitchFollows = twitchFollows.filter(f => f.id !== id);
      return true;
    }, { successMessage: 'Streamer Twitch supprimé du suivi.' });
  }
</script>

<ModulePage
  title="Réseaux Sociaux"
  description="Abonnez-vous à des chaînes YouTube et Twitch et configurez leurs alertes Discord."
  icon="share-2"
>
  {#snippet actions()}
      <div class="flex bg-surface-container-high/40 p-1.5 rounded-lg border border-outline-variant/20">
        <button
          onclick={() => gotoTab('/social-networks', 'youtube', 'youtube')}
          class="px-5 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-300 flex items-center gap-2 {activeTab === 'youtube' ? 'bg-red-600 text-white shadow-sm ' : 'text-on-surface-variant/70 hover:text-on-surface'}"
        >
          <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.508 9.388.508 9.388.508s7.518 0 9.388-.508a3.002 3.002 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
          <span>YouTube</span>
        </button>
        <button
          onclick={() => gotoTab('/social-networks', 'twitch', 'youtube')}
          class="px-5 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-300 flex items-center gap-2 {activeTab === 'twitch' ? 'bg-[#9146FF] text-white shadow-lg shadow-[#9146FF]/20 ' : 'text-on-surface-variant/70 hover:text-on-surface'}"
        >
          <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
          </svg>
          <span>Twitch</span>
        </button>
      </div>
  {/snippet}

  <div class="bg-surface-container-low/40 p-6 rounded-xl border border-outline-variant/20 flex flex-col md:flex-row md:items-center justify-between gap-6">
    <div class="space-y-1">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
        <h4 class="font-bold text-sm">Statut des modules</h4>
      </div>
      <p class="text-xs text-on-surface-variant/80">YouTube & Twitch sont gérés par les tâches de fond. Veillez à ce que les modules correspondants soient activés dans le <a href="/modules" class="text-primary hover:underline font-bold">Catalogue Système</a>.</p>
    </div>
    <div class="flex items-center gap-4 bg-surface-container-high/40 px-5 py-3 rounded-lg border border-outline-variant/10">
      <span class="text-xs font-medium text-primary">Modules Actifs</span>
      <span class="px-2.5 py-1 bg-emerald-500/10 text-emerald-500 rounded-lg text-[10px] font-semibold uppercase">En ligne</span>
    </div>
  </div>

  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div class="lg:col-span-1 p-8 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl space-y-6">
        <Skeleton width="60%" height="24px" />
        <Skeleton width="100%" height="180px" />
      </div>
      <div class="lg:col-span-2 p-8 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl space-y-6">
        <Skeleton width="40%" height="24px" />
        <Skeleton width="100%" height="80px" />
        <Skeleton width="100%" height="80px" />
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">

      <!-- ADD FORM COLUMN -->
      <div class="lg:col-span-1">
        {#if activeTab === 'youtube'}
          <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 sticky top-8 shadow-sm">
            <h3 class="text-lg font-semibold flex items-center gap-2.5 text-red-500">
              <svg class="w-5 h-5 fill-current" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.508 9.388.508 9.388.508s7.518 0 9.388-.508a3.002 3.002 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
              Suivre une chaîne YouTube
            </h3>

            <div class="space-y-4">
              <div class="space-y-1.5">
                <label for="yt-query" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">URL, Handle ou Nom de chaîne</label>
                <input
                  id="yt-query"
                  type="text"
                  placeholder="ex: https://youtube.com/@cyprien ou Cyprien"
                  bind:value={ytForm.query}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                />
              </div>

              <div class="space-y-1.5">
                <label for="yt-chan" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon des alertes</label>
                <SearchableSelect id="yt-chan" bind:value={ytForm.discordChannelId} options={availableChannels.map(ch => ({ id: ch.id, name: '#' + ch.name }))} placeholder="— Par défaut (Salon Public) —" className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-red-600/30 transition-all" />
              </div>

              <div class="space-y-1.5">
                <label for="yt-mention" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Mention (rôle à ping)</label>
                <input
                  id="yt-mention"
                  type="text"
                  placeholder="@everyone ou <@&role_id>"
                  bind:value={ytForm.mention}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                />
              </div>

              <div class="pt-4 border-t border-outline-variant/10">
                <p class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest mb-3">Messages par type d'alerte</p>

                <div class="space-y-3">
                  <div class="space-y-1.5">
                    <label for="yt-live-msg" class="text-[11px] font-bold text-on-surface-variant/50 ml-2">Live</label>
                    <input
                      id="yt-live-msg"
                      type="text"
                      placeholder="🔴 [channel] est en direct !"
                      bind:value={ytForm.liveMessage}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                    />
                    <p class="text-[10px] text-on-surface-variant/40 ml-2">Variables: [title], [channel]</p>
                  </div>

                  <div class="space-y-1.5">
                    <label for="yt-video-msg" class="text-[11px] font-bold text-on-surface-variant/50 ml-2">Vidéo</label>
                    <input
                      id="yt-video-msg"
                      type="text"
                      placeholder="🎥 Nouvelle vidéo de [channel] : [title]"
                      bind:value={ytForm.videoMessage}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                    />
                  </div>

                  <div class="space-y-1.5">
                    <label for="yt-short-msg" class="text-[11px] font-bold text-on-surface-variant/50 ml-2">Short</label>
                    <input
                      id="yt-short-msg"
                      type="text"
                      placeholder="⚡ Nouveau Short de [channel] !"
                      bind:value={ytForm.shortMessage}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                    />
                  </div>
                </div>
              </div>

              <button
                onclick={handleAddYoutube}
                disabled={!canManage}
                class="w-full mt-4 py-3.5 bg-red-600 hover:bg-red-700 text-white font-medium text-[13px] rounded-lg shadow-sm hover: active:scale-[0.98] transition-all disabled:opacity-50"
              >
                Ajouter la chaîne
              </button>
            </div>
          </div>
        {:else}
          <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 sticky top-8 shadow-sm">
            <h3 class="text-lg font-semibold flex items-center gap-2.5 text-[#9146FF]">
              <svg class="w-5 h-5 fill-current" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
              </svg>
              Suivre un streamer Twitch
            </h3>

            <div class="space-y-4">
              <div class="space-y-1.5">
                <label for="twitch-query" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Pseudo ou Lien Twitch</label>
                <input
                  id="twitch-query"
                  type="text"
                  placeholder="ex: xqc ou https://twitch.tv/xqc"
                  bind:value={twitchForm.query}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#9146FF]/30 transition-all text-on-surface"
                />
              </div>

              <div class="space-y-1.5">
                <label for="twitch-chan" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon des alertes</label>
                <SearchableSelect id="twitch-chan" bind:value={twitchForm.discordChannelId} options={availableChannels.map(ch => ({ id: ch.id, name: '#' + ch.name }))} placeholder="— Par défaut (Salon Public) —" className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-[#9146FF]/30 transition-all" />
              </div>

              <div class="space-y-1.5">
                <label for="twitch-mention" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Mention (rôle à ping)</label>
                <input
                  id="twitch-mention"
                  type="text"
                  placeholder="@everyone ou <@&role_id>"
                  bind:value={twitchForm.mention}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#9146FF]/30 transition-all text-on-surface"
                />
              </div>

              <div class="space-y-1.5">
                <label for="twitch-live-msg" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Message Live</label>
                <input
                  id="twitch-live-msg"
                  type="text"
                  placeholder="🎥 [channel] est en live sur Twitch !"
                  bind:value={twitchForm.liveMessage}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#9146FF]/30 transition-all text-on-surface"
                />
                <p class="text-[10px] text-on-surface-variant/40 ml-2">Variables: [title], [channel]</p>
              </div>

              <button
                onclick={handleAddTwitch}
                disabled={!canManage}
                class="w-full mt-4 py-3.5 bg-[#9146FF] hover:bg-[#772ce8] text-white font-medium text-[13px] rounded-lg shadow-lg shadow-[#9146FF]/20 hover: active:scale-[0.98] transition-all disabled:opacity-50"
              >
                Suivre le streamer
              </button>
            </div>
          </div>
        {/if}
      </div>

      <!-- LIST COLUMN -->
      <div class="lg:col-span-2 space-y-6">
        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 min-h-100">

          {#if activeTab === 'youtube'}
            <div class="flex items-center justify-between border-b border-outline-variant/20 pb-4">
              <h3 class="text-xl font-semibold flex items-center gap-2">
                <svg class="w-5 h-5 fill-red-600" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.508 9.388.508 9.388.508s7.518 0 9.388-.508a3.002 3.002 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                </svg>
                Chaînes suivies ({youtubeFollows.length})
              </h3>
            </div>

            {#if youtubeFollows.length === 0}
              <div class="flex flex-col items-center justify-center py-20 text-center text-on-surface-variant/50">
                <Papicon icon="Info" size={48} class="mb-4 text-on-surface-variant/30" />
                <p class="font-bold">Aucune chaîne YouTube suivie pour le moment.</p>
                <p class="text-xs">Remplissez le formulaire à gauche pour commencer.</p>
              </div>
            {:else}
              <div class="divide-y divide-outline-variant/10 space-y-6 divide-none">
                {#each youtubeFollows as follow (follow.id)}
                  <div class="p-6 rounded-xl bg-surface-container-high/15 border border-outline-variant/5 hover:border-outline-variant/10 transition-all">
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                      <div class="space-y-1">
                        <h4 class="font-bold text-base flex items-center gap-2">
                          <span class="w-2.5 h-2.5 bg-red-600 rounded-full"></span>
                          {follow.channelName}
                        </h4>
                        <p class="text-xs text-on-surface-variant/40 font-mono">ID: {follow.channelId}</p>
                      </div>

                      <div class="flex items-center gap-2">
                        <button
                          onclick={() => handleUpdateYoutube(follow)}
                          disabled={!canManage}
                          title="Sauvegarder la configuration"
                          class="p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl transition-all"
                        >
                          <Papicon icon="Gear" size={16} />
                        </button>
                        <button
                          onclick={() => handleDeleteYoutube(follow.id)}
                          disabled={!canManage}
                          title="Ne plus suivre"
                          class="p-3 bg-red-600/10 hover:bg-red-600/20 text-red-600 rounded-xl transition-all"
                        >
                          <Papicon icon="Trash" size={16} />
                        </button>
                      </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                      <div class="space-y-1">
                        <span class="text-[11px] font-bold text-on-surface-variant/50 uppercase">Salon des alertes</span>
                        <SearchableSelect bind:value={follow.discordChannelId} options={availableChannels.map(ch => ({ id: ch.id, name: '#' + ch.name }))} placeholder="— Par défaut —" className="w-full bg-surface-container/60 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs" />
                      </div>

                      <div class="space-y-1">
                        <label for="yt-mention-{follow.id}" class="text-[11px] font-bold text-on-surface-variant/50 uppercase">Mention</label>
                        <input
                          id="yt-mention-{follow.id}"
                          type="text"
                          bind:value={follow.mention}
                          placeholder="@everyone"
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                        />
                      </div>
                    </div>

                    <div class="mb-6 p-4 rounded-lg bg-surface-container/30 border border-outline-variant/5">
                      <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest mb-3">Messages par type d'alerte</p>
                      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div class="space-y-1">
                          <label for="yt-live-msg-{follow.id}" class="text-[11px] font-bold text-on-surface-variant/50">Live</label>
                          <input
                            id="yt-live-msg-{follow.id}"
                            type="text"
                            bind:value={follow.liveMessage}
                            placeholder="Message par défaut"
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                          />
                        </div>
                        <div class="space-y-1">
                          <label for="yt-video-msg-{follow.id}" class="text-[11px] font-bold text-on-surface-variant/50">Vidéo</label>
                          <input
                            id="yt-video-msg-{follow.id}"
                            type="text"
                            bind:value={follow.videoMessage}
                            placeholder="Message par défaut"
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                          />
                        </div>
                        <div class="space-y-1">
                          <label for="yt-short-msg-{follow.id}" class="text-[11px] font-bold text-on-surface-variant/50">Short</label>
                          <input
                            id="yt-short-msg-{follow.id}"
                            type="text"
                            bind:value={follow.shortMessage}
                            placeholder="Message par défaut"
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-600/30 transition-all text-on-surface"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {:else}
            <!-- TWITCH LIST -->
            <div class="flex items-center justify-between border-b border-outline-variant/20 pb-4">
              <h3 class="text-xl font-semibold flex items-center gap-2">
                <svg class="w-5 h-5 fill-[#9146FF]" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
                </svg>
                Streamers suivis ({twitchFollows.length})
              </h3>
            </div>

            {#if twitchFollows.length === 0}
              <div class="flex flex-col items-center justify-center py-20 text-center text-on-surface-variant/50">
                <Papicon icon="Info" size={48} class="mb-4 text-on-surface-variant/30" />
                <p class="font-bold">Aucun streamer Twitch suivi pour le moment.</p>
                <p class="text-xs">Remplissez le formulaire à gauche pour commencer.</p>
              </div>
            {:else}
              <div class="divide-y divide-outline-variant/10 space-y-6 divide-none">
                {#each twitchFollows as follow (follow.id)}
                  <div class="p-6 rounded-xl bg-surface-container-high/15 border border-outline-variant/5 hover:border-outline-variant/10 transition-all space-y-4">
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div class="space-y-1">
                        <h4 class="font-bold text-base flex items-center gap-2">
                          {#if follow.isLive}
                            <span class="relative flex h-3 w-3">
                              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                              <span class="relative inline-flex rounded-full h-3 w-3 bg-red-600"></span>
                            </span>
                          {:else}
                            <span class="w-3 h-3 bg-zinc-600 rounded-full"></span>
                          {/if}
                          {follow.streamerName}
                        </h4>
                        <p class="text-[10px] uppercase font-bold text-on-surface-variant/40">
                          {follow.isLive ? '🔴 En Live' : '⚫ Hors ligne'}
                        </p>
                      </div>

                      <div class="flex items-center gap-2 self-end md:self-center">
                        <button
                          onclick={() => handleUpdateTwitch(follow)}
                          disabled={!canManage}
                          title="Sauvegarder la configuration"
                          class="p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl transition-all"
                        >
                          <Papicon icon="Gear" size={16} />
                        </button>
                        <button
                          onclick={() => handleDeleteTwitch(follow.id)}
                          disabled={!canManage}
                          title="Ne plus suivre"
                          class="p-3 bg-red-600/10 hover:bg-red-600/20 text-red-600 rounded-xl transition-all"
                        >
                          <Papicon icon="Trash" size={16} />
                        </button>
                      </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div class="space-y-1">
                        <span class="text-[11px] font-bold text-on-surface-variant/50 uppercase">Salon des alertes</span>
                        <SearchableSelect bind:value={follow.discordChannelId} options={(availableChannels || []).map(ch => ({ id: ch.id, name: '#' + ch.name }))} placeholder="— Par défaut —" className="w-full bg-surface-container/60 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs" />
                      </div>

                      <div class="space-y-1">
                        <label for="twitch-mention-{follow.id}" class="text-[11px] font-bold text-on-surface-variant/50 uppercase">Mention</label>
                        <input
                          id="twitch-mention-{follow.id}"
                          type="text"
                          bind:value={follow.mention}
                          placeholder="@everyone"
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#9146FF]/30 transition-all text-on-surface"
                        />
                      </div>

                      <div class="space-y-1">
                        <label for="twitch-live-msg-{follow.id}" class="text-[11px] font-bold text-on-surface-variant/50 uppercase">Message Live</label>
                        <input
                          id="twitch-live-msg-{follow.id}"
                          type="text"
                          bind:value={follow.liveMessage}
                          placeholder="Message par défaut"
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#9146FF]/30 transition-all text-on-surface"
                        />
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</ModulePage>
