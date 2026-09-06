<script lang="ts">
  /**
   * Campagnes marketing : une suite de messages programmes, adressee a une
   * audience choisie, dont on mesure la portee.
   *
   * L'editeur suit l'ordre des decisions : ce qu'on dit (les etapes), a qui
   * (l'audience), et comment on saura si ca a marche (le code d'invitation).
   */
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import {
    fetchCampaigns,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    setCampaignStatus,
    fetchCampaignReport,
    previewCampaignAudience,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { dateLocale } from '../lib/i18n';

  type Step = {
    id?: string;
    offsetMinutes: number;
    delivery: 'CHANNEL' | 'DM';
    channelId: string | null;
    content: string;
    embed: { title?: string; description?: string; color?: string; imageUrl?: string } | null;
    status?: string;
    sentAt?: string | null;
    recipientCount?: number;
    deliveredCount?: number;
    failedCount?: number;
    reactionCount?: number;
    lastError?: string | null;
  };

  type Campaign = {
    id: string;
    name: string;
    description: string | null;
    status: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
    startAt: string | null;
    audienceRoleIds: string[];
    audienceExcludeRoleIds: string[];
    audienceMinLevel: number | null;
    audienceMinTenureDays: number | null;
    audienceInactiveDays: number | null;
    targetGuildIds: string[];
    inviteCode: string | null;
    steps: Step[];
  };

  const STATUS_META: Record<string, { label: string; text: string; bg: string }> = {
    DRAFT: { label: 'Brouillon', text: 'text-on-surface-variant', bg: 'bg-surface-container' },
    SCHEDULED: { label: 'Planifiée', text: 'text-sky-500', bg: 'bg-sky-500/10' },
    RUNNING: { label: 'En cours', text: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    COMPLETED: { label: 'Terminée', text: 'text-on-surface-variant', bg: 'bg-surface-container' },
    CANCELLED: { label: 'Annulée', text: 'text-error', bg: 'bg-error/10' },
  };

  let campaigns = $state<Campaign[]>([]);
  let loading = $state(true);
  let reports = $state<Record<string, { recipients: number; delivered: number; failed: number; reactions: number; joins: number }>>({});

  let modalOpen = $state(false);
  let saving = $state(false);
  let editingId = $state<string | null>(null);
  let form = $state(emptyForm());
  let audiencePreview = $state<{ count: number; sample: { id: string; name: string }[] } | null>(null);
  let previewing = $state(false);

  const discordRoles = $derived(dashboardStore.state.discordRoles || []);
  const discordChannels = $derived(dashboardStore.state.discordChannels || []);

  function emptyForm() {
    return {
      name: '',
      description: '',
      startAt: '',
      audienceRoleIds: [] as string[],
      audienceExcludeRoleIds: [] as string[],
      audienceMinLevel: '',
      audienceMinTenureDays: '',
      audienceInactiveDays: '',
      targetGuildIds: [] as string[],
      inviteCode: '',
      steps: [emptyStep()] as Step[],
    };
  }

  function emptyStep(): Step {
    return { offsetMinutes: 0, delivery: 'CHANNEL', channelId: null, content: '', embed: null };
  }

  /** Rend lisible un décalage exprimé en minutes. */
  function offsetLabel(minutes: number): string {
    if (minutes === 0) return 'Jour J';
    const abs = Math.abs(minutes);
    const unit = abs >= 1440 ? `${Math.round(abs / 1440)} j` : abs >= 60 ? `${Math.round(abs / 60)} h` : `${abs} min`;
    return minutes < 0 ? `J−${unit}` : `J+${unit}`;
  }

  const stepsSent = (c: Campaign) => c.steps.filter((s) => s.status === 'SENT').length;

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      const data = await fetchCampaigns();
      campaigns = data?.campaigns ?? [];
      // Les indicateurs ne concernent que ce qui est parti : les charger pour
      // un brouillon reviendrait a afficher des zéros sans signification.
      await Promise.all(
        campaigns
          .filter((c) => c.status === 'RUNNING' || c.status === 'COMPLETED')
          .map(async (c) => {
            const res = await fetchCampaignReport(c.id).catch(() => null);
            if (res?.report) reports = { ...reports, [c.id]: res.report };
          }),
      );
    } catch (err: any) {
      toast.error(err?.message || 'Chargement des campagnes impossible');
    } finally {
      loading = false;
    }
  }

  function openNew() {
    editingId = null;
    form = emptyForm();
    audiencePreview = null;
    modalOpen = true;
  }

  function openEdit(campaign: Campaign) {
    editingId = campaign.id;
    form = {
      name: campaign.name,
      description: campaign.description ?? '',
      // `datetime-local` n'accepte ni le fuseau ni les secondes.
      startAt: campaign.startAt ? campaign.startAt.slice(0, 16) : '',
      audienceRoleIds: [...campaign.audienceRoleIds],
      audienceExcludeRoleIds: [...campaign.audienceExcludeRoleIds],
      audienceMinLevel: campaign.audienceMinLevel?.toString() ?? '',
      audienceMinTenureDays: campaign.audienceMinTenureDays?.toString() ?? '',
      audienceInactiveDays: campaign.audienceInactiveDays?.toString() ?? '',
      targetGuildIds: [...campaign.targetGuildIds],
      inviteCode: campaign.inviteCode ?? '',
      steps: campaign.steps.map((s) => ({ ...s })),
    };
    audiencePreview = null;
    modalOpen = true;
  }

  function payload() {
    return {
      name: form.name,
      description: form.description,
      startAt: form.startAt ? new Date(form.startAt).toISOString() : null,
      audienceRoleIds: form.audienceRoleIds,
      audienceExcludeRoleIds: form.audienceExcludeRoleIds,
      audienceMinLevel: form.audienceMinLevel,
      audienceMinTenureDays: form.audienceMinTenureDays,
      audienceInactiveDays: form.audienceInactiveDays,
      targetGuildIds: form.targetGuildIds,
      inviteCode: form.inviteCode,
      steps: form.steps,
    };
  }

  async function save() {
    if (saving) return;
    if (!form.name.trim()) {
      toast.error('Donnez un nom à la campagne.');
      return;
    }

    saving = true;
    try {
      if (editingId) await updateCampaign(editingId, payload());
      else await createCampaign(payload());
      toast.success(editingId ? 'Campagne mise à jour' : 'Campagne créée');
      modalOpen = false;
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Enregistrement impossible');
    } finally {
      saving = false;
    }
  }

  async function preview() {
    if (previewing) return;
    previewing = true;
    try {
      audiencePreview = await previewCampaignAudience({
        audienceRoleIds: form.audienceRoleIds,
        audienceExcludeRoleIds: form.audienceExcludeRoleIds,
        audienceMinLevel: form.audienceMinLevel,
        audienceMinTenureDays: form.audienceMinTenureDays,
        audienceInactiveDays: form.audienceInactiveDays,
      });
    } catch (err: any) {
      toast.error(err?.message || "Calcul de l'audience impossible");
    } finally {
      previewing = false;
    }
  }

  async function changeStatus(campaign: Campaign, status: string) {
    if (status === 'SCHEDULED') {
      const dmSteps = campaign.steps.filter((s) => s.delivery === 'DM').length;
      const confirmed = await confirmDialog.ask({
        title: `Lancer « ${campaign.name} » ?`,
        description: dmSteps > 0
          ? `${campaign.steps.length} étape(s), dont ${dmSteps} en message privé. Les envois partent automatiquement à leur échéance et ne se rattrapent pas.`
          : `${campaign.steps.length} étape(s) partiront automatiquement à leur échéance.`,
        confirmLabel: 'Lancer',
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    try {
      await setCampaignStatus(campaign.id, status);
      await load();
      toast.success('Statut mis à jour');
    } catch (err: any) {
      toast.error(err?.message || 'Changement de statut impossible');
    }
  }

  async function remove(campaign: Campaign) {
    const confirmed = await confirmDialog.ask({
      title: `Supprimer « ${campaign.name} » ?`,
      description: 'La campagne et ses mesures sont perdues. Les messages déjà postés restent en place.',
      confirmLabel: 'Supprimer',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await deleteCampaign(campaign.id);
      toast.success('Campagne supprimée');
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Suppression impossible');
    }
  }

  onMount(load);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId) void load();
  });
</script>

<ModulePage
  title="Campagnes"
  description="Une suite de messages programmés, adressée à une audience choisie, dont on mesure la portée"
  icon="megaphone"
  featureKey="settings"
>
  {#snippet actions()}
    <ActionButton variant="primary" size="sm" icon="plus" label="Nouvelle campagne" onclick={openNew} />
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  {#if loading && campaigns.length === 0}
    <LoadingHint context="config" />
  {:else if campaigns.length === 0}
    <EmptyState
      icon="megaphone"
      title="Aucune campagne"
      description="Une campagne enchaîne plusieurs messages autour d'une date : un teaser, l'annonce, une relance."
    />
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      {#each campaigns as campaign (campaign.id)}
        {@const meta = STATUS_META[campaign.status]}
        {@const report = reports[campaign.id]}
        <SectionCard title={campaign.name} description={campaign.description || undefined}>
          {#snippet actions()}
            <span class="text-[11px] px-2 py-0.5 rounded-full font-semibold {meta.bg} {meta.text}">{meta.label}</span>
          {/snippet}

          <div class="space-y-3">
            <div class="flex flex-wrap items-center gap-3 text-[12px] text-on-surface-variant">
              <span class="inline-flex items-center gap-1.5">
                <Papicon icon="layers" size={13} />
                {stepsSent(campaign)}/{campaign.steps.length} étape(s) envoyée(s)
              </span>
              {#if campaign.startAt}
                <span class="inline-flex items-center gap-1.5">
                  <Papicon icon="calendar" size={13} />
                  {new Date(campaign.startAt).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              {/if}
              {#if campaign.targetGuildIds.length > 0}
                <span class="inline-flex items-center gap-1.5">
                  <Papicon icon="share" size={13} />
                  +{campaign.targetGuildIds.length} serveur(s)
                </span>
              {/if}
            </div>

            <!-- Frise des étapes : l'ordre d'envoi se lit d'un coup d'œil. -->
            <div class="space-y-1.5">
              {#each campaign.steps as step, i (step.id ?? i)}
                <div class="flex items-center gap-2.5 rounded-lg border border-outline-variant/20 bg-surface-container-low/40 px-3 py-2">
                  <span class="text-[11px] font-semibold tabular-nums text-on-surface-variant/70 w-14 shrink-0">
                    {offsetLabel(step.offsetMinutes)}
                  </span>
                  <Papicon icon={step.delivery === 'DM' ? 'mail' : 'hash'} size={13} class="text-on-surface-variant/60 shrink-0" />
                  <p class="text-[12px] text-on-surface truncate flex-1 min-w-0">{step.content}</p>
                  {#if step.status === 'SENT'}
                    <span class="text-[10.5px] text-emerald-500 shrink-0">
                      {step.deliveredCount}✓{step.failedCount ? ` ${step.failedCount}✗` : ''}
                    </span>
                  {:else if step.status === 'FAILED'}
                    <span class="text-[10.5px] text-error shrink-0" title={step.lastError ?? ''}>échec</span>
                  {/if}
                </div>
              {/each}
            </div>

            {#if report}
              <div class="grid grid-cols-4 gap-2 pt-1">
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
                  <div class="text-[13px] font-semibold text-on-surface tabular-nums">{report.delivered}</div>
                  <div class="text-[10px] text-on-surface-variant">Envoyés</div>
                </div>
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
                  <div class="text-[13px] font-semibold text-on-surface tabular-nums">{report.failed}</div>
                  <div class="text-[10px] text-on-surface-variant">Échecs</div>
                </div>
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
                  <div class="text-[13px] font-semibold text-on-surface tabular-nums">{report.reactions}</div>
                  <div class="text-[10px] text-on-surface-variant">Réactions</div>
                </div>
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center" title={campaign.inviteCode ? '' : "Sans code d'invitation, rien ne relie une arrivée à la campagne"}>
                  <div class="text-[13px] font-semibold text-on-surface tabular-nums">
                    {campaign.inviteCode ? report.joins : '-'}
                  </div>
                  <div class="text-[10px] text-on-surface-variant">Arrivées</div>
                </div>
              </div>
            {/if}

            <div class="flex flex-wrap gap-2 pt-1 border-t border-outline-variant/10">
              {#if campaign.status === 'DRAFT'}
                <ActionButton variant="primary" size="sm" icon="play" label="Lancer" onclick={() => changeStatus(campaign, 'SCHEDULED')} />
                <ActionButton variant="neutral" size="sm" icon="pencil" label="Modifier" onclick={() => openEdit(campaign)} />
              {:else if campaign.status === 'SCHEDULED' || campaign.status === 'RUNNING'}
                <ActionButton variant="warning" size="sm" icon="pause" label="Annuler" onclick={() => changeStatus(campaign, 'CANCELLED')} />
              {:else if campaign.status === 'CANCELLED'}
                <ActionButton variant="neutral" size="sm" icon="rotate-ccw" label="Repasser en brouillon" onclick={() => changeStatus(campaign, 'DRAFT')} />
              {/if}
              <ActionButton variant="danger" size="sm" icon="trash" label="Supprimer" onclick={() => remove(campaign)} />
            </div>
          </div>
        </SectionCard>
      {/each}
    </div>
  {/if}
</ModulePage>

<!-- ── Éditeur ──────────────────────────────────────────────────────────── -->
<Modal
  bind:open={modalOpen}
  title={editingId ? 'Modifier la campagne' : 'Nouvelle campagne'}
  subtitle="Ce qu'on dit, à qui, et comment on saura si ça a marché"
  size="xl"
  closeOnBackdropClick={!saving}
>
  <div class="p-5 space-y-4">
    <!-- ── Général ────────────────────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Nom</span>
          <FormInput type="text" bind:value={form.name} placeholder="Lancement de la saison 3" className="w-full" />
        </label>
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Date pivot (jour J)</span>
          <input
            type="datetime-local"
            bind:value={form.startAt}
            class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none"
          />
        </label>
      </div>

      <label class="block mt-3">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Description interne</span>
        <FormInput type="text" bind:value={form.description} placeholder="Vue par le staff seulement" className="w-full" />
      </label>
    </div>

    <!-- ── Étapes ─────────────────────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="campaign-section__header">
        <div class="campaign-section__icon">
          <Papicon icon="layers" size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">Étapes</p>
          <p class="text-[12px] text-on-surface-variant mt-0.5 leading-relaxed">
            Le décalage se compte depuis la date pivot. Négatif pour un teaser : −10080 min = une semaine avant.
          </p>
        </div>
        <ActionButton variant="neutral" size="sm" icon="plus" label="Ajouter" onclick={() => (form.steps = [...form.steps, emptyStep()])} />
      </div>

      <div class="space-y-2.5 mt-3">
        {#each form.steps as step, index (index)}
          <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/60 p-3.5 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <span class="inline-flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-primary/15 text-primary text-[10.5px] font-bold flex items-center justify-center shrink-0">
                  {index + 1}
                </span>
                <span class="text-[11.5px] font-semibold text-on-surface-variant">
                  {offsetLabel(step.offsetMinutes)}
                </span>
              </span>
              {#if form.steps.length > 1}
                <button
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-error/10 text-on-surface-variant/70 hover:text-error transition-colors"
                  onclick={() => (form.steps = form.steps.filter((_, i) => i !== index))}
                  title="Retirer l'étape"
                >
                  <Papicon icon="trash" size={14} />
                </button>
              {/if}
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label class="block">
                <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Décalage (min)</span>
                <input
                  type="number"
                  bind:value={step.offsetMinutes}
                  class="w-full bg-surface-container-high text-sm px-3 py-2 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 outline-none"
                />
              </label>
              <label class="block">
                <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Diffusion</span>
                <FormSelect bind:value={step.delivery} className="w-full">
                  <option value="CHANNEL">Dans un salon</option>
                  <option value="DM">En message privé</option>
                </FormSelect>
              </label>
              {#if step.delivery === 'CHANNEL'}
                <label class="block">
                  <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Salon</span>
                  <FormSelect bind:value={step.channelId} className="w-full">
                    <option value={null}>Choisir…</option>
                    {#each discordChannels as channel (channel.id)}
                      <option value={channel.id}>#{channel.name}</option>
                    {/each}
                  </FormSelect>
                </label>
              {/if}
            </div>

            <FormTextarea
              bind:value={step.content}
              placeholder={'Le message. {server} et, en MP, {user} sont remplacés.'}
              className="w-full h-20"
            />
          </div>
        {/each}
      </div>
    </div>

    <!-- ── Audience ───────────────────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="campaign-section__header">
        <div class="campaign-section__icon">
          <Papicon icon="users" size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">Audience</p>
          <p class="text-[12px] text-on-surface-variant mt-0.5 leading-relaxed">
            Les critères se cumulent. Ils ne servent qu'aux étapes en message privé :
            un message en salon est vu par tous ceux qui y ont accès.
          </p>
        </div>
        <ActionButton
          variant="neutral"
          size="sm"
          icon="users"
          label={previewing ? 'Calcul…' : 'Compter'}
          disabled={previewing}
          onclick={preview}
        />
      </div>

      {#if audiencePreview}
        <p class="text-[12px] text-on-surface-variant rounded-lg bg-surface-container px-3 py-2 mt-3">
          <span class="font-semibold text-on-surface">{audiencePreview.count} membre(s)</span>
          {#if audiencePreview.sample.length > 0}
            · {audiencePreview.sample.map((s) => s.name).join(', ')}{audiencePreview.count > audiencePreview.sample.length ? '…' : ''}
          {/if}
        </p>
      {/if}

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div>
          <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Rôles visés</span>
          <MultiSelect
            bind:values={form.audienceRoleIds}
            options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
            placeholder="Tous les membres"
          />
        </div>
        <div>
          <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Rôles exclus</span>
          <MultiSelect
            bind:values={form.audienceExcludeRoleIds}
            options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
            placeholder="Personne"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <label class="block">
          <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Niveau minimum</span>
          <FormInput type="number" bind:value={form.audienceMinLevel} placeholder="-" className="w-full" />
        </label>
        <label class="block">
          <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Ancienneté (jours)</span>
          <FormInput type="number" bind:value={form.audienceMinTenureDays} placeholder="-" className="w-full" />
        </label>
        <label class="block">
          <span class="text-[11px] font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Inactif depuis (jours)</span>
          <FormInput type="number" bind:value={form.audienceInactiveDays} placeholder="-" className="w-full" />
        </label>
      </div>
    </div>

    <!-- ── Mesure & partenaires ───────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="campaign-section__header">
        <div class="campaign-section__icon">
          <Papicon icon="bar-chart-2" size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">Mesure &amp; partenaires</p>
          <p class="text-[12px] text-on-surface-variant mt-0.5 leading-relaxed">
            Comment attribuer les arrivées à la campagne, et où la relayer.
          </p>
        </div>
      </div>

      <div class="space-y-3 mt-3">
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Code d'invitation à créditer</span>
          <FormInput type="text" bind:value={form.inviteCode} placeholder="ex. saison3" className="w-full" />
          <span class="text-[10px] text-on-surface-variant/60 ml-1 mt-1 block">
            Les arrivées passées par ce code depuis la date pivot sont comptées comme conversions.
            Sans lui, aucune arrivée n'est attribuable à la campagne.
          </span>
        </label>

        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Diffuser aussi sur (IDs de serveurs)</span>
          <FormInput
            type="text"
            value={form.targetGuildIds.join(', ')}
            oninput={(e: Event) => {
              form.targetGuildIds = (e.target as HTMLInputElement).value
                .split(',').map((v) => v.trim()).filter(Boolean);
            }}
            placeholder="1234…, 5678…"
            className="w-full"
          />
          <span class="text-[10px] text-on-surface-variant/60 ml-1 mt-1 block">
            Serveurs partenaires où Kotbo est présent. Les étapes en salon y sont postées si le salon
            y existe sous le même identifiant ; les serveurs injoignables comptent comme des échecs.
          </span>
        </label>
      </div>
    </div>
  </div>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <ActionButton variant="neutral" label="Annuler" disabled={saving} onclick={() => (modalOpen = false)} />
      <ActionButton
        variant="primary"
        label={saving ? 'Enregistrement…' : 'Enregistrer'}
        disabled={saving}
        onclick={save}
      />
    </div>
  {/snippet}
</Modal>

<style>
  .campaign-section {
    background: var(--surface-container-low);
    border: 1px solid var(--outline-variant);
    border-radius: 0.875rem;
    padding: 1rem;
  }

  .campaign-section__header {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .campaign-section__icon {
    width: 2rem;
    height: 2rem;
    border-radius: 0.625rem;
    background: var(--surface-container-high);
    color: var(--on-surface-variant);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
</style>
