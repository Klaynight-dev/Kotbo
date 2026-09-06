/**
 * Bornes et calculs du raid hebdomadaire.
 *
 * Aucun accès base : ces règles décident de l'équilibrage d'un événement collectif, et
 * doivent rester vérifiables en test. Une réserve de points de vie mal calibrée rend le
 * raid soit expédié en trois clics, soit impossible à finir, et dans les deux cas personne
 * ne revient la semaine suivante.
 */

import { toWallClockUtcMs, zonedTimeToInstant, formatWallClockInTimezone } from '@kotbo/contracts';
import { findRaidSpell, type RaidSpell } from './rpgRaidContent.js';

export const RAID_TEAM_MODES = ['CLAN', 'RPG_GUILD'] as const;
export type RaidTeamMode = (typeof RAID_TEAM_MODES)[number];

export const RAID_BOSS_NAME_MAX = 60;
export const RAID_BOSS_DESCRIPTION_MAX = 400;
/** Au delà, l'assaut devient illisible et le boss ne lance jamais la moitié de sa liste. */
export const RAID_SPELLS_MAX = 6;

export const RAID_LEVEL_RANGE = { min: 1, max: 100 } as const;
export const RAID_STAT_RANGE = { min: 1, max: 10_000 } as const;
export const RAID_HEALTH_PER_MEMBER_RANGE = { min: 100, max: 100_000 } as const;
export const RAID_HEALTH_BOUND_RANGE = { min: 500, max: 5_000_000 } as const;
export const RAID_ASSAULTS_RANGE = { min: 1, max: 20 } as const;
/** Zéro ferme la vente : un serveur peut vouloir du raid sans assauts achetables. */
export const RAID_BOUGHT_ASSAULTS_RANGE = { min: 0, max: 20 } as const;
/** Part versée à une équipe qui échoue, en pourcentage. Zéro ne paie que la victoire. */
export const RAID_CONSOLATION_RANGE = { min: 0, max: 100 } as const;
export const RAID_ENERGY_RANGE = { min: 0, max: 100 } as const;
export const RAID_WEEKDAY_RANGE = { min: 0, max: 6 } as const;
export const RAID_HOUR_RANGE = { min: 0, max: 23 } as const;
export const RAID_DURATION_RANGE = { min: 1, max: 168 } as const;
export const RAID_REWARD_RANGE = { min: 0, max: 1_000_000 } as const;
export const RAID_CLAN_POINTS_RANGE = { min: 0, max: 100_000 } as const;

export function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(parsed)));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRaidTeamMode(value: unknown): value is RaidTeamMode {
  return typeof value === 'string' && (RAID_TEAM_MODES as readonly string[]).includes(value);
}

export function asRaidTeamMode(value: unknown): RaidTeamMode {
  return isRaidTeamMode(value) ? value : 'CLAN';
}

export interface RaidBossInput {
  name?: unknown;
  description?: unknown;
  emoji?: unknown;
  level?: unknown;
  attack?: unknown;
  defense?: unknown;
  speed?: unknown;
  spellIds?: unknown;
  enabled?: unknown;
}

export interface NormalizedRaidBoss {
  name: string;
  description: string;
  emoji: string;
  level: number;
  attack: number;
  defense: number;
  speed: number;
  spells: RaidSpell[];
  enabled: boolean;
}

export type RaidBossNormalizeResult =
  | { ok: true; value: NormalizedRaidBoss }
  | { ok: false; error: string };

/**
 * Valide une fiche de boss saisie au dashboard.
 *
 * Les sorts sont choisis dans le catalogue et jamais composés champ par champ : un
 * multiplicateur de dégâts libre laisserait écrire un sort à 100 fois les dégâts, qui ne
 * serait plus un réglage mais une panne. Ce qui se règle, ce sont les statistiques du boss
 * et la liste de ses sorts.
 */
export function normalizeRaidBossInput(input: RaidBossInput): RaidBossNormalizeResult {
  const name = text(input.name);
  if (!name) return { ok: false, error: 'Le nom du boss est obligatoire.' };
  if (name.length > RAID_BOSS_NAME_MAX) {
    return { ok: false, error: `Le nom du boss ne peut pas dépasser ${RAID_BOSS_NAME_MAX} caractères.` };
  }

  const description = text(input.description).slice(0, RAID_BOSS_DESCRIPTION_MAX);
  if (!description) return { ok: false, error: 'La description du boss est obligatoire.' };

  const rawSpells = input.spellIds === undefined ? [] : input.spellIds;
  if (!Array.isArray(rawSpells)) return { ok: false, error: 'La liste des sorts est invalide.' };
  if (rawSpells.length > RAID_SPELLS_MAX) {
    return { ok: false, error: `Un boss ne peut pas avoir plus de ${RAID_SPELLS_MAX} sorts.` };
  }

  const spells: RaidSpell[] = [];
  const seen = new Set<string>();
  for (const raw of rawSpells) {
    const id = text(raw);
    const spell = findRaidSpell(id);
    if (!spell) return { ok: false, error: `Le sort « ${id || '?'} » n'existe pas.` };
    if (seen.has(id)) return { ok: false, error: `Le sort « ${spell.name} » est présent deux fois.` };
    seen.add(id);
    spells.push(spell);
  }

  return {
    ok: true,
    value: {
      name,
      description,
      emoji: text(input.emoji) || '🐲',
      level: clampInt(input.level, RAID_LEVEL_RANGE, 20),
      attack: clampInt(input.attack, RAID_STAT_RANGE, 60),
      defense: clampInt(input.defense, RAID_STAT_RANGE, 35),
      speed: clampInt(input.speed, RAID_STAT_RANGE, 20),
      spells,
      enabled: input.enabled !== false,
    },
  };
}

