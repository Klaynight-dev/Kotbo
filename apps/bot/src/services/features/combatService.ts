import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { checkLevelUp } from './economyService.js';
import { getAvailableSkills } from './rpg/rpgClasses.js';
import { listGuildMonsters } from './rpg/rpgBestiaryService.js';
import { computeAttack } from './rpg/rpgCombatMath.js';
import { getEffectiveStats, type EffectiveStats, type EquippedPiece, type Equipment, type StatItem } from './rpg/rpgStats.js';
import { parseEnchants } from './rpg/rpgEnchantments.js';

// ============================================================================
// TYPES
// ============================================================================

type MonsterDrop = {
  itemName: string;
  emoji: string;
  chance: number;
  coinBonus?: number;
};

export type BattleResult = {
  won: boolean;
  turns: BattleTurn[];
  totalDamageDealt: number;
  totalDamageTaken: number;
  xpEarned: number;
  coinsEarned: number;
  itemDropped: string | null;
  itemDropEmoji: string | null;
  playerHpRemaining: number;
  monsterHpRemaining: number;
  levelUp: number | null;
};

type BattleTurn = {
  attacker: 'player' | 'monster';
  damage: number;
  critical: boolean;
  playerHp: number;
  monsterHp: number;
  /** Nom de la compétence employée, `null` pour une attaque normale. */
  skillName: string | null;
};

/** Profil minimal nécessaire au calcul des statistiques effectives. */
type EquippableProfile = {
  id: string;
  level: number;
  attack: number;
  defense: number;
  speed: number;
  maxHealth: number;
  className: string | null;
  weaponId: string | null;
  armorId: string | null;
  accessoryId: string | null;
};

/**
 * Charge l'équipement porté et en dérive les statistiques effectives.
 *
 * Deux allers-retours au maximum : un pour les trois objets, un pour les instances qui
 * portent leur progression (forge + enchantements). Une pièce sans instance n'a tout
 * simplement jamais été améliorée ni enchantée : elle vaut ses statistiques nues.
 */
export async function loadEffectiveStats(profile: EquippableProfile): Promise<EffectiveStats> {
  return getEffectiveStats(profile, await loadEquipment(profile));
}

/**
 * Équipement porté, chaque pièce accompagnée de la progression de l'exemplaire possédé.
 * Exporté parce que le panneau en a besoin pour afficher forge et enchantements sur la fiche.
 */
export async function loadEquipment(profile: EquippableProfile): Promise<Equipment> {
  const ids = [profile.weaponId, profile.armorId, profile.accessoryId]
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) return { weapon: null, armor: null, accessory: null };

  const [items, instances] = await Promise.all([
    prisma.rpgItem.findMany({ where: { id: { in: ids } } }),
    prisma.rpgItemInstance.findMany({ where: { rpgProfileId: profile.id, itemId: { in: ids } } }),
  ]);

  const itemById = new Map<string, StatItem>(items.map((item) => [item.id, item]));
  const instanceByItemId = new Map(instances.map((instance) => [instance.itemId, instance]));

  const piece = (itemId: string | null): EquippedPiece | null => {
    if (!itemId) return null;
    const item = itemById.get(itemId);
    if (!item) return null;
    const instance = instanceByItemId.get(itemId);
    return {
      ...item,
      upgrade: instance?.upgrade ?? 0,
      enchants: parseEnchants(instance?.enchants),
    };
  };

  return {
    weapon: piece(profile.weaponId),
    armor: piece(profile.armorId),
    accessory: piece(profile.accessoryId),
  };
}

type ProfileForCombat = {
  id: string;
  guildId: string;
  userId: string;
  level: number;
  health: number;
  maxHealth: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  className: string | null;
  weaponId: string | null;
  armorId: string | null;
  accessoryId: string | null;
};

