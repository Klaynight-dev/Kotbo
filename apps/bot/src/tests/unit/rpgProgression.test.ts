import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import {
  RPG_ADVENTURE_EVENTS,
  RPG_ITEMS,
  RPG_MONSTERS,
} from '../../services/features/rpg/rpgContent.js';

type Item = {
  id: string;
  name: string;
  type: string;
  rarity: string;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  hpBonus: number;
  hpRestore: number;
  energyRestore: number;
  price: number;
  levelRequired: number;
};

type Profile = {
  id: string;
  guildId: string;
  userId: string;
  balance: number;
  level: number;
  xp: number;
  health: number;
  maxHealth: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  className: string | null;
  statPoints: number;
  weaponId: string | null;
  armorId: string | null;
  accessoryId: string | null;
  isTraveling: boolean;
  travelStartedAt: Date | null;
  travelDurationMin: number;
  lastEnergyTick: Date;
  updatedAt: Date;
  inventory: unknown[];
};

function makeItem(overrides: Partial<Item> & Pick<Item, 'id' | 'name' | 'type'>): Item {
  return {
    rarity: 'COMMON',
    atkBonus: 0,
    defBonus: 0,
    spdBonus: 0,
    hpBonus: 0,
    hpRestore: 0,
    energyRestore: 0,
    price: 100,
    levelRequired: 0,
    ...overrides,
  };
}

const ITEMS: Record<string, Item> = {
  sword: makeItem({ id: 'sword', name: 'Épée en bois', type: 'WEAPON', atkBonus: 5, spdBonus: 2, price: 50 }),
  blade: makeItem({ id: 'blade', name: 'Dague en fer', type: 'WEAPON', atkBonus: 9, spdBonus: 4, price: 150 }),
  ring: makeItem({ id: 'ring', name: 'Anneau de cuivre', type: 'ACCESSORY', atkBonus: 2, price: 80 }),
  gate: makeItem({ id: 'gate', name: 'Lame des Anciens', type: 'WEAPON', atkBonus: 30, price: 900, levelRequired: 10 }),
  ore: makeItem({ id: 'ore', name: 'Écaille de Dragon', type: 'MATERIAL', price: 180 }),
};

type Instance = { id: string; rpgProfileId: string; itemId: string; upgrade: number; enchants: unknown };

let profile: Profile;
/** Progression par objet possédé, indexée comme la contrainte `@@unique([profil, objet])`. */
let instances: Record<string, Instance>;

const instanceKey = (rpgProfileId: string, itemId: string) => `${rpgProfileId}:${itemId}`;

/** Raccourci de lecture pour les tests : niveau de forge de l'exemplaire possédé. */
function upgradeOf(itemId: string): number {
  return instances[instanceKey('profile-1', itemId)]?.upgrade ?? 0;
}

/** Applique le sous-ensemble d'opérateurs Prisma utilisé par les services. */
function applyData(target: Profile, data: Record<string, any>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('increment' in value) (target as any)[key] += value.increment;
      else if ('decrement' in value) (target as any)[key] -= value.decrement;
      continue;
    }
    if (value !== undefined) (target as any)[key] = value;
  }
}

const rpgProfile = {
  findUnique: mock(async () => ({ ...profile })),
  create: mock(async () => ({ ...profile })),
  update: mock(async ({ data }: any) => {
    applyData(profile, data);
    return { ...profile };
  }),
  updateMany: mock(async ({ where, data }: any) => {
    // Reproduit les gardes atomiques dont dépendent les services.
    if (where?.balance?.gte !== undefined && profile.balance < where.balance.gte) return { count: 0 };
    if (where?.statPoints?.gte !== undefined && profile.statPoints < where.statPoints.gte) return { count: 0 };
    if (where?.className !== undefined && where.className !== profile.className) return { count: 0 };
    applyData(profile, data);
    return { count: 1 };
  }),
};

const ADVENTURE_EVENTS = [
  { id: 'evt-a', title: 'A', choices: [] },
  { id: 'evt-b', title: 'B', choices: [] },
  { id: 'evt-c', title: 'C', choices: [] },
  { id: 'evt-d', title: 'D', choices: [] },
];

// Le seed du catalogue tourne au premier accès profil. On lui fait voir tout le contenu
// comme déjà présent, pour qu'il n'écrive rien et n'ajoute pas de bruit aux tests.
const SEEDED_ITEM_NAMES = RPG_ITEMS.map((item) => ({ name: item.name }));
const SEEDED_MONSTER_NAMES = RPG_MONSTERS.map((monster) => ({ name: monster.name }));
const SEEDED_EVENT_TITLES = RPG_ADVENTURE_EVENTS.map((event) => ({ title: event.title }));

