/**
 * Étapes du tunnel d'acquisition - source de vérité unique.
 *
 * Le bot, le dashboard et la landing écrivent tous dans le même journal. Sans
 * liste fermée partagée, chacun inventerait ses propres noms d'étapes et le
 * tunnel deviendrait illisible six mois plus tard : `paiement`, `payment`,
 * `first_payment` et `paid` désignant la même chose sans qu'aucune requête ne
 * puisse les réunir.
 *
 * D'où une énumération et une fonction de validation, plutôt qu'un `string`.
 * L'API publique qui reçoit les événements de la landing rejette ce qui n'est
 * pas dans cette liste : elle est ouverte à Internet, et une colonne `step`
 * alimentée par n'importe quelle chaîne venue du navigateur serait autant un
 * problème de données qu'un problème de sécurité.
 *
 * Ce paquet ne dépend de rien (ni Prisma, ni Stripe, ni discord.js) : les trois
 * applications l'importent tel quel.
 */

/**
 * Amont du tunnel : ce qui se passe avant qu'un serveur n'existe.
 *
 * Ces étapes n'ont pas de `guildId` - il n'y a pas encore de serveur - mais un
 * `visitorId` de session, seul moyen de relier « a lu les tarifs » à « a posé
 * le bot ». C'est aussi le seul segment du tunnel qui dépend de la landing.
 */
export const ACQUISITION_STEPS_UPSTREAM = [
  /** Première page de kotbo.fr dans la session. `metadata.referrer`, `metadata.path`. */
  'site_visit',
  /** Section tarifs réellement affichée à l'écran, pas seulement présente dans le DOM. */
  'pricing_viewed',
  'comparison_viewed',
  'faq_opened',
  /** Clic sur « Prendre rendez-vous » (offre Sur mesure). */
  'sales_clicked',
  /** Clic sur un bouton d'invitation. `content` dit lequel. */
  'invite_clicked',
  /** Passage effectif par `/api/public/invite`. */
  'invite_redirected',
  /** Arrivée sur « Mes serveurs » avec une provenance connue. */
  'dashboard_servers_seen',
  /** Départ vers l'écran d'autorisation Discord. */
  'discord_authorize_opened',
] as const;

/** Installation et prise en main : le serveur existe, il n'a encore rien payé. */
export const ACQUISITION_STEPS_ONBOARDING = [
  'bot_joined',
  'bot_reinstalled',
  'dashboard_first_open',
  'onboarding_started',
  /** Une étape du parcours validée. `metadata.step` porte laquelle. */
  'onboarding_step',
  /** Retour en arrière : signale une étape mal comprise, pas un abandon. */
  'onboarding_back',
  /** Posé par le cron après 72 h sans progression. */
  'onboarding_abandoned',
  'onboarding_completed',
] as const;

/** Paiement : de la page tarifs au premier prélèvement. */
export const ACQUISITION_STEPS_BILLING = [
  'plan_viewed',
  'checkout_started',
  'checkout_abandoned',
  'trial_reserved',
  'trial_started',
  'trial_converted',
  'trial_expired',
  'first_payment',
  'payment',
  'payment_failed',
  'plan_upgraded',
  'plan_downgraded',
  'gift_redeemed',
  'code_activated',
] as const;

/** Sortie : tout ce qui fait perdre un serveur, ou son argent. */
export const ACQUISITION_STEPS_CHURN = [
  'cancel_scheduled',
  'cancel_reverted',
  'subscription_ended',
  'access_expired',
  'bot_removed',
] as const;

export const ACQUISITION_STEPS = [
  ...ACQUISITION_STEPS_UPSTREAM,
  ...ACQUISITION_STEPS_ONBOARDING,
  ...ACQUISITION_STEPS_BILLING,
  ...ACQUISITION_STEPS_CHURN,
] as const;

export type AcquisitionStep = (typeof ACQUISITION_STEPS)[number];

const STEP_SET = new Set<string>(ACQUISITION_STEPS);

/** Étape connue ? Utilisé pour filtrer ce qui arrive de la landing. */
export function isAcquisitionStep(value: unknown): value is AcquisitionStep {
  return typeof value === 'string' && STEP_SET.has(value);
}

/**
 * Étapes qu'un visiteur anonyme a le droit de déclarer.
 *
 * La route publique ne fait confiance à personne : sans ce filtre, n'importe
 * qui pourrait poster `first_payment` en boucle et rendre les revenus
 * fantaisistes. Tout ce qui touche à l'argent, à l'installation ou au départ
 * n'est écrit que par le bot, à partir de faits qu'il constate lui-même.
 */
