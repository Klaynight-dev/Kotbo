import { m } from '../i18n';

export interface PageConfig {
  name: string;
  icon?: string;
  href: string;
  featureKey?: string;
  /** Affiche le badge BETA dans la sidebar et la bannière page */
  beta?: boolean;
  /** Affiche le badge WIP dans la sidebar et l'overlay page */
  wip?: boolean;
  /** Message custom sur l'overlay WIP (remplace le texte par défaut) */
  wipMessage?: string;
}

export function isPageBeta(page: PageConfig): boolean {
  return page.beta === true;
}

export function isPageWip(page: PageConfig): boolean {
  return page.wip === true;
}

export const generalItems: PageConfig[] = [
  { name: m.nav_home(),           icon: "home",      href: "/",          featureKey: "dashboard", beta: false, wip: false },
  // Prise en main juste apres l'accueil : c'est la page qu'on ouvre en
  // arrivant, et celle vers laquelle on revient pour verifier qu'il ne
  // manque rien.
  // « Créer mon serveur » y a été fusionné : monter la structure et vérifier
  // ce qu'il reste à régler sont le même moment.
  { name: "Prise en main",        icon: "compass",   href: "/setup",     featureKey: "settings", beta: true, wip: false },
  // « Reprise » a quitte le menu : la detection des autres bots et la
  // recuperation de ce qui est lisible du serveur se font desormais dans le
  // parcours de configuration, imposees des qu'on repond « serveur existant ».
  // C'est le bon moment - avant que Kotbo ne pose quoi que ce soit - et c'est
  // aussi le seul ou l'on y pense. La route `/migration` repond toujours, pour
  // les liens en favori et pour un second passage apres l'arrivee d'un
  // nouveau bot ; elle n'a simplement plus a occuper une ligne du menu de tous
  // les serveurs, y compris ceux qui n'ont jamais eu d'autre bot.
  { name: m.nav_pulse(),        icon: "activity",  href: "/pulse",     featureKey: "dashboard", beta: true, wip: false },
  { name: m.nav_inbox(),             icon: "inbox",     href: "/inbox",     featureKey: "inbox", beta: false, wip: false },
  { name: m.nav_analytics(),         icon: "pie-chart", href: "/analytics", featureKey: "analytics", beta: false, wip: false },
];

export const moderationItems: PageConfig[] = [
  { name: m.nav_members(),             icon: "users",         href: "/members",            featureKey: "members", beta: false, wip: false },
  { name: m.nav_invitations(),         icon: "link",          href: "/invitations",        featureKey: "members", beta: false, wip: false },
  { name: m.nav_discord_logs(),        icon: "file-text",     href: "/logs",              featureKey: "logs", beta: false, wip: false },
  { name: m.nav_message_search(),  icon: "search",        href: "/message-search",    featureKey: "logs", beta: false, wip: false },
  { name: m.nav_transcripts(),      icon: "file",          href: "/transcripts-list",  featureKey: "tickets", beta: false, wip: false },
  { name: m.nav_activity_log(),  icon: "history",       href: "/activity",          featureKey: "activity", beta: false, wip: false },
  { name: m.nav_events(),          icon: "zap",           href: "/events",            featureKey: "events", beta: false, wip: false },
  { name: m.nav_forms(),         icon: "clipboard",     href: "/forms",             featureKey: "events", beta: false, wip: false },
];

/**
 * Groupe Securite : une page-hub puis quatre pages thematiques, chacune
 * decoupee en onglets. Le decoupage suit le cycle de vie d'une menace
 * (entree -> contenu -> identite -> suite donnee) plutot que l'historique
 * des modules, qui avait disperse une meme fonction sur plusieurs pages.
 *
 * Deux sous-pages gardent une entree a elles tant que leur onglet d'accueil
 * n'existe pas : les pseudos sous Filtres, et les appels de ban sous Sanctions
 * - sans entree, /security/sanctions/appeals n'etait plus atteignable au clic.
 */
export const securityItems: PageConfig[] = [
  { name: m.nav_security_overview(),  icon: "shieldcheck",   href: "/security",           featureKey: "raid_protection", beta: false, wip: false },
  { name: m.nav_security_quick_setup(), icon: "sparkles",    href: "/security/quick-setup", featureKey: "automod", beta: false, wip: false },
  { name: m.nav_security_antiraid(),  icon: "shieldwarning", href: "/security/anti-raid", featureKey: "raid_protection", beta: false, wip: false },
  { name: m.nav_security_filters(),   icon: "shield-alert",  href: "/security/filters",   featureKey: "automod", beta: false, wip: false },
  { name: m.nav_nicknames(),          icon: "user",          href: "/security/filters/nicknames", featureKey: "nickname_moderation", beta: false, wip: false },
  { name: m.nav_security_accounts(),  icon: "shield",        href: "/security/accounts",  featureKey: "double_accounts", beta: false, wip: false },
  { name: m.nav_security_sanctions(), icon: "alert-triangle",href: "/security/sanctions", featureKey: "sanctions", beta: false, wip: false },
  { name: m.nav_ban_appeals(),        icon: "gavel",         href: "/security/sanctions/appeals", featureKey: "ban_appeals", beta: false, wip: false },
];

