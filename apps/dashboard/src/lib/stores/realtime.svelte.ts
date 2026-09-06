/**
 * Socle temps reel du dashboard.
 *
 * L'API pousse deja ses changements sur un WebSocket, mais chaque page qui
 * voulait en profiter recollait le meme bout de code : un `addEventListener`
 * sur `kotbo-ws-message`, un test sur le type, un test sur la guilde, un test
 * sur la raison, puis le retrait de l'ecouteur au demontage. Les pages qui ne
 * l'avaient pas fait sondaient l'API a intervalle fixe - jusqu'a toutes les
 * trois secondes - pour un changement qui arrive une fois par jour.
 *
 * Ce module centralise les trois choses qu'aucune page ne faisait correctement
 * seule :
 *
 * - le filtrage (type, raison, guilde affichee) en un seul endroit ;
 * - le rattrapage : un evenement emis pendant que la connexion etait coupee ou
 *   que l'onglet dormait est perdu a jamais, la page doit donc se recharger au
 *   retour plutot que d'afficher indefiniment un etat perime ;
 * - le filet de securite : le WebSocket n'est pas garanti - seul le shard qui
 *   porte l'API peut diffuser - donc un rafraichissement lent reste utile pour
 *   certaines vues, mais seulement lent, et jamais quand l'onglet dort.
 */

import { authStore } from './auth.svelte';

export interface RealtimeEvent {
  type: string;
  guildId?: string;
  reason?: string;
  at?: string;
  [key: string]: unknown;
}

export type RealtimeStatus = 'connecting' | 'live' | 'offline';

type RealtimeEventListener = (event: RealtimeEvent) => void;
type ResyncListener = () => void;

const eventListeners = new Set<RealtimeEventListener>();
const resyncListeners = new Set<ResyncListener>();

class RealtimeStore {
  status = $state<RealtimeStatus>('connecting');
  /** Horodatage du dernier message recu, tous types confondus. */
  lastEventAt = $state<number | null>(null);
  lastConnectedAt = $state<number | null>(null);

  get live() {
    return this.status === 'live';
  }
}

export const realtimeStore = new RealtimeStore();

// -- Cote emetteur : appele par `dashboardLifecycle` -------------------------

export function setRealtimeStatus(status: RealtimeStatus) {
  const wasOffline = realtimeStore.status !== 'live';
  realtimeStore.status = status;

  if (status === 'live') {
    realtimeStore.lastConnectedAt = Date.now();
    // Une reconnexion signifie qu'on a rate tout ce qui s'est passe pendant la
    // coupure. Seul un rechargement peut le rattraper : le serveur ne rejoue
    // pas les evenements manques.
    if (wasOffline) requestRealtimeResync('reconnexion');
  }
}

export function publishRealtimeEvent(event: RealtimeEvent) {
  realtimeStore.lastEventAt = Date.now();
  for (const listener of [...eventListeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error('[Realtime] Abonne en erreur:', error);
    }
  }
}

/**
 * Demander a tous les abonnes de se recharger.
 *
 * Sert au rattrapage, pas a la diffusion : aucun evenement n'est transmis, les
 * abonnes rechargent simplement leur propre etat.
 */
export function requestRealtimeResync(reason: string) {
  if (import.meta.env.DEV) console.debug(`[Realtime] Resynchronisation (${reason})`);
  for (const listener of [...resyncListeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[Realtime] Resynchronisation en erreur:', error);
    }
  }
}

// -- Cote abonne : appele par les pages --------------------------------------

