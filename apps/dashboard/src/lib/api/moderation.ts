/** Moderation : pseudos, salons, mots bannis. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, JSON_HEADERS, authorizedFetch, dashboardMutation, dashboardRequest } from './client';

// ==========================================
// MODÉRATION DES PSEUDOS
// ==========================================
export async function fetchNicknameModerationConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/nickname-moderation', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Nickname Moderation Config):',
    silent: true,
  });
}

export async function updateNicknameModerationConfig(
  payload: {
    enabled?: boolean;
    whitelist?: string[];
    bypass?: string[];
    onJoin?: boolean;
    onUpdate?: boolean;
    checkInvisible?: boolean;
    checkGlobal?: boolean;
    checkCustom?: boolean;
    discordAutoModSync?: boolean;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardMutation('/nickname-moderation', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Nickname Moderation Config):'
  });
}

// ==========================================
// AUTO-THREAD & CHANNELS MANAGEMENT
// ==========================================
export async function fetchAutoThreadConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/auto-thread', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Auto Thread Config):',
    silent: true,
  });
}

export async function updateAutoThreadConfig(
  payload: { enabled: boolean; channels: string[]; botsEnabled?: boolean },
  guildId = authStore.selectedGuildId
) {
  return dashboardMutation('/auto-thread', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Auto Thread Config):'
  });
}

export async function fetchChannelsManagementConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Channels Management Config):',
    silent: true,
  });
}

// ── Vue « Par salon » ────────────────────────────────────────────────────────
// Les salons du serveur avec, pour chacun, les fonctionnalites qui y sont
// actives. Complete la vue par fonctionnalite, qui obligeait a parcourir cinq
// onglets pour savoir ce qui touchait un salon donne.

export async function fetchChannelsByChannel(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/by-channel', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Channels By Channel):',
    silent: true,
  });
}

export async function toggleChannelFeature(
  channelId: string,
  feature: string,
  enabled: boolean,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest(`/channels-management/by-channel/${channelId}`, {
    method: 'PATCH',
    payload: { feature, enabled },
    guildId,
    silent: true,
    errorContext: 'API Error (Toggle Channel Feature):',
  });
}

export async function renameDiscordChannel(
  channelId: string,
  name: string,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest(`/channels-management/channel/${channelId}`, {
    method: 'PATCH',
    payload: { name },
    guildId,
    silent: true,
    errorContext: 'API Error (Rename Channel):',
  });
}

export async function deleteDiscordChannel(channelId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/channel/${channelId}`, {
    method: 'DELETE',
    guildId,
    silent: true,
    errorContext: 'API Error (Delete Channel):',
  });
}

export async function updateChannelsManagementConfig(
  payload: {
    autoThreadEnabled?: boolean;
    autoThreadChannels?: string[];
    statsEnabled?: boolean;
    statsConfig?: any;
    tempVoiceEnabled?: boolean;
    tempVoiceChannelId?: string | null;
    tempVoiceCategoryId?: string | null;
    tempVoiceNameTemplate?: string;
    tempVoiceRequiredRoleId?: string | null;
    tempVoiceGenerators?: Array<{ channelId?: string; categoryId?: string; nameTemplate?: string; requiredRoleId?: string | null }>;
    honeypotEnabled?: boolean;
    honeypotChannelId?: string | null;
    honeypotSanction?: string;
    honeypotReinvite?: boolean;
    createHoneypotChannel?: boolean;
    verificationEnabled?: boolean;
    verificationMode?: string;
    verificationAction?: string;
    verificationChannelId?: string | null;
    verificationFallbackChannelId?: string | null;
    verificationRoleId?: string | null;
    verificationLogChannelId?: string | null;
    verificationEmbedTitle?: string;
    verificationEmbedDesc?: string;
    verificationEmbedColor?: string;
    verificationOnJoin?: boolean;
    verificationSaveIp?: boolean;
    verificationLevelCommand?: string;
    verificationLevelJoin?: string;
    verificationWarnThreshold?: number | null;
    verificationWarnAutoMode?: string;
    verificationWarnReason?: string;
    warnWeightingEnabled?: boolean;
    warnDecayDays?: number | null;
    countArchivedInWarnScore?: boolean;
    warnAutoArchiveDays?: number | null;
    wordStatsEnabled?: boolean;
    banHygieneEnabled?: boolean;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/channels-management', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Channels Management Config):'
  });
}

export async function fetchStickyMessages(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/sticky', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Sticky Messages):',
    silent: true,
  });
}

export async function saveStickyMessage(
  payload: {
    channelId: string;
    enabled?: boolean;
    content: string;
    embedEnabled?: boolean;
    embedTitle?: string | null;
    embedColor?: string;
    messageThreshold?: number;
    cooldownSeconds?: number;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/channels-management/sticky', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Save Sticky Message):',
    silent: true,
  });
}

export async function deleteStickyMessage(channelId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/sticky/${channelId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Sticky Message):',
    silent: true,
  });
}

export async function repostStickyMessage(channelId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/sticky/${channelId}/repost`, {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Repost Sticky Message):',
    silent: true,
  });
}

export async function rescanChannelsManagementStats(payload: { force: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/rescan-stats', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Rescan Stats):'
  });
}

export async function rescanMemberStats(payload: { force: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/analytics/rescan-members', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Rescan Members):'
  });
}

export async function fetchTempVoiceChannels(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/temp-voice/channels', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Temp Voice Channels):',
    silent: true
  });
}

export async function updateTempVoiceChannel(channelId: string, data: { name?: string; roleId?: string | null; action?: 'DELETE' }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/temp-voice/channels/${channelId}`, {
    method: 'PATCH',
    payload: data,
    guildId,
    errorContext: 'API Error (Update Temp Voice Channel):'
  });
}

// ==========================================
// MOTS BANNIS (service générique partagé)
// ==========================================

/** Retourne { global: BannedWord[], custom: BannedWord[] } */
export async function fetchBannedWords(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/banned-words', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Banned Words):',
    silent: true,
  });
}

