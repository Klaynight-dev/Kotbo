import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import { Events } from 'discord.js';

/**
 * Mode « liaison seule » : un serveur relié sans clé d'activation ne doit voir
 * passer que le relais. Ces tests portent sur la propriété qui rend la promesse
 * tenable - l'isolement du bus - plus que sur la mécanique de cache.
 */

type GroupRow = { members: { guildId: string }[] };

let groupRows: GroupRow[] = [];
const findMany = mock((_args?: unknown) => Promise.resolve(groupRows));
const mockDb = { channelLinkGroup: { findMany } };

/** Un pont actif reliant les serveurs donnés, un salon par serveur. */
function pont(...guildIds: string[]): GroupRow {
  return { members: guildIds.map((guildId) => ({ guildId })) };
}

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const activated = new Set<string>();
const isGuildActivated = mock((guildId: string) => activated.has(guildId));
const activationPath = path.resolve(import.meta.dir, '../../utils/activation.ts');
const activationJsPath = path.resolve(import.meta.dir, '../../utils/activation.js');
mock.module(activationPath, () => ({ isGuildActivated, activatedGuilds: activated }));
mock.module(activationJsPath, () => ({ isGuildActivated, activatedGuilds: activated }));

// `getClient` lève hors runtime Discord : le service doit s'en accommoder,
// le rechargement du cache n'ayant rien à voir avec la présence d'un client.
const clientPath = path.resolve(import.meta.dir, '../../utils/client.ts');
const clientJsPath = path.resolve(import.meta.dir, '../../utils/client.js');
mock.module(clientPath, () => ({ getClient: () => { throw new Error('pas de client'); } }));
mock.module(clientJsPath, () => ({ getClient: () => { throw new Error('pas de client'); } }));

const {
  linkGuestGuilds,
  linkRelayBus,
  loadLinkGuestGuilds,
  refreshLinkGuestGuilds,
  isLinkGuestGuild,
  dispatchLinkGuestEvent,
  RELAY_ONLY_EVENTS,
} = await import('../../services/features/channelLinkGuestService');

beforeEach(() => {
  groupRows = [];
  activated.clear();
  linkGuestGuilds.clear();
  linkRelayBus.removeAllListeners();
  findMany.mockClear();
});

describe('loadLinkGuestGuilds', () => {
  test('classe comme invité le serveur sans clé relié à un serveur activé', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-B')];

    await loadLinkGuestGuilds();

    expect(isLinkGuestGuild('serveur-B')).toBe(true);
    // Le serveur activé garde son statut : il n'est jamais « invité » chez lui.
    expect(isLinkGuestGuild('serveur-A')).toBe(false);
  });

  test('fonctionne quelle que soit la place du serveur activé dans le pont', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-B', 'serveur-A')];

    await loadLinkGuestGuilds();

    expect(isLinkGuestGuild('serveur-B')).toBe(true);
  });

  test('refuse le pont entre deux serveurs dépourvus de clé', async () => {
    groupRows = [pont('serveur-B', 'serveur-C')];

    await loadLinkGuestGuilds();

    // Sans cette règle, des serveurs sans licence se relieraient entre eux pour
    // obtenir un pont gratuit.
    expect(linkGuestGuilds.size).toBe(0);
  });

  test('ignore un pont interne à un même serveur', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-A')];

    await loadLinkGuestGuilds();

    expect(linkGuestGuilds.size).toBe(0);
  });

  test('classe tous les serveurs sans clé d\'un pont à plusieurs', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-B', 'serveur-C', 'serveur-D')];

    await loadLinkGuestGuilds();

    expect(isLinkGuestGuild('serveur-B')).toBe(true);
    expect(isLinkGuestGuild('serveur-C')).toBe(true);
    expect(isLinkGuestGuild('serveur-D')).toBe(true);
    expect(isLinkGuestGuild('serveur-A')).toBe(false);
  });

  test('retire un serveur dont le pont a disparu', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-B')];
    await loadLinkGuestGuilds();
    expect(isLinkGuestGuild('serveur-B')).toBe(true);

    groupRows = [];
    await loadLinkGuestGuilds();

    expect(isLinkGuestGuild('serveur-B')).toBe(false);
  });

  test('perd son statut d\'invité si le serveur porteur de la clé est désactivé', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-B')];
    await loadLinkGuestGuilds();

    activated.delete('serveur-A');
    await loadLinkGuestGuilds();

    expect(linkGuestGuilds.size).toBe(0);
  });

  test('une lecture en base en échec laisse le cache intact plutôt que de l\'ouvrir', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-B')];
    await loadLinkGuestGuilds();

    findMany.mockImplementationOnce(() => Promise.reject(new Error('base indisponible')));
    await loadLinkGuestGuilds();

    expect(isLinkGuestGuild('serveur-B')).toBe(true);
  });
});

describe('refreshLinkGuestGuilds', () => {
  test('recharge le cache même sans client Discord disponible', async () => {
    activated.add('serveur-A');
    groupRows = [pont('serveur-A', 'serveur-B')];

    await refreshLinkGuestGuilds();

    expect(isLinkGuestGuild('serveur-B')).toBe(true);
  });
});

describe('dispatchLinkGuestEvent', () => {
  test('transmet au relais les évènements dont le pont a besoin', () => {
    const received: unknown[] = [];
    linkRelayBus.on(Events.MessageCreate, (msg: unknown) => received.push(msg));

    const forwarded = dispatchLinkGuestEvent(Events.MessageCreate, [{ id: 'msg-1' }]);

    expect(forwarded).toBe(true);
    expect(received).toEqual([{ id: 'msg-1' }]);
  });

  test('jette tout ce qui sort du périmètre du relais', () => {
    const received: unknown[] = [];
    linkRelayBus.on(Events.GuildMemberAdd, (m: unknown) => received.push(m));

    // Une arrivée de membre n'a aucun rôle dans un pont : elle ne doit jamais
    // sortir de la garde, sans quoi les modules d'analytics pourraient la voir.
    const forwarded = dispatchLinkGuestEvent(Events.GuildMemberAdd, [{ id: 'user-1' }]);

    expect(forwarded).toBe(false);
    expect(received).toEqual([]);
  });

  test('le périmètre reste limité aux évènements du relais', () => {
    expect([...RELAY_ONLY_EVENTS].sort()).toEqual(
      [
        Events.MessageCreate,
        Events.MessageUpdate,
        Events.MessageDelete,
        Events.MessageReactionAdd,
        Events.TypingStart,
        Events.ChannelPinsUpdate,
        Events.ThreadCreate,
        Events.ThreadDelete,
      ].sort(),
    );

    // Verrou explicite : ces évènements portent l'activité des membres et ne
    // doivent jamais rejoindre la liste sans décision consciente.
    for (const forbidden of [
      Events.GuildMemberAdd,
      Events.GuildMemberRemove,
      Events.VoiceStateUpdate,
      Events.InteractionCreate,
      Events.GuildAuditLogEntryCreate,
    ]) {
      expect(RELAY_ONLY_EVENTS.has(forbidden)).toBe(false);
    }
  });
});
