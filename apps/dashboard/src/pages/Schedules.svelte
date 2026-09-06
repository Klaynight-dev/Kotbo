<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import {
    fetchSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    runScheduleNow
  } from '../lib/api';

  const createAction = createAsyncActionState();
  const updateAction = createAsyncActionState();
  const deleteAction = createAsyncActionState();
  const runAction = createAsyncActionState();

  let loading = $state(false);
  let schedules = $state<any[]>([]);
  let showCreateModal = $state(false);
  let showDeleteModal = $state(false);
  let selectedSchedule = $state<any>(null);
  let isEditing = $state(false);

  // Form states
  let formName = $state('');
  let formType = $state('CHANNEL_RESET');
  let formTargetId = $state<string | null>(null);
  let formFrequency = $state('daily');
  let formCron = $state('0 0 * * *');
  // Type SEND_MESSAGE : texte, embed facultatif, mentions et usage unique.
  let formMessage = $state('');
  let formEmbedTitle = $state('');
  let formEmbedDescription = $state('');
  let formEmbedColor = $state('');
  let formEmbedImageUrl = $state('');
  let formAllowMentions = $state(false);
  let formRunOnce = $state(false);

  const canManageSchedules = $derived(
    !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(
    dashboardStore.state.discordChannels || []
  );

  // Predefined frequencies mapping
  const frequencies = $derived([
    { key: 'hourly', label: m.schedules_freq_hourly(), value: '0 * * * *' },
    { key: 'daily', label: m.schedules_freq_daily(), value: '0 0 * * *' },
    { key: 'weekly', label: m.schedules_freq_weekly(), value: '0 0 * * 0' },
    { key: 'monthly', label: m.schedules_freq_monthly(), value: '0 0 1 * *' },
    { key: 'custom', label: m.schedules_freq_custom(), value: '' }
  ]);

  onMount(async () => {
    await loadSchedules();
  });

  async function loadSchedules() {
    loading = true;
    try {
      const data = await fetchSchedules(authStore.selectedGuildId ?? '');
      schedules = data || [];
    } catch (error) {
      console.error('Erreur lors du chargement des planifications:', error);
    }
    loading = false;
  }

  function handleFrequencyChange(freqKey: string) {
    formFrequency = freqKey;
    const found = frequencies.find(f => f.key === freqKey);
    if (found && freqKey !== 'custom') {
      formCron = found.value;
    }
  }

  function openCreateModal() {
    isEditing = false;
    formName = '';
    formType = 'CHANNEL_RESET';
    formTargetId = null;
    formFrequency = 'daily';
    formCron = '0 0 * * *';
    formMessage = '';
    formEmbedTitle = '';
    formEmbedDescription = '';
    formEmbedColor = '';
    formEmbedImageUrl = '';
    formAllowMentions = false;
    formRunOnce = false;
    showCreateModal = true;
  }

  function openEditModal(schedule: any) {
    isEditing = true;
    selectedSchedule = schedule;
    formName = schedule.name;
    formType = schedule.type;
    formTargetId = schedule.targetId;
    formMessage = schedule.message || '';
    formEmbedTitle = schedule.messageEmbed?.title || '';
    formEmbedDescription = schedule.messageEmbed?.description || '';
    formEmbedColor = schedule.messageEmbed?.color || '';
    formEmbedImageUrl = schedule.messageEmbed?.imageUrl || '';
    formAllowMentions = schedule.allowMentions === true;
    formRunOnce = schedule.runOnce === true;

    // Detect frequency type
    const foundFreq = frequencies.find(f => f.value === schedule.cron);
    if (foundFreq) {
      formFrequency = foundFreq.key;
      formCron = foundFreq.value;
    } else {
      formFrequency = 'custom';
      formCron = schedule.cron;
    }

    showCreateModal = true;
  }

  async function handleSaveSchedule() {
    if (!formName.trim()) {
      createAction.setError(m.schedules_err_name_required());
      return;
    }

    if (formType !== 'SERVER_BACKUP' && !formTargetId) {
      createAction.setError(m.schedules_err_target_required());
      return;
    }

    // Un message programme sans texte ni embed n'a rien a poster : le bot
    // echouerait a l'heure dite, longtemps apres l'enregistrement.
    const hasEmbed = !!(formEmbedTitle.trim() || formEmbedDescription.trim() || formEmbedImageUrl.trim());
    if (formType === 'SEND_MESSAGE' && !formMessage.trim() && !hasEmbed) {
      createAction.setError('Renseignez un texte ou un embed pour ce message programmé.');
      return;
    }

    const payload = {
      name: formName,
      type: formType,
      cron: formCron,
      targetId: formType === 'SERVER_BACKUP' ? null : formTargetId,
      enabled: isEditing ? selectedSchedule.enabled : true,
      ...(formType === 'SEND_MESSAGE'
        ? {
            message: formMessage,
            messageEmbed: hasEmbed
              ? {
                  title: formEmbedTitle,
                  description: formEmbedDescription,
                  color: formEmbedColor,
                  imageUrl: formEmbedImageUrl,
                }
              : null,
            allowMentions: formAllowMentions,
            runOnce: formRunOnce,
          }
        : {}),
    };

    await createAction.run(async () => {
      if (isEditing && selectedSchedule) {
        await updateSchedule(selectedSchedule.id, payload, authStore.selectedGuildId ?? '');
      } else {
        await createSchedule(payload, authStore.selectedGuildId ?? '');
      }
      showCreateModal = false;
      await loadSchedules();
      return true;
    }, {
      successMessage: isEditing ? m.schedules_success_updated() : m.schedules_success_created()
    });
  }

  async function handleDeleteSchedule() {
    if (!selectedSchedule) return;
    await deleteAction.run(async () => {
      await deleteSchedule(selectedSchedule.id, authStore.selectedGuildId ?? '');
      showDeleteModal = false;
      selectedSchedule = null;
      await loadSchedules();
      return true;
    }, {
      successMessage: m.schedules_success_deleted()
    });
  }

  async function handleToggleActive(schedule: any, enabled: boolean) {
    await updateAction.run(async () => {
      await updateSchedule(schedule.id, { enabled }, authStore.selectedGuildId ?? '');
      await loadSchedules();
      return true;
    }, {
      successMessage: enabled ? m.schedules_success_enabled() : m.schedules_success_disabled()
    });
  }

  async function handleRunNow(schedule: any) {
    await runAction.run(async () => {
      await runScheduleNow(schedule.id, authStore.selectedGuildId ?? '');
      await loadSchedules();
      return true;
    }, {
      successMessage: m.schedules_success_run()
    });
  }

  function getChannelName(channelId: string | null): string {
    if (!channelId) return m.schedules_channel_none();
    const found = availableChannels.find((c: any) => c.id === channelId);
    return found ? `#${found.name}` : `#${channelId}`;
  }

  function formatType(type: string): string {
    switch (type) {
      case 'CHANNEL_RESET': return m.schedules_type_channel_reset();
      case 'SERVER_BACKUP': return m.schedules_type_server_backup();
      case 'DATA_EXPORT': return m.schedules_type_data_export();
      case 'SEND_MESSAGE': return 'Message programmé';
      default: return type;
    }
  }

  function formatCron(cronExp: string): string {
    const matched = frequencies.find(f => f.value === cronExp);
    return matched ? matched.label : cronExp;
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return m.schedules_never();
    return new Date(dateStr).toLocaleDateString(dateLocale(), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
</script>

<ModulePage
  title={m.schedules_title()}
  description={m.schedules_description()}
  icon="calendar"
  featureKey="settings"
>
  {#snippet actions()}
    {#if canManageSchedules}
      <ActionButton onClick={openCreateModal} variant="primary" label={m.schedules_btn_new()} icon="plus" />
    {/if}
  {/snippet}

  <!-- Content Grid -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    {#if loading}
      {#each Array(3) as _}
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 h-[250px]">
          <Skeleton height="100%" radius="1.5rem" />
        </div>
      {/each}
    {:else if schedules.length === 0}
      <div class="col-span-full bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-12 flex flex-col items-center justify-center text-center space-y-4">
        <div class="w-16 h-16 bg-surface-container-high/40 rounded-full flex items-center justify-center text-on-surface-variant/40 border border-outline-variant/10">
          <Papicon icon="calendar" size={32} />
        </div>
        <div class="space-y-1">
          <h3 class="text-xl font-semibold">{m.schedules_empty_title()}</h3>
          <p class="text-sm text-on-surface-variant/70 font-medium">{m.schedules_empty_desc()}</p>
        </div>
        {#if canManageSchedules}
          <ActionButton onClick={openCreateModal} variant="primary" label={m.schedules_btn_create()} icon="plus" />
        {/if}
      </div>
    {:else}
      {#each schedules as schedule}
        <div class="relative overflow-hidden bg-surface-container-low/30 border border-outline-variant/10 hover:border-primary/30 rounded-xl p-6 flex flex-col justify-between transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/5">
          <div class="space-y-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <h3 class="text-lg font-semibold truncate leading-snug">{schedule.name}</h3>
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 mt-1 bg-surface-container-high/50 border border-outline-variant/15 text-[10px] font-semibold rounded-lg uppercase tracking-wider text-primary">
                  {formatType(schedule.type)}
                </span>
              </div>
              {#if canManageSchedules}
                <ToggleSwitch
                  checked={schedule.enabled}
                  onToggle={(v) => handleToggleActive(schedule, v)}
                  disabled={updateAction.state.loading}
                />
              {/if}
            </div>

            <!-- Details Block -->
            <div class="space-y-2.5 bg-surface-container-high/15 border border-outline-variant/5 p-4 rounded-lg text-xs font-semibold text-on-surface-variant">
              <div class="flex items-center gap-2">
                <div class="text-primary/70 shrink-0"><Papicon icon="clock" size={16} /></div>
                <span class="truncate">{m.schedules_freq_label({ freq: formatCron(schedule.cron) })}</span>
              </div>
              {#if schedule.type !== 'SERVER_BACKUP'}
                <div class="flex items-center gap-2">
                  <div class="text-primary/70 shrink-0"><Papicon icon="hash" size={16} /></div>
                  <span class="truncate">{m.schedules_target_channel_label({ channel: getChannelName(schedule.targetId) })}</span>
                </div>
              {/if}
              <div class="flex items-center gap-2 border-t border-outline-variant/5 pt-2 mt-1">
                <div class="text-primary/70 shrink-0"><Papicon icon="history" size={16} /></div>
                <span class="truncate">{m.schedules_last_run_label({ date: formatDate(schedule.lastRun) })}</span>
              </div>
            </div>
          </div>

          <!-- Actions Footer -->
          <div class="flex items-center justify-end gap-2 pt-4 border-t border-outline-variant/10 mt-4 shrink-0">
            {#if canManageSchedules}
              <ActionButton
                onClick={() => handleRunNow(schedule)}
                variant="muted"
                size="sm"
                label={m.schedules_btn_run()}
                icon="play"
                disabled={runAction.state.loading || !schedule.enabled}
              />
              <ActionButton
                onClick={() => openEditModal(schedule)}
                variant="muted"
                size="sm"
                label={m.schedules_btn_edit()}
                icon="edit-3"
                disabled={updateAction.state.loading}
              />
              <ActionButton
                onClick={() => { selectedSchedule = schedule; showDeleteModal = true; }}
                variant="danger"
                size="sm"
                label={m.schedules_btn_delete()}
                icon="trash"
                disabled={deleteAction.state.loading}
              />
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <InlineFeedback state={updateAction} />
  <InlineFeedback state={runAction} />
</ModulePage>

<!-- Modal de création / édition de planification -->
<Modal bind:open={showCreateModal} title={isEditing ? m.schedules_modal_edit_title() : m.schedules_modal_create_title()}>
  <div class="space-y-6">
    <!-- Nom -->
    <div class="space-y-2">
      <span class="block text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.schedules_form_task_name()}</span>
      <input
        type="text"
        bind:value={formName}
        placeholder={m.schedules_form_task_name_placeholder()}
        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
      />
    </div>

    <!-- Type -->
    <div class="space-y-2">
      <span class="block text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.schedules_form_action_type()}</span>
      <FormSelect
        bind:value={formType}
        className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
      >
        <option value="CHANNEL_RESET">{m.schedules_form_type_reset_option()}</option>
        <option value="SERVER_BACKUP">{m.schedules_form_type_backup_option()}</option>
        <option value="DATA_EXPORT">{m.schedules_form_type_export_option()}</option>
        <option value="SEND_MESSAGE">Message programmé</option>
      </FormSelect>
    </div>

    <!-- Salon Discord cible -->
    {#if formType !== 'SERVER_BACKUP'}
      <div class="space-y-2">
        <span class="block text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.schedules_form_target_channel()}</span>
        <SearchableSelect
          id="schedule-target-channel"
          bind:value={formTargetId}
          options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
          placeholder={m.schedules_form_target_channel_placeholder()}
          className="w-full"
        />
      </div>
    {/if}

    <!-- Message programmé -->
    {#if formType === 'SEND_MESSAGE'}
      <div class="space-y-2">
        <span class="block text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Message</span>
        <FormTextarea
          bind:value={formMessage}
          placeholder="Le texte posté dans le salon."
          className="w-full h-24"
        />
      </div>

      <details class="rounded-lg border border-outline-variant/10 bg-surface-container-high/20 px-4 py-3">
        <summary class="text-xs font-semibold text-on-surface cursor-pointer select-none">Embed (facultatif)</summary>
        <div class="mt-3 space-y-3">
          <input
            type="text"
            bind:value={formEmbedTitle}
            placeholder="Titre"
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
          />
          <FormTextarea bind:value={formEmbedDescription} placeholder="Description" className="w-full h-20" />
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              bind:value={formEmbedColor}
              placeholder="#5865F2"
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none font-mono"
            />
            <input
              type="text"
              bind:value={formEmbedImageUrl}
              placeholder="https://… (image)"
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
            />
          </div>
          <p class="text-[10px] text-on-surface-variant/60">
            L'image doit être servie en HTTPS. Couleur au format hexadécimal.
          </p>
        </div>
      </details>

      <label class="flex items-start gap-3 cursor-pointer px-2 py-2 hover:bg-white/5 rounded-lg transition-colors">
        <input type="checkbox" bind:checked={formAllowMentions} class="w-4 h-4 mt-0.5 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <div>
          <span class="text-xs font-bold text-on-surface">Autoriser les mentions</span>
          <p class="text-[10px] text-on-surface-variant/60">
            Sans cela, @everyone, @here et les mentions de rôle sont écrits mais ne notifient personne -
            un message qui se répète ne doit pas pinger tout le serveur par accident.
          </p>
        </div>
      </label>

      <label class="flex items-start gap-3 cursor-pointer px-2 py-2 hover:bg-white/5 rounded-lg transition-colors">
        <input type="checkbox" bind:checked={formRunOnce} class="w-4 h-4 mt-0.5 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <div>
          <span class="text-xs font-bold text-on-surface">Envoyer une seule fois</span>
          <p class="text-[10px] text-on-surface-variant/60">
            La tâche se désactive juste après l'envoi. À cocher pour un message daté :
            son expression cron se redéclencherait sinon l'année suivante.
          </p>
        </div>
      </label>
    {/if}

    <!-- Fréquence -->
    <div class="space-y-2">
      <span class="block text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.schedules_form_frequency()}</span>
      <FormSelect
        value={formFrequency}
        onchange={(e) => handleFrequencyChange((e.target as HTMLSelectElement).value)}
        className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
      >
        {#each frequencies as freq}
          <option value={freq.key}>{freq.label}</option>
        {/each}
      </FormSelect>
    </div>

    <!-- Expression Cron -->
    {#if formFrequency === 'custom'}
      <div class="space-y-2">
        <span class="block text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">{m.schedules_form_cron_expr()}</span>
        <input
          type="text"
          bind:value={formCron}
          placeholder={m.schedules_form_cron_placeholder()}
          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none font-mono"
        />
        <p class="text-[10px] text-on-surface-variant/60 ml-2">{m.schedules_form_cron_help()}</p>
      </div>
    {/if}

    <!-- Footer Actions -->
    <div class="flex justify-end gap-3 pt-2">
      <ActionButton onClick={() => showCreateModal = false} variant="muted" label={m.schedules_btn_cancel()} />
      <ActionButton onClick={handleSaveSchedule} variant="primary" label={isEditing ? m.schedules_btn_save() : m.schedules_btn_create()} />
    </div>
    <InlineFeedback state={createAction} />
  </div>
</Modal>

<!-- Modal de suppression -->
<Modal bind:open={showDeleteModal} title={m.schedules_modal_delete_title()}>
  <div class="space-y-4">
    <p class="text-sm font-medium">{m.schedules_confirm_delete({ name: selectedSchedule?.name ?? '' })}</p>
    <p class="text-xs text-error font-bold bg-error/10 border border-error/20 px-4 py-3 rounded-lg flex items-center gap-2">
      <Papicon icon="alert-triangle" size={16} />
      {m.schedules_confirm_delete_warning()}
    </p>
    <div class="flex justify-end gap-3 pt-2">
      <ActionButton onClick={() => showDeleteModal = false} variant="muted" label={m.schedules_btn_cancel()} />
      <ActionButton onClick={handleDeleteSchedule} variant="danger" label={m.schedules_btn_delete()} />
    </div>
    <InlineFeedback state={deleteAction} />
  </div>
</Modal>
