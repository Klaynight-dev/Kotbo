/** Mise en place guidee du serveur. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type ServerTemplateSection =
  | 'access' | 'security' | 'staff' | 'captcha' | 'tickets' | 'welcome' | 'stats' | 'text' | 'fun' | 'bots' | 'voice' | 'modules';
export type ServerTemplateWiring =
  | 'staff' | 'logs' | 'tickets' | 'leveling' | 'rpg' | 'tempvoice' | 'welcome' | 'rules' | 'member' | 'captcha' | 'honeypot' | 'starboard' | 'stats' | 'autothread' | null;
/** A qui le salon s'ouvre : tout le plan etant ferme a @everyone, c'est ce qui les distingue. */
export type ServerTemplateAudience = 'staff' | 'member' | 'pending' | 'everyone';

export type ServerTemplatePlanItem = {
  key: string;
  section: ServerTemplateSection;
  kind: 'role' | 'category' | 'text' | 'voice' | 'module';
  parent: string | null;
  name: string;
  wiring: ServerTemplateWiring;
  audience: ServerTemplateAudience;
  readOnly: boolean;
  required: boolean;
  /** Module du dashboard active par cet element. */
  moduleId: string | null;
  /** Salon dont la creation coche ce module. */
  linkedTo: string | null;
  /** Element sans lequel celui-ci ne fonctionne pas : le cocher le ramene. */
  dependsOn: string | null;
};

export type ServerTemplateState = {
  locale: 'fr' | 'en';
  plan: ServerTemplatePlanItem[];
  /**
   * Clefs de la maquette que le serveur porte deja.
   *
   * Rapprochees cote bot par identifiant enregistre, puis par nom normalise.
   * Vide sur un serveur neuf ; sur un serveur habite, c'est ce qui permet a la
   * reprise de completer au lieu de doubler `#reglement` et `#bienvenue`.
   */
  present: string[];
  /**
   * Le meme constat, avec ce qui l'a produit.
   *
   * `present` dit qu'un element est deja la ; il ne dit pas lequel, et c'est ce
   * qui manquait pour poser la question. Ici chaque clef du plan pointe le
   * salon ou le role reconnu, et dit si le rapprochement est certain - un
   * identifiant que Kotbo avait enregistre - ou devine sur la ressemblance du
   * nom. Les ecrans de mappage pre-remplissent avec, et laissent corriger : un
   * `#logs-mod` que la ressemblance n'attrape pas se designe a la main plutot
   * que de se faire doubler.
   */
  matches: Record<string, { id: string; name: string; source: 'ref' | 'name' }>;
  /**
   * Les salons et roles reels du serveur, matiere des menus « utiliser
   * l'existant ». Bornee cote bot : au-dela de quelques centaines d'entrees, un
   * menu deroulant n'est plus l'outil.
   */
  inventory: {
    channels: { id: string; name: string; kind: 'text' | 'voice' | 'category'; parentId: string | null; position: number }[];
    roles: { id: string; name: string; color: string; position: number; assignable: boolean; managed: boolean }[];
  };
  /**
   * Le serveur porte deja quelque chose qui lui est propre.
   *
   * Lu sur les faits - un element du plan reconnu, ou des salons en nombre que
   * Kotbo n'a pas poses - et non sur la reponse a l'ecran « neuf ou existant ».
   * C'est ce qui fait basculer le parcours en mode detaille, ou l'on dit quel
   * salon est quoi section par section, au lieu de tout poser d'un bloc.
   */
  structured: boolean;
  defaultSelection: string[];
  missingPermissions: string[];
  canCreateChannels: boolean;
  /** Un salon de logs est deja configure : la sante des salons a ou parler. */
  hasLogChannel: boolean;
  isAdministrator: boolean;
  /**
   * Serveur neuf a batir, ou serveur habite a reprendre. Lu sur les faits (age,
   * membres, salons, roles) et non demande a l'administrateur : il repond
   * « nouveau serveur » parce que Kotbo est nouveau pour lui, pas parce que le
   * serveur l'est.
   */
  maturity: {
    maturity: 'fresh' | 'established';
    ageDays: number;
    /** Ce qui a fait pencher la balance, affiche tel quel. */
    reasons: string[];
  };
  /**
   * Maquette complete. Sur un serveur habite, `defaultSelection` n'en retient
   * que les modules : ce champ permet de proposer quand meme tout cocher, sans
   * que la page ait a reconstruire la liste.
   */
  fullSelection: string[];
  applied: { at: string; by: string | null; selection: string[] } | null;
};

