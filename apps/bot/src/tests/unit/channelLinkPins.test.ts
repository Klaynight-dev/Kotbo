import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Synchronisation des épinglages d'un pont.
 *
 * Discord n'annonce jamais *quel* message vient d'être épinglé : le service
 * compare les listes des salons. Ces tests portent donc sur les décisions
 * prises à partir de cette comparaison - notamment celles de ne rien faire, qui
 * sont les seules capables d'abîmer les salons d'en face.
 */

type GroupRow = Record<string, unknown>;
type MappingRow = {
  sourceMessageId: string;
  sourceChannelId: string;
  relayedMessageId: string;
  relayedChannelId: string;
};

let groupRows: GroupRow[] = [];
let mappingRows: MappingRow[] = [];

const mockDb = {
  channelLinkGroup: { findMany: mock(() => Promise.resolve(groupRows)) },
  channelLinkGroupMessage: { findMany: mock(() => Promise.resolve(mappingRows)) },
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { relayPinsUpdate } = await import('../../services/features/channelLinkService');

// Le cache des ponts est mémorisé par salon : chaque test travaille sur ses
// propres identifiants pour ne pas hériter du précédent.
let salonSeq = 0;

type FakeChannel = {
  id: string;
  isTextBased: () => boolean;
  messages: {
    fetchPins: () => Promise<{ hasMore: boolean; items: { message: { id: string } }[] }>;
    pin: ReturnType<typeof mock>;
    unpin: ReturnType<typeof mock>;
  };
};

function makeChannel(id: string, pinned: string[] | 'illisible'): FakeChannel {
  return {
    id,
    isTextBased: () => true,
    messages: {
      fetchPins: () =>
        pinned === 'illisible'
          ? Promise.reject(new Error('Missing Permissions'))
          : Promise.resolve({ hasMore: false, items: pinned.map((messageId) => ({ message: { id: messageId } })) }),
      pin: mock(() => Promise.resolve()),
      unpin: mock(() => Promise.resolve()),
    },
  };
}

function makeClient(channels: Record<string, Record<string, FakeChannel>>) {
  const guilds = Object.fromEntries(
    Object.entries(channels).map(([guildId, guildChannels]) => [
      guildId,
      {
        id: guildId,
        name: `Serveur ${guildId}`,
        channels: { cache: { get: (id: string) => guildChannels[id] } },
      },
    ]),
  );
  return { guilds: { cache: { get: (id: string) => guilds[id] } } };
}

type MemberSpec = { guildId: string; channelId: string; mode?: string; enabled?: boolean };

/** Un pont ordinaire, tous salons émetteurs et récepteurs, épinglages synchronisés. */
function makeGroup(members: MemberSpec[], overrides: GroupRow = {}) {
  salonSeq += 1;
  return {
    id: `pont-${salonSeq}`,
    enabled: true,
    relayPins: true,
    members: members.map((member, index) => ({
      id: `membre-${salonSeq}-${index}`,
      guildId: member.guildId,
      channelId: member.channelId,
      mode: member.mode ?? 'BOTH',
      relayMode: 'WEBHOOK',
      webhookId: `wh-${index}`,
      enabled: member.enabled ?? true,
    })),
    ...overrides,
  };
}

function salon(name: string) {
  return `${name}-${salonSeq + 1}`;
}

beforeEach(() => {
  groupRows = [];
  mappingRows = [];
});

describe('relayPinsUpdate', () => {
  test('épingle en face le message dont le pont connaît la copie', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([{ guildId: 'G-A', channelId: a }, { guildId: 'G-B', channelId: b }])];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'msg-copie', relayedChannelId: b },
    ];

    const local = makeChannel(a, ['msg-origine']);
    const distant = makeChannel(b, []);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.pin).toHaveBeenCalledTimes(1);
    expect(distant.messages.pin.mock.calls[0][0]).toBe('msg-copie');
    expect(distant.messages.unpin).not.toHaveBeenCalled();
  });

  test('remonte l\'épinglage d\'une copie relayée vers le message d\'origine', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([{ guildId: 'G-A', channelId: a }, { guildId: 'G-B', channelId: b }])];
    // Le salon où l'on épingle héberge cette fois la copie : l'original vit en face.
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: b, relayedMessageId: 'msg-copie', relayedChannelId: a },
    ];

    const local = makeChannel(a, ['msg-copie']);
    const distant = makeChannel(b, []);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.pin.mock.calls[0][0]).toBe('msg-origine');
  });

  test('propage l\'épinglage à tous les salons du pont', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    const c = salon('salon-c');
    groupRows = [makeGroup([
      { guildId: 'G-A', channelId: a },
      { guildId: 'G-B', channelId: b },
      { guildId: 'G-C', channelId: c },
    ])];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'copie-b', relayedChannelId: b },
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'copie-c', relayedChannelId: c },
    ];

    const local = makeChannel(a, ['msg-origine']);
    const versB = makeChannel(b, []);
    const versC = makeChannel(c, []);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: versB }, 'G-C': { [c]: versC } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(versB.messages.pin.mock.calls[0][0]).toBe('copie-b');
    expect(versC.messages.pin.mock.calls[0][0]).toBe('copie-c');
  });

  test('épingler une copie aligne aussi les autres copies du même message', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    const c = salon('salon-c');
    groupRows = [makeGroup([
      { guildId: 'G-A', channelId: a },
      { guildId: 'G-B', channelId: b },
      { guildId: 'G-C', channelId: c },
    ])];
    // L'original vit en A, on épingle sa copie en B : C n'est relié à B par aucune
    // ligne directe, seul le passage par l'original permet de la retrouver.
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'copie-b', relayedChannelId: b },
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'copie-c', relayedChannelId: c },
    ];

    const local = makeChannel(b, ['copie-b']);
    const versA = makeChannel(a, []);
    const versC = makeChannel(c, []);
    const client = makeClient({ 'G-A': { [a]: versA }, 'G-B': { [b]: local }, 'G-C': { [c]: versC } });

    await relayPinsUpdate('G-B', b, client as never);

    expect(versA.messages.pin.mock.calls[0][0]).toBe('msg-origine');
    expect(versC.messages.pin.mock.calls[0][0]).toBe('copie-c');
  });

  test('décroche en face le message qui vient d\'être désépinglé', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([{ guildId: 'G-A', channelId: a }, { guildId: 'G-B', channelId: b }])];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'msg-copie', relayedChannelId: b },
    ];

    const local = makeChannel(a, []);
    const distant = makeChannel(b, ['msg-copie']);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.unpin).toHaveBeenCalledTimes(1);
    expect(distant.messages.unpin.mock.calls[0][0]).toBe('msg-copie');
  });

  test('ne touche pas aux messages épinglés que le pont n\'a jamais relayés', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([{ guildId: 'G-A', channelId: a }, { guildId: 'G-B', channelId: b }])];
    mappingRows = [];

    const local = makeChannel(a, []);
    // Épinglage propre au serveur d'en face : il ne regarde pas le pont.
    const distant = makeChannel(b, ['annonce-locale']);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.unpin).not.toHaveBeenCalled();
    expect(distant.messages.pin).not.toHaveBeenCalled();
  });

  test('ne désépingle rien quand la liste d\'en face est illisible', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([{ guildId: 'G-A', channelId: a }, { guildId: 'G-B', channelId: b }])];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'msg-copie', relayedChannelId: b },
    ];

    const local = makeChannel(a, ['msg-origine']);
    // Permission manquante : croire le salon vide reviendrait à tout décrocher.
    const distant = makeChannel(b, 'illisible');
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.pin).not.toHaveBeenCalled();
    expect(distant.messages.unpin).not.toHaveBeenCalled();
  });

  test('laisse les épinglages tranquilles quand le pont ne les relaie pas', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([{ guildId: 'G-A', channelId: a }, { guildId: 'G-B', channelId: b }], { relayPins: false })];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'msg-copie', relayedChannelId: b },
    ];

    const local = makeChannel(a, ['msg-origine']);
    const distant = makeChannel(b, []);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.pin).not.toHaveBeenCalled();
  });

  test('un salon qui ne fait que recevoir ne remonte pas ses épinglages', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([
      { guildId: 'G-A', channelId: a, mode: 'SEND_ONLY' },
      { guildId: 'G-B', channelId: b, mode: 'RECEIVE_ONLY' },
    ])];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'msg-copie', relayedChannelId: b },
    ];

    // Épinglage posé du côté qui ne fait que recevoir : il ne remonte pas, comme
    // le faisait déjà l'ancien lien unidirectionnel.
    const local = makeChannel(b, ['msg-copie']);
    const distant = makeChannel(a, []);
    const client = makeClient({ 'G-A': { [a]: distant }, 'G-B': { [b]: local } });

    await relayPinsUpdate('G-B', b, client as never);

    expect(distant.messages.pin).not.toHaveBeenCalled();
  });

  test('un salon en pause n\'entraîne plus les épinglages du pont', async () => {
    const a = salon('salon-a');
    const b = salon('salon-b');
    groupRows = [makeGroup([
      { guildId: 'G-A', channelId: a },
      { guildId: 'G-B', channelId: b, enabled: false },
    ])];
    mappingRows = [
      { sourceMessageId: 'msg-origine', sourceChannelId: a, relayedMessageId: 'msg-copie', relayedChannelId: b },
    ];

    const local = makeChannel(a, ['msg-origine']);
    const distant = makeChannel(b, []);
    const client = makeClient({ 'G-A': { [a]: local }, 'G-B': { [b]: distant } });

    await relayPinsUpdate('G-A', a, client as never);

    expect(distant.messages.pin).not.toHaveBeenCalled();
  });
});
