import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { logger } from '../../../utils/logger.js';
import { fetchExternal } from '../../../utils/http.js';
import {
  getMissingOAuthConfig,
  getDiscordClientId,
  getDiscordClientSecret,
  getDiscordRedirectUri,
  getDashboardOrigin,
  getDashboardUrl,
  getJwtSecret,
} from '../../shared.js';
import {
  clearSessionCookies,
  createDashboardSession,
  deleteDashboardSession,
  getDashboardSession,
  makeSessionCookie,
  sessionIdFromCookieHeader,
} from '../../auth/sessionStore.js';

export const authRouter = new OpenAPIHono();

const OAUTH_COOKIE_MAX_AGE = 300;

function cookieSecurity(): string {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

function oauthCookie(name: string, value: string, maxAge = OAUTH_COOKIE_MAX_AGE): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly${cookieSecurity()}; SameSite=Lax; Max-Age=${maxAge}`;
}

function appendCookies(headers: Headers, cookies: string[]): void {
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
}

function clearOAuthCookies(): string[] {
  return ['kotbo_oauth_state', 'kotbo_oauth_verifier', 'kotbo_oauth_return_to'].map((name) =>
    oauthCookie(name, '', 0),
  );
}

function parseCookies(cookieHeader: string): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map((entry) => {
      const [name, ...value] = entry.trim().split('=');
      try {
        return [name, decodeURIComponent(value.join('='))];
      } catch {
        return [name, value.join('=')];
      }
    }),
  );
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function isAllowedMutationOrigin(origin: string | undefined): boolean {
  if (!origin) return process.env.NODE_ENV !== 'production';
  try {
    const normalized = new URL(origin).origin;
    if (normalized === getDashboardOrigin()) return true;
    return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function startDiscordOAuth(c: Context, widget: boolean) {
  const missingOAuth = getMissingOAuthConfig({ includeSecret: true });
  if (missingOAuth.length > 0) {
    return c.json({ error: 'Configuration OAuth invalide côté serveur.', missing: missingOAuth }, 500);
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const returnTo = safeReturnTo(c.req.query('returnTo'));

  appendCookies(c.res.headers, [
    oauthCookie('kotbo_oauth_state', state),
    oauthCookie('kotbo_oauth_verifier', verifier),
    oauthCookie('kotbo_oauth_return_to', returnTo),
  ]);

  const params = new URLSearchParams({
    client_id: getDiscordClientId(),
    redirect_uri: getDiscordRedirectUri(),
    response_type: 'code',
    scope: widget ? 'identify guilds openid sdk.social_layer' : 'identify guilds',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return c.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`, 302);
}

authRouter.get('/api/auth/discord/login', (c) => startDiscordOAuth(c, false));
authRouter.get('/api/auth/discord/widget-login', (c) => startDiscordOAuth(c, true));

