/**
 * Deploiement des commandes par serveur.
 *
 * Ce que ces cas verrouillent : une commande dont le module est eteint ne doit
 * pas figurer dans la charge utile envoyee a Discord - c'est tout l'interet du
 * passage au scope guilde, l'API ne sachant pas retirer une commande globale
 * serveur par serveur.
 *
 * Prefixe `zz-` : ce fichier remplace `utils/db` et `infra/redis` pour tout le
 * process (`mock.module` est global). Charge en dernier, il ne fausse pas les
 * suites suivantes.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { InteractionContextType } from 'discord.js';

interface FeatureRow { guildId: string; featureKey: string; enabled: boolean }

let guildRow: Record<string, unknown> | null = { id: 'guild-1' };
let featureRows: FeatureRow[] = [];

// Toutes les tables que lit `loadModuleStates` doivent figurer ici : une seule
// manquante fait lever la lecture, et la garde retombe alors sur les defauts du
// registre - `featureRows` n'est plus jamais consulte et tous les cas passent au
// vert pour la mauvaise raison.
const mockDb = {
  guild: { findUnique: mock(async () => guildRow), update: mock(async () => guildRow) },
  dashboardFeatureConfig: { findMany: mock(async () => featureRows), upsert: mock(async () => ({})) },
  levelConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  rankedConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  banAppealConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
};

const redisValues = new Map<string, string>();
// `del` compris : la garde des modules s'appuie dessus pour invalider son cache
// apres une bascule. Sans lui, l'etat lu restait celui d'avant et le test
// « republie quand un module bascule » echouait pour la mauvaise raison.
const mockRedis = {
  get: mock(async (key: string) => redisValues.get(key) ?? null),
  setex: mock(async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); }),
  del: mock(async (key: string) => (redisValues.delete(key) ? 1 : 0)),
  scan: mock(async () => ['0', [] as string[]]),
  pipeline: mock(() => ({ del: mock(() => undefined), exec: mock(async () => []) })),
};

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {},
};

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({
    default: mockDb, prisma: mockDb, prismaRead: mockDb,
  }));
}
for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({ logger: silentLogger, default: silentLogger }));
}
for (const suffix of ['../../infra/redis.ts', '../../infra/redis.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({
    getRedis: () => mockRedis,
    initRedis: async () => mockRedis,
    createRedisForWorker: () => null,
    assertRedisConnection: async () => undefined,
  }));
}

const { buildGuildCommandPayload, buildGlobalCommandPayload, syncGuildCommands, clearGuildCommands } =
  await import('../../services/core/commandDeployment.js');
const { invalidateModuleStates } = await import('../../services/core/moduleGate.js');
const { getCommandModuleKey, COMMAND_MODULES } = await import('../../commands.js');

const GUILD = 'guild-1';

/** Client minimal : seul `rest.put` et l'identifiant d'application comptent. */
function fakeClient() {
  const puts: Array<{ route: string; body: unknown }> = [];
  return {
    puts,
    client: {
      application: { id: 'app-1' },
      user: { id: 'app-1' },
      rest: {
        put: mock(async (route: string, options: { body: unknown }) => {
          puts.push({ route, body: options.body });
          return {};
        }),
      },
    } as never,
  };
}

type Payload = Array<{ name: string; contexts?: number[] }>;
const names = (payload: Payload) => payload.map((entry) => entry.name);

beforeEach(async () => {
  // Offre qui ouvre tout le catalogue. Sans elle, un faux enregistrement
  // retombe sur `FREE` - qui n'ouvre plus aucun module depuis que la grille
  // tarifaire est passee au palier par taille de serveur - et toutes les
  // commandes disparaitraient pour une raison etrangere a ce que ces cas
  // verifient : la publication selon l'etat des modules, pas selon l'offre.
  guildRow = { id: GUILD, plan: 'CUSTOM' };
  featureRows = [];
  redisValues.clear();
  await invalidateModuleStates(GUILD);
});

