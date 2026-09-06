/**
 * Règles des drops aléatoires, partagées entre le bot et le dashboard.
 *
 * Un drop est un cadeau qui apparaît de lui-même dans un salon : personne ne le
 * déclenche, le bot le pose à une heure imprévisible et le premier - ou les
 * premiers - à cliquer l'emportent. Tout ce qui décide de la récompense et du
 * moment vit ici, sans accès base ni Discord, pour rester vérifiable en test et
 * pour qu'un réglage refusé par l'API le soit aussi dans le formulaire.
 */

/** Ressource versée par un drop. Chaque type a son salon et ses montants. */
export type DropType = 'XP' | 'RPG_XP' | 'CLAN_POINTS' | 'COINS' | 'RPG_ITEM';

export const DROP_TYPES: readonly DropType[] = ['XP', 'RPG_XP', 'CLAN_POINTS', 'COINS', 'RPG_ITEM'] as const;


/**
 * Façon dont un drop se ramasse :
 * - `FIRST` : un seul gagnant, le premier à cliquer ;
 * - `RACE` : les N premiers, chacun touchant le montant annoncé ;
 * - `WINDOW` : tout le monde, tant que la fenêtre reste ouverte.
 *
 * Les trois modes cohabitent au sein d'un même type de drop, avec leurs propres
 * fourchettes : une course au clic peut ainsi rapporter bien plus qu'un drop
 * ouvert à tous pendant dix minutes.
 */
export type DropMode = 'FIRST' | 'RACE' | 'WINDOW';

export const DROP_MODES: readonly DropMode[] = ['FIRST', 'RACE', 'WINDOW'] as const;

/** Bornes de sécurité : une config saisie de travers ne doit ni figer ni emballer le cycle. */
export const DROP_INTERVAL_MINUTES_RANGE = { min: 5, max: 10_080 } as const;
export const DROP_AMOUNT_RANGE = { min: 1, max: 1_000_000 } as const;
export const DROP_RACE_WINNERS_RANGE = { min: 2, max: 50 } as const;

/**
 * Un drop d'objet tire dans une liste choisie par l'administrateur.
 *
 * Rien n'est tiré au hasard dans tout le catalogue : une arme légendaire tombée par
 * accident dans un salon vaut une économie ruinée, et le serveur doit pouvoir dire
 * exactement ce qu'il accepte de voir apparaître.
 */
export const DROP_ITEM_POOL_MAX = 25;

/**
 * Un drop d'objet donne des exemplaires, pas des points : la fourchette des autres
 * ressources monte au million, ce qui n'aurait aucun sens pour une épée.
 */
export const DROP_ITEM_QUANTITY_RANGE = { min: 1, max: 10 } as const;

/** Part d'un objet dans le tirage, en pourcentage. Zéro n'existe pas : on le retire. */
export const DROP_ITEM_WEIGHT_RANGE = { min: 1, max: 100 } as const;

/** Somme attendue des taux d'une liste bien réglée. */
export const DROP_ITEM_WEIGHT_TOTAL = 100;

/**
 * Un objet de la liste, avec sa part du tirage.
 *
 * Les taux sont saisis en pourcentage et la page en exige la somme exacte, mais le tirage
 * n'en dépend pas : il est proportionnel. Une liste dont la somme aurait dérivé - un objet
 * supprimé du catalogue, une sauvegarde d'une version antérieure - continue donc de tomber
 * juste, avec les rapports que l'administrateur avait voulus.
 */
export interface DropItemChance {
  itemId: string;
  weight: number;
}

/** Somme des taux, telle qu'affichée à l'administrateur. */
export function dropItemsTotalWeight(items: DropItemChance[]): number {
  return items.reduce((total, entry) => total + entry.weight, 0);
}

/**
 * Tire un objet au prorata des taux.
 *
 * Le tirage porte sur la somme réelle et non sur cent : c'est ce qui permet d'écarter les
 * objets devenus inéligibles - supprimés, module éteint - sans que les autres perdent
 * leurs rapports. Sur une liste vide, il n'y a rien à tirer.
 */