/**
 * Anciennes URL -> nouvel onglet. Sert a la fois aux redirections de routes
 * et a la reecriture des favoris deja enregistres en localStorage.
 */
export const SECURITY_LEGACY_REDIRECTS: Record<string, string> = {
  '/automod':               '/security/filters',
  '/raid-protection':       '/security/anti-raid',
  '/security-audit':        '/security',
  '/double-accounts':       '/security/accounts',
  '/detections':            '/security/accounts/detections',
  '/nickname-moderation':   '/security/filters/nicknames',
  '/sanctions':             '/security/sanctions',
  '/appeals':               '/security/sanctions/appeals',
  '/admin-lock':            '/security/sanctions/admin-approval',
};

/**
 * Resout une URL heritee vers sa destination, en conservant les segments
 * d'onglet qui suivent la base (`/double-accounts/network` -> `/security/accounts/network`).
 */
export function resolveSecurityRedirect(path: string): string | null {
  const direct = SECURITY_LEGACY_REDIRECTS[path];
  if (direct) return direct;

  for (const [legacy, target] of Object.entries(SECURITY_LEGACY_REDIRECTS)) {
    if (path.startsWith(`${legacy}/`)) {
      return `${target}/${path.slice(legacy.length + 1)}`;
    }
  }
  return null;
}

export const levelingItems: PageConfig[] = [
  { name: m.nav_leveling(),       icon: "trophy",        href: "/leveling",         featureKey: "leveling", beta: false, wip: false },
  { name: m.nav_prestige(),            icon: "crown",         href: "/prestige",         featureKey: "prestige", beta: true, wip: false },
  { name: m.nav_seasons(),             icon: "flag",          href: "/seasons",          featureKey: "leveling", beta: false, wip: false },
  { name: m.nav_reputation(),          icon: "star",          href: "/reputation",       featureKey: "leveling", beta: false, wip: false },
  { name: m.nav_clans(),               icon: "shield",        href: "/clans",            featureKey: "leveling", beta: true, wip: false },
  { name: m.nav_drops(),               icon: "arrow-down-box", href: "/drops",            featureKey: "leveling", beta: true, wip: false },
];

export const economyItems: PageConfig[] = [
  // En tete du groupe : un rythme touche aux gains, au delai du daily et a l'energie a la
  // fois, il ne releve donc d'aucun onglet de la page, et c'est par la qu'on commence.
  { name: m.nav_economy_quick_setup(), icon: "sparkles", href: "/economy-setup",    featureKey: "economy",  beta: false, wip: false },
  { name: m.nav_economy(),      icon: "coins",         href: "/economy",          featureKey: "economy",  beta: false, wip: false },
  { name: m.nav_marketplace(),              icon: "shopping-bag",  href: "/marketplace",      featureKey: "economy",  beta: false, wip: false },
  { name: m.nav_quests(),              icon: "compass",       href: "/quests",           featureKey: "economy",  beta: false, wip: false },
];

export const communityItems: PageConfig[] = [
  { name: m.nav_giveaways(),           icon: "sparkles",      href: "/giveaways",        featureKey: "giveaways", beta: false, wip: false },
  { name: m.nav_announcements(), icon: "megaphone",    href: "/announcement",     featureKey: "welcome_goodbye", beta: false, wip: false },
  { name: "Campagnes",           icon: "send",         href: "/campaigns",        featureKey: "settings", beta: true, wip: false },
  { name: m.nav_reaction_roles(),      icon: "mouse-pointer", href: "/reaction-roles",   featureKey: "reaction_roles", beta: false, wip: false },
  { name: m.nav_triggers(),        icon: "git-branch",    href: "/triggers",         featureKey: "workflows", beta: true, wip: false },
  { name: m.nav_suggestions(),         icon: "thumbs-up",     href: "/suggestions",      featureKey: "suggestions", beta: false, wip: false },
  { name: m.nav_starboard(),           icon: "star",          href: "/starboard",        featureKey: "starboard", beta: true, wip: false },
  { name: m.nav_embeds(),              icon: "file-plus",     href: "/embed-builder",    featureKey: "embed_builder", beta: false, wip: false },
  { name: m.nav_regulation(),           icon: "book",          href: "/regulation",       featureKey: "regulation", beta: false, wip: false },
  { name: m.nav_news(),    icon: "rss",           href: "/news",             featureKey: "news", beta: false, wip: false },
  { name: m.nav_fun_channels(),          icon: "smile",         href: "/fun",              featureKey: "fun",  beta: false, wip: false },
  { name: m.nav_social_networks(),     icon: "share-2",       href: "/social-networks",  featureKey: "social_networks", beta: true, wip: false },
];