describe('buildGuildCommandPayload', () => {
  test('retire les commandes dont le module est eteint', async () => {
    const ticketCommandName = [...findNameForModule('tickets')][0];
    expect(ticketCommandName).toBeDefined();

    const before = (await buildGuildCommandPayload(GUILD)) as Payload;
    expect(names(before)).toContain(ticketCommandName!);

    featureRows = [{ guildId: GUILD, featureKey: 'tickets', enabled: false }];
    await invalidateModuleStates(GUILD);

    const after = (await buildGuildCommandPayload(GUILD)) as Payload;
    expect(names(after)).not.toContain(ticketCommandName!);
  });

  test('garde les commandes sans module quoi qu il arrive', async () => {
    featureRows = [
      { guildId: GUILD, featureKey: 'tickets', enabled: false },
      { guildId: GUILD, featureKey: 'economy', enabled: false },
      { guildId: GUILD, featureKey: 'sanctions', enabled: false },
    ];
    await invalidateModuleStates(GUILD);

    const payload = (await buildGuildCommandPayload(GUILD)) as Payload;
    // `/setup`, `/config`, `/admin`... ne dependent d'aucun module.
    expect(payload.length).toBeGreaterThan(0);
    for (const entry of payload) {
      const moduleKey = getCommandModuleKey(entry.name);
      if (moduleKey) {
        expect(['tickets', 'economy', 'sanctions']).not.toContain(moduleKey);
      }
    }
  });

  test('les commandes de guilde sont restreintes au contexte serveur', async () => {
    const payload = (await buildGuildCommandPayload(GUILD)) as Payload;
    const slash = payload.filter((entry) => entry.contexts !== undefined);
    expect(slash.length).toBeGreaterThan(0);
    for (const entry of slash) {
      expect(entry.contexts).toEqual([InteractionContextType.Guild]);
    }
  });

  test('la cascade de dependances retire aussi les commandes du dependant', async () => {
    const seasonCommand = [...findNameForModule('seasons')][0];
    expect(seasonCommand).toBeDefined();

    featureRows = [{ guildId: GUILD, featureKey: 'leveling', enabled: false }];
    await invalidateModuleStates(GUILD);

    const payload = (await buildGuildCommandPayload(GUILD)) as Payload;
    expect(names(payload)).not.toContain(seasonCommand!);
  });
});

describe('buildGlobalCommandPayload', () => {
  test('ne publie globalement que l amorcage, les utilitaires hors serveur et les menus', async () => {
    const payload = (await buildGlobalCommandPayload()) as Payload;
    // Bien plus court que les 79 commandes d'avant : c'est la preuve que le
    // gros du catalogue est passe au scope guilde.
    expect(payload.length).toBeLessThan(20);
  });

  test('l exemplaire global d une commande `guild+dm` est limite aux contextes prives', async () => {
    const payload = (await buildGlobalCommandPayload()) as Payload;
    const ticketName = [...findNameForModule('tickets')][0];
    const ticket = payload.find((entry) => entry.name === ticketName);

    expect(ticket).toBeDefined();
    expect(ticket!.contexts).toEqual([
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ]);
  });
});

describe('syncGuildCommands', () => {
  test('publie une premiere fois puis ne republie pas a l identique', async () => {
    const { client, puts } = fakeClient();

    const first = await syncGuildCommands(client, GUILD);
    expect(first.changed).toBeTrue();
    expect(puts).toHaveLength(1);

    const second = await syncGuildCommands(client, GUILD);
    expect(second.changed).toBeFalse();
    // Le quota Discord porte sur les creations de commandes : republier a
    // l'identique le consommerait pour rien.
    expect(puts).toHaveLength(1);
  });

  test('republie quand un module bascule', async () => {
    const { client, puts } = fakeClient();
    await syncGuildCommands(client, GUILD);

    featureRows = [{ guildId: GUILD, featureKey: 'tickets', enabled: false }];
    await invalidateModuleStates(GUILD);

    const result = await syncGuildCommands(client, GUILD);
    expect(result.changed).toBeTrue();
    expect(puts).toHaveLength(2);
    expect((puts[1].body as Payload).length).toBeLessThan((puts[0].body as Payload).length);
  });

  test('`force` republie meme sans changement', async () => {
    const { client, puts } = fakeClient();
    await syncGuildCommands(client, GUILD);
    await syncGuildCommands(client, GUILD, { force: true });
    expect(puts).toHaveLength(2);
  });

  test('clearGuildCommands envoie une liste vide, une seule fois', async () => {
    const { client, puts } = fakeClient();

    await clearGuildCommands(client, GUILD);
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual([]);

    await clearGuildCommands(client, GUILD);
    expect(puts).toHaveLength(1);
  });
});

/**
 * Noms de commandes rattachees a un module, lus dans la table de `commands.ts`.
 *
 * On ne code aucun nom en dur : ils viennent de `getCommandMetadata()` et
 * changent avec la langue de l'instance. Et on part des definitions, pas d'une
 * charge utile deja filtree - un module eteint par defaut (`seasons`) n'y
 * figurerait pas, ce qui rendrait le test vert sans rien verifier.
 */
function findNameForModule(moduleKey: string): Set<string> {
  const found = new Set<string>();
  for (const [definition, key] of COMMAND_MODULES) {
    if (key === moduleKey) found.add(definition.data.name);
  }
  return found;
}