type MonsterForCombat = {
  id: string;
  name: string;
  emoji: string;
  level: number;
  health: number;
  attack: number;
  defense: number;
  speed: number;
  xpReward: number;
  coinReward: number;
  drops: unknown;
  isBoss: boolean;
};

// ============================================================================
// SEED DEFAULT MONSTERS
// ============================================================================

// Le bestiaire par défaut est global (guildId: null) : une seule exécution par process
// suffit. Sans mémoïsation, chaque combat / ouverture du bestiaire déclenchait un COUNT(*).
let seedMonstersPromise: Promise<void> | null = null;

export function seedDefaultMonsters(): Promise<void> {
  seedMonstersPromise ??= runSeedDefaultMonsters().catch((err) => {
    seedMonstersPromise = null;
    throw err;
  });
  return seedMonstersPromise;
}

async function runSeedDefaultMonsters(): Promise<void> {
  const count = await prisma.rpgMonster.count({ where: { guildId: null } });
  if (count > 0) return;

  logger.info('CombatService', 'Seeding default RPG monsters...');

  await prisma.rpgMonster.createMany({
    data: [
      // ─── Tier 1 (Niveau 1-5) ───
      { name: 'Slime', description: 'Une créature gélatineuse qui traîne dans les prairies.', emoji: '🟢', level: 1, health: 30, attack: 5, defense: 2, speed: 3, xpReward: 10, coinReward: 5, drops: JSON.stringify([{ itemName: 'Gelée de Slime', emoji: '🧪', chance: 0.3 }]) },
      { name: 'Rat Géant', description: 'Un rongeur de taille anormale qui rôde dans les égouts.', emoji: '🐀', level: 1, health: 25, attack: 7, defense: 3, speed: 8, xpReward: 12, coinReward: 8, drops: JSON.stringify([{ itemName: 'Queue de Rat', emoji: '🪶', chance: 0.25 }]) },
      { name: 'Gobelin', description: 'Un petit humanoïde vert et rusé armé d\'un couteau rouillé.', emoji: '👺', level: 2, health: 40, attack: 9, defense: 4, speed: 6, xpReward: 18, coinReward: 12, drops: JSON.stringify([{ itemName: 'Dent de Gobelin', emoji: '🦷', chance: 0.2 }]) },
      { name: 'Loup Sauvage', description: 'Un prédateur féroce aux yeux luisants qui chasse en meute.', emoji: '🐺', level: 3, health: 45, attack: 12, defense: 5, speed: 10, xpReward: 22, coinReward: 15, drops: JSON.stringify([{ itemName: 'Fourrure de Loup', emoji: '🧶', chance: 0.3 }]) },

      // ─── Tier 2 (Niveau 5-10) ───
      { name: 'Squelette Guerrier', description: 'Les os d\'un ancien soldat animés par une magie sombre.', emoji: '💀', level: 5, health: 60, attack: 15, defense: 8, speed: 7, xpReward: 30, coinReward: 20, drops: JSON.stringify([{ itemName: 'Os Enchanté', emoji: '🦴', chance: 0.2 }]) },
      { name: 'Bandit de Grand Chemin', description: 'Un voleur aguerri qui attaque les voyageurs imprudents.', emoji: '🥷', level: 5, health: 55, attack: 14, defense: 7, speed: 12, xpReward: 28, coinReward: 25, drops: JSON.stringify([{ itemName: 'Bourse Volée', emoji: '💰', chance: 0.35, coinBonus: 30 }]) },
      { name: 'Araignée Géante', description: 'Une arachnide de la taille d\'un cheval, tissant des toiles mortelles.', emoji: '🕷️', level: 6, health: 65, attack: 16, defense: 6, speed: 9, xpReward: 32, coinReward: 18, drops: JSON.stringify([{ itemName: 'Soie d\'Araignée', emoji: '🕸️', chance: 0.3 }]) },
      { name: 'Troll des Marais', description: 'Une créature massive et répugnante à la régénération redoutable.', emoji: '🧌', level: 8, health: 90, attack: 18, defense: 12, speed: 4, xpReward: 40, coinReward: 30, drops: JSON.stringify([{ itemName: 'Mousse de Troll', emoji: '🌿', chance: 0.2 }]) },

      // ─── Tier 3 (Niveau 10-20) ───
      { name: 'Chevalier Noir', description: 'Un chevalier déchu dont l\'armure est imprégnée de malédictions.', emoji: '⚔️', level: 10, health: 120, attack: 25, defense: 20, speed: 10, xpReward: 60, coinReward: 50, drops: JSON.stringify([{ itemName: 'Fragment d\'Armure Maudite', emoji: '🛡️', chance: 0.15 }]) },
      { name: 'Dragon Mineur', description: 'Un jeune dragon cracheur de feu, déjà dangereux malgré sa taille.', emoji: '🐉', level: 12, health: 140, attack: 28, defense: 18, speed: 15, xpReward: 75, coinReward: 60, drops: JSON.stringify([{ itemName: 'Écaille de Dragon', emoji: '✨', chance: 0.12 }]) },
      { name: 'Liche', description: 'Un sorcier mort-vivant dont le pouvoir nécromantique est terrifiant.', emoji: '☠️', level: 15, health: 110, attack: 32, defense: 15, speed: 12, xpReward: 85, coinReward: 70, drops: JSON.stringify([{ itemName: 'Phylactère Brisé', emoji: '💎', chance: 0.1 }]) },

      // ─── Tier 4 (Niveau 20+) ───
      { name: 'Démon Infernal', description: 'Une entité des profondeurs, incarnation de la destruction pure.', emoji: '👿', level: 20, health: 200, attack: 40, defense: 25, speed: 18, xpReward: 120, coinReward: 100, drops: JSON.stringify([{ itemName: 'Corne Démoniaque', emoji: '🔥', chance: 0.08 }]) },
      { name: 'Golem d\'Obsidienne', description: 'Un colosse de roche volcanique, quasi indestructible.', emoji: '🗿', level: 22, health: 250, attack: 35, defense: 40, speed: 5, xpReward: 130, coinReward: 110, drops: JSON.stringify([{ itemName: 'Cœur d\'Obsidienne', emoji: '🖤', chance: 0.07 }]) },

      // ─── BOSS ───
      { name: 'Roi Gobelin', description: 'Le souverain autoproclamé de la horde gobeline, entouré de ses gardes.', emoji: '👑', level: 5, health: 150, attack: 20, defense: 12, speed: 8, xpReward: 100, coinReward: 80, drops: JSON.stringify([{ itemName: 'Couronne du Roi Gobelin', emoji: '👑', chance: 0.5 }]), isBoss: true, bossRespawnHours: 1 },
      { name: 'Hydre des Marais', description: 'Une bête à trois têtes venimeuses, terreur des marécages.', emoji: '🐍', level: 10, health: 300, attack: 30, defense: 18, speed: 10, xpReward: 200, coinReward: 150, drops: JSON.stringify([{ itemName: 'Croc d\'Hydre', emoji: '🐍', chance: 0.4 }]), isBoss: true, bossRespawnHours: 2 },
      { name: 'Dragon Ancien', description: 'Le plus ancien des dragons, dont le souffle réduit les montagnes en cendres.', emoji: '🐲', level: 18, health: 500, attack: 45, defense: 30, speed: 20, xpReward: 400, coinReward: 300, drops: JSON.stringify([{ itemName: 'Cœur de Dragon', emoji: '❤️‍🔥', chance: 0.3 }]), isBoss: true, bossRespawnHours: 4 },
      { name: 'Seigneur des Ombres', description: 'L\'entité suprême des ténèbres, boss ultime du monde de Kotbo.', emoji: '🌑', level: 25, health: 800, attack: 55, defense: 35, speed: 25, xpReward: 700, coinReward: 500, drops: JSON.stringify([{ itemName: 'Orbe des Ombres', emoji: '🌑', chance: 0.2 }]), isBoss: true, bossRespawnHours: 8 },
    ]
  });
}

