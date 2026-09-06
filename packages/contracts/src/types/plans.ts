/**
 * Registre des offres commerciales Kotbo - source de vérité unique.
 *
 * Kotbo est vendu **tout-en-un** : une offre payante ouvre l'intégralité du
 * catalogue, y compris les modules ajoutés plus tard. Ce fichier ne dit donc
 * plus *quels modules* sont vendus avec quelle offre - il n'y a plus de module
 * en plus ou en moins d'une offre à l'autre - mais *à quel serveur* s'adresse
 * quelle offre : le palier est décidé par la taille du serveur, pas par un
 * panier de fonctionnalités.
 *
 *   jusqu'à 1 000 membres       → Plus
 *   de 1 001 à 10 000 membres   → Pro
 *   de 10 001 à 100 000 membres → Ultimate
 *   au-delà de 100 000 membres  → Sur mesure (rendez-vous commercial)
 *
 * La seule frontière fonctionnelle qui subsiste est celle de `FREE`, qui
 * n'ouvre **aucun** module : Kotbo est un outil professionnel, pas un bot
 * public que l'on branche pour trois commandes. Un serveur sans abonnement
 * garde uniquement les pages du cœur (tableau de bord, modules, réglages,
 * facturation), le temps de souscrire.
 *
 * Le lien avec `MODULE_REGISTRY` se fait par `planIncludesModule`, consulté par
 * `moduleGate` côté bot (garde d'exécution) et par le dashboard (affichage du
 * cadenas).
 *
 * Ce paquet ne dépend de rien (ni Prisma, ni Stripe, ni discord.js) : le bot,
 * le dashboard et les scripts l'importent tel quel. Les identifiants Stripe ne
 * sont donc **pas** ici - ils vivent dans les variables d'environnement, dont ce
 * fichier ne connaît que les noms.
 */

import { MODULE_REGISTRY } from './modules.js';

/**
 * Offres, de la plus faible à la plus forte. L'ordre du tableau fait foi pour
 * `comparePlans` : un plan situé plus loin inclut tout ce que porte le précédent.
 *
 * - `FREE`     : état d'un serveur sans abonnement. Aucun module ouvert : le
 *                bot est présent mais inerte tant que rien n'est souscrit.
 * - `PLUS`     : offre des petits serveurs, jusqu'à 1 000 membres. Même produit
 *                que les autres, au tarif de leur taille : c'est l'entrée de
 *                gamme, pas une version amputée.
 * - `PRO`      : offre des serveurs de 1 001 à 10 000 membres, en libre-service.
 * - `ULTIMATE` : même produit, pour les serveurs de 10 001 à 100 000 membres.
 * - `CUSTOM`   : au-delà de 100 000 membres, ou accord négocié (white-label,
 *                partenariat). Jamais vendu par Stripe en libre-service : il est
 *                posé à la main depuis l'administration.
 */
export const PLAN_KEYS = ['FREE', 'PLUS', 'PRO', 'ULTIMATE', 'CUSTOM'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Offres payantes, celles qu'un palier de taille peut désigner. */
export type PaidPlanKey = Exclude<PlanKey, 'FREE'>;

/** Périodicité de facturation. Une offre peut n'en proposer aucune (FREE, CUSTOM). */
export type BillingInterval = 'month' | 'year';

/**
 * Tranche de taille servie par une offre. `max: null` = pas de plafond.
 * Bornes exprimées en nombre de membres Discord du serveur.
 */
export interface PlanMemberRange {
  min: number;
  max: number | null;
}

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  /** Accroche courte, affichée sur la carte de l'offre. */
  tagline: string;
  description: string;
  /**
   * Modules débloqués, en plus des modules `core` (toujours inclus, quel que
   * soit le plan : sans eux le serveur n'est plus administrable, et il faut
   * bien pouvoir atteindre la page de facturation pour s'abonner).
   *
   * `'all'` débloque tout le catalogue, y compris les modules ajoutés plus tard.
   * Toutes les offres payantes sont dans ce cas - c'est la promesse tout-en-un.
   */
  modules: 'all' | string[];
  /**
   * Taille de serveur à laquelle l'offre s'adresse, ou `null` pour `FREE` qui
   * n'est pas un palier mais l'absence d'abonnement. C'est cette tranche qui
   * décide de l'offre proposée : elle n'est pas un conseil, elle est la règle
   * (voir `planForMemberCount`).
   */
  memberRange: PlanMemberRange | null;
  /**
   * Noms des variables d'environnement portant les identifiants de prix Stripe
   * (`price_...`). On stocke le *nom* et pas la valeur pour que ce fichier reste
   * publiable et identique entre test et production - seul le `.env` change.
   *
   * `null` pour les offres qui ne passent pas par Stripe.
   */
  priceEnv: { month: string; year: string } | null;
  /**
   * Tarif affiché, en centimes d'euro. Purement indicatif pour l'abonnement :
   * le montant réellement débité est celui du prix Stripe. Sert à peindre la
   * page tarifs sans un appel à l'API Stripe à chaque chargement, et à calculer
   * le montant d'un cadeau (`giftPriceCents`).
   */
  displayPriceCents: { month: number; year: number } | null;
  /** Vendue en libre-service depuis le dashboard (bouton « S'abonner »). */
  selfServe: boolean;
}

