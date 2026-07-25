<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { 
    fetchGiveaways, 
    createGiveaway, 
    endGiveaway, 
    rerollGiveaway, 
    deleteGiveaway 
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  let showModal = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.giveaways?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let giveaways = $state<Array<{
    id: string;
    channelId: string;
    messageId: string | null;
    prize: string;
    description: string | null;
    winnerCount: number;
    endsAt: string;
    ended: boolean;
    participants: string[];
    winners: string[];
    createdAt: string;
  }>>([]);

  // Form states
  let formPrize = $state('');
  let formDescription = $state('');
  let formWinnerCount = $state(1);
  let durationValue = $state(1);
  let durationUnit = $state('hours');
  let formChannelId = $state('');

  const computedDurationMinutes = $derived.by(() => {
    const val = durationValue || 1;
    if (durationUnit === 'minutes') return val;
    if (durationUnit === 'hours') return val * 60;
    if (durationUnit === 'days') return val * 1440;
    return val;
  });

  const presets = [
    { label: m.e8_giveaways_preset_30m(), value: 30, unit: 'minutes' },
    { label: m.e8_giveaways_preset_1h(), value: 1, unit: 'hours' },
    { label: m.e8_giveaways_preset_12h(), value: 12, unit: 'hours' },
    { label: m.e8_giveaways_preset_1d(), value: 1, unit: 'days' },
    { label: m.e8_giveaways_preset_3d(), value: 3, unit: 'days' },
    { label: m.e8_giveaways_preset_7d(), value: 7, unit: 'days' },
  ];

  function applyPreset(preset: typeof presets[0]) {
    durationValue = preset.value;
    durationUnit = preset.unit;
  }

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchGiveaways();
      if (res && res.giveaways) {
        giveaways = res.giveaways;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  function openCreateModal() {
    formPrize = '';
    formDescription = '';
    formWinnerCount = 1;
    durationValue = 1;
    durationUnit = 'hours';
    formChannelId = '';
    actionState.clearFeedback();
    showModal = true;
  }

  async function handleCreate() {
    if (!canManageSettings || !formPrize || !formWinnerCount || !computedDurationMinutes || !formChannelId) return;
    await actionState.run(async () => {
      const res = await createGiveaway({
        prize: formPrize,
        description: formDescription || undefined,
        winnerCount: formWinnerCount,
        durationMinutes: computedDurationMinutes,
        channelId: formChannelId
      });
      if (!res || !res.giveaway) throw new Error(m.e8_giveaways_error_create());
      giveaways = [res.giveaway, ...giveaways];
      showModal = false;
      return true;
    }, { successMessage: m.e8_giveaways_success_create() });
  }

  async function handleEnd(id: string) {
    if (!canManageSettings) return;
    await actionState.run(async () => {
      const ok = await endGiveaway(id);
      if (!ok) throw new Error(m.e8_giveaways_error_end());
      giveaways = giveaways.map(g => g.id === id ? { ...g, ended: true } : g);
      const res = await fetchGiveaways();
      if (res && res.giveaways) giveaways = res.giveaways;
      return true;
    }, { successMessage: m.e8_giveaways_success_end() });
  }

  async function handleReroll(id: string) {
    if (!canManageSettings) return;
    await actionState.run(async () => {
      const ok = await rerollGiveaway(id);
      if (!ok) throw new Error(m.e8_giveaways_error_reroll());
      const res = await fetchGiveaways();
      if (res && res.giveaways) giveaways = res.giveaways;
      return true;
    }, { successMessage: m.e8_giveaways_success_reroll() });
  }

  async function handleDelete(id: string) {
    if (!canManageSettings) return;
    if (!(await confirmDialog.danger(m.e8_giveaways_confirm_delete_title(), m.e8_giveaways_confirm_delete_desc()))) return;
    await actionState.run(async () => {
      const ok = await deleteGiveaway(id);
      if (!ok) throw new Error(m.e8_giveaways_error_delete());
      giveaways = giveaways.filter(g => g.id !== id);
      return true;
    }, { successMessage: m.e8_giveaways_success_delete() });
  }

  function getChannelName(channelId: string) {
    const channel = availableChannels.find(c => c.id === channelId);
    return channel ? channelDisplayName(channel) : m.e8_giveaways_unknown_channel({ channelId });
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleString('fr-FR', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDurationLabel(minutes: number) {
    if (minutes < 60) return m.e8_giveaways_duration_min({ minutes });
    if (minutes < 1440) return m.e8_giveaways_duration_hours({ hours: Math.round(minutes / 60) });
    return m.e8_giveaways_duration_days({ days: Math.round(minutes / 1440) });
  }
</script>

<ModulePage
  title="Giveaways"
  description="Créez et gérez des tirages au sort interactifs avec boutons de participation."
  icon="sparkles"
  featureKey="giveaways"
>
  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="space-y-4">
      <Skeleton height="100px" radius="2rem" />
      <Skeleton height="100px" radius="2rem" />
      <Skeleton height="100px" radius="2rem" />
    </div>
  {:else}
    <div class="space-y-6">
      <!-- Title & Actions Bar -->
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="List" size={20} class="text-secondary" />
          Liste des Concours ({giveaways.length})
        </h3>

        {#if canManageSettings}
          <button
            onclick={openCreateModal}
            class="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary font-medium text-[13px] rounded-lg transition-all cursor-pointer"
          >
            <Papicon icon="Add" size={16} />
            Lancer un Concours
          </button>
        {/if}
      </div>

      <!-- Giveaways list -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {#each giveaways as giveaway}
          <div class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl flex flex-col justify-between hover:bg-surface-container-low/50 hover:border-outline-variant/20 hover:shadow-sm hover:shadow-primary/5 transition-all duration-300 relative group">
            <div class="space-y-4">
              <!-- Status & Destination -->
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <span class="text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-xl {giveaway.ended ? 'bg-outline-variant/20 text-on-surface-variant' : 'bg-primary/10 text-primary border border-primary/20 animate-pulse'}">
                  {giveaway.ended ? 'Terminé' : 'En cours'}
                </span>
                <span class="text-[11px] font-bold text-on-surface-variant/70 flex items-center gap-1 bg-surface-container-high/40 px-2 py-1 rounded-lg">
                  <Papicon icon="Hash" size={11} />{getChannelName(giveaway.channelId)}
                </span>
              </div>

              <!-- Prize & Description -->
              <div class="space-y-1">
                <h4 class="text-lg font-semibold text-on-surface leading-tight group-hover:text-primary transition-colors duration-300">{giveaway.prize}</h4>
                {#if giveaway.description}
                  <p class="text-xs text-on-surface-variant/70 font-medium line-clamp-3 leading-relaxed">{giveaway.description}</p>
                {/if}
              </div>

              <!-- Stats row -->
              <div class="flex flex-wrap gap-2 pt-3 border-t border-outline-variant/10">
                <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/10">
                  <Papicon icon="Users" size={10} />{giveaway.participants.length} participants
                </span>
                <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/10">
                  <Papicon icon="Crown" size={10} />{giveaway.winnerCount} gagnants
                </span>
              </div>

              <!-- Winners or Clock -->
              {#if giveaway.ended}
                <div class="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3 space-y-1">
                  <span class="text-xs font-medium text-emerald-400 flex items-center gap-1">
                    <Papicon icon="Crown" size={10} /> Gagnant(s)
                  </span>
                  <p class="text-xs font-bold text-emerald-300/95 wrap-break-word">
                    {giveaway.winners.length > 0 ? giveaway.winners.join(', ') : 'Aucun gagnant'}
                  </p>
                </div>
              {:else}
                <div class="bg-surface-container-high/20 border border-outline-variant/5 rounded-lg p-3 flex items-center gap-2 text-on-surface-variant/60">
                  <Papicon icon="Clock" size={12} class="text-primary" />
                  <span class="text-[10px] font-semibold">
                    Fin le {formatDate(giveaway.endsAt)}
                  </span>
                </div>
              {/if}
            </div>

            <!-- Actions -->
            {#if canManageSettings}
              <div class="flex items-center gap-2 pt-4 mt-4 border-t border-outline-variant/10 justify-end">
                {#if !giveaway.ended}
                  <button
                    onclick={() => handleEnd(giveaway.id)}
                    class="px-3.5 py-2 bg-secondary hover:bg-secondary-hover text-on-secondary text-[10px] font-semibold uppercase tracking-wider rounded-xl transition-all shadow-md shadow-secondary/10 cursor-pointer flex items-center gap-1.5"
                    title="Forcer la fin et tirer au sort"
                  >
                    <Papicon icon="Sparkles" size={11} />
                    Tirer Gagnant
                  </button>
                {:else}
                  <button
                    onclick={() => handleReroll(giveaway.id)}
                    class="px-3.5 py-2 bg-outline-variant/20 hover:bg-outline-variant/35 text-on-surface text-[10px] font-semibold uppercase tracking-wider rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
                    title="Effectuer un nouveau tirage"
                  >
                    <Papicon icon="Refresh" size={11} />
                    Reroll
                  </button>
                {/if}
                <button
                  onclick={() => handleDelete(giveaway.id)}
                  class="p-2 text-error hover:bg-error/10 border border-transparent rounded-xl transition-all cursor-pointer"
                  title="Supprimer du dashboard"
                >
                  <Papicon icon="Trash" size={16} />
                </button>
              </div>
            {/if}
          </div>
        {:else}
          <div class="col-span-full flex flex-col items-center justify-center py-20 bg-surface-container-low/20 border border-outline-variant/10 rounded-xl text-center">
            <Papicon icon="Sparkles" size={32} class="text-on-surface-variant/20 mb-3" />
            <p class="text-sm text-on-surface-variant/60 font-medium">Aucun concours configuré pour le moment.</p>
            {#if canManageSettings}
              <button
                onclick={openCreateModal}
                class="mt-4 flex items-center gap-2 px-4 py-2 bg-primary/10 hover:bg-primary/20 text-primary font-bold text-xs rounded-lg transition-all cursor-pointer"
              >
                <Papicon icon="Add" size={14} /> Lancer un premier concours
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</ModulePage>

<!-- Modal Création Giveaway -->
{#if showModal}
  <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
    <div class="bg-surface-container-low/95 border border-outline-variant/20 max-w-lg w-full rounded-xl p-8 space-y-6 shadow-sm relative" transition:scale={{ start: 0.97, duration: 150 }}>

      <!-- Close button -->
      <button
        onclick={() => showModal = false}
        class="absolute top-6 right-6 p-2 rounded-full bg-surface-container-high/40 hover:bg-rose-500/15 hover:text-rose-500 text-on-surface-variant transition-colors cursor-pointer"
        title="Fermer"
      >
        <Papicon icon="Cross" size={20} />
      </button>

      <!-- Modal Header -->
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center text-primary shadow-inner">
          <Papicon icon="Sparkles" size={24} />
        </div>
        <div>
          <h3 class="text-2xl font-semibold tracking-tight">Lancer un Concours</h3>
          <p class="text-xs text-on-surface-variant/80 font-medium">Configurez et déployez un giveaway sur Discord.</p>
        </div>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleCreate(); }} class="space-y-5 pt-2">
        <div class="space-y-1.5">
          <label for="modal-prize" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Lot / Prix</label>
          <input
            id="modal-prize"
            type="text"
            bind:value={formPrize}
            placeholder="Ex: Nitro Boost 1 Mois 💎"
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
            required
            disabled={!canManageSettings}
          />
        </div>

        <div class="space-y-1.5">
          <label for="modal-desc" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Description (Optionnel)</label>
          <textarea
            id="modal-desc"
            bind:value={formDescription}
            placeholder="Conditions ou détails supplémentaires..."
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-20 resize-none"
            disabled={!canManageSettings}
          ></textarea>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label for="modal-winners" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Nb. Gagnants</label>
            <input
              id="modal-winners"
              type="number"
              min="1"
              max="50"
              bind:value={formWinnerCount}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              required
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="modal-duration-value" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Durée du concours</label>
            <div class="flex gap-2">
              <input
                id="modal-duration-value"
                type="number"
                min="1"
                bind:value={durationValue}
                class="w-2/3 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                required
                disabled={!canManageSettings}
              />
              <select
                bind:value={durationUnit}
                class="w-1/3 bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary/30 transition-all focus:outline-none cursor-pointer"
                disabled={!canManageSettings}
              >
                <option value="minutes">Min</option>
                <option value="hours">Heures</option>
                <option value="days">Jours</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Presets -->
        <div class="space-y-1.5">
          <span class="text-[11px] font-bold text-on-surface-variant/50 ml-2 uppercase tracking-widest">Durées prédéfinies</span>
          <div class="flex flex-wrap gap-2 ml-1">
            {#each presets as preset}
              <button
                type="button"
                onclick={() => applyPreset(preset)}
                class="px-3 py-1.5 bg-surface-container-high/35 hover:bg-primary/10 border border-outline-variant/10 hover:border-primary/30 rounded-xl text-xs font-bold text-on-surface transition-all cursor-pointer {durationValue === preset.value && durationUnit === preset.unit ? 'bg-primary/15 border-primary/40 text-primary' : ''}"
                disabled={!canManageSettings}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="space-y-1.5">
          <label for="modal-channel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon d'envoi</label>
          <SearchableSelect
            id="modal-channel"
            bind:value={formChannelId}
            options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
            placeholder="Sélectionner le salon"
            className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
            disabled={!canManageSettings}
          />
        </div>

        <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
          <button
            type="button"
            onclick={() => showModal = false}
            class="px-6 py-3 bg-outline-variant/20 hover:bg-outline-variant/30 text-on-surface text-[13px] font-medium rounded-lg transition-all cursor-pointer"
          >
            Annuler
          </button>
          {#if canManageSettings}
            <button
              type="submit"
              class="px-8 py-3 bg-primary text-on-primary font-medium text-[13px] rounded-lg transition-all cursor-pointer"
            >
              Envoyer sur Discord
            </button>
          {/if}
        </div>
      </form>
    </div>
  </div>
{/if}
