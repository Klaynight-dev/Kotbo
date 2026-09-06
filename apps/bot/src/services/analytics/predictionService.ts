/**
 * Prévisions et détection d'anomalies sur les statistiques de serveur.
 *
 * Corrections d'exactitude par rapport à la version précédente :
 *
 * - **Axe temporel réel.** La régression indexait les points par leur position
 *   dans le tableau. Si le bot était hors ligne trois jours, ces jours
 *   disparaissaient et la pente était calculée comme s'ils n'avaient jamais
 *   existé. On régresse désormais sur le décalage en jours réel.
 *
 * - **Prévision issue de la droite ajustée.** Le forecast partait de la *dernière
 *   valeur observée* (`last + slope × 7`) : une journée creuse suffisait à
 *   décaler toute la projection. On part du point ajusté par la régression.
 *
 * - **Confiance honnête.** Le R² était calculé sur une droite forcée à passer par
 *   le dernier point, ce qui pouvait rendre le R² négatif tout en affichant 85 %.
 *   On utilise l'intercept de la régression, un R² ajusté, et une pénalité liée à
 *   la taille de l'échantillon.
 *
 * - **Saisonnalité normalisée et appliquée au bon type de série.** Les indices
 *   hebdomadaires sont recentrés sur 1 (sinon ils introduisaient un biais
 *   multiplicatif systématique) et ne s'appliquent qu'aux *flux* (messages,
 *   vocal). Le total de membres est un *niveau* cumulé : lui appliquer un
 *   coefficient « le mardi est calme » faisait disparaître des membres.
 *
 * - **Anomalies robustes.** Le z-score était calculé sur la moyenne et l'écart-type
 *   de la fenêtre, anomalies incluses (une anomalie masque la suivante) et sans
 *   retirer la tendance (sur un serveur en croissance, chaque jour récent était
 *   un « pic »). On travaille sur les résidus détendancés avec un écart médian
 *   absolu (MAD), insensible aux valeurs extrêmes.
 *
 * - **Agrégation en base.** Le profil horaire était calculé en rapatriant jusqu'à
 *   2 160 lignes (90 j × 24 h). Il est désormais agrégé par `GROUP BY`.
 */
import { prismaRead } from '../../utils/db.js';
import { toDateKey, shiftDateKey, dateKeyWeekday } from './dateKeys.js';
import { BucketZoner } from './zonedBuckets.js';
import { resolveGuildTimezone } from '../../utils/timezone.js';

export interface TrendPoint {
  dateKey: string;
  value: number;
  predicted?: boolean;
  /** Bornes de l'intervalle de prévision (80 %), uniquement sur les points prédits. */
  lower?: number;
  upper?: number;
}

export interface AnomalyAlert {
  type: 'spike' | 'drop';
  metric: string;
  message: string;
  severity: 'info' | 'warning' | 'danger';
  dateKey: string;
  value: number;
  expectedRange: { min: number; max: number };
  /** Écart robuste en nombre de MAD. */
  deviation: number;
}

export interface SeasonalityProfile {
  busiestDay: string;
  quietestDay: string;
  busiestHour: number;
  quietestHour: number;
  /** Moyenne de messages par jour de semaine (index 0 = dimanche). */
  weekdayAverages: number[];
  /** Moyenne de messages par heure UTC (24 entrées). */
  hourlyAverages: number[];
  /** Vrai si l'échantillon est trop court pour que le profil soit fiable. */
  lowConfidence: boolean;
}

export interface PredictionData {
  membersTrend: TrendPoint[];
  messagesTrend: TrendPoint[];
  voiceTrend: TrendPoint[];
  growthForecast: {
    predicted7d: number;
    predicted30d: number;
    confidence: number;
    /** Variation nette moyenne par jour, issue de la régression. */
    dailyNet: number;
  };
  anomalies: AnomalyAlert[];
  seasonality: SeasonalityProfile;
  /** Nombre de jours réellement observés sur la fenêtre demandée. */
  observedDays: number;
  /** Faux quand il n'y a pas assez d'historique pour produire une prévision. */
  hasData: boolean;
}