export type ServerTemplateApplyResult = {
  success: boolean;
  items: { key: string; id: string; name: string; created: boolean }[];
  modules: string[];
  /**
   * Modules configures mais encore inertes, faute d'abonnement. Ils s'allument
   * seuls le jour ou le serveur souscrit : rien a rejouer, la mise en place n'a
   * pas a etre refaite.
   */
  preparedModules: string[];
  /** Etapes facultatives qui n'ont pas abouti, sans arreter la mise en place. */
  warnings: string[];
  panelSent: boolean;
};

export async function fetchServerTemplate(guildId = authStore.selectedGuildId): Promise<ServerTemplateState> {
  return dashboardRequest('/server-template', { method: 'GET', guildId, errorContext: 'API Error (Server Template):' });
}

/**
 * Ce que le serveur avait deja fait quand la mise en place s'est interrompue.
 * `appliedAt` distingue le refus d'une mise en place menee ailleurs de celui
 * d'une mise en place encore en cours : la premiere est definitive, la seconde
 * se retente.
 */
export type ServerTemplateApplyFailure = Partial<ServerTemplateApplyResult> & {
  error?: string;
  appliedAt?: string;
};

/**
 * Pose la selection, en adoptant ce que l'administrateur a designe.
 *
 * `adopt` porte les clefs du plan qu'un salon ou un role existant remplit deja.
 * Le bot les fait entrer dans sa trace avant de poser quoi que ce soit : ces
 * elements sont alors repris tels quels - ni renommes, ni deplaces, ni
 * repermissionnes - et seul ce qui reste dans `selection` sans y figurer est
 * reellement cree.
 */
export async function applyServerTemplate(
  selection: string[],
  adopt: Record<string, string> = {},
  guildId = authStore.selectedGuildId,
): Promise<ServerTemplateApplyResult> {
  return dashboardRequest('/server-template/apply', {
    method: 'POST',
    payload: { selection, adopt },
    guildId,
    errorContext: 'API Error (Server Template Apply):',
    // La page rend elle-meme le detail de ce qui a ete cree, et son propre
    // message d'erreur : le toast generique du socle ferait doublon.
    silent: true,
  });
}

// ── Créations à la demande du parcours ───────────────────────────────────────

/**
 * L'usage d'un salon que le parcours sait poser lui-même.
 *
 * Ce ne sont pas des salons quelconques : chacun correspond à une liste
 * déroulante d'un écran, et c'est le seul endroit où le manque se constate.
 */
export type OnboardingChannelPurpose = 'logs' | 'staffAlerts' | 'drops';

export type OnboardingChannelResult = { id: string; name: string; created: boolean };

/**
 * Crée le salon dont un écran a besoin, quand le serveur n'en a aucun.
 *
 * Sans cela, il fallait quitter le parcours, aller créer un `#log` sur
 * Discord, revenir et rafraîchir : trois gestes hors du produit, au moment
 * même où on essaie de le montrer.
 */
export async function createOnboardingChannel(
  purpose: OnboardingChannelPurpose,
  guildId = authStore.selectedGuildId,
): Promise<OnboardingChannelResult> {
  return dashboardRequest('/server-template/channel', {
    method: 'POST',
    payload: { purpose },
    guildId,
    errorContext: 'API Error (Onboarding Channel):',
    silent: true,
  });
}

/** Ce qu'un rôle créé par le parcours peut faire, en échelons fermés côté bot. */
export type StaffRolePower = 'admin' | 'manage' | 'moderate' | 'coordinate' | 'assist' | 'none';

export type OnboardingRoleRequest = {
  key: string;
  name: string;
  color?: string;
  hoist?: boolean;
  power?: StaffRolePower;
};

export type OnboardingRolesResult = {
  roles: { key: string; id: string; name: string; created: boolean; color: string | null }[];
  warnings: string[];
};

/**
 * Crée une hiérarchie de rôles, du plus haut au plus bas.
 *
 * L'ordre du tableau est celui de la hiérarchie voulue : le bot s'en sert tel
 * quel, Discord empilant chaque nouveau rôle sous le précédent.
 */
export async function createOnboardingRoles(
  roles: OnboardingRoleRequest[],
  guildId = authStore.selectedGuildId,
): Promise<OnboardingRolesResult> {
  return dashboardRequest('/server-template/roles', {
    method: 'POST',
    payload: { roles },
    guildId,
    errorContext: 'API Error (Onboarding Roles):',
    silent: true,
  });
}
