import { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Client } from 'discord.js';
import type { McpKeyPermission } from '@prisma/client';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JWT_SECRET, json } from '../shared.js';
import { getActiveMcpKeyById, verifyMcpKey, verifyMcpKeyByClientCredentials } from './mcpKeyService.js';
import { registerMcpTools } from './mcpTools.js';
import { logger } from '../../utils/logger.js';

// ── In-memory OAuth state (ephemeral, single-instance) ────────────────────

type OAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  guildId: string;
};

type AuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  guildId: string;
  keyId: string;
  expiresAt: number;
  resource?: string;
};

type RefreshTokenPayload = {
  clientId: string;
  guildId: string;
  keyId: string;
  resource: string;
  expiresAt: number;
};

type McpAccessTokenClaims = {
  sub: string;
  guildId: string;
  scope?: string;
  typ?: string;
  aud?: string;
  iss?: string;
};

const oauthClients = new Map<string, OAuthClient>();
const authCodes    = new Map<string, AuthCode>();

export type McpConnectionLog = {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  guildId: string;
  event: string;
  method: string;
  url: string;
  ua: string;
  data: Record<string, unknown>;
};

const mcpConnectionLogs: McpConnectionLog[] = [];
const MCP_CONNECTION_LOG_LIMIT = 500;
const MCP_DIRECT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Clean expired codes every 15 min
setInterval(() => {
  const now = Date.now();
  for (const [code, ac] of authCodes) {
    if (ac.expiresAt < now) authCodes.delete(code);
  }
}, 15 * 60 * 1000);

// ── Rate limiter (shared, cleaned by dashboardApi.ts) ─────────────────────
export const mcpRateLimiter = new Map<string, number[]>();

function checkRateLimit(keyId: string): boolean {
  const now = Date.now();
  const ts = (mcpRateLimiter.get(keyId) ?? []).filter((t) => now - t < 60_000);
  if (ts.length >= 100) return false;
  ts.push(now);
  mcpRateLimiter.set(keyId, ts);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseFormBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function pushMcpConnectionLog(entry: McpConnectionLog) {
  mcpConnectionLogs.push(entry);
  if (mcpConnectionLogs.length > MCP_CONNECTION_LOG_LIMIT) {
    mcpConnectionLogs.splice(0, mcpConnectionLogs.length - MCP_CONNECTION_LOG_LIMIT);
  }
}

export function getMcpConnectionLogs(guildId: string, limit = 150): McpConnectionLog[] {
  return mcpConnectionLogs
    .filter((entry) => entry.guildId === guildId)
    .slice(-limit)
    .reverse();
}

function inferMcpGuildId(req: IncomingMessage): string {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const match = path.match(/\/api\/(?:mcp|mcp-direct)\/(\d{15,20})(?:\/|$)/);
  return match?.[1] ?? 'unknown';
}

function sanitizeMcpUrl(rawUrl: string | undefined): string {
  return (rawUrl ?? '')
    .replace(/(\/api\/mcp-direct\/\d{15,20}\/)[^/?#&]+/g, '$1[token]')
    .replace(/(%2Fapi%2Fmcp-direct%2F\d{15,20}%2F)[^&?#]+/gi, '$1[token]');
}

function sanitizeMcpLogValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeMcpUrl(value);
  if (Array.isArray(value)) return value.map(sanitizeMcpLogValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeMcpLogValue(item)])
    );
  }
  return value;
}

function oauthError(req: IncomingMessage, res: ServerResponse, status: number, error: string, desc?: string) {
  mcpLog(req, 'oauth_error', { status, error, description: desc ?? null }, 'warn');
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify({ error, ...(desc ? { error_description: desc } : {}) }));
}

function sendOAuthTokenResponse(res: ServerResponse, body: Record<string, unknown>) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.statusCode = 200;
  res.end(JSON.stringify(body));
}

function mcpLog(req: IncomingMessage, event: string, data: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
  const ua = Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'].join(' ') : req.headers['user-agent'] ?? '';
  const guildId = typeof data.guildId === 'string' ? data.guildId : inferMcpGuildId(req);
  const safeUrl = sanitizeMcpUrl(req.url);
  const safeData = sanitizeMcpLogValue(data) as Record<string, unknown>;
  const payload = {
    method: req.method,
    url: safeUrl,
    ua: ua.slice(0, 120),
    guildId,
    ...safeData,
  };

  pushMcpConnectionLog({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level,
    guildId,
    event,
    method: req.method ?? 'GET',
    url: safeUrl,
    ua: ua.slice(0, 120),
    data: safeData,
  });

  const log = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
  log('MCPAuth', `${event} ${JSON.stringify(payload)}`);
}

