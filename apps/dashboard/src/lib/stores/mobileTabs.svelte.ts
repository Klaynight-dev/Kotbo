import type { PageConfig } from '../config/pages';
import { onNavigationStorageCleared } from './navigationStorage';

/**
 * Which shortcuts the phone tab bar shows.
 *
 * The bar is a phone-only surface, so the choice lives on the device rather
 * than on the account: there is nothing to reconcile with the desktop sidebar,
 * and a user who switches phones gets the sensible default again.
 */

const STORAGE_KEY = 'mobile_tabbar';

/** The bar holds four shortcuts plus the permanent "More" button. */
export const TAB_SLOTS = 4;

/**
 * Destinations competing for the four slots when the user has not chosen,
 * best first. Whatever the current permissions do not grant is skipped.
 */
export const DEFAULT_TAB_ORDER = [
  '/',
  '/inbox',
  '/members',
  '/tickets',
  '/security/sanctions',
  '/analytics',
];

function sanitize(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return [
    ...new Set(
      entries
        .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].slice(0, TAB_SLOTS);
}

function readStored(): string[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = sanitize(JSON.parse(raw));
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

class MobileTabsStore {
  #chosen = $state<string[] | null>(readStored());

  /** True once the user has picked their own shortcuts. */
  get isCustomized(): boolean {
    return this.#chosen !== null;
  }

  /**
   * The shortcuts to render, resolved against the pages this user may actually
   * reach. A stored page that a guild does not expose is dropped rather than
   * leaving a dead tab; if nothing survives we fall back to the defaults so the
   * bar never collapses to the "More" button alone.
   */
  resolve(available: PageConfig[]): PageConfig[] {
    const byHref = new Map(available.map((item) => [item.href, item]));

    if (this.#chosen) {
      const picked = this.#chosen
        .map((href) => byHref.get(href))
        .filter((item): item is PageConfig => !!item);
      if (picked.length > 0) return picked.slice(0, TAB_SLOTS);
    }

    const preferred = DEFAULT_TAB_ORDER.map((href) => byHref.get(href)).filter(
      (item): item is PageConfig => !!item,
    );
    const extras = available.filter((item) => !DEFAULT_TAB_ORDER.includes(item.href));
    return [...preferred, ...extras].slice(0, TAB_SLOTS);
  }

  set(hrefs: string[]): void {
    const next = sanitize(hrefs);
    if (next.length === 0) return;
    this.#chosen = next;
    this.#persist(next);
  }

  reset(): void {
    this.#chosen = null;
    try {
      localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: the reset still applies for this session */
    }
  }

  #persist(next: string[]): void {
    try {
      localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable (private mode, quota): choice stays in memory */
    }
  }
}

export const mobileTabs = new MobileTabsStore();

// Les raccourcis de la barre mobile sont des chemins choisis par un compte,
// stockes sous une cle globale : sans cette purge ils passaient au compte
// suivant sur le meme navigateur, revelant au passage les pages auxquelles le
// precedent avait acces.
onNavigationStorageCleared(() => mobileTabs.reset());
