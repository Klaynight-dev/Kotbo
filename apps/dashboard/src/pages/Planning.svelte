<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import {
    fetchStaffMembers,
    fetchStaffCalendarData,
    createCall,
    deleteCall,
    fetchTasks,
    createTask,
    updateTask,
    deleteTask,
    createAbsence,
    createMeeting,
    deleteMeeting,
    updateMeeting,
    deleteAbsence,
    fetchStaffRoles,
    searchDiscordMembers,
    fetchCallPermissionConfig,
    updateCallPermissionConfig,
    fetchMemberCase,
    createReminder,
    deleteReminder,
  } from '../lib/api';
  import { parseDiscordEmojisAndMarkdown } from '../lib/emojiParser';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { formatWallClockInTimezone, parseDateTimeInTimezone } from '@kotbo/contracts';
  import TimezoneHint from '../lib/components/TimezoneHint.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Calendar from '../lib/components/Calendar.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import DiscordMarkdownEditor from '../lib/components/DiscordMarkdownEditor.svelte';
  import { localInitialAvatar } from '../lib/discordMedia';

  // State
  let loading = $state(true);
  let allStaff = $state<any[]>([]);
  let allRoles = $state<any[]>([]);
  type CalendarData = { absences: any[], voiceSessions: any[], meetings: any[], calls: any[], tasks: any[] };
  const emptyCalendarData = (): CalendarData => ({ absences: [], voiceSessions: [], meetings: [], calls: [], tasks: [] });
  let calendarData = $state<CalendarData>(emptyCalendarData());
  let userTasks = $state<any[]>([]);

  // Calendar binding
  let calendarView = $state<string>('week');
  let calendarCurrentDate = $state(new Date());

  // Filtering
  let selectedStaffIds = $state<string[]>([]);
  let visibleTypes = $state<string[]>(['meeting', 'absence', 'call', 'task']);

  // Panels
  let showTaskPanel = $state(true);
  let sidebarCollapsed = $state(false);

  // Modals
  let creationModalOpen = $state(false);
  let detailModalOpen = $state(false);
  const planningTabs = ['meeting', 'absence', 'call', 'task'] as const;
  let currentTab = $state<'meeting' | 'absence' | 'call' | 'task'>('meeting');

  $effect(() => {
    const _path = $router.path;
    currentTab = resolveTabFromUrl('/planning', planningTabs, 'meeting') as typeof currentTab;
  });

  // Selection dates
  let selectedStartDate = $state(new Date());
  let selectedEndDate = $state(new Date(Date.now() + 3600000));
  // Fuseau choisi par l'organisateur pour la reunion en cours de creation ;
  // reset a `null` au switch de tab et apres soumission.
  let formTimezone = $state<string | null>(null);
  let currentItemDetail = $state<any>(null);

  // Forms Fields
  let formTitle = $state('');
  let formDescription = $state('');
  let formPriority = $state<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  let formAssigneeId = $state('');
  let formSuperiorId = $state('');
  let formAbsenceType = $state('Autre');
  let formChannelMode = $state('CREATE_NEW');
  let formChannelType = $state('VOICE');
  let formDiscordChannelId = $state('');
  let formIsTempChannel = $state(true);
  let formInviteeUserIds = $state<string[]>([]);

  let formError = $state('');
  let saving = $state(false);

  // Reminders form state
  let newReminderTime = $state('');
  let newReminderMessage = $state('');
  let newReminderChannel = $state('DM');

  // Member search for call invitees
  let memberSearchQuery = $state('');
  let memberSearchResults = $state<any[]>([]);
  let memberSearchLoading = $state(false);
  let memberSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  let formInviteeMemberIds = $state<string[]>([]);
  let selectedMembers = $state<Map<string, any>>(new Map());

  // Call creation permissions ("qui peut créer des appels")
  let callPermConfig = $state<any>(null);
  let callPermCanCreate = $state(true);
  let permissionModalOpen = $state(false);
  let permMode = $state<'EVERYONE' | 'RESTRICTED'>('EVERYONE');
  let permRoleIds = $state<string[]>([]);
  let permUserIds = $state<string[]>([]);
  let permSelectedUsersMap = $state<Map<string, any>>(new Map());
  let permMemberSearchQuery = $state('');
  let permMemberSearchResults = $state<any[]>([]);
  let permMemberSearchLoading = $state(false);
  let permMemberSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  let permError = $state('');
  let permSaving = $state(false);
  const isAdmin = $derived(authStore.guilds.find(g => g.id === authStore.selectedGuildId)?.accessLevel === 'admin');

  // Meetings Feature Access & Permissions
  const meetingsFeatureAccess = $derived(dashboardStore.state.featureAccess?.meetings || {});
  const canManageMeetings = $derived(isAdmin || !!dashboardStore.state.access?.canManageSettings || !!meetingsFeatureAccess.canConfigure);
  const canModerateMeetings = $derived(canManageMeetings || !!meetingsFeatureAccess.canModerate);

  // Member Case Modal States
  let userCaseModalOpen = $state(false);
  let selectedUserIdForCase = $state<string | null>(null);
  let selectedUserNameForCase = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  // Meeting deletion states
  let meetingDeleteModalOpen = $state(false);
  let meetingToDeleteId = $state<string | null>(null);
  let deleteDiscordEvent = $state(true);
  let deleteDiscordMessage = $state(false);
  let deleteDiscordNotification = $state(true);
  let deletingMeeting = $state(false);

  // Meeting edition states
  let meetingEditModalOpen = $state(false);
  let editMeetingTitle = $state('');
  let editMeetingDesc = $state('');
  let editMeetingDate = $state('');
  let editMeetingEndDate = $state('');
  let editMeetingError = $state('');
  let editMeetingTimezone = $state<string | null>(null);
  let savingMeetingEdit = $state(false);

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
      caseError = err instanceof Error ? err.message : 'Impossible de charger le dossier';
    } finally {
      loadingCase = false;
    }
  }

  async function updateMeetingStatus(id: string, status: string) {
    if (!canModerateMeetings) return;
    try {
      await updateMeeting(id, { status });
      await refreshCalendar();
      if (currentItemDetail && currentItemDetail.id === id) {
        currentItemDetail.raw.status = status;
      }
    } catch (e) {
      console.error('Failed to update status:', e);
    }
  }

  function getAttendanceStats(meeting: any) {
    const presences = meeting.presences || [];
    return {
      present: presences.filter((p: any) => p.status === 'PRESENT').length,
      excused: presences.filter((p: any) => p.status === 'EXCUSED' || p.status === 'ABSENT_CHECKED').length,
      absent: presences.filter((p: any) => p.status === 'ABSENT').length
    };
  }

  function openEditMeeting(meeting: any) {
    if (!canManageMeetings) return;
    editMeetingTitle = meeting.title;
    editMeetingDesc = meeting.description || '';
    // Le fuseau est passe explicitement : `formatLocal` suit `activeTimezone`,
    // qui ne bascule sur celui de l'edition qu'une fois la modale marquee comme
    // ouverte - c'est-a-dire apres ces deux lignes. Nommer la zone ici evite de
    // dependre de l'ordre des affectations.
    editMeetingTimezone = meeting.timezone ?? null;
    const editZone = editMeetingTimezone ?? timezoneStore.timezone;
    editMeetingDate = formatWallClockInTimezone(new Date(meeting.scheduledAt), editZone);
    editMeetingEndDate = formatWallClockInTimezone(
      meeting.endedAt ? new Date(meeting.endedAt) : new Date(new Date(meeting.scheduledAt).getTime() + 3600000),
      editZone,
    );
    editMeetingError = '';
    meetingEditModalOpen = true;
  }

  async function saveMeetingEdit() {
    if (!editMeetingTitle || !editMeetingDate) {
      editMeetingError = m.meetings_err_required();
      return;
    }
    const start = parseLocal(editMeetingDate);
    const end = parseLocal(editMeetingEndDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      editMeetingError = 'Les dates fournies sont invalides.';
      return;
    }
    if (end <= start) {
      editMeetingError = m.meetings_err_end_before_start();
      return;
    }

    savingMeetingEdit = true;
    editMeetingError = '';
    try {
      const payload: any = {
        title: editMeetingTitle,
        description: editMeetingDesc,
        scheduledAt: start.toISOString(),
        endedAt: end.toISOString(),
        timezone: editMeetingTimezone,
      };

      if (currentItemDetail?.id) {
        await updateMeeting(currentItemDetail.id, payload);
        meetingEditModalOpen = false;
        
        // Update local state so details update immediately
        currentItemDetail.title = editMeetingTitle;
        currentItemDetail.start = start;
        currentItemDetail.end = end;
        currentItemDetail.raw.title = editMeetingTitle;
        currentItemDetail.raw.description = editMeetingDesc;
        currentItemDetail.raw.scheduledAt = start.toISOString();
        currentItemDetail.raw.endedAt = end.toISOString();
        
        await refreshCalendar();
      }
    } catch (e) {
      console.error('Failed to save meeting:', e);
      editMeetingError = m.meetings_err_save();
    } finally {
      savingMeetingEdit = false;
    }
  }

  async function confirmDeleteMeeting() {
    if (!meetingToDeleteId) return;
    deletingMeeting = true;
    try {
      await deleteMeeting(meetingToDeleteId, {
        deleteEvent: deleteDiscordEvent,
        deleteMessage: deleteDiscordMessage,
        deleteNotifications: deleteDiscordNotification
      });
      meetingDeleteModalOpen = false;
      detailModalOpen = false;
      await Promise.all([refreshCalendar(), refreshTasks()]);
    } catch (e) {
      console.error('Failed to delete meeting:', e);
    } finally {
      deletingMeeting = false;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'SCHEDULED': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
      case 'IN_PROGRESS': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 animate-pulse';
      case 'COMPLETED': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
      case 'CANCELLED': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
      // Presence statuses
      case 'PRESENT': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
      case 'EXCUSED': 
      case 'ABSENT_CHECKED': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
      case 'ABSENT': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
      default: return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400';
    }
  }

  function formatStatus(status: string) {
    switch (status) {
      case 'SCHEDULED': return m.meetings_status_scheduled();
      case 'IN_PROGRESS': return m.meetings_status_in_progress();
      case 'COMPLETED': return m.meetings_status_completed();
      case 'CANCELLED': return m.meetings_status_cancelled();
      // Presence statuses
      case 'PRESENT': return m.meetings_presence_present();
      case 'EXCUSED': return m.meetings_presence_excused();
      case 'ABSENT_CHECKED': return m.planning_presence_excused_checked();
      case 'ABSENT': return m.meetings_presence_absent();
      default: return status;
    }
  }

  async function searchMembers(query: string) {
    if (!query.trim()) {
      memberSearchResults = [];
      return;
    }
    memberSearchLoading = true;
    try {
      const data = await searchDiscordMembers(query, 15);
      memberSearchResults = (data?.members || []).filter(
        (mem: any) => !activeStaff.some(s => s.userId === mem.id) && mem.id !== (authStore.user as any)?.id
      );
    } catch (e) {
      console.error('Member search error:', e);
      memberSearchResults = [];
    } finally {
      memberSearchLoading = false;
    }
  }

  function handleMemberSearchInput(value: string) {
    memberSearchQuery = value;
    if (memberSearchTimeout) clearTimeout(memberSearchTimeout);
    memberSearchTimeout = setTimeout(() => searchMembers(value), 300);
  }

  function toggleMemberInvitee(member: any) {
    if (formInviteeMemberIds.includes(member.id)) {
      formInviteeMemberIds = formInviteeMemberIds.filter(id => id !== member.id);
      const next = new Map(selectedMembers);
      next.delete(member.id);
      selectedMembers = next;
    } else {
      formInviteeMemberIds = [...formInviteeMemberIds, member.id];
      const next = new Map(selectedMembers);
      next.set(member.id, member);
      selectedMembers = next;
    }
  }

  // Call creation permissions
  function togglePermRole(roleId: string) {
    permRoleIds = permRoleIds.includes(roleId) ? permRoleIds.filter(id => id !== roleId) : [...permRoleIds, roleId];
  }

  function togglePermUser(member: any) {
    if (permUserIds.includes(member.id)) {
      permUserIds = permUserIds.filter(id => id !== member.id);
      const next = new Map(permSelectedUsersMap);
      next.delete(member.id);
      permSelectedUsersMap = next;
    } else {
      permUserIds = [...permUserIds, member.id];
      const next = new Map(permSelectedUsersMap);
      next.set(member.id, member);
      permSelectedUsersMap = next;
    }
  }

  async function searchPermMembers(query: string) {
    if (!query.trim()) {
      permMemberSearchResults = [];
      return;
    }
    permMemberSearchLoading = true;
    try {
      const data = await searchDiscordMembers(query, 15);
      permMemberSearchResults = (data?.members || []).filter((mem: any) => !permUserIds.includes(mem.id));
    } catch (e) {
      console.error('Permission member search error:', e);
      permMemberSearchResults = [];
    } finally {
      permMemberSearchLoading = false;
    }
  }

  function handlePermMemberSearchInput(value: string) {
    permMemberSearchQuery = value;
    if (permMemberSearchTimeout) clearTimeout(permMemberSearchTimeout);
    permMemberSearchTimeout = setTimeout(() => searchPermMembers(value), 300);
  }

  function openPermissionModal() {
    permMode = callPermConfig?.mode || 'EVERYONE';
    permRoleIds = [...(callPermConfig?.allowedRoleIds || [])];
    permUserIds = [...(callPermConfig?.allowedUserIds || [])];
    permMemberSearchQuery = '';
    permMemberSearchResults = [];
    permError = '';
    permissionModalOpen = true;
  }

  async function savePermissionConfig() {
    permSaving = true;
    permError = '';
    try {
      await updateCallPermissionConfig({ mode: permMode, allowedRoleIds: permRoleIds, allowedUserIds: permUserIds });
      const data = await fetchCallPermissionConfig().catch(() => null);
      if (data) {
        callPermConfig = data.config;
        callPermCanCreate = data.canCreate;
      }
      permissionModalOpen = false;
    } catch (e: any) {
      permError = e?.message || m.planning_err_perm_update();
    } finally {
      permSaving = false;
    }
  }

  // Time boundaries
  let currentRangeStart = new Date();
  let currentRangeEnd = new Date();

  // Mini calendar
  let miniCalDate = $state(new Date());

  // Derived
  const myStaffRecord = $derived(allStaff.find(s => s.userId === (authStore.user as any)?.id));
  const activeStaff = $derived(allStaff.filter(s => !s.blacklistEntries || s.blacklistEntries.length === 0));

  const eligibleSuperiors = $derived.by(() => {
    if (!myStaffRecord || allRoles.length === 0) return [];
    const myRole = allRoles.find(r => r.name === myStaffRecord.grade);
    if (!myRole) return activeStaff;
    return activeStaff.filter(s => {
      if (s.userId === (authStore.user as any)?.id) return false;
      if (s.testingPeriods && s.testingPeriods.length > 0) return false;
      const sRole = allRoles.find(r => r.name === s.grade);
      if (!sRole) return false;
      return (sRole.sortOrder ?? 0) >= (myRole.sortOrder ?? 0);
    });
  });

  // Events for calendar (no type prefix - Outlook uses color, not text labels)
  const calendarEvents = $derived.by(() => {
    const events: any[] = [];

    if (visibleTypes.includes('meeting') && calendarData.meetings) {
      calendarData.meetings.forEach((mtg: any) => {
        events.push({
          id: mtg.id,
          title: mtg.title,
          start: new Date(mtg.scheduledAt),
          end: mtg.endedAt ? new Date(mtg.endedAt) : new Date(new Date(mtg.scheduledAt).getTime() + 3600000),
          type: 'meeting',
          isAllDay: false,
          details: mtg.description,
          raw: mtg
        });
      });
    }

    if (visibleTypes.includes('absence') && calendarData.absences) {
      calendarData.absences.forEach((abs: any) => {
        const start = new Date(abs.startDate);
        const end = abs.endDate ? new Date(abs.endDate) : (abs.isIndefinite ? new Date(start.getTime() + 86400000 * 30) : start);
        const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        events.push({
          id: abs.id,
          title: abs.reason,
          start,
          end,
          type: 'absence',
          isAllDay: abs.isIndefinite || durationHours >= 12,
          staffName: abs.staffMember?.displayName || abs.staffMember?.username,
          avatarUrl: abs.staffMember?.avatarUrl,
          raw: abs
        });
      });
    }

    if (visibleTypes.includes('call') && calendarData.calls) {
      calendarData.calls.forEach((call: any) => {
        events.push({
          id: call.id,
          title: call.title,
          start: new Date(call.scheduledAt),
          end: call.endedAt ? new Date(call.endedAt) : new Date(new Date(call.scheduledAt).getTime() + 1800000),
          type: 'call',
          isAllDay: false,
          details: call.description,
          raw: call
        });
      });
    }

    if (visibleTypes.includes('task') && calendarData.tasks) {
      calendarData.tasks.forEach((task: any) => {
        if (task.dueDate) {
          events.push({
            id: task.id,
            title: task.title,
            start: new Date(task.dueDate),
            end: new Date(new Date(task.dueDate).getTime() + 1800000),
            type: 'task',
            isAllDay: false,
            details: task.description,
            raw: task
          });
        }
      });
    }

    return events;
  });

  // Mini calendar helpers
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  function isToday(date: Date) {
    const t = new Date();
    return date.getDate() === t.getDate() && date.getMonth() === t.getMonth() && date.getFullYear() === t.getFullYear();
  }

  function isSameDay(a: Date, b: Date) {
    return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  }

  const miniCalDays = $derived.by(() => {
    const year = miniCalDate.getFullYear();
    const month = miniCalDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const offset = firstDay === 0 ? 6 : firstDay - 1;

    const days: { date: Date; isCurrentMonth: boolean }[] = [];
    const prevDays = new Date(year, month, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) {
      days.push({ date: new Date(year, month - 1, prevDays - i), isCurrentMonth: false });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({ date: new Date(year, month, i), isCurrentMonth: true });
    }
    while (days.length % 7 !== 0) {
      const nextDay = days.length - offset - daysInMonth + 1;
      days.push({ date: new Date(year, month + 1, nextDay), isCurrentMonth: false });
    }
    return days;
  });

  function navigateToDate(date: Date) {
    calendarCurrentDate = new Date(date);
  }

  function miniCalPrev() {
    miniCalDate = new Date(miniCalDate.getFullYear(), miniCalDate.getMonth() - 1, 1);
  }

  function miniCalNext() {
    miniCalDate = new Date(miniCalDate.getFullYear(), miniCalDate.getMonth() + 1, 1);
  }

  // Fuseau utilise pour lire et rendre les inputs `datetime-local` du formulaire
  // de creation et de la modale d'edition.
  //
  // Seule une reunion porte son propre fuseau, et le selecteur n'apparait que
  // sur cet onglet-la. Le retenir au-dela ferait lire une absence, un appel ou
  // une tache dans le fuseau d'une reunion creee juste avant, alors que le
  // libelle affiche sous le champ annonce celui du serveur.
  const activeTimezone = $derived(
    meetingEditModalOpen
      ? (editMeetingTimezone ?? timezoneStore.timezone)
      : creationModalOpen && currentTab === 'meeting'
        ? (formTimezone ?? timezoneStore.timezone)
        : timezoneStore.timezone,
  );
  const formatLocal = (date: Date) => formatWallClockInTimezone(date, activeTimezone);
  const parseLocal = (input: string): Date =>
    parseDateTimeInTimezone(input, activeTimezone) ?? new Date();

  /**
   * Un rappel ne porte pas de fuseau propre : il se lit toujours dans celui du
   * serveur. Il vit hors des deux modales, donc `activeTimezone` ne le decrit
   * pas - c'est ce qui le faisait heriter du fuseau de la derniere reunion.
   */
  const parseServerLocal = (input: string): Date =>
    parseDateTimeInTimezone(input, timezoneStore.timezone) ?? new Date();

  /** Meme heure au mur, relue dans un autre fuseau. */
  function reinterpretWallClock(date: Date, from: string, to: string): Date {
    return parseDateTimeInTimezone(formatWallClockInTimezone(date, from), to) ?? date;
  }

  /**
   * Changer le fuseau reinterprete l'heure affichee, il ne la reecrit pas.
   *
   * L'etiquette sous les champs annonce « Heure interpretee dans {zone} » :
   * declarer une reunion sur Montreal apres avoir tape 15:00 doit donner 15:00
   * a Montreal. Or ces champs portent un instant, pas une heure au mur, et le
   * rendu suit le fuseau courant : l'affichage sautait donc a 09:00 - le meme
   * instant vu d'ailleurs - et la reunion restait a l'heure d'origine. Le
   * formulaire d'edition, lui, garde des chaines et se comportait deja ainsi.
   *
   * Passe par le binding plutot que par un effet sur `formTimezone` : seul un
   * choix explicite dans le selecteur doit deplacer les dates. Un effet aurait
   * aussi reagi a l'arrivee du fuseau du serveur et a la reinitialisation du
   * formulaire, qui ne doivent rien deplacer du tout.
   */
  function applyFormTimezone(zone: string | null): void {
    const previous = formTimezone ?? timezoneStore.timezone;
    const next = zone ?? timezoneStore.timezone;
    formTimezone = zone;
    if (previous === next) return;

    selectedStartDate = reinterpretWallClock(selectedStartDate, previous, next);
    selectedEndDate = reinterpretWallClock(selectedEndDate, previous, next);
  }

  // Data loading
  async function loadData() {
    loading = true;
    try {
      const [membersData, rolesData, callPermData] = await Promise.all([
        fetchStaffMembers(),
        fetchStaffRoles(),
        fetchCallPermissionConfig().catch(() => null)
      ]);
      allStaff = membersData?.members || [];
      allRoles = rolesData?.roles || [];

      if (callPermData) {
        callPermConfig = callPermData.config;
        callPermCanCreate = callPermData.canCreate;

        const usersMap = new Map();
        for (const uid of callPermData.config?.allowedUserIds || []) {
          const staff = allStaff.find((s: any) => s.userId === uid);
          if (staff) usersMap.set(uid, { id: uid, username: staff.username, displayName: staff.displayName, avatarUrl: staff.avatarUrl });
        }
        permSelectedUsersMap = usersMap;
      }

      if (myStaffRecord) {
        selectedStaffIds = [myStaffRecord.id];
      } else if (allStaff.length > 0) {
        selectedStaffIds = [allStaff[0].id];
      }

      await Promise.all([refreshCalendar(), refreshTasks()]);
    } catch (e) {
      console.error('Failed to load initial data:', e);
    } finally {
      loading = false;
    }
  }

  async function refreshCalendar() {
    try {
      const data = await fetchStaffCalendarData(currentRangeStart, currentRangeEnd, selectedStaffIds);
      calendarData = {
        absences: data?.absences || [],
        voiceSessions: data?.voiceSessions || [],
        meetings: data?.meetings || [],
        calls: data?.calls || [],
        tasks: data?.tasks || []
      };
    } catch (e) {
      console.error('Failed to load calendar data:', e);
    }
  }

  async function refreshTasks() {
    try {
      if (myStaffRecord) {
        const data = await fetchTasks(myStaffRecord.id);
        userTasks = data.tasks || [];
      }
    } catch (e) {
      console.error('Failed to load tasks:', e);
    }
  }

  async function handleAddReminder() {
    if (!newReminderTime || !newReminderMessage.trim()) {
      toast.error('Date/heure et message requis');
      return;
    }

    try {
      const payload: any = {
        message: newReminderMessage,
        targetTime: parseServerLocal(newReminderTime).toISOString(),
        channelId: newReminderChannel === 'CURRENT' ? currentItemDetail.raw.discordChannelId || null : null,
      };

      if (currentItemDetail.type === 'task') payload.taskId = currentItemDetail.raw.id;
      else if (currentItemDetail.type === 'call') payload.callId = currentItemDetail.raw.id;
      else if (currentItemDetail.type === 'meeting') payload.meetingId = currentItemDetail.raw.id;

      await createReminder(payload);
      toast.success(m.planning_reminder_created());
      newReminderMessage = '';
      newReminderTime = '';
      
      await Promise.all([refreshCalendar(), refreshTasks()]);
      
      // Update currentItemDetail to show the new reminder immediately
      const updatedItem = calendarData[currentItemDetail.type + 's']?.find((x: any) => x.id === currentItemDetail.raw.id)
        || userTasks.find((x: any) => x.id === currentItemDetail.raw.id);
      if (updatedItem) {
        currentItemDetail = { ...currentItemDetail, raw: updatedItem };
      }
    } catch (e: any) {
      console.error('Failed to create reminder:', e);
      toast.error(e.message || m.planning_reminder_err_create());
    }
  }

  async function handleDeleteReminder(reminderId: string) {
    try {
      await deleteReminder(reminderId);
      toast.success(m.planning_reminder_deleted());
      
      await Promise.all([refreshCalendar(), refreshTasks()]);
      
      // Update currentItemDetail to remove the reminder immediately
      const updatedItem = calendarData[currentItemDetail.type + 's']?.find((x: any) => x.id === currentItemDetail.raw.id)
        || userTasks.find((x: any) => x.id === currentItemDetail.raw.id);
      if (updatedItem) {
        currentItemDetail = { ...currentItemDetail, raw: updatedItem };
      }
    } catch (e: any) {
      console.error('Failed to delete reminder:', e);
      toast.error(e.message || 'Impossible de supprimer le rappel');
    }
  }

  async function handleRangeChange(start: Date, end: Date) {
    currentRangeStart = start;
    currentRangeEnd = end;
    await refreshCalendar();
  }

  function handleEventClick(event: any) {
    currentItemDetail = event;
    detailModalOpen = true;
  }

  /**
   * Creneau propose a l'ouverture du formulaire.
   *
   * Il partait de l'instant d'ouverture de la modale. Le temps de saisir un
   * titre, cet instant etait passe : Discord refuse un evenement planifie dans
   * le passe, et la creation echouait sur un « Invalid Form Body » que rien ne
   * reliait a la cause. Une heure d'avance, comme le formulaire de la page
   * Reunions.
   */
  function defaultStart(): Date {
    return new Date(Date.now() + 3600000);
  }

  function openCreateModal(start: Date, end?: Date) {
    selectedStartDate = start;
    selectedEndDate = end || new Date(start.getTime() + 3600000);
    formTitle = '';
    formDescription = '';
    formTimezone = null;
    formPriority = 'MEDIUM';
    formAssigneeId = myStaffRecord?.id || '';
    formSuperiorId = eligibleSuperiors[0]?.userId || '';
    formAbsenceType = 'Autre';
    formChannelMode = 'CREATE_NEW';
    formChannelType = 'VOICE';
    formDiscordChannelId = '';
    formIsTempChannel = true;
    formInviteeUserIds = [];
    formInviteeMemberIds = [];
    selectedMembers = new Map();
    memberSearchQuery = '';
    memberSearchResults = [];
    formError = '';
    creationModalOpen = true;
  }

  async function handleCreateItem() {
    if (!formTitle && currentTab !== 'absence') {
      formError = m.planning_err_title_required();
      return;
    }
    saving = true;
    formError = '';

    try {
      if (currentTab === 'meeting') {
        // Un creneau du calendrier peut lui aussi etre deja passe. Le dire ici
        // vaut mieux que de laisser remonter le refus brut de Discord.
        if (selectedStartDate.getTime() <= Date.now()) {
          formError = m.planning_err_meeting_in_past();
          saving = false;
          return;
        }
        // Seul l'onglet Absence testait l'ordre des deux dates. La page
        // Reunions le fait aussi, avec ce meme libelle et ce meme test.
        if (selectedEndDate.getTime() <= selectedStartDate.getTime()) {
          formError = m.meetings_err_end_before_start();
          saving = false;
          return;
        }
        const ok = await createMeeting(formTitle, formDescription, selectedStartDate.toISOString(), selectedEndDate.toISOString(), formTimezone);
        if (!ok) throw new Error(m.planning_err_create_meeting());
      } else if (currentTab === 'absence') {
        if (!myStaffRecord) { formError = m.planning_err_not_staff(); saving = false; return; }
        if (!formDescription.trim()) { formError = m.planning_err_absence_reason(); saving = false; return; }
        if (!formSuperiorId) { formError = m.planning_err_superior_required(); saving = false; return; }
        if (selectedEndDate && selectedEndDate < selectedStartDate) { formError = m.planning_err_end_before_start(); saving = false; return; }
        await createAbsence({
          staffUserId: myStaffRecord.userId,
          startDate: selectedStartDate.toISOString(),
          endDate: selectedEndDate ? selectedEndDate.toISOString() : undefined,
          reason: formDescription.trim(),
          type: formAbsenceType,
          superiorUserId: formSuperiorId,
          confirmIndefinite: !selectedEndDate
        });
      } else if (currentTab === 'call') {
        if (!callPermCanCreate) { formError = m.planning_err_no_call_permission(); saving = false; return; }
        await createCall({
          title: formTitle,
          description: formDescription,
          scheduledAt: selectedStartDate.toISOString(),
          channelMode: formChannelMode,
          channelType: formChannelMode === 'CREATE_NEW' ? formChannelType : null,
          discordChannelId: formChannelMode === 'EXISTING' ? formDiscordChannelId : null,
          isTempChannel: formIsTempChannel,
          inviteeUserIds: [...formInviteeUserIds, ...formInviteeMemberIds]
        });
      } else if (currentTab === 'task') {
        await createTask({
          title: formTitle,
          description: formDescription,
          priority: formPriority,
          dueDate: selectedStartDate ? selectedStartDate.toISOString() : null,
          assigneeId: formAssigneeId
        });
      }

      creationModalOpen = false;
      await Promise.all([refreshCalendar(), refreshTasks()]);
    } catch (err: any) {
      console.error(err);
      formError = err.message || m.planning_err_create_generic();
    } finally {
      saving = false;
    }
  }

  async function toggleTaskCompletion(task: any) {
    const nextStatus = task.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED';
    try {
      await updateTask(task.id, { status: nextStatus });
      await Promise.all([refreshCalendar(), refreshTasks()]);
    } catch (e) { console.error(e); }
  }

  async function handleDeleteDetail() {
    if (!currentItemDetail) return;
    const { id, type } = currentItemDetail;
    if (type === 'meeting') {
      meetingToDeleteId = id;
      deleteDiscordEvent = true;
      deleteDiscordMessage = false;
      deleteDiscordNotification = true;
      meetingDeleteModalOpen = true;
      return;
    }
    if (!(await confirmDialog.danger(m.planning_confirm_delete_item()))) return;
    try {
      if (type === 'absence') await deleteAbsence(id);
      else if (type === 'call') await deleteCall(id);
      else if (type === 'task') await deleteTask(id);
      detailModalOpen = false;
      await Promise.all([refreshCalendar(), refreshTasks()]);
    } catch (e) { console.error(e); }
  }

  function toggleType(type: string) {
    visibleTypes = visibleTypes.includes(type) ? visibleTypes.filter(t => t !== type) : [...visibleTypes, type];
  }

  function toggleStaff(staffId: string) {
    selectedStaffIds = selectedStaffIds.includes(staffId) ? selectedStaffIds.filter(id => id !== staffId) : [...selectedStaffIds, staffId];
    refreshCalendar();
  }

  function toggleEveryone() {
    selectedStaffIds = selectedStaffIds.length === activeStaff.length ? [] : activeStaff.map(s => s.id);
    refreshCalendar();
  }

  function getTypeLabel(type: string) {
    switch (type) {
      case 'meeting': return m.planning_type_meeting();
      case 'call': return m.planning_type_call();
      case 'absence': return m.planning_type_absence();
      case 'task': return m.planning_type_task();
      default: return type;
    }
  }

  function getTypeColor(type: string) {
    switch (type) {
      case 'meeting': return 'emerald';
      case 'call': return 'green';
      case 'absence': return 'amber';
      case 'task': return 'purple';
      default: return 'slate';
    }
  }

  // Pending task count
  const pendingTaskCount = $derived(userTasks.filter(t => t.status !== 'COMPLETED').length);

  onMount(() => {
    const handleDashboardRefresh = () => loadData();
    window.addEventListener('kotbo-dashboard-refresh-request', handleDashboardRefresh);
    // Fuseau du serveur avant loadData : les formulaires seedent sinon leurs
    // dates en heure navigateur, puis basculent au chargement du store.
    void timezoneStore.ensureLoaded();
    loadData();
    return () => window.removeEventListener('kotbo-dashboard-refresh-request', handleDashboardRefresh);
  });