/** Horizon de projection, en jours. */
const FORECAST_DAYS = 7;
/** En deçà, aucune prévision n'est publiée : la droite serait du bruit. */
const MIN_DAYS_FOR_FORECAST = 5;
/** En deçà, pas de détection d'anomalies (pas de dispersion mesurable). */
const MIN_DAYS_FOR_ANOMALIES = 10;
/** Seuil de z-score robuste au-delà duquel un point est signalé à l'utilisateur. */
const ANOMALY_Z = 3.5;
/**
 * Seuil, plus permissif, du nettoyage interne : ces points sont écartés de
 * l'ajustement de la tendance et du calcul de dispersion, sans forcément être
 * remontés comme anomalies (ils peuvent être trop anciens).
 */
const OUTLIER_Z = 3;
/** Quantile normal à 90 % - bande de prévision à 80 %. */
const Z_80 = 1.2816;
/** 0.6745 = quantile normal à 75 %, facteur d'échelle du MAD vers un écart-type. */
const MAD_TO_SIGMA = 1 / 0.6745;

const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

interface Observation {
  /** Décalage en jours par rapport au premier jour de la fenêtre. */
  x: number;
  y: number;
  dateKey: string;
}

interface Fit {
  slope: number;
  intercept: number;
  /** Écart-type des résidus. */
  sigma: number;
  /** R² ajusté, borné à [0, 1]. */
  rSquared: number;
  n: number;
}

const FLAT_FIT: Fit = { slope: 0, intercept: 0, sigma: 0, rSquared: 0, n: 0 };

/**
 * Moindres carrés pondérés sur `(x, y)`.
 * Le poids croît linéairement de 0,25 à 1 avec la récence, pour que la droite
 * suive les inflexions récentes sans ignorer le passé.
 */
function weightedFit(points: Observation[]): Fit {
  const n = points.length;
  if (n === 0) return FLAT_FIT;
  if (n === 1) return { ...FLAT_FIT, intercept: points[0].y, n: 1 };

  const xMin = points[0].x;
  const xSpan = points[n - 1].x - xMin || 1;

  let sumW = 0, sumWX = 0, sumWY = 0, sumWXY = 0, sumWX2 = 0;
  for (const p of points) {
    const w = 0.25 + 0.75 * ((p.x - xMin) / xSpan);
    sumW += w;
    sumWX += w * p.x;
    sumWY += w * p.y;
    sumWXY += w * p.x * p.y;
    sumWX2 += w * p.x * p.x;
  }

  const denominator = sumW * sumWX2 - sumWX * sumWX;
  // Tous les x confondus (ou quasi) : la pente n'est pas identifiable.
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return { ...FLAT_FIT, intercept: sumW > 0 ? sumWY / sumW : 0, n };
  }

  const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;
  const intercept = (sumWY - slope * sumWX) / sumW;

  const meanY = sumWY / sumW;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const fitted = intercept + slope * p.x;
    ssRes += (p.y - fitted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }

  const sigma = Math.sqrt(ssRes / Math.max(n - 2, 1));
  const rawR2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  // R² ajusté : pénalise un ajustement obtenu sur trop peu de points.
  const adjusted = n > 2 ? 1 - (1 - rawR2) * ((n - 1) / (n - 2)) : rawR2;

  return {
    slope: Number.isFinite(slope) ? slope : 0,
    intercept: Number.isFinite(intercept) ? intercept : 0,
    sigma: Number.isFinite(sigma) ? sigma : 0,
    rSquared: Math.max(0, Math.min(1, adjusted)),
    n,
  };
}

/**
 * Pente de Theil–Sen : médiane des pentes de toutes les paires de points.
 *
 * Contrairement aux moindres carrés, elle tolère qu'un tiers de l'échantillon
 * soit aberrant. C'est indispensable ici : la droite sert justement à *repérer*
 * les valeurs aberrantes, et une droite tirée par un raid déclarerait ce raid
 * normal tout en accusant les journées ordinaires qui l'entourent.
 *
 * Coût : O(n²) sur n ≤ 90 points, soit quelques milliers d'opérations.
 */
