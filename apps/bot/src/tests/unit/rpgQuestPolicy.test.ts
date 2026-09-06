import { describe, expect, test } from 'bun:test';
import {
  normalizeRpgQuestInput,
  questWindowBounds,
  questWindowKey,
  QUEST_WINDOW_RANGE,
  RPG_QUEST_OBJECTIVES,
} from '../../services/features/rpg/rpgQuestPolicy.js';

const VALID = {
  name: 'Chasse du week-end',
  description: 'Abattre des boss ensemble avant la fin de la fenêtre.',
  objective: 'BOSS_KILLS',
  target: 300,
  scope: 'TEAM',
  teamMode: 'CLAN',
  windowHours: 24,
  rewardCoins: 5000,
  rewardXp: 2000,
  rewardClanPoints: 250,
};

describe('fenêtre d’une quête', () => {
  // Une fenêtre qui demarrerait au premier coup de chaque equipe donnerait a chacune sa
  // propre echeance, et leurs resultats ne seraient plus comparables.
  test('la clé ne change pas au sein d’une même fenêtre', () => {
    const start = new Date('2026-08-26T00:00:00Z');
    const later = new Date('2026-08-26T23:59:59Z');
    expect(questWindowKey(24, start)).toBe(questWindowKey(24, later));
  });

  test('la clé change au passage à la fenêtre suivante', () => {
    expect(questWindowKey(24, new Date('2026-08-26T23:59:59Z')))
      .not.toBe(questWindowKey(24, new Date('2026-08-27T00:00:01Z')));
  });

  test('une fenêtre de 24 h tombe sur minuit, une de 6 h sur les quarts de journée', () => {
    expect(questWindowBounds(24, new Date('2026-08-26T15:00:00Z')).startsAt.toISOString())
      .toBe('2026-08-26T00:00:00.000Z');
    expect(questWindowBounds(6, new Date('2026-08-26T15:00:00Z')).startsAt.toISOString())
      .toBe('2026-08-26T12:00:00.000Z');
  });

  test('la fenêtre dure exactement ce qui est demandé', () => {
    const { startsAt, endsAt } = questWindowBounds(6, new Date('2026-08-26T15:00:00Z'));
    expect(endsAt.getTime() - startsAt.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  test('une durée aberrante est ramenée dans ses bornes', () => {
    const now = new Date('2026-08-26T15:00:00Z');
    expect(questWindowKey(0, now)).toBe(questWindowKey(QUEST_WINDOW_RANGE.min, now));
    expect(questWindowKey(99_999, now)).toBe(questWindowKey(QUEST_WINDOW_RANGE.max, now));
  });
});

describe('fiche de quête', () => {
  test('conserve une fiche valide', () => {
    const result = normalizeRpgQuestInput(VALID);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.objective).toBe('BOSS_KILLS');
    expect(result.value.target).toBe(300);
    expect(result.value.rewardClanPoints).toBe(250);
  });

  test('refuse un objectif inconnu, un nom ou une description vides', () => {
    expect(normalizeRpgQuestInput({ ...VALID, objective: 'DANCE' }).ok).toBe(false);
    expect(normalizeRpgQuestInput({ ...VALID, name: '   ' }).ok).toBe(false);
    expect(normalizeRpgQuestInput({ ...VALID, description: '' }).ok).toBe(false);
  });

  // Une quete personnelle credite le clan de celui qui la termine, comme un monstre vaincu.
  // Une quete d'equipe credite l'equipe : son clan, ou sa guilde du jeu en XP de guilde.
  test('une quête personnelle garde ses points de clan', () => {
    const result = normalizeRpgQuestInput({ ...VALID, scope: 'MEMBER' });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.rewardClanPoints).toBe(250);
  });

  test('une quête de guilde RPG garde ses points, versés à la guilde', () => {
    const result = normalizeRpgQuestInput({ ...VALID, scope: 'TEAM', teamMode: 'RPG_GUILD' });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.rewardClanPoints).toBe(250);
  });

  // Le catalogue est recopié à trois endroits - l'énum Postgres, cette liste, et les
  // libellés du dashboard. Le test ne garde que le lien entre les deux premiers, mais
  // c'est là que l'oubli coûte le plus cher : une quête refusée à l'enregistrement.
  test('tous les objectifs du catalogue sont acceptés', () => {
    for (const objective of RPG_QUEST_OBJECTIVES) {
      const result = normalizeRpgQuestInput({ ...VALID, objective });
      if (!result.ok) throw new Error(`${objective} refusé : ${result.error}`);
      expect(result.value.objective).toBe(objective);
    }
  });

  test('une portée ou un mode d’équipe inconnus retombent sur leur défaut', () => {
    const result = normalizeRpgQuestInput({ ...VALID, scope: 'PLANET', teamMode: 'NOPE' });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.scope).toBe('MEMBER');
    expect(result.value.teamMode).toBe('CLAN');
  });

  test('ramène les valeurs aberrantes dans leurs bornes', () => {
    const result = normalizeRpgQuestInput({ ...VALID, target: -5, windowHours: 0, rewardCoins: 99_999_999 });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.target).toBe(1);
    expect(result.value.windowHours).toBe(QUEST_WINDOW_RANGE.min);
    expect(result.value.rewardCoins).toBe(1_000_000);
  });
});