export interface RealtimeSubscription {
  /**
   * Raisons de `dashboard_state_changed` a suivre, ou `'*'` pour toutes.
   * Ce sont les chaines passees a `broadcastDashboardStateChange` cote bot.
   */
  reasons?: readonly string[] | '*';
  /** Types d'evenements hors `dashboard_state_changed` (`bot_guilds_changed`...). */
  types?: readonly string[];
  /**
   * Ignorer ce qui ne concerne pas le serveur affiche. Vrai par defaut : c'est
   * ce que veut toute page de configuration. Les vues qui portent sur
   * l'ensemble des serveurs (« Mes serveurs », administration) le desactivent.
   */
  guildScoped?: boolean;
  /** Ce qu'il faut refaire. Recoit l'evenement declencheur, ou `null` sur un rattrapage. */
  onUpdate: (event: RealtimeEvent | null) => void | Promise<void>;
  /**
   * Filet de securite : rafraichir de toute facon a cet intervalle. A ne
   * renseigner que pour ce qui progresse sans emettre d'evenement (les scans
   * de fond) ou ce que le WebSocket ne couvre pas encore. Jamais en dessous de
   * quelques dizaines de secondes : c'est un filet, pas un sondage.
   */
  fallbackMs?: number;
  /** Recharger au retour de connexion et d'onglet. Vrai par defaut. */
  resync?: boolean;
  /** Delai minimal entre deux executions. Absorbe les rafales d'evenements. */
  throttleMs?: number;
}

/** Au dela, un onglet revenu au premier plan a probablement rate quelque chose. */
const STALE_AFTER_MS = 20_000;
const DEFAULT_THROTTLE_MS = 800;

/**
 * S'abonner aux changements pousses par l'API.
 *
 * Rend la fonction de desabonnement : a appeler dans `onDestroy`, ou a rendre
 * telle quelle depuis `onMount`.
 */
export function subscribeRealtime(options: RealtimeSubscription): () => void {
  const {
    reasons,
    types,
    guildScoped = true,
    onUpdate,
    fallbackMs,
    resync = true,
    throttleMs = DEFAULT_THROTTLE_MS,
  } = options;

  const wantedReasons = reasons === '*' ? null : new Set(reasons ?? []);
  const wantedTypes = new Set(types ?? []);

  let disposed = false;
  let lastRunAt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEvent: RealtimeEvent | null = null;

  /**
   * Une action de dashboard emet souvent plusieurs evenements d'affilee (un par
   * enregistrement touche). Les executer un par un lancerait autant de requetes
   * pour un seul et meme rechargement : on ne garde que le dernier.
   */
  const run = (event: RealtimeEvent | null) => {
    if (disposed) return;
    pendingEvent = event;

    if (pendingTimer) return;
    const wait = Math.max(0, throttleMs - (Date.now() - lastRunAt));

    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (disposed) return;
      lastRunAt = Date.now();
      const triggering = pendingEvent;
      pendingEvent = null;
      void onUpdate(triggering);
    }, wait);
  };

  const handleEvent = (event: RealtimeEvent) => {
    if (event.type === 'dashboard_state_changed') {
      if (!reasons) return;
      if (wantedReasons && !wantedReasons.has(event.reason ?? '')) return;
      if (guildScoped && event.guildId !== authStore.selectedGuildId) return;
      run(event);
      return;
    }

    if (!wantedTypes.has(event.type)) return;
    if (guildScoped && event.guildId && event.guildId !== authStore.selectedGuildId) return;
    run(event);
  };

  eventListeners.add(handleEvent);

  const handleResync = () => run(null);
  if (resync) resyncListeners.add(handleResync);

  /**
   * Un onglet en arriere-plan n'a personne pour le regarder : le rafraichir
   * n'apporte rien et le navigateur bride de toute facon ses minuteurs. On le
   * remet a jour au retour, et seulement s'il a de quoi etre perime.
   */
  const handleVisibility = () => {
    if (document.hidden) return;
    if (Date.now() - lastRunAt < STALE_AFTER_MS) return;
    run(null);
  };
  if (resync) document.addEventListener('visibilitychange', handleVisibility);

  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  if (fallbackMs && fallbackMs > 0) {
    fallbackTimer = setInterval(() => {
      if (document.hidden) return;
      run(null);
    }, fallbackMs);
  }

  return () => {
    disposed = true;
    eventListeners.delete(handleEvent);
    resyncListeners.delete(handleResync);
    if (resync) document.removeEventListener('visibilitychange', handleVisibility);
    if (pendingTimer) clearTimeout(pendingTimer);
    if (fallbackTimer) clearInterval(fallbackTimer);
  };
}
