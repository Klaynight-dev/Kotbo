<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { parseDiscordEmojisAndMarkdown } from '../lib/emojiParser';
  import { fetchMeetings, createMeeting, deleteMeeting, updateMeeting, fetchMemberCase, fetchFeatureConfigurations, updateStaffConfig, fetchStaffServerChannels } from '../lib/api';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import DiscordMarkdownEditor from '../lib/components/DiscordMarkdownEditor.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { formatWallClockInTimezone, parseDateTimeInTimezone } from '@kotbo/contracts';
  import TimezoneHint from '../lib/components/TimezoneHint.svelte';

  let meetings = $state<any[]>([]);
  let loading = $state(true);
  let modalOpen = $state(false);
  let detailModalOpen = $state(false);
  let editMode = $state(false);
  let saving = $state(false);

  // Member Case Modal States
  let userCaseModalOpen = $state(false);
  let selectedUserIdForCase = $state<string | null>(null);
  let selectedUserNameForCase = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  let meetingTitle = $state('');
  let meetingDesc = $state('');
  // Fuseau choisi pour la reunion en cours. `null` = repli sur le serveur ;
  // plusieurs reunions peuvent porter chacune leur propre fuseau.
  let meetingTimezone = $state<string | null>(null);
  const effectiveTimezone = $derived(meetingTimezone ?? timezoneStore.timezone);

  // Interprete la saisie dans ce fuseau, pas celui du navigateur : ouvrir le
  // dashboard depuis Paris pour une reunion regie sur Montreal stockait sinon
  // l'instant Paris et decalait les rappels de six heures.
  const formatLocal = (date: Date) => formatWallClockInTimezone(date, effectiveTimezone);
  const parseLocal = (input: string) => parseDateTimeInTimezone(input, effectiveTimezone) ?? new Date();

  let meetingDate = $state(formatLocal(new Date()));
  // Duree par defaut : 2h.
  let meetingEndDate = $state(formatLocal(new Date(Date.now() + 7200000)));
  let currentMeetingId = $state<string | null>(null);
  let selectedMeeting = $state<any>(null);
  
  let deleteModalOpen = $state(false);
  let meetingToDeleteId = $state<string | null>(null);
  let deleteDiscordEvent = $state(true);
  let deleteDiscordMessage = $state(false);
  let deleteDiscordNotification = $state(true);
  let deleting = $state(false);

  const isAdmin = $derived(authStore.guilds.find(g => g.id === authStore.selectedGuildId)?.accessLevel === 'admin');
  const featureAccess = $derived(dashboardStore.state.featureAccess?.meetings || {});
  const canManageSettings = $derived(isAdmin || !!dashboardStore.state.access?.canManageSettings || !!featureAccess.canConfigure);
  const canModerate = $derived(canManageSettings || !!featureAccess.canModerate);

  const saveAction = createAsyncActionState();
  // Validation error message for the form
  let meetingError = $state('');
  let meetingsConfig = $state<any>(null);
  let loadingConfig = $state(false);

  // Derived from dashboardStore for real-time sync
  const meetingAnnouncementChannelId = $derived(dashboardStore.state.meetingAnnouncementChannelId || null);
  const meetingVoiceChannelId = $derived(dashboardStore.state.meetingVoiceChannelId || null);
  const availableDiscordChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableDiscordVoiceChannels = $derived(dashboardStore.state.discordVoiceChannels || []);

  // Salons du serveur staff lié (pickers cross-serveur)
  let staffServerChannels = $state<{ staffGuildId: string | null; staffGuildName: string | null; channels: any[]; voiceChannels: any[] }>({
    staffGuildId: null, staffGuildName: null, channels: [], voiceChannels: [],
  });

  async function loadStaffServerChannels() {
    try {
      const data = await fetchStaffServerChannels();
      if (data?.staffGuildId) {
        staffServerChannels = {
          staffGuildId: data.staffGuildId,
          staffGuildName: data.staffGuildName ?? data.staffGuildId,
          channels: data.channels ?? [],
          voiceChannels: data.voiceChannels ?? [],
        };
      }
    } catch {
      // pas de lien staff - pickers locaux uniquement
    }
  }

  const canView = $derived(isAdmin || !!featureAccess.canView);

  async function loadMeetings() {
    loading = true;
    try {
      const data = await fetchMeetings();
      meetings = data.meetings || [];
      // Sort by date desc
      meetings.sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());
      
      // Si un modal de détails est ouvert, on met à jour les données de la réunion sélectionnée
      if (detailModalOpen && selectedMeeting) {
        const updated = meetings.find(m => m.id === selectedMeeting.id);
        if (updated) selectedMeeting = updated;
      }
    } catch (e) {
      console.error('Failed to fetch meetings:', e);
    } finally {
      loading = false;
    }
  }

  async function openMemberCase(userId: string, name: string) {
    if (!authStore.selectedGuildId) return;
    selectedUserIdForCase = userId;
    selectedUserNameForCase = name;
    userCaseModalOpen = true;
    loadingCase = true;
    caseError = '';
    caseData = null;

    try {
      caseData = await fetchMemberCase(userId, authStore.selectedGuildId);
    } catch (err) {
      caseError = err instanceof Error ? err.message : m.meetings_case_error();
    } finally {
      loadingCase = false;
    }
  }

  function getAttendanceStats(meeting: any) {
    const presences = meeting.presences || [];
    return {
      present: presences.filter(p => p.status === 'PRESENT').length,
      excused: presences.filter(p => p.status === 'EXCUSED' || p.status === 'ABSENT_CHECKED').length,
      absent: presences.filter(p => p.status === 'ABSENT').length
    };
  }

  onMount(() => {
    if (!canView) {
      // On redirige ou affiche une erreur si besoin, mais ici on laisse le ModulePage gérer le message si possible
      // ou on peut mettre une erreur locale
      return;
    }
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      // Charge le fuseau du serveur avant de peindre les inputs : sans ca, la
      // premiere ouverture affichait la date en heure navigateur puis basculait
      // sur le fuseau du serveur au rechargement suivant.
      await timezoneStore.ensureLoaded();
      const now = new Date();
      meetingDate = formatLocal(now);
      meetingEndDate = formatLocal(new Date(now.getTime() + 7200000));

      loadMeetings();
      loadStaffServerChannels();

      loadingConfig = true;
      try {
        const configs = await fetchFeatureConfigurations();
        meetingsConfig = configs?.features?.find((c: any) => c.featureKey === 'meetings') || null;
      } catch (err) {
        console.error('Error fetching meetings config:', err);
      } finally {
        loadingConfig = false;
      }

      // Synchronisation temps réel lors de créations / modifications / émargements
      unsubscribe = subscribeRealtime({
        reasons: ['meetings_updated'],
        fallbackMs: 60_000,
        onUpdate: () => {
          if (!modalOpen && !deleteModalOpen && !saving && !deleting) {
            void fetchMeetings().then(data => {
              meetings = data.meetings || [];
              meetings.sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());
              
              if (detailModalOpen && selectedMeeting) {
                const updated = meetings.find(m => m.id === selectedMeeting.id);
                if (updated) selectedMeeting = updated;
              }
            });
          }
        },
      });
    })();

    return () => {
      unsubscribe?.();
    };
  });

  function openCreate() {
    if (!canManageSettings) return;
    editMode = false;
    meetingTitle = '';
    meetingDesc = '';
    meetingTimezone = null;
    // Default start 1h from now, end 2h from now, both in local format
    meetingDate = formatLocal(new Date(Date.now() + 3600000));
    meetingEndDate = formatLocal(new Date(Date.now() + 7200000));
    meetingError = '';
    modalOpen = true;
  }

  function openEdit(meeting: any) {
    if (!canManageSettings) return;
    editMode = true;
    currentMeetingId = meeting.id;
    meetingTitle = meeting.title;
    meetingDesc = meeting.description || '';
    // Le fuseau doit etre restaure AVANT le format, sinon `formatLocal` lit
    // encore le fuseau precedent et affiche une heure decalee au premier rendu.
    meetingTimezone = meeting.timezone ?? null;
    meetingDate = formatLocal(new Date(meeting.scheduledAt));
    meetingEndDate = meeting.endedAt ? formatLocal(new Date(meeting.endedAt)) : formatLocal(new Date(new Date(meeting.scheduledAt).getTime() + 3600000));
    meetingError = '';
    modalOpen = true;
  }

  async function save() {
    // Basic validation
    if (!meetingTitle || !meetingDate) {
      meetingError = m.meetings_err_required();
      return;
    }
    const start = parseLocal(meetingDate);
    const end = parseLocal(meetingEndDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      meetingError = m.meetings_err_invalid_dates();
      return;
    }
    if (end <= start) {
      meetingError = m.meetings_err_end_before_start();
      return;
    }

    saving = true;
    meetingError = '';
    try {
      const payload: any = {
        title: meetingTitle,
        description: meetingDesc,
        scheduledAt: start.toISOString(),
        endedAt: end.toISOString(),
        timezone: meetingTimezone,
      };

      if (editMode && currentMeetingId) {
        await updateMeeting(currentMeetingId, payload);
      } else {
        await createMeeting(meetingTitle, meetingDesc, payload.scheduledAt, payload.endedAt, meetingTimezone);
      }
      modalOpen = false;
      await loadMeetings();
    } catch (e) {
      console.error('Failed to save meeting:', e);
      meetingError = m.meetings_err_save();
    } finally {
      saving = false;
    }
  }

  function openDelete(id: string) {
    if (!canManageSettings) return;
    meetingToDeleteId = id;
    deleteDiscordEvent = true;
    deleteDiscordMessage = false;
    deleteDiscordNotification = true;
    deleteModalOpen = true;
  }

  async function confirmDelete() {
    if (!meetingToDeleteId) return;
    deleting = true;
    try {
      await deleteMeeting(meetingToDeleteId, {
        deleteEvent: deleteDiscordEvent,
        deleteMessage: deleteDiscordMessage,
        deleteNotifications: deleteDiscordNotification
      });
      deleteModalOpen = false;
      await loadMeetings();
    } catch (e) {
      console.error('Failed to delete meeting:', e);
    } finally {
      deleting = false;
    }
  }

  async function updateStatus(id: string, status: string) {
    if (!canModerate) return;
    try {
      await updateMeeting(id, { status });
      await loadMeetings();
    } catch (e) {
      console.error('Failed to update status:', e);
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'SCHEDULED': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
      case 'IN_PROGRESS': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 animate-pulse';
      case 'COMPLETED': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
      case 'CANCELLED': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
      default: return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400';
    }
  }

  function formatStatus(status: string) {
    switch (status) {
      case 'SCHEDULED': return m.meetings_status_scheduled();
      case 'IN_PROGRESS': return m.meetings_status_in_progress();
      case 'COMPLETED': return m.meetings_status_completed();
      case 'CANCELLED': return m.meetings_status_cancelled();
      case 'PRESENT': return m.meetings_presence_present();
      case 'EXCUSED': return m.meetings_presence_excused();
      case 'ABSENT': return m.meetings_presence_absent();
      case 'ABSENT_CHECKED': return m.meetings_presence_absent_checked();
      default: return status;
    }
  }

  function openDetails(meeting: any) {
    selectedMeeting = meeting;
    detailModalOpen = true;
  }