export const PLAN_REGISTRY: PlanDefinition[] = [
  {
    key: 'FREE',
    name: 'Gratuit',
    tagline: 'Le bot est là, rien n\'est ouvert.',
    description:
      "État d'un serveur sans abonnement : aucun module n'est actif. Kotbo est un outil de gestion professionnel, pas un bot public - seules les pages de configuration restent accessibles, le temps de choisir une offre.",
    modules: [],
    memberRange: null,
    priceEnv: null,
    displayPriceCents: null,
    selfServe: false,
  },
  {
    key: 'PLUS',
    name: 'Plus',
    tagline: 'Tout Kotbo, pour un serveur jusqu\'à 1 000 membres.',
    description:
      "Le catalogue complet, au tarif d'un petit serveur : quelques centaines de membres n'ont pas à payer le prix d'une communauté de dix mille. Exactement les mêmes modules que Pro et Ultimate, rien n'est réservé au palier au-dessus.",
    modules: 'all',
    memberRange: { min: 0, max: 1_000 },
    priceEnv: { month: 'STRIPE_PRICE_PLUS_MONTHLY', year: 'STRIPE_PRICE_PLUS_YEARLY' },
    displayPriceCents: { month: 500, year: 3_000 },
    selfServe: true,
  },
  {
    key: 'PRO',
    name: 'Pro',
    tagline: 'Tout Kotbo, pour un serveur de 1 001 à 10 000 membres.',
    description:
      "L'intégralité du catalogue : modération, staff, progression, économie, tickets, événements, contenu, intégrations, cross-serveur. Rien n'est en option, et les modules ajoutés plus tard sont inclus d'office.",
    modules: 'all',
    memberRange: { min: 1_001, max: 10_000 },
    priceEnv: { month: 'STRIPE_PRICE_PRO_MONTHLY', year: 'STRIPE_PRICE_PRO_YEARLY' },
    displayPriceCents: { month: 999, year: 4_999 },
    selfServe: true,
  },
  {
    key: 'ULTIMATE',
    name: 'Ultimate',
    tagline: 'Le même Kotbo, dimensionné au-dessus de 10 000 membres.',
    description:
      "Exactement les mêmes fonctionnalités que Pro - tout le catalogue - mais pour une communauté de 10 001 à 100 000 membres : volume de traitement, quotas et accompagnement suivent la taille du serveur.",
    modules: 'all',
    memberRange: { min: 10_001, max: 100_000 },
    priceEnv: { month: 'STRIPE_PRICE_ULTIMATE_MONTHLY', year: 'STRIPE_PRICE_ULTIMATE_YEARLY' },
    displayPriceCents: { month: 2_500, year: 14_999 },
    selfServe: true,
  },
  {
    key: 'CUSTOM',
    name: 'Sur mesure',
    tagline: 'Au-delà de 100 000 membres, on en parle.',
    description:
      "Tout le catalogue, sur des conditions convenues au cas par cas : volumétrie, infrastructure dédiée, white-label, partenariat. Se met en place après un rendez-vous, jamais souscrit en ligne.",
    modules: 'all',
    memberRange: { min: 100_001, max: null },
    priceEnv: null,
    displayPriceCents: null,
    selfServe: false,
  },
];

/**
 * Prise de rendez-vous commercial. Unique adresse de contact affichée par le
 * dashboard et le bot : la mettre ici évite qu'un lien mort survive dans un
 * coin de l'interface parce qu'on a oublié un `href`.
 */
export const SALES_CONTACT_URL = 'https://pros.kotbo.fr/rdv';

