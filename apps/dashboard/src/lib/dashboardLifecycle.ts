import { DASHBOARD_WS_URL } from './api';
import { prefetchRoute } from './lazyRoutes';
import { authStore } from './stores/auth.svelte';
import { dashboardStore } from './stores/dashboard.svelte';
import {
  publishRealtimeEvent,
  setRealtimeStatus,
  subscribeRealtime,
} from './stores/realtime.svelte';

function waitForWindowLoad(): Promise<void> {
  if (document.readyState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handleLoad = () => {
      window.removeEventListener('load', handleLoad);
      resolve();
    };

    window.addEventListener('load', handleLoad, { once: true });
  });
}

function waitForBrowserIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 300 });
      return;
    }

    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 150);
    });
  });
}

const AUTO_REFRESH_INTERVAL = 10 * 60 * 1000;

const RECONNECT_BASE_DELAY = 3_000;
const RECONNECT_MAX_DELAY = 60_000;

class DashboardLifecycleManager {
  private socket: WebSocket | null = null;
  private reconnectTimer: any = null;
  private reconnectAttempts = 0;
  private unsubscribeState: (() => void) | null = null;
  private intentionallyClosed = false;
  private isConnecting = false;
  private initialized = false;
  private readonly handleRefreshRequest = () => {
    void dashboardStore.refresh();
  };

  /**
   * Un onglet en arriere-plan voit ses minuteurs brides, et une connexion
   * fermee pendant ce temps attendrait jusqu'a une minute de recul avant de
   * revenir. Le retour au premier plan est le moment ou la fraicheur compte :
   * on repart tout de suite, sans attendre le tour du recul.
   */
  private readonly handleVisibility = () => {
    if (document.hidden) return;
    if (this.socket || this.intentionallyClosed || !authStore.token) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    void this.connect();
  };

  constructor() {}

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // Refresh initially
    if (authStore.token && authStore.selectedGuildId) {
      dashboardStore.refresh();
    }

    // Event listener for manual refresh requests
    window.addEventListener('kotbo-dashboard-refresh-request', this.handleRefreshRequest);
    document.addEventListener('visibilitychange', this.handleVisibility);

    // L'etat global se recharge au retour de connexion et au retour d'onglet,
    // faute de quoi il resterait fige sur ce qu'il decrivait avant la coupure.
    // Le cycle de dix minutes n'est plus qu'un filet : les changements arrivent
    // desormais par le WebSocket.
    this.unsubscribeState = subscribeRealtime({
      fallbackMs: AUTO_REFRESH_INTERVAL,
      onUpdate: () => {
        if (authStore.token && authStore.selectedGuildId) void dashboardStore.refresh();
      },
    });

    // Start connection
    this.connect();

    void this.prefetchFrequentRoutes();
  }

  /**
   * Precharge en temps mort les pages les plus consultees. Le navigateur est
   * deja au repos a ce moment-la (la page d'accueil est rendue), donc ces
   * chunks n'entrent en concurrence avec rien ; en contrepartie, le premier
   * clic sur ces entrees de menu n'attend aucun telechargement.
   *
   * `prefetchRoute` est silencieux en cas d'echec : un prefetch rate ne doit
   * jamais empecher la navigation reelle, qui refera la tentative.
   */
  private async prefetchFrequentRoutes() {
    if (typeof window === 'undefined') return;

    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (
      connection?.saveData ||
      connection?.effectiveType === 'slow-2g' ||
      connection?.effectiveType === '2g'
    ) {
      return;
    }

    await waitForWindowLoad();
    await waitForBrowserIdle();

    // Deux routes fréquentes et relativement légères seulement. Sanctions et
    // tickets tiraient des dizaines de chunks en cache sans intention de
    // navigation, soit plusieurs centaines de Ko après chaque accueil.
    for (const path of ['/analytics', '/members']) {
      prefetchRoute(path);
      await waitForBrowserIdle();
    }
  }

  async connect() {
    if (!authStore.token) return;
    if (this.isConnecting) return;
    
    // Si déjà ouvert ou en cours, on ne fait rien
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isConnecting = true;
    this.intentionallyClosed = false;

    try {
      // On attend que la page soit stable pour éviter les interruptions mentionnées par l'utilisateur
      await waitForWindowLoad();
      await waitForBrowserIdle();

      if (this.intentionallyClosed || !authStore.token) {
        this.isConnecting = false;
        return;
      }

      const wsUrl = new URL(DASHBOARD_WS_URL);

      this.socket = new WebSocket(wsUrl.toString());

      this.socket.onopen = () => {
        console.log('[DashboardWS] Connecté avec la session sécurisée.');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        // Declenche le rattrapage des abonnes si la connexion revient d'une
        // coupure : tout ce qui a ete diffuse entre-temps est perdu.
        setRealtimeStatus('live');
      };

      this.socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);

          // Le socle typé, et l'événement global historique que quelques pages
          // écoutent encore directement.
          publishRealtimeEvent(payload);
          const customEvent = new CustomEvent('kotbo-ws-message', { detail: payload });
          window.dispatchEvent(customEvent);

          const shouldRefresh =
            payload?.type === 'dashboard_state_changed' &&
            payload?.guildId === authStore.selectedGuildId;

          if (shouldRefresh) {
            console.log('[DashboardWS] Changement détecté, actualisation...');
            dashboardStore.refresh();
          }
        } catch (error) {
          console.error('[DashboardWS] Payload invalide:', error);
        }
      };

      this.socket.onclose = (event) => {
        this.isConnecting = false;
        this.socket = null;
        setRealtimeStatus(this.intentionallyClosed ? 'offline' : 'connecting');

        if (this.intentionallyClosed) {
          console.log('[DashboardWS] Déconnecté (intentionnel)');
          return;
        }

        this.scheduleReconnect(`code: ${event.code}`);
      };

      this.socket.onerror = (error) => {
        console.error('[DashboardWS] Erreur:', error);
        this.socket?.close();
      };
    } catch (err) {
      this.isConnecting = false;
      console.error('[DashboardWS] Erreur lors de la tentative de connexion:', err);
      this.scheduleReconnect('exception');
    }
  }

  /**
   * Le delai ne changeait jamais : une API arretee, ou une session expiree - que le
   * navigateur ne distingue pas d'une coupure reseau, l'echec ayant lieu
   * pendant l'upgrade HTTP et remontant en code 1006 - faisait rouvrir une
   * connexion toutes les 3 secondes indefiniment, pour chaque onglet ouvert.
   *
   * La gigue evite qu'au redemarrage de l'API tous les onglets de tous les
   * utilisateurs ne reviennent frapper a la meme seconde.
   */
  private scheduleReconnect(reason: string) {
    if (this.intentionallyClosed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const backoff = Math.min(
      RECONNECT_BASE_DELAY * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY,
    );
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;

    console.warn(
      `[DashboardWS] Connexion interrompue (${reason}). Nouvelle tentative dans ${Math.round(delay / 1000)}s.`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  destroy() {
    this.intentionallyClosed = true;
    window.removeEventListener('kotbo-dashboard-refresh-request', this.handleRefreshRequest);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    setRealtimeStatus('offline');
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.initialized = false;
  }
}

export const dashboardLifecycle = new DashboardLifecycleManager();

/**
 * @deprecated Use dashboardLifecycle.init() in MainLayout instead
 */
export function refreshDashboardOnMount() {
  // Empty to avoid breaking components while refactoring
}
