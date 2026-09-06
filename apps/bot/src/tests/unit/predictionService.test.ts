import { describe, expect, test } from 'bun:test';
import { __testing, type PredictionObservation } from '../../services/analytics/predictionService.js';
import { dateKeyWeekday, dateKeyRange, shiftDateKey, toDateKey } from '../../services/analytics/dateKeys.js';
import { BucketZoner } from '../../services/analytics/zonedBuckets.js';

// Les creneaux sont stockes en UTC : un lecteur UTC les retrouve inchanges,
// ce qui garde ces cas de test focalises sur le calcul de saisonnalite.
const UTC = new BucketZoner('UTC');

const { weightedFit, weeklyIndices, robustSigma, projectSeries, buildSeasonality, buildGrowthForecast, buildAnomalyAlerts } =
  __testing;

/** Série quotidienne continue se terminant à `endKey`. */
function series(endKey: string, values: number[]): PredictionObservation[] {
  const keys = dateKeyRange(endKey, values.length);
  return values.map((y, i) => ({ x: i, y, dateKey: keys[i] }));
}

const END = '2026-06-30';

describe('dateKeys', () => {
  test('le jour de semaine est calculé en UTC, indépendamment du fuseau machine', () => {
    // 2026-06-30 est un mardi.
    expect(dateKeyWeekday('2026-06-30')).toBe(2);
    expect(dateKeyWeekday('2026-07-05')).toBe(0);
    expect(dateKeyWeekday('nimporte quoi')).toBe(0);
  });

  test('shiftDateKey traverse correctement les fins de mois et les années', () => {
    expect(shiftDateKey(1, new Date('2026-06-30T00:00:00Z'))).toBe('2026-07-01');
    expect(shiftDateKey(-1, new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-31');
    expect(shiftDateKey(1, new Date('2028-02-28T00:00:00Z'))).toBe('2028-02-29');
  });

  test('dateKeyRange produit des jours consécutifs et ordonnés', () => {
    expect(dateKeyRange('2026-03-03', 3)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  test('toDateKey renvoie bien une clé ISO', () => {
    expect(toDateKey(new Date('2026-06-30T23:59:59Z'))).toBe('2026-06-30');
  });
});

describe('régression', () => {
  test('retrouve exactement une droite parfaite', () => {
    const points = series(END, Array.from({ length: 20 }, (_, i) => 100 + 3 * i));
    const fit = weightedFit(points);

    expect(fit.slope).toBeCloseTo(3, 6);
    expect(fit.intercept).toBeCloseTo(100, 6);
    expect(fit.rSquared).toBeCloseTo(1, 6);
    expect(fit.sigma).toBeLessThan(1e-6);
  });

  test("un trou dans l'historique ne fausse pas la pente", () => {
    // Même droite, mais trois jours manquants au milieu (bot hors ligne).
    const complete = series(END, Array.from({ length: 20 }, (_, i) => 100 + 3 * i));
    const withGap = complete.filter((p) => p.x < 8 || p.x > 10);

    // L'ancienne implémentation réindexait par position et voyait une pente de
    // 3 × 20/17 ; ici l'axe reste le décalage en jours réel.
    expect(weightedFit(withGap).slope).toBeCloseTo(3, 6);
  });

  test('une série plate ne produit ni pente ni division par zéro', () => {
    const fit = weightedFit(series(END, Array(12).fill(42)));
    expect(fit.slope).toBeCloseTo(0, 9);
    expect(fit.intercept).toBeCloseTo(42, 6);
    expect(Number.isFinite(fit.sigma)).toBe(true);
  });

  test('les cas dégénérés renvoient un ajustement neutre', () => {
    expect(weightedFit([]).slope).toBe(0);
    expect(weightedFit([{ x: 0, y: 7, dateKey: END }]).intercept).toBe(7);
  });
});

describe('indices saisonniers', () => {
  test('leur moyenne vaut 1 : aucun biais multiplicatif introduit', () => {
    // 28 jours avec un week-end deux fois plus actif.
    const values = Array.from({ length: 28 }, (_, i) => {
      const weekday = dateKeyWeekday(dateKeyRange(END, 28)[i]);
      return weekday === 0 || weekday === 6 ? 200 : 100;
    });
    const points = series(END, values);
    const indices = weeklyIndices(points, weightedFit(points));

    const mean = indices.reduce((a, b) => a + b, 0) / 7;
    expect(mean).toBeCloseTo(1, 6);
  });

  test('le week-end ressort au-dessus de la semaine', () => {
    const keys = dateKeyRange(END, 28);
    const values = keys.map((k) => (dateKeyWeekday(k) === 6 ? 300 : 100));
    const points = series(END, values);
    const indices = weeklyIndices(points, weightedFit(points));

    expect(indices[6]).toBeGreaterThan(indices[3]);
  });

  test('un jour jamais observé garde un indice neutre', () => {
    const points = series(END, Array(3).fill(50));
    const indices = weeklyIndices(points, weightedFit(points));
    const unobserved = [0, 1, 2, 3, 4, 5, 6].filter(
      (d) => !points.some((p) => dateKeyWeekday(p.dateKey) === d),
    );
    for (const d of unobserved) expect(indices[d]).toBe(1);
  });
});

describe('dispersion robuste', () => {
  test('une poignée de valeurs extrêmes ne gonfle pas la dispersion', () => {
    const clean = Array(30).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
    const polluted = [...clean, 500, -500];

    // Un écart-type classique doublerait ; le MAD reste stable.
    expect(robustSigma(polluted)).toBeCloseTo(robustSigma(clean), 6);
  });
});

describe('projection', () => {
  test('la prévision part de la droite ajustée, pas du dernier point brut', () => {
    // Droite parfaite, sauf le dernier jour qui s'effondre accidentellement.
    const values = Array.from({ length: 20 }, (_, i) => 100 + 5 * i);
    values[values.length - 1] = 0;

    const projected = projectSeries(series(END, values), END, 'flow');
    const firstForecast = projected.trend.find((p) => p.predicted);

    // L'ancienne formule (`dernier + pente`) prédisait ~5 ; on attend le
    // prolongement de la tendance, autour de 195.
    expect(firstForecast!.value).toBeGreaterThan(120);
  });

  test('une série de niveau ne reçoit aucun coefficient saisonnier', () => {
    // Membres strictement croissants : chaque prévision doit rester croissante.
    const values = Array.from({ length: 28 }, (_, i) => 1000 + 2 * i);
    const projected = projectSeries(series(END, values), END, 'level');
    const forecast = projected.trend.filter((p) => p.predicted);

    for (let i = 1; i < forecast.length; i++) {
      expect(forecast[i].value).toBeGreaterThanOrEqual(forecast[i - 1].value);
    }
  });

  test("l'intervalle de prévision encadre la valeur et s'élargit avec l'horizon", () => {
    const values = Array.from({ length: 28 }, (_, i) => 100 + 4 * i + (i % 3) * 10);
    const forecast = projectSeries(series(END, values), END, 'flow').trend.filter((p) => p.predicted);

    expect(forecast).toHaveLength(7);
    for (const point of forecast) {
      expect(point.lower!).toBeLessThanOrEqual(point.value);
      expect(point.upper!).toBeGreaterThanOrEqual(point.value);
      expect(point.value).toBeGreaterThanOrEqual(0);
    }

    const first = forecast[0].upper! - forecast[0].lower!;
    const last = forecast[6].upper! - forecast[6].lower!;
    expect(last).toBeGreaterThan(first);
  });

  test('les jours prédits suivent le dernier jour observé', () => {
    const projected = projectSeries(series(END, Array(20).fill(50)), END, 'flow');
    const predictedKeys = projected.trend.filter((p) => p.predicted).map((p) => p.dateKey);
    expect(predictedKeys).toEqual(dateKeyRange(shiftDateKey(7, new Date(`${END}T00:00:00Z`)), 7));
  });

  test('un historique trop court ne produit aucune prévision', () => {
    const projected = projectSeries(series(END, [1, 2, 3]), END, 'flow');
    expect(projected.trend.every((p) => !p.predicted)).toBe(true);
  });
});

describe('anomalies', () => {
  test("une croissance régulière n'est pas signalée comme une série de pics", () => {
    // C'était le principal faux positif : un z-score sur la moyenne brute faisait
    // ressortir chaque jour récent d'un serveur en croissance.
    const values = Array.from({ length: 30 }, (_, i) => 100 + 10 * i);
    const projected = projectSeries(series(END, values), END, 'flow');
    expect(buildAnomalyAlerts(projected, 'messages', 'messages')).toHaveLength(0);
  });

  test('un pic réel est détecté et qualifié', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + (i % 4));
    values[values.length - 2] = 5000;

    const projected = projectSeries(series(END, values), END, 'flow');
    const alerts = buildAnomalyAlerts(projected, 'messages', 'messages');

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('spike');
    expect(alerts[0].severity).toBe('danger');
    expect(alerts[0].value).toBe(5000);
    expect(alerts[0].expectedRange.min).toBeLessThanOrEqual(alerts[0].expectedRange.max);
  });

  test('une chute réelle est détectée', () => {
    const values = Array.from({ length: 30 }, () => 1000);
    values[values.length - 3] = 0;

    const alerts = buildAnomalyAlerts(
      projectSeries(series(END, values), END, 'flow'),
      'messages',
      'messages',
    );
    expect(alerts.some((a) => a.type === 'drop')).toBe(true);
  });

  test('une anomalie n’en masque pas une seconde', () => {
    // Avec une moyenne/écart-type classiques, le premier pic gonflait la
    // référence au point de rendre le second invisible.
    const values = Array.from({ length: 30 }, () => 100);
    values[values.length - 2] = 4000;
    values[values.length - 4] = 3500;

    const alerts = buildAnomalyAlerts(
      projectSeries(series(END, values), END, 'flow'),
      'messages',
      'messages',
    );
    expect(alerts.length).toBe(2);
  });

  test('aucune anomalie sur un historique trop court', () => {
    const values = [100, 100, 100, 100, 100, 9999];
    const alerts = buildAnomalyAlerts(
      projectSeries(series(END, values), END, 'flow'),
      'messages',
      'messages',
    );
    expect(alerts).toHaveLength(0);
  });
});

describe('prévision de croissance', () => {
  test('une tendance parfaitement linéaire donne une confiance élevée', () => {
    const points = series(END, Array.from({ length: 30 }, (_, i) => 1000 + 5 * i));
    const forecast = buildGrowthForecast(weightedFit(points), points);

    expect(forecast.predicted7d).toBe(1145 + 35 - 35 + 35 - 0); // 1145 + 5×7
    expect(forecast.predicted30d).toBe(1145 + 150);
    expect(forecast.confidence).toBeGreaterThan(85);
    expect(forecast.dailyNet).toBeCloseTo(5, 2);
  });

  test('du bruit pur donne une confiance faible, pas 85 % par défaut', () => {
    const noise = [412, 118, 903, 55, 720, 260, 988, 34, 661, 190, 845, 77, 530, 300, 970];
    const points = series(END, noise);
    const forecast = buildGrowthForecast(weightedFit(points), points);

    expect(forecast.confidence).toBeLessThan(40);
  });

  test('un historique trop court annonce une confiance nulle', () => {
    const points = series(END, [10, 12, 11]);
    const forecast = buildGrowthForecast(weightedFit(points), points);

    expect(forecast.confidence).toBe(0);
    expect(forecast.predicted7d).toBe(11);
  });

  test('une projection ne descend jamais sous zéro', () => {
    const points = series(END, Array.from({ length: 20 }, (_, i) => Math.max(0, 60 - 3 * i)));
    const forecast = buildGrowthForecast(weightedFit(points), points);
    expect(forecast.predicted30d).toBeGreaterThanOrEqual(0);
  });
});

describe('saisonnalité', () => {
  const keys = dateKeyRange(END, 30);

  test('classe les jours sur des moyennes, pas des totaux', () => {
    // Le mardi apparaît 5 fois et n'est actif qu'à moitié : sur des totaux il
    // ressortait devant des jours plus actifs mais moins fréquents.
    const stats = keys.map((dateKey) => ({
      dateKey,
      messagesCount: dateKeyWeekday(dateKey) === 2 ? 50 : 100,
    }));

    const profile = buildSeasonality(stats, [], UTC);
    expect(profile.quietestDay).toBe('Mardi');
    expect(profile.weekdayAverages[2]).toBeCloseTo(50, 6);
  });

  test("l'heure la plus creuse peut être une heure sans aucune ligne en base", () => {
    const stats = keys.map((dateKey) => ({ dateKey, messagesCount: 100 }));
    // Seules les heures 8 à 23 ont des lignes : 0 à 7 sont absentes de la base.
    const buckets = Array.from({ length: 16 }, (_, i) => ({
      dateKey: END,
      hour: i + 8,
      _sum: { messagesCount: 300 + i },
    }));

    const profile = buildSeasonality(stats, buckets, UTC);
    // L'ancienne version ne regardait que les heures présentes et ne pouvait
    // donc jamais désigner une heure réellement morte.
    expect(profile.quietestHour).toBeLessThan(8);
    expect(profile.busiestHour).toBe(23);
    expect(profile.hourlyAverages).toHaveLength(24);
  });

  test('les moyennes horaires sont rapportées au nombre de jours observés', () => {
    const stats = keys.map((dateKey) => ({ dateKey, messagesCount: 100 }));
    const profile = buildSeasonality(stats, [{ dateKey: END, hour: 12, _sum: { messagesCount: 600 } }], UTC);
    expect(profile.hourlyAverages[12]).toBeCloseTo(20, 6);
  });

  test('les heures sont ramenees au fuseau du serveur', () => {
    // Meme creneau, meme volume : seul le fuseau de lecture change. En juin,
    // Paris est a UTC+2, donc le pic de 12h UTC est le pic de 14h.
    const stats = keys.map((dateKey) => ({ dateKey, messagesCount: 100 }));
    const buckets = [{ dateKey: END, hour: 12, _sum: { messagesCount: 600 } }];

    const paris = buildSeasonality(stats, buckets, new BucketZoner('Europe/Paris'));
    expect(paris.busiestHour).toBe(14);
    expect(paris.hourlyAverages[12]).toBe(0);
    expect(buildSeasonality(stats, buckets, UTC).busiestHour).toBe(12);
  });

  test('un échantillon court est explicitement marqué peu fiable', () => {
    const short = dateKeyRange(END, 5).map((dateKey) => ({ dateKey, messagesCount: 10 }));
    expect(buildSeasonality(short, [], UTC).lowConfidence).toBe(true);
    expect(buildSeasonality(keys.map((dateKey) => ({ dateKey, messagesCount: 10 })), [], UTC).lowConfidence).toBe(false);
  });

  test('des compteurs nuls en base sont tolérés', () => {
    const stats = keys.map((dateKey) => ({ dateKey, messagesCount: 0 }));
    const profile = buildSeasonality(stats, [{ dateKey: END, hour: 3, _sum: { messagesCount: null } }], UTC);
    expect(profile.hourlyAverages[3]).toBe(0);
    expect(Number.isFinite(profile.weekdayAverages[0])).toBe(true);
  });
});
