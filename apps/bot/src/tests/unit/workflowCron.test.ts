import { describe, expect, test } from 'bun:test';
import {
  cronMatches,
  cronToSchedule,
  isValidCron,
  parseCron,
  scheduleToCron,
  wallClockMinuteKey,
} from '@kotbo/shared';

/**
 * Instant absolu. Les motifs sont ensuite confrontes a un fuseau explicite :
 * sans ca, le resultat des tests dependrait du fuseau de la machine.
 */
const at = (iso: string) => new Date(`${iso}Z`);

/** Le fuseau neutre, sauf pour les tests qui verifient justement la conversion. */
const UTC = 'UTC';

describe('validation des motifs', () => {
  test('accepte les formes standard', () => {
    for (const pattern of ['* * * * *', '0 9 * * *', '30 8 * * 1', '0 0 1 * *', '*/15 * * * *', '0 9-17 * * 1-5', '0 0,12 * * *']) {
      expect(isValidCron(pattern)).toBeTrue();
    }
  });

  test('refuse ce qu\'elle ne sait pas interpréter', () => {
    for (const pattern of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '0 0 0 * *', '0 0 * 13 *', '@daily', '0 0 L * *', 'a b c d e', '0 0 * * 1#2', '5-1 * * * *']) {
      expect(isValidCron(pattern)).toBeFalse();
    }
  });

  test('7 et 0 designent tous deux le dimanche', () => {
    const sunday = at('2026-08-16T12:00:00');
    expect(sunday.getUTCDay()).toBe(0);
    expect(cronMatches('0 12 * * 7', sunday, UTC)).toBeTrue();
    expect(cronMatches('0 12 * * 0', sunday, UTC)).toBeTrue();
  });
});

