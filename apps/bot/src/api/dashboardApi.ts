import { errorCode } from '../utils/errors.js';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Client } from 'discord.js';

import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  json,
  getDiscordClientId,
  getDashboardOrigin,
  CORS_EXTRA_ORIGINS,
  isKotboPublicOrigin,
  splitPath,
  parseDiscordMarkdown,
  extractMediaUrls,
  configRateLimiter,
  errorReportRateLimiter,
  feedbackReportRateLimiter,
  partnershipRateLimiter,
  dashboardWriteRateLimiter,
  dashboardSensitiveRateLimiter,
  rankCardPreviewRateLimiter,
  setDashboardStateBroadcaster,
  setDashboardEventBroadcaster,
  collectShardGuilds,
  type DashboardEvent,
  type DashboardSanctionType,
  BunServerResponse,
} from './shared.js';
import { getDashboardSession, sessionIdFromCookieHeader } from './auth/sessionStore.js';
import { getCurrentInstance } from '../utils/instanceContext.js';
import { getAllInstances } from '../utils/instanceResolver.js';

// Modular Route Handlers (legacy - maintenu pendant la migration progressive)
import { handlePublicRoutes } from './routes/public.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleReportErrorRoute } from './routes/error.js';
import { handleReportFeedbackRoute } from './routes/feedback.js';
import { handlePartnershipRoute } from './routes/partnership.js';
import { handleUserRoutes } from './routes/user.js';
import { handleAdminRoutes } from './routes/admin.js';
import { startBroadcastScheduler } from '../services/system/broadcastService.js';
import { handleDashboardRoutes } from './routes/dashboard.js';
import { handleVerifyRoutes } from './routes/verify.js';
import { handleMCPRoutes, mcpRateLimiter } from './mcp/mcpServer.js';

// Hono - nouveau routeur typé (migration progressive)
import { createHonoApp } from './hono/app.js';

export type { DashboardSanctionType };

export async function notifyDashboardSanctionReportRequired(params: {
  guildId: string;
  sanctionId: string;
  sanctionType: DashboardSanctionType;
  targetTag: string;
  moderatorTag: string;
}) {
  const details = [
    `Sanction ${params.sanctionType} appliquée à ${params.targetTag}.`,
    `Rapport à compléter pour ${params.moderatorTag}.`,
    `ID sanction: ${params.sanctionId}.`,
  ].join(' ');

  await prisma.dashboardAuditLog.create({
    data: {
      guildId: params.guildId,
      user: params.moderatorTag,
      action: 'Rapport de sanction requis',
      context: `Sanction ${params.sanctionType}`,
      module: 'Sanctions',
      eventType: 'Action requise',
      details,
      dateIso: new Date(),
    },
  });

  const broadcaster = (globalThis as unknown as Record<string, unknown>).KOTBO_WS_BROADCASTER;
  if (typeof broadcaster === 'function') {
    (broadcaster as (guildId: string, reason: string) => void)(params.guildId, 'sanction_report_required');
  }
}

interface WebSocketData {
  isAuthenticated: boolean;
  userId?: string;
}

