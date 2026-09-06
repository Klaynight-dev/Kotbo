import { DEFAULT_TIMEZONE, isValidTimezone } from '@kotbo/contracts';
import { authStore } from './auth.svelte';
import { userPrefs } from './userPreferences.svelte';
import { fetchGuildTimezone } from '../api/guild';

/**
 * Fuseau du serveur selectionne, partage entre toutes les pages qui saisissent
 * une date. Regroupe en un seul appel : sans cache, Meetings, Planning et le
 * formulaire de rappels lanceraient chacun leur propre GET a l'ouverture.
 *
 * Le fuseau du navigateur reste expose pour les libelles d'aide : « heure
 * saisie dans Europe/Paris (comme sur ton PC) » se lit differemment selon que
 * les deux correspondent ou non.
 */
class TimezoneStore {
  timezone = $state<string>(DEFAULT_TIMEZONE);
  loadedGuildId = $state<string | null>(null);

  /**
   * Vrai seulement si le fuseau en memoire decrit bien le serveur affiche. Un
   * simple drapeau restait a `true` apres un changement de serveur, et les
   * libelles annoncaient le fuseau du precedent jusqu'au retour de la lecture.
   */
  get loaded(): boolean {
    return this.loadedGuildId !== null && this.loadedGuildId === authStore.selectedGuildId;
  }

  /**
   * Fuseau qu'on vient d'ecrire ailleurs (page Accueil) : evite une relecture
   * juste apres la sauvegarde, et garde les formulaires en phase.
   */
  apply(timezone: string, guildId: string | null = authStore.selectedGuildId): void {
    if (!guildId) return;
    this.timezone = timezone;
    this.loadedGuildId = guildId;
  }

  readonly browserTimezone: string = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
    } catch {
      return DEFAULT_TIMEZONE;
    }
  })();

  /**
   * Lecture en vol, partagee par tous les appelants. Plusieurs composants
   * demandent le fuseau au montage : sans ce partage, chacun lancait son propre
   * GET puisque `loadedGuildId` n'est ecrit qu'a la reponse.
   */
  private loading: Promise<void> | null = null;
  private loadingGuildId: string | null = null;

  async ensureLoaded(force = false): Promise<void> {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    if (!force && this.loadedGuildId === guildId) return;
    // Une lecture en vol ne repond que pour le serveur qu'elle vise : rendre
    // celle d'un autre laisserait l'appelant croire son fuseau charge.
    if (!force && this.loading && this.loadingGuildId === guildId) return this.loading;

    const pending = this.load(guildId);
    this.loading = pending;
    this.loadingGuildId = guildId;
    try {
      await pending;
    } finally {
      if (this.loading === pending) {
        this.loading = null;
        this.loadingGuildId = null;
      }
    }
  }

  private async load(guildId: string): Promise<void> {
    const state = await fetchGuildTimezone();
    // La selection a pu changer pendant l'appel : n'ecrit que si on est encore
    // sur le serveur demande, sinon on ecraserait un chargement plus recent.
    if (authStore.selectedGuildId !== guildId) return;
    if (state?.timezone) this.apply(state.timezone, guildId);
  }

  /** Vrai si le fuseau du serveur diffère de celui du navigateur. */
  get differsFromBrowser(): boolean {
    return this.timezone !== this.browserTimezone;
  }

  /**
   * Fuseau dans lequel lire les statistiques.
   *
   * Les agregats sont stockes en UTC : rendus tels quels, ils annoncaient a un
   * lecteur parisien un pic de 14h comme un pic de midi. Le reglage utilisateur
   * prime, sinon le fuseau du navigateur - qui est deja le bon pour la plupart
   * des lecteurs, et ne demande aucun reglage.
   *
   * Volontairement independant du fuseau du serveur : deux moderateurs d'un
   * meme serveur peuvent vivre a deux endroits differents, et chacun lit ses
   * courbes a son heure.
   */
  get displayTimezone(): string {
    const preferred = userPrefs.prefs.timezone;
    if (preferred && preferred !== 'auto' && isValidTimezone(preferred)) return preferred;
    return this.browserTimezone;
  }
}

export const timezoneStore = new TimezoneStore();
