<script lang="ts">
  import { onMount } from 'svelte';
  import {
    detachAdminGuildBilling,
    fetchAdminBilling,
    resetAdminGuildBillingTrial,
    resyncAdminGuildBilling,
    setAdminGuildPlan,
    type AdminBillingGuild,
    type AdminBillingState,
    type AdminPlanKey,
  } from '../../lib/api';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import Papicon from '../../lib/components/Papicon.svelte';

  let billingState = $state<AdminBillingState | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let search = $state('');
  let filter = $state('ALL');
  let busyIds = $state<string[]>([]);
  let drafts = $state<Record<string, AdminPlanKey>>({});
  let reasons = $state<Record<string, string>>({});

  const guilds = $derived(billingState?.guilds ?? []);
  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return guilds
      .filter((guild) => !needle || (guild.name ?? '').toLowerCase().includes(needle) || guild.id.includes(needle))
      .filter((guild) => filter === 'ALL' || guild.plan === filter || (filter === 'STRIPE' && Boolean(guild.stripeSubscriptionId)))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, 'fr'));
  });

  onMount(load);

  async function load() {
    try {
      billingState = await fetchAdminBilling();
      drafts = Object.fromEntries(billingState.guilds.map((guild) => [guild.id, guild.plan]));
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de chargement';
    } finally {
      loading = false;
    }
  }

  function setBusy(id: string, value: boolean) {
    busyIds = value ? [...busyIds, id] : busyIds.filter((item) => item !== id);
  }

  async function run(guild: AdminBillingGuild, action: () => Promise<{ message: string }>) {
    setBusy(guild.id, true);
    try {
      const result = await action();
      toast.success(result.message);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(guild.id, false);
    }
  }

  async function changePlan(guild: AdminBillingGuild) {
    const plan = drafts[guild.id] ?? guild.plan;
    if (plan === guild.plan) return;
    const reason = reasons[guild.id]?.trim() || 'modification depuis le big admin';
    const warning = guild.stripeSubscriptionId
      ? "Un abonnement Stripe est encore rattaché. Un prochain webhook peut remettre l'offre payée."
      : `Les droits du serveur passeront immédiatement à l'offre ${plan}.`;
    if (!(await confirmDialog.ask({ title: `Passer ${guild.name ?? guild.id} à ${plan} ?`, description: warning, confirmLabel: 'Changer l’offre', variant: 'warning' }))) return;
    await run(guild, () => setAdminGuildPlan(guild.id, plan, reason));
  }

  async function detach(guild: AdminBillingGuild) {
    if (!(await confirmDialog.danger(
      `Détacher Stripe de ${guild.name ?? guild.id} ?`,
      "Cette action efface uniquement le lien dans Kotbo. Elle n'annule pas l'abonnement et n'arrête pas les prélèvements dans Stripe.",
      'Détacher seulement',
    ))) return;
    await run(guild, () => detachAdminGuildBilling(guild.id));
  }

  async function resetTrial(guild: AdminBillingGuild) {
    if (!(await confirmDialog.ask({
      title: `Rendre l'essai à ${guild.name ?? guild.id} ?`,
      description: "Le serveur et le compte Discord qui avait lancé l'essai pourront recommencer un essai complet.",
      confirmLabel: "Rendre l'essai",
      variant: 'warning',
    }))) return;
    await run(guild, () => resetAdminGuildBillingTrial(guild.id));
  }

  async function resync(guild: AdminBillingGuild) {
    await run(guild, () => resyncAdminGuildBilling(guild.id));
  }

  function date(value: string | null): string {
    return value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
  }
</script>

