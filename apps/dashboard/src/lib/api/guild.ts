/** Etat de la guilde, modules, presets et reglages globaux. */
import { authStore } from '../stores/auth.svelte';
import { toast } from '../stores/toast.svelte';
import { BASE_URL, JSON_HEADERS, authorizedFetch, getGuildId, dashboardMutation, dashboardRequest } from './client';

/**
 * Clot le parcours de configuration cote serveur.
 *
 * Le seul endroit ou le parcours se termine sans paiement, et c'est le bot qui
 * en juge : instance sans facturation, ou serveur dont l'acces a deja ete
 * accorde. Rien n'est garde dans le navigateur - un drapeau local reviendrait
 * a laisser n'importe quel visiteur sauter le parcours d'un serveur qui ne l'a
 * jamais traverse.
 */
export async function completeOnboarding(guildId = authStore.selectedGuildId ?? undefined): Promise<boolean> {
  const result = await dashboardRequest('/onboarding/complete', {
    method: 'POST',
    guildId,
    silent: true,
    errorContext: 'API Error (Onboarding):',
  });
  return result?.ok === true;
}

/**
 * Ou le parcours de configuration en etait, cote serveur.
 *
 * Le navigateur garde la meme chose et repond sans attendre : ceci ne sert
 * qu'a reprendre sur un autre appareil. Un echec n'est donc pas une erreur a
 * montrer - on repart de ce que le navigateur porte.
 */
export async function fetchOnboardingState(
  guildId = authStore.selectedGuildId ?? undefined,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await dashboardRequest('/onboarding/state', {
      guildId,
      silent: true,
      errorContext: 'API Error (Onboarding state):',
    });
    const state = result?.state;
    return state && typeof state === 'object' && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;
  } catch {
    // Migration pas encore passee, reseau coupe : le navigateur fait foi.
    return null;
  }
}

/** Double la memoire du navigateur. `null` efface le parcours enregistre. */
export async function saveOnboardingState(
  state: Record<string, unknown> | null,
  guildId = authStore.selectedGuildId ?? undefined,
): Promise<boolean> {
  try {
    const result = await dashboardRequest('/onboarding/state', {
      method: 'PUT',
      payload: { state },
      guildId,
      silent: true,
      errorContext: 'API Error (Onboarding state):',
    });
    return result?.ok === true;
  } catch {
    // La sauvegarde distante est un confort : le parcours continue sans elle.
    return false;
  }
}

export async function fetchGuildState(
  guildId = authStore.selectedGuildId,
  options: { overview?: boolean } = {},
) {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) {
    console.warn('API: Attempted to fetch guild state without a selected guild.');
    return null;
  }

  try {
    const suffix = options.overview ? '?scope=overview' : '';
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}${suffix}`);
    if (!response.ok) {
      const error = new Error(`Server error: ${response.status}`);
      (error as any).status = response.status;
      try {
        const body = await response.clone().json();
        if (body?.needsActivation) {
          (error as any).needsActivation = true;
        }
        if (body?.hint) {
          (error as any).hint = body.hint;
          console.error('API hint:', body.hint);
        }
      } catch { }
      throw error;
    }
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

export interface GuildLanguageState {
  /** `manual` = choix explicite d'un admin, `auto` = detection depuis Discord. */
  mode: 'manual' | 'auto';
  /** Langue effectivement appliquee apres la cascade. */
  locale: 'fr' | 'en';
  /** Langue declaree du serveur Discord, `null` si inexploitable. */
  detected: 'fr' | 'en' | null;
  available: Array<'fr' | 'en'>;
  /**
   * Compte-rendu du re-rendu des panneaux persistants (reglement, tickets,
   * roles-reaction), `null` si la langue effective n'a pas change.
   */
  rerender: { updated: number; skipped: number; failed: number } | null;
}

export async function fetchGuildLanguage(guildId = authStore.selectedGuildId): Promise<GuildLanguageState | null> {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return null;

  try {
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}/language`);
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('API Error (Guild language):', error);
    return null;
  }
}

/**
 * Passe `language: null` (ou `mode: 'auto'`) pour repasser en detection auto.
 *
 * La reponse porte deja le nouvel etat : pas besoin d'un GET de suivi.
 */
