/**
 * Règles du bilan hebdomadaire des clans.
 *
 * Aucun accès base ni Discord : ce module décide de la période couverte et de ce qu'on tire
 * du journal des contributions. Le service voisin lit et publie ; ce qui se calcule doit
 * rester vérifiable en test, le rang de la semaine précédente en premier.
 */

import { formatWallClockInTimezone } from '@kotbo/contracts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Le bilan porte sur les sept derniers jours, et paraît le lundi matin. */
export const DIGEST_WINDOW_DAYS = 7;
const DIGEST_WEEKDAY = 1;
const DIGEST_HOUR = 10;
const TOP_CONTRIBUTORS = 5;

/** Gains attribués au clan entier plutôt qu'à quelqu'un : ils fausseraient un palmarès. */
const CLAN_WIDE_AUTHOR = 'system_manual_points';

export interface WeekPosition {
  /** Lundi de la semaine en cours, sur le fuseau du serveur. Sert de clé de publication. */
  weekKey: string;
  /** Vrai tant que l'heure de parution n'est pas passée. */
  tooEarly: boolean;
}

/**
 * Où l'on se situe dans la semaine locale du serveur.
 *
 * La clé est la date du lundi plutôt qu'un numéro de semaine ISO : elle est aussi unique,
 * se lit sans conversion, et sert telle quelle de repère dans le message.
 */
export function weekPosition(timezone: string, now: Date): WeekPosition {
  const [datePart, timePart] = formatWallClockInTimezone(now, timezone).split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const hour = Number.parseInt(timePart.slice(0, 2), 10) || 0;

  const today = new Date(Date.UTC(year, month - 1, day));
  // `getUTCDay` place dimanche en tête ; la semaine du bilan commence un lundi.
  const weekday = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
  const monday = new Date(today.getTime() - (weekday - 1) * MS_PER_DAY);

  return {
    weekKey: monday.toISOString().slice(0, 10),
    tooEarly: weekday === DIGEST_WEEKDAY && hour < DIGEST_HOUR,
  };
}

/** Un gain enregistré au journal, réduit à ce dont le bilan a besoin. */
export interface ClanWeekEvent {
  clanId: string;
  userId: string;
  amount: number;
  source: string;
}

export interface ClanWeekStats {
  clanId: string;
  points: number;
  contributors: Array<{ userId: string; points: number }>;
  bySource: Array<{ source: string; points: number }>;
  rank: number;
  previousRank: number;
}

/**
 * Ce que chaque clan a gagné sur la période, et la place que ça lui vaut.
 *
 * Le rang d'avant se déduit du total de saison moins les points de la semaine, sans
 * instantané à conserver : la comparaison porte sur le même journal pour tous les clans,
 * donc l'ordre reste juste même si le journal et l'agrégat divergeaient d'un point.
 */
export function summarizeClanWeek(
  clanIds: string[],
  events: ClanWeekEvent[],
  seasonTotals: Map<string, number>,
): Map<string, ClanWeekStats> {
  const weekPoints = new Map(clanIds.map((id) => [id, 0]));
  const contributors = new Map<string, Map<string, number>>();
  const sources = new Map<string, Map<string, number>>();

  for (const event of events) {
    if (!weekPoints.has(event.clanId)) continue;

    weekPoints.set(event.clanId, (weekPoints.get(event.clanId) ?? 0) + event.amount);

    if (event.userId !== CLAN_WIDE_AUTHOR) {
      const byUser = contributors.get(event.clanId) ?? new Map<string, number>();
      byUser.set(event.userId, (byUser.get(event.userId) ?? 0) + event.amount);
      contributors.set(event.clanId, byUser);
    }

    const bySource = sources.get(event.clanId) ?? new Map<string, number>();
    bySource.set(event.source, (bySource.get(event.source) ?? 0) + event.amount);
    sources.set(event.clanId, bySource);
  }

  const rankOf = (score: (clanId: string) => number) => {
    const order = [...clanIds].sort((a, b) => score(b) - score(a));
    return new Map(order.map((clanId, index) => [clanId, index + 1]));
  };

  const ranks = rankOf((clanId) => seasonTotals.get(clanId) ?? 0);
  const previousRanks = rankOf((clanId) => (seasonTotals.get(clanId) ?? 0) - (weekPoints.get(clanId) ?? 0));

  const stats = new Map<string, ClanWeekStats>();
  for (const clanId of clanIds) {
    stats.set(clanId, {
      clanId,
      points: weekPoints.get(clanId) ?? 0,
      contributors: [...(contributors.get(clanId) ?? new Map<string, number>())]
        .map(([userId, points]) => ({ userId, points }))
        .filter((entry) => entry.points > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, TOP_CONTRIBUTORS),
      bySource: [...(sources.get(clanId) ?? new Map<string, number>())]
        .map(([source, points]) => ({ source, points }))
        .filter((entry) => entry.points !== 0)
        .sort((a, b) => b.points - a.points),
      rank: ranks.get(clanId) ?? clanIds.length,
      previousRank: previousRanks.get(clanId) ?? clanIds.length,
    });
  }

  return stats;
}
