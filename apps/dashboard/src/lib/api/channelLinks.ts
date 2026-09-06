/** Liens de salons et serveurs staff. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

// ============================================================================
// CHANNEL LINKS API
// ============================================================================

export async function fetchChannelLinks(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channel-links', { method: 'GET', guildId, errorContext: 'API Error (Channel Links):' });
}

export async function fetchChannelLinkInvites(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channel-links/invites', { method: 'GET', guildId, errorContext: 'API Error (Link Invites):' });
}

export async function createChannelLinkInvite(data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channel-links/invites', { method: 'POST', payload: data, guildId, errorContext: 'API Error (Create Invite):' });
}

export async function updateChannelLink(linkId: string, data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channel-links/${linkId}`, { method: 'PATCH', payload: data, guildId, errorContext: 'API Error (Update Link):' });
}

export async function addChannelLinkMember(groupId: string, data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channel-links/${groupId}/members`, { method: 'POST', payload: data, guildId, errorContext: 'API Error (Add Link Member):' });
}

export async function updateChannelLinkMember(groupId: string, memberId: string, data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channel-links/${groupId}/members/${memberId}`, { method: 'PATCH', payload: data, guildId, errorContext: 'API Error (Update Link Member):' });
}

export async function removeChannelLinkMember(groupId: string, memberId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/channel-links/${groupId}/members/${memberId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Remove Link Member):' });
}

export async function deleteChannelLink(linkId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/channel-links/${linkId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Link):' });
}

export async function fetchChannelLinkOtherGuilds(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channel-links/other-guilds', { method: 'GET', guildId, errorContext: 'API Error (Other Guilds):' });
}

export async function generateChannelLinkInvite(linkId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channel-links/${linkId}/invite`, { method: 'POST', guildId, errorContext: 'API Error (Generate Invite):' });
}

export async function createDirectChannelLink(data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channel-links/direct', { method: 'POST', payload: data, guildId, errorContext: 'API Error (Direct Link):' });
}

// ============================================================================
// STAFF SERVER LINKS API
// ============================================================================

export async function fetchStaffServerLinks(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff-server', { method: 'GET', guildId, errorContext: 'API Error (Staff Server):' });
}

export async function fetchStaffServerChannels(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff-server/channels', { method: 'GET', guildId, errorContext: 'API Error (Staff Server Channels):' });
}

export async function createStaffServerLink(data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff-server', { method: 'POST', payload: data, guildId, errorContext: 'API Error (Create Staff Link):' });
}

export async function updateStaffServerLink(linkId: string, data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff-server/${linkId}`, { method: 'PATCH', payload: data, guildId, errorContext: 'API Error (Update Staff Link):' });
}

export async function deleteStaffServerLink(linkId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff-server/${linkId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Staff Link):' });
}

export async function addStaffServerRoleMapping(linkId: string, data: Record<string, any>, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff-server/${linkId}/mappings`, { method: 'POST', payload: data, guildId, errorContext: 'API Error (Add Mapping):' });
}

export async function deleteStaffServerRoleMapping(linkId: string, mappingId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff-server/${linkId}/mappings/${mappingId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Mapping):' });
}

export async function syncStaffServerRoles(linkId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff-server/${linkId}/sync`, { method: 'POST', guildId, errorContext: 'API Error (Sync Roles):' });
}
