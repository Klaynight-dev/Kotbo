/** Analytics et profils publics. */
import { authStore } from '../stores/auth.svelte';
import { timezoneStore } from '../stores/timezone.svelte';
import { API_BASE_URL, JSON_HEADERS, getGuildId, dashboardRequest } from './client';

/**
 * Fuseau de lecture joint a toute requete qui renvoie des creneaux horaires.
 *
 * Les agregats sont stockes en UTC : sans ce parametre, l'API repondait avec
 * des heures UTC et le dashboard affichait a minuit un pic reellement observe
 * a 14h. Le serveur retombe sur le fuseau du serveur Discord si le parametre
 * manque ou n'est pas un identifiant IANA connu.
 */
function appendViewTimezone(params: URLSearchParams) {
  params.append('tz', timezoneStore.displayTimezone);
  return params;
}

export async function fetchAnalytics(options: { period?: number, startDate?: string, endDate?: string, granularity?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.period) params.append('period', options.period.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);
  if (options.granularity) params.append('granularity', options.granularity);
  appendViewTimezone(params);

  return dashboardRequest(`/analytics?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Analytics):'
  });
}

export async function fetchInviteAnalytics(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/analytics/invites', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Invite Analytics):'
  });
}

export async function fetchChannelDetails(channelId: string, options: { days?: number } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  appendViewTimezone(params);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return dashboardRequest(`/analytics/channels/${channelId}${suffix}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Channel Details):'
  });
}

export async function fetchMemberDetailedAnalytics(userId, period = 30, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/analytics/members?userId=${userId}&period=${period}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Member Detailed Analytics):'
  });
}

export async function fetchPublicProfile(userId: string) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authStore.token) {
    headers.Authorization = `Bearer ${authStore.token}`;
  }

  const response = await fetch(`${API_BASE_URL}/api/public/profile/${userId}`, { headers });
  if (!response.ok) {
    const error = new Error(`Server error: ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

export async function updatePublicProfile(userId: string, payload: { bio?: string | null; isProfilePrivate?: boolean }) {
  if (!authStore.token) {
    throw new Error('No auth token available');
  }

  const response = await fetch(`${API_BASE_URL}/api/public/profile/${userId}`, {
    method: 'PATCH',
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${authStore.token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = new Error(`Server error: ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

export async function fetchStaffProfile(userId: string, guildId = authStore.selectedGuildId) {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return null;

  if (!authStore.token) {
    throw new Error('No auth token available');
  }

  const response = await fetch(`${API_BASE_URL}/api/dashboard/users/${userId}/profile?guildId=${selectedGuildId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authStore.token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const error = new Error(`Server error: ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

export async function fetchHourlyHeatmap(options: { days?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);
  appendViewTimezone(params);

  return dashboardRequest(`/analytics/heatmap?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Hourly Heatmap):'
  });
}

export type AdvancedAnalyticsSection =
  | 'retention' | 'activity' | 'churn' | 'channels' | 'social' | 'words' | 'moderation';

export async function fetchAdvancedAnalytics(section: AdvancedAnalyticsSection, guildId = authStore.selectedGuildId) {
  const params = appendViewTimezone(new URLSearchParams({ section }));
  return dashboardRequest(`/analytics/advanced?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: `API Error (Advanced Analytics ${section}):`
  });
}

export async function fetchWeeklyComparison(options: { offset?: number, mode?: 'week' | 'month' } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.offset) params.append('offset', options.offset.toString());
  if (options.mode) params.append('mode', options.mode);
  return dashboardRequest(`/analytics/weekly-comparison?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Weekly Comparison):'
  });
}

export async function fetchGrowthAndRetention(options: { days?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);

  return dashboardRequest(`/analytics/growth-retention?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Growth & Retention):'
  });
}

export async function fetchDailyAlgoAnalytics(options: { days?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);

  return dashboardRequest(`/analytics/daily-algo?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Daily Algo Analytics):'
  });
}

export async function fetchGlobalInteractions(options: { period?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.period) params.append('period', options.period.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);

  return dashboardRequest(`/analytics/interactions?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Global Interactions Graph):'
  });
}
