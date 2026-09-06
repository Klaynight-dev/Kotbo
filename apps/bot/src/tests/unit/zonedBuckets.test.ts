import { describe, expect, test } from 'bun:test';
import { BucketZoner, shiftKey } from '../../services/analytics/zonedBuckets';

// Les creneaux analytics sont stockes en UTC. Ces tests verifient qu'un
// lecteur les retrouve a l'heure de son horloge, y compris quand la conversion
// change de jour ou tombe un jour de changement d'heure.
describe('BucketZoner.fromKeyHour', () => {
  test('decale l heure murale, ete comme hiver', () => {
    const paris = new BucketZoner('Europe/Paris');

    // Paris est a UTC+2 en aout : le creneau 12h UTC est le pic de 14h.
    expect(paris.fromKeyHour('2026-08-20', 12)).toEqual({
      dateKey: '2026-08-20',
      hour: 14,
      weekday: 4,
    });

    // UTC+1 en janvier : le meme creneau tombe a 13h.
    expect(paris.fromKeyHour('2026-01-15', 12).hour).toBe(13);
  });

  test('fait changer de jour quand la conversion franchit minuit', () => {
    const paris = new BucketZoner('Europe/Paris');

    // 23h UTC un jeudi, c'est 1h du matin le vendredi a Paris.
    expect(paris.fromKeyHour('2026-08-20', 23)).toEqual({
      dateKey: '2026-08-21',
      hour: 1,
      weekday: 5,
    });

    // Et dans l'autre sens a Montreal : 2h UTC, c'est 22h la veille.
    expect(new BucketZoner('America/Montreal').fromKeyHour('2026-08-20', 2)).toEqual({
      dateKey: '2026-08-19',
      hour: 22,
      weekday: 3,
    });
  });

  test('suit le changement d heure au milieu d une plage', () => {
    const paris = new BucketZoner('Europe/Paris');

    // Le 29 mars 2026, Paris passe de UTC+1 a UTC+2 a 2h du matin.
    expect(paris.fromKeyHour('2026-03-29', 0).hour).toBe(1);
    expect(paris.fromKeyHour('2026-03-29', 12).hour).toBe(14);
  });

  test('gere les fuseaux a la demi-heure', () => {
    // Asia/Kolkata est a UTC+5:30 : l'heure murale de 12h UTC est 17h30, donc
    // le creneau de l'heure 17.
    expect(new BucketZoner('Asia/Kolkata').fromKeyHour('2026-08-20', 12).hour).toBe(17);
  });

  test('laisse UTC inchange', () => {
    expect(new BucketZoner('UTC').fromKeyHour('2026-08-20', 0)).toEqual({
      dateKey: '2026-08-20',
      hour: 0,
      weekday: 4,
    });
  });

  test('replie sur le defaut plutot que d exploser sur un fuseau inconnu', () => {
    const zoner = new BucketZoner('Mars/Olympus_Mons');
    expect(zoner.timezone).toBe('Europe/Paris');
    expect(zoner.fromKeyHour('2026-08-20', 12).hour).toBe(14);
  });

  test('rend le creneau tel quel si la cle est illisible', () => {
    expect(new BucketZoner('Europe/Paris').fromKeyHour('pas-une-date', 7).hour).toBe(7);
  });
});

describe('shiftKey', () => {
  test('decale une cle jour dans les deux sens, changement de mois compris', () => {
    expect(shiftKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftKey('2026-12-31', 1)).toBe('2027-01-01');
  });
});