function authParam(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function authChallenge(req: IncomingMessage, url: URL, guildId: string, error?: string, errorDescription?: string): string {
  const params = [
    'Bearer realm="kotbo"',
    'scope="mcp"',
    `resource_metadata="${standardProtectedResourceMetadataUrl(req, url, guildId)}"`,
  ];
  if (error) {
    params.splice(1, 0, `error="${authParam(error)}"`);
    params.splice(2, 0, `error_description="${authParam(errorDescription ?? 'Autorisation MCP Kotbo requise')}"`);
  }
  return params.join(', ');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function publicBase(req: IncomingMessage, url: URL, guildId: string): string {
  return `${publicOrigin(req, url)}/api/mcp/${guildId}`;
}

function directPublicBase(req: IncomingMessage, url: URL, guildId: string, directToken: string): string {
  return `${publicOrigin(req, url)}/api/mcp-direct/${guildId}/${directToken}`;
}

function publicOrigin(req: IncomingMessage, url: URL): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    ?? url.protocol.replace(':', '');
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? url.host;
  return `${proto}://${host}`;
}

function standardProtectedResourceMetadataUrl(req: IncomingMessage, url: URL, guildId: string): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    ?? url.protocol.replace(':', '');
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? url.host;
  return `${proto}://${host}/.well-known/oauth-protected-resource/api/mcp/${guildId}`;
}

function oauthCodeKey(): Buffer {
  const secret = process.env.MCP_OAUTH_CODE_SECRET || JWT_SECRET || process.env.JWT_SECRET || 'kotbo-mcp-dev-secret';
  return crypto.createHash('sha256').update(secret).digest();
}

function oauthJwtSecret(): string {
  return process.env.MCP_OAUTH_JWT_SECRET || process.env.MCP_OAUTH_CODE_SECRET || JWT_SECRET || process.env.JWT_SECRET || 'kotbo-mcp-dev-secret';
}

export function isValidMcpGuildId(guildId: string): boolean {
  return /^\d{15,20}$/.test(guildId);
}

export function mcpProtectedResourceMetadata(base: string) {
  return {
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `${base}/.well-known/oauth-protected-resource`,
  };
}

export function mcpAuthorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ['mcp', 'offline_access'],
  };
}

function jsonRpcMethod(body: unknown): string | null {
  if (!body || Array.isArray(body) || typeof body !== 'object') return null;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' ? method : null;
}

function jsonRpcId(body: unknown): unknown {
  if (!body || Array.isArray(body) || typeof body !== 'object') return null;
  return (body as { id?: unknown }).id ?? null;
}

function initializeProtocolVersion(body: unknown): string {
  if (!body || Array.isArray(body) || typeof body !== 'object') return '2025-06-18';
  const params = (body as { params?: unknown }).params;
  if (!params || Array.isArray(params) || typeof params !== 'object') return '2025-06-18';
  const protocolVersion = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof protocolVersion === 'string' && protocolVersion ? protocolVersion : '2025-06-18';
}

function initializeClientInfo(body: unknown): Record<string, unknown> | null {
  if (!body || Array.isArray(body) || typeof body !== 'object') return null;
  const params = (body as { params?: unknown }).params;
  if (!params || Array.isArray(params) || typeof params !== 'object') return null;
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (!clientInfo || Array.isArray(clientInfo) || typeof clientInfo !== 'object') return null;
  return clientInfo as Record<string, unknown>;
}

function looksLikeClaude(req: IncomingMessage): boolean {
  const ua = Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'].join(' ') : req.headers['user-agent'] ?? '';
  return /claude|anthropic/i.test(ua);
}

function zodSchemaToToolInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} };

  try {
    const converted = zodToJsonSchema(schema as never) as Record<string, unknown>;
    if (converted && converted.type === 'object') return converted;
  } catch {
    // fall through
  }

  return { type: 'object', properties: {} };
}

function sendToolsListCompat(server: McpServer, parsedBody: unknown, res: ServerResponse) {
  const registeredTools = ((server as unknown as { _registeredTools?: Record<string, Record<string, unknown>> })._registeredTools) ?? {};
  const tools = Object.entries(registeredTools)
    .filter(([, tool]) => tool.enabled !== false)
    .map(([name, tool]) => {
      const meta = (tool._meta as { securitySchemes?: unknown } | undefined) ?? {};
      const securitySchemes = meta.securitySchemes ?? [{ type: 'noauth' }, { type: 'oauth2', scopes: ['mcp'] }];

      return {
        name,
        title: tool.title,
        description: tool.description,
        inputSchema: zodSchemaToToolInputSchema(tool.inputSchema),
        outputSchema: tool.outputSchema ? zodSchemaToToolInputSchema(tool.outputSchema) : undefined,
        annotations: tool.annotations,
        execution: tool.execution,
        securitySchemes,
        _meta: { ...meta, securitySchemes },
      };
    });

  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({
    result: { tools },
    jsonrpc: '2.0',
    id: jsonRpcId(parsedBody),
  }));
}

function sendInitializeCompat(parsedBody: unknown, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: jsonRpcId(parsedBody),
    result: {
      protocolVersion: initializeProtocolVersion(parsedBody),
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'kotbo',
        version: '1.0.0',
      },
      instructions: 'Kotbo exposes Discord server tools through MCP.',
    },
  }));
}

