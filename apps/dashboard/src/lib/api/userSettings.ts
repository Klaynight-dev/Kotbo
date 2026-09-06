/** Preferences utilisateur et presets de layout. */
import { authStore } from '../stores/auth.svelte';
import { BASE_URL, authorizedFetch, getGuildId, dashboardMutation, dashboardRequest } from './client';

// ============================================================================
// USER SETTINGS & LAYOUTS (BENTO / THEME)
// ============================================================================

const USER_SETTINGS_TTL_MS = 30_000;
const userSettingsCache = new Map<string, { data: any; fetchedAt: number }>();
const userSettingsInflight = new Map<string, Promise<any>>();

export async function fetchUserSettings(guildId = authStore.selectedGuildId) {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return null;

  const cached = userSettingsCache.get(selectedGuildId);
  if (cached && Date.now() - cached.fetchedAt < USER_SETTINGS_TTL_MS) {
    return cached.data;
  }

  const pending = userSettingsInflight.get(selectedGuildId);
  if (pending) return pending;

  const request = dashboardRequest('/user-settings', {
    method: 'GET',
    guildId: selectedGuildId,
    errorContext: 'API Error (Get User Settings):',
    silent: true
  }).then((data) => {
    userSettingsCache.set(selectedGuildId, { data, fetchedAt: Date.now() });
    userSettingsInflight.delete(selectedGuildId);
    return data;
  }).catch((error) => {
    userSettingsInflight.delete(selectedGuildId);
    throw error;
  });

  userSettingsInflight.set(selectedGuildId, request);
  return request;
}

export async function updateUserSettings(settings: {
  bentoLayout?: any;
  themeId?: string;
  customTheme?: any;
  accentColor?: string;
  sidebarBehavior?: string;
  compactMode?: boolean;
  /** `null` = suivre le fuseau du navigateur. */
  timezone?: string | null;
}, guildId = authStore.selectedGuildId) {
  const selectedGuildId = getGuildId(guildId);
  const result = await dashboardRequest('/user-settings', {
    method: 'PUT',
    payload: settings,
    guildId: selectedGuildId,
    errorContext: 'API Error (Update User Settings):',
    silent: true
  });

  if (selectedGuildId) {
    const previous = userSettingsCache.get(selectedGuildId)?.data ?? {};
    userSettingsCache.set(selectedGuildId, {
      data: { ...previous, ...settings, ...(result ?? {}) },
      fetchedAt: Date.now()
    });
  }

  return result;
}

// ============================================================================
// BENTO LAYOUT PRESETS
// ============================================================================

export interface LayoutPreset {
  id: string;
  name: string;
  description?: string;
  creatorId: string;
  guildId: string;
  layout: any[];
  isPublic: boolean;
  shareToken?: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchLayoutPresets(guildId = authStore.selectedGuildId): Promise<LayoutPreset[]> {
  const data = await dashboardRequest('/layout-presets', { method: 'GET', guildId, errorContext: 'API Error (Fetch Presets):', silent: true });
  return data?.presets || [];
}

export async function createLayoutPreset(preset: { name: string; description?: string; layout: any[]; isPublic?: boolean }, guildId = authStore.selectedGuildId): Promise<LayoutPreset | null> {
  const data = await dashboardRequest('/layout-presets', { method: 'POST', payload: preset, guildId, errorContext: 'API Error (Create Preset):' });
  return data?.preset || null;
}

export async function deleteLayoutPreset(presetId: string, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/layout-presets/${presetId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Preset):' });
}

export async function shareLayoutPreset(presetId: string, guildId = authStore.selectedGuildId): Promise<{ shareToken: string; shareUrl: string } | null> {
  const data = await dashboardRequest(`/layout-presets/${presetId}/share`, { method: 'POST', guildId, errorContext: 'API Error (Share Preset):' });
  return data || null;
}

export async function applyLayoutPreset(presetId: string, guildId = authStore.selectedGuildId): Promise<any | null> {
  const data = await dashboardRequest(`/layout-presets/${presetId}/apply`, { method: 'POST', guildId, errorContext: 'API Error (Apply Preset):' });
  return data?.layout || null;
}

export async function fetchSharedLayoutPreset(shareToken: string): Promise<LayoutPreset | null> {
  try {
    const response = await authorizedFetch(`${BASE_URL}/presets/shared/${shareToken}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.preset || null;
  } catch {
    return null;
  }
}

export async function importLayoutPreset(preset: { name: string; description?: string; layout: any[] }, guildId = authStore.selectedGuildId): Promise<LayoutPreset | null> {
  const data = await dashboardRequest('/layout-presets/import', { method: 'POST', payload: preset, guildId, errorContext: 'API Error (Import Preset):' });
  return data?.preset || null;
}
