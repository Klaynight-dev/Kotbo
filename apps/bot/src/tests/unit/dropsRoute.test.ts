import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { PlanLockedError } from '../../services/core/moduleActivationService.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

let inOnboardingResult = false;
const mockSetStatus = mock(async () => ({
  moduleKey: 'drops',
  enabled: true,
  enabledRequirements: [],
  disabledDependents: [],
  preparedOnly: inOnboardingResult,
}));

let guildRow: Record<string, unknown> | null = null;
const mockDb = {
  guild: {
    findUnique: mock(async () => guildRow),
    update: mock(async () => guildRow),
  },
  dashboardAuditLog: {
    create: mock(async () => ({})),
  },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const moduleActivationPath = path.resolve(__dirname, '../../services/core/moduleActivationService.ts');
for (const suffix of [
  '../../services/core/moduleActivationService.ts',
  '../../services/core/moduleActivationService.js',
]) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(moduleActivationPath, {
    PlanLockedError,
    setDashboardModuleStatus: mockSetStatus,
  }));
}

const onboardingPath = path.resolve(__dirname, '../../services/core/onboardingGate.ts');
for (const suffix of [
  '../../services/core/onboardingGate.ts',
  '../../services/core/onboardingGate.js',
]) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(onboardingPath, {
    isGuildInOnboarding: mock(async () => inOnboardingResult),
  }));
}

// Import après les mocks
const { handleDropsRoutes } = await import('../../api/routes/dashboard/drops.js');

function createMockRequest(body: Record<string, unknown>): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = 'PUT';
  req.url = '/api/dashboard/guilds/guild-123/drops';
  req.headers = { 'content-type': 'application/json' };
  const raw = JSON.stringify(body);
  req.push(raw);
  req.push(null);
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

  Object.defineProperty(res, 'statusCode', {
    get: () => _statusCode,
    set: (code: number) => {
      _statusCode = code;
    },
  });

  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (statusCode: number) => {
    _statusCode = statusCode;
    return res;
  };

  res.end = (chunk?: unknown) => {
    if (chunk) _body += String(chunk);
    res.body = _body;
    return res;
  };

  return res;
}

const mockClient = {
  guilds: {
    cache: new Map(),
  },
} as unknown as Client;

const mockUser: AuthClaims = {
  userId: 'user-1',
  username: 'Admin',
};

const mockAccess: DashboardAccess = DASHBOARD_ACCESS_ADMIN;

describe('handleDropsRoutes - onboarding et offres', () => {
  beforeEach(() => {
    mockSetStatus.mockClear();
    mockDb.guild.findUnique.mockClear();
    mockDb.guild.update.mockClear();
    inOnboardingResult = false;
    guildRow = {
      id: 'guild-123',
      dropsEnabled: false,
      dropChannelId: null,
      dropMentionRoleId: null,
      dropLifetimeMinutes: 60,
    };
  });

  test('passe recordIntentWhenLocked: true lors de l onboarding', async () => {
    inOnboardingResult = true;

    const req = createMockRequest({
      dropsEnabled: true,
      dropChannelId: 'channel-1',
      dropLifetimeMinutes: 60,
    });
    const res = createMockResponse();
    const parts = ['api', 'dashboard', 'guilds', 'guild-123', 'drops'];

    const handled = await handleDropsRoutes(
      req,
      res,
      parts,
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(handled).toBeTrue();
    expect(res.statusCode).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'guild-123',
      'drops',
      true,
      'Dashboard',
      { recordIntentWhenLocked: true },
    );
  });

  test('intercepte PlanLockedError hors onboarding et renvoie 402 plan_locked au lieu de 500', async () => {
    inOnboardingResult = false;
    mockSetStatus.mockImplementationOnce(async () => {
      throw new PlanLockedError('drops', 'FREE', 'PRO');
    });

    const req = createMockRequest({
      dropsEnabled: true,
      dropChannelId: 'channel-1',
    });
    const res = createMockResponse();
    const parts = ['api', 'dashboard', 'guilds', 'guild-123', 'drops'];

    const handled = await handleDropsRoutes(
      req,
      res,
      parts,
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(handled).toBeTrue();
    expect(res.statusCode).toBe(402);
    const data = JSON.parse(res.body);
    expect(data.code).toBe('plan_locked');
    expect(data.moduleKey).toBe('drops');
    expect(data.requiredPlan).toBe('PRO');
  });
});