// ============================================================================
// FIND MONSTERS
// ============================================================================

export async function findRandomMonster(guildId: string, playerLevel: number) {
  await seedDefaultMonsters();

  const minLevel = Math.max(1, playerLevel - 3);
  const maxLevel = playerLevel + 2;

  const bestiary = await listGuildMonsters(guildId, { isBoss: false });
  const monsters = bestiary.filter((monster) => monster.level >= minLevel && monster.level <= maxLevel);

  if (monsters.length === 0) {
    const fallback = bestiary.slice(0, 5);
    if (fallback.length === 0) return null;
    return fallback[Math.floor(Math.random() * fallback.length)];
  }

  return monsters[Math.floor(Math.random() * monsters.length)];
}

export async function listBosses(guildId: string) {
  await seedDefaultMonsters();

  return listGuildMonsters(guildId, { isBoss: true });
}

export async function listDiscoveredMonsters(guildId: string, userId: string) {
  const battles = await prisma.rpgBattle.findMany({
    where: { guildId, userId },
    select: { monsterId: true },
    distinct: ['monsterId']
  });

  const monsterIds = battles.map(b => b.monsterId);
  if (monsterIds.length === 0) return [];

  return prisma.rpgMonster.findMany({
    where: { id: { in: monsterIds } },
    orderBy: { level: 'asc' }
  });
}

