import { describe, expect, test } from 'bun:test';
import {
  asDifficulty,
  DIFFICULTY_SCALING,
  DROP_CHANCE_CEILING,
  DROP_CHANCE_FLOOR,
  isDifficulty,
  levelWeight,
  LEVEL_WEIGHT_FLOOR,
  recommendDifficulty,
  rescaleDropChance,
  rescaleItemPrice,
  rescaleRespawnHours,
  rescaleStats,
  sameStats,
  statsMatch,
} from '../../services/features/rpg/rpgDifficultyPolicy.js';

const GOBLIN_KING = {
  health: 170,
  attack: 21,
  defense: 12,
  speed: 8,
  xpReward: 110,
  coinReward: 90,
};
const GOBLIN_KING_LEVEL = 5;

const SLIME = { health: 30, attack: 5, defense: 2, speed: 3, xpReward: 12, coinReward: 6 };

describe('paliers de difficulté', () => {
  test('le palier moyen ne touche à rien', () => {
    const same = rescaleStats(GOBLIN_KING, 'NORMAL', 'NORMAL', GOBLIN_KING_LEVEL);
    expect(same).toEqual(GOBLIN_KING);
    expect(sameStats(GOBLIN_KING, same)).toBe(true);
  });

  test('le palier facile affaiblit la créature, le palier difficile la renforce', () => {
    const easy = rescaleStats(GOBLIN_KING, 'NORMAL', 'EASY', GOBLIN_KING_LEVEL);
    const hard = rescaleStats(GOBLIN_KING, 'NORMAL', 'HARD', GOBLIN_KING_LEVEL);

    expect(easy.health).toBeLessThan(GOBLIN_KING.health);
    expect(easy.attack).toBeLessThan(GOBLIN_KING.attack);
    expect(hard.health).toBeGreaterThan(GOBLIN_KING.health);
    expect(hard.attack).toBeGreaterThan(GOBLIN_KING.attack);
  });

  test('les récompenses suivent la difficulté sans la rattraper', () => {
    expect(DIFFICULTY_SCALING.HARD.xpReward).toBeLessThan(DIFFICULTY_SCALING.HARD.health);
    expect(DIFFICULTY_SCALING.EASY.xpReward).toBeGreaterThan(DIFFICULTY_SCALING.EASY.health);
  });

  // C'est tout l'intérêt du passage par le palier de départ : sans lui, un serveur déjà en
  // difficile qui reclique sur difficile doublerait une seconde fois les points de vie.
  test('réappliquer le palier déjà en place ne change rien', () => {
    const hard = rescaleStats(GOBLIN_KING, 'NORMAL', 'HARD', GOBLIN_KING_LEVEL);
    expect(rescaleStats(hard, 'HARD', 'HARD', GOBLIN_KING_LEVEL)).toEqual(hard);
  });

  // L'arrondi à l'entier peut décaler d'une unité au retour : une créature ne se joue pas au
  // point de vie près, mais elle ne doit pas dériver plus que ça.
  test('revenir au palier moyen rend les statistiques d’origine', () => {
    const easy = rescaleStats(GOBLIN_KING, 'NORMAL', 'EASY', GOBLIN_KING_LEVEL);
    const back = rescaleStats(easy, 'EASY', 'NORMAL', GOBLIN_KING_LEVEL);

    for (const key of Object.keys(GOBLIN_KING) as Array<keyof typeof GOBLIN_KING>) {
      expect(Math.abs(back[key] - GOBLIN_KING[key])).toBeLessThanOrEqual(1);
    }
  });

  test('une retouche manuelle est conservée proportionnellement', () => {
    const hard = rescaleStats(GOBLIN_KING, 'NORMAL', 'HARD', GOBLIN_KING_LEVEL);
    const buffed = { ...hard, health: hard.health * 2 };

    const back = rescaleStats(buffed, 'HARD', 'NORMAL', GOBLIN_KING_LEVEL);
    expect(back.health).toBe(GOBLIN_KING.health * 2);
    expect(back.attack).toBe(GOBLIN_KING.attack);
  });

  test('les statistiques restent dans leurs bornes', () => {
    const monstrous = rescaleStats(
      { health: 100_000, attack: 10_000, defense: 10_000, speed: 10_000, xpReward: 1_000_000, coinReward: 1_000_000 },
      'NORMAL',
      'HARD',
      25,
    );

    expect(monstrous.health).toBe(100_000);
    expect(monstrous.attack).toBe(10_000);
    expect(monstrous.xpReward).toBe(1_000_000);

    const harmless = rescaleStats({ health: 1, attack: 0, defense: 0, speed: 0, xpReward: 0, coinReward: 0 }, 'NORMAL', 'EASY', 1);
    expect(harmless.health).toBe(1);
    expect(harmless.attack).toBe(0);
  });

  test('un palier inconnu retombe sur le palier moyen', () => {
    expect(isDifficulty('EASY')).toBe(true);
    expect(isDifficulty('IMPOSSIBLE')).toBe(false);
    expect(asDifficulty(null)).toBe('NORMAL');
    expect(asDifficulty('HARD')).toBe('HARD');
  });
});

