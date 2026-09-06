/** Invitations et suivi des inviteurs. */
import { authStore } from '../stores/auth.svelte';
import { timezoneStore } from '../stores/timezone.svelte';
import { dashboardRequest } from './client';

export async function fetchInvitations(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/invitations', { guildId });
}

export async function fetchInvitationDetails(code: string, options: { days?: number } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  // La repartition horaire des arrivees se lit a l'heure murale du lecteur,
  // pas en UTC ou elle est stockee.
  params.append('tz', timezoneStore.displayTimezone);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return dashboardRequest(`/invitations/${code}${suffix}`, { guildId });
}

export async function toggleInvitationSuspension(code: string, suspended: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/invitations/${code}/suspend`, {
    method: 'PUT',
    payload: { suspended },
    guildId,
    errorContext: 'Error toggling invite suspension'
  });
}

export async function updateInvitationSource(code: string, sourceLabel: string | null, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/invitations/${code}/source`, {
    method: 'PUT',
    payload: { sourceLabel },
    guildId,
    errorContext: 'Error updating invitation source'
  });
}

export async function deleteInvitation(code: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/invitations/${code}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'Error deleting invitation'
  });
}

export async function purgeInvitationMembers(code: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/invitations/${code}/purge`, {
    method: 'POST',
    guildId,
    errorContext: 'Error purging invitation members'
  });
}

export async function suspendInviter(
  userId: string,
  userTag: string,
  reason: string,
  options: { cascade?: boolean } = {},
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/invitations/suspended-inviters', {
    method: 'POST',
    payload: { userId, userTag, reason, cascade: options.cascade ?? false },
    guildId,
    errorContext: 'Error suspending inviter'
  });
}

export async function removeSuspendedInviter(userId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/invitations/suspended-inviters/${userId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'Error removing suspended inviter'
  });
}

export async function purgeInviterMembers(userId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/invitations/inviters/${userId}/purge`, {
    method: 'POST',
    guildId,
    errorContext: 'Error purging inviter members'
  });
}