export function pickWeightedDropItem(
  items: DropItemChance[],
  random: () => number = Math.random,
): string | null {
  const pool = items.filter((entry) => entry.weight > 0);
  if (pool.length === 0) return null;

  const total = dropItemsTotalWeight(pool);
  let ticket = random() * total;
  for (const entry of pool) {
    ticket -= entry.weight;
    if (ticket < 0) return entry.itemId;
  }

  // Arrondis flottants : le dernier de la liste emporte le reste plutôt que rien.
  return pool[pool.length - 1].itemId;
}

/** Nettoie une liste saisie : doublons retirés, taux bornés, liste plafonnée. */
export function normalizeDropItems(raw: unknown): DropItemChance[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const items: DropItemChance[] = [];

  for (const entry of raw) {
    const source = entry as Partial<DropItemChance>;
    const itemId = typeof source?.itemId === 'string' ? source.itemId : '';
    if (!itemId || seen.has(itemId)) continue;

    const weight = clampDropInt(source?.weight, DROP_ITEM_WEIGHT_RANGE, DROP_ITEM_WEIGHT_RANGE.min);
    seen.add(itemId);
    items.push({ itemId, weight });

    if (items.length >= DROP_ITEM_POOL_MAX) break;
  }

  return items;
}

/** Fourchette applicable au montant d'un type : une quantité pour un objet, des points sinon. */
export function dropAmountRange(type: DropType): { min: number; max: number } {
  return type === 'RPG_ITEM' ? DROP_ITEM_QUANTITY_RANGE : DROP_AMOUNT_RANGE;
}

/**
 * Écart minimal entre deux drops publiés sur un même serveur, tous types
 * confondus.
 *
 * C'est le garde-fou anti-spam du module. L'intervalle réglé par type ne suffit
 * pas : il est tiré au sort autour de sa valeur (donc parfois bien plus court),
 * et les quatre ressources tournent chacune de leur côté - quatre types réglés
 * au minimum feraient quatre messages dans le même quart d'heure, souvent dans
 * le même salon. Un bot qui poste à cette cadence se fait signaler comme
 * spammeur et s'expose aux restrictions de Discord.
 */
export const DROP_MIN_PUBLISH_GAP_MINUTES = 5;

/**
 * Un drop reste ramassable au moins cinq minutes, quel que soit le mode.
 *
 * Complément du garde-fou ci-dessus, côté fermeture : en dessous, seul un
 * membre déjà devant l'écran au bon moment peut cliquer.
 */
export const DROP_MIN_OPEN_MINUTES = 5;
export const DROP_WINDOW_MINUTES_RANGE = { min: DROP_MIN_OPEN_MINUTES, max: 1_440 } as const;
/** Durée de vie d'un drop que personne ne ramasse. */
export const DROP_LIFETIME_MINUTES_RANGE = { min: DROP_MIN_OPEN_MINUTES, max: 1_440 } as const;

export interface DropModeSettings {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
}

export interface DropTypeSettings {
  enabled: boolean;
  /**
   * Objets pouvant tomber, avec leur part du tirage. Vide, aucun drop n'est publié : mieux
   * vaut pas de drop qu'un message annonçant une récompense que rien ne peut verser.
   */
  items: DropItemChance[];
  /** Salon de publication. `null` = salon par défaut des réglages globaux. */
  channelId: string | null;
  /** Écart moyen entre deux drops. Le tirage réel s'en écarte volontairement. */
  intervalMinutes: number;
  first: DropModeSettings;
  race: DropModeSettings & { winnerCount: number };
  window: DropModeSettings & { durationMinutes: number };
}

export interface DropGlobalSettings {
  dropsEnabled: boolean;
  dropChannelId: string | null;
  dropMentionRoleId: string | null;
  dropLifetimeMinutes: number;
}

export const DEFAULT_DROP_GLOBAL_SETTINGS: DropGlobalSettings = {
  dropsEnabled: false,
  dropChannelId: null,
  dropMentionRoleId: null,
  dropLifetimeMinutes: 60,
};

/**
 * Barèmes de départ, calibrés par ressource : 200 points de clan et 200 pièces
 * n'ont pas le même poids, et une valeur unique pour les quatre types donnerait
 * un drop dérisoire d'un côté, hors barème de l'autre.
 */
