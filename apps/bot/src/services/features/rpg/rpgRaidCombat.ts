/**
 * Déroulé d'un assaut de raid.
 *
 * Un assaut n'est pas un combat de boss ordinaire : la réserve de points de vie appartient
 * à l'équipe et non au joueur qui frappe, le boss lance des sorts, et l'affrontement
 * s'arrête au bout d'un nombre de tours même si personne n'est tombé. Le moteur est donc
 * distinct de `simulateBattle`, dont la boucle ne connaît ni sorts adverses ni états qui
 * durent. Ce qui doit rester commun l'est déjà : `computeAttack` porte la formule de
 * dégâts, précisément pour que les deux moteurs ne divergent pas.
 *
 * Aucun accès base : tout entre par les paramètres et ressort dans le résultat, ce qui rend
 * le déroulé rejouable en test avec un générateur aléatoire injecté.
 */

import { computeAttack } from './rpgCombatMath.js';
import { pickRaidSpell } from './rpgRaidPolicy.js';
import type { RaidSpell } from './rpgRaidContent.js';

/** Au delà, l'assaut tourne en rond : ni le joueur ni la réserve ne bougent plus assez. */
export const RAID_MAX_TURNS = 30;

export interface RaidFighterStats {
  attack: number;
  defense: number;
  speed: number;
  maxHealth: number;
  critChance: number;
  armorPiercing: number;
  damageReduction: number;
  /** Vol de vie apporté par les enchantements de l'arme, de 0 à 1. */
  lifesteal: number;
  /** Dégâts renvoyés par les enchantements de l'armure, de 0 à 1. */
  thorns: number;
}

export interface RaidBossStats {
  attack: number;
  defense: number;
  speed: number;
  spells: RaidSpell[];
}

export interface RaidTurn {
  attacker: 'player' | 'boss';
  damage: number;
  critical: boolean;
  /** Sort lancé par le boss ce tour-ci, le cas échéant. */
  spellName: string | null;
  spellEmoji: string | null;
  playerHp: number;
  remainingHealth: number;
}

export interface RaidAssaultResult {
  turns: RaidTurn[];
  /** Dégâts réellement retirés de la réserve, soins du boss déduits. */
  damageDealt: number;
  damageTaken: number;
  /** Vrai si la réserve est tombée à zéro pendant cet assaut. */
  killingBlow: boolean;
  survived: boolean;
  remainingHealth: number;
  spellsCast: string[];
}

export interface RaidAssaultInput {
  stats: RaidFighterStats;
  playerHealth: number;
  /** Compétences du joueur, appliquées comme en combat de boss automatique. */
  playerSkills: Array<{ name: string; cooldownTurns: number; effect: { damageMultiplier: number; armorPiercing?: number; lifesteal?: number } }>;
  boss: RaidBossStats;
  remainingHealth: number;
  totalHealth: number;
  random?: () => number;
}

/**
 * Effet defensif en cours et le nombre de tours qui lui restent.
 *
 * Chaque effet a sa propre minuterie : un compteur partage ferait qu'une carapace posee
 * apres des ecailles brulantes prolongerait les deux, et un boss compose de deux sorts
 * defensifs tiendrait bien plus longtemps que ce que ses fiches annoncent.
 */
interface TimedEffect {
  value: number;
  turns: number;
}

interface BossState {
  cooldowns: Record<string, number>;
  defense: TimedEffect;
  reduction: TimedEffect;
  thorns: TimedEffect;
  stunPlayer: boolean;
}

/**
 * Joue un assaut et rend son déroulé.
 *
 * Le joueur commence s'il est plus rapide, comme partout ailleurs dans le jeu. Les effets
 * défensifs du boss tiennent un nombre de tours donné puis retombent : sans cette
 * expiration, une carapace lancée au premier tour rendrait le boss invulnérable jusqu'à la
 * fin de l'assaut.
 */