/**
 * Relit la colonne `spells`.
 *
 * Un sort recopié sur un raid en cours doit rester jouable même si le catalogue a changé
 * depuis : on relit donc les valeurs stockées plutôt que de les rechercher par identifiant.
 */
export function parseRaidSpells(value: unknown): RaidSpell[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const spell = entry as Partial<RaidSpell>;
    const id = text(spell?.id);
    const effect = spell?.effect;
    if (!id || !effect || typeof effect !== 'object') return [];

    return [{
      id,
      name: text(spell.name) || id,
      emoji: text(spell.emoji) || '✨',
      icon: text(spell.icon) || 'Sparkles',
      description: text(spell.description),
      cooldownTurns: clampInt(spell.cooldownTurns, { min: 0, max: 20 }, 3),
      ...(typeof spell.triggerBelowHealth === 'number'
        ? { triggerBelowHealth: Math.min(1, Math.max(0, spell.triggerBelowHealth)) }
        : {}),
      effect: {
        damageMultiplier: Math.min(10, Math.max(0, Number(effect.damageMultiplier) || 0)),
        armorPiercing: clampFraction(effect.armorPiercing),
        lifesteal: clampFraction(effect.lifesteal),
        damageReduction: clampFraction(effect.damageReduction),
        thorns: clampFraction(effect.thorns),
        defenseMultiplier: Math.min(10, Math.max(0, Number(effect.defenseMultiplier) || 1)),
        stunNextTurn: effect.stunNextTurn === true,
        durationTurns: clampInt(effect.durationTurns, { min: 1, max: 10 }, 1),
      },
    }];
  });
}

