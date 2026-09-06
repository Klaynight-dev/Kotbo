import { describe, expect, test } from 'bun:test';
import {
  summarizeClanWeek,
  weekPosition,
  type ClanWeekEvent,
} from '../../services/community/clanDigestPolicy.js';

const PARIS = 'Europe/Paris';

describe('semaine du bilan de clan', () => {
  test('la clé est le lundi de la semaine en cours', () => {
    // Jeudi 27 août 2026, midi à Paris.
    expect(weekPosition(PARIS, new Date('2026-08-27T10:00:00Z')).weekKey).toBe('2026-08-24');
  });

  // Dimanche ferme la semaine du lundi précédent : le compter avec la suivante ferait
  // publier deux bilans à un jour d'intervalle.
  test('dimanche appartient encore à la semaine de son lundi', () => {
    expect(weekPosition(PARIS, new Date('2026-08-30T10:00:00Z')).weekKey).toBe('2026-08-24');
    expect(weekPosition(PARIS, new Date('2026-08-31T10:00:00Z')).weekKey).toBe('2026-08-31');
  });

  test('le lundi, rien ne part avant l’heure de parution', () => {
    // 07:00 puis 11:00 à Paris, le lundi 31 août 2026.
    expect(weekPosition(PARIS, new Date('2026-08-31T05:00:00Z')).tooEarly).toBe(true);
    expect(weekPosition(PARIS, new Date('2026-08-31T09:00:00Z')).tooEarly).toBe(false);
  });

  // Le retard est voulu : un bot arrêté le lundi matin doit pouvoir rattraper son bilan
  // plus tard dans la semaine, la clé restant celle du lundi.
  test('les autres jours ne retiennent jamais le bilan', () => {
    expect(weekPosition(PARIS, new Date('2026-08-26T02:00:00Z')).tooEarly).toBe(false);
  });

  test('l’heure lue est celle du serveur, pas celle du process', () => {
    // 23:00 UTC le dimanche, soit déjà lundi 01:00 à Paris.
    const utc = weekPosition('UTC', new Date('2026-08-30T23:00:00Z'));
    const paris = weekPosition(PARIS, new Date('2026-08-30T23:00:00Z'));

    expect(utc.weekKey).toBe('2026-08-24');
    expect(paris.weekKey).toBe('2026-08-31');
    expect(paris.tooEarly).toBe(true);
  });
});

describe('bilan d’une semaine de clan', () => {
  const CLANS = ['loups', 'ours', 'faucons'];
  const totals = new Map([['loups', 1000], ['ours', 900], ['faucons', 500]]);

  const event = (clanId: string, userId: string, amount: number, source = 'XP'): ClanWeekEvent =>
    ({ clanId, userId, amount, source });

  test('cumule les points de la période par clan', () => {
    const stats = summarizeClanWeek(CLANS, [
      event('loups', 'a', 30),
      event('loups', 'b', 20),
      event('ours', 'c', 10),
    ], totals);

    expect(stats.get('loups')?.points).toBe(50);
    expect(stats.get('ours')?.points).toBe(10);
    expect(stats.get('faucons')?.points).toBe(0);
  });

  test('classe les contributeurs et cumule leurs gains', () => {
    const stats = summarizeClanWeek(CLANS, [
      event('loups', 'a', 10),
      event('loups', 'b', 40),
      event('loups', 'a', 15),
    ], totals);

    expect(stats.get('loups')?.contributors).toEqual([
      { userId: 'b', points: 40 },
      { userId: 'a', points: 25 },
    ]);
  });

  // Un gain versé au clan entier n'a pas d'auteur : le faire figurer au palmarès
  // inventerait un membre qui n'existe pas.
  test('un gain versé au clan entier ne monte pas au palmarès', () => {
    const stats = summarizeClanWeek(CLANS, [
      event('loups', 'system_manual_points', 500),
      event('loups', 'a', 10),
    ], totals);

    expect(stats.get('loups')?.points).toBe(510);
    expect(stats.get('loups')?.contributors).toEqual([{ userId: 'a', points: 10 }]);
  });

  test('ventile les points par origine, la plus grosse en tête', () => {
    const stats = summarizeClanWeek(CLANS, [
      event('loups', 'a', 10, 'XP'),
      event('loups', 'b', 90, 'RPG'),
      event('loups', 'c', 20, 'XP'),
    ], totals);

    expect(stats.get('loups')?.bySource).toEqual([
      { source: 'RPG', points: 90 },
      { source: 'XP', points: 30 },
    ]);
  });

  // Tout l'intérêt du bilan : dire si la place a bougé, sans avoir gardé d'instantané.
  test('déduit le rang de la semaine passée du total moins la période', () => {
    const stats = summarizeClanWeek(CLANS, [event('ours', 'a', 600)], totals);

    // Sur la saison, les loups mènent avec 1000 contre 900.
    expect(stats.get('loups')?.rank).toBe(1);
    expect(stats.get('ours')?.rank).toBe(2);
    // Avant la semaine, les ours n'avaient que 300 : ils étaient derniers.
    expect(stats.get('ours')?.previousRank).toBe(3);
    expect(stats.get('loups')?.previousRank).toBe(1);
  });

  test('une semaine sans mouvement ne bouge aucun rang', () => {
    const stats = summarizeClanWeek(CLANS, [], totals);

    for (const clanId of CLANS) {
      const clan = stats.get(clanId);
      expect(clan?.points).toBe(0);
      expect(clan?.bySource).toEqual([]);
      expect(clan?.rank).toBe(clan?.previousRank);
    }
  });

  // Le journal peut porter un clan supprimé depuis, ou d'un autre serveur si la lecture
  // dérapait : il ne doit pas apparaître dans un bilan qui ne le liste pas.
  test('ignore un clan absent de la liste', () => {
    const stats = summarizeClanWeek(CLANS, [event('disparu', 'a', 999)], totals);

    expect(stats.has('disparu')).toBe(false);
    expect(stats.size).toBe(CLANS.length);
  });

  test('une semaine négative reste une semaine négative', () => {
    const stats = summarizeClanWeek(CLANS, [
      event('loups', 'a', 50),
      event('loups', 'a', -120, 'ADMIN'),
    ], totals);

    expect(stats.get('loups')?.points).toBe(-70);
    // Le solde du membre est négatif : il n'a pas porté le clan, il ne figure pas.
    expect(stats.get('loups')?.contributors).toEqual([]);
  });
});