export function runRaidAssault(input: RaidAssaultInput): RaidAssaultResult {
  const random = input.random ?? Math.random;
  const { stats, boss } = input;

  const bestSkill = [...input.playerSkills]
    .filter((skill) => skill.effect.damageMultiplier > 0)
    .sort((a, b) => b.effect.damageMultiplier - a.effect.damageMultiplier)[0] ?? null;

  let playerHp = Math.max(1, input.playerHealth);
  let remaining = Math.max(0, input.remainingHealth);
  const total = Math.max(1, input.totalHealth);

  const state: BossState = {
    cooldowns: {},
    defense: { value: 1, turns: 0 },
    reduction: { value: 0, turns: 0 },
    thorns: { value: 0, turns: 0 },
    stunPlayer: false,
  };

  const turns: RaidTurn[] = [];
  const spellsCast: string[] = [];
  let damageDealt = 0;
  let damageTaken = 0;
  let skillCooldown = 0;

  const playerFirst = stats.speed >= boss.speed;

  for (let i = 0; i < RAID_MAX_TURNS && playerHp > 0 && remaining > 0; i++) {
    const playerTurn = (playerFirst && i % 2 === 0) || (!playerFirst && i % 2 === 1);

    if (playerTurn) {
      if (state.stunPlayer) {
        // Le tour est perdu, mais il compte : un étourdissement doit coûter du temps.
        state.stunPlayer = false;
        turns.push({ attacker: 'player', damage: 0, critical: false, spellName: null, spellEmoji: null, playerHp, remainingHealth: remaining });
        expireBossEffects(state);
        continue;
      }

      const useSkill = bestSkill !== null && skillCooldown === 0;
      const skill = useSkill ? bestSkill : null;

      const { damage, critical, healed } = computeAttack({
        attack: stats.attack,
        targetDefense: boss.defense,
        speed: stats.speed,
        critChance: stats.critChance,
        armorPiercing: Math.max(stats.armorPiercing, skill?.effect.armorPiercing ?? 0),
        skillMultiplier: skill?.effect.damageMultiplier ?? 1,
        targetDefenseMultiplier: state.defense.value,
        targetDamageReduction: state.reduction.value,
        // Vol de vie de la compétence et des enchantements : deux sources qui se cumulent.
        lifesteal: stats.lifesteal + (skill?.effect.lifesteal ?? 0),
        random,
      });

      remaining = Math.max(0, remaining - damage);
      damageDealt += damage;
      skillCooldown = useSkill ? skill!.cooldownTurns : Math.max(0, skillCooldown - 1);

      if (healed > 0) playerHp = Math.min(stats.maxHealth, playerHp + healed);

      // Les épines frappent avant que le tour ne se termine : elles punissent le coup qui
      // vient d'être porté, pas le suivant.
      if (state.thorns.turns > 0) {
        const reflected = Math.max(1, Math.floor(damage * state.thorns.value));
        playerHp = Math.max(0, playerHp - reflected);
        damageTaken += reflected;
      }

      turns.push({ attacker: 'player', damage, critical, spellName: null, spellEmoji: null, playerHp, remainingHealth: remaining });
      expireBossEffects(state);
      continue;
    }

    const spell = pickRaidSpell(boss.spells, {
      healthShare: remaining / total,
      cooldowns: state.cooldowns,
    });

    if (spell) {
      state.cooldowns[spell.id] = spell.cooldownTurns + 1;
      spellsCast.push(spell.id);
      applyBossSpell(state, spell);
    }

    let damage = 0;
    let critical = false;
    if (!spell || spell.effect.damageMultiplier > 0) {
      const attack = computeAttack({
        attack: boss.attack,
        targetDefense: stats.defense,
        speed: boss.speed,
        critChance: 0.08,
        armorPiercing: spell?.effect.armorPiercing ?? 0,
        skillMultiplier: spell?.effect.damageMultiplier ?? 1,
        targetDamageReduction: stats.damageReduction,
        targetThorns: stats.thorns,
        random,
      });
      damage = attack.damage;
      critical = attack.critical;

      playerHp = Math.max(0, playerHp - damage);
      damageTaken += damage;

      // Les épines de l'armure entament la réserve du boss, comme n'importe quel dégât
      // porté par ce joueur : elles comptent donc dans sa part de l'enveloppe.
      if (attack.reflected > 0) {
        remaining = Math.max(0, remaining - attack.reflected);
        damageDealt += attack.reflected;
      }

      // Le boss se soigne sur la réserve de l'équipe : ce que rend la gueule dévorante est
      // repris à tout le monde, pas au seul joueur present.
      if (spell?.effect.lifesteal) {
        const healed = Math.floor(damage * spell.effect.lifesteal);
        const before = remaining;
        remaining = Math.min(total, remaining + healed);
        damageDealt -= remaining - before;
      }
    }

    turns.push({
      attacker: 'boss',
      damage,
      critical,
      spellName: spell?.name ?? null,
      spellEmoji: spell?.emoji ?? null,
      playerHp,
      remainingHealth: remaining,
    });

    tickCooldowns(state);
    expireBossEffects(state);
  }

  return {
    turns,
    damageDealt: Math.max(0, damageDealt),
    damageTaken,
    killingBlow: remaining <= 0,
    survived: playerHp > 0,
    remainingHealth: remaining,
    spellsCast,
  };
}

/**
 * Pose les effets d'un sort.
 *
 * La durée est comptée en tours de jeu et non en tours de boss, d'où le doublage : un joueur
 * et un boss jouent chacun leur tour, et « deux tours » doit s'entendre comme deux échanges,
 * sans quoi une carapace annoncée pour deux tours n'en tiendrait qu'un.
 */
function applyBossSpell(state: BossState, spell: RaidSpell): void {
  const turns = (spell.effect.durationTurns ?? 1) * 2;

  if (spell.effect.defenseMultiplier && spell.effect.defenseMultiplier !== 1) {
    state.defense = { value: spell.effect.defenseMultiplier, turns };
  }
  if (spell.effect.damageReduction) {
    state.reduction = { value: spell.effect.damageReduction, turns };
  }
  if (spell.effect.thorns) {
    state.thorns = { value: spell.effect.thorns, turns };
  }
  if (spell.effect.stunNextTurn) state.stunPlayer = true;
}

/** Fait vieillir chaque effet d'un tour, et rend sa valeur neutre a celui qui expire. */
function expireBossEffects(state: BossState): void {
  age(state.defense, 1);
  age(state.reduction, 0);
  age(state.thorns, 0);
}

function age(effect: TimedEffect, neutral: number): void {
  if (effect.turns <= 0) return;
  effect.turns -= 1;
  if (effect.turns === 0) effect.value = neutral;
}

function tickCooldowns(state: BossState): void {
  for (const id of Object.keys(state.cooldowns)) {
    state.cooldowns[id] = Math.max(0, state.cooldowns[id] - 1);
  }
}