const PUBLIC_STEP_SET = new Set<string>(ACQUISITION_STEPS_UPSTREAM);

export function isPublicAcquisitionStep(value: unknown): value is AcquisitionStep {
  return typeof value === 'string' && PUBLIC_STEP_SET.has(value);
}

// ─────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────

/**
 * Canal par lequel un visiteur est arrivé sur le site, déduit du référent.
 *
 * Kotbo n'est diffusé aujourd'hui que par deux voies : Discord et la recherche
 * Google. Le paramètre `utm_source` ne dit pas laquelle - il dit seulement
 * quelle *surface* a produit le clic d'invitation, et vaut `landing` dans les
 * deux cas. C'est donc le référent de la première visite qui répond à « combien
 * viennent de Google ».
 *
 * Seule la catégorie est conservée, jamais l'URL référente complète : celle
 * d'un moteur de recherche peut contenir la requête tapée, donc une donnée
 * personnelle. La liste reste courte et fermée, `other` absorbant le reste :
 * on ne code pas des provenances qui n'existent pas encore.
 */
export const ACQUISITION_REFERRERS = [
  'google',
  'bing',
  'duckduckgo',
  'discord',
  /** Navigation interne au site : ne compte pas comme une nouvelle provenance. */
  'internal',
  /** Aucun référent : saisie directe, favori, application native. */
  'direct',
  'other',
] as const;

export type AcquisitionReferrer = (typeof ACQUISITION_REFERRERS)[number];