function theilSenFit(points: Observation[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };

  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[j].x - points[i].x;
      if (dx !== 0) slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  if (slopes.length === 0) return { slope: 0, intercept: points[0].y };

  const slope = median(slopes);
  const intercept = median(points.map((p) => p.y - slope * p.x));
  return {
    slope: Number.isFinite(slope) ? slope : 0,
    intercept: Number.isFinite(intercept) ? intercept : 0,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Écart médian absolu, ramené à une échelle d'écart-type. */
function robustSigma(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  return mad * MAD_TO_SIGMA;
}

/**
 * Dispersion utilisable pour normaliser des résidus.
 *
 * Le MAD vaut exactement 0 dès qu'une majorité de points sont identiques - cas
 * fréquent d'une série plate perturbée par un ou deux pics. Un sigma nul rendrait
 * tout écart infiniment significatif *et* empêcherait toute comparaison : on
 * plancher donc sur une fraction de l'ordre de grandeur de la série.
 */
function residualScale(residuals: number[], values: number[]): number {
  const magnitude = Math.abs(median(values));
  return Math.max(robustSigma(residuals), magnitude * 0.02, 0.5);
}

/**
 * Indices saisonniers hebdomadaires, **normalisés pour que leur moyenne vaille 1**.
 * Sans cette normalisation, une série dont les ratios moyens valent 1,3
 * gonflait toutes les prévisions de 30 %.
 *
 * Ne s'applique qu'aux séries de flux (une quantité par jour), jamais aux séries
 * de niveau (un stock cumulé).
 */
function weeklyIndices(points: Observation[], fit: Fit): number[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);

  for (const p of points) {
    const trend = fit.intercept + fit.slope * p.x;
    if (trend <= 0) continue;
    buckets[dateKeyWeekday(p.dateKey)].push(p.y / trend);
  }

  // Médiane par jour : un seul raid ne doit pas redéfinir « le samedi ».
  const raw = buckets.map((ratios) => (ratios.length > 0 ? median(ratios) : 1));

  const observed = raw.filter((_, i) => buckets[i].length > 0);
  const mean = observed.length > 0 ? observed.reduce((a, b) => a + b, 0) / observed.length : 1;
  if (!(mean > 0)) return Array(7).fill(1);

  // Recentrage + garde-fou : un indice ne peut ni annuler ni tripler la tendance.
  return raw.map((r, i) => (buckets[i].length > 0 ? Math.max(0.4, Math.min(2.5, r / mean)) : 1));
}

// ---------------------------------------------------------------------------
// Séries
// ---------------------------------------------------------------------------

type SeriesKind = 'flow' | 'level';

interface ProjectedSeries {
  trend: TrendPoint[];
  fit: Fit;
  anomalies: Array<{ dateKey: string; value: number; residual: number; expected: number }>;
  sigma: number;
}

/**
 * Projette une série sur {@link FORECAST_DAYS} jours et repère ses anomalies.
 *
 * @param kind `flow` pour une quantité produite chaque jour (messages, minutes de
 *             vocal) - la saisonnalité hebdomadaire s'y applique.
 *             `level` pour un stock (nombre de membres) - la série est monotone
 *             par nature, aucun coefficient saisonnier n'a de sens.
 */
function projectSeries(observed: Observation[], lastDateKey: string, kind: SeriesKind): ProjectedSeries {
  const history: TrendPoint[] = observed.map((p) => ({ dateKey: p.dateKey, value: p.y }));

  if (observed.length < MIN_DAYS_FOR_FORECAST) {
    return { trend: history, fit: FLAT_FIT, anomalies: [], sigma: 0 };
  }

  // Passe 1 - tendance robuste, uniquement pour identifier les points aberrants.
  const robust = theilSenFit(observed);
  const robustResiduals = observed.map((p) => p.y - (robust.intercept + robust.slope * p.x));
  const robustScale0 = residualScale(robustResiduals, observed.map((p) => p.y));

  const isOutlier = (index: number): boolean =>
    Math.abs(robustResiduals[index]) / robustScale0 > OUTLIER_Z;

  // Passe 2 - la tendance publiée et les indices saisonniers sont ajustés sur
  // l'échantillon nettoyé : un raid ne doit pas déformer la semaine suivante.
  const clean = observed.filter((_, i) => !isOutlier(i));
  const usable = clean.length >= MIN_DAYS_FOR_FORECAST ? clean : observed;

  const fit = weightedFit(usable);
  const indices = kind === 'flow' ? weeklyIndices(usable, fit) : Array(7).fill(1);

  const expectedAt = (x: number, dateKey: string) => {
    const trend = fit.intercept + fit.slope * x;
    return trend * indices[dateKeyWeekday(dateKey)];
  };

  // Dispersion mesurée sur les résidus détendancés et désaisonnalisés des seuls
  // points sains. Un plancher évite qu'une série parfaitement constante donne un
  // sigma nul, qui rendrait tout écart infiniment significatif.
  const cleanResiduals = usable.map((p) => p.y - expectedAt(p.x, p.dateKey));
  const sigma = residualScale(cleanResiduals, usable.map((p) => p.y));

  const anomalies =
    observed.length >= MIN_DAYS_FOR_ANOMALIES
      ? observed
          .slice(-7)
          .map((p) => {
            const expected = expectedAt(p.x, p.dateKey);
            return { dateKey: p.dateKey, value: p.y, residual: p.y - expected, expected };
          })
          .filter((r) => Math.abs(r.residual) / sigma > ANOMALY_Z)
      : [];

  const lastX = observed[observed.length - 1].x;
  const base = new Date(`${lastDateKey}T00:00:00.000Z`);

  const forecast: TrendPoint[] = [];
  for (let h = 1; h <= FORECAST_DAYS; h++) {
    const dateKey = shiftDateKey(h, base);
    const value = expectedAt(lastX + h, dateKey);
    // L'incertitude croît avec l'horizon : √h est l'hypothèse d'une marche aléatoire.
    const margin = Z_80 * sigma * Math.sqrt(h);
    const floor = kind === 'level' ? 0 : 0;
    forecast.push({
      dateKey,
      value: Math.max(floor, Math.round(value)),
      predicted: true,
      lower: Math.max(floor, Math.round(value - margin)),
      upper: Math.max(floor, Math.round(value + margin)),
    });
  }

  return { trend: [...history, ...forecast], fit, anomalies, sigma };
}

function buildAnomalyAlerts(
  series: ProjectedSeries,
  metric: string,
  metricLabel: string,
): AnomalyAlert[] {
  if (series.sigma <= 0) return [];

  return series.anomalies.map((a) => {
    const deviation = Math.abs(a.residual) / series.sigma;
    const isSpike = a.residual > 0;
    const min = Math.max(0, Math.round(a.expected - ANOMALY_Z * series.sigma));
    const max = Math.round(a.expected + ANOMALY_Z * series.sigma);

    return {
      type: isSpike ? ('spike' as const) : ('drop' as const),
      metric,
      message: isSpike
        ? `Pic anormal de ${metricLabel} le ${a.dateKey} (${Math.round(a.value)} pour ${Math.round(a.expected)} attendus)`
        : `Chute anormale de ${metricLabel} le ${a.dateKey} (${Math.round(a.value)} pour ${Math.round(a.expected)} attendus)`,
      severity: deviation > 6 ? ('danger' as const) : ('warning' as const),
      dateKey: a.dateKey,
      value: Math.round(a.value),
      expectedRange: { min, max },
      deviation: Math.round(deviation * 10) / 10,
    };
  });
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Les prévisions ne bougent qu'au rythme des snapshots quotidiens : recalculer à
 * chaque affichage du dashboard (ou à chaque changement d'onglet) était du pur
 * gaspillage. Un TTL court suffit à absorber les rafales.
 */
const CACHE_TTL_MS = 120_000;
const cache = new Map<string, { expiresAt: number; data: PredictionData }>();

export function invalidatePredictionCache(guildId?: string): void {
  if (!guildId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${guildId}:`)) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

export async function getPredictionData(guildId: string, days = 30): Promise<PredictionData> {
  const window = Math.min(Math.max(Math.trunc(days) || 30, 7), 90);
  const cacheKey = `${guildId}:${window}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const data = await computePredictionData(guildId, window);
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, data });

  // Bornage mémoire : le cache ne doit pas croître avec le nombre de guildes vues.
  if (cache.size > 500) {
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  }

  return data;
}

async function computePredictionData(guildId: string, window: number): Promise<PredictionData> {
  const startKey = shiftDateKey(-window);
  const todayKey = toDateKey();
  const zoner = new BucketZoner(await resolveGuildTimezone(guildId));

  const [dailyStats, hourlyBuckets] = await Promise.all([
    prismaRead.guildDailyStat.findMany({
      where: { guildId, dateKey: { gte: startKey, lte: todayKey } },
      // Le jour en cours est incomplet : l'inclure tirerait la tendance vers le bas.
      select: {
        dateKey: true,
        totalMembers: true,
        messagesCount: true,
        voiceMinutes: true,
        membersJoined: true,
        membersLeft: true,
      },
      orderBy: { dateKey: 'asc' },
    }),
    // Agrégation côté base, jour par jour et non sur les 24 heures d'un coup :
    // les créneaux sont stockés en UTC, et un même créneau UTC ne tombe pas à
    // la même heure locale des deux côtés d'un changement d'heure. Le regroupement
    // final se fait donc après conversion - au plus `window × 24` lignes de deux
    // entiers, ce qui reste sans commune mesure avec la lecture des messages bruts.
    prismaRead.guildHourlyStat.groupBy({
      by: ['dateKey', 'hour'],
      where: { guildId, dateKey: { gte: startKey, lt: todayKey } },
      _sum: { messagesCount: true },
    }),
  ]);

  // On exclut le jour courant, incomplet par construction.
  const completeStats = dailyStats.filter((s) => s.dateKey < todayKey);

  if (completeStats.length === 0) {
    return emptyPrediction();
  }

  const firstKey = completeStats[0].dateKey;
  const originMs = Date.parse(`${firstKey}T00:00:00Z`);
  const dayOffset = (dateKey: string) =>
    Math.round((Date.parse(`${dateKey}T00:00:00Z`) - originMs) / 86_400_000);

  const toObservations = (pick: (s: (typeof completeStats)[number]) => number): Observation[] =>
    completeStats.map((s) => ({ x: dayOffset(s.dateKey), y: pick(s), dateKey: s.dateKey }));

  const membersObs = toObservations((s) => s.totalMembers);
  const messagesObs = toObservations((s) => s.messagesCount);
  const voiceObs = toObservations((s) => s.voiceMinutes);
  const leavesObs = toObservations((s) => s.membersLeft);

  const lastKey = completeStats[completeStats.length - 1].dateKey;

  const members = projectSeries(membersObs, lastKey, 'level');
  const messages = projectSeries(messagesObs, lastKey, 'flow');
  const voice = projectSeries(voiceObs, lastKey, 'flow');
  const leaves = projectSeries(leavesObs, lastKey, 'flow');

  const anomalies = [
    ...buildAnomalyAlerts(messages, 'messages', 'messages'),
    ...buildAnomalyAlerts(voice, 'voice', 'activité vocale'),
    ...buildAnomalyAlerts(leaves, 'leaves', 'départs'),
  ].sort((a, b) => b.deviation - a.deviation);

  const growthForecast = buildGrowthForecast(members.fit, membersObs);

  return {
    membersTrend: members.trend,
    messagesTrend: messages.trend,
    voiceTrend: voice.trend,
    growthForecast,
    anomalies,
    seasonality: buildSeasonality(
      completeStats,
      hourlyBuckets as Array<{ dateKey: string; hour: number; _sum: { messagesCount: number | null } }>,
      zoner,
    ),
    observedDays: completeStats.length,
    hasData: completeStats.length >= MIN_DAYS_FOR_FORECAST,
  };
}

function buildGrowthForecast(fit: Fit, observations: Observation[]): PredictionData['growthForecast'] {
  if (observations.length < MIN_DAYS_FOR_FORECAST) {
    const last = observations[observations.length - 1]?.y ?? 0;
    return { predicted7d: last, predicted30d: last, confidence: 0, dailyNet: 0 };
  }

  const lastX = observations[observations.length - 1].x;
  // Point de départ = valeur *ajustée* au dernier jour, pas la valeur brute :
  // une journée atypique ne doit pas décaler toute la projection.
  const fittedLast = fit.intercept + fit.slope * lastX;

  // Fiabilité = qualité de l'ajustement × suffisance de l'échantillon.
  const sampleFactor = Math.min(1, observations.length / 14);
  const confidence = Math.round(Math.max(5, Math.min(95, fit.rSquared * sampleFactor * 100)));

  return {
    predicted7d: Math.max(0, Math.round(fittedLast + fit.slope * 7)),
    predicted30d: Math.max(0, Math.round(fittedLast + fit.slope * 30)),
    confidence,
    dailyNet: Math.round(fit.slope * 100) / 100,
  };
}

function buildSeasonality(
  stats: Array<{ dateKey: string; messagesCount: number }>,
  hourlyBuckets: Array<{ dateKey: string; hour: number; _sum: { messagesCount: number | null } }>,
  zoner: BucketZoner,
): SeasonalityProfile {
  // Moyennes et non totaux : sur une fenêtre de 30 jours certains jours de la
  // semaine apparaissent 5 fois et d'autres 4, ce qui biaisait le classement.
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  for (const stat of stats) {
    const day = dateKeyWeekday(stat.dateKey);
    sums[day] += stat.messagesCount;
    counts[day] += 1;
  }
  const weekdayAverages = sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : 0));

  let busiestDay = 0, quietestDay = 0;
  let busiestVal = -Infinity, quietestVal = Infinity;
  for (let d = 0; d < 7; d++) {
    if (counts[d] === 0) continue; // Jour jamais observé : ni pic ni creux.
    if (weekdayAverages[d] > busiestVal) { busiestVal = weekdayAverages[d]; busiestDay = d; }
    if (weekdayAverages[d] < quietestVal) { quietestVal = weekdayAverages[d]; quietestDay = d; }
  }

  // Dénominateur constant = nombre de jours observés. Une heure sans aucune ligne
  // vaut 0 message/jour ; l'ancienne version l'excluait purement et simplement,
  // si bien que l'heure la plus creuse ne pouvait jamais être détectée.
  const observedDays = Math.max(stats.length, 1);
  // Somme puis moyenne à l'heure murale du serveur : « le serveur s'anime à
  // 21h » doit désigner 21h sur l'horloge de ses membres, pas 21h UTC.
  const hourlyTotals = Array(24).fill(0);
  for (const bucket of hourlyBuckets) {
    if (bucket.hour < 0 || bucket.hour > 23) continue;
    hourlyTotals[zoner.fromKeyHour(bucket.dateKey, bucket.hour).hour] += bucket._sum.messagesCount ?? 0;
  }
  const hourlyAverages = hourlyTotals.map((total) => total / observedDays);

  let busiestHour = 0, quietestHour = 0;
  let busiestHourVal = -Infinity, quietestHourVal = Infinity;
  for (let h = 0; h < 24; h++) {
    if (hourlyAverages[h] > busiestHourVal) { busiestHourVal = hourlyAverages[h]; busiestHour = h; }
    if (hourlyAverages[h] < quietestHourVal) { quietestHourVal = hourlyAverages[h]; quietestHour = h; }
  }

  return {
    busiestDay: DAY_NAMES[busiestDay],
    quietestDay: DAY_NAMES[quietestDay],
    busiestHour,
    quietestHour,
    weekdayAverages: weekdayAverages.map((v) => Math.round(v * 10) / 10),
    hourlyAverages: hourlyAverages.map((v) => Math.round(v * 10) / 10),
    lowConfidence: stats.length < 14,
  };
}

function emptyPrediction(): PredictionData {
  return {
    membersTrend: [],
    messagesTrend: [],
    voiceTrend: [],
    growthForecast: { predicted7d: 0, predicted30d: 0, confidence: 0, dailyNet: 0 },
    anomalies: [],
    seasonality: {
      busiestDay: DAY_NAMES[0],
      quietestDay: DAY_NAMES[0],
      busiestHour: 0,
      quietestHour: 0,
      weekdayAverages: Array(7).fill(0),
      hourlyAverages: Array(24).fill(0),
      lowConfidence: true,
    },
    observedDays: 0,
    hasData: false,
  };
}

/** Exporté pour les tests unitaires du modèle. */
export const __testing = {
  weightedFit,
  weeklyIndices,
  robustSigma,
  projectSeries,
  buildSeasonality,
  buildGrowthForecast,
  buildAnomalyAlerts,
};

export type { Fit as PredictionFit, Observation as PredictionObservation };