export const DEFAULT_DROP_AMOUNTS: Record<DropType, { min: number; max: number }> = {
  XP: { min: 50, max: 250 },
  RPG_XP: { min: 25, max: 150 },
  CLAN_POINTS: { min: 10, max: 60 },
  COINS: { min: 50, max: 300 },
  RPG_ITEM: { min: 1, max: 1 },
};

export function defaultDropTypeSettings(type: DropType): DropTypeSettings {
  const base = DEFAULT_DROP_AMOUNTS[type];
  return {
    enabled: false,
    items: [],
    channelId: null,
    intervalMinutes: 360,
    first: { enabled: true, minAmount: base.min, maxAmount: base.max },
    // Un drop partagé rapporte moins par tête qu'une victoire au clic : le
    // barème de départ le reflète, l'administrateur reste libre de l'inverser.
    race: { enabled: false, winnerCount: 3, minAmount: Math.max(DROP_AMOUNT_RANGE.min, Math.round(base.min / 2)), maxAmount: Math.max(DROP_AMOUNT_RANGE.min, Math.round(base.max / 2)) },
    window: { enabled: false, durationMinutes: 10, minAmount: Math.max(DROP_AMOUNT_RANGE.min, Math.round(base.min / 4)), maxAmount: Math.max(DROP_AMOUNT_RANGE.min, Math.round(base.max / 4)) },
  };
}

export function clampDropInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(parsed)));
}

function normalizeModeAmounts(
  raw: Partial<DropModeSettings> | null | undefined,
  fallback: DropModeSettings,
  range: { min: number; max: number },
): DropModeSettings {
  const min = clampDropInt(raw?.minAmount, range, fallback.minAmount);
  const max = clampDropInt(raw?.maxAmount, range, fallback.maxAmount);
  return {
    enabled: raw?.enabled ?? fallback.enabled,
    // Une fourchette saisie à l'envers donnerait un tirage vide : elle est
    // remise à l'endroit plutôt que refusée.
    minAmount: Math.min(min, max),
    maxAmount: Math.max(min, max),
  };
}

export function normalizeDropTypeSettings(
  type: DropType,
  raw: Partial<DropTypeSettings> | null | undefined,
): DropTypeSettings {
  const fallback = defaultDropTypeSettings(type);
  const source = raw ?? {};

  const range = dropAmountRange(type);
  const race = normalizeModeAmounts(source.race, fallback.race, range);
  const window = normalizeModeAmounts(source.window, fallback.window, range);

  return {
    enabled: source.enabled ?? fallback.enabled,
    items: normalizeDropItems(source.items ?? fallback.items),
    channelId: source.channelId ?? null,
    intervalMinutes: clampDropInt(source.intervalMinutes, DROP_INTERVAL_MINUTES_RANGE, fallback.intervalMinutes),
    first: normalizeModeAmounts(source.first, fallback.first, range),
    race: {
      ...race,
      winnerCount: clampDropInt(source.race?.winnerCount, DROP_RACE_WINNERS_RANGE, fallback.race.winnerCount),
    },
    window: {
      ...window,
      durationMinutes: clampDropInt(source.window?.durationMinutes, DROP_WINDOW_MINUTES_RANGE, fallback.window.durationMinutes),
    },
  };
}

export function normalizeDropGlobalSettings(raw: Partial<DropGlobalSettings> | null | undefined): DropGlobalSettings {
  const source = raw ?? {};
  return {
    dropsEnabled: source.dropsEnabled ?? DEFAULT_DROP_GLOBAL_SETTINGS.dropsEnabled,
    dropChannelId: source.dropChannelId ?? null,
    dropMentionRoleId: source.dropMentionRoleId ?? null,
    dropLifetimeMinutes: clampDropInt(
      source.dropLifetimeMinutes,
      DROP_LIFETIME_MINUTES_RANGE,
      DEFAULT_DROP_GLOBAL_SETTINGS.dropLifetimeMinutes,
    ),
  };
}

const MS_PER_MINUTE = 60 * 1000;

/**
 * Tire la date du prochain drop.
 *
 * Le drop ne tombe pas à heure fixe : il arrive entre la moitié et une fois et
 * demie l'intervalle configuré. L'écart moyen vaut donc exactement l'intervalle
 * demandé, mais personne ne peut camper le salon à l'heure dite - ce qui est
 * tout l'intérêt d'un drop aléatoire.
 *
 * Le tirage ne descend jamais sous l'écart minimal : au réglage le plus serré,
 * la moitié d'un intervalle de cinq minutes tomberait à deux minutes et demie,
 * soit le double de la cadence voulue.
 */