export async function updateGuildLanguage(
  payload: { mode: 'auto' } | { language: 'fr' | 'en' },
  guildId = authStore.selectedGuildId,
  /** Muet quand l'ecriture vient du parcours : l'ecran suivant fait la confirmation. */
  options: { silent?: boolean } = {},
): Promise<GuildLanguageState | null> {
  return dashboardRequest('/language', {
    method: 'PATCH',
    payload,
    guildId,
    silent: options.silent,
    errorContext: 'API Error (Guild language):',
  });
}

export interface GuildTimezoneState {
  /** Identifiant IANA en vigueur sur le serveur. */
  timezone: string;
  /** Valeur appliquee aux serveurs qui n'ont jamais choisi. */
  default: string;
  /** Fuseaux connus du runtime du bot, tries. */
  available: string[];
}

export async function fetchGuildTimezone(guildId = authStore.selectedGuildId): Promise<GuildTimezoneState | null> {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return null;

  try {
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}/timezone`);
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('API Error (Guild timezone):', error);
    return null;
  }
}

export async function updateGuildTimezone(
  timezone: string,
  guildId = authStore.selectedGuildId,
  options: { silent?: boolean } = {},
): Promise<GuildTimezoneState | null> {
  return dashboardRequest('/timezone', {
    method: 'PATCH',
    payload: { timezone },
    guildId,
    silent: options.silent,
    errorContext: 'API Error (Guild timezone):',
  });
}

/**
 * Muet : les quatre endroits qui basculent un module annoncent deja le
 * resultat avec le nom du module (bandeau ou bulle). Le « Operation reussie »
 * du socle venait s'y ajouter, soit deux notifications pour un seul clic.
 */
export async function updateModuleStatus(moduleId, status, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/modules/${moduleId}`, {
    method: 'PUT',
    payload: { status },
    guildId,
    silent: true
  });
}

export async function applyGuildPreset(presetKey, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/presets', {
    method: 'POST',
    payload: { presetKey },
    guildId,
    errorContext: 'API Error (Presets):'
  });
}



export async function translateText(text, targetLang = 'fr') {
  try {
    const response = await authorizedFetch(`${BASE_URL}/translate`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text, targetLang })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.translatedText;
  } catch (error) {
    console.error('API Error (Translation):', error);
    return null;
  }
}

export async function updateGlobalSettings(settings, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/settings', {
    method: 'PATCH',
    payload: settings,
    guildId,
    errorContext: 'API Error (Global Settings):'
  });
}

