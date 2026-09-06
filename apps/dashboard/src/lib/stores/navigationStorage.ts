/**
 * Miroir local des favoris et des pages recemment visitees.
 *
 * Ce module ne depend d'aucun autre store : `authStore` doit pouvoir purger ce
 * stockage a la fermeture de session sans creer de cycle d'import avec
 * `navigation.svelte.ts`, qui lui lit `authStore`.
 */
export const FAVORITES_KEY = 'sidebar_favorites';
export const RECENTS_KEY = 'nav_recents';

export function readStoredHrefs(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function writeStoredHrefs(key: string, value: string[]): void {
  try {
    localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode, quota): favourites stay in memory */
  }
}

const clearListeners = new Set<() => void>();

/**
 * Permet au store de navigation de vider aussi son etat en memoire, sans que
 * `authStore` ait a l'importer - l'import inverse existe deja.
 */
export function onNavigationStorageCleared(listener: () => void): void {
  clearListeners.add(listener);
}

/**
 * Favoris et recents n'appartiennent qu'a la session qui les a constitues.
 * Sans cette purge ils survivaient a la deconnexion : le compte suivant sur le
 * meme navigateur heritait des raccourcis et de l'historique de navigation du
 * precedent - la meme fuite que celle deja corrigee pour `kotbo_guild_id`.
 *
 * Purger le seul `localStorage` n'aurait pas suffi : le store est un singleton
 * construit une fois pour toute la page, ses listes restent en memoire d'une
 * session a l'autre tant qu'on ne les vide pas explicitement.
 */
export function clearNavigationStorage(): void {
  try {
    localStorage?.removeItem(FAVORITES_KEY);
    localStorage?.removeItem(RECENTS_KEY);
  } catch {
    /* storage unavailable: rien a purger */
  }
  for (const listener of clearListeners) listener();
}
