/** Staff : effectif, roles, absences, reunions, taches. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

// ==========================================
// STAFF LEADERSHIP / HR APIs
// ==========================================

export async function fetchStaffMetrics(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/leadership', { method: 'GET', guildId });
}

export async function fetchStaffMembers(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/members', { method: 'GET', guildId });
}

export async function fetchStaffWarnings(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/warnings', { method: 'GET', guildId });
}

export async function fetchStaffRoles(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/roles', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Staff Roles):'
  });
}

export async function deleteStaffRole(roleId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/roles/${roleId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Staff Role):'
  });
}

export async function updateStaffRole(roleId, data, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/roles/${roleId}`, {
    method: 'PATCH',
    payload: data,
    guildId,
    errorContext: 'API Error (Update Staff Role):'
  });
}

export async function fetchStaffConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/config', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Staff Config):'
  });
}

export async function updateStaffConfig(config, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/staff/config', {
    method: 'PATCH',
    payload: config,
    guildId,
    errorContext: 'API Error (Update Staff Config):'
  });
}

export async function fetchDiscordChannels(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels', {
    method: 'GET',
    guildId,
    silent: true,
    errorContext: 'API Error (Fetch Discord Channels):'
  });
}

export async function fetchAbsences(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/absences', { method: 'GET', guildId });
}

export async function fetchStaffCalendarData(start: Date, end: Date, staffIds?: string[], guildId = authStore.selectedGuildId) {
  let path = `/absences/calendar-data?start=${start.toISOString()}&end=${end.toISOString()}`;
  if (staffIds && staffIds.length > 0) {
    path += `&staffIds=${staffIds.join(',')}`;
  }
  return dashboardRequest(path, { method: 'GET', guildId });
}

export async function fetchAbsenceConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/absences/config', { method: 'GET', guildId });
}

export async function updateAbsenceConfig(
  config: {
    managerRoleLevels: number[];
    webhookUrl?: string | null;
    channelId?: string | null;
    notificationRoleId?: string | null;
    notifyViaDiscordChannel?: boolean;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/absences/config', { method: 'POST', payload: config, guildId });
}

export async function updateAbsenceStatus(absenceId, status, note, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/absences/${absenceId}`, { method: 'PATCH', payload: { status, note }, guildId });
}

export async function deleteAbsence(absenceId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/absences/${absenceId}`, { method: 'DELETE', guildId });
}

export async function fetchMeetings(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/meetings', { method: 'GET', guildId });
}

export async function createMeeting(
  title: string,
  description: string,
  scheduledAt: string,
  endedAt?: string,
  timezone?: string | null,
  guildId = authStore.selectedGuildId,
) {
  return dashboardMutation('/meetings', { method: 'POST', payload: { title, description, scheduledAt, endedAt, timezone }, guildId });
}

export async function deleteMeeting(meetingId, options = { deleteEvent: true, deleteMessage: false, deleteNotifications: false }, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.deleteEvent) params.append('deleteEvent', 'true');
  if (options.deleteMessage) params.append('deleteMessage', 'true');
  if (options.deleteNotifications) params.append('deleteNotifications', 'true');

  const queryString = params.toString();
  const path = `/meetings/${meetingId}${queryString ? '?' + queryString : ''}`;

  return dashboardMutation(path, { method: 'DELETE', guildId });
}

export async function updateMeeting(meetingId, data, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/meetings/${meetingId}`, { method: 'PATCH', payload: data, guildId });
}

export async function createAbsence(data: {
  staffUserId?: string;
  type: string;
  startDate: string | Date;
  endDate?: string | Date | null;
  reason: string;
  superiorUserId: string;
  message?: string;
  confirmIndefinite?: boolean;
  isIndefinite?: boolean;
}, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/absences', { method: 'POST', payload: data, guildId });
}

export async function fetchCalls(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/calls', { method: 'GET', guildId });
}

export async function createCall(payload: { title: string; description?: string | null; scheduledAt: string; channelMode: string; channelType?: string | null; discordChannelId?: string | null; isTempChannel?: boolean; inviteeUserIds?: string[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/calls', { method: 'POST', payload, guildId });
}

export async function updateCall(callId: string, payload: { title?: string; description?: string | null; scheduledAt?: string; endedAt?: string; status?: string; invitees?: string[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/calls/${callId}`, { method: 'PATCH', payload, guildId });
}

export async function deleteCall(callId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/calls/${callId}`, { method: 'DELETE', guildId });
}

export async function fetchCallPermissionConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/calls/config', { method: 'GET', guildId, silent: true });
}

export async function updateCallPermissionConfig(
  payload: { mode: 'EVERYONE' | 'RESTRICTED'; allowedRoleIds: string[]; allowedUserIds: string[] },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/calls/config', { method: 'POST', payload, guildId });
}

export async function fetchTasks(assigneeId?: string, guildId = authStore.selectedGuildId) {
  const path = assigneeId ? `/tasks?assigneeId=${assigneeId}` : '/tasks';
  return dashboardRequest(path, { method: 'GET', guildId });
}

export async function createTask(payload: { title: string; description?: string | null; priority: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: string | null; assigneeId: string }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/tasks', { method: 'POST', payload, guildId });
}

export async function updateTask(taskId: string, payload: { title?: string; description?: string | null; status?: string; priority?: string; dueDate?: string | null; assigneeId?: string }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/tasks/${taskId}`, { method: 'PATCH', payload, guildId });
}

export async function deleteTask(taskId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/tasks/${taskId}`, { method: 'DELETE', guildId });
}

export async function fetchReminders(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/reminders', { method: 'GET', guildId });
}

export async function createReminder(payload: {
  message: string;
  targetTime: string;
  channelId?: string | null;
  taskId?: string | null;
  callId?: string | null;
  meetingId?: string | null;
}, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/reminders', { method: 'POST', payload, guildId });
}

export async function deleteReminder(reminderId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/reminders/${reminderId}`, { method: 'DELETE', guildId });
}

export async function fetchPolls(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/polls', { method: 'GET', guildId });
}

export async function createPoll(title, description, options, closesAt, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/staff/polls', { method: 'POST', payload: { title, description, options, closesAt }, guildId });
}

export async function fetchProcedures(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/procedures', { method: 'GET', guildId });
}

export async function upsertProcedure(procedureId, title, content, sortOrder, guildId = authStore.selectedGuildId) {
  if (procedureId) {
    return dashboardMutation(`/procedures/${procedureId}`, { method: 'PATCH', payload: { title, content, sortOrder }, guildId });
  }
  return dashboardMutation('/procedures', { method: 'POST', payload: { title, content, sortOrder }, guildId });
}

export async function deleteProcedure(procedureId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/procedures/${procedureId}`, { method: 'DELETE', guildId });
}

export async function markProcedureRead(procedureId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/procedures/read`, { method: 'POST', payload: { procedureId }, guildId });
}


export async function fetchManagerNotes(staffUserId, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff/${staffUserId}/notes`, { method: 'GET', guildId });
}

export async function addManagerNote(staffUserId, content, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/${staffUserId}/notes`, { method: 'POST', payload: { content }, guildId });
}

export async function deleteManagerNote(staffUserId, noteId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/${staffUserId}/notes/${noteId}`, { method: 'DELETE', guildId });
}

export async function searchDiscordMembers(query: string, limit = 12, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (query) params.append('q', query);
  params.append('limit', String(limit));
  return dashboardRequest(`/staff/discord-members?${params}`, { method: 'GET', guildId });
}

export async function toggleTutorStatus(userId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/members/${userId}/tutor`, { method: 'POST', guildId });
}
