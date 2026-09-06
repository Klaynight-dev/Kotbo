/**
 * Socle HTTP du dashboard : resolution de la guilde courante, appel
 * authentifie et gestion uniforme des erreurs.
 *
 * Les modules de domaine de ce dossier s appuient tous sur dashboardRequest
 * (reponse JSON, leve en cas d echec) ou dashboardMutation (booleen, ne leve
 * pas). L API publique est reexportee par ./index.ts.
 */
import { authStore } from '../stores/auth.svelte';
import { toast } from '../stores/toast.svelte';

const envApiUrl = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/$/, '');

function getBrowserOrigin() {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return '';
}

export const API_BASE_URL = envApiUrl;
const wsBaseUrl = API_BASE_URL
  ? API_BASE_URL.replace(/^http/i, 'ws')
  : getBrowserOrigin().replace(/^http/i, 'ws');
export const DASHBOARD_WS_URL = `${wsBaseUrl}/api/dashboard/ws`;
export const BASE_URL = `${API_BASE_URL}/api/dashboard`;
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function authorizedFetch(url: string, options: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const token = authStore.token;
  if (!token) {
    throw new Error('No auth token available');
  }

  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  };

  const response = await fetch(url, { ...options, headers, credentials: 'include' });

  if (response.status === 401) {
    authStore.logout();
    throw new Error('Session expired');
  }

  return response;
}

export function getGuildId(guildId?: string) {
  if (guildId) {
    return guildId;
  }

  const requestedGuildId = authStore.selectedGuildId;
  if (!requestedGuildId) return null;

  if (authStore.guilds.length === 0) {
    return requestedGuildId;
  }

  const accessibleGuild = authStore.guilds.find((guild) => guild.id === requestedGuildId);
  if (accessibleGuild) {
    return requestedGuildId;
  }

  return authStore.guilds[0]?.id ?? null;
}

/**
 * Un module eteint n'est pas une panne : l'API ferme ses routes avec un 403
 * `module_disabled`, y compris en lecture. Ces refus sont attendus et deja
 * racontes a l'ecran par ModuleDisabledNotice ; les remonter en toast faisait
 * apparaitre « Le module X est desactive sur ce serveur » sur toutes les pages,
 * parce qu'un appel de fond (la progression d'apprenti du store global) part a
 * chaque chargement. L'erreur continue d'etre levee : l'appelant garde la main.
 */
function isModuleDisabledError(error: unknown): boolean {
  const data = (error as any)?.data;
  return (error as any)?.status === 403 && data?.code === 'module_disabled';
}

export async function dashboardMutation(path: string, options: {
  method?: string;
  payload?: any;
  guildId?: string;
  errorContext?: string;
  silent?: boolean;
} = {}): Promise<boolean> {
  const selectedGuildId = getGuildId(options.guildId);
  if (!selectedGuildId) return false;

  const method = options.method || 'PUT';
  const errorContext = options.errorContext || 'API Error';
  const hasPayload = options.payload !== undefined;

  try {
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}${path}`, {
      method,
      headers: hasPayload ? JSON_HEADERS : undefined,
      body: hasPayload ? JSON.stringify(options.payload) : undefined
    });

    if (response.ok) {
      if (method !== 'GET' && !options.silent) {
        toast.success('Opération réussie');
      }
    } else {
      let message = "Erreur lors de l'opération";
      try {
        const data = await response.json();
        message = data.error || data.message || message;
      } catch { }
      toast.error(message);
    }

    return response.ok;
  } catch (error) {
    console.error(errorContext, error);
    toast.error('Erreur réseau ou serveur');
    return false;
  }
}

export async function dashboardRequest(path: string, options: {
  method?: string;
  payload?: any;
  guildId?: string;
  errorContext?: string;
  silent?: boolean;
} = {}): Promise<any> {
  const selectedGuildId = getGuildId(options.guildId);
  if (!selectedGuildId) return null;

  const method = options.method || 'GET';
  const errorContext = options.errorContext || 'API Error';
  const hasPayload = options.payload !== undefined;

  try {
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}${path}`, {
      method,
      headers: hasPayload ? JSON_HEADERS : undefined,
      body: hasPayload ? JSON.stringify(options.payload) : undefined
    });

    if (!response.ok) {
      let message = `Server error: ${response.status}`;
      let body: any = null;
      try {
        body = await response.json();
        if (body && typeof body.error === 'string' && body.error.trim()) {
          message = body.error.trim();
        } else if (body && typeof body.message === 'string' && body.message.trim()) {
          message = body.message.trim();
        }
      } catch {
        // ignore JSON parsing errors and keep fallback message
      }
      const error = new Error(message);
      (error as any).status = response.status;
      // Une reponse d'echec peut porter autre chose qu'un message : une
      // operation interrompue a mi-chemin rend ce qu'elle avait deja fait, et
      // l'appelant doit pouvoir le lire.
      (error as any).data = body;
      throw error;
    }

    if (method !== 'GET' && response.ok && !options.silent) {
      toast.success('Opération réussie');
    }

    return await response.json();
  } catch (error) {
    if (!options.silent && !isModuleDisabledError(error)) {
      console.error(errorContext, error);
      toast.error((error as any).message || 'Erreur réseau ou serveur');
    }
    throw error;
  }
}
