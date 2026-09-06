import { describe, expect, test } from 'bun:test';
import {
  computeTeamEnvelope,
  computeTeamHealth,
  RAID_ENVELOPE_MAX,
  normalizeRaidBossInput,
  parseRaidSpells,
  pickRaidSpell,
  planNextRaidWindow,
  splitRaidRewards,
  RAID_EQUAL_SHARE,
} from '../../services/features/rpg/rpgRaidPolicy.js';
import { RAID_SPELLS, findRaidSpell } from '../../services/features/rpg/rpgRaidContent.js';
import { runRaidAssault } from '../../services/features/rpg/rpgRaidCombat.js';

const HEALTH = { healthPerMember: 1000, healthFloor: 2500, healthCap: 20_000 };

describe('réserve de points de vie d’une équipe', () => {
  test('suit l’effectif entre le plancher et le plafond', () => {
    expect(computeTeamHealth(10, HEALTH)).toBe(10_000);
  });

  // Sans plancher, un clan de deux personnes trouverait un boss trivial ; sans plafond, un
  // clan de cinquante se retrouverait devant un mur qu'il n'a pas le temps d'entamer.
  test('ne descend pas sous le plancher ni ne dépasse le plafond', () => {
    expect(computeTeamHealth(1, HEALTH)).toBe(2500);
    expect(computeTeamHealth(500, HEALTH)).toBe(20_000);
  });

  test('un effectif absurde ne produit pas une réserve absurde', () => {
    expect(computeTeamHealth(0, HEALTH)).toBe(2500);
    expect(computeTeamHealth(Number.NaN, HEALTH)).toBe(2500);
  });

  test('un plafond sous le plancher ne renverse pas les bornes', () => {
    expect(computeTeamHealth(10, { healthPerMember: 1000, healthFloor: 5000, healthCap: 1000 })).toBe(5000);
  });
});