export const staffItems: PageConfig[] = [
  { name: m.nav_staff_directory(),            icon: "users",         href: "/staff-management/members", featureKey: "staff_directory", beta: false, wip: false },
  { name: m.nav_staff_hierarchy(),  icon: "shield",        href: "/staff-management/roles",   featureKey: "staff_roles", beta: false, wip: false },
  { name: m.nav_recruitment(),         icon: "user-plus",     href: "/recruitment",      featureKey: "recruitment", beta: false, wip: false },
  { name: m.nav_tickets(), icon: "message-square",href: "/tickets",          featureKey: "tickets", beta: false, wip: false },
// { name: m.nav_staff_evaluations(),   icon: "award",         href: "/evaluations",      featureKey: "staff_directory", beta: true, wip: false },
  { name: m.nav_tutoring(),             icon: "book-open",     href: "/tutoring",         featureKey: "tutoring", beta: false, wip: false },
  { name: m.nav_meetings(),            icon: "users",         href: "/meetings",         featureKey: "meetings", beta: false, wip: false },
  { name: m.nav_planning(),            icon: "calendar",      href: "/planning",         featureKey: "absences", beta: false, wip: false },
  { name: m.nav_polls(),            icon: "bar-chart",     href: "/staff-management/polls",    featureKey: "polls", beta: false, wip: false },
  { name: m.nav_discipline(),          icon: "alert-circle",  href: "/staff-management/warnings", featureKey: "discipline", beta: false, wip: false },
];

export const crossServerItems: PageConfig[] = [
  { name: m.nav_channel_links(),        icon: "link",          href: "/channel-links",      featureKey: "channel_links", beta: false, wip: false },
  { name: m.nav_staff_servers(),         icon: "shield",        href: "/staff-server",       featureKey: "staff_server", beta: false, wip: false },
];

export const configItems: PageConfig[] = [
  { name: m.nav_management_center(),   icon: "shield",        href: "/management",           featureKey: "centralized_config", beta: false, wip: false },
  { name: m.nav_modules(),             icon: "package",       href: "/modules",              featureKey: "modules", beta: false, wip: false },
  { name: m.nav_channel_health(),        icon: "activity",      href: "/channel-health",       featureKey: "channel_health", beta: true, wip: false },
  { name: m.nav_channels(),              icon: "hash",          href: "/channels-management",  featureKey: "auto_thread", beta: false, wip: false },
  { name: m.nav_commands(),           icon: "terminal",      href: "/command-access",       featureKey: "commands", beta: false, wip: false },
  { name: m.nav_backups(),         icon: "archive",        href: "/backups",              featureKey: "settings", beta: false, wip: false },
  { name: m.nav_schedules(),      icon: "calendar",      href: "/schedules",            featureKey: "settings", beta: false, wip: false },
  { name: m.nav_mcp_api(),             icon: "cpu",           href: "/mcp-settings",         featureKey: "settings", beta: false, wip: false },
  { name: m.nav_custom_bot(),          icon: "bot",           href: "/custom-bot",           featureKey: "settings", beta: false, wip: true, wipMessage: m.nav_custom_bot_wip() },
];

export const otherPages: PageConfig[] = [
  { name: m.nav_administration(),      icon: "lock",          href: "/admin",                beta: false, wip: false },
  // Hors des groupes de navigation : la facturation vit en bas de la barre
  // laterale, au-dessus du profil, comme l'entree Administration. Elle ne
  // s'affiche pas pour tout le monde (le payeur, l'administrateur, ou tout le
  // staff quand le serveur l'a autorise), et `featureKey: "settings"` - un
  // module du coeur - garantit qu'un serveur sans abonnement peut encore
  // l'atteindre pour souscrire.
  { name: m.nav_billing(),             icon: "credit-card",   href: "/billing",              featureKey: "settings", beta: false, wip: false },
  { name: m.nav_my_profile(),          icon: "user",          href: "/profile",              beta: false, wip: false },
  { name: m.nav_user_settings(), icon: "settings",   href: "/userSettings",         beta: false, wip: false },
];

export const allPages: PageConfig[] = [
  ...generalItems,
  ...moderationItems,
  ...securityItems,
  ...levelingItems,
  ...economyItems,
  ...communityItems,
  ...staffItems,
  ...crossServerItems,
  ...configItems,
  ...otherPages
];

export function getPageStatus(path: string, url: string = path): { beta: boolean; wip: boolean; name: string; wipMessage?: string } | null {
  // Le prefixe le plus long gagne : sans cela `/security` capterait
  // `/security/anti-raid` et la banniere afficherait le mauvais titre.
  const ordered = [...allPages].sort((a, b) => b.href.length - a.href.length);

  for (const page of ordered) {
    const [pPath, pQuery] = page.href.split('?');
    if (pQuery) {
      if (path === pPath && url.includes(pQuery)) {
        return { beta: isPageBeta(page), wip: isPageWip(page), name: page.name, wipMessage: page.wipMessage };
      }
    } else {
      if (path === pPath || (pPath !== '/' && path.startsWith(`${pPath}/`))) {
        return { beta: isPageBeta(page), wip: isPageWip(page), name: page.name, wipMessage: page.wipMessage };
      }
    }
  }
  return null;
}
