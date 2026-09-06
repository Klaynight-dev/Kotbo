import type { MiddlewareHandler } from 'hono';
import { getDashboardOrigin, CORS_EXTRA_ORIGINS, isKotboPublicOrigin } from '../../shared.js';
import { getAllInstances } from '../../../utils/instanceResolver.js';

/** Vérifie si un origin est en localhost (développement) */
function isAllowedDevOrigin(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Middleware CORS centralisé pour toutes les routes dashboard.
 * Construit la whitelist dynamiquement à partir de l'instance courante
 * et de toutes les instances white-label.
 */
export function dashboardCors(): MiddlewareHandler {
  return async (c, next) => {
    const isMcpPath =
      c.req.path.startsWith('/api/mcp/') ||
      c.req.path === '/.well-known/oauth-authorization-server' ||
      c.req.path.startsWith('/.well-known/oauth-protected-resource/') ||
      c.req.path.startsWith('/.well-known/oauth-authorization-server/');

    // Les apercus de liens (Open Graph) sont lus par les robots de Discord,
    // Slack ou X : ils n'envoient pas d'`Origin` et leurs CDN rechargent les
    // images depuis leurs propres domaines. La whitelist du dashboard n'a donc
    // aucun sens ici - comme pour MCP, l'acces est public par nature.
    const isOgPath = c.req.path.startsWith('/api/og/');

    if (isMcpPath || isOgPath) {
      c.header('Access-Control-Allow-Origin', '*');
    } else {
      const dashboardOrigin = getDashboardOrigin();
      const wlOrigins = getAllInstances().map((i) => i.dashboardOrigin);
      const allowedOrigins = new Set([
        dashboardOrigin,
        ...CORS_EXTRA_ORIGINS,
        ...wlOrigins,
        'http://localhost:5173',
        'http://localhost:3000',
      ]);

      const origin = c.req.header('origin');
      if (origin) {
        let normalizedOrigin: string;
        try {
          normalizedOrigin = new URL(origin).origin;
        } catch {
          normalizedOrigin = origin.replace(/\/$/, '');
        }
        if (allowedOrigins.has(normalizedOrigin) || isAllowedDevOrigin(origin) || isKotboPublicOrigin(origin)) {
          c.header('Access-Control-Allow-Origin', origin);
          c.header('Access-Control-Allow-Credentials', 'true');
        } else {
          // Origine non autorisée : ne jamais refléter l'origin ni autoriser les
          // credentials, sinon la whitelist ne protège plus rien.
          c.header('Vary', 'Origin');
          return c.json({ error: 'Origine refusée' }, 403);
        }
      } else {
        c.header('Access-Control-Allow-Origin', dashboardOrigin);
      }
      c.header('Vary', 'Origin');
    }

    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, Cache-Control, Pragma, X-Kotbo-API-Key, X-API-Key');
    c.header('Access-Control-Max-Age', '86400');

    // Sécurité
    c.header('Content-Security-Policy', "default-src 'self';");
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }

    await next();
  };
}
