import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { resetCurrentInstance } from '../../utils/instanceContext.js';
import jwt from 'jsonwebtoken';
import { type Client } from 'discord.js';

// Setup DB Mock before importing route modules
const mockDb = {
  memberProfile: {
    findUnique: mock(() => Promise.resolve<unknown>(null)),
    update: mock(() => Promise.resolve({})),
    findMany: mock(() => Promise.resolve([])),
  },
  guild: {
    findUnique: mock(() => Promise.resolve<unknown>(null)),
    findMany: mock(() => Promise.resolve([])),
  },
  newsArticle: {
    findMany: mock(() => Promise.resolve([])),
  },
  transcript: {
    findUnique: mock(() => Promise.resolve(null)),
  },
  globalAdmin: {
    findMany: mock(() => Promise.resolve([])),
    findUnique: mock(() => Promise.resolve(null)),
    upsert: mock(() => Promise.resolve({})),
    delete: mock(() => Promise.resolve({})),
  },
  sanction: {
    count: mock(() => Promise.resolve(0)),
    findMany: mock(() => Promise.resolve([])),
  },
  dailyAlgoSubmission: {
    count: mock(() => Promise.resolve(0)),
  },
  globalBlacklist: {
    findMany: mock(() => Promise.resolve([])),
    upsert: mock(() => Promise.resolve({})),
    delete: mock(() => Promise.resolve({})),
  },
  bannedWord: {
    findMany: mock(() => Promise.resolve([])),
    findFirst: mock(() => Promise.resolve(null)),
    create: mock(() => Promise.resolve({})),
    update: mock(() => Promise.resolve({})),
    delete: mock(() => Promise.resolve({})),
  },
  botGlobalConfig: {
    findUnique: mock(() => Promise.resolve(null)),
    upsert: mock(() => Promise.resolve({})),
  },
  botErrorLog: {
    findMany: mock(() => Promise.resolve([])),
    deleteMany: mock(() => Promise.resolve({})),
  },
  activationCode: {
    findMany: mock(() => Promise.resolve([])),
    create: mock(() => Promise.resolve({})),
    findUnique: mock(() => Promise.resolve(null)),
    update: mock(() => Promise.resolve({})),
  },
  dashboardAuditLog: {
    create: mock(() => Promise.resolve({})),
  },
  dashboardFeatureConfig: {
    findMany: mock(() => Promise.resolve([])),
    create: mock(() => Promise.resolve({})),
    findUnique: mock(() => Promise.resolve(null)),
    update: mock(() => Promise.resolve({})),
  },
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');

mock.module(dbPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

mock.module(dbJsPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

// Setup Guild Activation Mock
const mockActivation = {
  isGuildActivated: mock((_guildId: string) => true),
  activateGuild: mock(() => Promise.resolve({})),
  deactivateGuild: mock(() => Promise.resolve({})),
};
const activationPath = path.resolve(import.meta.dir, '../../utils/activation.ts');
const activationJsPath = path.resolve(import.meta.dir, '../../utils/activation.js');

mock.module(activationPath, () => mockActivation);
mock.module(activationJsPath, () => mockActivation);

// Authentification du dashboard.
//
// `verifyAuth` n'accepte plus l'en-tete `Authorization: Bearer <jwt>` : ce
// chemin est desormais conditionne a la variable AUTH_LEGACY_BEARER_UNTIL et
// destine a disparaitre. L'authentification reelle passe par une session
// serveur referencee par un cookie. On mocke donc le magasin de sessions
// plutot que de tester un mecanisme obsolete.
const TEST_SESSION_ID = 'test-session-id';
const TEST_SESSION = {
  userId: '123456789012345678',
  username: 'TestUser',
  avatar: null,
  discordAccessToken: 'discord-access-token',
  discordRefreshToken: 'discord-refresh-token',
  expiresAt: Date.now() + 3_600_000,
};

const sessionStorePath = path.resolve(import.meta.dir, '../../api/auth/sessionStore.ts');
const sessionStoreJsPath = path.resolve(import.meta.dir, '../../api/auth/sessionStore.js');
const mockSessionStore = () => completeModuleMock(sessionStorePath, {
  getDashboardSession: mock(async (sessionId: string | null) =>
    sessionId === TEST_SESSION_ID ? TEST_SESSION : null),
  sessionIdFromRequest: (req: { headers: Record<string, unknown> }) => {
    const raw = req.headers?.cookie;
    const cookie = Array.isArray(raw) ? raw[0] : raw;
    const match = typeof cookie === 'string' ? cookie.match(/(?:^|;\s*)kotbo_session=([^;]+)/) : null;
    return match ? match[1] : null;
  },
  sessionIdFromCookieHeader: (cookie?: string) => {
    const match = typeof cookie === 'string' ? cookie.match(/(?:^|;\s*)kotbo_session=([^;]+)/) : null;
    return match ? match[1] : null;
  },
});

mock.module(sessionStorePath, mockSessionStore);
mock.module(sessionStoreJsPath, mockSessionStore);

/** En-tetes d'une requete authentifiee, au format attendu aujourd'hui. */
const authenticatedHeaders = (extra: Record<string, string> = {}) => ({
  cookie: `kotbo_session=${TEST_SESSION_ID}`,
  ...extra,
});

const mockMcpKeyService = {
  verifyMcpKey: mock((): Promise<unknown> => Promise.resolve(null)),
  verifyMcpKeyByClientCredentials: mock((): Promise<unknown> => Promise.resolve(null)),
  getActiveMcpKeyById: mock((): Promise<unknown> => Promise.resolve(null)),
  findActiveMcpKeyById: mock((): Promise<unknown> => Promise.resolve(null)),
  createMcpKey: mock(() => Promise.resolve({})),
  getMcpKeys: mock(() => Promise.resolve([])),
  deactivateMcpKey: mock(() => Promise.resolve({ count: 1 })),
};
const mcpKeyServicePath = path.resolve(import.meta.dir, '../../api/mcp/mcpKeyService.ts');
const mcpKeyServiceJsPath = path.resolve(import.meta.dir, '../../api/mcp/mcpKeyService.js');

mock.module(mcpKeyServicePath, () => mockMcpKeyService);
mock.module(mcpKeyServiceJsPath, () => mockMcpKeyService);

const mockMcpTools = {
  registerMcpTools: mock((server: { registerTool: (...args: unknown[]) => unknown }, _guildId: string, _permissions: string[], _client: Client, options?: { securitySchemes?: unknown }) => {
    const securitySchemes = options?.securitySchemes ?? [{ type: 'oauth2', scopes: ['mcp'] }];
    server.registerTool(
      'test_tool',
      {
        description: 'Test tool',
        inputSchema: {},
        _meta: { securitySchemes },
      },
      async () => ({ content: [{ type: 'text', text: '{}' }] })
    );
  }),
};
const mcpToolsPath = path.resolve(import.meta.dir, '../../api/mcp/mcpTools.ts');
const mcpToolsJsPath = path.resolve(import.meta.dir, '../../api/mcp/mcpTools.js');

mock.module(mcpToolsPath, () => mockMcpTools);
mock.module(mcpToolsJsPath, () => mockMcpTools);

// Import router modules and helpers after mocks are set up
import { JWT_SECRET, splitPath } from '../../api/shared.js';
import { handlePublicRoutes } from '../../api/routes/public.js';
import { handleAuthRoutes } from '../../api/routes/auth.js';
import { handleReportErrorRoute } from '../../api/routes/error.js';
import { handleUserRoutes } from '../../api/routes/user.js';
import { handleAdminRoutes } from '../../api/routes/admin.js';
import { handleDashboardRoutes } from '../../api/routes/dashboard.js';
import { getMcpConnectionLogs, handleMCPRoutes, makeMcpDirectToken } from '../../api/mcp/mcpServer.js';

// Helper mock req/res functions
function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = options.method || 'GET';
  req.url = options.url || '/';
  req.headers = options.headers || {};
  if (options.body) {
    (req as IncomingMessage & { bodyText?: string }).bodyText = options.body;
    req.push(options.body);
    req.push(null);
  } else {
    (req as IncomingMessage & { bodyText?: string }).bodyText = '';
    req.push(null);
  }
  return req;
}

interface MockResponse extends ServerResponse {
  body: string;
}

function createMockResponse(): MockResponse {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as MockResponse;
  
  let _statusCode = 200;
  let _body = '';
  const _headers: Record<string, string> = {};

  Object.defineProperty(res, 'statusCode', {
    get: () => _statusCode,
    set: (code: number) => {
      _statusCode = code;
    }
  });

  res.setHeader = (name: string, value: unknown) => {
    _headers[name.toLowerCase()] = String(value);
    return res;
  };

  res.getHeader = (name: string) => {
    return _headers[name.toLowerCase()];
  };

  res.writeHead = (statusCode: number, headers?: unknown) => {
    _statusCode = statusCode;
    if (headers) {
      for (const key of Object.keys(headers)) {
        res.setHeader(key, headers[key as keyof typeof headers]);
      }
    }
    return res;
  };

  res.write = (chunk: Record<string, unknown>) => {
    _body += chunk.toString();
    return true;
  };

  res.end = (chunk?: unknown) => {
    if (chunk) {
      _body += chunk.toString();
    }
    (res as unknown as { finished: boolean }).finished = true;
    res.body = _body;
    return res;
  };

  return res;
}

// Mock Discord Client
const mockClient = {
  users: {
    fetch: mock((userId: string) => Promise.resolve({
      id: userId,
      tag: 'TestUser#1234',
      username: 'TestUser',
      globalName: 'Test User',
      displayAvatarURL: () => 'http://example.com/avatar.png',
      accentColor: 0xff0000,
      createdAt: new Date(),
      bot: false,
    })),
  },
  guilds: {
    cache: {
      get: mock((guildId: string) => ({
        id: guildId,
        name: 'Test Guild',
        memberCount: 100,
        roles: {
          cache: {
            get: () => null,
          },
        },
        channels: {
          cache: {
            get: mock((channelId: string) => ({
              id: channelId,
              isTextBased: () => true,
              send: mock((options: Record<string, unknown>) => Promise.resolve({ id: 'sent-msg-id', ...options })),
              messages: {
                fetch: mock((messageId: string) => Promise.resolve({
                  id: messageId,
                  edit: mock((options: Record<string, unknown>) => Promise.resolve({ id: messageId, ...options })),
                })),
              },
            })),
            values: () => [],
          },
        },
        members: {
          fetch: mock(() => Promise.resolve({
            id: '123456789012345678',
            roles: {
              cache: new Map(),
            },
            permissions: {
              has: () => true,
            },
          })),
        },
      })),
      find: mock(() => null),
      first: mock(() => ({ id: 'fallback-guild' })),
    },
    fetch: mock((guildId: string) => Promise.resolve({
      id: guildId,
      name: 'Test Guild',
      memberCount: 100,
    })),
  },
} as unknown as Client;

async function requestMcpOverHttp(body: unknown, extraHeaders: Record<string, string> = {}, requestPath = '/api/mcp/112233445566778899') {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    (req as IncomingMessage & { bodyText?: string }).bodyText = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const handled = await handleMCPRoutes(
      req as IncomingMessage & { bodyText?: string },
      res,
      splitPath(url.pathname),
      url,
      mockClient
    );
    if (!handled) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api-kotbo.example',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: await response.text(),
      headers: response.headers,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function requestMcpWithMismatchedRawContentType(body: unknown) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    (req as IncomingMessage & { bodyText?: string }).bodyText = Buffer.concat(chunks).toString('utf8');
    req.headers['content-type'] = 'application/json';
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'content-type') {
        req.rawHeaders[i + 1] = 'text/plain';
      }
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const handled = await handleMCPRoutes(
      req as IncomingMessage & { bodyText?: string },
      res,
      splitPath(url.pathname),
      url,
      mockClient
    );
    if (!handled) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/mcp/112233445566778899`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api-kotbo.example',
      },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: await response.text(),
      headers: response.headers,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

describe('Modular Routers Unit Tests', () => {
  let testUserToken: string;

  beforeEach(() => {
    // Reset all mock functions
    mockDb.memberProfile.findUnique.mockClear();
    mockDb.memberProfile.update.mockClear();
    mockDb.memberProfile.findMany.mockClear();
    mockDb.guild.findUnique.mockClear();
    mockDb.guild.findMany.mockClear();
    mockDb.newsArticle.findMany.mockClear();
    mockDb.transcript.findUnique.mockClear();
    mockDb.globalAdmin.findMany.mockClear();
    mockDb.globalAdmin.findUnique.mockClear();
    mockDb.sanction.count.mockClear();
    mockDb.sanction.findMany.mockClear();
    mockDb.dailyAlgoSubmission.count.mockClear();
    mockDb.globalBlacklist.findMany.mockClear();
    mockDb.globalBlacklist.upsert.mockClear();
    mockDb.globalBlacklist.delete.mockClear();
    mockDb.bannedWord.findMany.mockClear();
    mockDb.bannedWord.findFirst.mockClear();
    mockDb.bannedWord.create.mockClear();
    mockDb.bannedWord.update.mockClear();
    mockDb.bannedWord.delete.mockClear();
    mockDb.botGlobalConfig.findUnique.mockClear();
    mockDb.botGlobalConfig.upsert.mockClear();
    mockDb.botErrorLog.findMany.mockClear();
    mockDb.botErrorLog.deleteMany.mockClear();
    mockDb.activationCode.findMany.mockClear();
    mockDb.activationCode.create.mockClear();
    mockDb.activationCode.findUnique.mockClear();
    mockDb.activationCode.update.mockClear();
    mockDb.dashboardAuditLog.create.mockClear();
    mockDb.dashboardFeatureConfig.findMany.mockClear();
    mockDb.dashboardFeatureConfig.create.mockClear();
    mockDb.dashboardFeatureConfig.findUnique.mockClear();
    mockDb.dashboardFeatureConfig.update.mockClear();
    mockMcpKeyService.verifyMcpKey.mockClear();
    mockMcpKeyService.verifyMcpKeyByClientCredentials.mockClear();
    mockMcpKeyService.getActiveMcpKeyById.mockClear();
    mockMcpKeyService.findActiveMcpKeyById.mockClear();
    mockMcpKeyService.createMcpKey.mockClear();
    mockMcpKeyService.getMcpKeys.mockClear();
    mockMcpKeyService.deactivateMcpKey.mockClear();
    mockMcpTools.registerMcpTools.mockClear();

    mockActivation.isGuildActivated.mockClear();
    mockActivation.activateGuild.mockClear();
    mockActivation.deactivateGuild.mockClear();

    // Ce fichier s'appuie sur les valeurs de repli lues dans l'environnement
    // (DISCORD_CLIENT_ID, JWT_SECRET...). `setCurrentInstance` etant un etat
    // global au process, un autre fichier de test peut l'avoir renseigne : on
    // repart d'un contexte vierge pour ne pas dependre de l'ordre d'execution.
    resetCurrentInstance();

    testUserToken = jwt.sign(
      { userId: '123456789012345678', username: 'TestUser' },
      JWT_SECRET!,
      { expiresIn: '1h' }
    );
  });

  describe('1. Public Routes', () => {
    test('GET /health returns service status', async () => {
      const req = createMockRequest({ method: 'GET', url: '/health' });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBeTrue();
      expect(data.service).toBe('kotbo-dashboard-api');
    });

    test('GET /api/config returns client info', async () => {
      const req = createMockRequest({ method: 'GET', url: '/api/config' });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      // Set client ID to bypass empty checks
      process.env.DISCORD_CLIENT_ID = 'test-client-id';
      process.env.DISCORD_REDIRECT_URI = 'http://localhost';

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.discordClientId).toBe('test-client-id');
    });

    test('GET root OAuth discovery refuses templated MCP endpoints', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api-kotbo.example' },
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('guild_scoped_mcp_endpoint_required');
      expect(data.endpoint_format).toBe('https://api-kotbo.example/api/mcp/:guildId');
    });

    test('GET standard MCP protected resource metadata returns guild-scoped issuer', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource/api/mcp/112233445566778899',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api-kotbo.example' },
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.resource).toBe('https://api-kotbo.example/api/mcp/112233445566778899');
      expect(data.authorization_servers).toEqual(['https://api-kotbo.example/api/mcp/112233445566778899']);
    });

    test('GET standard MCP authorization server metadata returns concrete endpoints', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server/api/mcp/112233445566778899',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api-kotbo.example' },
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.issuer).toBe('https://api-kotbo.example/api/mcp/112233445566778899');
      expect(data.authorization_endpoint).toBe('https://api-kotbo.example/api/mcp/112233445566778899/oauth/authorize');
      expect(data.token_endpoint).toBe('https://api-kotbo.example/api/mcp/112233445566778899/oauth/token');
      expect(data.authorization_endpoint).not.toContain('{guildId}');
      expect(data.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(data.token_endpoint_auth_methods_supported[0]).toBe('none');
      expect(data.client_id_metadata_document_supported).toBe(true);
    });

    test('GET root protected resource metadata supports resource query parameter', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource?resource=https%3A%2F%2Fapi-kotbo.example%2Fapi%2Fmcp%2F112233445566778899',
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.resource).toBe('https://api-kotbo.example/api/mcp/112233445566778899');
    });

    test('GET root authorization server metadata supports resource query parameter', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server?resource=https%3A%2F%2Fapi-kotbo.example%2Fapi%2Fmcp%2F112233445566778899',
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.issuer).toBe('https://api-kotbo.example/api/mcp/112233445566778899');
    });

    test('GET root authorization server metadata supports signed direct MCP resource URLs', async () => {
      const directToken = makeMcpDirectToken('112233445566778899', 'direct-key-id');
      const directResource = `https://api-kotbo.example/api/mcp-direct/112233445566778899/${directToken}`;
      const req = createMockRequest({
        method: 'GET',
        url: `/.well-known/oauth-authorization-server?resource=${encodeURIComponent(directResource)}`,
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handlePublicRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.issuer).toBe(directResource);
      expect(data.registration_endpoint).toBe(`${directResource}/oauth/register`);
      expect(data.authorization_endpoint).toBe(`${directResource}/oauth/authorize`);
      expect(data.token_endpoint).toBe(`${directResource}/oauth/token`);
    });
  });

  describe('1b. MCP OAuth Routes', () => {
    test('rejects encoded guildId template from OAuth discovery', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/api/mcp/%7BguildId%7D/oauth/authorize?client_id=test&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=abc',
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleMCPRoutes(req as IncomingMessage & { bodyText?: string }, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('invalid_guild_id');
    });

    test('OAuth authorize page overrides global CSP so inline CSS can render', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/api/mcp/112233445566778899/oauth/authorize?client_id=test&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=abc',
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleMCPRoutes(req as IncomingMessage & { bodyText?: string }, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-security-policy')).toContain("style-src 'unsafe-inline'");
      expect(res.getHeader('content-type')).toContain('text/html');
      expect(res.body).toContain('<style>');
    });

    test('GET MCP endpoint without token starts OAuth discovery instead of returning 405', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/api/mcp/112233445566778899',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api-kotbo.example' },
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleMCPRoutes(req as IncomingMessage & { bodyText?: string }, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(401);
      expect(res.getHeader('www-authenticate')).toContain('Bearer realm="kotbo"');
      expect(res.getHeader('www-authenticate')).toContain('resource_metadata="https://api-kotbo.example/.well-known/oauth-protected-resource/api/mcp/112233445566778899"');
    });

    test('POST initialize without token is allowed for MCP client discovery', async () => {
      const response = await requestMcpOverHttp({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ChatGPT', version: 'test' },
        },
      });

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.result.serverInfo.name).toBe('kotbo');
      expect(mockMcpKeyService.verifyMcpKey).not.toHaveBeenCalled();
      expect(mockMcpTools.registerMcpTools).toHaveBeenCalledWith(
        expect.anything(),
        '112233445566778899',
        [],
        mockClient,
        expect.objectContaining({ listAllTools: true })
      );
    });

    test('POST initialize tolerates Claude httpx loose transport headers', async () => {
      const response = await requestMcpOverHttp(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'Claude', version: 'httpx' },
          },
        },
        { accept: '*/*', 'content-type': 'text/plain', 'user-agent': 'python-httpx/0.28.1' }
      );

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.result.serverInfo.name).toBe('kotbo');
    });

    test('POST initialize normalizes raw content-type even when parsed header looks valid', async () => {
      const response = await requestMcpWithMismatchedRawContentType({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'Claude', version: 'raw-header-mismatch' },
        },
      });

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.result.serverInfo.name).toBe('kotbo');
    });

    test('POST tools/list without token lists public tool descriptors instead of HTTP 401', async () => {
      const response = await requestMcpOverHttp({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.result.tools).toEqual([
        expect.objectContaining({
          name: 'test_tool',
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }],
          _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }] },
        }),
      ]);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(mockMcpTools.registerMcpTools).toHaveBeenCalledWith(
        expect.anything(),
        '112233445566778899',
        [],
        mockClient,
        expect.objectContaining({ listAllTools: true })
      );
    });

    test('POST tools/call without token returns HTTP OAuth challenge for Claude lazy auth', async () => {
      const response = await requestMcpOverHttp(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'test_tool',
            arguments: {},
          },
        },
        { 'user-agent': 'Claude MCP Connector' }
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer realm="kotbo"');
      expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://api-kotbo.example/.well-known/oauth-protected-resource/api/mcp/112233445566778899"');
      const data = JSON.parse(response.body);
      expect(data.error).toBe('authorization_required');
    });

    test('OAuth token endpoint supports client_credentials with MCP key client ID and secret', async () => {
      const clientId = 'mcp-key-id';
      const clientSecret = 'mcp_test_secret';
      mockMcpKeyService.verifyMcpKeyByClientCredentials.mockImplementation(() => Promise.resolve({
        id: clientId,
        guildId: '112233445566778899',
        isActive: true,
      } as unknown));

      const req = createMockRequest({
        method: 'POST',
        url: '/api/mcp/112233445566778899/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      const res = createMockResponse();
      const parts = splitPath(new URL(req.url!, 'http://localhost').pathname);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleMCPRoutes(req as IncomingMessage & { bodyText?: string }, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.access_token).toBe(clientSecret);
      expect(data.token_type).toBe('Bearer');
    });

    test('OAuth authorization_code returns JWT access token and refresh token accepted by MCP endpoint', async () => {
      const keyId = 'mcp-key-id';
      const rawKey = 'mcp_test_secret';
      const clientId = 'oauth-client-id';
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const codeVerifier = 'test-verifier';
      const codeChallenge = nodeCrypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const resource = 'https://api-kotbo.example/api/mcp/112233445566778899';

      mockMcpKeyService.verifyMcpKey.mockImplementation(() => Promise.resolve({
        id: keyId,
        guildId: '112233445566778899',
        permissions: ['READ_STATS'],
        isActive: true,
      } as unknown));
      mockMcpKeyService.getActiveMcpKeyById.mockImplementation(() => Promise.resolve({
        id: keyId,
        guildId: '112233445566778899',
        permissions: ['READ_STATS'],
        isActive: true,
      } as unknown));

      const authorizeReq = createMockRequest({
        method: 'POST',
        url: `/api/mcp/112233445566778899/oauth/authorize?resource=${encodeURIComponent(resource)}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'api-kotbo.example',
        },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          state: 'state',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          api_key: rawKey,
          resource,
        }).toString(),
      });
      const authorizeRes = createMockResponse();
      await handleMCPRoutes(
        authorizeReq as IncomingMessage & { bodyText?: string },
        authorizeRes,
        splitPath(new URL(authorizeReq.url!, 'http://localhost').pathname),
        new URL(authorizeReq.url!, 'http://localhost'),
        mockClient
      );
      const callbackUrl = new URL(String(authorizeRes.getHeader('location')));
      const code = callbackUrl.searchParams.get('code')!;

      const tokenReq = createMockRequest({
        method: 'POST',
        url: '/api/mcp/112233445566778899/oauth/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'api-kotbo.example',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          resource,
        }).toString(),
      });
      const tokenRes = createMockResponse();
      await handleMCPRoutes(
        tokenReq as IncomingMessage & { bodyText?: string },
        tokenRes,
        splitPath(new URL(tokenReq.url!, 'http://localhost').pathname),
        new URL(tokenReq.url!, 'http://localhost'),
        mockClient
      );
      expect(tokenRes.statusCode).toBe(200);
      const tokenData = JSON.parse(tokenRes.body);
      expect(tokenData.access_token).not.toBe(rawKey);
      expect(tokenData.refresh_token).toStartWith('kotbo_rt_');
      expect(tokenData.token_type).toBe('Bearer');

      const response = await requestMcpOverHttp(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/list',
          params: {},
        },
        { authorization: `Bearer ${tokenData.access_token}` }
      );

      expect(response.status).toBe(200);
      expect(mockMcpKeyService.getActiveMcpKeyById).toHaveBeenCalledWith(keyId, '112233445566778899', expect.anything());
    });

    test('signed direct MCP URL authenticates without OAuth and hides token in logs', async () => {
      const keyId = 'direct-key-id';
      const directToken = makeMcpDirectToken('112233445566778899', keyId);
      mockMcpKeyService.getActiveMcpKeyById.mockImplementation(() => Promise.resolve({
        id: keyId,
        guildId: '112233445566778899',
        permissions: ['READ_STATS'],
        isActive: true,
      } as unknown));

      const initializeResponse = await requestMcpOverHttp(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'Claude', version: 'httpx' },
          },
        },
        { 'user-agent': 'Claude MCP Connector', accept: '*/*' },
        `/api/mcp-direct/112233445566778899/${directToken}`
      );
      expect(initializeResponse.status).toBe(200);
      const initializeData = JSON.parse(initializeResponse.body);
      expect(initializeData.result.protocolVersion).toBe('2025-06-18');
      expect(initializeData.result.capabilities.tools).toEqual({});
      expect(initializeData.result.serverInfo.name).toBe('kotbo');

      const response = await requestMcpOverHttp(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/list',
          params: {},
        },
        { 'user-agent': 'Claude MCP Connector' },
        `/api/mcp-direct/112233445566778899/${directToken}`
      );

      expect(response.status).toBe(200);
      expect(mockMcpKeyService.getActiveMcpKeyById).toHaveBeenCalledWith(keyId, '112233445566778899', expect.anything());
      expect(mockMcpTools.registerMcpTools).toHaveBeenCalledWith(
        expect.anything(),
        '112233445566778899',
        ['READ_STATS'],
        mockClient,
        expect.objectContaining({ listAllTools: false, securitySchemes: [{ type: 'noauth' }] })
      );
      const data = JSON.parse(response.body);
      expect(data.result.tools[0].securitySchemes).toEqual([{ type: 'noauth' }]);
      expect(JSON.stringify(data.result.tools[0])).not.toContain('oauth2');

      const logs = getMcpConnectionLogs('112233445566778899', 20);
      expect(JSON.stringify(logs)).not.toContain(directToken);
      expect(logs.some((entry) => entry.url.includes('/api/mcp-direct/112233445566778899/[token]'))).toBeTrue();
    });

    test('signed direct MCP URL supports automatic OAuth registration flow for Claude fallback', async () => {
      const keyId = 'direct-key-id';
      const directToken = makeMcpDirectToken('112233445566778899', keyId);
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const codeVerifier = 'direct-verifier';
      const codeChallenge = nodeCrypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const directResource = `https://api-kotbo.example/api/mcp-direct/112233445566778899/${directToken}`;

      mockMcpKeyService.getActiveMcpKeyById.mockImplementation(() => Promise.resolve({
        id: keyId,
        guildId: '112233445566778899',
        permissions: ['READ_STATS'],
        isActive: true,
      } as unknown));

      const registerReq = createMockRequest({
        method: 'POST',
        url: `/api/mcp-direct/112233445566778899/${directToken}/oauth/register`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude',
          redirect_uris: [redirectUri],
        }),
      });
      const registerRes = createMockResponse();
      await handleMCPRoutes(
        registerReq as IncomingMessage & { bodyText?: string },
        registerRes,
        splitPath(new URL(registerReq.url!, 'http://localhost').pathname),
        new URL(registerReq.url!, 'http://localhost'),
        mockClient
      );
      expect(registerRes.statusCode).toBe(201);
      const registered = JSON.parse(registerRes.body);

      const authorizeReq = createMockRequest({
        method: 'GET',
        url: `/api/mcp-direct/112233445566778899/${directToken}/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: registered.client_id,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: 'state',
          resource: directResource,
        }).toString()}`,
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'api-kotbo.example',
        },
      });
      const authorizeRes = createMockResponse();
      await handleMCPRoutes(
        authorizeReq as IncomingMessage & { bodyText?: string },
        authorizeRes,
        splitPath(new URL(authorizeReq.url!, 'http://localhost').pathname),
        new URL(authorizeReq.url!, 'http://localhost'),
        mockClient
      );
      expect(authorizeRes.statusCode).toBe(302);
      const callbackUrl = new URL(String(authorizeRes.getHeader('location')));
      const code = callbackUrl.searchParams.get('code')!;
      expect(code).toStartWith('kotbo_ac_');

      const tokenReq = createMockRequest({
        method: 'POST',
        url: `/api/mcp-direct/112233445566778899/${directToken}/oauth/token`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'api-kotbo.example',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: registered.client_id,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          resource: directResource,
        }).toString(),
      });
      const tokenRes = createMockResponse();
      await handleMCPRoutes(
        tokenReq as IncomingMessage & { bodyText?: string },
        tokenRes,
        splitPath(new URL(tokenReq.url!, 'http://localhost').pathname),
        new URL(tokenReq.url!, 'http://localhost'),
        mockClient
      );
      expect(tokenRes.statusCode).toBe(200);
      const tokenData = JSON.parse(tokenRes.body);
      expect(typeof tokenData.access_token).toBe('string');
      expect(tokenData.token_type).toBe('Bearer');

      const logs = getMcpConnectionLogs('112233445566778899', 30);
      expect(JSON.stringify(logs)).not.toContain(directToken);
    });
  });

  describe('2. Auth Routes', () => {
    test('active Discord login is handled by the Hono router', async () => {
      const req = createMockRequest({ method: 'GET', url: '/api/auth/discord/login' });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleAuthRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeFalse();
    });

    test('legacy implicit token exchange is retired', async () => {
      const req = createMockRequest({ method: 'POST', url: '/api/auth/discord/token-exchange' });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleAuthRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(410);
    });

  });

  describe('3. Error Routes', () => {
    test('POST /api/report-error returns 400 for invalid payload', async () => {
      const req = createMockRequest({
        method: 'POST',
        url: '/api/report-error',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleReportErrorRoute(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(400);
    });
  });

  describe('4. User Routes', () => {
    test('GET /api/user/me returns user info when authenticated', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/api/user/me',
        headers: authenticatedHeaders(),
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleUserRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.id).toBe('123456789012345678');
      expect(data.username).toBe('TestUser');
    });
  });

  describe('5. Admin Routes', () => {
    test('GET /api/admin/stats is blocked without admin access', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/api/admin/stats',
        headers: authenticatedHeaders(),
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      // Mock resolvesAdminAccess to false
      mockDb.globalAdmin.findUnique.mockResolvedValue(null);

      const handled = await handleAdminRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(403);
    });
  });

  describe('6. Dashboard Router dispatcher', () => {
    test('Bypasses auth for recruitment webhook', async () => {
      const req = createMockRequest({
        method: 'POST',
        url: '/api/dashboard/guilds/1122334455667788/recruitment/candidatures',
        body: JSON.stringify({ data: { name: 'Applicant' } }),
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleDashboardRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(401);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('Non authentifié');
    });

    test('Requires user authentication for general guild settings', async () => {
      const req = createMockRequest({
        method: 'GET',
        url: '/api/dashboard/guilds/1122334455667788/state',
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleDashboardRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(401);
    });

    test('GET /api/dashboard/guilds/:guildId/notifications/features returns 200', async () => {
      // Mock db feature configs and guild info
      mockDb.guild.findUnique.mockResolvedValue({ id: '1122334455667788', dailyAlgoEnabled: true });
      mockDb.dashboardFeatureConfig.findMany.mockResolvedValue([]);
      
      const req = createMockRequest({
        method: 'GET',
        url: '/api/dashboard/guilds/1122334455667788/notifications/features',
        headers: authenticatedHeaders(),
      });
      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleDashboardRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.features).toBeDefined();
    });

    test('POST /api/dashboard/guilds/:guildId/embed-builder parses content and V2 embed fields', async () => {
      mockDb.guild.findUnique.mockResolvedValue({ id: '1122334455667788' });
      mockDb.dashboardFeatureConfig.findMany.mockResolvedValue([]);

      const payload = {
        channelId: '12345678',
        content: 'This is test content outside the embed',
        embed: {
          title: 'V2 Title',
          description: 'V2 Description',
          color: '#ff0000',
          url: 'https://title-url.com',
          authorName: 'V2 Author',
          authorUrl: 'https://author-url.com',
          timestamp: true,
        },
      };

      const req = createMockRequest({
        method: 'POST',
        url: '/api/dashboard/guilds/1122334455667788/embed-builder',
        headers: authenticatedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      });

      const res = createMockResponse();
      const parts = splitPath(req.url!);
      const url = new URL(req.url!, 'http://localhost');

      const handled = await handleDashboardRoutes(req, res, parts, url, mockClient);
      expect(handled).toBeTrue();
      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.ok).toBeTrue();
      expect(data.messageId).toBe('sent-msg-id');
    });
  });
});
