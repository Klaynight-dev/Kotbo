import { describe, expect, test } from 'bun:test';
import {
  MONSTER_DROPS_MAX,
  normalizeMonsterInput,
  parseMonsterDrops,
  shouldAwardClanPoints,
} from '../../services/features/rpg/rpgBestiaryPolicy.js';

const VALID = {
  name: 'Roi Gobelin',
  description: 'Le souverain autoproclamé de la horde gobeline.',
  emoji: '👑',
  level: 5,
  health: 170,
  attack: 21,
  defense: 12,
  speed: 8,
  xpReward: 110,
  coinReward: 90,
  drops: [{ itemName: 'Dent de Gobelin', emoji: '🦷', chance: 0.5 }],
  isBoss: true,
  bossRespawnHours: 2,
};

function expectOk(input: Parameters<typeof normalizeMonsterInput>[0]) {
  const result = normalizeMonsterInput(input);
  if (!result.ok) throw new Error(`normalisation refusée : ${result.error}`);
  return result.value;
}

describe('normalisation d’une fiche de monstre', () => {
  test('conserve une fiche valide', () => {
    const monster = expectOk(VALID);
    expect(monster.name).toBe('Roi Gobelin');
    expect(monster.isBoss).toBe(true);
    expect(monster.bossRespawnHours).toBe(2);
    expect(monster.drops).toEqual([{ itemName: 'Dent de Gobelin', emoji: '🦷', chance: 0.5, coinBonus: 0 }]);
  });

  test('refuse un nom ou une description vides', () => {
    expect(normalizeMonsterInput({ ...VALID, name: '   ' }).ok).toBe(false);
    expect(normalizeMonsterInput({ ...VALID, description: '' }).ok).toBe(false);
  });

  test('ramène les statistiques aberrantes dans leurs bornes', () => {
    const monster = expectOk({ ...VALID, level: 9999, health: 0, attack: -5, speed: 1e9 });
    expect(monster.level).toBe(100);
    expect(monster.health).toBe(1);
    expect(monster.attack).toBe(0);
    expect(monster.speed).toBe(10_000);
  });

  test('la prime de clan est bornée et vaut zéro par défaut', () => {
    expect(expectOk(VALID).clanPoints).toBe(0);
    expect(expectOk({ ...VALID, clanPoints: 25 }).clanPoints).toBe(25);
    expect(expectOk({ ...VALID, clanPoints: -10 }).clanPoints).toBe(0);
    expect(expectOk({ ...VALID, clanPoints: 10_000_000 }).clanPoints).toBe(100_000);
  });

  test('un monstre ordinaire n’a jamais de délai de réapparition', () => {
    const monster = expectOk({ ...VALID, isBoss: false, bossRespawnHours: 12 });
    expect(monster.bossRespawnHours).toBeNull();
  });

  test('un boss sans délai reçoit le minimum plutôt que rien', () => {
    const monster = expectOk({ ...VALID, bossRespawnHours: undefined });
    expect(monster.bossRespawnHours).toBe(1);
  });

  test('une chance saisie en pourcentage devient une fraction', () => {
    const monster = expectOk({ ...VALID, drops: [{ itemName: 'Os Enchanté', chance: 35 }] });
    expect(monster.drops[0].chance).toBe(0.35);
    expect(monster.drops[0].emoji).toBe('📦');
  });

  test('une chance nulle ou négative est refusée', () => {
    expect(normalizeMonsterInput({ ...VALID, drops: [{ itemName: 'Os Enchanté', chance: 0 }] }).ok).toBe(false);
    expect(normalizeMonsterInput({ ...VALID, drops: [{ itemName: 'Os Enchanté', chance: -1 }] }).ok).toBe(false);
  });

  test('refuse deux fois le même objet dans le butin', () => {
    const result = normalizeMonsterInput({
      ...VALID,
      drops: [{ itemName: 'Os Enchanté', chance: 0.2 }, { itemName: 'Os Enchanté', chance: 0.5 }],
    });
    expect(result.ok).toBe(false);
  });

  test('refuse un butin trop long', () => {
    const drops = Array.from({ length: MONSTER_DROPS_MAX + 1 }, (_, i) => ({ itemName: `Objet ${i}`, chance: 0.1 }));
    expect(normalizeMonsterInput({ ...VALID, drops }).ok).toBe(false);
  });
});

describe('lecture de la colonne drops', () => {
  test('accepte le tableau natif comme la chaîne JSON des premiers seeds', () => {
    const expected = [{ itemName: 'Croc d’Hydre', emoji: '🐍', chance: 0.4, coinBonus: 0 }];
    expect(parseMonsterDrops([{ itemName: 'Croc d’Hydre', emoji: '🐍', chance: 0.4 }])).toEqual(expected);
    expect(parseMonsterDrops(JSON.stringify([{ itemName: 'Croc d’Hydre', emoji: '🐍', chance: 0.4 }]))).toEqual(expected);
  });

  test('ignore une colonne illisible plutôt que de lever', () => {
    expect(parseMonsterDrops('pas du json')).toEqual([]);
    expect(parseMonsterDrops(null)).toEqual([]);
    expect(parseMonsterDrops([{ chance: 0.5 }])).toEqual([]);
  });
});

describe('versement des points de clan', () => {
  const ON = { clansEnabled: true, clanPointsFromRpg: true };

  test('verse quand les clans tournent, que le pont est ouvert et la prime réglée', () => {
    expect(shouldAwardClanPoints(ON, 25)).toBe(true);
  });

  test('ne tente rien si les clans sont désactivés, prime réglée ou non', () => {
    expect(shouldAwardClanPoints({ clansEnabled: false, clanPointsFromRpg: true }, 25)).toBe(false);
    expect(shouldAwardClanPoints({ clansEnabled: false, clanPointsFromRpg: false }, 25)).toBe(false);
  });

  test('ne tente rien si le pont est fermé ou la guilde introuvable', () => {
    expect(shouldAwardClanPoints({ clansEnabled: true, clanPointsFromRpg: false }, 25)).toBe(false);
    expect(shouldAwardClanPoints(null, 25)).toBe(false);
  });

  test('ne tente rien sans prime', () => {
    expect(shouldAwardClanPoints(ON, 0)).toBe(false);
    expect(shouldAwardClanPoints(ON, -5)).toBe(false);
    expect(shouldAwardClanPoints(ON, Number.NaN)).toBe(false);
  });
});
