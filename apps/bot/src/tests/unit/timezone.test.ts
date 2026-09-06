import { describe, expect, test } from 'bun:test';
import { formatInTimezone, parseDateTimeInTimezone, zonedTimeToInstant } from '../../utils/timezone';

// Le process tourne en UTC en conteneur : ces tests verifient qu'une heure
// murale saisie par un admin donne le bon instant quel que soit ce fuseau.
describe('parseDateTimeInTimezone', () => {
  test('lit une heure murale dans le fuseau demande, ete comme hiver', () => {
    // Paris est a UTC+2 en aout, UTC+1 en janvier.
    expect(parseDateTimeInTimezone('2026-08-20 21:00', 'Europe/Paris')?.toISOString())
      .toBe('2026-08-20T19:00:00.000Z');
    expect(parseDateTimeInTimezone('2026-01-15 21:00', 'Europe/Paris')?.toISOString())
      .toBe('2026-01-15T20:00:00.000Z');
  });

  test('accepte le separateur T et les fuseaux hors Europe', () => {
    expect(parseDateTimeInTimezone('2026-08-20T21:00', 'Europe/Paris')?.toISOString())
      .toBe('2026-08-20T19:00:00.000Z');
    expect(parseDateTimeInTimezone('2026-08-20 21:00', 'America/Montreal')?.toISOString())
      .toBe('2026-08-21T01:00:00.000Z');
    expect(parseDateTimeInTimezone('2026-08-20 21:00', 'UTC')?.toISOString())
      .toBe('2026-08-20T21:00:00.000Z');
  });

  test('laisse intacte une chaine deja horodatee', () => {
    expect(parseDateTimeInTimezone('2026-08-20T19:00:00Z', 'Europe/Paris')?.toISOString())
      .toBe('2026-08-20T19:00:00.000Z');
  });

  test('retourne null sur une saisie inexploitable', () => {
    expect(parseDateTimeInTimezone('', 'Europe/Paris')).toBeNull();
    expect(parseDateTimeInTimezone('demain 21h', 'Europe/Paris')).toBeNull();
  });

  test('un fuseau invalide retombe sur le defaut au lieu de lever', () => {
    expect(parseDateTimeInTimezone('2026-08-20 21:00', 'Pas/UnFuseau')?.toISOString())
      .toBe('2026-08-20T19:00:00.000Z');
  });

  test('une date qui n existe pas est refusee, pas reportee', () => {
    // `Date.UTC` reporte sans rien dire : le 31 fevrier devient le 3 mars, le
    // mois 13 devient janvier de l'annee suivante. Une saisie fautive doit etre
    // rejetee pour que l'appelant affiche son message d'erreur.
    expect(parseDateTimeInTimezone('2026-02-31 09:00', 'Europe/Paris')).toBeNull();
    expect(parseDateTimeInTimezone('2026-13-01 09:00', 'Europe/Paris')).toBeNull();
    expect(parseDateTimeInTimezone('2026-04-31', 'Europe/Paris')).toBeNull();
  });

  test('le 29 fevrier d une annee bissextile reste valide', () => {
    expect(parseDateTimeInTimezone('2028-02-29 12:00', 'UTC')?.toISOString())
      .toBe('2028-02-29T12:00:00.000Z');
    expect(parseDateTimeInTimezone('2026-02-29 12:00', 'UTC')).toBeNull();
  });
});

describe('changements d heure', () => {
  test('aller-retour stable autour du retour a l heure d hiver', () => {
    const instant = parseDateTimeInTimezone('2026-10-25 02:30', 'Europe/Paris');
    expect(formatInTimezone(instant!, 'Europe/Paris', 'fr', { hour: '2-digit', minute: '2-digit' }))
      .toBe('02:30');
  });

  test('une heure inexistante bascule apres le saut au lieu d echouer', () => {
    // 02h30 n'existe pas le 29 mars 2026 a Paris : l'horloge saute de 02h a 03h.
    const instant = zonedTimeToInstant(Date.UTC(2026, 2, 29, 2, 30), 'Europe/Paris');
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('formatInTimezone', () => {
  test('formate dans le fuseau demande, pas celui du process', () => {
    const instant = new Date('2026-08-20T19:00:00.000Z');
    expect(formatInTimezone(instant, 'Europe/Paris', 'fr', { hour: '2-digit', minute: '2-digit' }))
      .toBe('21:00');
    expect(formatInTimezone(instant, 'UTC', 'fr', { hour: '2-digit', minute: '2-digit' }))
      .toBe('19:00');
  });
});
