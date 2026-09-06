/**
 * Store for user-specific UI preferences.
 * All values are persisted to localStorage under the `kotbo_prefs` key.
 */

import { sidebarStore } from './sidebar.svelte';
import { themeStore, type ThemeId, type AccentColorId } from './theme.svelte';
import { applyLocale, getLocale } from '../i18n';

type Language = 'fr' | 'en';
type DateFormat = 'relative' | 'absolute' | 'both';
type SidebarBehavior = 'auto' | 'always-open' | 'always-closed';
/** `'auto'` = suivre le fuseau du navigateur ; sinon un identifiant IANA. */
type TimezonePreference = 'auto' | (string & Record<never, never>);

// Keep old type alias for backward compat in imports
type AccentColor = AccentColorId;

interface UserPrefs {
  theme: ThemeId;
  language: Language;
  sidebarBehavior: SidebarBehavior;
  compactMode: boolean;
  soundNotifications: boolean;
  desktopNotifications: boolean;
  dateFormat: DateFormat;
  accentColor: AccentColor;
  animationsEnabled: boolean;
  showOnlineStatus: boolean;
  /**
   * Fuseau de lecture des statistiques. Les agregats sont stockes en UTC :
   * sans ce reglage, un lecteur parisien voyait son pic de 14h annonce a midi.
   */
  timezone: TimezonePreference;
}

const DEFAULT_PREFS: UserPrefs = {
  theme: 'dark',
  language: 'fr',
  sidebarBehavior: 'auto',
  compactMode: false,
  soundNotifications: false,
  desktopNotifications: false,
  dateFormat: 'relative',
  accentColor: 'violet',
  animationsEnabled: true,
  showOnlineStatus: true,
  timezone: 'auto',
};

const STORAGE_KEY = 'kotbo_prefs';

function canUseDom() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function loadPrefs(): UserPrefs {
  try {
    if (!canUseDom()) {
      return { ...DEFAULT_PREFS };
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    }

    // Pas de préférence sauvegardée : on reprend la langue déjà résolue par
    // Paraglide (stratégie localStorage > langue du navigateur > 'fr') plutôt
    // que de forcer 'fr' pour un nouveau visiteur.
    return { ...DEFAULT_PREFS, language: getLocale() as Language };
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_PREFS };
}

class UserPreferencesStore {
  prefs = $state<UserPrefs>(loadPrefs());