</script>

<ModulePage
  title={m.planning_page_title()}
  description={m.planning_page_desc()}
  icon="calendar"
  featureKey="absences"
>
  {#snippet actions()}
    <RefreshButton onClick={async () => { await Promise.all([refreshCalendar(), refreshTasks()]); }} loading={loading} label={m.planning_refresh()} />

    <!-- Task panel toggle (Outlook "My Day") -->
    <button
      onclick={() => showTaskPanel = !showTaskPanel}
      class="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all border {showTaskPanel ? 'bg-purple-500/10 border-purple-500/30 text-purple-400' : 'bg-surface-container border-outline-variant/20 text-on-surface-variant hover:text-on-surface'}"
    >
      <Papicon icon="check-square" size={14} />
      {m.planning_my_day()}
      {#if pendingTaskCount > 0}
        <span class="w-5 h-5 rounded-full bg-purple-500 text-white text-[10px] font-bold flex items-center justify-center">{pendingTaskCount}</span>
      {/if}
    </button>

    {#if isAdmin}
      <button
        onclick={openPermissionModal}
        class="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all border bg-surface-container border-outline-variant/20 text-on-surface-variant hover:text-on-surface"
        title={m.planning_call_perms_tooltip()}
      >
        <Papicon icon="shield" size={14} />
        {m.planning_call_perms_btn()}
      </button>
    {/if}

    <ActionButton
      onClick={() => openCreateModal(defaultStart())}
      variant="primary"
      icon="plus"
      label={m.planning_new_event()}
    />
  {/snippet}

  {#if loading && allStaff.length === 0}
    <div class="flex flex-col items-center justify-center py-20 bg-surface-container-lowest rounded-xl border border-outline-variant/30">
      <div class="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin"></div>
      <p class="mt-4 text-on-surface-variant font-medium">{m.planning_loading()}</p>
      <LoadingHint context="data" />
    </div>
  {:else}
    <div class="flex flex-col xl:flex-row gap-5">

      <!-- ===== LEFT SIDEBAR (Outlook-style: mini calendar + filters) ===== -->
      <aside class="w-full xl:w-60 flex flex-col gap-4 shrink-0 {sidebarCollapsed ? 'xl:w-12' : ''}">

        {#if !sidebarCollapsed}
          <!-- Mini Month Calendar -->
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant/30 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <button onclick={miniCalPrev} class="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-hover transition-colors">
                <Papicon icon="chevron-left" size={14} class="text-on-surface-variant" />
              </button>
              <span class="text-[11px] font-semibold text-on-surface capitalize">
                {capitalize(miniCalDate.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }))}
              </span>
              <button onclick={miniCalNext} class="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-hover transition-colors">
                <Papicon icon="chevron-right" size={14} class="text-on-surface-variant" />
              </button>
            </div>

            <div class="grid grid-cols-7 gap-0">
              {#each [m.planning_weekday_mon(), m.planning_weekday_tue(), m.planning_weekday_wed(), m.planning_weekday_thu(), m.planning_weekday_fri(), m.planning_weekday_sat(), m.planning_weekday_sun()] as day}
                <div class="text-center text-[9px] font-semibold text-on-surface-variant/50 py-1">{day}</div>
              {/each}
              {#each miniCalDays as { date, isCurrentMonth }}
                <button
                  onclick={() => navigateToDate(date)}
                  class="text-center text-[10px] w-full aspect-square rounded-full flex items-center justify-center transition-all
 {isCurrentMonth ? 'text-on-surface hover:bg-primary/15' : 'text-on-surface-variant/25'}
                    {isToday(date) ? 'bg-primary text-white font-bold hover:bg-primary/90' : ''}
                    {isSameDay(date, calendarCurrentDate) && !isToday(date) ? 'ring-1.5 ring-primary/50 text-primary font-semibold' : ''}"
                >
                  {date.getDate()}
                </button>
              {/each}
            </div>
          </div>

          <!-- Calendars / Type Filters -->
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant/30 shadow-sm">
            <h3 class="text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest mb-3">{m.planning_my_calendars()}</h3>
            <div class="flex flex-col gap-1">
              {#each [
                { key: 'meeting', label: m.planning_cal_meetings(), color: 'emerald' },
                { key: 'call', label: m.planning_cal_calls(), color: 'green' },
                { key: 'absence', label: m.planning_cal_absences(), color: 'amber' },
                { key: 'task', label: m.planning_cal_tasks(), color: 'purple' }
              ] as { key, label, color }}
                <button
                  onclick={() => toggleType(key)}
                  class="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-all text-left group {visibleTypes.includes(key) ? 'hover:bg-surface-hover' : 'opacity-40 hover:opacity-60'}"
                >
                  <div class="w-3.5 h-3.5 rounded flex items-center justify-center border transition-colors
 {color === 'emerald' ? (visibleTypes.includes(key) ? 'bg-emerald-500 border-emerald-600' : 'border-emerald-500/40') : ''}
                    {color === 'green' ? (visibleTypes.includes(key) ? 'bg-green-500 border-green-600' : 'border-green-500/40') : ''}
                    {color === 'amber' ? (visibleTypes.includes(key) ? 'bg-amber-500 border-amber-600' : 'border-amber-500/40') : ''}
                    {color === 'purple' ? (visibleTypes.includes(key) ? 'bg-purple-500 border-purple-600' : 'border-purple-500/40') : ''}"
                  >
                    {#if visibleTypes.includes(key)}
                      <Papicon icon="check" size={10} class="text-white" />
                    {/if}
                  </div>
                  <span class="text-[11px] font-semibold text-on-surface">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Staff Members -->
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant/30 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest">{m.planning_people()}</h3>
              <button
                onclick={toggleEveryone}
                class="text-[9px] font-semibold uppercase px-2 py-0.5 rounded transition-all {selectedStaffIds.length === activeStaff.length ? 'bg-primary/20 text-primary' : 'text-on-surface-variant/50 hover:text-on-surface-variant'}"
              >
                {selectedStaffIds.length === activeStaff.length ? m.planning_select_none() : m.planning_select_all()}
              </button>
            </div>

            <div class="flex flex-col gap-0.5 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
              {#each activeStaff as staff}
                <button
                  onclick={() => toggleStaff(staff.id)}
                  class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-all hover:bg-surface-hover group {selectedStaffIds.includes(staff.id) ? '' : 'opacity-40'}"
                >
                  <div class="relative shrink-0">
                    <img src={staff.avatarUrl || localInitialAvatar(staff.username)} alt="" class="w-6 h-6 rounded-full" />
                    {#if selectedStaffIds.includes(staff.id)}
                      <div class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-primary rounded-full border-2 border-surface-container-low"></div>
                    {/if}
                  </div>
                  <div class="flex-1 text-left min-w-0">
                    <div class="text-[11px] font-semibold text-on-surface truncate">{staff.displayName || staff.username}</div>
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Sidebar collapse toggle -->
        <button
          onclick={() => sidebarCollapsed = !sidebarCollapsed}
          class="hidden xl:flex items-center justify-center w-full py-1.5 text-on-surface-variant/40 hover:text-on-surface-variant transition-colors rounded-lg hover:bg-surface-hover"
        >
          <Papicon icon={sidebarCollapsed ? 'chevrons-right' : 'chevrons-left'} size={14} />
        </button>
      </aside>

      <!-- ===== MAIN CALENDAR ===== -->
      <main class="flex-1 min-w-0">
        <Calendar
          bind:view={calendarView}
          bind:currentDate={calendarCurrentDate}
          events={calendarEvents}
          onRangeChange={handleRangeChange}
          onEventClick={handleEventClick}
          onDateClick={(start: any, end: any) => openCreateModal(start, end)}
        />
      </main>

      <!-- ===== RIGHT PANEL: Tasks / "Ma Journée" (Outlook-style) ===== -->
      {#if showTaskPanel}
        <aside class="w-full xl:w-72 flex flex-col gap-0 shrink-0">
          <div class="bg-surface-container-low rounded-xl border border-outline-variant/30 shadow-sm flex flex-col overflow-hidden" style="height: 75vh; min-height: 600px;">
            <!-- Panel Header -->
            <div class="px-5 py-3.5 border-b border-outline-variant/20 flex items-center justify-between shrink-0">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 bg-purple-500/15 rounded-lg flex items-center justify-center">
                  <Papicon icon="sun" size={14} class="text-purple-400" />
                </div>
                <div>
                  <h3 class="text-xs font-bold text-on-surface leading-tight">{m.planning_my_day()}</h3>
                  <p class="text-[9px] text-on-surface-variant/60 font-medium">
                    {new Date().toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}
                  </p>
                </div>
              </div>
              <button
                onclick={() => showTaskPanel = false}
                class="w-6 h-6 rounded flex items-center justify-center hover:bg-surface-hover transition-colors"
              >
                <Papicon icon="x" size={14} class="text-on-surface-variant/50" />
              </button>
            </div>

            <!-- Tasks List -->
            <div class="flex-1 overflow-y-auto custom-scrollbar px-3 py-3">
              {#if userTasks.length === 0}
                <div class="flex flex-col items-center justify-center h-full text-center p-6 text-on-surface-variant/30">
                  <Papicon icon="check-circle" size={40} class="mb-3" />
                  <p class="text-xs font-semibold">{m.planning_no_task()}</p>
                  <p class="text-[10px] mt-1">{m.planning_day_free()}</p>
                </div>
              {:else}
                <div class="flex flex-col gap-1.5">
                  {#each userTasks as task}
                    <div class="group flex items-start gap-2.5 p-2.5 rounded-lg transition-all hover:bg-surface-hover/50 {task.status === 'COMPLETED' ? 'opacity-50' : ''}">
                      <button
                        onclick={() => toggleTaskCompletion(task)}
                        class="mt-0.5 w-4.5 h-4.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors
 {task.status === 'COMPLETED' ? 'border-purple-500 bg-purple-500' : 'border-on-surface-variant/30 hover:border-purple-500'}"
                      >
                        {#if task.status === 'COMPLETED'}
                          <Papicon icon="check" size={10} class="text-white" />
                        {/if}
                      </button>
                      <button
                        onclick={() => handleEventClick({
                          id: task.id,
                          title: task.title,
                          start: task.dueDate ? new Date(task.dueDate) : new Date(),
                          end: task.dueDate ? new Date(new Date(task.dueDate).getTime() + 1800000) : new Date(Date.now() + 1800000),
                          type: 'task',
                          isAllDay: false,
                          details: task.description,
                          raw: task
                        })}
                        class="text-left flex-1 min-w-0 border-none bg-transparent cursor-pointer p-0 block w-full focus:outline-none"
                      >
                        <p class="text-[11px] font-semibold text-on-surface leading-tight {task.status === 'COMPLETED' ? 'line-through text-on-surface-variant' : ''}">{task.title}</p>
                        {#if task.description}
                          <p class="text-[10px] text-on-surface-variant/60 line-clamp-1 mt-0.5">{task.description}</p>
                        {/if}
                        <div class="flex items-center gap-2 mt-1.5">
                          {#if task.priority === 'HIGH'}
                            <span class="text-[9px] font-bold uppercase tracking-wider text-red-400 flex items-center gap-0.5">
                              <Papicon icon="alert-triangle" size={9} /> {m.planning_task_important()}
                            </span>
                          {/if}
                          {#if task.dueDate}
                            <span class="text-[9px] text-on-surface-variant/50 flex items-center gap-0.5 font-medium">
                              <Papicon icon="calendar" size={9} />
                              {new Date(task.dueDate).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}
                            </span>
                          {/if}
                        </div>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Add Task -->
            <div class="px-3 py-3 border-t border-outline-variant/15 shrink-0">
              <button
                onclick={() => { gotoTab('/planning', 'task', 'meeting'); openCreateModal(defaultStart()); }}
                class="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-[11px] font-semibold text-purple-400 hover:bg-purple-500/10 transition-colors"
              >
                <Papicon icon="plus" size={14} />
                {m.planning_add_task()}
              </button>
            </div>
          </div>
        </aside>
      {/if}
    </div>
  {/if}

  <!-- ===== CREATION MODAL ===== -->
  {#if creationModalOpen}
    <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
      <button type="button" class="absolute inset-0 bg-black/50 border-none cursor-default" onclick={() => creationModalOpen = false} aria-label={m.planning_close_aria()}></button>

      <div class="relative w-full max-w-xl bg-surface-container-lowest rounded-xl shadow-2xl overflow-hidden border border-outline-variant/30 animate-in fade-in duration-200">

        <!-- Header -->
        <div class="px-6 py-4 border-b border-outline-variant/15 bg-surface-container-low flex justify-between items-center">
          <h3 class="text-sm font-bold text-on-surface">{m.planning_new_event()}</h3>
          <button onclick={() => creationModalOpen = false} class="w-7 h-7 rounded-md hover:bg-surface-hover flex items-center justify-center transition-colors">
            <Papicon icon="x" size={16} />
          </button>
        </div>

        <!-- Type Tabs (Outlook segment control) -->
        <div class="px-6 pt-4 pb-0">
          <div class="flex bg-surface-container/50 p-0.5 rounded-lg border border-outline-variant/15 gap-0.5">
            {#each [
              { key: 'meeting', label: m.planning_type_meeting(), icon: 'calendar', color: 'emerald' },
              { key: 'call', label: m.planning_type_call(), icon: 'phone', color: 'green' },
              { key: 'absence', label: m.planning_type_absence(), icon: 'sun', color: 'amber' },
              { key: 'task', label: m.planning_type_task(), icon: 'check-square', color: 'purple' }
            ].filter(t => t.key !== 'call' || callPermCanCreate) as { key, label, icon, color }}
              <button
                onclick={() => gotoTab('/planning', key, 'meeting')}
                class="flex-1 py-2 text-[11px] font-semibold rounded-md transition-all flex items-center justify-center gap-1.5 whitespace-nowrap
 {currentTab === key
                    ? (color === 'emerald' ? 'bg-emerald-500 text-white shadow-sm' :
                       color === 'green' ? 'bg-green-600 text-white shadow-sm' :
                       color === 'amber' ? 'bg-amber-500 text-white shadow-sm' :
                       'bg-purple-600 text-white shadow-sm')
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-hover'}"
              >
                <Papicon icon={icon} size={12} />
                {label}
              </button>
            {/each}
          </div>
        </div>

        <div class="px-6 py-5 space-y-4 max-h-[55vh] overflow-y-auto custom-scrollbar">
          <!-- Title -->
          {#if currentTab !== 'absence'}
            <div>
              <FormInput bind:value={formTitle} placeholder={m.planning_title_ph()} className="w-full text-sm font-semibold border-0! border-b! border-outline-variant/20! rounded-none! px-0! py-2! focus:border-primary! bg-transparent!" />
            </div>
          {/if}

          <!-- Dates -->
          <div class="flex items-center gap-3">
            <Papicon icon="clock" size={16} class="text-on-surface-variant/50 shrink-0" />
            <div class="flex-1 flex flex-wrap items-center gap-2">
              <input
                type="datetime-local"
                value={formatLocal(selectedStartDate)}
                onchange={(e) => selectedStartDate = parseLocal((e.target as HTMLInputElement).value)}
                class="bg-transparent text-xs font-medium px-2 py-1.5 rounded-md border border-outline-variant/20 focus:border-primary outline-none transition-all"
              />
              {#if currentTab !== 'task'}
                <span class="text-on-surface-variant/40 text-xs">–</span>
                <input
                  type="datetime-local"
                  value={formatLocal(selectedEndDate)}
                  onchange={(e) => selectedEndDate = parseLocal((e.target as HTMLInputElement).value)}
                  class="bg-transparent text-xs font-medium px-2 py-1.5 rounded-md border border-outline-variant/20 focus:border-primary outline-none transition-all"
                />
              {/if}
            </div>
          </div>
          {#if timezoneStore.loaded && currentTab === 'meeting'}
            <div class="pl-7">
              <TimezoneHint bind:value={() => formTimezone, (zone) => applyFormTimezone(zone)} />
            </div>
          {:else if timezoneStore.loaded}
            <p class="pl-7 text-[10px] text-on-surface-variant/70">
              {#if timezoneStore.differsFromBrowser}
                {m.planning_datetime_hint_diff({ server: timezoneStore.timezone, browser: timezoneStore.browserTimezone })}
              {:else}
                {m.planning_datetime_hint_same({ zone: timezoneStore.timezone })}
              {/if}
            </p>
          {/if}

          <!-- Description -->
          <div class="flex items-start gap-3">
            <Papicon icon="align-left" size={16} class="text-on-surface-variant/50 shrink-0 mt-2" />
            <FormTextarea bind:value={formDescription} placeholder={currentTab === 'absence' ? m.planning_absence_reason_ph() : m.planning_description_ph()} rows={2} className="w-full resize-none text-xs!" />
          </div>

          <!-- Absence-specific fields -->
          {#if currentTab === 'absence'}
            <div class="flex items-center gap-3">
              <Papicon icon="tag" size={16} class="text-on-surface-variant/50 shrink-0" />
              <div class="flex-1 grid grid-cols-2 gap-3">
                <FormSelect bind:value={formAbsenceType} className="w-full text-xs! py-1.5!">
                  <option value="Vacances">{m.planning_absence_type_holidays()}</option>
                  <option value="Maladie">{m.planning_absence_type_sick()}</option>
                  <option value="Examens">{m.planning_absence_type_exams()}</option>
                  <option value="Autre">{m.planning_absence_type_other()}</option>
                </FormSelect>
                <SearchableSelect
                  bind:value={formSuperiorId}
                  options={eligibleSuperiors.map(s => ({ id: s.userId, name: s.displayName || s.username }))}
                  placeholder={m.planning_superior_ph()}
                  className="w-full text-xs!"
                />
              </div>
            </div>
          {/if}

          <!-- Call-specific fields -->
          {#if currentTab === 'call'}
            <div class="border border-outline-variant/15 rounded-lg p-4 bg-surface-container/30 space-y-3">
              <div class="flex items-center gap-2 text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest">
                <Papicon icon="headphones" size={12} />
                {m.planning_discord_config()}
              </div>

              <div class="grid grid-cols-2 gap-3">
                <FormSelect bind:value={formChannelMode} className="w-full text-xs! py-1.5!">
                  <option value="CREATE_NEW">{m.planning_channel_temp()}</option>
                  <option value="EXISTING">{m.planning_channel_existing()}</option>
                </FormSelect>
                {#if formChannelMode === 'CREATE_NEW'}
                  <FormSelect bind:value={formChannelType} className="w-full text-xs! py-1.5!">
                    <option value="VOICE">{m.planning_channel_voice()}</option>
                    <option value="STAGE">{m.planning_channel_stage()}</option>
                  </FormSelect>
                {:else}
                  <SearchableSelect
                    bind:value={formDiscordChannelId}
                    options={[
                      ...dashboardStore.state.discordVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` })),
                      ...dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))
                    ]}
                    placeholder={m.planning_select_ph()}
                    className="w-full text-xs!"
                  />
                {/if}
              </div>

              {#if formChannelMode === 'CREATE_NEW'}
                <div class="flex items-center justify-between py-2 px-3 rounded-md bg-surface-container-high/30">
                  <span class="text-[10px] font-medium text-on-surface-variant">{m.planning_auto_delete_empty()}</span>
                  <ToggleSwitch checked={formIsTempChannel} onToggle={(v: boolean) => formIsTempChannel = v} />
                </div>
              {/if}

              <div>
                <span class="block text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest mb-2">{m.planning_guests_staff()}</span>
                <div class="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto custom-scrollbar">
                  {#each activeStaff.filter(s => s.id !== myStaffRecord?.id) as staff}
                    <label class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-container-high/30 rounded-md cursor-pointer hover:bg-surface-container-high/50 transition-colors">
                      <input
                        type="checkbox"
                        checked={formInviteeUserIds.includes(staff.id)}
                        onchange={(e) => {
                          if ((e.target as HTMLInputElement).checked) formInviteeUserIds = [...formInviteeUserIds, staff.id];
                          else formInviteeUserIds = formInviteeUserIds.filter(id => id !== staff.id);
                        }}
                        class="rounded border-outline-variant text-primary focus:ring-primary w-3 h-3"
                      />
                      <span class="text-[10px] font-semibold text-on-surface">{staff.displayName || staff.username}</span>
                    </label>
                  {/each}
                </div>
              </div>

              <!-- Members search section -->
              <div>
                <span class="block text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest mb-2">{m.planning_guests_members()}</span>

                <!-- Selected members chips -->
                {#if formInviteeMemberIds.length > 0}
                  <div class="flex flex-wrap gap-1.5 mb-2">
                    {#each formInviteeMemberIds as memberId}
                      {@const member = selectedMembers.get(memberId)}
                      {#if member}
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-cyan-500/15 border border-cyan-500/25 rounded-md text-[10px] font-semibold text-cyan-300">
                          <img src={member.avatarUrl || localInitialAvatar(member.displayName || member.username)} alt="" class="w-3.5 h-3.5 rounded-full" />
                          {member.displayName || member.username}
                          <button
                            onclick={() => toggleMemberInvitee(member)}
                            class="ml-0.5 w-3.5 h-3.5 rounded-full hover:bg-cyan-500/30 flex items-center justify-center transition-colors"
                          >
                            <Papicon icon="x" size={8} />
                          </button>
                        </span>
                      {/if}
                    {/each}
                  </div>
                {/if}

                <!-- Search input -->
                <div class="relative">
                  <div class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                    {#if memberSearchLoading}
                      <div class="w-3.5 h-3.5 border-2 border-primary/20 border-t-primary rounded-full animate-spin"></div>
                    {:else}
                      <Papicon icon="search" size={12} class="text-on-surface-variant/40" />
                    {/if}
                  </div>
                  <input
                    type="text"
                    value={memberSearchQuery}
                    oninput={(e) => handleMemberSearchInput((e.target as HTMLInputElement).value)}
                    placeholder={m.planning_search_member_ph()}
                    class="w-full pl-8 pr-3 py-2 bg-surface-container-high/30 rounded-md border border-outline-variant/15 text-[11px] font-medium text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/50 transition-colors"
                  />
                </div>

                <!-- Search results -->
                {#if memberSearchResults.length > 0}
                  <div class="mt-2 max-h-32 overflow-y-auto custom-scrollbar rounded-md border border-outline-variant/15 bg-surface-container/50">
                    {#each memberSearchResults as member}
                      <button
                        onclick={() => toggleMemberInvitee(member)}
                        class="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all hover:bg-surface-hover/50 {formInviteeMemberIds.includes(member.id) ? 'bg-cyan-500/10' : ''}"
                      >
                        <img src={member.avatarUrl || localInitialAvatar(member.displayName || member.username)} alt="" class="w-5 h-5 rounded-full shrink-0" />
                        <div class="flex-1 min-w-0">
                          <span class="text-[11px] font-semibold text-on-surface truncate block">{member.displayName || member.username}</span>
                          {#if member.username !== member.displayName}
                            <span class="text-[9px] text-on-surface-variant/50">@{member.username}</span>
                          {/if}
                        </div>
                        {#if formInviteeMemberIds.includes(member.id)}
                          <div class="w-4 h-4 rounded bg-cyan-500 flex items-center justify-center shrink-0">
                            <Papicon icon="check" size={10} class="text-white" />
                          </div>
                        {:else}
                          <div class="w-4 h-4 rounded border border-outline-variant/30 shrink-0"></div>
                        {/if}
                      </button>
                    {/each}
                  </div>
                {:else if memberSearchQuery.trim() && !memberSearchLoading}
                  <p class="mt-2 text-[10px] text-on-surface-variant/40 text-center py-2">{m.planning_no_member_found()}</p>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Task-specific fields -->
          {#if currentTab === 'task'}
            <div class="flex items-center gap-3">
              <Papicon icon="flag" size={16} class="text-on-surface-variant/50 shrink-0" />
              <div class="flex-1 grid grid-cols-2 gap-3">
                <FormSelect bind:value={formPriority} className="w-full text-xs! py-1.5!">
                  <option value="LOW">{m.planning_priority_low()}</option>
                  <option value="MEDIUM">{m.planning_priority_medium()}</option>
                  <option value="HIGH">{m.planning_priority_high()}</option>
                </FormSelect>
                <SearchableSelect
                  bind:value={formAssigneeId}
                  options={activeStaff.map(s => ({ id: s.id, name: s.displayName || s.username }))}
                  placeholder={m.planning_assign_ph()}
                  className="w-full text-xs!"
                />
              </div>
            </div>
          {/if}

          {#if formError}
            <div class="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-[11px] font-semibold">
              <Papicon icon="alert-circle" size={14} />
              {formError}
            </div>
          {/if}
        </div>

        <!-- Footer -->
        <div class="px-6 py-3.5 border-t border-outline-variant/15 bg-surface-container-low flex justify-end gap-2">
          <button onclick={() => creationModalOpen = false} class="px-4 py-2 rounded-lg text-[11px] font-semibold text-on-surface-variant hover:bg-surface-hover transition-colors">
            {m.common_cancel()}
          </button>
          <button
            onclick={handleCreateItem}
            disabled={saving}
            class="px-5 py-2 rounded-lg text-[11px] font-semibold text-white bg-primary hover:bg-primary-hover disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-md"
          >
            {#if saving}
              <div class="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
            {/if}
            {m.common_save()}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ===== DETAIL MODAL ===== -->
  {#if detailModalOpen && currentItemDetail}
    {@const raw = currentItemDetail.raw}
    {@const typeColor = getTypeColor(currentItemDetail.type)}
    <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
      <button type="button" class="absolute inset-0 bg-black/50 border-none cursor-default" onclick={() => detailModalOpen = false} aria-label={m.planning_close_aria()}></button>

      <div class="relative w-full max-w-md max-h-[85vh] bg-surface-container-lowest rounded-xl shadow-2xl overflow-hidden border border-outline-variant/30 animate-in fade-in duration-200 text-on-surface flex flex-col">

        <!-- Colored top bar (Outlook-style) -->
        <div class="h-1 shrink-0 {typeColor === 'emerald' ? 'bg-emerald-500' : typeColor === 'green' ? 'bg-green-500' : typeColor === 'amber' ? 'bg-amber-500' : 'bg-purple-500'}"></div>

        <div class="p-5 overflow-y-auto custom-scrollbar flex-1 min-h-0">
          <!-- Header -->
          <div class="flex justify-between items-start mb-4">
            <div class="flex-1 min-w-0">
              <span class="text-[9px] font-bold uppercase tracking-wider
 {typeColor === 'emerald' ? 'text-emerald-400' : typeColor === 'green' ? 'text-green-400' : typeColor === 'amber' ? 'text-amber-400' : 'text-purple-400'}">
                {getTypeLabel(currentItemDetail.type)}
              </span>
              <h3 class="text-base font-bold mt-0.5 leading-tight">{currentItemDetail.title}</h3>
            </div>
            <button onclick={() => detailModalOpen = false} class="w-7 h-7 rounded-md hover:bg-surface-hover flex items-center justify-center transition-colors shrink-0 ml-2">
              <Papicon icon="x" size={16} />
            </button>
          </div>

          <!-- Time -->
          <div class="flex items-center gap-2.5 text-xs text-on-surface-variant mb-4">
            <Papicon icon="clock" size={14} class="shrink-0" />
            <span class="font-medium">
              {new Date(currentItemDetail.start).toLocaleString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {#if currentItemDetail.end}
                <span class="text-on-surface-variant/40 mx-1">–</span>
                {new Date(currentItemDetail.end).toLocaleString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}
              {/if}
            </span>
          </div>

          <!-- Description -->
          {#if raw.description || raw.reason}
            {#if currentItemDetail.type === 'meeting'}
              <div class="p-4 bg-[#2f3136] rounded-lg border border-white/5 text-xs mb-4">
                <div class="text-[#dcddde] leading-relaxed whitespace-pre-wrap break-words discord-preview">
                  {@html parseDiscordEmojisAndMarkdown(raw.description || '')}
                </div>
              </div>
            {:else}
              <div class="p-3 bg-surface-container/50 rounded-lg text-xs text-on-surface-variant leading-relaxed mb-4">
                {raw.description || raw.reason}
              </div>
            {/if}
          {/if}

          <!-- Type-specific details -->
          {#if currentItemDetail.type === 'meeting'}
            {@const stats = getAttendanceStats(raw)}
            <div class="space-y-4 mb-4">
              <!-- Meeting Status and Moderation Actions -->
              <div class="flex items-center justify-between gap-3">
                <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider {getStatusColor(raw.status)}">
                  {formatStatus(raw.status)}
                </span>
                
                {#if canModerateMeetings}
                  <div class="flex items-center gap-2">
                    {#if raw.status === 'SCHEDULED'}
                      <button 
                        onclick={() => updateMeetingStatus(currentItemDetail.id, 'IN_PROGRESS')} 
                        class="text-[10px] font-bold text-primary bg-primary/10 px-2.5 py-1 hover:bg-primary/20 rounded-md transition-colors flex items-center gap-1"
                      >
                        <Papicon icon="play" size={10} />
                        {m.meetings_start_btn()}
                      </button>
                    {:else if raw.status === 'IN_PROGRESS'}
                      <button 
                        onclick={() => updateMeetingStatus(currentItemDetail.id, 'COMPLETED')} 
                        class="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2.5 py-1 hover:bg-emerald-500/20 rounded-md transition-colors flex items-center gap-1"
                      >
                        <Papicon icon="check" size={10} />
                        {m.meetings_finish_btn()}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>

              <!-- Attendance Stats -->
              <div class="grid grid-cols-3 gap-2 p-3 bg-surface-container-low rounded-lg text-center">
                <div>
                  <p class="text-[9px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.meetings_stat_present()}</p>
                  <p class="text-base font-bold text-emerald-500">{stats.present}</p>
                </div>
                <div class="border-x border-outline-variant/30">
                  <p class="text-[9px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.meetings_stat_excused()}</p>
                  <p class="text-base font-bold text-amber-500">{stats.excused}</p>
                </div>
                <div>
                  <p class="text-[9px] font-semibold text-on-surface-variant uppercase tracking-widest">{m.meetings_stat_absent()}</p>
                  <p class="text-base font-bold text-red-500">{stats.absent}</p>
                </div>
              </div>

              <!-- Attendance List -->
              {#if raw.presences && raw.presences.length > 0}
                <div class="space-y-2">
                  <span class="block text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest px-1">{m.meetings_presence_list_title()}</span>
                  <div class="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                    {#each raw.presences as presence}
                      <div class="flex items-center justify-between p-2 bg-surface-container-low/50 rounded-lg border border-outline-variant/10 hover:bg-surface-container-low transition-colors group">
                        <div class="flex items-center gap-2.5 min-w-0">
                          <button 
                            type="button"
                            onclick={() => openMemberCase(presence.staffUserId, presence.staffMember?.displayName || presence.staffMember?.username || m.planning_member_fallback())}
                            class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-semibold text-primary overflow-hidden transition-transform shrink-0"
                          >
                            {#if presence.staffMember?.avatarUrl}
                              <img src={presence.staffMember.avatarUrl} alt="" class="w-full h-full object-cover" />
                            {:else}
                              {presence.staffMember?.displayName?.slice(0, 2).toUpperCase() || presence.staffMember?.username?.slice(0, 2).toUpperCase() || "??"}
                            {/if}
                          </button>
                          <div class="min-w-0">
                            <button 
                              type="button"
                              onclick={() => openMemberCase(presence.staffUserId, presence.staffMember?.displayName || presence.staffMember?.username || m.planning_member_fallback())}
                              class="text-xs font-bold text-on-surface hover:text-primary transition-colors text-left block truncate"
                            >
                              {presence.staffMember?.displayName || presence.staffMember?.username || m.planning_member_fallback()}
                            </button>
                            {#if presence.note}
                              <p class="text-[9px] text-on-surface-variant leading-tight mt-0.5 truncate" title={presence.note}>{presence.note}</p>
                            {/if}
                          </div>
                        </div>
                        <div class="shrink-0">
                          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[8px] font-semibold uppercase tracking-wider {getStatusColor(presence.status)}">
                            {formatStatus(presence.status)}
                          </span>
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          {#if currentItemDetail.type === 'call'}
            <div class="space-y-2 text-xs mb-4">
              <div class="flex items-center gap-2 text-on-surface-variant">
                <Papicon icon="headphones" size={12} />
                <span class="font-medium">{raw.channelMode === 'CREATE_NEW' ? m.planning_channel_temp() : m.planning_channel_existing()}</span>
              </div>
              {#if raw.invitees && raw.invitees.length > 0}
                <div class="flex items-start gap-2">
                  <Papicon icon="users" size={12} class="mt-1 text-on-surface-variant" />
                  <div class="flex flex-wrap gap-1.5">
                    {#each raw.invitees as invitee}
                      <span class="flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-surface-container-high text-[10px] font-semibold">
                        <img
                          src={invitee.staffMember?.avatarUrl || localInitialAvatar(invitee.staffMember?.displayName || invitee.staffMember?.username)}
                          alt=""
                          class="w-4 h-4 rounded-full"
                        />
                        {invitee.staffMember?.displayName || invitee.staffMember?.username || m.planning_member_fallback()}
                      </span>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          {#if currentItemDetail.type === 'task'}
            <div class="flex items-center gap-4 text-xs mb-4">
              <div class="flex items-center gap-1.5">
                <Papicon icon="flag" size={12} class="text-on-surface-variant" />
                <span class="font-semibold {raw.priority === 'HIGH' ? 'text-red-400' : raw.priority === 'MEDIUM' ? 'text-amber-400' : 'text-blue-400'}">{raw.priority}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <Papicon icon="activity" size={12} class="text-on-surface-variant" />
                <span class="font-semibold text-purple-400">{raw.status}</span>
              </div>
              {#if raw.assignee}
                <div class="flex items-center gap-1.5">
                  <img
                    src={raw.assignee.avatarUrl || localInitialAvatar(raw.assignee.displayName || raw.assignee.username)}
                    alt=""
                    class="w-4 h-4 rounded-full"
                  />
                  <span class="font-medium">{raw.assignee.displayName || raw.assignee.username}</span>
                </div>
              {/if}
            </div>
          {/if}

          {#if currentItemDetail.type === 'absence'}
            <div class="flex items-center gap-2.5 mb-3">
              <img
                src={currentItemDetail.avatarUrl || localInitialAvatar(currentItemDetail.staffName || raw.staffMember?.username)}
                alt=""
                class="w-7 h-7 rounded-full border border-outline-variant/20"
              />
              <span class="text-xs font-bold text-on-surface">{currentItemDetail.staffName || raw.staffMember?.username || m.planning_unknown_member()}</span>
            </div>
            <div class="flex items-center gap-4 text-xs mb-4">
              <div class="flex items-center gap-1.5">
                <Papicon icon="tag" size={12} class="text-on-surface-variant" />
                <span class="font-semibold text-amber-400">{raw.type || m.planning_absence_type_default()}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <Papicon icon="info" size={12} class="text-on-surface-variant" />
                <span class="font-semibold {raw.status === 'APPROVED' ? 'text-emerald-400' : 'text-amber-400'}">
                  {raw.status === 'APPROVED' ? m.planning_absence_approved() : raw.status === 'PENDING' ? m.planning_absence_pending() : raw.status}
                </span>
              </div>
            </div>
          {/if}

          {#if currentItemDetail.type !== 'absence'}
            <div class="mt-4 border-t border-outline-variant/15 pt-4 text-left">
              <h4 class="text-xs font-bold text-on-surface mb-2 flex items-center gap-1.5">
                <Papicon icon="bell" size={12} class="text-amber-400" />
                {m.planning_reminders_title({ count: raw.reminders?.length || 0 })}
              </h4>

              {#if raw.reminders && raw.reminders.length > 0}
                <div class="space-y-1.5 max-h-32 overflow-y-auto mb-3 custom-scrollbar">
                  {#each raw.reminders as reminder}
                    <div class="flex items-center justify-between p-2 rounded bg-surface-container/60 text-[11px] border border-outline-variant/5">
                      <div class="flex-1 min-w-0 pr-2">
                        <div class="font-medium text-on-surface truncate">{reminder.message}</div>
                        <div class="text-[9px] text-on-surface-variant">
                          {m.planning_reminder_at({ date: new Date(reminder.targetTime).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}
                          {#if reminder.fired}
                            <span class="text-emerald-400 ml-1">{m.planning_reminder_sent()}</span>
                          {:else}
                            <span class="text-amber-400 ml-1">{m.planning_reminder_scheduled()}</span>
                          {/if}
                        </div>
                      </div>
                      <button
                        onclick={() => handleDeleteReminder(reminder.id)}
                        class="p-1 rounded hover:bg-red-500/10 text-red-400 border-none bg-transparent transition-colors cursor-pointer shrink-0"
                        title={m.planning_reminder_delete_tooltip()}
                      >
                        <Papicon icon="trash-2" size={10} />
                      </button>
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="text-[11px] text-on-surface-variant italic mb-3">{m.planning_no_reminder()}</p>
              {/if}

              <!-- Add Reminder Form -->
              <div class="flex flex-col gap-2 p-2.5 rounded bg-surface-container/30 border border-outline-variant/10 text-xs">
                <div class="font-semibold text-[10px] uppercase text-on-surface-variant">{m.planning_schedule_reminder()}</div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label for="new-reminder-time" class="block text-[9px] text-on-surface-variant font-medium mb-1">{m.planning_reminder_datetime()}</label>
                    <input
                      id="new-reminder-time"
                      type="datetime-local"
                      bind:value={newReminderTime}
                      class="w-full bg-surface-container-high border border-outline-variant/20 rounded px-2 py-1 text-xs text-on-surface outline-none"
                    />
                    {#if timezoneStore.loaded && timezoneStore.differsFromBrowser}
                      <p class="mt-1 text-[9px] text-on-surface-variant/70">
                        {m.planning_datetime_hint_diff_short({ server: timezoneStore.timezone })}
                      </p>
                    {/if}
                  </div>
                  <div>
                    <label for="new-reminder-channel" class="block text-[9px] text-on-surface-variant font-medium mb-1">{m.planning_reminder_channel()}</label>
                    <select
                      id="new-reminder-channel"
                      bind:value={newReminderChannel}
                      class="w-full bg-surface-container-high border border-outline-variant/20 rounded px-2 py-1 text-xs text-on-surface outline-none"
                    >
                      <option value="DM">{m.planning_reminder_channel_dm()}</option>
                      <option value="CURRENT">{m.planning_reminder_channel_current()}</option>
                    </select>
                  </div>
                </div>
                <div class="flex gap-2 items-center">
                  <input
                    type="text"
                    placeholder={m.planning_reminder_note_ph()}
                    bind:value={newReminderMessage}
                    class="flex-1 bg-surface-container-high border border-outline-variant/20 rounded px-2.5 py-1 text-xs text-on-surface outline-none"
                  />
                  <button
                    onclick={handleAddReminder}
                    class="px-3 py-1 rounded bg-amber-500 hover:bg-amber-600 text-white font-medium transition-colors shrink-0 text-xs cursor-pointer border-none"
                  >
                    {m.planning_reminder_add()}
                  </button>
                </div>
              </div>
            </div>
          {/if}
        </div>

        <!-- Footer actions -->
        <div class="px-5 py-3 border-t border-outline-variant/15 bg-surface-container-low/50 flex justify-between items-center shrink-0">
          <div class="flex gap-2">
            <button onclick={handleDeleteDetail} class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold text-red-400 hover:bg-red-500/10 transition-colors">
              <Papicon icon="trash-2" size={12} />
              {m.planning_detail_delete()}
            </button>
            {#if currentItemDetail.type === 'meeting' && canManageMeetings}
              <button onclick={() => openEditMeeting(raw)} class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold text-primary hover:bg-primary/10 transition-colors">
                <Papicon icon="edit-2" size={12} />
                {m.planning_detail_edit()}
              </button>
            {/if}
          </div>
          <button onclick={() => detailModalOpen = false} class="px-4 py-1.5 rounded-md text-[11px] font-semibold text-on-surface-variant hover:bg-surface-hover transition-colors">
            {m.planning_detail_close()}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ===== CALL PERMISSIONS MODAL ===== -->
  {#if permissionModalOpen}
    <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
      <button type="button" class="absolute inset-0 bg-black/50 border-none cursor-default" onclick={() => permissionModalOpen = false} aria-label={m.planning_close_aria()}></button>

      <div class="relative w-full max-w-lg bg-surface-container-lowest rounded-xl shadow-2xl overflow-hidden border border-outline-variant/30 animate-in fade-in duration-200">
        <div class="px-6 py-4 border-b border-outline-variant/15 bg-surface-container-low flex justify-between items-center">
          <h3 class="text-sm font-bold text-on-surface">{m.planning_call_perms_tooltip()}</h3>
          <button onclick={() => permissionModalOpen = false} class="w-7 h-7 rounded-md hover:bg-surface-hover flex items-center justify-center transition-colors">
            <Papicon icon="x" size={16} />
          </button>
        </div>

        <div class="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
          <div class="flex bg-surface-container/50 p-0.5 rounded-lg border border-outline-variant/15 gap-0.5">
            <button
              onclick={() => permMode = 'EVERYONE'}
              class="flex-1 py-2 text-[11px] font-semibold rounded-md transition-all {permMode === 'EVERYONE' ? 'bg-primary text-white shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-hover'}"
            >
              {m.planning_perm_everyone()}
            </button>
            <button
              onclick={() => permMode = 'RESTRICTED'}
              class="flex-1 py-2 text-[11px] font-semibold rounded-md transition-all {permMode === 'RESTRICTED' ? 'bg-primary text-white shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-hover'}"
            >
              {m.planning_perm_restricted()}
            </button>
          </div>

          {#if permMode === 'RESTRICTED'}
            <div>
              <span class="block text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest mb-2">{m.planning_perm_roles()}</span>
              {#if (dashboardStore.state.discordRoles || []).length === 0}
                <p class="text-[10px] text-on-surface-variant/40">{m.planning_perm_no_roles()}</p>
              {:else}
                <div class="flex flex-wrap gap-1.5">
                  {#each dashboardStore.state.discordRoles as role}
                    <button
                      onclick={() => togglePermRole(role.id)}
                      class="px-2.5 py-1 rounded-md text-[10px] font-semibold border transition-colors {permRoleIds.includes(role.id) ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-surface-container-high/30 border-outline-variant/15 text-on-surface-variant hover:bg-surface-container-high/50'}"
                    >
                      @{role.name}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <div>
              <span class="block text-[10px] font-semibold text-on-surface-variant/60 uppercase tracking-widest mb-2">{m.planning_perm_members()}</span>

              {#if permUserIds.length > 0}
                <div class="flex flex-wrap gap-1.5 mb-2">
                  {#each permUserIds as uid}
                    {@const u = permSelectedUsersMap.get(uid)}
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-cyan-500/15 border border-cyan-500/25 rounded-md text-[10px] font-semibold text-cyan-300">
                      {#if u}
                        <img src={u.avatarUrl || localInitialAvatar(u.displayName || u.username)} alt="" class="w-3.5 h-3.5 rounded-full" />
                      {/if}
                      {u ? (u.displayName || u.username) : uid}
                      <button onclick={() => togglePermUser({ id: uid, ...(u || {}) })} class="ml-0.5 w-3.5 h-3.5 rounded-full hover:bg-cyan-500/30 flex items-center justify-center transition-colors">
                        <Papicon icon="x" size={8} />
                      </button>
                    </span>
                  {/each}
                </div>
              {/if}

              <div class="relative">
                <div class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                  {#if permMemberSearchLoading}
                    <div class="w-3.5 h-3.5 border-2 border-primary/20 border-t-primary rounded-full animate-spin"></div>
                  {:else}
                    <Papicon icon="search" size={12} class="text-on-surface-variant/40" />
                  {/if}
                </div>
                <input
                  type="text"
                  value={permMemberSearchQuery}
                  oninput={(e) => handlePermMemberSearchInput((e.target as HTMLInputElement).value)}
                  placeholder={m.planning_search_member_ph()}
                  class="w-full pl-8 pr-3 py-2 bg-surface-container-high/30 rounded-md border border-outline-variant/15 text-[11px] font-medium text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/50 transition-colors"
                />
              </div>

              {#if permMemberSearchResults.length > 0}
                <div class="mt-2 max-h-32 overflow-y-auto custom-scrollbar rounded-md border border-outline-variant/15 bg-surface-container/50">
                  {#each permMemberSearchResults as member}
                    <button
                      onclick={() => togglePermUser(member)}
                      class="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all hover:bg-surface-hover/50"
                    >
                      <img src={member.avatarUrl || localInitialAvatar(member.displayName || member.username)} alt="" class="w-5 h-5 rounded-full shrink-0" />
                      <div class="flex-1 min-w-0">
                        <span class="text-[11px] font-semibold text-on-surface truncate block">{member.displayName || member.username}</span>
                      </div>
                    </button>
                  {/each}
                </div>
              {:else if permMemberSearchQuery.trim() && !permMemberSearchLoading}
                <p class="mt-2 text-[10px] text-on-surface-variant/40 text-center py-2">{m.planning_no_member_found()}</p>
              {/if}
            </div>
          {:else}
            <p class="text-[11px] text-on-surface-variant/60">{m.planning_perm_everyone_hint()}</p>
          {/if}

          {#if permError}
            <div class="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-[11px] font-semibold">
              <Papicon icon="alert-circle" size={14} />
              {permError}
            </div>
          {/if}
        </div>

        <div class="px-6 py-3.5 border-t border-outline-variant/15 bg-surface-container-low flex justify-end gap-2">
          <button onclick={() => permissionModalOpen = false} class="px-4 py-2 rounded-lg text-[11px] font-semibold text-on-surface-variant hover:bg-surface-hover transition-colors">
            {m.common_cancel()}
          </button>
          <button
            onclick={savePermissionConfig}
            disabled={permSaving}
            class="px-5 py-2 rounded-lg text-[11px] font-semibold text-white bg-primary hover:bg-primary-hover disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-md"
          >
            {#if permSaving}
              <div class="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
            {/if}
            {m.common_save()}
          </button>
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
      const label = foundNode?.label || 'Membre';
      openMemberCase(newUserId, label);
    }}
  />

  {#if meetingDeleteModalOpen}
    <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
      <div 
        class="absolute inset-0 bg-black/60" 
        onclick={() => meetingDeleteModalOpen = false}
        onkeydown={(e) => e.key === 'Escape' && (meetingDeleteModalOpen = false)}
        role="button"
        tabindex="0"
        aria-label={m.meetings_close_modal_aria()}
      ></div>
      
      <div class="relative w-full max-w-md bg-surface-container-lowest rounded-xl shadow-2xl overflow-hidden border border-outline-variant/30 font-inter text-on-surface">
        <div class="p-8 border-b border-outline-variant/30 bg-red-500/5 flex items-center justify-between">
          <div>
            <h3 class="text-xl font-semibold text-on-surface">{m.meetings_delete_modal_title()}</h3>
            <p class="text-on-surface-variant text-sm">{m.meetings_delete_modal_subtitle()}</p>
          </div>
          <button onclick={() => meetingDeleteModalOpen = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
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
            <button onclick={() => meetingDeleteModalOpen = false} class="px-6 py-2.5 font-bold text-on-surface-variant hover:bg-surface-hover rounded-xl transition-colors">
              {m.common_cancel()}
            </button>
            <button 
              onclick={confirmDeleteMeeting}
              disabled={deletingMeeting}
              class="px-8 py-2.5 bg-red-500 text-white rounded-xl font-semibold shadow-sm hover:shadow-red-500/40 disabled:opacity-50 transition-all flex items-center gap-2"
            >
              {#if deletingMeeting}
                <div class="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
              {/if}
              {m.planning_detail_delete()}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if meetingEditModalOpen}
    <div class="fixed inset-0 z-100 flex items-center justify-center p-4">
      <div 
        class="absolute inset-0 bg-black/60" 
        onclick={() => meetingEditModalOpen = false}
        onkeydown={(e) => e.key === 'Escape' && (meetingEditModalOpen = false)}
        role="button"
        tabindex="0"
        aria-label={m.meetings_close_modal_aria()}
      ></div>
      
      <div class="relative w-full max-w-3xl bg-surface-container-lowest rounded-xl shadow-2xl overflow-hidden border border-outline-variant/30 font-inter text-on-surface">
        <div class="p-8 border-b border-outline-variant/30 flex items-center justify-between bg-primary/5">
          <div>
            <h3 class="text-2xl font-semibold text-on-surface">{m.planning_edit_meeting_title()}</h3>
            <p class="text-on-surface-variant text-sm">{m.meetings_modal_subtitle()}</p>
          </div>
          <button onclick={() => meetingEditModalOpen = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
            <Papicon icon="x" size={24} />
          </button>
        </div>

        <div class="p-8 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
          <div>
            <label for="edit-meeting-title" class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">{m.meetings_field_title_label()}</label>
            <FormInput 
              id="edit-meeting-title"
              bind:value={editMeetingTitle}
              placeholder={m.meetings_field_title_ph()}
              className="w-full text-lg font-bold"
            />
          </div>

          <div>
            <label for="edit-meeting-date" class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">{m.meetings_field_start_label()}</label>
            <FormInput 
              id="edit-meeting-date"
              type="datetime-local"
              bind:value={editMeetingDate}
              className="w-full"
            />
          </div>

          <div>
            <label for="edit-meeting-end-date" class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">{m.meetings_field_end_label()}</label>
            <FormInput 
              id="edit-meeting-end-date"
              type="datetime-local"
              bind:value={editMeetingEndDate}
              className="w-full"
            />
            {#if timezoneStore.loaded}
              <div class="mt-1.5">
                <TimezoneHint bind:value={editMeetingTimezone} />
              </div>
            {/if}
          </div>

          <div>
            <DiscordMarkdownEditor
              id="edit-meeting-desc"
              bind:value={editMeetingDesc}
              label={m.meetings_field_agenda_label()}
              placeholder={m.meetings_field_agenda_ph()}
              rows={10}
              agendaMode={true}
              disabled={savingMeetingEdit}
            />
          </div>

          {#if editMeetingError}
            <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mt-3">
              <p class="text-sm text-red-700">{editMeetingError}</p>
            </div>
          {/if}

          <div class="flex items-center justify-end gap-4 pt-4 mt-6 border-t border-outline-variant/30">
            <button onclick={() => meetingEditModalOpen = false} class="px-6 py-2.5 font-bold text-on-surface-variant hover:bg-surface-hover rounded-xl transition-colors">
              {m.common_cancel()}
            </button>
            <button 
              onclick={saveMeetingEdit}
              disabled={savingMeetingEdit || !editMeetingTitle || !editMeetingDate}
              class="px-8 py-2.5 bg-primary text-white rounded-xl font-semibold shadow-sm hover:shadow-primary/40 disabled:opacity-50 disabled:grayscale transition-all flex items-center gap-2"
            >
              {#if savingMeetingEdit}
                <div class="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
              {/if}
              {m.common_save()}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

</ModulePage>

<style>
  .custom-scrollbar::-webkit-scrollbar {
    width: 4px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.06);
    border-radius: 10px;
  }
</style>
