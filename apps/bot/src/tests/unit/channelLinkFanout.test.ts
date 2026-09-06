import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Diffusion d'un pont à plus de deux salons.
 *
 * Un message publié dans un salon possède autant de copies que le pont compte
 * de destinataires : ces tests vérifient que les évènements qui suivent -
 * édition, suppression, réaction - les retrouvent toutes, y compris depuis une
 * copie, qui n'a de lien avec ses sœurs qu'en passant par l'original.
 */

type MappingRow = {
  id: string;
  groupId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  relayedMessageId: string;
  relayedChannelId: string;
  relayedGuildId: string;
  webhookId: string | null;
};

let groupRows: Record<string, unknown>[] = [];
let mappingRows: MappingRow[] = [];

/** Filtre minimal reproduisant les `where` que le service adresse aux mappings. */
function matches(row: MappingRow, where: Record<string, any> = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'OR') {
      if (!(condition as Record<string, any>[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    const value = (row as Record<string, any>)[field];
    if (condition && typeof condition === 'object' && 'in' in condition) {
      if (!(condition.in as string[]).includes(value)) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

const deleteMany = mock((args?: { where?: Record<string, any> }) => {
  const kept = mappingRows.filter((row) => !matches(row, args?.where));
  const removed = mappingRows.length - kept.length;
  mappingRows = kept;
  return Promise.resolve({ count: removed });
});

const mockDb = {
  channelLinkGroup: { findMany: mock(() => Promise.resolve(groupRows)) },
  channelLinkGroupMessage: {
    findMany: mock((args?: { where?: Record<string, any> }) =>
      Promise.resolve(mappingRows.filter((row) => matches(row, args?.where)))),
    findFirst: mock((args?: { where?: Record<string, any> }) =>
      Promise.resolve(mappingRows.find((row) => matches(row, args?.where)) ?? null)),
    deleteMany,
  },
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { relayMessageEdit, relayMessageDelete, relayReactionAdd, neutralizeMassMentions } = await import(
  '../../services/features/channelLinkService'
);

// Le cache des ponts est mémorisé par salon : chaque test travaille sur ses
// propres identifiants pour ne pas hériter du précédent.
let seq = 0;

type FakeMessage = { id: string; editable: boolean; deletable: boolean; edit: ReturnType<typeof mock>; delete: ReturnType<typeof mock>; react: ReturnType<typeof mock> };
type FakeChannel = { id: string; isTextBased: () => boolean; messages: { fetch: (id: string) => Promise<FakeMessage | null> } };

function makeMessage(id: string): FakeMessage {
  return {
    id,
    editable: true,
    deletable: true,
    edit: mock(() => Promise.resolve()),
    delete: mock(() => Promise.resolve()),
    react: mock(() => Promise.resolve()),
  };
}

function makeChannel(id: string, messages: Record<string, FakeMessage>): FakeChannel {
  return {
    id,
    isTextBased: () => true,
    messages: { fetch: (messageId: string) => Promise.resolve(messages[messageId] ?? null) },
  };
}

function makeClient(guilds: Record<string, FakeChannel[]>) {
  const cache = Object.fromEntries(
    Object.entries(guilds).map(([guildId, channels]) => [
      guildId,
      {
        id: guildId,
        name: `Serveur ${guildId}`,
        channels: { cache: { get: (id: string) => channels.find((c) => c.id === id) } },
      },
    ]),
  );
  return { guilds: { cache: { get: (id: string) => cache[id] } } };
}

/**
 * Un pont à trois salons en relais embed : sans webhook, chaque copie est
 * modifiée par le bot lui-même, ce qui rend les appels observables.
 */
function makeGroup(channelIds: [string, string, string], overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `pont-${seq}`,
    enabled: true,
    relayText: true,
    relayImages: true,
    relayEdits: true,
    relayDeletes: true,
    relayReactions: true,
    relayPins: false,
    members: [
      { id: `m-${seq}-a`, guildId: 'G-A', channelId: channelIds[0], mode: 'BOTH', relayMode: 'EMBED', webhookId: null, enabled: true },
      { id: `m-${seq}-b`, guildId: 'G-B', channelId: channelIds[1], mode: 'BOTH', relayMode: 'EMBED', webhookId: null, enabled: true },
      { id: `m-${seq}-c`, guildId: 'G-C', channelId: channelIds[2], mode: 'BOTH', relayMode: 'EMBED', webhookId: null, enabled: true },
    ],
    ...overrides,
  };
}

function copies(groupId: string, sourceChannelId: string, targets: { channelId: string; guildId: string; messageId: string }[]): MappingRow[] {
  return targets.map((target, index) => ({
    id: `map-${groupId}-${index}`,
    groupId,
    sourceMessageId: 'msg-origine',
    sourceChannelId,
    relayedMessageId: target.messageId,
    relayedChannelId: target.channelId,
    relayedGuildId: target.guildId,
    webhookId: null,
  }));
}

function channelIds(): [string, string, string] {
  const suffix = seq + 1;
  return [`salon-a-${suffix}`, `salon-b-${suffix}`, `salon-c-${suffix}`];
}

beforeEach(() => {
  groupRows = [];
  mappingRows = [];
});

describe('relayMessageEdit', () => {
  test('répercute l\'édition sur toutes les copies du message', async () => {
    const [a, b, c] = channelIds();
    const group = makeGroup([a, b, c]);
    groupRows = [group];
    mappingRows = copies(group.id, a, [
      { channelId: b, guildId: 'G-B', messageId: 'copie-b' },
      { channelId: c, guildId: 'G-C', messageId: 'copie-c' },
    ]);

    const copieB = makeMessage('copie-b');
    const copieC = makeMessage('copie-c');
    const client = makeClient({
      'G-A': [makeChannel(a, {})],
      'G-B': [makeChannel(b, { 'copie-b': copieB })],
      'G-C': [makeChannel(c, { 'copie-c': copieC })],
    });

    const message = {
      id: 'msg-origine',
      content: 'texte corrigé',
      createdAt: new Date(),
      // discord.js rend toujours une URL d'avatar : une chaîne vide ferait
      // échouer la construction de l'embed et l'édition n'atteindrait aucune copie.
      author: { bot: false, username: 'kot', displayName: 'Kot', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
      guild: { id: 'G-A', name: 'Serveur A', iconURL: () => null },
      channel: { id: a },
    };

    await relayMessageEdit(message as never, client as never);

    expect(copieB.edit).toHaveBeenCalledTimes(1);
    expect(copieC.edit).toHaveBeenCalledTimes(1);
  });
});

describe('relayMessageDelete', () => {
  test('supprime toutes les copies et efface leurs correspondances', async () => {
    const [a, b, c] = channelIds();
    const group = makeGroup([a, b, c]);
    groupRows = [group];
    mappingRows = copies(group.id, a, [
      { channelId: b, guildId: 'G-B', messageId: 'copie-b' },
      { channelId: c, guildId: 'G-C', messageId: 'copie-c' },
    ]);

    const copieB = makeMessage('copie-b');
    const copieC = makeMessage('copie-c');
    const client = makeClient({
      'G-A': [makeChannel(a, {})],
      'G-B': [makeChannel(b, { 'copie-b': copieB })],
      'G-C': [makeChannel(c, { 'copie-c': copieC })],
    });

    const message = {
      id: 'msg-origine',
      author: { bot: false },
      guild: { id: 'G-A' },
      channel: { id: a },
    };

    await relayMessageDelete(message as never, client as never);

    expect(copieB.delete).toHaveBeenCalledTimes(1);
    expect(copieC.delete).toHaveBeenCalledTimes(1);
    // Le pont ne doit pas conserver les identifiants de messages qui n'existent plus.
    expect(mappingRows).toHaveLength(0);
  });
});

describe('relayReactionAdd', () => {
  test('propage la réaction posée sur l\'original à toutes les copies', async () => {
    const [a, b, c] = channelIds();
    const group = makeGroup([a, b, c]);
    groupRows = [group];
    mappingRows = copies(group.id, a, [
      { channelId: b, guildId: 'G-B', messageId: 'copie-b' },
      { channelId: c, guildId: 'G-C', messageId: 'copie-c' },
    ]);

    const copieB = makeMessage('copie-b');
    const copieC = makeMessage('copie-c');
    const client = makeClient({
      'G-A': [makeChannel(a, { 'msg-origine': makeMessage('msg-origine') })],
      'G-B': [makeChannel(b, { 'copie-b': copieB })],
      'G-C': [makeChannel(c, { 'copie-c': copieC })],
    });

    const reaction = {
      emoji: { id: null, name: '👍' },
      message: { id: 'msg-origine', guild: { id: 'G-A' }, channel: { id: a } },
    };

    await relayReactionAdd(reaction as never, { bot: false } as never, client as never);

    expect(copieB.react).toHaveBeenCalledWith('👍');
    expect(copieC.react).toHaveBeenCalledWith('👍');
  });

  test('une réaction posée sur une copie atteint l\'original et les autres copies', async () => {
    const [a, b, c] = channelIds();
    const group = makeGroup([a, b, c]);
    groupRows = [group];
    mappingRows = copies(group.id, a, [
      { channelId: b, guildId: 'G-B', messageId: 'copie-b' },
      { channelId: c, guildId: 'G-C', messageId: 'copie-c' },
    ]);

    const original = makeMessage('msg-origine');
    const copieC = makeMessage('copie-c');
    const client = makeClient({
      'G-A': [makeChannel(a, { 'msg-origine': original })],
      'G-B': [makeChannel(b, { 'copie-b': makeMessage('copie-b') })],
      'G-C': [makeChannel(c, { 'copie-c': copieC })],
    });

    const reaction = {
      emoji: { id: null, name: '👍' },
      message: { id: 'copie-b', guild: { id: 'G-B' }, channel: { id: b } },
    };

    await relayReactionAdd(reaction as never, { bot: false } as never, client as never);

    // Deux copies d'un même message n'ont aucun lien direct en base : les relier
    // suppose de remonter à l'original, qui est leur seul point commun.
    expect(original.react).toHaveBeenCalledWith('👍');
    expect(copieC.react).toHaveBeenCalledWith('👍');
  });
});

/**
 * Ces tests vivent ici pour profiter des mocks du service, déjà posés plus haut.
 *
 * La propriété est de sûreté, pas de confort : un pont relie des communautés qui
 * ne se connaissent pas, et rien de ce qui y transite ne doit pouvoir notifier
 * l'autre serveur en entier.
 */
describe('neutralizeMassMentions', () => {
  test('rend inoffensives les mentions de masse', () => {
    expect(neutralizeMassMentions('@everyone au rapport')).toBe('@\u200beveryone au rapport');
    expect(neutralizeMassMentions('coucou @here')).toBe('coucou @\u200bhere');
  });

  test('traite toutes les occurrences d\'un même message', () => {
    expect(neutralizeMassMentions('@everyone et @everyone')).toBe('@\u200beveryone et @\u200beveryone');
  });

  test('laisse le reste du texte intact', () => {
    // Ni les mentions ordinaires, ni un simple mot contenant « everyone » ne
    // notifient qui que ce soit : les toucher abîmerait le message pour rien.
    expect(neutralizeMassMentions('salut <@123> et <@&456>')).toBe('salut <@123> et <@&456>');
    expect(neutralizeMassMentions('everyone est là')).toBe('everyone est là');
    expect(neutralizeMassMentions('')).toBe('');
  });
});