  private readonly storageListener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    this.prefs = loadPrefs();
    this.applyPreferences();
  };

  constructor() {
    if (canUseDom()) {
      window.addEventListener('storage', this.storageListener);

      const savedTheme = localStorage.getItem('kotbo_theme') as ThemeId | null;
      if (savedTheme) {
        this.prefs.theme = savedTheme;
      } else {
        this.prefs.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
    }

    this.applyPreferences();
  }

  private save() {
    if (!canUseDom()) {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
  }

  private applyThemePreference(theme: UserPrefs['theme']) {
    if (!canUseDom()) {
      return;
    }

    themeStore.themeId = theme;
  }

  private applyAccentColorPreference(accentColor: AccentColor) {
    if (!canUseDom()) {
      return;
    }

    themeStore.setAccent(accentColor);
  }

  private applyUiPreferences() {
    if (!canUseDom()) {
      return;
    }

    document.documentElement.classList.toggle('no-animations', !this.prefs.animationsEnabled);
    document.documentElement.classList.toggle('compact-ui', this.prefs.compactMode);
    document.documentElement.lang = this.prefs.language;
    // Aligne Paraglide sur la préférence sans recharger (init / restauration).
    applyLocale(this.prefs.language, { reload: false });
    document.documentElement.dataset.sidebarBehavior = this.prefs.sidebarBehavior;
    document.documentElement.dataset.dateFormat = this.prefs.dateFormat;

    if (this.prefs.sidebarBehavior === 'always-open') {
      sidebarStore.set(false);
    } else if (this.prefs.sidebarBehavior === 'always-closed') {
      sidebarStore.set(true);
    }
  }

  private applyPreferences() {
    this.applyThemePreference(this.prefs.theme);
    this.applyAccentColorPreference(this.prefs.accentColor);
    this.applyUiPreferences();
  }

  async syncFromDatabase() {
    try {
      const { fetchUserSettings } = await import('../api');
      const data = await fetchUserSettings();
      if (data) {
        // Le bouton clair/sombre ecrit localStorage de facon synchrone, alors
        // qu'un rechargement - changer de langue en declenche un - peut annuler
        // l'ecriture vers la base. Reappliquer la base par-dessus ressuscitait
        // alors le theme d'avant la bascule. En cas de desaccord, le choix de
        // cet appareil fait foi et c'est la base qu'on rattrape.
        const localTheme = canUseDom() ? localStorage.getItem('kotbo_theme') : null;
        if (data.themeId && !localTheme) {
          this.prefs.theme = data.themeId;
          themeStore.themeId = data.themeId;
        } else if (data.themeId && data.themeId !== localTheme) {
          void this.syncToDatabase();
        }
        if (data.customTheme) {
          themeStore.setCustomColors(data.customTheme);
        }
        if (data.accentColor) {
          this.prefs.accentColor = data.accentColor;
          themeStore.setAccent(data.accentColor);
        }
        if (data.sidebarBehavior) {
          this.prefs.sidebarBehavior = data.sidebarBehavior;
        }
        if (data.compactMode !== undefined) {
          this.prefs.compactMode = data.compactMode;
        }
        // `null` en base veut dire « suivre le navigateur » : c'est une valeur
        // choisie, pas une absence de reponse, donc elle doit ecraser un
        // reglage local devenu obsolete.
        if (data.timezone !== undefined) {
          this.prefs.timezone = data.timezone ?? 'auto';
        }
        this.applyPreferences();
        this.save();
      }
    } catch (e) {
      console.warn("Failed to sync preferences from database:", e);
    }
  }

  async syncToDatabase() {
    try {
      const { updateUserSettings } = await import('../api');
      await updateUserSettings({
        // Lu depuis le magasin et non depuis `prefs` : le bouton clair/sombre
        // change le thème sans passer par ici, et une valeur périmée renvoyée à
        // la base ressuscitait l'ancien thème au chargement suivant.
        themeId: themeStore.themeId,
        customTheme: themeStore.themeId === 'custom' ? themeStore.customColors : null,
        accentColor: this.prefs.accentColor,
        sidebarBehavior: this.prefs.sidebarBehavior,
        compactMode: this.prefs.compactMode,
        timezone: this.prefs.timezone === 'auto' ? null : this.prefs.timezone
      });
    } catch (e) {
      console.warn("Failed to sync preferences to database:", e);
    }
  }

  set<K extends keyof UserPrefs>(key: K, value: UserPrefs[K]) {
    // Le bouton clair/sombre change le thème sans passer par ce magasin :
    // enregistrer une autre préférence y réécrivait sinon le thème d'avant la
    // bascule. Un appel qui porte justement sur le thème fait foi, lui, et
    // `reset()` doit pouvoir revenir au thème par défaut.
    if (key !== 'theme') {
      this.prefs.theme = themeStore.themeId;
    }
    this.prefs[key] = value;
    this.save();
    // Les messages Paraglide ne sont pas réactifs en Svelte pur : un changement
    // de langue recharge la page pour retraduire l'ensemble de l'UI.
    if (key === 'language' && canUseDom()) {
      this.syncToDatabase();
      applyLocale(value as Language);
      return;
    }
    this.applyPreferences();
    this.syncToDatabase();
  }

  reset() {
    this.prefs = { ...DEFAULT_PREFS };
    this.save();
    this.applyPreferences();
    this.syncToDatabase();
  }
}

export const userPrefs = new UserPreferencesStore();
export type { UserPrefs, Language, DateFormat, SidebarBehavior, AccentColor, TimezonePreference };
export type { ThemeId } from './theme.svelte';