const PLAN_BY_KEY = new Map(PLAN_REGISTRY.map((plan) => [plan.key, plan]));

/** Rang d'une offre dans l'échelle. Sert aux comparaisons « au moins ». */
const PLAN_RANK: Record<PlanKey, number> = {
  FREE: 0,
  PLUS: 1,
  PRO: 2,
  ULTIMATE: 3,
  // Un accord sur mesure débloque tout : il se compare comme le sommet de
  // l'échelle, même s'il ne s'achète pas.
  CUSTOM: 4,
};

/**
 * Ramène une valeur venue de la base ou d'une requête à une offre connue. Toute
 * valeur inattendue retombe sur `FREE` : en cas de donnée corrompue, on ferme,
 * on n'ouvre pas.
 */
export function normalizePlanKey(value: unknown): PlanKey {
  const candidate = typeof value === 'string' ? value.toUpperCase() : '';
  return (PLAN_KEYS as readonly string[]).includes(candidate) ? (candidate as PlanKey) : 'FREE';
}

export function getPlanDefinition(plan: PlanKey): PlanDefinition {
  return PLAN_BY_KEY.get(plan) ?? PLAN_BY_KEY.get('FREE')!;
}

/** Négatif si `a` est en dessous de `b`, 0 si égal, positif si au-dessus. */
export function comparePlans(a: PlanKey, b: PlanKey): number {
  return PLAN_RANK[a] - PLAN_RANK[b];
}

// ─────────────────────────────────────────────────────────────
// Palier commercial : c'est la taille du serveur qui décide
// ─────────────────────────────────────────────────────────────

/**
 * Seuils de bascule, en nombre de membres. Écrits ici et nulle part ailleurs :
 * le dashboard les affiche, la route de paiement les fait respecter, et les
 * deux doivent dire la même chose.
 */
export const PLAN_MEMBER_THRESHOLDS = {
  /** Au-delà de ce nombre de membres, Plus ne suffit plus. */
  PRO: 1_000,
  /** Au-delà de ce nombre de membres, Pro ne suffit plus. */
  ULTIMATE: 10_000,
  /** Au-delà de ce nombre de membres, plus rien ne se vend en ligne. */
  CUSTOM: 100_000,
} as const;

/**
 * Offre qui correspond à un serveur de cette taille. C'est la seule offre
 * payante qu'il puisse souscrire : les fonctionnalités étant identiques
 * partout, laisser le choix reviendrait à laisser un serveur de 80 000 membres
 * payer le tarif d'un serveur de 500.
 *
 * Un nombre de membres inconnu (cache du bot pas encore rempli, serveur
 * injoignable) retombe sur `PRO` : ni l'offre la plus chère, qu'on n'a aucune
 * raison de pousser sur la foi d'une donnée manquante, ni la moins chère, qui
 * laisserait un serveur de 50 000 membres payer le tarif d'un salon de 200.
 */
export function planForMemberCount(memberCount: number | null | undefined): PaidPlanKey {
  if (typeof memberCount !== 'number' || !Number.isFinite(memberCount)) return 'PRO';
  if (memberCount > PLAN_MEMBER_THRESHOLDS.CUSTOM) return 'CUSTOM';
  if (memberCount > PLAN_MEMBER_THRESHOLDS.ULTIMATE) return 'ULTIMATE';
  if (memberCount > PLAN_MEMBER_THRESHOLDS.PRO) return 'PRO';
  return 'PLUS';
}

/**
 * Ce serveur peut-il souscrire cette offre en ligne ?
 *
 * `CUSTOM` répond toujours faux : il passe par un rendez-vous, pas par Stripe.
 */
export function canPurchasePlan(plan: PlanKey, memberCount: number | null | undefined): boolean {
  return getPlanDefinition(plan).selfServe && planForMemberCount(memberCount) === plan;
}

// ─────────────────────────────────────────────────────────────
// Modules ouverts par une offre
// ─────────────────────────────────────────────────────────────

/**
 * Clés des modules ouverts par une offre, modules `core` compris. Toujours une
 * liste concrète, y compris pour `'all'`, pour être affichable telle quelle.
 */
export function modulesForPlan(plan: PlanKey): string[] {
  const definition = getPlanDefinition(plan);
  if (definition.modules === 'all') return MODULE_REGISTRY.map((m) => m.key);

  const included = new Set(definition.modules);
  for (const mod of MODULE_REGISTRY) {
    if (mod.core) included.add(mod.key);
  }
  return MODULE_REGISTRY.filter((m) => included.has(m.key)).map((m) => m.key);
}