describe('correspondance a la minute', () => {
  test('tous les jours a 9h00', () => {
    expect(cronMatches('0 9 * * *', at('2026-08-18T09:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 9 * * *', at('2026-08-18T09:01:00'), UTC)).toBeFalse();
    expect(cronMatches('0 9 * * *', at('2026-08-18T10:00:00'), UTC)).toBeFalse();
  });

  test('un pas couvre les minutes attendues', () => {
    expect(cronMatches('*/15 * * * *', at('2026-08-18T10:00:00'), UTC)).toBeTrue();
    expect(cronMatches('*/15 * * * *', at('2026-08-18T10:15:00'), UTC)).toBeTrue();
    expect(cronMatches('*/15 * * * *', at('2026-08-18T10:30:00'), UTC)).toBeTrue();
    expect(cronMatches('*/15 * * * *', at('2026-08-18T10:07:00'), UTC)).toBeFalse();
  });

  test('un intervalle de jours de semaine exclut le week-end', () => {
    // 2026-08-17 est un lundi, 2026-08-22 un samedi.
    expect(cronMatches('0 8 * * 1-5', at('2026-08-17T08:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 8 * * 1-5', at('2026-08-22T08:00:00'), UTC)).toBeFalse();
  });

  test('une liste accepte chacune de ses valeurs', () => {
    expect(cronMatches('0 0,12 * * *', at('2026-08-18T00:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 0,12 * * *', at('2026-08-18T12:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 0,12 * * *', at('2026-08-18T06:00:00'), UTC)).toBeFalse();
  });

  test('jour du mois et jour de semaine se combinent par un OU', () => {
    // Regle historique de cron : « le 1er du mois, et aussi tous les lundis ».
    // 2026-09-01 est un mardi, 2026-09-07 un lundi.
    expect(cronMatches('0 0 1 * 1', at('2026-09-01T00:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 0 1 * 1', at('2026-09-07T00:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 0 1 * 1', at('2026-09-08T00:00:00'), UTC)).toBeFalse();
  });

  test('un champ restreint seul reste un ET avec le reste', () => {
    expect(cronMatches('0 0 1 * *', at('2026-09-01T00:00:00'), UTC)).toBeTrue();
    expect(cronMatches('0 0 1 * *', at('2026-09-02T00:00:00'), UTC)).toBeFalse();
  });

  test('un motif invalide ne declenche jamais', () => {
    expect(cronMatches('nawak', at('2026-08-18T09:00:00'), UTC)).toBeFalse();
  });
});

describe('lecture dans le fuseau du serveur', () => {
  test('l heure du motif est celle du serveur, pas celle du process', () => {
    // Le bot tourne en UTC : « tous les jours a 9h » doit partir a 07:00 UTC en
    // ete a Paris, et surtout pas a 09:00 UTC.
    expect(cronMatches('0 9 * * *', at('2026-08-18T07:00:00'), 'Europe/Paris')).toBeTrue();
    expect(cronMatches('0 9 * * *', at('2026-08-18T09:00:00'), 'Europe/Paris')).toBeFalse();
  });

  test('le decalage suit l heure d hiver', () => {
    // Meme motif, meme serveur, un decalage de moins : 08:00 UTC en janvier.
    expect(cronMatches('0 9 * * *', at('2026-01-15T08:00:00'), 'Europe/Paris')).toBeTrue();
    expect(cronMatches('0 9 * * *', at('2026-01-15T07:00:00'), 'Europe/Paris')).toBeFalse();
  });

  test('le jour bascule avec le fuseau', () => {
    // 2026-08-18T23:30 UTC est deja le 19 a Paris, un mercredi.
    expect(cronMatches('30 1 19 * *', at('2026-08-18T23:30:00'), 'Europe/Paris')).toBeTrue();
    expect(cronMatches('30 1 19 * 3', at('2026-08-18T23:30:00'), 'Europe/Paris')).toBeTrue();
    expect(cronMatches('30 23 18 * *', at('2026-08-18T23:30:00'), 'Europe/Paris')).toBeFalse();
  });

  test('minuit tombe bien sur 0 et non sur 24', () => {
    expect(cronMatches('0 0 * * *', at('2026-08-17T22:00:00'), 'Europe/Paris')).toBeTrue();
  });

  test('un fuseau inconnu retombe sur UTC au lieu de tout eteindre', () => {
    expect(cronMatches('0 9 * * *', at('2026-08-18T09:00:00'), 'Mars/Olympus')).toBeTrue();
  });

  test('une etoile avec pas se combine par un ET, comme le cron systeme', () => {
    // `0 0 */2 * 1` : les lundis qui tombent un jour impair du mois.
    // 2026-09-07 est un lundi (jour 7, impair au sens de `*/2` : 1,3,5,7...).
    expect(cronMatches('0 0 */2 * 1', at('2026-09-07T00:00:00'), UTC)).toBeTrue();
    // 2026-09-14 est un lundi, mais le 14 n'est pas dans `*/2` a partir de 1.
    expect(cronMatches('0 0 */2 * 1', at('2026-09-14T00:00:00'), UTC)).toBeFalse();
    // 2026-09-09 est dans `*/2` mais c'est un mercredi.
    expect(cronMatches('0 0 */2 * 1', at('2026-09-09T00:00:00'), UTC)).toBeFalse();
  });
});

describe('composition depuis l editeur', () => {
  test('chaque frequence produit un motif valide et relisible', () => {
    const presets = [
      { frequency: 'hourly' as const, minute: 30, hour: 9, weekday: 1, day: 1 },
      { frequency: 'daily' as const, minute: 0, hour: 20, weekday: 1, day: 1 },
      { frequency: 'weekly' as const, minute: 15, hour: 8, weekday: 3, day: 1 },
      { frequency: 'monthly' as const, minute: 0, hour: 7, weekday: 1, day: 15 },
    ];

    for (const preset of presets) {
      const cron = scheduleToCron(preset);
      expect(isValidCron(cron)).toBeTrue();

      const read = cronToSchedule(cron);
      expect(read).not.toBeNull();
      expect(read!.frequency).toBe(preset.frequency);
      expect(read!.minute).toBe(preset.minute);
      if (preset.frequency !== 'hourly') expect(read!.hour).toBe(preset.hour);
      if (preset.frequency === 'weekly') expect(read!.weekday).toBe(preset.weekday);
      if (preset.frequency === 'monthly') expect(read!.day).toBe(preset.day);
    }
  });

  test('un motif hors des quatre frequences se relit en null', () => {
    // L'editeur bascule alors sur la saisie brute plutot que d'afficher des
    // reglages qui ne correspondent pas.
    expect(cronToSchedule('*/15 * * * *')).toBeNull();
    expect(cronToSchedule('0 9-17 * * *')).toBeNull();
    expect(cronToSchedule('0 0 1 1 *')).toBeNull();
    expect(cronToSchedule('0 0 1 * 1')).toBeNull();
  });

  test('les valeurs aberrantes sont ramenees dans les bornes', () => {
    expect(scheduleToCron({ frequency: 'daily', minute: 99, hour: -3, weekday: 1, day: 1 })).toBe('59 0 * * *');
  });
});

describe('repere de minute murale', () => {
  test('le retour a l heure d hiver repasse par la meme minute murale', () => {
    // 2026-10-25, dernier dimanche d'octobre : Paris repasse de 03h CEST a 02h
    // CET. « 02h30 » y tombe deux fois, a une heure d'intervalle.
    const premierPassage = at('2026-10-25T00:30:00');
    const secondPassage = at('2026-10-25T01:30:00');

    expect(cronMatches('30 2 * * *', premierPassage, 'Europe/Paris')).toBeTrue();
    expect(cronMatches('30 2 * * *', secondPassage, 'Europe/Paris')).toBeTrue();
    // Le balayage s'appuie la-dessus pour ne pas declencher deux fois.
    expect(wallClockMinuteKey(premierPassage, 'Europe/Paris'))
      .toBe(wallClockMinuteKey(secondPassage, 'Europe/Paris'));
  });

  test('deux minutes distinctes gardent des reperes distincts', () => {
    expect(wallClockMinuteKey(at('2026-08-18T09:00:00'), UTC)).toBe('2026-08-18T09:00');
    expect(wallClockMinuteKey(at('2026-08-18T09:01:00'), UTC)).toBe('2026-08-18T09:01');
  });

  test('le repere suit le fuseau, pas l instant', () => {
    expect(wallClockMinuteKey(at('2026-08-18T22:30:00'), 'Europe/Paris')).toBe('2026-08-19T00:30');
  });
});

describe('structure analysee', () => {
  test('parseCron distingue l etoile d une enumeration complete', () => {
    expect(parseCron('* * * * *')!.dayOfWeekWildcard).toBeTrue();
    expect(parseCron('* * * * 0-6')!.dayOfWeekWildcard).toBeFalse();
  });
});