describe('reconnaissance d’une fiche restée à son palier', () => {
  // Enchaîner deux paliers arrondit deux fois : sans tolérance, des fiches que personne n'a
  // ouvertes seraient signalées comme retouchées à la main, définitivement.
  test('les arrondis d’un enchaînement de paliers ne comptent pas pour une retouche', () => {
    const viaHard = rescaleStats(
      rescaleStats(GOBLIN_KING, 'NORMAL', 'HARD', GOBLIN_KING_LEVEL),
      'HARD',
      'EASY',
      GOBLIN_KING_LEVEL,
    );
    const direct = rescaleStats(GOBLIN_KING, 'NORMAL', 'EASY', GOBLIN_KING_LEVEL);

    expect(statsMatch(viaHard, direct)).toBe(true);
  });

  test('une retouche volontaire est reconnue', () => {
    const direct = rescaleStats(GOBLIN_KING, 'NORMAL', 'EASY', GOBLIN_KING_LEVEL);
    expect(statsMatch({ ...direct, health: direct.health * 2 }, direct)).toBe(false);
    expect(statsMatch({ ...direct, attack: direct.attack + 5 }, direct)).toBe(false);
  });

  test('une statistique nulle ou minuscule garde une marge d’une unité', () => {
    const tiny = { health: 1, attack: 0, defense: 0, speed: 1, xpReward: 0, coinReward: 0 };
    expect(statsMatch({ ...tiny, defense: 1 }, tiny)).toBe(true);
    expect(statsMatch({ ...tiny, defense: 4 }, tiny)).toBe(false);
  });
});

describe('atténuation par niveau', () => {
  test('le poids part du plancher au niveau 1 et vaut 1 au bout de la courbe', () => {
    expect(levelWeight(1)).toBeCloseTo(LEVEL_WEIGHT_FLOOR, 5);
    expect(levelWeight(20)).toBeCloseTo(1, 5);
    expect(levelWeight(80)).toBeCloseTo(1, 5);
    expect(levelWeight(0)).toBeCloseTo(LEVEL_WEIGHT_FLOOR, 5);
  });

  // Un multiplicateur plat durcirait le Slime autant que le boss final, et c'est le Slime que
  // rencontre le joueur qui vient de commencer.
  test('une créature de bas niveau encaisse moins le palier qu’une créature de haut niveau', () => {
    const slimeGrowth = rescaleStats(SLIME, 'NORMAL', 'HARD', 1).health / SLIME.health;
    const bossGrowth = rescaleStats(GOBLIN_KING, 'NORMAL', 'HARD', 25).health / GOBLIN_KING.health;

    expect(slimeGrowth).toBeGreaterThan(1);
    expect(slimeGrowth).toBeLessThan(bossGrowth);
    expect(bossGrowth).toBeCloseTo(DIFFICULTY_SCALING.HARD.health, 1);
  });
});

describe('butin, réapparition et prix', () => {
  test('le palier difficile raréfie le butin, le palier facile le rend généreux', () => {
    expect(rescaleDropChance(0.4, 'NORMAL', 'HARD', 20)).toBeLessThan(0.4);
    expect(rescaleDropChance(0.4, 'NORMAL', 'EASY', 20)).toBeGreaterThan(0.4);
  });

  test('une chance de butin ne descend jamais à zéro ni ne dépasse la certitude', () => {
    expect(rescaleDropChance(0.01, 'NORMAL', 'HARD', 25)).toBeGreaterThanOrEqual(DROP_CHANCE_FLOOR);
    expect(rescaleDropChance(1, 'NORMAL', 'EASY', 25)).toBe(1);
  });

  // Un seul butin est tiré par victoire, dans l'ordre : monter une chance à 1 rendrait tous
  // les butins suivants inatteignables.
  test('le palier ne rend jamais un butin certain', () => {
    expect(rescaleDropChance(0.8, 'NORMAL', 'EASY', 20)).toBeLessThanOrEqual(DROP_CHANCE_CEILING);
    expect(rescaleDropChance(0.9, 'NORMAL', 'EASY', 20)).toBeLessThan(1);
  });

  test('le palier difficile allonge la réapparition des boss sans passer sous une heure', () => {
    expect(rescaleRespawnHours(4, 'NORMAL', 'HARD', 20)).toBeGreaterThan(4);
    expect(rescaleRespawnHours(1, 'NORMAL', 'EASY', 20)).toBe(1);
  });

  test('le prix suit le niveau requis par l’objet', () => {
    const starter = rescaleItemPrice(100, 'NORMAL', 'HARD', 0) / 100;
    const endgame = rescaleItemPrice(100, 'NORMAL', 'HARD', 30) / 100;

    expect(starter).toBeGreaterThan(1);
    expect(starter).toBeLessThan(endgame);
  });
});

describe('palier conseillé', () => {
  test('rien n’est conseillé tant que les combats sont trop rares', () => {
    expect(recommendDifficulty({ battles: 4, wins: 4 })).toBeNull();
    expect(recommendDifficulty({ battles: 0, wins: 0 })).toBeNull();
  });

  test('un serveur où l’on gagne toujours mérite un palier plus dur, et l’inverse', () => {
    expect(recommendDifficulty({ battles: 40, wins: 38 })).toBe('HARD');
    expect(recommendDifficulty({ battles: 40, wins: 10 })).toBe('EASY');
    expect(recommendDifficulty({ battles: 40, wins: 26 })).toBe('NORMAL');
  });
});