type McpServerInternals = {
  _registeredTools: Record<string, { handler: unknown; inputSchema: unknown; enabled?: boolean }>;
  validateToolInput(tool: unknown, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: unknown, args: unknown, extra: Record<string, unknown>): Promise<unknown>;
};

async function sendToolCallCompat(server: McpServer, parsedBody: unknown, res: ServerResponse) {
  const params = (parsedBody as { params?: Record<string, unknown> })?.params ?? {};
  const toolName = typeof params.name === 'string' ? params.name : '';
  const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

  const srv = server as unknown as McpServerInternals;
  const tool = srv._registeredTools[toolName];

  const reply = (body: Record<string, unknown>) => {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  };

  if (!tool || tool.enabled === false) {
    reply({ jsonrpc: '2.0', id: jsonRpcId(parsedBody), error: { code: -32601, message: `Tool not found: ${toolName}` } });
    return;
  }

  try {
    const validatedArgs = await srv.validateToolInput(tool, toolArgs, toolName);
    const result = await srv.executeToolHandler(tool, validatedArgs, {});
    reply({ jsonrpc: '2.0', id: jsonRpcId(parsedBody), result });
  } catch (error: unknown) {
    const code = (error as { code?: number })?.code ?? -32603;
    const message = error instanceof Error ? error.message : String(error);
    reply({ jsonrpc: '2.0', id: jsonRpcId(parsedBody), error: { code, message } });
  }
}

async function handleTransportRequestWithCompat(
  transport: StreamableHTTPServerTransport,
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown
) {
  const method = jsonRpcMethod(parsedBody);

  if (method === 'tools/list') {
    sendToolsListCompat(server, parsedBody, res);
    return;
  }

  if (method === 'tools/call') {
    await sendToolCallCompat(server, parsedBody, res);
    return;
  }

  if (method === 'ping') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: jsonRpcId(parsedBody), result: {} }));
    return;
  }

  // Notifications are fire-and-forget (no id), just acknowledge.
  if (method?.startsWith('notifications/')) {
    res.statusCode = 202;
    res.end();
    return;
  }

  await transport.handleRequest(req, res, parsedBody);
}

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
    return hash === challenge;
  }
  return verifier === challenge; // plain
}

function readBasicClientCredentials(authHeader: string | string[] | undefined): { clientId: string; clientSecret: string } | null {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw?.startsWith('Basic ')) return null;

  try {
    const decoded = Buffer.from(raw.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;

    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function setIncomingHeader(req: IncomingMessage, name: string, value: string) {
  const lowerName = name.toLowerCase();
  req.headers[lowerName] = value;

  let found = false;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === lowerName) {
      req.rawHeaders[i + 1] = value;
      found = true;
    }
  }

  if (!found) {
    req.rawHeaders.push(name, value);
  }
}

function getRawIncomingHeader(req: IncomingMessage, name: string): string | null {
  const lowerName = name.toLowerCase();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === lowerName) {
      return req.rawHeaders[i + 1] ?? null;
    }
  }
  return null;
}

function normalizeMcpTransportAcceptHeader(req: IncomingMessage, method: string): string | null {
  const current = Array.isArray(req.headers.accept) ? req.headers.accept.join(', ') : req.headers.accept;

  if (method === 'POST') {
    if (!current?.includes('application/json') || !current.includes('text/event-stream')) {
      setIncomingHeader(req, 'Accept', 'application/json, text/event-stream');
      return current ?? null;
    }
  }

  if (method === 'GET' && !current?.includes('text/event-stream')) {
    setIncomingHeader(req, 'Accept', 'text/event-stream');
    return current ?? null;
  }

  return null;
}

function normalizeMcpTransportContentTypeHeader(req: IncomingMessage, method: string, parsedBody: unknown): string | null {
  if (method !== 'POST') return null;
  if (!jsonRpcMethod(parsedBody)) return null;

  const current = Array.isArray(req.headers['content-type'])
    ? req.headers['content-type'].join(', ')
    : req.headers['content-type'];
  const rawCurrent = getRawIncomingHeader(req, 'Content-Type');

  setIncomingHeader(req, 'Content-Type', 'application/json');
  if (current?.includes('application/json') && rawCurrent?.includes('application/json')) {
    return null;
  }

  return JSON.stringify({ header: current ?? null, rawHeader: rawCurrent });
}

function makeAccessToken(opts: {
  guildId: string;
  keyId: string;
  issuer: string;
  audience: string;
  scope?: string;
}) {
  return jwt.sign(
    {
      guildId: opts.guildId,
      scope: opts.scope ?? 'mcp',
    },
    oauthJwtSecret(),
    {
      subject: opts.keyId,
      issuer: opts.issuer,
      audience: opts.audience,
      expiresIn: '1h',
    }
  );
}