export const startDashboardApi = async (client: Client) => {
  const instance = getCurrentInstance();
  const port = instance.apiPort;
  const strictOAuthConfig = process.env.DASHBOARD_OAUTH_STRICT === 'true';

  // Instancie l'app Hono (nouveau routeur typé)
  const honoApp = createHonoApp(client);

  const clientId = getDiscordClientId();
  const missingOAuthAtStartup = (() => {
    const missing: string[] = [];
    if (!clientId?.trim()) missing.push('DISCORD_CLIENT_ID');
    if (!instance.discordRedirectUri && !process.env.DISCORD_REDIRECT_URI?.trim()) missing.push('DISCORD_REDIRECT_URI');
    if (!instance.discordClientSecret?.trim()) missing.push('DISCORD_CLIENT_SECRET');
    return missing;
  })();

  if (missingOAuthAtStartup.length > 0) {
    const message = `Configuration OAuth invalide: variables manquantes (${missingOAuthAtStartup.join(', ')})`;
    if (strictOAuthConfig) {
      logger.error('DashboardAPI', message);
      throw new Error(message);
    }

    logger.warn('DashboardAPI', `${message}. Les routes OAuth renverront une erreur tant que ces variables ne sont pas définies.`);
  }

  const broadcastDashboardEventLocal = (event: DashboardEvent) => {
    server.publish(
      'authenticated-dashboard',
      JSON.stringify({ at: new Date().toISOString(), ...event }),
    );
  };

  const broadcastDashboardStateChangeLocal = (guildId: string, reason: string) => {
    broadcastDashboardEventLocal({ type: 'dashboard_state_changed', guildId, reason });
  };

  setDashboardStateBroadcaster(broadcastDashboardStateChangeLocal);
  setDashboardEventBroadcaster(broadcastDashboardEventLocal);
  (globalThis as unknown as Record<string, unknown>).KOTBO_WS_BROADCASTER = broadcastDashboardStateChangeLocal;
  // Point d'entree des diffusions venues des autres shards, qui n'ont pas de
  // serveur WebSocket a eux (voir `broadcastDashboardEventAcrossShards`).
  (globalThis as unknown as Record<string, unknown>).KOTBO_WS_EVENT_BROADCASTER = broadcastDashboardEventLocal;

  // Clean up expired entries every 10 minutes
  setInterval(() => {
    const now = Date.now();
    const cleanLimiter = (limiterMap: Map<string, number[]>, windowMs: number) => {
      for (const [ip, timestamps] of limiterMap.entries()) {
        const valid = timestamps.filter(t => now - t < windowMs);
        if (valid.length === 0) {
          limiterMap.delete(ip);
        } else {
          limiterMap.set(ip, valid);
        }
      }
    };
    cleanLimiter(configRateLimiter, 60 * 1000);
    cleanLimiter(errorReportRateLimiter, 15 * 60 * 1000);
    cleanLimiter(feedbackReportRateLimiter, 15 * 60 * 1000);
    cleanLimiter(partnershipRateLimiter, 60 * 60 * 1000);
    cleanLimiter(mcpRateLimiter, 60 * 1000);
    cleanLimiter(dashboardWriteRateLimiter, 60 * 1000);
    cleanLimiter(dashboardSensitiveRateLimiter, 60 * 1000);
    cleanLimiter(rankCardPreviewRateLimiter, 60 * 1000);
  }, 10 * 60 * 1000).unref();

  // Annonces globales programmees : le planificateur vit dans le processus qui
  // porte l'API, seul endroit qui dispose a la fois du client Discord et de la
  // base. L'etat etant persiste, un redemarrage ne perd aucune annonce.
  startBroadcastScheduler(client, collectShardGuilds);

  const startServer = (listenPort: number) => Bun.serve<WebSocketData>({
    port: listenPort,
    reusePort: true,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);

      // WebSocket upgrade (inchangé)
      if (url.pathname === '/api/dashboard/ws') {
        const origin = request.headers.get('origin');
        let allowedOrigin = origin === getDashboardOrigin();
        if (!allowedOrigin && process.env.NODE_ENV !== 'production' && origin) {
          try {
            allowedOrigin = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
          } catch {
            allowedOrigin = false;
          }
        }
        if (!allowedOrigin) return new Response('Origine WebSocket refusée', { status: 403 });

        const session = await getDashboardSession(sessionIdFromCookieHeader(request.headers.get('cookie') ?? undefined));
        if (!session) return new Response('Session WebSocket absente ou expirée', { status: 401 });
        const success = serverInstance.upgrade(request, {
          data: { isAuthenticated: true, userId: session.userId },
        });
        if (success) return undefined;
      }

      // -----------------------------------------------------------------------
      // 1. Routeur Hono (routes migrées vers Zod + OpenAPI)
      //    Si Hono retourne 404, on tombe dans le fallback legacy.
      //    On clone le request pour que le body reste lisible par le legacy handler.
      // -----------------------------------------------------------------------
      try {
        const honoResponse = await honoApp.fetch(request.clone());
        if (honoResponse.status !== 404) {
          return honoResponse;
        }
      } catch (honoErr) {
        logger.error('DashboardAPI', 'Erreur Hono non gérée:', honoErr);
        return new Response(JSON.stringify({ error: 'Erreur interne API' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // -----------------------------------------------------------------------
      // 2. Fallback legacy - handlers non encore migrés vers Hono
      //    Conservé pendant la période de migration progressive.
      // -----------------------------------------------------------------------

      // Convert request standard to IncomingMessage
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = request.method;
      req.url = url.pathname + url.search;
      req.headers = {};
      request.headers.forEach((value, key) => {
        req.headers[key.toLowerCase()] = value;
      });

      const logMsg = (msg: string) => {
        if (process.env.NODE_ENV !== 'production') {
          logger.debug('LegacyAPI', msg);
        }
      };

      const sanitizedPath = url.pathname.replace(/mcp_[a-f0-9]+/gi, 'mcp_[REDACTED]')
        .replace(/kotbo_ac_[A-Za-z0-9_-]+/gi, 'kotbo_ac_[REDACTED]')
        .replace(/kotbo_rt_[A-Za-z0-9_-]+/gi, 'kotbo_rt_[REDACTED]');
      logMsg(`[Legacy] Request: ${request.method} ${sanitizedPath}`);

      let bodyText = '';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
          bodyText = await request.text();
        } catch (err) {
          const errMsg = err instanceof Error ? err.stack || err.message : String(err);
          logMsg(`Body read error: ${errMsg}`);
        }
      }
      req.bodyText = bodyText;

      if (bodyText) {
        req.push(Buffer.from(bodyText, 'utf8'));
      }
      req.push(null);

      return new Promise<Response>((resolve) => {
        const res = new BunServerResponse(req, resolve);

        void (async () => {
          // CORS + sécurité (legacy - géré par Hono middleware pour les routes migrées)
          const isMcpPath = url.pathname.startsWith('/api/mcp/')
            || url.pathname === '/.well-known/oauth-authorization-server'
            || url.pathname.startsWith('/.well-known/oauth-protected-resource/')
            || url.pathname.startsWith('/.well-known/oauth-authorization-server/');

          if (isMcpPath) {
            res.setHeader('Access-Control-Allow-Origin', '*');
          } else {
            const dashboardOrigin = getDashboardOrigin();
            const wlOrigins = getAllInstances().map(i => i.dashboardOrigin);
            const allowedOrigins = new Set([
              dashboardOrigin,
              ...CORS_EXTRA_ORIGINS,
              ...wlOrigins,
              'http://localhost:5173',
              'http://localhost:3000'
            ]);
            const isAllowedDevOrigin = (candidate: string) => {
              try {
                const parsed = new URL(candidate);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
                return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
              } catch { return false; }
            };
            const origin = req.headers.origin;
            const originStr = Array.isArray(origin) ? origin[0] : origin;
            if (originStr) {
              let normalizedOrigin: string;
              try { normalizedOrigin = new URL(originStr).origin; } catch { normalizedOrigin = originStr.replace(/\/$/, ''); }
              if (allowedOrigins.has(normalizedOrigin) || isAllowedDevOrigin(originStr) || isKotboPublicOrigin(originStr)) {
                res.setHeader('Access-Control-Allow-Origin', originStr);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
              } else {
                // Origine non autorisée : ne pas refléter l'origin ni les credentials.
                res.statusCode = 403;
                res.setHeader('Vary', 'Origin');
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'Origine refusée' }));
                return;
              }
            } else {
              res.setHeader('Access-Control-Allow-Origin', dashboardOrigin);
            }
            res.setHeader('Vary', 'Origin');
          }
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, Cache-Control, Pragma, X-Kotbo-API-Key, X-API-Key');
          res.setHeader('Access-Control-Max-Age', '86400');
          // Reponses binaires : sans exposition explicite, le dashboard ne peut
          // pas lire l en-tete qui accompagne l image (aperçu de carte de rang).
          res.setHeader('Access-Control-Expose-Headers', 'X-Rank-Card-Preview');
          res.setHeader('Content-Security-Policy', "default-src 'self';");
          res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
          res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.end();
              return;
            }

            const parts = splitPath(url.pathname);

            // Routes legacy (non encore migrées vers Hono)
            if (await handlePublicRoutes(req, res, parts, url, client)) return;
            if (await handleAuthRoutes(req, res, parts, url, client)) return;
            if (await handleVerifyRoutes(req, res, parts, url, client)) return;
            if (await handleReportErrorRoute(req, res, parts, url, client)) return;
            if (await handleReportFeedbackRoute(req, res, parts, url, client)) return;
            if (await handlePartnershipRoute(req, res, parts, url, client)) return;
            if (await handleUserRoutes(req, res, parts, url, client)) return;
            if (await handleAdminRoutes(req, res, parts, url, client)) return;
            if (await handleMCPRoutes(req, res, parts, url, client)) return;
            if (await handleDashboardRoutes(req, res, parts, url, client)) return;

            json(res, 404, { error: 'Route introuvable' });
          } catch (error) {
            logger.error('DashboardAPI', error);
            json(res, 500, { error: 'Erreur interne API dashboard' });
          }
        })();
      });
    },
    websocket: {
      open(ws) {
        ws.subscribe('authenticated-dashboard');
        ws.send(JSON.stringify({ type: 'dashboard_ws_connected', at: new Date().toISOString() }));
      },
      message(ws, messageData) {
        try {
          const raw = typeof messageData === 'string' ? messageData : new TextDecoder().decode(messageData);
          const data = JSON.parse(raw) as { type?: string };
          // Authentication happens during the HTTP upgrade. Keep accepting the
          // old client message as a harmless no-op during the frontend rollout.
          if (data.type === 'auth') return;
        } catch {
          ws.close(4000, 'Payload invalide');
        }
      },
      close(ws) {
        ws.unsubscribe('authenticated-dashboard');
      }
    }
  });

  let server: ReturnType<typeof startServer>;
  try {
    server = startServer(port);
  } catch (err: unknown) {
    if (errorCode(err) === 'EADDRINUSE') {
      logger.warn('DashboardAPI', `Port ${port} occupé, tentative de libération...`);
      try {
        const _proc = Bun.spawnSync(['cmd', '/c', `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`]);
        await new Promise(r => setTimeout(r, 1000));
        server = startServer(port);
      } catch {
        logger.error('DashboardAPI', `Impossible de démarrer le serveur sur le port ${port} - port toujours occupé.`);
        return;
      }
    } else {
      throw err;
    }
  }

  // Diffuser les messages des salons de tickets en temps réel
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot && msg.author.id !== client.user!.id) return;
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { channelId: msg.channelId }
      });
      if (!ticket) return;

      const authorName = msg.member?.displayName || msg.author.displayName || msg.author.username;

      const payload = JSON.stringify({
        type: 'new_ticket_message',
        guildId: ticket.guildId,
        ticketId: ticket.id,
        message: {
          id: msg.id,
          authorId: msg.author.id,
          authorName,
          authorAvatar: msg.author.displayAvatarURL(),
          isStaff: msg.author.bot,
          content: msg.content,
          htmlContent: parseDiscordMarkdown(msg.content, msg.guild || undefined),
          mediaUrls: extractMediaUrls(msg.content),
          stickers: msg.stickers ? msg.stickers.map(s => ({ id: s.id, name: s.name, url: s.url })) : [],
          attachments: msg.attachments.map(a => ({ url: a.url, contentType: a.contentType })),
          embeds: msg.embeds.map(e => ({
            title: e.title,
            description: e.description,
            htmlDescription: e.description ? parseDiscordMarkdown(e.description, msg.guild || undefined) : '',
            color: e.hexColor,
            fields: e.fields ? e.fields.map(f => ({
              name: f.name,
              value: f.value,
              htmlValue: f.value ? parseDiscordMarkdown(f.value, msg.guild || undefined) : ''
            })) : [],
            image: e.image ? { url: e.image.url } : null,
            thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
            video: e.video ? { url: e.video.url } : null
          })),
          createdAt: msg.createdAt.toISOString()
        }
      });

      server.publish('authenticated-dashboard', payload);
    } catch (err) {
      logger.error('DashboardWS', 'Erreur lors de la diffusion du message live du ticket:', err);
    }
  });

  logger.success('DashboardAPI', `API dashboard active sur http://localhost:${port}`);

  return server;
};
