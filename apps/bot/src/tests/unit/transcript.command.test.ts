import { describe, expect, test } from 'bun:test';
import { parseDurationToMs, parseDateTimeOrDuration } from '../../commands/moderation/transcript';

describe('commande transcript duration parser', () => {
  test('parse correctement les durées valides', () => {
    expect(parseDurationToMs('30m')).toBe(30 * 60 * 1000);
    expect(parseDurationToMs('2h')).toBe(2 * 60 * 60 * 1000);
    expect(parseDurationToMs('1j')).toBe(24 * 60 * 60 * 1000);
    expect(parseDurationToMs('7j')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDurationToMs(' 5  heures ')).toBe(5 * 60 * 60 * 1000);
  });

  test('retourne null pour les durées invalides', () => {
    expect(parseDurationToMs('invalide')).toBeNull();
    expect(parseDurationToMs('abc')).toBeNull();
    expect(parseDurationToMs('10xyz')).toBeNull();
  });
});

describe('commande transcript datetime and duration parser', () => {
  test('parse correctement les durées relatives', () => {
    const parsed = parseDateTimeOrDuration('2h');
    expect(parsed).not.toBeNull();
    // Allow up to 10s difference due to execution time
    const diff = Math.abs((Date.now() - 2 * 60 * 60 * 1000) - (parsed || 0));
    expect(diff).toBeLessThan(10000);
  });

  test('parse correctement les timestamps unix en secondes et millisecondes', () => {
    // 1716307200 -> Wed May 21 2026 16:00:00 (approx)
    expect(parseDateTimeOrDuration('1716307200')).toBe(1716307200 * 1000);
    expect(parseDateTimeOrDuration('1716307200000')).toBe(1716307200000);
  });

  test('parse correctement le format de date français DD/MM/YYYY-HH:MM', () => {
    const parsed = parseDateTimeOrDuration('21/05/2026-16:30');
    expect(parsed).not.toBeNull();
    const date = new Date(parsed || 0);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(4); // May (0-indexed)
    expect(date.getDate()).toBe(21);
    expect(date.getHours()).toBe(16);
    expect(date.getMinutes()).toBe(30);
  });

  test('parse correctement le format de date français simple DD/MM/YYYY', () => {
    const parsed = parseDateTimeOrDuration('21/05/2026');
    expect(parsed).not.toBeNull();
    const date = new Date(parsed || 0);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(4);
    expect(date.getDate()).toBe(21);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  test('parse correctement le format ISO ou standard JS date', () => {
    const parsed = parseDateTimeOrDuration('2026-05-21T16:30:00Z');
    expect(parsed).toBe(Date.parse('2026-05-21T16:30:00Z'));
  });

  test('retourne null pour les entrées invalides', () => {
    expect(parseDateTimeOrDuration('invalide')).toBeNull();
    expect(parseDateTimeOrDuration('21/05/2026-abc')).toBeNull();
    expect(parseDateTimeOrDuration('')).toBeNull();
  });
});

describe('parseDateTimeOrDuration avec options', () => {
  test('une duree relative peut designer une echeance a venir', () => {
    const parsed = parseDateTimeOrDuration('2h', { direction: 'future' });
    expect(parsed).not.toBeNull();
    const diff = Math.abs((Date.now() + 2 * 60 * 60 * 1000) - (parsed || 0));
    expect(diff).toBeLessThan(10_000);
  });

  test('le sens par defaut reste le passe, pour /transcript', () => {
    const parsed = parseDateTimeOrDuration('2h');
    expect(parsed).not.toBeNull();
    const diff = Math.abs((Date.now() - 2 * 60 * 60 * 1000) - (parsed || 0));
    expect(diff).toBeLessThan(10_000);
  });

  test('une date francaise est lue dans le fuseau demande', () => {
    // 21h a Paris le 20 aout = 19h UTC ; sans fuseau, la lecture suit celui du
    // process, qui varie d'une machine a l'autre.
    expect(parseDateTimeOrDuration('20/08/2026-21:00', { timezone: 'Europe/Paris' }))
      .toBe(Date.parse('2026-08-20T19:00:00.000Z'));
    expect(parseDateTimeOrDuration('20/08/2026-21:00', { timezone: 'UTC' }))
      .toBe(Date.parse('2026-08-20T21:00:00.000Z'));
  });

  test('le repli de parsing suit lui aussi le fuseau demande', () => {
    expect(parseDateTimeOrDuration('2026-08-20 21:00', { timezone: 'Europe/Paris' }))
      .toBe(Date.parse('2026-08-20T19:00:00.000Z'));
  });

  test('une chaine deja horodatee garde son instant, fuseau ou pas', () => {
    expect(parseDateTimeOrDuration('2026-08-20T19:00:00Z', { timezone: 'Europe/Paris' }))
      .toBe(Date.parse('2026-08-20T19:00:00.000Z'));
  });

  test('une saisie inexploitable reste nulle avec un fuseau', () => {
    expect(parseDateTimeOrDuration('invalide', { timezone: 'Europe/Paris' })).toBeNull();
    expect(parseDateTimeOrDuration('', { timezone: 'Europe/Paris' })).toBeNull();
  });

  test('une date francaise qui n existe pas est refusee', () => {
    // Sans ce controle, « 31/02/2026 » planifiait au 3 mars sans avertir.
    expect(parseDateTimeOrDuration('31/02/2026-09:00', { timezone: 'Europe/Paris' })).toBeNull();
    expect(parseDateTimeOrDuration('31/04/2026', { timezone: 'UTC' })).toBeNull();
    expect(parseDateTimeOrDuration('31/02/2026-09:00')).toBeNull();
  });

  test('une date francaise limite reste acceptee', () => {
    expect(parseDateTimeOrDuration('29/02/2028-12:00', { timezone: 'UTC' }))
      .toBe(Date.parse('2028-02-29T12:00:00.000Z'));
    expect(parseDateTimeOrDuration('31/12/2026-23:59', { timezone: 'UTC' }))
      .toBe(Date.parse('2026-12-31T23:59:00.000Z'));
  });
});
