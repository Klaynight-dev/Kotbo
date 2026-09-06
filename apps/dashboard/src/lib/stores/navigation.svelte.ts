import { canonicalModuleKey, getModuleDefinition, getModuleForPath } from '@kotbo/contracts';
import { updateSidebarFavorites } from '../api';
import {
  allPages,
  generalItems,
  moderationItems,
  securityItems,
  levelingItems,
  economyItems,
  communityItems,
  staffItems,
  crossServerItems,
  configItems,
  resolveSecurityRedirect,
  type PageConfig,
} from '../config/pages';
import { m } from '../i18n';
import { authStore } from './auth.svelte';
import {
  FAVORITES_KEY,
  RECENTS_KEY,
  onNavigationStorageCleared,
  readStoredHrefs,
  writeStoredHrefs,
} from './navigationStorage';
import { dashboardStore } from './dashboard.svelte';

export type NavGroup = { key: string; label: string; items: PageConfig[] };

const MAX_FAVORITES = 80;
const MAX_RECENTS = 6;

/** Staff-only pages that non-admins reach only when they hold the matching role. */
const STAFF_SHARED_PAGES = [
  '/planning',
  '/absences',
  '/meetings',
  '/tickets',
  '/recruitment',
  '/evaluations',
];

function sanitizeHrefs(entries: unknown, limit: number): string[] {
  if (!Array.isArray(entries)) return [];
  return [
    ...new Set(
      entries
        .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
        .map((entry) => entry.trim())
        // Les favoris et recents enregistres avant la refonte securite pointent
        // vers des URL qui n'existent plus : on les reecrit a la lecture plutot
        // que de les laisser disparaitre silencieusement.
        .map((entry) => resolveSecurityRedirect(entry) ?? entry)
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function readStored(key: string, limit: number): string[] {
  return sanitizeHrefs(readStoredHrefs(key), limit);
}

/**
 * Single source of truth for what the current user may navigate to.
 *
 * Both the desktop sidebar and the mobile navigation sheet read from here, so
 * permission rules only ever have to be expressed once.
 */
class NavigationStore {
  #favorites = $state<string[]>([]);
  #recents = $state<string[]>(readStored(RECENTS_KEY, MAX_RECENTS));
  #hydratedGuildId = $state<string | null>(null);
  #persistTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #guild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId),
  );

  readonly #featureAccess = $derived(
    (dashboardStore.state.featureAccess ?? {}) as Record<string, { canView?: boolean }>,
  );

  /**
   * Deux sources pour la meme question, parce qu'elles ne se trompent pas au
   * meme endroit : le niveau de la liste des serveurs vient des permissions
   * rendues par OAuth, qui datent de la connexion, tandis que l'etat de guilde
   * lit les permissions reelles du membre sur le serveur. Sans la seconde, un
   * administrateur dont la session a vieilli perdait le groupe Configuration
   * de sa barre laterale. `canManageSettings` n'est vrai que pour le niveau
   * `admin` : le croisement n'ouvre rien a un moderateur.
   */
  readonly isAdmin = $derived(
    this.#guild?.accessLevel === 'admin'
      || !!dashboardStore.state.access?.canManageSettings,
  );
  /**
   * Facturation visible pour ce compte sur ce serveur.
   *
   * Calcule par l'API (`/api/user/guilds`) et non ici : la regle melange le
   * niveau Discord, le payeur enregistre et un reglage du serveur, dont le
   * navigateur n'a aucune raison de connaitre le detail. La page n'apparait
   * donc que pour l'administrateur, celui qui paie, ou tout le staff quand le
   * serveur a choisi de leur ouvrir.
   */
  readonly canViewBilling = $derived(Boolean(this.#guild?.billingAccess));
  readonly isModerator = $derived(this.#guild?.accessLevel === 'moderator');
  readonly isStaff = $derived(!!authStore.member);
  readonly isStaffServer = $derived(!!dashboardStore.state.isStaffServer);

  readonly #moduleStates = $derived(
    (dashboardStore.state.moduleStates ?? {}) as Record<string, boolean>,
  );

  canViewFeature = (featureKey?: string): boolean => {
    // L'acces a la guilde se verifie avant `featureAccess`, qui vient du store
    // et decrit toujours la derniere guilde chargee : passe outre, un compte
    // qui perd ses droits en cours de session continuerait de voir ses pages
    // tant que le store n'a pas ete relu.
    if (!authStore.hasGuildAccess) return false;
    if (!featureKey) return true;
    const feature = this.#featureAccess[featureKey];
    if (feature?.canView !== undefined) return feature.canView;
    return true;
  };

  /**
   * Module auquel une entrée de navigation appartient.
   *
   * `featureKey` d'abord, la route ensuite : plusieurs pages n'ont pas de clé
   * de fonctionnalité mais leur chemin est déclaré par le registre.
   */
  #moduleKeyFor = (featureKey?: string, href?: string): string | undefined => {
    if (featureKey) {
      const canonical = canonicalModuleKey(featureKey);
      if (getModuleDefinition(canonical)) return canonical;
    }
    return getModuleForPath(href);
  };

  /**
   * Module éteint sur ce serveur.
   *
   * La liste des correspondances était auparavant écrite à la main ici, et ne
   * couvrait que sept modules sur une trentaine : les autres restaient affichés
   * comme actifs. Elle vient maintenant de l'état que le bot applique.
   */
  isModuleDisabled = (featureKey?: string, href?: string): boolean => {
    const moduleKey = this.#moduleKeyFor(featureKey, href);
    if (!moduleKey) return false;
    return this.#moduleStates[moduleKey] === false;
  };

  /**
   * Une entrée de navigation dont le module est coupé disparaît : sa page
   * renverrait de toute façon une erreur 403, l'API filtrant les routes du
   * module. La griser aurait laissé un lien menant à un mur.
   */
  #isReachable = (item: PageConfig): boolean => {
    return this.canViewFeature(item.featureKey) && !this.isModuleDisabled(item.featureKey, item.href);
  };

  /**
   * « Créer mon serveur » avait ici son propre filtre : sa page etait reservee
   * aux admins. Elle est devenue un bloc de la prise en main, ouverte a qui
   * peut configurer le serveur, et c'est la page qui masque desormais le bloc
   * aux non-admins - le reste du parcours leur restant utile.
   */
  readonly #visibleGeneral = $derived(generalItems.filter(this.#isReachable));

  readonly #visibleModeration = $derived(
    this.isStaff || this.isModerator || this.isAdmin
      ? moderationItems.filter(this.#isReachable)
      : [],
  );

  /**
   * Securite : visible des le staff, mais en lecture seule pour les non-admins.
   * Les pages elles-memes desactivent les champs via `canManageSecurity`, ce qui
   * evite de masquer un etat que les moderateurs ont besoin de consulter.
   */
  readonly #visibleSecurity = $derived(
    this.isStaff || this.isModerator || this.isAdmin
      ? securityItems.filter(this.#isReachable)
      : [],
  );

  /** Vrai si l'utilisateur peut modifier la configuration de securite. */
  readonly canManageSecurity = $derived(this.isAdmin);

  readonly #visibleLeveling = $derived(
    this.isStaffServer ? [] : levelingItems.filter(this.#isReachable),
  );

  readonly #visibleEconomy = $derived(
    this.isStaffServer ? [] : economyItems.filter(this.#isReachable),
  );

  readonly #visibleCommunity = $derived(
    this.isStaffServer ? [] : communityItems.filter(this.#isReachable),
  );

  readonly #visibleStaff = $derived.by((): PageConfig[] => {
    if (this.isAdmin) return staffItems.filter(this.#isReachable);

    const isTutor = dashboardStore.state.isTutor;
    const isApprentice = !!dashboardStore.state.apprenticeProgress;

    return staffItems
      .filter(({ href }) => {
        if (href === '/tutoring') return isTutor || isApprentice || this.isModerator;
        if (STAFF_SHARED_PAGES.includes(href)) return this.isStaff || this.isModerator;
        return false;
      })
      .filter(this.#isReachable);
  });

  readonly #visibleCrossServer = $derived(
    this.isAdmin ? crossServerItems.filter(this.#isReachable) : [],
  );

  readonly #visibleConfig = $derived(
    this.isAdmin ? configItems.filter(this.#isReachable) : [],
  );

  /** Navigation groups in reading order, empty groups removed. */
  readonly groups = $derived.by((): NavGroup[] => {
    const general = { key: 'general', label: m.nav_group_general(), items: this.#visibleGeneral };
    const moderation = { key: 'moderation', label: m.nav_group_moderation(), items: this.#visibleModeration };
    const security = { key: 'security', label: m.nav_group_security(), items: this.#visibleSecurity };
    const leveling = { key: 'leveling', label: m.nav_group_xp(), items: this.#visibleLeveling };
    const economy = { key: 'economy', label: m.nav_group_economy(), items: this.#visibleEconomy };
    const community = { key: 'community', label: m.nav_group_community(), items: this.#visibleCommunity };
    const staff = { key: 'staff', label: m.nav_group_staff(), items: this.#visibleStaff };
    const crossserver = { key: 'crossserver', label: m.nav_group_crossserver(), items: this.#visibleCrossServer };
    const config = { key: 'config', label: m.nav_group_config(), items: this.#visibleConfig };

    // On a staff server the staff tooling is the reason people are here.
    const ordered = this.isStaffServer
      ? [general, staff, moderation, security, leveling, economy, community, crossserver, config]
      : [general, moderation, security, leveling, economy, community, staff, crossserver, config];

    return ordered.filter((group) => group.items.length > 0);
  });

  /** Flat list of every reachable page, used for search. */
  readonly allItems = $derived(this.groups.flatMap((group) => group.items));

  get favorites(): string[] {
    return this.#favorites;
  }

  readonly favoriteItems = $derived(
    this.#favorites
      .map((href) => this.allItems.find((item) => item.href === href))
      .filter((item): item is PageConfig => !!item),
  );

  readonly recentItems = $derived(
    this.#recents
      .map((href) => this.allItems.find((item) => item.href === href))
      .filter((item): item is PageConfig => !!item),
  );

  isFavorite = (href: string): boolean => this.#favorites.includes(href);

  /**
   * Favourites live on the server so they follow the user across devices, with
   * localStorage as an offline mirror. Call once per guild from a component.
   */
  hydrateFavorites(): void {
    const guildId = authStore.selectedGuildId ?? null;
    const serverFavorites = sanitizeHrefs(
      (dashboardStore.state as { sidebarFavorites?: unknown }).sidebarFavorites ?? [],
      MAX_FAVORITES,
    );

    if (this.#hydratedGuildId !== guildId) {
      const legacy = readStored(FAVORITES_KEY, MAX_FAVORITES);
      this.#hydratedGuildId = guildId;
      this.#favorites = serverFavorites.length > 0 ? serverFavorites : legacy;
      if (legacy.length > 0 && serverFavorites.length === 0 && guildId) {
        void this.#persist(legacy);
      }
      return;
    }

    if (JSON.stringify(serverFavorites) !== JSON.stringify(this.#favorites)) {
      this.#favorites = serverFavorites;
    }
  }

  toggleFavorite(href: string): void {
    this.#favorites = this.#favorites.includes(href)
      ? this.#favorites.filter((entry) => entry !== href)
      : [...this.#favorites, href].slice(0, MAX_FAVORITES);

    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    const snapshot = this.#favorites;
    this.#persistTimer = setTimeout(() => void this.#persist(snapshot), 250);
  }

  /** Records a visit so the navigation sheet can offer a "recent" shortcut. */
  noteVisit(href: string): void {
    if (!href.startsWith('/') || href === '/') return;
    const next = [href, ...this.#recents.filter((entry) => entry !== href)].slice(0, MAX_RECENTS);
    if (JSON.stringify(next) === JSON.stringify(this.#recents)) return;
    this.#recents = next;
    writeStoredHrefs(RECENTS_KEY, next);
  }

  /** Case- and accent-insensitive search across every reachable page. */
  search(query: string): PageConfig[] {
    const needle = normalize(query);
    if (!needle) return [];
    return this.allItems
      .map((item) => ({ item, score: matchScore(normalize(item.name), needle) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }

  /** Fin de session : plus rien de l'utilisateur precedent ne doit rester. */
  reset(): void {
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#persistTimer = null;
    this.#favorites = [];
    this.#recents = [];
    this.#hydratedGuildId = null;
  }

  async #persist(next: string[]): Promise<void> {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    const sanitized = sanitizeHrefs(next, MAX_FAVORITES);
    (dashboardStore.state as { sidebarFavorites?: string[] }).sidebarFavorites = sanitized;
    writeStoredHrefs(FAVORITES_KEY, sanitized);
    await updateSidebarFavorites(sanitized, guildId);
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Prefix matches rank above word-start matches, which rank above substrings. */
function matchScore(haystack: string, needle: string): number {
  if (haystack.startsWith(needle)) return 3;
  if (haystack.includes(` ${needle}`)) return 2;
  if (haystack.includes(needle)) return 1;
  return 0;
}

export const navigationStore = new NavigationStore();

onNavigationStorageCleared(() => navigationStore.reset());

/** Adresses du menu, sans leur eventuelle requete. Fixes : calculees une fois. */
const NAV_BASE_PATHS = allPages.map((page) => page.href.split('?')[0]);

/**
 * Shared active-route test so sidebar and sheet always agree on highlighting.
 *
 * L'entree la plus precise gagne : sans cela `/security` restait allume sur
 * `/security/anti-raid` et deux entrees du meme groupe s'eclairaient ensemble.
 * Une entree sans voisine plus longue garde son prefixe, et les sous-pages
 * absentes du menu - `/admin/servers`, un onglet - continuent d'allumer leur
 * entree parente.
 */
export function isActiveNavItem(href: string, path: string, url: string): boolean {
  if (href === '/') return path === '/';
  const [base, query] = href.split('?');
  if (query) return path === base && url.includes(query);
  if (path === base) return true;
  if (!path.startsWith(`${base}/`)) return false;

  return !NAV_BASE_PATHS.some(
    (candidate) => candidate.length > base.length
      && (path === candidate || path.startsWith(`${candidate}/`)),
  );
}