const REFERRER_HOSTS: ReadonlyArray<readonly [RegExp, AcquisitionReferrer]> = [
  [/(^|\.)google\./i, 'google'],
  [/(^|\.)bing\./i, 'bing'],
  [/(^|\.)duckduckgo\./i, 'duckduckgo'],
  [/(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/i, 'discord'],
  [/(^|\.)kotbo\.fr$/i, 'internal'],
];

/**
 * Classe un référent en canal. Ne reçoit que l'hôte en pratique, mais accepte
 * une URL complète pour que l'appelant n'ait pas à la découper - et surtout
 * pour qu'il n'ait jamais de raison de transmettre autre chose que le résultat.
 */
export function classifyReferrer(referrer: string | null | undefined): AcquisitionReferrer {
  if (!referrer) return 'direct';

  let host = referrer.trim();
  if (!host) return 'direct';

  try {
    host = new URL(host).hostname;
  } catch {
    // Déjà un nom d'hôte, ou une valeur inexploitable : on tente tel quel.
    host = host.replace(/^https?:\/\//i, '').split('/')[0] ?? '';
  }

  if (!host) return 'direct';

  for (const [pattern, channel] of REFERRER_HOSTS) {
    if (pattern.test(host)) return channel;
  }
  return 'other';
}

/**
 * Surfaces d'où part un clic d'invitation, telles que `utm_source` les nomme.
 * Reprend la liste déjà appliquée par la route publique d'invitation.
 */
export const ACQUISITION_SOURCES = ['landing', 'docs', 'discord', 'dashboard', 'direct', 'other'] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

const SOURCE_SET = new Set<string>(ACQUISITION_SOURCES);

export function normalizeAcquisitionSource(value: unknown): AcquisitionSource {
  if (typeof value !== 'string') return 'direct';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return 'direct';
  return SOURCE_SET.has(trimmed) ? (trimmed as AcquisitionSource) : 'other';
}

/**
 * Origine de l'activation d'un serveur, pour l'axe « qu'est-ce qui rapporte ».
 * Distincte de la provenance du clic : un serveur peut arriver depuis Google
 * puis être activé par un code partenaire.
 */
export const ACTIVATION_ORIGINS = ['SELF_SERVE', 'CODE', 'STAFF_LINK', 'GIFT', 'ADMIN'] as const;
export type ActivationOrigin = (typeof ACTIVATION_ORIGINS)[number];

/** Motif de sortie, renseigné sur `GuildLifecycle` au moment du churn. */
export const CHURN_REASONS = [
  'VOLUNTARY',
  'PAYMENT_FAILED',
  'TRIAL_EXPIRED',
  'BOT_REMOVED',
  'DOWNGRADE',
] as const;
export type ChurnReason = (typeof CHURN_REASONS)[number];

// ─────────────────────────────────────────────────────────────
// Segmentation
// ─────────────────────────────────────────────────────────────

/**
 * Tranches de taille de serveur.
 *
 * Volontairement plus fines que les paliers tarifaires : `PRO` couvre de 0 à
 * 10 000 membres, or un serveur de 80 membres et un serveur de 9 000 ne se
 * comportent pas de la même façon - ni à la conversion, ni à la rétention. Les
 * bornes 10 000 et 100 000 restent présentes pour pouvoir recoller aux paliers.
 */
export const SIZE_BUCKETS = [
  { key: '0-100', min: 0, max: 100 },
  { key: '100-1k', min: 101, max: 1_000 },
  { key: '1k-10k', min: 1_001, max: 10_000 },
  { key: '10k-100k', min: 10_001, max: 100_000 },
  { key: '100k+', min: 100_001, max: null },
] as const;

export type SizeBucketKey = (typeof SIZE_BUCKETS)[number]['key'];

export function sizeBucketFor(memberCount: number | null | undefined): SizeBucketKey {
  const count = typeof memberCount === 'number' && Number.isFinite(memberCount) ? memberCount : 0;
  for (const bucket of SIZE_BUCKETS) {
    if (count >= bucket.min && (bucket.max === null || count <= bucket.max)) return bucket.key;
  }
  return '100k+';
}

/**
 * Axes de découpage des instantanés quotidiens.
 *
 * `AnalyticsDailySnapshot` porte une ligne par couple (axe, valeur) plutôt
 * qu'une colonne par métrique et par axe : ajouter un axe ne demande alors
 * aucune migration. `global` est l'axe sans découpage, dont la valeur est vide.
 */
export const ANALYTICS_DIMENSIONS = [
  'global',
  'plan',
  'size',
  'source',
  'origin',
  'kind',
  'instance',
  'locale',
  'interval',
] as const;

export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

/**
 * Écrans du parcours de configuration, dans l'ordre.
 *
 * Vivait dans le dashboard seul. Le bot en a besoin pour la seule chose que
 * l'ordre permet de trancher : distinguer une avancée d'un retour en arrière.
 * Le parcours envoie son état complet à chaque clic, jamais « je viens de
 * franchir tel écran » - sans cet ordre, un visiteur qui revient sur ses pas
 * serait compté comme progressant, et l'entonnoir ne montrerait aucun
 * décrochage.
 *
 * Le parcours est à embranchements : une piste décochée saute des écrans. Un
 * taux d'abandon se calcule donc **sur les serveurs pour qui l'écran était au
 * programme**, jamais sur tous - sinon un écran sauté par construction ressort
 * comme un point de décrochage.
 */
export const ONBOARDING_STEPS = [
  'welcome',
  'kind',
  'migration-bots',
  'migration-findings',
  'tracks',
  'identity',
  'theme',
  'tickets',
  // Le mappage d'un serveur deja habite : quel salon, quel role tient deja
  // chacun des roles du plan. Sautes entierement sur un serveur neuf, ou il n'y
  // a rien a rapprocher - l'entonnoir ne les compte donc que pour les serveurs
  // a qui ils ont ete proposes, comme toute piste decochable.
  'map-access',
  'map-staff',
  'map-tickets',
  'map-welcome',
  'map-stats',
  'map-text',
  'map-fun',
  'map-voice',
  'structure',
  'moderation',
  'logs',
  'staff',
  'greeting',
  'rules',
  'levels',
  'economy',
  'economy-shop',
  'animation',
  'animation-drops',
  'mcp',
  'recap',
  'checkout',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const ONBOARDING_ORDER = new Map<string, number>(
  ONBOARDING_STEPS.map((step, index) => [step, index]),
);

/**
 * Le passage de `from` vers `to` est-il un retour en arrière ?
 *
 * Faux quand l'un des deux écrans est inconnu : en cas de doute on compte une
 * avancée, un faux retour polluant l'entonnoir plus qu'une avancée manquée.
 */
export function isOnboardingBacktrack(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!from || !to) return false;
  const a = ONBOARDING_ORDER.get(from);
  const b = ONBOARDING_ORDER.get(to);
  if (a === undefined || b === undefined) return false;
  return b < a;
}

/**
 * Durée de conservation du journal détaillé, en jours.
 *
 * Treize mois et non douze : comparer un mois à celui de l'année précédente
 * suppose que le second soit encore là au moment où l'on regarde le premier.
 * Les instantanés agrégés, eux, ne portent aucun identifiant et sont conservés
 * sans limite.
 */
export const ACQUISITION_EVENT_RETENTION_DAYS = 396;

/**
 * Durée de vie d'un identifiant de visite, en jours.
 *
 * Court par construction : c'est ce qui maintient la mesure dans l'exemption de
 * consentement prévue par la CNIL pour la mesure d'audience. L'allonger, ou le
 * rapprocher d'un compte Discord nominatif, ferait retomber le site sous
 * l'obligation d'une bannière.
 */
export const VISITOR_ID_RETENTION_DAYS = 30;
