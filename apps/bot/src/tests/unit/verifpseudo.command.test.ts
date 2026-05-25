import { describe, expect, test, mock, beforeEach, beforeAll } from 'bun:test';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import path from 'node:path';

// Mock the nickname moderation service
const mockNicknameService = {
  isNicknameProblematic: mock((name: string, words: string[]) => {
    return name.includes('banni');
  }),
  SAFE_NICKNAME: 'pseudo non conforme | automod',
  buildRenameReason: mock((name: string) => `Automod: original: "${name}"`),
  loadBannedWords: mock(() => Promise.resolve(['banni'])),
};

const servicePath = path.resolve(__dirname, '../../services/nicknameModerationService.ts');
const serviceJsPath = path.resolve(__dirname, '../../services/nicknameModerationService.js');

mock.module(servicePath, () => mockNicknameService);
mock.module(serviceJsPath, () => mockNicknameService);

// Mock @prisma/client directly to avoid missing generated client errors in bun test
mock.module('@prisma/client', () => ({
  PrismaClient: mock(() => ({
    dashboardAuditLog: {
      create: mock(() => Promise.resolve({})),
    },
  })),
}));

// Mock the database dependency
const mockDb = {
  dashboardAuditLog: {
    create: mock(() => Promise.resolve({})),
  },
};

const dbPath = path.resolve(__dirname, '../../utils/db.ts');
const dbJsPath = path.resolve(__dirname, '../../utils/db.js');

mock.module(dbPath, () => ({ default: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb }));

let execute: any;

describe('commande verifpseudo', () => {
  beforeAll(async () => {
    const mod = await import('../../commands/verifpseudo');
    execute = mod.execute;
  });
  let interaction: any;
  let replies: any[];
  let edits: any[];
  let membersFetch: any;

  beforeEach(() => {
    replies = [];
    edits = [];
    mockNicknameService.loadBannedWords.mockClear();
    mockNicknameService.isNicknameProblematic.mockClear();
    mockDb.dashboardAuditLog.create.mockClear();

    membersFetch = mock(() => Promise.resolve(new Map()));

    interaction = {
      id: 'interaction-123',
      guildId: `guild-${Math.random()}`,
      channelId: 'channel-123',
      user: { tag: 'User#1234' },
      guild: {
        name: 'Mon Serveur',
        ownerId: 'owner-123',
        members: {
          fetchMe: mock(() => Promise.resolve({
            permissions: {
              has: mock(() => true),
            },
            roles: {
              highest: { position: 10 },
            },
          })),
          fetch: membersFetch,
        },
      },
      reply: mock(async (options: any) => {
        replies.push(options);
        return { id: 'reply-1' };
      }),
      deferReply: mock(async () => {
        return;
      }),
      editReply: mock(async (options: any) => {
        edits.push(options);
        return { id: 'reply-1', createMessageComponentCollector: () => ({ on: mock(), stop: mock() }) };
      }),
    };
  });

  test('affiche une erreur si utilisée en MP', async () => {
    interaction.guild = null;
    interaction.guildId = null;

    await execute(interaction);

    expect(replies.length).toBe(1);
    expect(replies[0].embeds[0].data.title).toContain('Serveur requis');
  });

  test('affiche une erreur si le bot n\'a pas la permission', async () => {
    interaction.guild.members.fetchMe = mock(() => Promise.resolve({
      permissions: {
        has: mock(() => false),
      },
    }));

    await execute(interaction);

    expect(edits.length).toBe(1);
    expect(edits[0].embeds[0].data.title).toContain('Permission manquante');
  });

  test('affiche une info si aucun mot banni n\'est configure', async () => {
    mockNicknameService.loadBannedWords.mockResolvedValueOnce([]);

    await execute(interaction);

    expect(edits.length).toBe(1);
    expect(edits[0].embeds[0].data.title).toContain('Aucun mot banni');
  });

  test('verifie et renomme les membres non conformes', async () => {
    const mockMember1 = {
      id: 'member-1',
      user: { bot: false, tag: 'Banni#0001' },
      nickname: 'Jean-banni',
      roles: { highest: { position: 5 } },
      guild: { ownerId: 'owner-123' },
      setNickname: mock(() => Promise.resolve({})),
    };

    const mockMember2 = {
      id: 'member-2',
      user: { bot: false, tag: 'Ok#0002' },
      nickname: 'Jean-normal',
      roles: { highest: { position: 5 } },
      guild: { ownerId: 'owner-123' },
      setNickname: mock(() => Promise.resolve({})),
    };

    const membersMap = new Collection<string, any>([
      ['member-1', mockMember1],
      ['member-2', mockMember2],
    ]);

    membersFetch.mockResolvedValueOnce(membersMap);

    await execute(interaction);

    expect(mockMember1.setNickname).toHaveBeenCalledWith(
      'pseudo non conforme | automod',
      expect.any(String)
    );
    expect(mockMember2.setNickname).not.toHaveBeenCalled();

    // L'embed de fin doit afficher le scan termine
    const finalEmbed = edits[edits.length - 1].embeds[0].data;
    expect(finalEmbed.title).toContain('Vérification des pseudos terminée');
  });
});