describe('fenêtre hebdomadaire', () => {
  test('vise le jour demandé, à l’heure demandée', () => {
    // Mercredi 26 août 2026, 10 h à Paris.
    const since = new Date('2026-08-26T08:00:00Z');
    const { opensAt, closesAt } = planNextRaidWindow(since, { weekday: 6, hour: 20, durationHours: 24 }, 'Europe/Paris');

    expect(opensAt.getUTCDay()).toBe(6);
    expect(opensAt.getTime()).toBeGreaterThan(since.getTime());
    expect(closesAt.getTime() - opensAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // Le jour même, une fois l'heure passée, le raid ne peut plus ouvrir « tout à l'heure ».
  test('le jour même après l’heure, la semaine suivante est visée', () => {
    const since = new Date('2026-08-29T20:00:00Z');
    const { opensAt } = planNextRaidWindow(since, { weekday: 6, hour: 20, durationHours: 24 }, 'Europe/Paris');

    expect(opensAt.getTime() - since.getTime()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });

  test('l’heure reste celle du fuseau du serveur, été comme hiver', () => {
    const summer = planNextRaidWindow(new Date('2026-07-01T00:00:00Z'), { weekday: 6, hour: 20, durationHours: 2 }, 'Europe/Paris');
    const winter = planNextRaidWindow(new Date('2026-12-01T00:00:00Z'), { weekday: 6, hour: 20, durationHours: 2 }, 'Europe/Paris');

    // Paris est à UTC+2 en été et UTC+1 en hiver : 20 h locales ne tombent pas au même
    // instant UTC, ce qui est précisément ce que le fuseau doit faire.
    expect(summer.opensAt.getUTCHours()).toBe(18);
    expect(winter.opensAt.getUTCHours()).toBe(19);
  });
});

describe('choix du sort', () => {
  const crushing = findRaidSpell('crushing_blow')!;
  const lastBreath = findRaidSpell('last_breath')!;

  test('ne lance rien quand tout est en recharge', () => {
    expect(pickRaidSpell([crushing], { healthShare: 1, cooldowns: { crushing_blow: 2 } })).toBeNull();
  });

  test('un sort de phase attend son seuil', () => {
    expect(pickRaidSpell([lastBreath], { healthShare: 0.8, cooldowns: {} })).toBeNull();
    expect(pickRaidSpell([lastBreath], { healthShare: 0.2, cooldowns: {} })?.id).toBe('last_breath');
  });

  // Sans cette priorité, un souffle d'agonie ne partirait jamais tant qu'une frappe
  // ordinaire est disponible, et le raid n'aurait pas de fin différente de son début.
  test('le sort de phase passe devant un sort ordinaire disponible', () => {
    const picked = pickRaidSpell([crushing, lastBreath], { healthShare: 0.1, cooldowns: {} });
    expect(picked?.id).toBe('last_breath');
  });

  test('à égalité, l’ordre de la liste tranche', () => {
    const picked = pickRaidSpell([crushing, findRaidSpell('armor_breaker')!], { healthShare: 1, cooldowns: {} });
    expect(picked?.id).toBe('crushing_blow');
  });
});

describe('enveloppe d’une équipe', () => {
  test('suit l’effectif, comme la réserve', () => {
    expect(computeTeamEnvelope(100, 10, HEALTH)).toBe(1000);
    expect(computeTeamEnvelope(100, 1, HEALTH)).toBe(250);
  });

  // C'est tout l'intérêt : à enveloppe fixe, se scinder en équipes d'une personne
  // multipliait le gain par tête, et le raid n'avait plus rien de collectif.
  test('le gain par tête ne dépend pas de la taille de l’équipe', () => {
    const solo = computeTeamEnvelope(100, 1, HEALTH) / computeTeamHealth(1, HEALTH);
    const groupe = computeTeamEnvelope(100, 10, HEALTH) / computeTeamHealth(10, HEALTH);
    expect(solo).toBeCloseTo(groupe);
  });

  test('le plafond de réserve plafonne aussi l’enveloppe', () => {
    expect(computeTeamEnvelope(100, 500, HEALTH)).toBe(computeTeamEnvelope(100, 20, HEALTH));
  });

  test('une récompense nulle ou aberrante ne verse rien', () => {
    expect(computeTeamEnvelope(0, 10, HEALTH)).toBe(0);
    expect(computeTeamEnvelope(Number.NaN, 10, HEALTH)).toBe(0);
  });

  // Le multiplicateur peut atteindre plusieurs milliers : sans borne, la part versée à un
  // joueur ne tenait plus dans sa colonne, et l'équipe restait impayée sans un mot.
  test('un réglage extrême reste dans une borne écrivable', () => {
    const extreme = { healthPerMember: 100, healthFloor: 500, healthCap: 5_000_000 };
    expect(computeTeamEnvelope(1_000_000, 100_000, extreme)).toBe(RAID_ENVELOPE_MAX);
  });
});

describe('partage des récompenses', () => {
  test('une part égale pour tous, le reste au prorata des dégâts', () => {
    const shares = splitRaidRewards([
      { userId: 'a', damage: 900 },
      { userId: 'b', damage: 100 },
    ], 1000);

    expect(shares.get('a')! + shares.get('b')!).toBeLessThanOrEqual(1000);
    expect(shares.get('a')!).toBeGreaterThan(shares.get('b')!);
    // Le petit contributeur garde au moins sa part égale : sans elle, les petits niveaux
    // ne reviendraient pas la semaine suivante.
    expect(shares.get('b')!).toBeGreaterThanOrEqual(Math.floor((1000 * RAID_EQUAL_SHARE) / 2));
  });

  test('cumule les assauts d’un même membre', () => {
    const shares = splitRaidRewards([
      { userId: 'a', damage: 300 },
      { userId: 'a', damage: 300 },
      { userId: 'b', damage: 600 },
    ], 600);

    expect(shares.get('a')).toBe(shares.get('b'));
  });

  test('une enveloppe vide ou sans participant ne verse rien', () => {
    expect(splitRaidRewards([], 500).size).toBe(0);
    expect(splitRaidRewards([{ userId: 'a', damage: 10 }], 0).size).toBe(0);
  });
});

describe('fiche de boss de raid', () => {
  const VALID = {
    name: 'Hydre Ancestrale',
    description: 'Chaque tête recousue rend la suivante plus affamée.',
    emoji: '🐍',
    level: 20,
    attack: 68,
    defense: 30,
    speed: 18,
    spellIds: ['devouring_maw', 'armor_breaker'],
  };

  test('résout les sorts depuis le catalogue', () => {
    const result = normalizeRaidBossInput(VALID);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.spells.map((spell) => spell.id)).toEqual(['devouring_maw', 'armor_breaker']);
  });

  test('refuse un sort inconnu ou répété', () => {
    expect(normalizeRaidBossInput({ ...VALID, spellIds: ['nope'] }).ok).toBe(false);
    expect(normalizeRaidBossInput({ ...VALID, spellIds: ['frenzy', 'frenzy'] }).ok).toBe(false);
  });

  test('refuse un nom ou une description vides', () => {
    expect(normalizeRaidBossInput({ ...VALID, name: '  ' }).ok).toBe(false);
    expect(normalizeRaidBossInput({ ...VALID, description: '' }).ok).toBe(false);
  });

  test('ramène les statistiques aberrantes dans leurs bornes', () => {
    const result = normalizeRaidBossInput({ ...VALID, attack: 10_000_000, level: -5 });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.attack).toBe(10_000);
    expect(result.value.level).toBe(1);
  });

  test('relit une colonne de sorts abîmée sans tomber', () => {
    expect(parseRaidSpells('pas du json')).toEqual([]);
    expect(parseRaidSpells([{ id: 'x' }])).toEqual([]);
    expect(parseRaidSpells(JSON.stringify(RAID_SPELLS)).length).toBe(RAID_SPELLS.length);
  });
});

describe('déroulé d’un assaut', () => {
  const STATS = {
    attack: 120, defense: 60, speed: 30, maxHealth: 400,
    critChance: 0.1, armorPiercing: 0, damageReduction: 0,
    // Sans enchantement : le déroulé de référence ne doit dépendre ni du vol de vie
    // ni des épines, qui ont leurs propres tests.
    lifesteal: 0, thorns: 0,
  };

  function assault(overrides: Partial<Parameters<typeof runRaidAssault>[0]> = {}) {
    return runRaidAssault({
      stats: STATS,
      playerHealth: 400,
      playerSkills: [],
      boss: { attack: 50, defense: 30, speed: 10, spells: [] },
      remainingHealth: 5000,
      totalHealth: 5000,
      // Générateur figé : le déroulé doit être rejouable, sinon un test de combat ne
      // vérifie que la chance du jour.
      random: () => 0.5,
      ...overrides,
    });
  }

  test('entame la réserve sans la faire tomber quand elle est grande', () => {
    const result = assault();
    expect(result.damageDealt).toBeGreaterThan(0);
    expect(result.killingBlow).toBe(false);
    expect(result.remainingHealth).toBe(5000 - result.damageDealt);
  });

  test('le coup de grâce est signalé quand la réserve tombe', () => {
    const result = assault({ remainingHealth: 50, totalHealth: 5000 });
    expect(result.killingBlow).toBe(true);
    expect(result.remainingHealth).toBe(0);
  });

  test('les dégâts portés restent acquis même si le joueur tombe', () => {
    const result = assault({ playerHealth: 1, boss: { attack: 500, defense: 30, speed: 99, spells: [] } });
    expect(result.survived).toBe(false);
    expect(result.damageDealt).toBeGreaterThanOrEqual(0);
  });

  // La gueule dévorante rend des points de vie au boss : ce que le joueur croit avoir
  // retiré ne doit pas compter deux fois dans la réserve de l'équipe.
  test('un soin du boss diminue les dégâts nets sans jamais les rendre négatifs', () => {
    const result = assault({
      boss: { attack: 200, defense: 30, speed: 99, spells: [findRaidSpell('devouring_maw')!] },
      remainingHealth: 4000,
      totalHealth: 5000,
    });

    expect(result.damageDealt).toBeGreaterThanOrEqual(0);
    expect(result.remainingHealth).toBeLessThanOrEqual(5000);
  });

  test('un assaut se termine toujours', () => {
    const result = assault({ remainingHealth: 10_000_000, totalHealth: 10_000_000, playerHealth: 100_000 });
    expect(result.turns.length).toBeLessThanOrEqual(30);
  });
});