export function makeMcpDirectUrl(req: IncomingMessage, url: URL, guildId: string, keyId: string) {
  const token = makeMcpDirectToken(guildId, keyId);
  return {
    directUrl: `${publicOrigin(req, url)}/api/mcp-direct/${guildId}/${token}`,
    expiresAt: new Date(Date.now() + MCP_DIRECT_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

export function makeMcpDirectToken(guildId: string, keyId: string) {
  return jwt.sign(
    {
      guildId,
      typ: 'mcp_direct',
      scope: 'mcp',
    },
    oauthJwtSecret(),
    {
      subject: keyId,
      issuer: 'kotbo-mcp-direct',
      audience: 'kotbo-mcp-direct',
      expiresIn: MCP_DIRECT_TOKEN_TTL_SECONDS,
    }
  );
}

async function verifyMcpDirectToken(token: string, guildId: string, client?: Client) {
  try {
    const claims = jwt.verify(token, oauthJwtSecret(), {
      issuer: 'kotbo-mcp-direct',
      audience: 'kotbo-mcp-direct',
    }) as McpAccessTokenClaims;

    if (claims.typ !== 'mcp_direct' || claims.guildId !== guildId || typeof claims.sub !== 'string') {
      return null;
    }

    return getActiveMcpKeyById(claims.sub, guildId, client);
  } catch {
    return null;
  }
}

function sealRefreshToken(payload: RefreshTokenPayload): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', oauthCodeKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `kotbo_rt_${Buffer.concat([iv, tag, encrypted]).toString('base64url')}`;
}

function openRefreshToken(refreshToken: string): RefreshTokenPayload | null {
  if (!refreshToken.startsWith('kotbo_rt_')) return null;

  try {
    const packed = Buffer.from(refreshToken.slice('kotbo_rt_'.length), 'base64url');
    if (packed.length <= 28) return null;

    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', oauthCodeKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as RefreshTokenPayload;
  } catch {
    return null;
  }
}

async function verifyOAuthAccessToken(token: string, guildId: string, audience: string, client?: Client) {
  try {
    const claims = jwt.verify(token, oauthJwtSecret(), {
      audience,
    }) as McpAccessTokenClaims;

    if (claims.guildId !== guildId || typeof claims.sub !== 'string') return null;
    return getActiveMcpKeyById(claims.sub, guildId, client);
  } catch {
    return null;
  }
}

function sealAuthCode(payload: AuthCode): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', oauthCodeKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `kotbo_ac_${Buffer.concat([iv, tag, encrypted]).toString('base64url')}`;
}

function openAuthCode(code: string): AuthCode | null {
  if (!code.startsWith('kotbo_ac_')) return null;

  try {
    const packed = Buffer.from(code.slice('kotbo_ac_'.length), 'base64url');
    if (packed.length <= 28) return null;

    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', oauthCodeKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as AuthCode;
  } catch {
    return null;
  }
}

// ── Authorization HTML page ───────────────────────────────────────────────

function authPage(opts: {
  guildId: string; clientName: string; clientId: string;
  redirectUri: string; state: string; codeChallenge: string;
  codeChallengeMethod: string; resource?: string; error?: string;
}): string {
  const e = escapeHtml;
  return `<!DOCTYPE html><html lang="fr">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kotbo - Autorisation MCP</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e5e7eb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#1a1d23;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:2rem;width:100%;max-width:400px}
h1{font-size:1.375rem;font-weight:800;color:#fff;margin-bottom:.25rem}
.sub{font-size:.8125rem;color:#6b7280;margin-bottom:1.5rem}
.app{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:.875rem 1rem;margin-bottom:1.5rem}
.app-name{font-size:.875rem;font-weight:600;color:#fff}
.app-desc{font-size:.75rem;color:#6b7280;margin-top:.25rem}
label{display:block;font-size:.8125rem;font-weight:500;color:#9ca3af;margin-bottom:.375rem}
input[type=password]{width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:.625rem .875rem;color:#fff;font-size:.875rem;font-family:monospace;outline:none;transition:border-color .15s}
input[type=password]:focus{border-color:rgba(99,102,241,.5)}
.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:8px;padding:.625rem .875rem;font-size:.8125rem;color:#f87171;margin-bottom:1rem}
button{width:100%;padding:.75rem;background:#6366f1;border:none;border-radius:8px;color:#fff;font-size:.9375rem;font-weight:600;cursor:pointer;margin-top:1rem;transition:background .15s}
button:hover{background:#5558e3}
.hint{font-size:.75rem;color:#4b5563;margin-top:1rem;text-align:center;line-height:1.5}
</style>
</head>
<body>
<div class="card">
  <h1>Kotbo</h1>
  <p class="sub">Serveur MCP - autorisation d'accès</p>
  <div class="app">
    <div class="app-name">${e(opts.clientName)}</div>
    <div class="app-desc">Cet agent IA souhaite accéder aux données de ton serveur Discord via Kotbo.</div>
  </div>
  ${opts.error ? `<div class="err">${e(opts.error)}</div>` : ''}
  <form method="POST">
    <input type="hidden" name="client_id" value="${e(opts.clientId)}">
    <input type="hidden" name="redirect_uri" value="${e(opts.redirectUri)}">
    <input type="hidden" name="state" value="${e(opts.state)}">
    <input type="hidden" name="code_challenge" value="${e(opts.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${e(opts.codeChallengeMethod)}">
    ${opts.resource ? `<input type="hidden" name="resource" value="${e(opts.resource)}">` : ''}
    <label for="api_key">Clé MCP Kotbo</label>
    <input type="password" id="api_key" name="api_key" placeholder="mcp_…" required autocomplete="off" autofocus>
    <button type="submit">Autoriser l'accès</button>
  </form>
  <p class="hint">Trouve ta clé dans <strong>Kotbo → Paramètres → API MCP</strong><br>puis clique sur une clé pour voir son Client Secret.</p>
</div>
</body></html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleMCPRoutes(
  req: IncomingMessage & { bodyText?: string },
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client
): Promise<boolean> {
  const isStandardMcp = parts[0] === 'api' && parts[1] === 'mcp';
  const isDirectMcp = parts[0] === 'api' && parts[1] === 'mcp-direct';
  if (!isStandardMcp && !isDirectMcp) return false;

  const guildId = parts[2];
  if (!guildId) {
    json(res, 400, { error: 'guildId manquant dans le chemin /api/mcp/:guildId' });
    return true;
  }
  if (!isValidMcpGuildId(guildId)) {
    json(res, 400, {
      error: 'invalid_guild_id',
      error_description: 'Utilise l URL MCP complete depuis le dashboard Kotbo, avec l ID Discord du serveur.',
    });
    return true;
  }

  const method = req.method ?? 'GET';
  const directToken = isDirectMcp ? parts[3] : null;
  const subPath = parts.slice(isDirectMcp ? 4 : 3).join('/');
  const base = directToken ? directPublicBase(req, url, guildId, directToken) : publicBase(req, url, guildId);

  if (isDirectMcp && !directToken) {
    mcpLog(req, 'mcp_direct_missing_token', { guildId }, 'warn');
    json(res, 401, { error: 'direct_token_required' });
    return true;
  }

  // ── Protected Resource Metadata (RFC 9728) ─────────────────────────────
  if (subPath === '.well-known/oauth-protected-resource' && method === 'GET') {
    json(res, 200, mcpProtectedResourceMetadata(base));
    return true;
  }

  // ── Authorization Server Metadata (RFC 8414) ───────────────────────────
  if (subPath === '.well-known/oauth-authorization-server' && method === 'GET') {
    json(res, 200, mcpAuthorizationServerMetadata(base));
    return true;
  }

  if (subPath === '.well-known/openid-configuration' && method === 'GET') {
    json(res, 200, mcpAuthorizationServerMetadata(base));
    return true;
  }

  // ── Dynamic Client Registration (RFC 7591) ─────────────────────────────
  if (subPath === 'oauth/register' && method === 'POST') {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(req.bodyText ?? '{}') as Record<string, unknown>; } catch { /* ok */ }

    const clientId    = crypto.randomUUID();
    const redirectUris = (body.redirect_uris as string[] | undefined) ?? [];
    const clientName  = (body.client_name as string | undefined) ?? 'Unknown Client';

    oauthClients.set(clientId, { clientId, redirectUris, clientName, guildId });
    mcpLog(req, 'dcr_registered', { guildId, clientId, redirectUris, clientName });

    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 201;
    res.end(JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }));
    return true;
  }

  // ── Authorization endpoint - GET (show login form) ─────────────────────
  if (subPath === 'oauth/authorize' && method === 'GET') {
    const p = url.searchParams;
    const clientId            = p.get('client_id') ?? '';
    const redirectUri         = p.get('redirect_uri') ?? '';
    const state               = p.get('state') ?? '';
    const codeChallenge       = p.get('code_challenge') ?? '';
    const codeChallengeMethod = p.get('code_challenge_method') ?? 'S256';
    const resource            = p.get('resource') ?? undefined;

    if (!clientId || !redirectUri || !codeChallenge) {
      mcpLog(req, 'authorize_get_invalid', { guildId, hasClientId: !!clientId, hasRedirectUri: !!redirectUri, hasCodeChallenge: !!codeChallenge });
      json(res, 400, { error: 'invalid_request', error_description: 'client_id, redirect_uri et code_challenge requis' });
      return true;
    }

    if (directToken) {
      const mcpKey = await verifyMcpDirectToken(directToken, guildId, client);
      if (!mcpKey) {
        mcpLog(req, 'direct_authorize_invalid', { guildId, clientId, redirectUri }, 'warn');
        json(res, 401, { error: 'invalid_direct_token' });
        return true;
      }

      const authCode: AuthCode = {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        guildId,
        keyId: mcpKey.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
        resource: resource ?? base,
      };
      const code = sealAuthCode(authCode);
      authCodes.set(code, authCode);
      mcpLog(req, 'direct_authorize_code_issued', { guildId, clientId, redirectUri, resource: resource ?? base, keyId: mcpKey.id, permissions: mcpKey.permissions });

      const dest = new URL(redirectUri);
      dest.searchParams.set('code', code);
      if (state) dest.searchParams.set('state', state);
      dest.searchParams.set('iss', resource ?? base);

      res.setHeader('Location', dest.toString());
      res.statusCode = 302;
      res.end();
      return true;
    }

    mcpLog(req, 'authorize_get_page', { guildId, clientId, redirectUri, resource: resource ?? null });
    const clientName = oauthClients.get(clientId)?.clientName ?? 'Agent IA';
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://chatgpt.com https://chat.openai.com https://gemini.google.com; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    res.end(authPage({ guildId, clientName, clientId, redirectUri, state, codeChallenge, codeChallengeMethod, resource }));
    return true;
  }

  // ── Authorization endpoint - POST (form submit, validate key, issue code) ─
  if (subPath === 'oauth/authorize' && method === 'POST') {
    const p = parseFormBody(req.bodyText ?? '');
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, api_key, resource } = p;

    if (!client_id || !redirect_uri || !code_challenge || !api_key) {
      mcpLog(req, 'authorize_post_invalid', { guildId, hasClientId: !!client_id, hasRedirectUri: !!redirect_uri, hasCodeChallenge: !!code_challenge, hasApiKey: !!api_key });
      json(res, 400, { error: 'invalid_request' });
      return true;
    }

    const cleanApiKey = api_key.trim();
    const mcpKey = await verifyMcpKey(cleanApiKey, guildId, client);
    if (!mcpKey) {
      mcpLog(req, 'authorize_post_bad_key', { guildId, clientId: client_id, redirectUri: redirect_uri });
      const clientName = oauthClients.get(client_id)?.clientName ?? 'Agent IA';
      res.setHeader('Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://chatgpt.com https://chat.openai.com https://gemini.google.com; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(authPage({
        guildId, clientName, clientId: client_id, redirectUri: redirect_uri,
        state: state ?? '', codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method ?? 'S256',
        resource,
        error: 'Clé MCP invalide ou inactive. Vérifie que tu as copié la clé complète (mcp_…).',
      }));
      return true;
    }

    const authCode: AuthCode = {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method ?? 'S256',
      guildId,
      keyId: mcpKey.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
      resource,
    };
    const code = sealAuthCode(authCode);
    authCodes.set(code, authCode);
    mcpLog(req, 'authorize_post_code_issued', { guildId, clientId: client_id, redirectUri: redirect_uri, resource: resource ?? null, keyId: mcpKey.id, permissions: mcpKey.permissions });

    const dest = new URL(redirect_uri);
    dest.searchParams.set('code', code);
    if (state) dest.searchParams.set('state', state);
    const issuer = resource ?? base;
    dest.searchParams.set('iss', issuer);

    mcpLog(req, 'authorize_post_redirect', { guildId, redirectUri: redirect_uri, iss: issuer, base, resource: resource ?? null });
    res.setHeader('Location', dest.toString());
    res.statusCode = 302;
    res.end();
    return true;
  }

  // ── Token endpoint - POST (exchange code + PKCE verifier) ─────────────
  if (subPath === 'oauth/token' && method === 'POST') {
    const ct = req.headers['content-type'] ?? '';
    let p: Record<string, string>;
    if (ct.includes('application/json')) {
      try { p = JSON.parse(req.bodyText ?? '{}') as Record<string, string>; }
      catch { oauthError(req, res, 400, 'invalid_request'); return true; }
    } else {
      p = parseFormBody(req.bodyText ?? '');
    }

    const basicCredentials = readBasicClientCredentials(req.headers.authorization);
    const { grant_type, code, code_verifier, redirect_uri, resource } = p;
    const clientId = basicCredentials?.clientId ?? p.client_id;
    const clientSecret = basicCredentials?.clientSecret ?? p.client_secret;
    mcpLog(req, 'token_request', {
      guildId,
      grantType: grant_type,
      clientId: clientId ?? null,
      hasCode: !!code,
      hasVerifier: !!code_verifier,
      redirectUri: redirect_uri ?? null,
      resource: resource ?? null,
    });

    if (grant_type === 'refresh_token') {
      const refreshToken = p.refresh_token;
      if (!refreshToken) {
        oauthError(req, res, 400, 'invalid_request', 'refresh_token requis');
        return true;
      }

      const rt = openRefreshToken(refreshToken);
      if (!rt || rt.expiresAt < Date.now() || rt.guildId !== guildId) {
        oauthError(req, res, 400, 'invalid_grant', 'refresh_token invalide ou expiré');
        return true;
      }

      const mcpKey = await getActiveMcpKeyById(rt.keyId, guildId, client);
      if (!mcpKey) {
        oauthError(req, res, 400, 'invalid_grant', 'Clé MCP inactive');
        return true;
      }

      const audience = resource ?? rt.resource ?? base;
      mcpLog(req, 'token_refresh_success', { guildId, clientId: rt.clientId, keyId: rt.keyId, resource: audience });
      sendOAuthTokenResponse(res, {
        access_token: makeAccessToken({ guildId, keyId: rt.keyId, issuer: base, audience }),
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 7776000,
        scope: 'mcp',
      });
      return true;
    }

    if (grant_type === 'client_credentials') {
      if (!clientId || !clientSecret) {
        oauthError(req, res, 400, 'invalid_request', 'client_id et client_secret requis');
        return true;
      }

      const mcpKey = await verifyMcpKeyByClientCredentials(clientId, clientSecret, guildId, client);
      if (!mcpKey) {
        oauthError(req, res, 401, 'invalid_client', 'Client ID ou secret invalide');
        return true;
      }
      mcpLog(req, 'token_client_credentials_success', { guildId, clientId, keyId: mcpKey.id });

      sendOAuthTokenResponse(res, {
        access_token: clientSecret,
        token_type: 'Bearer',
        expires_in: 7776000,
        scope: 'mcp',
      });
      return true;
    }

    if (grant_type !== 'authorization_code') {
      oauthError(req, res, 400, 'unsupported_grant_type', 'authorization_code, refresh_token et client_credentials sont supportés');
      return true;
    }
    if (!code || !code_verifier || !redirect_uri) {
      oauthError(req, res, 400, 'invalid_request', 'code, code_verifier et redirect_uri requis');
      return true;
    }

    const ac = authCodes.get(code) ?? openAuthCode(code);
    if (!ac || ac.expiresAt < Date.now()) {
      oauthError(req, res, 400, 'invalid_grant', 'Code invalide ou expiré');
      return true;
    }
    if (ac.guildId !== guildId) {
      oauthError(req, res, 400, 'invalid_grant', 'Code invalide pour ce serveur');
      return true;
    }
    if (clientId && clientId !== ac.clientId) {
      oauthError(req, res, 400, 'invalid_grant', 'client_id ne correspond pas');
      return true;
    }
    if (redirect_uri !== ac.redirectUri) {
      oauthError(req, res, 400, 'invalid_grant', 'redirect_uri ne correspond pas');
      return true;
    }
    if (resource && ac.resource && resource !== ac.resource) {
      oauthError(req, res, 400, 'invalid_target', 'resource ne correspond pas');
      return true;
    }
    if (!verifyPKCE(code_verifier, ac.codeChallenge, ac.codeChallengeMethod)) {
      oauthError(req, res, 400, 'invalid_grant', 'PKCE code_verifier invalide');
      return true;
    }

    authCodes.delete(code); // single-use
    const tokenAudience = resource ?? ac.resource ?? base;
    const refreshToken = sealRefreshToken({
      clientId: ac.clientId,
      guildId,
      keyId: ac.keyId,
      resource: tokenAudience,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    mcpLog(req, 'token_authorization_code_success', { guildId, clientId: ac.clientId, keyId: ac.keyId, resource: tokenAudience });

    sendOAuthTokenResponse(res, {
      access_token: makeAccessToken({ guildId, keyId: ac.keyId, issuer: base, audience: tokenAudience }),
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 7776000,
      scope: 'mcp',
    });
    return true;
  }

  if (isDirectMcp && subPath !== '') {
    mcpLog(req, 'mcp_direct_subpath_rejected', { guildId, subPath }, 'warn');
    json(res, 404, { error: 'not_found' });
    return true;
  }

  // ── MCP JSON-RPC / Streamable HTTP (main endpoint) ─────────────────────
  if (subPath === '') {
    let parsedBody: unknown;
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        parsedBody = req.bodyText ? JSON.parse(req.bodyText) : undefined;
      } catch {
        json(res, 400, { error: 'Corps JSON invalide' });
        return true;
      }
    }

    const authHeader = req.headers['authorization'];
    const rawKey = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;
    const basicCredentials = readBasicClientCredentials(authHeader);

    if (!directToken && !rawKey && !basicCredentials && (method === 'GET' || method === 'HEAD')) {
      mcpLog(req, 'mcp_get_auth_challenge', { guildId });
      res.setHeader('WWW-Authenticate', authChallenge(req, url, guildId));
      json(res, 401, { error: 'Authorization manquante' });
      return true;
    }

    if (!directToken && !rawKey && !basicCredentials && jsonRpcMethod(parsedBody) === 'tools/call' && looksLikeClaude(req)) {
      mcpLog(req, 'mcp_tools_call_claude_401', { guildId, tool: (parsedBody as unknown as { params?: { name?: string } })?.params?.name ?? null });
      res.setHeader('WWW-Authenticate', authChallenge(req, url, guildId, 'insufficient_scope', 'Autorisation MCP Kotbo requise'));
      json(res, 401, { error: 'authorization_required', error_description: 'Autorisation MCP Kotbo requise' });
      return true;
    }

    let permissions: McpKeyPermission[] = [];
    let keyId: string | null = null;

    if (directToken) {
      const mcpKey = await verifyMcpDirectToken(directToken, guildId, client);
      if (!mcpKey) {
        mcpLog(req, 'mcp_direct_invalid', { guildId }, 'warn');
        json(res, 401, { error: 'URL MCP directe invalide ou expirée' });
        return true;
      }

      permissions = mcpKey.permissions;
      keyId = mcpKey.id;
      mcpLog(req, 'mcp_direct_valid', { guildId, keyId, method: jsonRpcMethod(parsedBody), permissions });
    } else if (rawKey) {
      const mcpKey = rawKey.startsWith('mcp_')
        ? await verifyMcpKey(rawKey, guildId, client)
        : await verifyOAuthAccessToken(rawKey, guildId, base, client);
      if (!mcpKey) {
        mcpLog(req, 'mcp_bearer_invalid', { guildId });
        res.setHeader('WWW-Authenticate', authChallenge(req, url, guildId, 'invalid_token', 'Clé MCP invalide ou inactive'));
        json(res, 401, { error: 'Clé MCP invalide ou inactive' });
        return true;
      }

      permissions = mcpKey.permissions;
      keyId = mcpKey.id;
      mcpLog(req, 'mcp_bearer_valid', { guildId, keyId, tokenKind: rawKey.startsWith('mcp_') ? 'mcp_key' : 'oauth_jwt', method: jsonRpcMethod(parsedBody), permissions });
    } else if (basicCredentials) {
      const mcpKey = await verifyMcpKeyByClientCredentials(basicCredentials.clientId, basicCredentials.clientSecret, guildId, client);
      if (!mcpKey) {
        mcpLog(req, 'mcp_basic_invalid', { guildId, clientId: basicCredentials.clientId });
        res.setHeader('WWW-Authenticate', authChallenge(req, url, guildId, 'invalid_token', 'Client MCP invalide ou inactif'));
        json(res, 401, { error: 'Client MCP invalide ou inactif' });
        return true;
      }

      permissions = mcpKey.permissions;
      keyId = mcpKey.id;
      mcpLog(req, 'mcp_basic_valid', { guildId, keyId, method: jsonRpcMethod(parsedBody), permissions });
    }

    if (keyId && !checkRateLimit(keyId)) {
      json(res, 429, { error: 'Trop de requêtes (100 req/min max)' });
      return true;
    }

    // Unauthenticated POST with no JSON-RPC method (probe/empty body): return 401 instead of 415/400.
    if (!keyId && method === 'POST' && !jsonRpcMethod(parsedBody)) {
      mcpLog(req, 'mcp_probe_no_auth', { guildId }, 'warn');
      res.setHeader('WWW-Authenticate', authChallenge(req, url, guildId));
      json(res, 401, { error: 'authorization_required', error_description: 'Authentification requise' });
      return true;
    }

    const server = new McpServer({ name: 'kotbo', version: '1.0.0' });
    registerMcpTools(server, guildId, permissions, client, {
      listAllTools: !directToken && !rawKey && !basicCredentials,
      wwwAuthenticate: directToken ? undefined : authChallenge(req, url, guildId, 'insufficient_scope', 'Autorisation MCP Kotbo requise'),
      securitySchemes: directToken ? [{ type: 'noauth' }] : undefined,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const previousAccept = normalizeMcpTransportAcceptHeader(req, method);
    if (previousAccept !== null) {
      mcpLog(req, 'mcp_accept_header_patched', {
        guildId,
        keyId,
        method: jsonRpcMethod(parsedBody),
        previousAccept,
        accept: req.headers.accept,
      });
    }
    const previousContentType = normalizeMcpTransportContentTypeHeader(req, method, parsedBody);
    if (previousContentType !== null) {
      mcpLog(req, 'mcp_content_type_header_patched', {
        guildId,
        keyId,
        method: jsonRpcMethod(parsedBody),
        previousContentType,
        contentType: req.headers['content-type'],
      });
    }

    if (jsonRpcMethod(parsedBody) === 'initialize') {
      mcpLog(req, 'mcp_initialize_compat', {
        guildId,
        keyId,
        protocolVersion: initializeProtocolVersion(parsedBody),
        clientInfo: initializeClientInfo(parsedBody),
      });
      sendInitializeCompat(parsedBody, res);
      mcpLog(req, 'mcp_jsonrpc_response', { guildId, keyId, method: jsonRpcMethod(parsedBody), statusCode: res.statusCode });
      return true;
    }

    try {
      await server.connect(transport);
      mcpLog(req, 'mcp_jsonrpc_request', { guildId, keyId, method: jsonRpcMethod(parsedBody) });
      await handleTransportRequestWithCompat(transport, server, req, res, parsedBody);
      mcpLog(req, 'mcp_jsonrpc_response', { guildId, keyId, method: jsonRpcMethod(parsedBody), statusCode: res.statusCode });
    } catch (error) {
      mcpLog(req, 'mcp_jsonrpc_error', {
        guildId,
        keyId,
        method: jsonRpcMethod(parsedBody),
        error: error instanceof Error ? error.message : String(error),
      }, 'error');
      throw error;
    }
    return true;
  }

  return false;
}