export async function updateSidebarFavorites(sidebarFavorites: string[], guildId = authStore.selectedGuildId) {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return false;

  try {
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}/settings`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sidebarFavorites })
    });

    if (!response.ok) {
      let message = 'Erreur lors de la sauvegarde des favoris';
      try {
        const data = await response.json();
        message = data.error || data.message || message;
      } catch {
        // Ignore JSON parsing errors.
      }
      toast.error(message);
      return false;
    }

    return true;
  } catch (error) {
    console.error('API Error (Sidebar Favorites):', error);
    toast.error('Erreur réseau ou serveur');
    return false;
  }
}

export async function updateNotificationsSettings(notifications, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/notifications', {
    method: 'PUT',
    payload: notifications,
    guildId,
    errorContext: 'API Error (Notifications):'
  });
}

export async function updateCommandAccessSettings(commandRestrictions, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/command-access', {
    method: 'PUT',
    payload: { commandRestrictions },
    guildId,
    errorContext: 'API Error (Command Access):'
  });
}

// ── Reprise de configuration ────────────────────────────────────────────────
// Detection des bots presents, lecture de ce qui est observable du serveur, et
// import d'un export tiers dont on ne devine pas le format.

export async function fetchMigrationPlan(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/migration', {
    method: 'GET',
    guildId,
    silent: true,
    errorContext: 'API Error (Migration Plan):'
  });
}

export async function applyMigrationPlan(keys: string[], guildId = authStore.selectedGuildId) {
  return dashboardRequest('/migration/apply', {
    method: 'POST',
    payload: { keys },
    guildId,
    silent: true,
    errorContext: 'API Error (Migration Apply):'
  });
}

export async function inspectMigrationExport(payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/migration/inspect', {
    method: 'POST',
    payload: { export: payload },
    guildId,
    silent: true,
    errorContext: 'API Error (Migration Inspect):'
  });
}

export async function assignMigrationValues(
  assignments: { setting: string; value: string }[],
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/migration/assign', {
    method: 'POST',
    payload: { assignments },
    guildId,
    silent: true,
    errorContext: 'API Error (Migration Assign):'
  });
}

/**
 * Parcours de configuration : ce qui est en place, ce qui manque, et ou aller.
 * Calcule cote serveur a partir de la configuration reelle, pas d'un compteur
 * d'etapes franchies.
 */
export async function fetchSetupJourney(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/setup', {
    method: 'GET',
    guildId,
    silent: true,
    errorContext: 'API Error (Setup Journey):'
  });
}

// ── Emojis personnalisés du serveur ─────────────────────────────────────────

export interface GuildEmoji {
  id: string;
  name: string;
  animated: boolean;
  available: boolean;
  /** Image du CDN Discord, en 64px : ce que le sélecteur affiche. */
  url: string;
  /** `<:nom:id>` — la forme que Discord rend dans un message. */
  mention: string;
}

export interface GuildEmojiSet {
  emojis: GuildEmoji[];
  slots: { total: number; staticUsed: number; animatedUsed: number };
  /** Faux si le bot n'a pas « Gérer les expressions », ou le lecteur pas les droits. */
  canUpload: boolean;
  created?: GuildEmoji;
}

/** Discord refuse tout ce qui dépasse : autant le dire avant l'envoi. */
export const GUILD_EMOJI_MAX_BYTES = 256 * 1024;
export const GUILD_EMOJI_ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export async function fetchGuildEmojis(guildId = authStore.selectedGuildId): Promise<GuildEmojiSet | null> {
  return dashboardRequest('/emojis', {
    guildId,
    silent: true,
    errorContext: 'API Error (Guild Emojis):',
  });
}

/**
 * Dépose une image et crée l'emoji sur le serveur Discord.
 *
 * Le nom est nettoyé ici parce que Discord n'accepte que `\w{2,32}` : laisser
 * partir un nom avec des espaces ne produirait qu'un aller-retour et un
 * message d'erreur, alors que la correction est évidente.
 */
export async function uploadGuildEmoji(
  file: File,
  name: string,
  guildId = authStore.selectedGuildId,
): Promise<GuildEmojiSet> {
  if (!GUILD_EMOJI_ACCEPTED.includes(file.type)) {
    throw new Error(`Format non supporté (${file.type || 'inconnu'}). Utilisez PNG, JPEG, GIF ou WEBP.`);
  }
  if (file.size > GUILD_EMOJI_MAX_BYTES) {
    throw new Error(`Image trop lourde : ${Math.round(GUILD_EMOJI_MAX_BYTES / 1024)} Ko maximum.`);
  }

  const cleaned = sanitizeEmojiName(name);
  if (cleaned.length < 2) {
    throw new Error('Nom trop court : 2 caractères minimum (lettres, chiffres, tirets bas).');
  }

  const result = await dashboardRequest('/emojis', {
    method: 'POST',
    payload: { name: cleaned, mimeType: file.type, data: await readFileAsBase64(file) },
    guildId,
    silent: true,
    errorContext: 'API Error (Guild Emoji Upload):',
  });
  if (!result) throw new Error("Erreur lors de la création de l'emoji");
  return result as GuildEmojiSet;
}

/** Ramène un nom de fichier ou une saisie libre à ce que Discord accepte. */
export function sanitizeEmojiName(raw: string): string {
  return raw
    // NFD puis retrait des marques : « Épée » devient « Epee » plutôt que
    // « _p_e », que le tiret bas de secours produirait sur les accents.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32);
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const separator = result.indexOf(',');
      resolve(separator >= 0 ? result.slice(separator + 1) : result);
    };
    reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
    reader.readAsDataURL(file);
  });
}