</script>

<ModulePage 
  title={m.meetings_page_title()}
  
  description={m.meetings_page_desc()}
  
  icon="calendar"
  featureKey="meetings"
>
  {#snippet actions()}
    <RefreshButton onClick={loadMeetings} loading={loading} label={m.meetings_refresh()} />
    {#if canManageSettings}
      <ActionButton onClick={openCreate} variant="primary" icon="plus" label={m.meetings_new_btn()} />
    {/if}
  {/snippet}

  {#if canManageSettings && meetingsConfig}
    <div class="mb-10 space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-surface-container-low rounded-xl p-6 border border-outline-variant/20 shadow-sm">
          <h4 class="text-xs font-semibold text-on-surface-variant uppercase tracking-widest mb-4">{m.meetings_config_channels_title()}</h4>
          <div class="space-y-4">
            <div>
              <label for="meeting-announcement-channel" class="block text-[10px] font-semibold text-on-surface-variant uppercase mb-2 ml-1">{m.meetings_announce_channel_label()}</label>
              <select 
                id="meeting-announcement-channel"
                value={meetingAnnouncementChannelId} 
                onchange={async (e) => {
                  const val = (e.target as HTMLSelectElement).value;
                  await updateStaffConfig({ meetingAnnouncementChannelId: val || null });
                  await dashboardStore.refresh();
                }}
                class="w-full rounded-xl border border-outline-variant/30 bg-surface-container-lowest px-4 py-2.5 text-sm outline-none transition focus:border-primary/50"
              >
                <option value="">{m.meetings_none_option()}</option>
                {#if staffServerChannels.staffGuildId}
                  <optgroup label={m.meetings_optgroup_this_server()}>
                    {#each availableDiscordChannels as ch}
                      <option value={ch.id}>#{ch.name}</option>
                    {/each}
                  </optgroup>
                  <optgroup label={m.meetings_optgroup_staff_server({ name: staffServerChannels.staffGuildName ?? "" })}>
                    {#each staffServerChannels.channels as ch}
                      <option value={ch.id}>#{ch.name}</option>
                    {/each}
                  </optgroup>
                {:else}
                  {#each availableDiscordChannels as ch}
                    <option value={ch.id}>#{ch.name}</option>
                  {/each}
                {/if}
              </select>
            </div>
            <div>
              <label for="meeting-voice-channel" class="block text-[10px] font-semibold text-on-surface-variant uppercase mb-2 ml-1">{m.meetings_voice_channel_label()}</label>
              <select 
                id="meeting-voice-channel"
                value={meetingVoiceChannelId} 
                onchange={async (e) => {
                  const val = (e.target as HTMLSelectElement).value;
                  await updateStaffConfig({ meetingVoiceChannelId: val || null });
                  await dashboardStore.refresh();
                }}
                class="w-full rounded-xl border border-outline-variant/30 bg-surface-container-lowest px-4 py-2.5 text-sm outline-none transition focus:border-primary/50"
              >
                <option value="">{m.meetings_none_option()}</option>
                {#if staffServerChannels.staffGuildId}
                  <optgroup label={m.meetings_optgroup_this_server()}>
                    {#each availableDiscordVoiceChannels as ch}
                      <option value={ch.id}>{ch.name}</option>
                    {/each}
                  </optgroup>
                  <optgroup label={m.meetings_optgroup_staff_server({ name: staffServerChannels.staffGuildName ?? "" })}>
                    {#each staffServerChannels.voiceChannels as ch}
                      <option value={ch.id}>{ch.name}</option>
                    {/each}
                  </optgroup>
                {:else}
                  {#each availableDiscordVoiceChannels as ch}
                    <option value={ch.id}>{ch.name}</option>
                  {/each}
                {/if}
              </select>
            </div>
          </div>
        </div>

        <div class="bg-surface-container-low rounded-xl p-6 border border-outline-variant/20 shadow-sm flex flex-col">
          <h4 class="text-xs font-semibold text-on-surface-variant uppercase tracking-widest mb-4">{m.meetings_roles_access_title()}</h4>
          <div class="flex-1 overflow-y-auto max-h-[300px]">
            <RolePermissionSettings 
              featureKey="meetings" 
              roleAccess={meetingsConfig.roleAccessByRole} 
            />
          </div>
        </div>
      </div>

      {#if saveAction.state.message}
        <p class="text-xs font-bold text-emerald-600 ml-1">{saveAction.state.message}</p>
      {/if}
    </div>
  {/if}

  <div class="grid grid-cols-1 gap-6">
    {#if loading && meetings.length === 0}
      <div class="flex flex-col items-center justify-center py-20 bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <div class="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin"></div>
        <p class="mt-4 text-on-surface-variant font-medium">{m.meetings_loading()}</p>
      </div>
    {:else if meetings.length === 0}
      <div class="flex flex-col items-center justify-center py-20 bg-surface-container-lowest rounded-xl border border-outline-variant/30">
        <Papicon icon="calendar" size={60} class="text-on-surface-variant/20 mb-4" />
        <h3 class="text-xl font-bold text-on-surface">{m.meetings_empty_title()}</h3>
        <p class="text-on-surface-variant mt-1">{m.meetings_empty_desc()}</p>
        {#if canManageSettings}
          <button onclick={openCreate} class="mt-6 px-6 py-2.5 bg-primary text-on-primary rounded-xl font-bold hover:bg-primary-hover transition-colors">
            {m.meetings_empty_btn()}
          </button>
        {/if}
      </div>
    {:else}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {#each meetings as meeting}
          {@const stats = getAttendanceStats(meeting)}
          <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 overflow-hidden hover:shadow-xl hover:shadow-primary/5 transition-all group">
            <div class="p-6">
              <div class="flex justify-between items-start gap-4 mb-4">
                <div>
                  <span class="inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider mb-2 {getStatusColor(meeting.status)}">
                    {formatStatus(meeting.status)}
                  </span>
                  <h4 class="text-xl font-bold text-on-surface leading-tight">{meeting.title}</h4>
                  <div class="flex items-center gap-2 mt-1 text-on-surface-variant text-sm font-medium">
                    <Papicon icon="calendar" size={18} />
                    {new Date(meeting.scheduledAt).toLocaleString(dateLocale(), { dateStyle: 'full', timeStyle: 'short' })}
                  </div>
                </div>
                {#if canManageSettings}
                  <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick={() => openEdit(meeting)} class="p-2 hover:bg-surface-hover rounded-full transition-colors text-on-surface-variant hover:text-primary" title={m.meetings_edit_tooltip()}>
                      <Papicon icon="edit-2" size={18} />
                    </button>
                    <button onclick={() => openDelete(meeting.id)} class="p-2 hover:bg-red-500/10 rounded-full transition-colors text-on-surface-variant hover:text-red-500" title={m.meetings_delete_tooltip()}>
                      <Papicon icon="trash-2" size={18} />
                    </button>
                  </div>
                {/if}
              </div>

              <div class="text-on-surface-variant text-sm line-clamp-3 mb-6 min-h-12">
                {#if meeting.description}
                  {@html parseDiscordEmojisAndMarkdown(meeting.description)}
                {:else}
                  <span class="italic opacity-60">{m.meetings_no_description()}</span>
                {/if}
              </div>

              <div class="grid grid-cols-3 gap-2 p-3 bg-surface-container-low rounded-lg">
                <div class="text-center">
                  <p class="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.meetings_stat_present()}</p>
                  <p class="text-xl font-bold text-emerald-500">{stats.present}</p>
                </div>
                <div class="text-center border-x border-outline-variant/30">
                  <p class="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.meetings_stat_excused()}</p>
                  <p class="text-xl font-bold text-amber-500">{stats.excused}</p>
                </div>
                <div class="text-center">
                  <p class="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.meetings_stat_absent()}</p>
                  <p class="text-xl font-bold text-red-500">{stats.absent}</p>
                </div>
              </div>
            </div>

            <div class="px-6 py-4 bg-surface-container-low/50 border-t border-outline-variant/30 flex items-center justify-between">
              <div class="flex -space-x-2">
                {#each meeting.presences.filter(p => p.status === 'PRESENT').slice(0, 5) as p}
                  <button 
                    onclick={() => openMemberCase(p.staffUserId, p.staffMember?.displayName || p.staffMember?.username || m.meetings_member_fallback())}
                    class="w-8 h-8 rounded-full border-2 border-surface-container-lowest bg-primary/10 flex items-center justify-center overflow-hidden transition-transform hover:z-10" 
                    title={p.staffMember?.displayName || p.staffMember?.username || m.meetings_member_fallback()}
                  >
                    {#if p.staffMember?.avatarUrl}
                      <img src={p.staffMember.avatarUrl} alt="" class="w-full h-full object-cover" />
                    {:else}
                      <span class="text-[10px] font-bold text-primary">{(p.staffMember?.displayName || p.staffMember?.username || "??").slice(0, 2).toUpperCase()}</span>
                    {/if}
                  </button>
                {/each}
                {#if stats.present > 5}
                  <div class="w-8 h-8 rounded-full border-2 border-surface-container-lowest bg-surface-hover flex items-center justify-center text-[10px] font-bold text-on-surface-variant">
                    +{stats.present - 5}
                  </div>
                {/if}
              </div>

              <div class="flex items-center gap-2">
                {#if canModerate}
                   {#if meeting.status === 'SCHEDULED'}
                      <button onclick={() => updateStatus(meeting.id, 'IN_PROGRESS')} class="text-xs font-bold text-primary px-3 py-1.5 hover:bg-primary/10 rounded-lg transition-colors">
                        {m.meetings_start_btn()}
                      </button>
                   {:else if meeting.status === 'IN_PROGRESS'}
                      <button onclick={() => updateStatus(meeting.id, 'COMPLETED')} class="text-xs font-bold text-emerald-500 px-3 py-1.5 hover:bg-emerald-500/10 rounded-lg transition-colors">
                        {m.meetings_finish_btn()}
                      </button>
                   {/if}
                {/if}
                <button onclick={() => openDetails(meeting)} class="text-xs font-bold text-on-surface-variant px-3 py-1.5 hover:bg-surface-hover rounded-lg transition-colors">
                  {m.meetings_details_btn()}
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</ModulePage>

{#if modalOpen}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
    <div 
      class="absolute inset-0 bg-black/60" 
      onclick={() => modalOpen = false}
      onkeydown={(e) => e.key === 'Escape' && (modalOpen = false)}
      role="button"
      tabindex="0"
      aria-label={m.meetings_close_modal_aria()}
    ></div>
    
    <div class="relative w-full max-w-3xl bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-outline-variant/30 font-inter">
      <div class="p-8 border-b border-outline-variant/30 flex items-center justify-between bg-primary/5">
        <div>
          <h3 class="text-2xl font-semibold text-on-surface">{editMode ? m.meetings_modal_edit_title() : m.meetings_modal_create_title()}</h3>
          <p class="text-on-surface-variant text-sm">{m.meetings_modal_subtitle()}</p>
        </div>
        <button onclick={() => modalOpen = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </div>

      <div class="p-8 space-y-6">
        <div>
          <label for="meeting-title" class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">{m.meetings_field_title_label()}</label>
          <FormInput 
            id="meeting-title"
            bind:value={meetingTitle}
            placeholder={m.meetings_field_title_ph()}
            className="w-full text-lg font-bold"
          />
        </div>

        <div>
          <label for="meeting-date" class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">{m.meetings_field_start_label()}</label>
          <FormInput 
            id="meeting-date"
            type="datetime-local"
            bind:value={meetingDate}
            className="w-full"
          />
        </div>

        <div>
          <label for="meeting-end-date" class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">{m.meetings_field_end_label()}</label>
          <FormInput 
            id="meeting-end-date"
            type="datetime-local"
            bind:value={meetingEndDate}
            className="w-full"
          />
          {#if timezoneStore.loaded}
            <div class="mt-1.5">
              <TimezoneHint bind:value={meetingTimezone} />
            </div>
          {/if}
        </div>

        <div>
          <DiscordMarkdownEditor
            id="meeting-desc"
            bind:value={meetingDesc}
            label={m.meetings_field_agenda_label()}
            placeholder={m.meetings_field_agenda_ph()}
            rows={10}
            agendaMode={true}
            disabled={saving}
          />
        </div>

        {#if !editMode}
          <div class="bg-blue-500/5 border border-blue-500/20 rounded-lg p-4 flex gap-3">
             <Papicon icon="info" size={24} class="text-blue-500" />
             <p class="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
               {m.meetings_create_info()}
             </p>
          </div>
        {/if}

        {#if meetingError}
          <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mt-3">
            <p class="text-sm text-red-700">{meetingError}</p>
          </div>
        {/if}

        <div class="flex items-center justify-end gap-4 pt-4 mt-6 border-t border-outline-variant/30">
          <button onclick={() => modalOpen = false} class="px-6 py-2.5 font-bold text-on-surface-variant hover:bg-surface-hover rounded-xl transition-colors">
            {m.common_cancel()}
          </button>
          <button 
            onclick={save}
            disabled={saving || !meetingTitle || !meetingDate}
            class="px-8 py-2.5 bg-primary text-on-primary rounded-xl font-semibold hover:shadow-primary/40 disabled:opacity-50 disabled:grayscale transition-all flex items-center gap-2"
          >
            {#if saving}
              <div class="w-4 h-4 border-2 border-on-primary/20 border-t-on-primary rounded-full animate-spin"></div>
            {/if}
            {editMode ? m.meetings_submit_edit() : m.meetings_submit_create()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if detailModalOpen && selectedMeeting}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
    <div 
      class="absolute inset-0 bg-black/60" 
      onclick={() => detailModalOpen = false}
      onkeydown={(e) => e.key === 'Escape' && (detailModalOpen = false)}
      role="button"
      tabindex="0"
      aria-label={m.meetings_close_modal_aria()}
    ></div>
    
    <div class="relative w-full max-w-2xl bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-outline-variant/30 font-inter">
      <div class="p-8 border-b border-outline-variant/30 bg-primary/5 flex items-center justify-between">
        <div>
          <h3 class="text-2xl font-semibold text-on-surface">{selectedMeeting.title}</h3>
          <p class="text-on-surface-variant text-sm flex items-center gap-1">
             <Papicon icon="calendar" size={12} />
             {new Date(selectedMeeting.scheduledAt).toLocaleString(dateLocale())}
          </p>
        </div>
        <button onclick={() => detailModalOpen = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </div>

      <div class="p-8 space-y-8 max-h-[70vh] overflow-y-auto">
        {#if selectedMeeting.description}
           <div class="p-4 bg-[#2f3136] rounded-lg border border-white/5">
              <div class="text-sm text-[#dcddde] leading-relaxed whitespace-pre-wrap break-words discord-preview">
                {@html parseDiscordEmojisAndMarkdown(selectedMeeting.description)}
              </div>
           </div>
        {/if}

        <div class="space-y-4">
           <h4 class="text-xs font-semibold text-on-surface-variant uppercase tracking-widest px-1">{m.meetings_presence_list_title()}</h4>
           <div class="grid grid-cols-1 gap-2">
              {#each selectedMeeting.presences as presence}
                 <div class="flex items-center justify-between p-4 bg-surface-container-low/50 rounded-lg border border-outline-variant/10 hover:bg-surface-container-low transition-colors group">
                    <div class="flex items-center gap-3">
                       <button 
                          onclick={() => openMemberCase(presence.staffUserId, presence.staffMember?.displayName || presence.staffMember?.username || m.meetings_member_fallback())}
                          class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary overflow-hidden transition-transform "
                       >
                          {#if presence.staffMember?.avatarUrl}
                            <img src={presence.staffMember.avatarUrl} alt="" class="w-full h-full object-cover" />
                          {:else}
                            {presence.staffMember?.displayName?.slice(0, 2).toUpperCase() || presence.staffMember?.username?.slice(0, 2).toUpperCase() || "??"}
                          {/if}
                       </button>
                       <div>
                          <button 
                            onclick={() => openMemberCase(presence.staffUserId, presence.staffMember?.displayName || presence.staffMember?.username || m.meetings_member_fallback())}
                            class="text-sm font-bold text-on-surface hover:text-primary transition-colors text-left block"
                          >
                            {presence.staffMember?.displayName || presence.staffMember?.username || m.meetings_member_fallback()}
                          </button>
                          {#if presence.note}
                             <p class="text-[11px] text-on-surface-variant leading-tight mt-0.5">{presence.note}</p>
                          {/if}
                       </div>
                    </div>
                    <div>
                       <span class="inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider {getStatusColor(presence.status)}">
                          {formatStatus(presence.status)}
                       </span>
                    </div>
                 </div>
              {/each}
           </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if deleteModalOpen}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
    <div 
      class="absolute inset-0 bg-black/60" 
      onclick={() => deleteModalOpen = false}
      onkeydown={(e) => e.key === 'Escape' && (deleteModalOpen = false)}
      role="button"
      tabindex="0"
      aria-label={m.meetings_close_modal_aria()}
    ></div>
    
    <div class="relative w-full max-w-md bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-outline-variant/30 font-inter">
      <div class="p-8 border-b border-outline-variant/30 bg-red-500/5 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-semibold text-on-surface">{m.meetings_delete_modal_title()}</h3>
          <p class="text-on-surface-variant text-sm">{m.meetings_delete_modal_subtitle()}</p>
        </div>
        <button onclick={() => deleteModalOpen = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </div>

      <div class="p-8 space-y-6">
        <p class="text-sm text-on-surface-variant leading-relaxed">
          {m.meetings_delete_question()}
        </p>

        <div class="space-y-4">
          <label class="flex items-center gap-3 p-4 bg-surface-container-low rounded-lg border border-outline-variant/10 cursor-pointer hover:bg-surface-container-low transition-colors">
            <input type="checkbox" bind:checked={deleteDiscordEvent} class="w-5 h-5 rounded-lg border-outline-variant text-primary focus:ring-primary" />
            <div>
              <p class="text-sm font-bold text-on-surface">{m.meetings_delete_event_label()}</p>
              <p class="text-[11px] text-on-surface-variant">{m.meetings_delete_event_desc()}</p>
            </div>
          </label>

          <label class="flex items-center gap-3 p-4 bg-surface-container-low rounded-lg border border-outline-variant/10 cursor-pointer hover:bg-surface-container-low transition-colors">
            <input type="checkbox" bind:checked={deleteDiscordMessage} class="w-5 h-5 rounded-lg border-outline-variant text-primary focus:ring-primary" />
            <div>
              <p class="text-sm font-bold text-on-surface">{m.meetings_delete_message_label()}</p>
              <p class="text-[11px] text-on-surface-variant">{m.meetings_delete_message_desc()}</p>
            </div>
          </label>

          <label class="flex items-center gap-3 p-4 bg-surface-container-low rounded-lg border border-outline-variant/10 cursor-pointer hover:bg-surface-container-low transition-colors">
            <input type="checkbox" bind:checked={deleteDiscordNotification} class="w-5 h-5 rounded-lg border-outline-variant text-primary focus:ring-primary" />
            <div>
              <p class="text-sm font-bold text-on-surface">{m.meetings_delete_notif_label()}</p>
              <p class="text-[11px] text-on-surface-variant">{m.meetings_delete_notif_desc()}</p>
            </div>
          </label>
        </div>

        <div class="flex items-center justify-end gap-4 pt-4 border-t border-outline-variant/30">
          <button onclick={() => deleteModalOpen = false} class="px-6 py-2.5 font-bold text-on-surface-variant hover:bg-surface-hover rounded-xl transition-colors">
            {m.common_cancel()}
          </button>
          <button 
            onclick={confirmDelete}
            disabled={deleting}
            class="px-8 py-2.5 bg-red-500 text-white rounded-xl font-semibold shadow-sm hover:shadow-red-500/40 disabled:opacity-50 transition-all flex items-center gap-2"
          >
            {#if deleting}
              <div class="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
            {/if}
            {m.common_delete()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<MemberCaseModal
  open={userCaseModalOpen}
  userId={selectedUserIdForCase}
  userName={selectedUserNameForCase}
  {caseData}
  loading={loadingCase}
  error={caseError}
  onClose={() => {
    userCaseModalOpen = false;
  }}
  onSelectUser={(newUserId) => {
    const foundNode = caseData?.interactionGraph?.nodes?.find((n: any) => n.id === newUserId);
    const label = foundNode?.label || m.meetings_member_fallback();
    openMemberCase(newUserId, label);
  }}
/>

<style>
  :global(.font-headline) {
    font-family: 'Outfit', 'Inter', sans-serif;
  }
</style>
