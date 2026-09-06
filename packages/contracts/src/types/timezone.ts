/**
 * Fuseau horaire d'un serveur.
 *
 * Le bot tourne en UTC (image `oven/bun:1-alpine`, sans `TZ`) : toute date
 * formatee sans `timeZone` explicite sort en UTC, et toute chaine sans fuseau
 * passee a `new Date()` est lue comme de l'UTC. Les deux erreurs decalent d'une
 * a deux heures selon la saison, dans des sens opposes.
 *
 * La liste proposee est celle de l'environnement (`Intl.supportedValuesOf`),
 * pas une liste figee : elle suit les mises a jour de la base IANA sans qu'on
 * ait a toucher au code.
 */

export const DEFAULT_TIMEZONE = 'Europe/Paris';

/**
 * `supportedValuesOf` n'existe pas partout (Safari < 17, runtimes anciens). Le
 * repli garde le selecteur utilisable au lieu de le vider entierement.
 */
const FALLBACK_TIMEZONES: readonly string[] = [
  'UTC',
  'Europe/Paris',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Brussels',
  'Europe/Madrid',
  'Europe/Berlin',
  'Europe/Zurich',
  'America/Montreal',
  'America/New_York',
  'Africa/Casablanca',
  'Indian/Reunion',
];

type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[];
};

/**
 * Tous les identifiants IANA connus du runtime, tries.
 *
 * `ensure` garantit la presence d'une valeur deja enregistree : les alias
 * historiques (`Europe/Kiev`, `Asia/Calcutta`) restent acceptes par `Intl` sans
 * figurer dans la liste, et un selecteur qui ne les contient pas s'affiche vide
 * alors qu'un fuseau est bien configure.
 */
export function listSupportedTimezones(ensure?: string): string[] {
  const supportedValuesOf = (Intl as IntlWithSupportedValues).supportedValuesOf;

  let zones: readonly string[];
  if (typeof supportedValuesOf !== 'function') {
    zones = FALLBACK_TIMEZONES;
  } else {
    try {
      zones = supportedValuesOf('timeZone');
    } catch {
      zones = FALLBACK_TIMEZONES;
    }
  }

  // `UTC` est absent de la liste IANA sur certains runtimes alors que
  // `Intl.DateTimeFormat` l'accepte : sans cet ajout, le seul choix neutre
  // proposable disparait du selecteur.
  const complete = new Set(zones);
  complete.add('UTC');
  if (ensure && isValidTimezone(ensure)) complete.add(ensure);

  return [...complete].sort((a, b) => a.localeCompare(b));
}

/**
 * Verifie qu'un identifiant est utilisable par `Intl`. C'est la seule
 * validation fiable : la liste supportee varie d'un runtime a l'autre, et les
 * alias historiques (`Europe/Kiev`) restent acceptes sans y figurer.
 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Fuseau stocke, ramene au defaut s'il est vide ou devenu invalide. */
export function normalizeTimezone(value: unknown): string {
  return isValidTimezone(value) ? value : DEFAULT_TIMEZONE;
}

/**
 * Decalage du fuseau, en millisecondes, a l'instant donne.
 *
 * Sert de brique de conversion aux helpers plus haut niveau. Isole ici pour ne
 * pas dupliquer la formule Intl entre le bot et le dashboard.
 */
function offsetAt(instant: Date, timezone: string): number {
  // `hourCycle: 'h23'` garantit un domaine 0-23. `hour12: false` en `en-US`
  // renvoyait « 24 » a minuit sur Node, ce qui faisait repartir `Date.UTC`
  // un jour plus loin et decalait l'aller-retour de 48 h a chaque minuit.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  return asUtc - instant.getTime();
}

/**
 * Convertit une heure murale (celle qu'un humain a tapee) en instant reel.
 *
 * `wallClockUtcMs` est le millisecondes UTC des champs date/heure lus tels
 * quels : le decalage depend de l'instant qu'on cherche justement a calculer,
 * on part donc d'une approximation puis on corrige.
 *
 * Cas ambigus (memes que tout autre convertisseur de fuseau) : une heure qui
 * n'existe pas lors du passage a l'heure d'ete tombe apres le saut, et une
 * heure doublee au retour a l'heure d'hiver designe la seconde occurrence.
 * Ces cas ne se distinguent pas de la saisie « wall clock » que fournit un
 * `<input type="datetime-local">`.
 */
export function zonedTimeToInstant(wallClockUtcMs: number, timezone: string): Date {
  const zone = normalizeTimezone(timezone);
  const first = new Date(wallClockUtcMs - offsetAt(new Date(wallClockUtcMs), zone));
  return new Date(wallClockUtcMs - offsetAt(first, zone));
}

/** `YYYY-MM-DD HH:mm`, `YYYY-MM-DDTHH:mm`, avec secondes optionnelles. */
const WALL_CLOCK_REGEX = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Millisecondes UTC de champs date/heure lus tels quels, ou `null` si la
 * combinaison n'existe pas.
 *
 * `Date.UTC` ne refuse rien : il reporte. Le 31 fevrier devient le 3 mars et le
 * mois 13 devient janvier de l'annee suivante, sans le moindre signal. Un
 * `/rappel 2026-02-31 09:00` partait donc au mauvais jour au lieu d'etre
 * refuse. On relit donc ce qu'on vient d'ecrire, seule facon de distinguer une
 * date valide d'un report.
 *
 * `monthIndex` est en base 0, comme `Date.UTC` et `new Date(...)`.
 */
export function toWallClockUtcMs(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number | null {
  const ms = Date.UTC(year, monthIndex, day, hour, minute, second);
  if (Number.isNaN(ms)) return null;

  const back = new Date(ms);
  const matches = back.getUTCFullYear() === year
    && back.getUTCMonth() === monthIndex
    && back.getUTCDate() === day
    && back.getUTCHours() === hour
    && back.getUTCMinutes() === minute
    && back.getUTCSeconds() === second;

  return matches ? ms : null;
}

/**
 * Lit une date saisie par un humain dans le fuseau donne.
 *
 * Une chaine deja horodatee (`…Z`, `+02:00`) designe un instant sans ambiguite
 * et est rendue telle quelle : seules les saisies sans fuseau sont interpretees
 * dans `timezone`.
 */
export function parseDateTimeInTimezone(input: string, timezone: string): Date | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(WALL_CLOCK_REGEX);
  if (match) {
    const wallClock = toWallClockUtcMs(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      match[4] ? Number(match[4]) : 0,
      match[5] ? Number(match[5]) : 0,
      match[6] ? Number(match[6]) : 0,
    );
    // Une date qui n'existe pas est refusee ici plutot que reportee : la forme
    // etant reconnue, retomber sur `new Date` reproduirait le meme report.
    if (wallClock === null) return null;
    return zonedTimeToInstant(wallClock, timezone);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `YYYY-MM-DDTHH:mm` rendu par un `<input type="datetime-local">`, mais lu dans
 * le fuseau demande plutot que celui du navigateur.
 *
 * Sans ca, un dashboard ouvert depuis un autre fuseau que celui du serveur
 * affichait l'heure locale du poste dans le formulaire, alors que la meme
 * reunion s'affichait dans le fuseau du serveur partout ailleurs.
 */
export function formatWallClockInTimezone(date: Date, timezone: string): string {
  // `hourCycle: 'h23'` : cf. `offsetAt`. Sans ca, une reunion pile a minuit se
  // rendait « 24:00 » dans l'input, refuse par le navigateur.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimezone(timezone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
}