// ============================================================================
// COMBAT SIMULATION
// ============================================================================

export async function simulateBattle(
  profile: ProfileForCombat,
  monster: MonsterForCombat
): Promise<BattleResult> {
  const stats = await loadEffectiveStats(profile);

  // Le combat automatique de boss alterne attaque normale et meilleure compétence
  // disponible, pour que la classe et son passif pèsent autant qu'en combat interactif.
  const skills = getAvailableSkills(profile.className, profile.level)
    .filter((skill) => skill.effect.damageMultiplier > 0)
    .sort((a, b) => b.effect.damageMultiplier - a.effect.damageMultiplier);
  const bestSkill = skills[0] ?? null;

  let playerHp = profile.health;
  let monsterHp = monster.health;
  const turns: BattleTurn[] = [];

  const playerFirst = stats.speed >= monster.speed;
  const maxTurns = 40;
  let skillCooldown = 0;

  for (let i = 0; i < maxTurns && playerHp > 0 && monsterHp > 0; i++) {
    if ((playerFirst && i % 2 === 0) || (!playerFirst && i % 2 === 1)) {
      const useSkill = bestSkill !== null && skillCooldown === 0;
      const skill = useSkill ? bestSkill : null;

      const { damage, critical, healed } = computeAttack({
        attack: stats.attack,
        targetDefense: monster.defense,
        speed: stats.speed,
        critChance: stats.critChance,
        armorPiercing: Math.max(stats.armorPiercing, skill?.effect.armorPiercing ?? 0),
        skillMultiplier: skill?.effect.damageMultiplier ?? 1,
        // Le vol de vie de la compétence et celui des enchantements se cumulent : ce sont
        // deux sources distinctes, et une compétence ne doit pas annuler un enchantement.
        lifesteal: stats.lifesteal + (skill?.effect.lifesteal ?? 0),
      });

      monsterHp = Math.max(0, monsterHp - damage);
      if (healed > 0) playerHp = Math.min(stats.maxHealth, playerHp + healed);
      skillCooldown = useSkill ? (bestSkill?.cooldownTurns ?? 0) : Math.max(0, skillCooldown - 1);

      turns.push({ attacker: 'player', damage, critical, playerHp, monsterHp, skillName: skill?.name ?? null });
    } else {
      const { damage, critical, reflected } = computeAttack({
        attack: monster.attack,
        targetDefense: stats.defense,
        speed: monster.speed,
        critChance: 0.08,
        targetDamageReduction: stats.damageReduction,
        targetThorns: stats.thorns,
      });
      playerHp = Math.max(0, playerHp - damage);
      // Les épines frappent même si le coup est mortel : l'armure réagit à l'impact.
      if (reflected > 0) monsterHp = Math.max(0, monsterHp - reflected);
      turns.push({ attacker: 'monster', damage, critical, playerHp, monsterHp, skillName: null });
    }
  }

  const won = monsterHp <= 0;
  const totalDamageDealt = turns.filter(t => t.attacker === 'player').reduce((s, t) => s + t.damage, 0);
  const totalDamageTaken = turns.filter(t => t.attacker === 'monster').reduce((s, t) => s + t.damage, 0);

  let xpEarned = 0;
  let coinsEarned = 0;
  let itemDropped: string | null = null;
  let itemDropEmoji: string | null = null;

  if (won) {
    xpEarned = monster.xpReward + Math.floor(Math.random() * Math.floor(monster.xpReward * 0.3));
    coinsEarned = monster.coinReward + Math.floor(Math.random() * Math.floor(monster.coinReward * 0.3));

    const drops = (Array.isArray(monster.drops) ? monster.drops : JSON.parse(String(monster.drops || '[]'))) as MonsterDrop[];
    for (const drop of drops) {
      if (Math.random() < drop.chance) {
        itemDropped = drop.itemName;
        itemDropEmoji = drop.emoji;
        if (drop.coinBonus) coinsEarned += drop.coinBonus;

        // Le butin était annoncé dans l'embed mais jamais versé : les boss, qui passent
        // tous par cette simulation, ne rapportaient donc aucun objet.
        const dropItem = await prisma.rpgItem.findFirst({
          where: { OR: [{ guildId: null }, { guildId: profile.guildId }], name: drop.itemName },
          select: { id: true },
        });
        if (dropItem) {
          await prisma.rpgInventoryItem.upsert({
            where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: dropItem.id } },
            update: { quantity: { increment: 1 } },
            create: { rpgProfileId: profile.id, itemId: dropItem.id, quantity: 1 },
          });
        }
        break;
      }
    }
  } else {
    xpEarned = Math.floor(monster.xpReward * 0.15);
  }

  // Persist results
  await prisma.rpgProfile.update({
    where: { guildId_userId: { guildId: profile.guildId, userId: profile.userId } },
    data: {
      health: Math.max(1, playerHp),
      balance: { increment: coinsEarned },
      xp: { increment: xpEarned },
      totalMonstersKilled: won && !monster.isBoss ? { increment: 1 } : undefined,
      totalBossesKilled: won && monster.isBoss ? { increment: 1 } : undefined,
      lastBattle: new Date()
    }
  });

  await prisma.rpgBattle.create({
    data: {
      guildId: profile.guildId,
      userId: profile.userId,
      monsterId: monster.id,
      monsterName: monster.name,
      won,
      damageDealt: totalDamageDealt,
      damageTaken: totalDamageTaken,
      xpEarned,
      coinsEarned,
      itemDropped
    }
  });

  let levelUp: number | null = null;
  if (won) {
    const before = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId: profile.guildId, userId: profile.userId } } });
    const beforeLevel = before?.level ?? profile.level;
    await checkLevelUp(profile.guildId, profile.userId);
    const after = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId: profile.guildId, userId: profile.userId } } });
    if (after && after.level > beforeLevel) levelUp = after.level;
  }

  return {
    won,
    turns,
    totalDamageDealt,
    totalDamageTaken,
    xpEarned,
    coinsEarned,
    itemDropped,
    itemDropEmoji,
    playerHpRemaining: Math.max(0, playerHp),
    monsterHpRemaining: Math.max(0, monsterHp),
    levelUp
  };
}