/** Ajoute un mot personnalisé pour le serveur */
export async function addBannedWord(
  word: string,
  category = 'custom',
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/banned-words', {
    method: 'POST',
    payload: { word, category },
    guildId,
    errorContext: 'API Error (Add Banned Word):'
  });
}

/** Active ou désactive un mot personnalisé */
export async function toggleBannedWord(
  id: string,
  enabled: boolean,
  guildId = authStore.selectedGuildId
) {
  return dashboardMutation(`/banned-words/${id}`, {
    method: 'PATCH',
    payload: { enabled },
    guildId,
    errorContext: 'API Error (Toggle Banned Word):'
  });
}

/** Supprime un mot personnalisé */
export async function deleteBannedWord(id: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/banned-words/${id}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Banned Word):'
  });
}

// ==========================================
// MOTS BANNIS GLOBAUX (admin bot)
// ==========================================

export async function fetchGlobalBannedWords() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words`, { method: 'GET' });
  if (!response.ok) throw new Error('Erreur lors du chargement des mots globaux');
  return response.json();
}

export async function saveGlobalBannedWords(
  words: Array<{ word: string; category?: string; enabled?: boolean }>
) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ words })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de l'enregistrement des mots globaux");
  }

  return response.json();
}

export async function cleanupGlobalBannedWords() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words/cleanup`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du nettoyage des mots globaux');
  }

  return response.json();
}

export async function updateGlobalBannedWord(
  id: string,
  payload: { word?: string; category?: string; enabled?: boolean }
) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors de la mise à jour du mot global');
  }

  return response.json();
}

export async function toggleGlobalBannedWord(id: string, enabled: boolean) {
  return updateGlobalBannedWord(id, { enabled });
}

export async function deleteGlobalBannedWord(id: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Erreur lors de la suppression du mot global');
  return response.json();
}