<AdminShell title="Facturation" description="Offres, abonnements Stripe et essais gratuits de tous les serveurs.">
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-500">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStat label="Serveurs" value={guilds.length} icon="Server" loading={loading} />
      <AdminStat label="Abonnements Stripe" value={billingState?.subscriptions ?? 0} icon="CreditCard" tone="success" loading={loading} />
      <AdminStat label="Essais consommés" value={billingState?.trials ?? 0} icon="Clock" tone="info" loading={loading} />
      <AdminStat label="Offres Custom" value={billingState?.counts.CUSTOM ?? 0} icon="Sparkles" tone="warning" loading={loading} />
    </div>

    {#if billingState && !billingState.enabled}
      <div class="flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
        <Papicon icon="TriangleAlert" size={18} class="shrink-0 mt-0.5" />
        <p>Stripe n'est pas configuré sur cette instance. Les offres manuelles restent utilisables, mais la resynchronisation et les achats sont indisponibles.</p>
      </div>
    {/if}

    {#if error}
      <div class="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-500">{error}</div>
    {/if}

    <AdminToolbar
      bind:search
      bind:activeFilter={filter}
      placeholder="Nom ou identifiant du serveur…"
      resultCount={filtered.length}
      resultLabel="serveur"
      filters={[
        { value: 'ALL', label: 'Tous', count: guilds.length },
        ...(billingState?.plans ?? []).map((plan) => ({ value: plan.key, label: plan.name, count: billingState?.counts[plan.key] ?? 0 })),
        { value: 'STRIPE', label: 'Avec Stripe', count: billingState?.subscriptions ?? 0 },
      ]}
    />

    {#if loading}
      <div class="h-56 rounded-2xl bg-on-surface/6 animate-pulse"></div>
    {:else if filtered.length === 0}
      <div class="rounded-2xl border border-outline-variant/25 p-12 text-center text-sm text-on-surface-variant">Aucun serveur trouvé.</div>
    {:else}
      <div class="space-y-3">
        {#each filtered as guild (guild.id)}
          <section class="rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/70 p-4">
            <div class="flex flex-col xl:flex-row xl:items-start gap-4">
              <div class="min-w-0 xl:w-64">
                <div class="flex items-center gap-2">
                  <h2 class="font-semibold text-on-surface truncate">{guild.name ?? 'Serveur absent'}</h2>
                  {#if !guild.present}<span class="px-2 py-0.5 rounded-full bg-on-surface/8 text-[10px] text-on-surface-variant">hors bot</span>{/if}
                </div>
                <p class="text-xs font-mono text-on-surface-variant mt-1 select-all">{guild.id}</p>
                <p class="text-xs text-on-surface-variant mt-2">Accès : {guild.activated ? 'actif' : 'inactif'}{guild.accessExpiresAt ? ` jusqu'au ${date(guild.accessExpiresAt)}` : ''}</p>
              </div>

              <div class="grid sm:grid-cols-[150px_minmax(180px,1fr)_auto] gap-2 flex-1">
                <select bind:value={drafts[guild.id]} disabled={busyIds.includes(guild.id)} class="h-10 rounded-xl bg-surface-container-low border border-outline-variant/30 px-3 text-sm text-on-surface">
                  {#each billingState?.plans ?? [] as plan}<option value={plan.key}>{plan.name} ({plan.key})</option>{/each}
                </select>
                <input bind:value={reasons[guild.id]} placeholder="Motif (journal d'audit)" class="h-10 rounded-xl bg-surface-container-low border border-outline-variant/30 px-3 text-sm text-on-surface placeholder:text-on-surface-variant" />
                <button onclick={() => changePlan(guild)} disabled={busyIds.includes(guild.id) || drafts[guild.id] === guild.plan} class="h-10 px-4 rounded-xl bg-primary text-on-primary text-sm font-semibold disabled:opacity-40">Appliquer</button>
              </div>
            </div>

            <div class="mt-4 pt-4 border-t border-outline-variant/20 flex flex-col lg:flex-row lg:items-center gap-3">
              <div class="flex-1 text-xs text-on-surface-variant space-y-1 min-w-0">
                <p>Stripe : <span class="font-medium text-on-surface">{guild.stripeSubscriptionStatus ?? 'aucun abonnement'}</span>{guild.stripeCancelAtPeriodEnd ? ' · résiliation programmée' : ''}</p>
                {#if guild.stripeSubscriptionId}<p class="font-mono truncate select-all">{guild.stripeSubscriptionId} · fin de période {date(guild.stripeCurrentPeriodEnd)}</p>{/if}
                <p>Essai : {guild.trial ? (guild.trial.consumed ? `consommé par ${guild.trial.discordUserId}` : `réservé par ${guild.trial.discordUserId}`) : `disponible (${billingState?.trialDays ?? 15} jours)`}</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button onclick={() => resync(guild)} disabled={busyIds.includes(guild.id) || !guild.stripeSubscriptionId || !billingState?.enabled} class="h-9 px-3 rounded-lg bg-on-surface/6 hover:bg-on-surface/10 text-xs font-medium text-on-surface disabled:opacity-40">Resynchroniser</button>
                <button onclick={() => resetTrial(guild)} disabled={busyIds.includes(guild.id) || !guild.trial} class="h-9 px-3 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 text-xs font-medium text-amber-600 dark:text-amber-400 disabled:opacity-40">Rendre l'essai</button>
                <button onclick={() => detach(guild)} disabled={busyIds.includes(guild.id) || (!guild.stripeCustomerId && !guild.stripeSubscriptionId)} class="h-9 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/15 text-xs font-medium text-red-500 disabled:opacity-40">Détacher Stripe</button>
              </div>
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</AdminShell>