export function planNextDropAt(
  since: Date,
  intervalMinutes: number,
  random: () => number = Math.random,
): Date {
  const interval = clampDropInt(intervalMinutes, DROP_INTERVAL_MINUTES_RANGE, 360);
  const periodMs = interval * MS_PER_MINUTE;
  const offsetMs = Math.max(
    periodMs / 2 + random() * periodMs,
    DROP_MIN_PUBLISH_GAP_MINUTES * MS_PER_MINUTE,
  );
  return new Date(since.getTime() + Math.round(offsetMs));
}

/**
 * Instant à partir duquel un serveur peut recevoir un nouveau drop, ou `null`
 * quand rien n'a encore été publié.
 *
 * Le cycle reporte à cette date le type dont l'heure est venue trop tôt, au
 * lieu de sauter son tour : le drop est retardé de quelques minutes, pas perdu.
 */
export function nextAllowedPublicationAt(lastPublishedAt: Date | null | undefined): Date | null {
  if (!lastPublishedAt) return null;
  return new Date(lastPublishedAt.getTime() + DROP_MIN_PUBLISH_GAP_MINUTES * MS_PER_MINUTE);
}

/** Modes réellement utilisables pour ce type de drop. */
export function enabledDropModes(settings: DropTypeSettings): DropMode[] {
  const modes: DropMode[] = [];
  if (settings.first.enabled) modes.push('FIRST');
  if (settings.race.enabled) modes.push('RACE');
  if (settings.window.enabled) modes.push('WINDOW');
  return modes;
}

/**
 * Choisit le mode du prochain drop parmi ceux activés, à chances égales.
 *
 * Renvoie `null` quand l'administrateur a tout éteint : le cycle saute alors ce
 * type plutôt que de poser un drop que personne ne peut ramasser.
 */
export function pickDropMode(settings: DropTypeSettings, random: () => number = Math.random): DropMode | null {
  const modes = enabledDropModes(settings);
  if (modes.length === 0) return null;
  return modes[Math.floor(random() * modes.length)] ?? modes[0];
}

export function dropModeSettings(settings: DropTypeSettings, mode: DropMode): DropModeSettings {
  if (mode === 'RACE') return settings.race;
  if (mode === 'WINDOW') return settings.window;
  return settings.first;
}

/** Montant du drop, tiré une fois à la création et versé tel quel à chaque gagnant. */
export function drawDropAmount(settings: DropTypeSettings, mode: DropMode, random: () => number = Math.random): number {
  const { minAmount, maxAmount } = dropModeSettings(settings, mode);
  const min = Math.min(minAmount, maxAmount);
  const max = Math.max(minAmount, maxAmount);
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Nombre de ramassages autorisés. `0` vaut « sans limite » : en mode fenêtre,
 * c'est le temps qui ferme le drop, pas un compteur.
 */
export function dropMaxClaims(settings: DropTypeSettings, mode: DropMode): number {
  if (mode === 'RACE') return clampDropInt(settings.race.winnerCount, DROP_RACE_WINNERS_RANGE, 3);
  if (mode === 'WINDOW') return 0;
  return 1;
}

/**
 * Date de fermeture d'un drop.
 *
 * En mode fenêtre, c'est la durée d'ouverture annoncée aux membres. Dans les
 * autres modes, c'est la durée de vie globale : un drop que personne ne ramasse
 * ne doit pas laisser un bouton vivant indéfiniment.
 */
export function dropExpiresAt(
  postedAt: Date,
  settings: DropTypeSettings,
  mode: DropMode,
  lifetimeMinutes: number,
): Date {
  const minutes = mode === 'WINDOW'
    ? clampDropInt(settings.window.durationMinutes, DROP_WINDOW_MINUTES_RANGE, 10)
    : clampDropInt(lifetimeMinutes, DROP_LIFETIME_MINUTES_RANGE, 60);
  return new Date(postedAt.getTime() + minutes * MS_PER_MINUTE);
}
