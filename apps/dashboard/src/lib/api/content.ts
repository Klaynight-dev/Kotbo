/** News, journaux d evenements et suivis sociaux. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, dashboardMutation, dashboardRequest } from './client';

export async function fetchNews(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch News):'
  });
}

export async function fetchPublicNews(guildId: string) {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/news`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du chargement des actualités publiques');
  }

  return response.json();
}

/** Classement RP public : aucune authentification, le lien se partage. */
export async function fetchPublicRanked(guildId: string) {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/ranked`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du chargement du classement de prestige');
  }

  return response.json();
}

export async function fetchPublicLeveling(guildId: string) {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/leveling`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du chargement du classement de leveling');
  }

  return response.json();
}

export async function createNews(payload: { title: string; content: string; summary?: string; imageUrl?: string; category?: string; subcategory?: string; published?: boolean; publishMode?: 'summary' | 'full_embed' }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Create News):'
  });
}

export async function updateNews(articleId: string, payload: { title?: string; content?: string; summary?: string; imageUrl?: string; category?: string; subcategory?: string; published?: boolean; publishMode?: 'summary' | 'full_embed' }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/news/${articleId}`, {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update News):'
  });
}

export async function deleteNews(articleId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/news/${articleId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete News):'
  });
}

export async function fetchNewsCategoryConfigs(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news/category-configs', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch News Category Configs):'
  });
}

export async function createNewsCategoryConfig(payload: { category: string; subcategory?: string; channelId: string }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news/category-configs', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Create News Category Config):'
  });
}

export async function deleteNewsCategoryConfig(configId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/news/category-configs/${configId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete News Category Config):'
  });
}

export async function fetchLogEventConfigs(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/logs/event-configs', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Log Event Configs):'
  });
}

export async function updateLogEventConfigs(configs: Array<{ eventType: string; enabled: boolean; channelId: string | null }>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/logs/event-configs', {
    method: 'PUT',
    payload: { configs },
    guildId,
    errorContext: 'API Error (Update Log Event Configs):'
  });
}

export async function fetchSocialFollows(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/social-follows', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Social Follows):'
  });
}

export async function addYoutubeFollow(payload: { query?: string; channelId?: string; discordChannelId?: string | null; mention?: string | null; liveMessage?: string | null; videoMessage?: string | null; shortMessage?: string | null }, guildId = authStore.selectedGuildId) {
  // Mise à jour d'un suivi existant : le channelId sert de requête de résolution.
  const body = {
    query: payload.query || payload.channelId || '',
    discordChannelId: payload.discordChannelId,
    mention: payload.mention,
    liveMessage: payload.liveMessage,
    videoMessage: payload.videoMessage,
    shortMessage: payload.shortMessage
  };
  return dashboardRequest('/social-follows/youtube', {
    method: 'POST',
    payload: body,
    guildId,
    errorContext: 'API Error (Add Youtube Follow):'
  });
}

export async function deleteYoutubeFollow(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/social-follows/youtube/${id}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Youtube Follow):'
  });
}

export async function addTwitchFollow(payload: { streamerName: string; discordChannelId?: string | null; mention?: string | null; liveMessage?: string | null }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/social-follows/twitch', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Add Twitch Follow):'
  });
}

export async function deleteTwitchFollow(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/social-follows/twitch/${id}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Twitch Follow):'
  });
}

/**
 * Starlight : la configuration vit dans sa propre table, la reponse porte donc
 * toujours un objet `config` complet - valeurs par defaut du schema comprises
 * tant que le serveur n'a jamais enregistre.
 */
export interface StarboardConfigPayload {
  enabled: boolean;
  channelId: string | null;
  upvoteEmojis: string[];
  downvoteEmojis: string[];
  threshold: number;
  countEmbedReactions: boolean;
  autoReactEmbed: boolean;
  autoReactChannels: string[];
  watchedChannels: string[];
  ignoredChannels: string[];
  allowBots: boolean;
  embedColor: string;
  removeBelowThreshold: boolean;
}

export async function fetchStarboardConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/starboard', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Starboard Config):',
    silent: true,
  });
}

export async function updateStarboardConfig(
  payload: Partial<StarboardConfigPayload>,
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/starboard', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Starboard Config):',
    silent: true,
  });
}

// ── Campagnes marketing ─────────────────────────────────────────────────────

export async function fetchCampaigns(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/campaigns', {
    method: 'GET', guildId, silent: true,
    errorContext: 'API Error (Campaigns):'
  });
}

export async function createCampaign(payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/campaigns', {
    method: 'POST', payload, guildId, silent: true,
    errorContext: 'API Error (Create Campaign):'
  });
}

export async function updateCampaign(id: string, payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}`, {
    method: 'PATCH', payload, guildId, silent: true,
    errorContext: 'API Error (Update Campaign):'
  });
}

export async function deleteCampaign(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}`, {
    method: 'DELETE', guildId, silent: true,
    errorContext: 'API Error (Delete Campaign):'
  });
}

export async function setCampaignStatus(id: string, status: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}/status`, {
    method: 'POST', payload: { status }, guildId, silent: true,
    errorContext: 'API Error (Campaign Status):'
  });
}

export async function fetchCampaignReport(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}/report`, {
    method: 'GET', guildId, silent: true,
    errorContext: 'API Error (Campaign Report):'
  });
}

export async function previewCampaignAudience(payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/campaigns/audience-preview', {
    method: 'POST', payload, guildId, silent: true,
    errorContext: 'API Error (Campaign Audience):'
  });
}
