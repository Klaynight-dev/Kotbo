/**
 * Relecture des agregats analytics dans un fuseau donne.
 *
 * INVARIANT d'ecriture (cf. `dateKeys.ts`) : `GuildHourlyStat.dateKey` et
 * `.hour` sont des cles **UTC**. C'est le bon choix de stockage - il ne bouge
 * pas avec les changements d'heure - mais un lecteur a Paris lisait ses pics de
 * 14h annonces a midi, et ceux de minuit annonces la veille a 22h.
 *
 * La conversion se fait donc a la lecture, pas a l'ecriture : chaque creneau
 * est reprojete sur l'heure murale du fuseau demande. Passer par `Intl` plutot
 * que par un decalage fixe couvre les fuseaux a la demi-heure (Asia/Kolkata) et
 * les changements d'heure au milieu d'une periode, ou deux jours d'une meme
 * plage n'ont pas le meme decalage.
 */

import { normalizeTimezone } from '@kotbo/contracts';

/** Creneau replace dans un fuseau : jour, heure murale et jour de semaine. */
export type ZonedBucket = {
  /** `YYYY-MM-DD` local, qui peut differer du jour UTC d'origine. */
  dateKey: string;
  /** 0-23, heure murale locale. */
  hour: number;
  /** 0 = dimanche, aligne sur `Date.getUTCDay()`. */
  weekday: number;
};

/**
 * Convertisseur lie a un fuseau.
 *
 * Le `Intl.DateTimeFormat` est construit une seule fois : une heatmap sur un an
 * reprojette 8 760 creneaux, et instancier un formateur par creneau coute bien
 * plus cher que le formatage lui-meme.
 */
export class BucketZoner {
  readonly timezone: string;
  private readonly formatter: Intl.DateTimeFormat;

  constructor(timezone: string) {
    this.timezone = normalizeTimezone(timezone);
    this.formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      // `hourCycle: 'h23'` : sans lui, minuit sort en « 24 » sur certains
      // runtimes et le creneau repart sur le jour suivant.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
  }

  /** Reprojette un instant reel. */
  fromDate(date: Date): ZonedBucket {
    const parts = this.formatter.formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '00';

    const dateKey = `${read('year')}-${read('month')}-${read('day')}`;
    return {
      dateKey,
      hour: Number(read('hour')) % 24,
      weekday: weekdayOf(dateKey),
    };
  }

  /** Reprojette un creneau `(dateKey, hour)` stocke en UTC. */
  fromKeyHour(dateKey: string, hour: number): ZonedBucket {
    const ts = Date.parse(`${dateKey}T${String(hour).padStart(2, '0')}:00:00Z`);
    // Une cle illisible ne doit pas faire tomber toute la serie : on rend le
    // creneau tel quel, comme avant l'introduction du fuseau.
    if (Number.isNaN(ts)) return { dateKey, hour, weekday: weekdayOf(dateKey) };
    return this.fromDate(new Date(ts));
  }
}

/** Jour de la semaine (0 = dimanche) d'une cle `YYYY-MM-DD`. */
function weekdayOf(dateKey: string): number {
  const ts = Date.parse(`${dateKey}T00:00:00Z`);
  return Number.isNaN(ts) ? 0 : new Date(ts).getUTCDay();
}

/**
 * Marge de securite quand on relit des creneaux horaires sur une plage de
 * jours : le fuseau du lecteur peut faire entrer dans la plage locale des
 * creneaux UTC de la veille ou du lendemain (UTC-11 a UTC+14).
 *
 * On elargit donc la fenetre lue d'un jour de chaque cote, puis on refiltre sur
 * les cles locales apres conversion.
 */
export const ZONE_MARGIN_DAYS = 1;

/** Cle jour decalee de `offset` jours. */
export function shiftKey(dateKey: string, offset: number): string {
  const ts = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(ts)) return dateKey;
  return new Date(ts + offset * 86_400_000).toISOString().slice(0, 10);
}