const MODULES_BY_PLAN = new Map<PlanKey, Set<string>>(
  PLAN_KEYS.map((key) => [key, new Set(modulesForPlan(key))]),
);

/**
 * L'offre `plan` donne-t-elle accès au module `moduleKey` ?
 *
 * Un module inconnu du registre est considéré inclus : la grille tarifaire ne
 * doit pas fermer une fonctionnalité qu'elle ne sait pas décrire - même règle
 * que `moduleGate`, pour que les deux gardes se comportent pareil.
 */
export function planIncludesModule(plan: PlanKey, moduleKey: string): boolean {
  if (!MODULE_REGISTRY.some((m) => m.key === moduleKey)) return true;
  return MODULES_BY_PLAN.get(plan)?.has(moduleKey) ?? false;
}

/**
 * Offre la plus basse qui ouvre ce module. `null` si le module est déjà ouvert
 * sans abonnement - ce qui, désormais, ne concerne que les modules du cœur.
 *
 * Les offres payantes étant identiques, la réponse est toujours `PLUS` pour
 * un module verrouillé. Le dashboard n'affiche pas cette valeur telle quelle : il
 * propose l'offre correspondant à la taille du serveur (`planForMemberCount`),
 * seule réellement achetable.
 */
export function lowestPlanWithModule(moduleKey: string): PlanKey | null {
  if (planIncludesModule('FREE', moduleKey)) return null;
  for (const key of PLAN_KEYS) {
    if (key === 'CUSTOM' || key === 'FREE') continue;
    if (planIncludesModule(key, moduleKey)) return key;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Essai gratuit
// ─────────────────────────────────────────────────────────────

/**
 * Durée de l'essai gratuit offert à la première souscription, en jours.
 *
 * Ici et pas dans une variable d'environnement : la durée est un engagement
 * commercial affiché sur la page tarifs et dans les CGU, elle doit être la même
 * sur toutes les instances et lisible depuis le dashboard comme depuis le bot.
 * Stripe n'en garde aucune trace côté prix - c'est le paramètre
 * `trial_period_days` de la session de paiement qui la porte, à chaque fois.
 */
export const TRIAL_DAYS = 15;

/**
 * Cette offre ouvre-t-elle droit à l'essai gratuit ?
 *
 * Seules les offres vendues en libre-service : `FREE` n'a rien à essayer, et un
 * accord `CUSTOM` se négocie, période de découverte comprise.
 */
export function planAllowsTrial(plan: PlanKey): boolean {
  return getPlanDefinition(plan).selfServe;
}

// ─────────────────────────────────────────────────────────────
// Offrir Kotbo
// ─────────────────────────────────────────────────────────────

/**
 * Durées proposées quand on offre Kotbo à un serveur, en mois.
 *
 * Un cadeau n'est pas un abonnement : c'est un paiement unique qui ouvre une
 * offre pour une durée fixe, sans reconduction ni carte enregistrée chez le
 * bénéficiaire. Le bénéficiaire n'a donc rien à résilier quand la période
 * s'achève - le serveur retombe simplement sur `FREE`.
 */
export const GIFT_DURATIONS_MONTHS = [1, 3, 6, 12] as const;
export type GiftDurationMonths = (typeof GIFT_DURATIONS_MONTHS)[number];

export function isGiftDuration(months: number): months is GiftDurationMonths {
  return (GIFT_DURATIONS_MONTHS as readonly number[]).includes(months);
}

/**
 * Montant d'un cadeau, en centimes d'euro, ou `null` si l'offre n'a pas de
 * tarif public (`FREE`, `CUSTOM` : on n'offre pas un accord négocié).
 *
 * Contrairement à l'abonnement, ce montant est bien celui qui sera débité : un
 * cadeau n'a pas de prix Stripe préenregistré, il est facturé à la volée à
 * partir de cette valeur.
 */
export function giftPriceCents(plan: PlanKey, months: number): number | null {
  const prices = getPlanDefinition(plan).displayPriceCents;
  if (!prices || !isGiftDuration(months)) return null;
  // Douze mois = le tarif annuel, remise comprise : offrir un an ne doit pas
  // coûter plus cher que s'abonner un an soi-même.
  return months === 12 ? prices.year : prices.month * months;
}