function clampFraction(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

export interface RaidHealthConfig {
  healthPerMember: number;
  healthFloor: number;
  healthCap: number;
}

/**
 * Réserve de points de vie d'une équipe.
 *
 * Elle suit l'effectif, sinon un clan de vingt membres expédie la même épreuve qu'un clan
 * de trois. Le plancher évite qu'une équipe minuscule ne trouve un boss trivial, le plafond
 * qu'une équipe nombreuse ne se retrouve devant un mur qu'elle n'a pas le temps d'entamer.
 */
export function computeTeamHealth(memberCount: number, config: RaidHealthConfig): number {
  const members = Math.max(1, Math.trunc(Number(memberCount) || 1));
  const floor = clampInt(config.healthFloor, RAID_HEALTH_BOUND_RANGE, 2500);
  const cap = Math.max(floor, clampInt(config.healthCap, RAID_HEALTH_BOUND_RANGE, 60_000));
  const perMember = clampInt(config.healthPerMember, RAID_HEALTH_PER_MEMBER_RANGE, 1200);

  return Math.min(cap, Math.max(floor, members * perMember));
}

/**
 * Garde-fou de l'enveloppe totale d'une équipe.
 *
 * Ce n'est pas un réglage d'équilibrage mais une borne technique : le multiplicateur d'une
 * équipe peut atteindre plusieurs milliers, et une récompense par membre déjà haute
 * produirait une part individuelle qui ne tient plus dans la colonne entière où elle
 * s'ajoute. Le versement échouerait alors en silence, l'équipe étant déjà marquée payée.
 */
export const RAID_ENVELOPE_MAX = 100_000_000;

/**
 * Enveloppe d'une équipe, à partir de la récompense réglée par membre.
 *
 * Elle suit la réserve de points de vie plutôt que d'être fixe : à enveloppe unique, une
 * équipe d'une personne touchait autant qu'une de vingt pour une épreuve huit fois moindre,
 * et se fragmenter en équipes minuscules devenait la seule façon rationnelle de jouer. En
 * passant par la réserve et non par l'effectif brut, le plancher et le plafond valent aussi
 * pour la récompense : on est payé pour ce que l'équipe a réellement eu à abattre.
 */
export function computeTeamEnvelope(rewardPerMember: number, memberCount: number, config: RaidHealthConfig): number {
  const reward = Math.max(0, Math.trunc(Number(rewardPerMember) || 0));
  if (reward === 0) return 0;

  const perMember = clampInt(config.healthPerMember, RAID_HEALTH_PER_MEMBER_RANGE, 1200);
  const envelope = Math.round((reward * computeTeamHealth(memberCount, config)) / perMember);

  return Math.min(RAID_ENVELOPE_MAX, envelope);
}

export interface RaidWindowConfig {
  weekday: number;
  hour: number;
  durationHours: number;
}

export interface RaidWindow {
  opensAt: Date;
  closesAt: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prochaine ouverture, strictement après `since`, à l'heure locale du serveur.
 *
 * Le calcul passe par le fuseau configuré et non par l'heure du process, qui tourne en
 * UTC : un raid annoncé pour samedi 20 h doit ouvrir à 20 h chez ses joueurs, en été comme
 * en hiver.
 */
export function planNextRaidWindow(since: Date, config: RaidWindowConfig, timezone: string): RaidWindow {
  const weekday = clampInt(config.weekday, RAID_WEEKDAY_RANGE, 6);
  const hour = clampInt(config.hour, RAID_HOUR_RANGE, 20);
  const durationHours = clampInt(config.durationHours, RAID_DURATION_RANGE, 24);

  // Date murale du jour dans le fuseau, d'où l'on déduit le jour de la semaine local :
  // à minuit passé en UTC, on n'est pas encore le même jour partout.
  const wall = formatWallClockInTimezone(since, timezone);
  const [datePart] = wall.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const todayUtc = Date.UTC(year, month - 1, day);
  const currentWeekday = new Date(todayUtc).getUTCDay();

  let daysAhead = (weekday - currentWeekday + 7) % 7;
  let opensAt = instantFor(todayUtc, daysAhead, hour, timezone);
  // Le jour même, l'heure peut déjà être passée : on vise alors la semaine suivante.
  if (opensAt.getTime() <= since.getTime()) {
    daysAhead += 7;
    opensAt = instantFor(todayUtc, daysAhead, hour, timezone);
  }

  return { opensAt, closesAt: new Date(opensAt.getTime() + durationHours * 60 * 60 * 1000) };
}

function instantFor(todayUtcMs: number, daysAhead: number, hour: number, timezone: string): Date {
  const target = new Date(todayUtcMs + daysAhead * MS_PER_DAY);
  const wallMs = toWallClockUtcMs(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour);
  return zonedTimeToInstant(wallMs ?? target.getTime(), timezone);
}

export interface RaidSpellState {
  /** Part de réserve restante, de 0 à 1. */
  healthShare: number;
  /** Tours restants avant que chaque sort ne redevienne lançable. */
  cooldowns: Record<string, number>;
}

/**
 * Sort que le boss lance ce tour-ci, ou `null` pour une attaque normale.
 *
 * Les sorts de phase priment, du seuil le plus bas au plus haut : ils décrivent un boss
 * acculé, et un sort d'agonie qui ne partirait pas parce qu'une frappe ordinaire était
 * disponible priverait le raid de sa fin. À égalité, l'ordre de la liste tranche, ce qui
 * laisse la main à qui compose la fiche.
 */
export function pickRaidSpell(spells: RaidSpell[], state: RaidSpellState): RaidSpell | null {
  const ready = spells.filter((spell) => {
    if ((state.cooldowns[spell.id] ?? 0) > 0) return false;
    return spell.triggerBelowHealth === undefined || state.healthShare <= spell.triggerBelowHealth;
  });
  if (ready.length === 0) return null;

  const phased = ready
    .filter((spell) => spell.triggerBelowHealth !== undefined)
    .sort((a, b) => (a.triggerBelowHealth ?? 1) - (b.triggerBelowHealth ?? 1));

  return phased[0] ?? ready[0];
}

/**
 * Part de l'enveloppe versée à parts égales entre les participants.
 *
 * Le reste suit les dégâts. Tout au prorata découragerait les petits niveaux, qui ne
 * reviendraient pas ; tout à parts égales laisserait venir frapper une fois pour la forme.
 */
export const RAID_EQUAL_SHARE = 0.3;

/** Répartit une enveloppe entre les participants d'une équipe, dégâts cumulés par membre. */
export function splitRaidRewards(
  assaults: Array<{ userId: string; damage: number }>,
  envelope: number,
): Map<string, number> {
  const shares = new Map<string, number>();
  if (assaults.length === 0 || envelope <= 0) return shares;

  const byUser = new Map<string, number>();
  for (const assault of assaults) {
    byUser.set(assault.userId, (byUser.get(assault.userId) ?? 0) + Math.max(0, assault.damage));
  }

  const totalDamage = [...byUser.values()].reduce((sum, damage) => sum + damage, 0);
  const equalPart = Math.floor((envelope * RAID_EQUAL_SHARE) / byUser.size);
  const damagePool = envelope - equalPart * byUser.size;

  for (const [userId, damage] of byUser) {
    const prorata = totalDamage > 0 ? Math.floor((damagePool * damage) / totalDamage) : 0;
    shares.set(userId, equalPart + prorata);
  }

  return shares;
}