const mockDb = {
  economyConfig: {
    findUnique: mock(async () => ({
      enabled: true,
      rpgEnabled: true,
      shopEnabled: true,
      maxEnergy: 100,
      energyRecoveryPerHour: 10,
      currencyEmoji: 'coins',
    })),
  },
  rpgItem: {
    count: mock(async () => 1),
    createMany: mock(async () => ({ count: 0 })),
    findUnique: mock(async ({ where }: any) => ITEMS[where.id] ?? null),
    findMany: mock(async ({ where }: any) => {
      // Lecture d'équipement (par identifiants) vs lecture du seed (catalogue complet).
      if (where?.id?.in) return where.id.in.map((id: string) => ITEMS[id]).filter(Boolean);
      return [...SEEDED_ITEM_NAMES, ...Object.values(ITEMS).map((item) => ({ ...item }))];
    }),
  },
  rpgMonster: {
    count: mock(async () => 1),
    createMany: mock(async () => ({ count: 0 })),
    findMany: mock(async () => SEEDED_MONSTER_NAMES),
  },
  rpgRecipe: {
    findMany: mock(async () => []),
    createMany: mock(async () => ({ count: 0 })),
  },
  rpgInventoryItem: {
    findUnique: mock(async ({ where }: any) => {
      const item = ITEMS[where.rpgProfileId_itemId.itemId];
      return item ? { id: `inv-${item.id}`, quantity: 1, item } : null;
    }),
  },
  rpgAdventureEvent: {
    count: mock(async () => 1),
    createMany: mock(async () => ({ count: 0 })),
    findMany: mock(async ({ select }: any) => (
      // Le seed ne lit que les titres ; `resolveTravel` a besoin des événements complets.
      select?.title ? SEEDED_EVENT_TITLES : ADVENTURE_EVENTS.map((event) => ({ ...event }))
    )),
  },
  rpgProfile,
  rpgItemInstance: {
    findUnique: mock(async ({ where }: any) => {
      const { rpgProfileId, itemId } = where.rpgProfileId_itemId;
      return instances[instanceKey(rpgProfileId, itemId)] ?? null;
    }),
    findMany: mock(async ({ where }: any) => Object.values(instances).filter((instance) => (
      instance.rpgProfileId === where.rpgProfileId
      && (!where.itemId?.in || where.itemId.in.includes(instance.itemId))
    ))),
    upsert: mock(async ({ where, create }: any) => {
      const { rpgProfileId, itemId } = where.rpgProfileId_itemId;
      const key = instanceKey(rpgProfileId, itemId);
      instances[key] ??= { id: `inst-${itemId}`, rpgProfileId, itemId, upgrade: create.upgrade ?? 0, enchants: create.enchants ?? [] };
      return { ...instances[key] };
    }),
    update: mock(async ({ where, data }: any) => {
      const instance = Object.values(instances).find((candidate) => candidate.id === where.id)!;
      applyData(instance as any, data);
      return { ...instance };
    }),
    updateMany: mock(async ({ where, data }: any) => {
      const instance = Object.values(instances).find((candidate) => candidate.id === where.id);
      // Garde atomique sur le niveau : reproduit celle dont dépend la forge.
      if (!instance || (where.upgrade !== undefined && instance.upgrade !== where.upgrade)) return { count: 0 };
      applyData(instance as any, data);
      return { count: 1 };
    }),
    deleteMany: mock(async ({ where }: any) => {
      const key = instanceKey(where.rpgProfileId, where.itemId);
      const existed = key in instances;
      delete instances[key];
      return { count: existed ? 1 : 0 };
    }),
  },
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { checkLevelUp, equipInventoryItem, resolveTravel } = await import('../../services/features/economyService.js');
const { allocateStatPoint, chooseRpgClass, upgradeEquipment } = await import('../../services/features/rpg/rpgProgressionService.js');

beforeEach(() => {
  const now = new Date();
  instances = {};
  profile = {
    id: 'profile-1',
    guildId: 'guild-1',
    userId: 'user-1',
    balance: 0,
    level: 1,
    xp: 0,
    health: 100,
    maxHealth: 100,
    energy: 100,
    attack: 10,
    defense: 10,
    speed: 10,
    className: null,
    statPoints: 0,
    weaponId: null,
    armorId: null,
    accessoryId: null,
    isTraveling: false,
    travelStartedAt: null,
    travelDurationMin: 0,
    lastEnergyTick: now,
    updatedAt: now,
    inventory: [],
  };
});

describe('checkLevelUp', () => {
  test('accorde tous les paliers couverts par un gros gain d XP', async () => {
    // Paliers : niv.1 -> 100 XP, niv.2 -> 200 XP, niv.3 -> 300 XP.
    // 350 XP couvre donc deux niveaux et laisse 50 XP de reste.
    profile.xp = 350;

    const level = await checkLevelUp('guild-1', 'user-1');

    expect(level).toBe(3);
    expect(profile.level).toBe(3);
    expect(profile.xp).toBe(50);
    expect(profile.maxHealth).toBe(116); // +8 par niveau gagné
    expect(profile.attack).toBe(12); // +1 automatique par niveau
    expect(profile.health).toBe(profile.maxHealth); // soin complet
    expect(profile.statPoints).toBe(6); // 3 points à répartir par niveau
  });

  test('ne fait rien tant que le palier n est pas atteint', async () => {
    profile.xp = 99;

    expect(await checkLevelUp('guild-1', 'user-1')).toBeNull();
    expect(profile.level).toBe(1);
    expect(profile.statPoints).toBe(0);
  });
});

describe('equipInventoryItem', () => {
  test('équiper puis re-sélectionner le même objet le déséquipe', async () => {
    const equipped = await equipInventoryItem('guild-1', 'user-1', 'sword');
    expect(equipped.equipped).toBe(true);
    expect(equipped.slot).toBe('weapon');
    expect(profile.weaponId).toBe('sword');

    const unequipped = await equipInventoryItem('guild-1', 'user-1', 'sword');
    expect(unequipped.equipped).toBe(false);
    expect(profile.weaponId).toBeNull();
  });

  test('n écrit jamais dans les statistiques de base', async () => {
    // Les bonus sont dérivés à la lecture : toute écriture ici recréerait la dérive
    // permanente que le modèle actuel élimine par construction.
    const before = { attack: profile.attack, defense: profile.defense, speed: profile.speed };

    await equipInventoryItem('guild-1', 'user-1', 'sword');
    await equipInventoryItem('guild-1', 'user-1', 'blade');

    expect(profile.weaponId).toBe('blade');
    expect({ attack: profile.attack, defense: profile.defense, speed: profile.speed }).toEqual(before);
  });

  test('la progression suit l objet, pas l emplacement', async () => {
    // Le niveau de forge vit sur l'exemplaire possédé. Poser une autre arme dans le slot
    // ne lui transmet donc rien - l'exploit qui consistait à monter une babiole bon marché
    // à +10 avant d'y glisser une légendaire n'existe plus - et reprendre la première la
    // retrouve intacte, là où l'ancien modèle l'effaçait au déséquipement.
    await equipInventoryItem('guild-1', 'user-1', 'sword');
    instances[instanceKey('profile-1', 'sword')].upgrade = 7;

    await equipInventoryItem('guild-1', 'user-1', 'blade');
    expect(upgradeOf('blade')).toBe(0);
    expect(upgradeOf('sword')).toBe(7);

    await equipInventoryItem('guild-1', 'user-1', 'sword');
    expect(upgradeOf('sword')).toBe(7);
  });

  test('un accessoire occupe son propre emplacement', async () => {
    await equipInventoryItem('guild-1', 'user-1', 'sword');
    const result = await equipInventoryItem('guild-1', 'user-1', 'ring');

    expect(result.slot).toBe('accessory');
    expect(profile.accessoryId).toBe('ring');
    expect(profile.weaponId).toBe('sword'); // l'arme reste équipée
  });

  test('refuse un matériau, qui ne s équipe pas', () => {
    expect(equipInventoryItem('guild-1', 'user-1', 'ore')).rejects.toThrow(/accessoires/);
  });

  test('refuse un objet dont le niveau requis n est pas atteint', () => {
    expect(equipInventoryItem('guild-1', 'user-1', 'gate')).rejects.toThrow(/niveau 10/);
  });
});

describe('points de caractéristiques', () => {
  test('investir un point augmente la statistique et décrémente le solde', async () => {
    profile.statPoints = 3;

    const result = await allocateStatPoint('guild-1', 'user-1', 'attack');

    expect(result.gain).toBe(1);
    expect(profile.attack).toBe(11);
    expect(profile.statPoints).toBe(2);
  });

  test('un point de vitalité vaut plusieurs PV et soigne d autant', async () => {
    profile.statPoints = 1;
    const healthBefore = profile.health;

    const result = await allocateStatPoint('guild-1', 'user-1', 'maxHealth');

    expect(result.gain).toBe(8);
    expect(profile.maxHealth).toBe(108);
    expect(profile.health).toBe(healthBefore + 8);
  });

  test('refuse de dépenser des points inexistants', () => {
    profile.statPoints = 0;
    expect(allocateStatPoint('guild-1', 'user-1', 'attack')).rejects.toThrow();
  });
});

describe('choix de classe', () => {
  test('le premier choix est gratuit à partir du niveau requis', async () => {
    profile.level = 5;

    const result = await chooseRpgClass('guild-1', 'user-1', 'MAGE');

    expect(result.cost).toBe(0);
    expect(profile.className).toBe('MAGE');
    expect(profile.balance).toBe(0);
  });

  test('refuse avant le niveau de déblocage', () => {
    profile.level = 4;
    expect(chooseRpgClass('guild-1', 'user-1', 'WARRIOR')).rejects.toThrow(/niveau 5/);
  });

  test('la reconversion est payante et refusée sans le solde', async () => {
    profile.level = 10;
    profile.className = 'WARRIOR';
    profile.balance = 100;

    expect(chooseRpgClass('guild-1', 'user-1', 'MAGE')).rejects.toThrow(/2500/);

    profile.balance = 5_000;
    const result = await chooseRpgClass('guild-1', 'user-1', 'MAGE');
    expect(result.cost).toBe(2_500);
    expect(profile.balance).toBe(2_500);
  });

  test('refuse une classe inconnue', () => {
    profile.level = 10;
    expect(chooseRpgClass('guild-1', 'user-1', 'NECROMANCER')).rejects.toThrow(/inconnue/);
  });
});

describe('forge', () => {
  test('un échec ne rétrograde pas l objet mais coûte les pièces', async () => {
    profile.weaponId = 'sword';
    instances[instanceKey('profile-1', 'sword')] = {
      id: 'inst-sword', rpgProfileId: 'profile-1', itemId: 'sword', upgrade: 9, enchants: [],
    }; // au-delà de la zone garantie
    profile.balance = 1_000_000;
    const balanceBefore = profile.balance;

    const result = await upgradeEquipment('guild-1', 'user-1', 'weapon');

    expect(profile.balance).toBe(balanceBefore - result.cost);
    expect(upgradeOf('sword')).toBeGreaterThanOrEqual(9); // jamais de perte de niveau
    expect(result.newLevel).toBe(result.success ? 10 : 9);
  });

  test('les trois premiers niveaux réussissent toujours', async () => {
    profile.weaponId = 'sword';
    profile.balance = 1_000_000;

    const result = await upgradeEquipment('guild-1', 'user-1', 'weapon');

    expect(result.success).toBe(true);
    expect(upgradeOf('sword')).toBe(1);
  });

  test('refuse d améliorer un emplacement vide', () => {
    profile.balance = 1_000_000;
    expect(upgradeEquipment('guild-1', 'user-1', 'armor')).rejects.toThrow(/Aucun objet/);
  });

  test('refuse si le solde est insuffisant', () => {
    profile.weaponId = 'sword';
    profile.balance = 1;
    expect(upgradeEquipment('guild-1', 'user-1', 'weapon')).rejects.toThrow(/coûte/);
  });
});

describe('resolveTravel', () => {
  test('rouvrir la vue Voyage retombe sur le même événement', async () => {
    profile.isTraveling = true;
    profile.travelDurationMin = 5;
    profile.travelStartedAt = new Date(Date.now() - 10 * 60 * 1000);

    const first = await resolveTravel('guild-1', 'user-1');
    const second = await resolveTravel('guild-1', 'user-1');

    expect(first.complete).toBe(true);
    expect(first.event?.id).toBeDefined();
    expect(second.event?.id).toBe(first.event?.id);
  });

  test('signale le temps restant tant que le voyage est en cours', async () => {
    profile.isTraveling = true;
    profile.travelDurationMin = 30;
    profile.travelStartedAt = new Date(Date.now() - 5 * 60 * 1000);

    const status = await resolveTravel('guild-1', 'user-1');

    expect(status.complete).toBe(false);
    expect(status.remainingMinutes).toBe(25);
  });
});