authRouter.get('/api/auth/discord/callback', async (c) => {
  const dashboardUrl = getDashboardUrl().replace(/\/$/, '');
  const code = c.req.query('code');
  const state = c.req.query('state');

  // Retour d'une *invitation du bot*, et non d'une connexion.
  //
  // L'ecran d'autorisation d'un bot revient sur la meme adresse que la
  // connexion - une application Discord n'a qu'une liste de redirections, et
  // celle-ci est la seule declaree. Mais il n'y a ni `state` ni verificateur
  // PKCE : ce trajet-la n'a jamais demarre par `startDiscordOAuth`. La garde
  // ci-dessous le prenait donc pour un etat invalide et renvoyait sur
  // `/login`, d'ou la session encore valide ramenait sur `/` - le serveur qui
  // venait d'etre equipe etait perdu en route, et avec lui le parcours de
  // configuration qu'il devait ouvrir.
  //
  // `guild_id` est ce que Discord ajoute a ce retour, et lui seul : il dit
  // *quel* serveur vient de recevoir le bot. On le rend a « Mes serveurs »,
  // qui sait attendre l'arrivee effective du bot puis entrer dedans.
  const installedGuildId = c.req.query('guild_id');
  if (installedGuildId && /^\d{17,20}$/.test(installedGuildId)) {
    return c.redirect(`${dashboardUrl}/servers?installed=${installedGuildId}`, 302);
  }
  const cookies = parseCookies(c.req.header('cookie') ?? '');
  const returnTo = safeReturnTo(cookies.kotbo_oauth_return_to);

  if (!code || !state || !cookies.kotbo_oauth_state || state !== cookies.kotbo_oauth_state || !cookies.kotbo_oauth_verifier) {
    appendCookies(c.res.headers, clearOAuthCookies());
    return c.redirect(`${dashboardUrl}/login?error=invalid_state`, 302);
  }

  try {
    const tokenResponse = await fetchExternal('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: getDiscordClientId(),
        client_secret: getDiscordClientSecret(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: getDiscordRedirectUri(),
        code_verifier: cookies.kotbo_oauth_verifier,
      }),
    });
    const tokenData = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(`Discord token exchange failed: ${tokenData.error ?? tokenResponse.status}`);
    }

    const userResponse = await fetchExternal('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userResponse.json() as {
      id?: string;
      username?: string;
      avatar?: string | null;
    };
    if (!userResponse.ok || !user.id || !user.username) throw new Error('Discord user fetch failed');

    const session = await createDashboardSession({
      userId: user.id,
      username: user.username,
      avatar: user.avatar ?? null,
      discordAccessToken: tokenData.access_token,
      discordRefreshToken: tokenData.refresh_token ?? null,
      discordExpiresIn: tokenData.expires_in ?? 604800,
    });

    appendCookies(c.res.headers, [...clearOAuthCookies(), makeSessionCookie(session.id)]);
    return c.redirect(`${dashboardUrl}${returnTo === '/' ? '/' : returnTo}`, 302);
  } catch (error) {
    logger.error('Auth', 'OAuth authorization-code callback error:', error);
    appendCookies(c.res.headers, clearOAuthCookies());
    return c.redirect(`${dashboardUrl}/login?error=auth_failed`, 302);
  }
});

authRouter.get('/api/auth/session', async (c) => {
  const sessionId = sessionIdFromCookieHeader(c.req.header('cookie'));
  const session = await getDashboardSession(sessionId);
  if (!session) return c.json({ authenticated: false }, 401);
  return c.json({
    authenticated: true,
    user: { id: session.userId, username: session.username, avatar: session.avatar },
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
});

authRouter.post('/api/auth/migrate', async (c) => {
  if (!isAllowedMutationOrigin(c.req.header('origin'))) return c.json({ error: 'Origine refusée' }, 403);
  const legacyUntil = process.env.AUTH_LEGACY_BEARER_UNTIL;
  const cutoff = legacyUntil ? (/^\d+$/.test(legacyUntil) ? Number(legacyUntil) : Date.parse(legacyUntil)) : 0;
  if (!Number.isFinite(cutoff) || Date.now() >= cutoff) {
    return c.json({ error: 'Migration des anciennes sessions terminée' }, 410);
  }

  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return c.json({ error: 'Ancienne session absente' }, 401);
  try {
    const claims = jwt.verify(authorization.slice(7), getJwtSecret()) as {
      userId?: string;
      username?: string;
      avatar?: string | null;
      discordToken?: string;
      exp?: number;
    };
    if (!claims.userId || !claims.username || !claims.discordToken) throw new Error('Claims incomplets');
    const expiresIn = claims.exp ? Math.max(60, claims.exp - Math.floor(Date.now() / 1000)) : 3600;
    const session = await createDashboardSession({
      userId: claims.userId,
      username: claims.username,
      avatar: claims.avatar ?? null,
      discordAccessToken: claims.discordToken,
      discordExpiresIn: expiresIn,
    });
    appendCookies(c.res.headers, [makeSessionCookie(session.id)]);
    return c.json({ success: true });
  } catch {
    return c.json({ error: 'Ancienne session invalide ou expirée' }, 401);
  }
});

authRouter.post('/api/auth/logout', async (c) => {
  if (!isAllowedMutationOrigin(c.req.header('origin'))) return c.json({ error: 'Origine refusée' }, 403);
  const sessionId = sessionIdFromCookieHeader(c.req.header('cookie'));
  await deleteDashboardSession(sessionId);
  appendCookies(c.res.headers, clearSessionCookies());
  return c.json({ success: true });
});
