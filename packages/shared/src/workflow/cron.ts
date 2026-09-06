/**
 * Motifs cron à cinq champs, résolus à la minute.
 *
 * Le déclencheur « Planification » ne s'abonne à aucun événement Discord : un
 * balayage passe chaque minute et demande à chaque workflow planifié si son
 * motif tombe maintenant. C'est ce que répond `cronMatches`.
 *
 * Le motif est toujours confronté à l'heure murale d'un fuseau explicite, et
 * jamais à celle du process : le bot tourne en UTC, donc « tous les jours à
 * 9h00 » serait parti à 11h à Paris en été et à 10h en hiver, alors que le
 * reste du produit affiche et lit les dates dans le fuseau du serveur.
 *
 * La grammaire couverte est celle que produit l'éditeur - `*`, une valeur, une
 * liste, un intervalle, un pas - et rien de plus. Les extensions non standard
 * (`@daily`, `L`, `#`) sont refusées plutôt que mal interprétées : un motif
 * accepté mais compris de travers ferait partir une automatisation au mauvais
 * moment, ce qui est pire qu'un refus à l'enregistrement.
 */

/** minute, heure, jour du mois, mois, jour de la semaine. */
const FIELD_RANGES: [min: number, max: number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/**
 * Valeurs autorisées par un champ, ou `null` si le champ est invalide.
 *
 * `wildcard` dit que le champ porte une étoile, pas qu'il accepte toutes les
 * valeurs : une étoile suivie d'un pas n'en accepte qu'une sur deux. C'est bien
 * la présence de l'étoile que regarde la règle jour du mois / jour de la
 * semaine, et une énumération complète ne s'y substitue pas - `* * * * 1` et
 * `* * 1-31 * 1` ne se comportent pas pareil dans un cron.
 */
function parseField(raw: string, min: number, max: number): { values: Set<number>; wildcard: boolean } | null {
  const field = raw.trim();
  if (field === '') return null;

  const values = new Set<number>();
  let wildcard = false;

  for (const part of field.split(',')) {
    const [spec, stepRaw, ...extra] = part.split('/');
    if (extra.length > 0) return null;

    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return null;
      step = Number(stepRaw);
      if (step < 1) return null;
    }

    let from: number;
    let to: number;

    if (spec === '*') {
      from = min;
      to = max;
      // `*/2` compte aussi comme une étoile, comme dans le cron système : c'est
      // la présence de l'étoile, et non l'absence de pas, qui fait basculer la
      // règle jour du mois / jour de la semaine.
      wildcard = true;
    } else if (/^\d+$/.test(spec)) {
      from = Number(spec);
      // `5/2` n'a de sens qu'en partant de 5 et en allant jusqu'au bout.
      to = stepRaw === undefined ? from : max;
    } else {
      const range = spec.match(/^(\d+)-(\d+)$/);
      if (!range) return null;
      from = Number(range[1]);
      to = Number(range[2]);
    }

    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return values.size > 0 ? { values, wildcard } : null;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Le champ portait une étoile, pas forcément toutes les valeurs. */
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parsed = fields.map((field, index) => parseField(field, FIELD_RANGES[index][0], FIELD_RANGES[index][1]));
  if (parsed.some((field) => field === null)) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as NonNullable<(typeof parsed)[number]>[];

  // 7 et 0 désignent tous deux le dimanche.
  const daysOfWeek = new Set([...dayOfWeek.values].map((day) => (day === 7 ? 0 : day)));

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek,
    dayOfMonthWildcard: dayOfMonth.wildcard,
    dayOfWeekWildcard: dayOfWeek.wildcard,
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

/** Champs date et heure d'un instant, lus dans le fuseau demandé. */
interface ZonedParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  year: number;
  /** 0 = dimanche, comme `Date.prototype.getDay`. */
  weekday: number;
}

/** Découpe un instant en heure murale. */
function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = zonedFormatter(timezone).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const year = read('year');
  const month = read('month');
  const day = read('day');

  return {
    minute: read('minute'),
    hour: read('hour'),
    day,
    month,
    year,
    // Le jour de la semaine est déduit de la date murale plutôt que demandé à
    // `Intl` : pas de nom de jour à reconnaître, donc rien qui dépende de la
    // locale du runtime.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/**
 * Repère de la minute murale d'un instant : deux instants qui portent le même
 * repère désignent la même heure au mur, dans ce fuseau.
 *
 * Sert à ne pas déclencher deux fois la nuit du retour à l'heure d'hiver, où
 * l'horloge repasse par la même heure : « tous les jours à 02h30 » y tombe une
 * fois à 00h30 UTC et une seconde à 01h30 UTC. Comparer les instants ne les
 * distingue pas d'un jour à l'autre - il faut comparer ce que voit l'humain.
 */
export function wallClockMinuteKey(date: Date, timezone: string): string {
  const { year, month, day, hour, minute } = zonedParts(date, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * `Intl.DateTimeFormat` coûte cher à construire, et le balayage passe chaque
 * minute sur tous les workflows planifiés.
 *
 * Un identifiant que le runtime ne connaît pas retombe sur UTC plutôt que de
 * lever : un fuseau devenu invalide doit décaler les déclenchements, pas
 * éteindre toutes les planifications. Le repli est mémorisé sous la clé
 * demandée, pour ne pas retenter la construction à chaque passage.
 */
function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;

  // `hourCycle: 'h23'` : en `en-US`, minuit ressort « 24 » sans lui, ce qu'aucune
  // heure de motif ne peut égaler.
  const options: Intl.DateTimeFormatOptions = {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  };

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }

  formatterCache.set(timezone, formatter);
  return formatter;
}

/**
 * Le motif tombe-t-il sur cette minute, dans le fuseau donné ?
 *
 * `timezone` est explicite et sans valeur par défaut : c'est la seule façon
 * d'empêcher un appelant de comparer par mégarde à l'heure du process, qui est
 * UTC en conteneur.
 *
 * Quand le jour du mois et le jour de la semaine sont tous deux restreints,
 * la règle historique de cron veut qu'ils soient combinés par un OU et non
 * par un ET : `0 0 1 * 1` se lit « le 1er du mois, et aussi tous les lundis ».
 * S'en écarter ferait manquer des déclenchements attendus. Dès que l'un des
 * deux porte une étoile, on revient au ET, comme le cron système.
 */
export function cronMatches(expression: string, date: Date, timezone: string): boolean {
  const cron = parseCron(expression);
  if (!cron) return false;

  const now = zonedParts(date, timezone);

  if (!cron.minutes.has(now.minute)) return false;
  if (!cron.hours.has(now.hour)) return false;
  if (!cron.months.has(now.month)) return false;

  const dayOfMonthMatches = cron.daysOfMonth.has(now.day);
  const dayOfWeekMatches = cron.daysOfWeek.has(now.weekday);

  if (cron.dayOfMonthWildcard || cron.dayOfWeekWildcard) {
    return dayOfMonthMatches && dayOfWeekMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

// ============================================================================
// COMPOSITION DEPUIS L'ÉDITEUR
// ============================================================================

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface SchedulePreset {
  frequency: ScheduleFrequency;
  /** Minute de l'heure, pour la fréquence horaire comme pour les autres. */
  minute: number;
  hour: number;
  /** 0 = dimanche. Utilisé par la fréquence hebdomadaire. */
  weekday: number;
  /** Jour du mois, utilisé par la fréquence mensuelle. */
  day: number;
}

export const DEFAULT_SCHEDULE: SchedulePreset = {
  frequency: 'daily',
  minute: 0,
  hour: 9,
  weekday: 1,
  day: 1,
};

export function scheduleToCron(preset: SchedulePreset): string {
  const minute = clamp(preset.minute, 0, 59);
  const hour = clamp(preset.hour, 0, 23);

  switch (preset.frequency) {
    case 'hourly': return `${minute} * * * *`;
    case 'weekly': return `${minute} ${hour} * * ${clamp(preset.weekday, 0, 6)}`;
    case 'monthly': return `${minute} ${hour} ${clamp(preset.day, 1, 31)} * *`;
    default: return `${minute} ${hour} * * *`;
  }
}

/**
 * Relit un motif vers les réglages de l'éditeur.
 *
 * Renvoie `null` pour tout ce que les quatre fréquences ne savent pas
 * exprimer : l'éditeur bascule alors sur la saisie brute plutôt que d'afficher
 * des réglages qui ne correspondent pas au motif enregistré.
 */
export function cronToSchedule(expression: string): SchedulePreset | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, day, month, weekday] = fields;
  if (month !== '*') return null;
  if (!/^\d+$/.test(minute)) return null;

  const base = { ...DEFAULT_SCHEDULE, minute: Number(minute) };
  if (base.minute > 59) return null;

  if (hour === '*' && day === '*' && weekday === '*') {
    return { ...base, frequency: 'hourly' };
  }

  if (!/^\d+$/.test(hour) || Number(hour) > 23) return null;
  const withHour = { ...base, hour: Number(hour) };

  if (day === '*' && weekday === '*') return { ...withHour, frequency: 'daily' };
  if (day === '*' && /^[0-6]$/.test(weekday)) return { ...withHour, frequency: 'weekly', weekday: Number(weekday) };
  if (weekday === '*' && /^\d+$/.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    return { ...withHour, frequency: 'monthly', day: Number(day) };
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
