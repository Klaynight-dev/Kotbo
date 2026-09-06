<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchActivationCodes, createActivationCode, deleteActivationCode } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  interface ActivationCode {
    id: string;
    code: string;
    isActive: boolean;
    usedByGuildId: string | null;
    guildName: string | null;
    accessType: 'PERMANENT' | 'TRIAL' | 'SUBSCRIPTION';
    durationMinutes: number | null;
    label: string | null;
    guildActivated: boolean | null;
    accessExpiresAt: string | null;
    accessExpiredAt: string | null;
  }

  let activationCodes = $state<ActivationCode[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Formulaire de génération : accès permanent ou période limitée. La durée est
  // saisie dans l'unité qui arrange, puis convertie en minutes, l'unité que
  // l'API et la base manipulent.
  const UNITS = { minute: 1, hour: 60, day: 1440 } as const;
  type Unit = keyof typeof UNITS;

  let grantType = $state<'PERMANENT' | 'TRIAL' | 'SUBSCRIPTION'>('PERMANENT');
  let grantAmount = $state(15);
  let grantUnit = $state<Unit>('day');
  let grantLabel = $state('');
  let generating = $state(false);

  const MS_PER_MINUTE = 60_000;

  const grantMinutes = $derived(Math.round(grantAmount * UNITS[grantUnit]));

  /** Raccourcis proposés selon l'unité choisie. */
  const presets = $derived(
    grantUnit === 'minute' ? [15, 30, 60] : grantUnit === 'hour' ? [1, 6, 24] : [7, 15, 30],
  );

  function minutesLeft(expiresAt: string): number {
    return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / MS_PER_MINUTE));
  }

  /** Même rendu que le bot côté Discord : « 15 jours », « 2 heures », « 30 minutes ». */
  function formatDuration(minutes: number): string {
    const plural = (v: number, word: string) => `${v} ${word}${v > 1 ? 's' : ''}`;
    if (minutes < 60) return plural(Math.max(1, minutes), 'minute');
    if (minutes < 1440) {
      const h = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? plural(h, 'heure') : `${plural(h, 'heure')} ${plural(rest, 'minute')}`;
    }
    const d = Math.floor(minutes / 1440);
    const restH = Math.floor((minutes % 1440) / 60);
    return restH === 0 ? plural(d, 'jour') : `${plural(d, 'jour')} ${plural(restH, 'heure')}`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** Libellé court du type d'accès porté par un code. */
  function accessLabel(item: ActivationCode): string {
    const duration = item.durationMinutes ? formatDuration(item.durationMinutes) : '';
    if (item.accessType === 'TRIAL') return `Essai ${duration}`;
    if (item.accessType === 'SUBSCRIPTION') return `Abonnement ${duration}`;
    return 'Permanent';
  }

  async function loadActivationCodes() {
    try {
      activationCodes = await fetchActivationCodes();
    } catch (err: any) {
      console.error('Erreur chargement codes activation:', err);
    }
  }

  onMount(async () => {
    try {
      await loadActivationCodes();
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  });

  async function handleGenerateCode() {
    if (grantType !== 'PERMANENT' && (!Number.isInteger(grantMinutes) || grantMinutes < 1)) {
      toast.error('Indiquez une durée valide.');
      return;
    }

    generating = true;
    try {
      const newCode = await createActivationCode({
        accessType: grantType,
        durationMinutes: grantType === 'PERMANENT' ? null : grantMinutes,
        label: grantLabel.trim() || null,
      });
      toast.success(
        grantType === 'PERMANENT'
          ? `Nouveau code généré : ${newCode.code}`
          : `Code ${formatDuration(grantMinutes)} généré : ${newCode.code}`,
      );
      grantLabel = '';
      await loadActivationCodes();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      generating = false;
    }
  }

  async function handleDeleteCode(codeId: string, code: string, usedBy: string | null) {
    const confirmed = usedBy
      ? await confirmDialog.danger(
          `Supprimer le code utilisé par « ${usedBy} » ?`,
          'Ce serveur sera immédiatement désactivé.',
        )
      : await confirmDialog.danger(`Supprimer le code d'activation ${code} ?`);
    if (!confirmed) return;
    try {
      await deleteActivationCode(codeId);
      toast.success("Code d'activation supprimé.");
      await loadActivationCodes();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

</script>

<AdminShell title="Codes d’activation" description="Génération et suivi des codes donnant accès aux fonctions complètes.">
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">
  {#if loading}
    <div class="space-y-8">
      <div class="premium-card rounded-[2.25rem] p-8">
        <div class="animate-pulse flex flex-wrap items-end gap-5">
          <div class="h-12 w-72 bg-surface/40 rounded-xl"></div>
          <div class="h-12 flex-1 min-w-[220px] bg-surface/40 rounded-xl"></div>
          <div class="h-12 w-44 bg-surface/40 rounded-xl"></div>
        </div>
      </div>
      <div class="premium-card rounded-[2.25rem] overflow-hidden">
        <div class="animate-pulse space-y-4 p-8">
          <div class="h-12 bg-surface/40 rounded-xl"></div>
          <div class="h-12 bg-surface/40 rounded-xl"></div>
          <div class="h-12 bg-surface/40 rounded-xl"></div>
        </div>
      </div>
    </div>
  {:else if error}
    <div class="bg-error/10 border border-error/20 p-8 rounded-[2.25rem] text-center">
      <Papicon icon="AlertTriangle" size={48} class="text-error mx-auto mb-4" />
      <h2 class="text-xl font-bold text-on-error-container">Erreur de chargement</h2>
      <p class="text-on-error-container/70 mt-2">{error}</p>
    </div>
  {:else}
    <div class="space-y-8 animate-in fade-in">
      <!-- Générateur : barre d'action pleine largeur, les champs ont enfin la
           place de tenir sur une ligne au lieu de s'empiler dans une colonne. -->
      <div class="premium-card rounded-[2.25rem] p-8 space-y-5">
        <div class="flex flex-wrap items-end gap-5">
          <!-- Type d'accès accordé par le code -->
          <div class="space-y-2">
            <span class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant/60">
              Type d'accès
            </span>
            <div role="group" aria-label="Type d'accès" class="inline-flex rounded-xl border border-outline-variant/30 bg-surface-container-high p-1 gap-1">
              {#each [{ v: 'PERMANENT', l: 'Permanent' }, { v: 'TRIAL', l: 'Essai' }, { v: 'SUBSCRIPTION', l: 'Abonnement' }] as option}
                <button
                  type="button"
                  aria-pressed={grantType === option.v}
                  onclick={() => (grantType = option.v as typeof grantType)}
                  class="px-4 py-2 rounded-lg text-xs font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 {grantType === option.v
                    ? 'bg-primary text-on-primary'
                    : 'text-on-surface-variant hover:text-on-surface'}"
                >
                  {option.l}
                </button>
              {/each}
            </div>
          </div>

          {#if grantType !== 'PERMANENT'}
            <div class="space-y-2 animate-in fade-in">
              <label for="grant-amount" class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant/60">
                Durée
              </label>
              <div class="flex items-center gap-2">
                <input
                  id="grant-amount"
                  type="number"
                  min="1"
                  bind:value={grantAmount}
                  class="w-20 px-4 py-2.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
                <select
                  aria-label="Unité de durée"
                  bind:value={grantUnit}
                  class="px-3 py-2.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                >
                  <option value="minute">minutes</option>
                  <option value="hour">heures</option>
                  <option value="day">jours</option>
                </select>
                {#each presets as preset}
                  <button
                    type="button"
                    onclick={() => (grantAmount = preset)}
                    class="px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 {grantAmount === preset
                      ? 'bg-primary/10 border-primary/40 text-primary'
                      : 'bg-surface-container-high border-outline-variant/30 text-on-surface-variant hover:border-outline-variant/60'}"
                  >
                    {preset}
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <div class="space-y-2 flex-1 min-w-[220px]">
            <label for="grant-label" class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant/60">
              Note interne <span class="normal-case tracking-normal text-on-surface-variant/40">(optionnel)</span>
            </label>
            <input
              id="grant-label"
              type="text"
              placeholder="Nom du client, contexte…"
              bind:value={grantLabel}
              class="w-full px-4 py-2.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <button
            onclick={handleGenerateCode}
            disabled={generating}
            class="shrink-0 px-6 py-2.5 rounded-xl bg-primary text-on-primary font-medium text-[13px] transition-all active:scale-95 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 flex items-center gap-2.5"
          >
            <Papicon icon="Unlock" size={16} />
            {generating ? 'Génération…' : 'Générer un code'}
          </button>
        </div>

        <!-- Une seule ligne d'aide, qui décrit ce que le code choisi va réellement faire. -->
        <p class="text-xs text-on-surface-variant/50 leading-relaxed border-t border-outline-variant/20 pt-4">
          {#if grantType === 'PERMANENT'}
            Accès sans expiration. Un code ne vaut que pour un seul serveur à la fois.
          {:else}
            Accès de {formatDuration(grantMinutes)}. Le serveur reçoit un embed à l'activation, un rappel à
            mi-parcours puis à J-3 et J-1 quand la période est assez longue, et se désactive automatiquement à
            l'échéance. Un code ne vaut que pour un seul serveur à la fois.
          {/if}
        </p>
      </div>

      <!-- Codes List Table -->
      <div class="space-y-6">
        <h2 class="text-xl font-semibold font-headline flex items-center gap-3 px-2">
          <Papicon icon="activity" size={24} class="text-purple-400" />
          Codes générés ({activationCodes.length})
        </h2>

        <div class="premium-card rounded-[2.25rem] overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse border-spacing-0">
              <thead class="bg-on-surface/5 text-on-surface-variant/40 text-xs font-medium">
                <tr>
                  <th class="px-6 py-5">Code d'activation</th>
                  <th class="px-6 py-5">Accès</th>
                  <th class="px-6 py-5">Serveur</th>
                  <th class="px-6 py-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/10">
                {#each activationCodes as item}
                  <tr class="hover:bg-on-surface/5 transition-colors group">
                    <td class="px-6 py-5">
                      <span class="font-mono text-sm font-semibold text-on-surface bg-surface-container-high px-3 py-1.5 rounded-lg border border-outline-variant/20 tracking-wider">
                        {item.code}
                      </span>
                      {#if item.label}
                        <p class="text-[11px] text-on-surface-variant/50 mt-1.5">{item.label}</p>
                      {/if}
                    </td>
                    <td class="px-6 py-5">
                      {#if item.accessType === 'PERMANENT'}
                        <span class="text-xs text-on-surface-variant/60 font-medium">{accessLabel(item)}</span>
                      {:else}
                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20">
                          <Papicon icon="Clock" size={12} />
                          {accessLabel(item)}
                        </span>
                        {#if item.accessExpiredAt}
                          <p class="text-[11px] text-error/70 mt-1.5 font-medium">
                            Expiré le {formatDate(item.accessExpiredAt)}
                          </p>
                        {:else if item.accessExpiresAt}
                          <p class="text-[11px] text-on-surface-variant/50 mt-1.5">
                            {formatDuration(minutesLeft(item.accessExpiresAt))} restantes · {formatDate(item.accessExpiresAt)}
                          </p>
                        {/if}
                      {/if}
                    </td>
                    <!-- Le serveur porte à lui seul le statut du code : un code
                         rattaché à un serveur est utilisé, un code libre est
                         disponible. Deux colonnes disaient la même chose. -->
                    <td class="px-6 py-5 text-sm">
                      {#if item.usedByGuildId}
                        <div class="flex items-center gap-2">
                          <p class="font-semibold text-on-surface">{item.guildName || 'Serveur inconnu'}</p>
                          {#if item.guildActivated === false}
                            <!-- Un essai révoqué à la main garde son code sans poser
                                 d'échéance : sans ce marqueur, la colonne Accès
                                 afficherait un décompte pour un serveur déjà coupé. -->
                            <span class="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-error/10 text-error border border-error/20">
                              Coupé
                            </span>
                          {/if}
                        </div>
                        <p class="text-[10px] text-on-surface-variant/40 font-mono tracking-tighter mt-0.5">{item.usedByGuildId}</p>
                      {:else if item.isActive}
                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-success/10 text-success border border-success/20">
                          <span class="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
                          Disponible
                        </span>
                      {:else}
                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-on-surface/5 text-on-surface-variant/60 border border-outline-variant/30">
                          <span class="w-1.5 h-1.5 rounded-full bg-on-surface-variant/40"></span>
                          Désactivé
                        </span>
                      {/if}
                    </td>
                    <td class="px-6 py-5 text-right">
                      <button
                        class="w-10 h-10 inline-flex items-center justify-center hover:bg-error/10 rounded-xl text-on-surface-variant hover:text-error transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
                        onclick={() => handleDeleteCode(item.id, item.code, item.guildName)}
                        title={item.usedByGuildId ? "Révoquer et désactiver le serveur" : "Supprimer ce code"}
                      >
                        <Papicon icon="Trash" size={18} />
                      </button>
                    </td>
                  </tr>
                {/each}
                {#if activationCodes.length === 0}
                  <tr>
                    <td colspan="4" class="px-6 py-12 text-center text-sm text-on-surface-variant/50">
                      Aucun code pour le moment. Générez-en un ci-dessus pour activer un serveur.
                    </td>
                  </tr>
                {/if}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  {/if}
  </div>
</AdminShell>
