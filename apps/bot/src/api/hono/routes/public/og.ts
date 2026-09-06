import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../../utils/logger.js';
import { getApiUrl, getDashboardUrl } from '../../../shared.js';
import { getAllInstances } from '../../../../utils/instanceResolver.js';
import { normalizeOgPath, resolveOgMetadata, type OgMetadata } from '../../../../services/system/ogMetadataService.js';
import { tryRenderOgCard } from '../../../../services/system/ogImageService.js';

// ============================================================================
// APERCU DES LIENS POUR LES ROBOTS SOCIAUX
//
// Trois routes, toutes alimentees par le meme resolveur (ogMetadataService) :
//
//   /api/og/preview  page HTML minimale portant les balises Open Graph, servie
//                    aux robots par le proxy du dashboard (cf. nginx.conf) ;
//   /api/og/image    la carte 1200x630 annoncee par ces balises ;
//   /api/og/oembed   la reponse oEmbed pointee par la page, qui ajoute la ligne
//                    « auteur » (le nom du serveur) au-dessus du titre dans
//                    l'embed Discord.
//
// Aucune de ces routes n'est authentifiee : elles ne servent donc jamais autre
// chose que ce que le resolveur a juge public. Les valeurs interpolees dans le
// HTML (nom de serveur, titre de formulaire) viennent d'utilisateurs Discord et
// sont echappees sans exception.
// ============================================================================

const IMAGE_CACHE_SECONDS = 3600;
const PREVIEW_CACHE_SECONDS = 300;

// Un robot social recharge une page en rafale au premier partage, puis plus
// rien. La fenetre est donc large et la limite haute : elle n'existe que pour
// empecher qu'on se serve de la generation d'images comme d'un amplificateur.
const OG_WINDOW_MS = 60_000;
const OG_MAX_PER_WINDOW = 60;
const OG_MAX_TRACKED_CLIENTS = 10_000;
const requestLog = new Map<string, number[]>();

function clientKey(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown';
}

function rateLimited(c: Context): boolean {
  const key = clientKey(c);
  const now = Date.now();
  const hits = (requestLog.get(key) ?? []).filter((at) => now - at < OG_WINDOW_MS);
  hits.push(now);
  requestLog.set(key, hits);

  if (requestLog.size > OG_MAX_TRACKED_CLIENTS) {
    for (const [tracked, timestamps] of requestLog) {
      if (timestamps.every((at) => now - at >= OG_WINDOW_MS)) requestLog.delete(tracked);
      if (requestLog.size <= OG_MAX_TRACKED_CLIENTS) break;
    }
  }

  return hits.length > OG_MAX_PER_WINDOW;
}

/**
 * Echappement HTML.
 *
 * Les titres de formulaires et les noms de serveurs sont saisis par des
 * utilisateurs Discord : sans cet echappement, un serveur nomme
 * `"><script>` reecrirait la page servie aux robots.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Origine du dashboard a annoncer comme URL canonique.
 *
 * En marque blanche, plusieurs dashboards partagent la meme API : on suit
 * l'hote transmis par le proxy, mais uniquement s'il correspond a une instance
 * connue. Sinon la page canoniserait vers l'hote que l'appelant a choisi.
 */
function resolveDashboardOrigin(c: Context): string {
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) {
    for (const instance of getAllInstances()) {
      try {
        if (new URL(instance.dashboardOrigin).host === forwardedHost) return instance.dashboardOrigin;
      } catch {
        // Instance mal configuree : on ignore et on retombe sur le defaut.
      }
    }
  }
  return getDashboardUrl().replace(/\/$/, '');
}

/**
 * Origine publique de l'API, telle que le robot vient de l'atteindre.
 *
 * On lit l'hote reellement contacte (`Host`), pas `X-Forwarded-Host` : quand la
 * requete arrive par le proxy du dashboard, ce dernier en-tete porte l'hote du
 * DASHBOARD, qui ne sait pas servir les images de carte.
 */
function resolveApiOrigin(c: Context): string {
  try {
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
    return `${proto}://${url.host}`;
  } catch {
    return getApiUrl();
  }
}

function metaTag(property: string, content: string, kind: 'property' | 'name' = 'property'): string {
  return `    <meta ${kind}="${property}" content="${escapeHtml(content)}" />`;
}

/**
 * Page servie aux robots.
 *
 * Elle n'a pas vocation a etre lue par un humain : si un navigateur y atterrit
 * malgre le filtrage du proxy, un rafraichissement le renvoie immediatement sur
 * la vraie page du dashboard. Le corps reste rempli pour les lecteurs qui
 * n'executent pas de script.
 */
export function renderPreviewHtml(meta: OgMetadata, canonicalUrl: string, apiOrigin: string): string {
  const imageUrl = meta.imagePath ? `${apiOrigin}${meta.imagePath}` : null;
  const oembedUrl = `${apiOrigin}/api/og/oembed?url=${encodeURIComponent(canonicalUrl)}`;

  const tags = [
    metaTag('og:site_name', meta.siteName),
    metaTag('og:title', meta.title),
    metaTag('og:description', meta.description),
    metaTag('og:url', canonicalUrl),
    metaTag('og:type', meta.ogType),
    metaTag('og:locale', meta.locale === 'fr' ? 'fr_FR' : 'en_US'),
    metaTag('description', meta.description, 'name'),
    metaTag('robots', meta.robots, 'name'),
    // Discord colore la barre laterale de l'embed avec `theme-color`.
    metaTag('theme-color', meta.themeColor, 'name'),
    metaTag('twitter:card', imageUrl ? 'summary_large_image' : 'summary', 'name'),
    metaTag('twitter:title', meta.title, 'name'),
    metaTag('twitter:description', meta.description, 'name'),
  ];

  if (imageUrl) {
    tags.push(
      metaTag('og:image', imageUrl),
      metaTag('og:image:secure_url', imageUrl),
      metaTag('og:image:type', 'image/png'),
      metaTag('og:image:width', '1200'),
      metaTag('og:image:height', '630'),
      metaTag('og:image:alt', meta.imageAlt),
      metaTag('twitter:image', imageUrl, 'name'),
    );
  }

  return `<!doctype html>
<html lang="${meta.locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)}</title>
${tags.join('\n')}
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${escapeHtml(meta.title)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(canonicalUrl)}" />
  </head>
  <body>
    <h1>${escapeHtml(meta.title)}</h1>
    <p>${escapeHtml(meta.description)}</p>
    <p><a href="${escapeHtml(canonicalUrl)}">${escapeHtml(canonicalUrl)}</a></p>
  </body>
</html>
`;
}

export function createOgRouter(client: Client): OpenAPIHono {
  const router = new OpenAPIHono();

  // -------------------------------------------------------------------------
  // GET /api/og/preview?path=/form/xxx
  // -------------------------------------------------------------------------
  router.get('/api/og/preview', async (c) => {
    if (rateLimited(c)) return c.json({ error: 'Trop de requêtes' }, 429);

    const path = normalizeOgPath(c.req.query('path') ?? c.req.header('x-original-uri'));
    const meta = await resolveOgMetadata(client, path);
    const canonicalUrl = `${resolveDashboardOrigin(c)}${path === '/' ? '/' : path}`;
    const html = renderPreviewHtml(meta, canonicalUrl, resolveApiOrigin(c));

    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', `public, max-age=${PREVIEW_CACHE_SECONDS}`);
    // La page est une redirection habillee : elle ne doit jamais etre encadree.
    c.header('X-Robots-Tag', meta.robots);
    return c.body(html);
  });

  // -------------------------------------------------------------------------
  // GET /api/og/image?path=/form/xxx&v=...
  //
  // `v` ne sert qu'a invalider les CDN : la carte elle-meme est identifiee par
  // la cle de cache que le resolveur a calculee a partir des donnees.
  // -------------------------------------------------------------------------
  router.get('/api/og/image', async (c) => {
    if (rateLimited(c)) return c.json({ error: 'Trop de requêtes' }, 429);

    const path = normalizeOgPath(c.req.query('path'));
    const meta = await resolveOgMetadata(client, path);
    if (!meta.card) return c.json({ error: 'Aucune carte pour cette page' }, 404);

    const etag = `"og-${Buffer.from(meta.card.cacheKey).toString('base64url')}"`;
    // L'`Access-Control-Allow-Origin: *` est pose par le middleware CORS pour
    // tout `/api/og/` ; il reste a autoriser le chargement cross-origin de la
    // ressource elle-meme, que les CDN sociaux servent depuis leur domaine.
    const imageHeaders = {
      'Cache-Control': `public, max-age=${IMAGE_CACHE_SECONDS}`,
      ETag: etag,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: imageHeaders });
    }

    const png = await tryRenderOgCard(meta.card);
    if (!png) return c.json({ error: 'Rendu indisponible' }, 503);

    return new Response(new Uint8Array(png), {
      status: 200,
      headers: { ...imageHeaders, 'Content-Type': 'image/png' },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/og/oembed?url=https://dash.../form/xxx
  //
  // Discord lit `author_name` et l'affiche AU-DESSUS du titre : c'est la seule
  // façon d'obtenir le nom du serveur en tete de l'embed.
  // -------------------------------------------------------------------------
  router.get('/api/og/oembed', async (c) => {
    if (rateLimited(c)) return c.json({ error: 'Trop de requêtes' }, 429);

    const raw = c.req.query('url');
    if (!raw) return c.json({ error: 'Paramètre url manquant' }, 400);

    // On ne decrit que nos propres pages : sans ce controle, l'endpoint servirait
    // de fournisseur oEmbed pour n'importe quelle URL.
    const knownOrigins = new Set([
      getDashboardUrl().replace(/\/$/, ''),
      ...getAllInstances().map((instance) => instance.dashboardOrigin),
    ]);
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return c.json({ error: 'URL invalide' }, 400);
    }
    if (!knownOrigins.has(target.origin)) {
      return c.json({ error: 'URL hors du domaine' }, 400);
    }

    const meta = await resolveOgMetadata(client, target.pathname);
    const apiOrigin = resolveApiOrigin(c);

    c.header('Cache-Control', `public, max-age=${PREVIEW_CACHE_SECONDS}`);
    return c.json({
      version: '1.0',
      type: 'link',
      provider_name: meta.siteName,
      provider_url: getDashboardUrl().replace(/\/$/, ''),
      title: meta.title,
      author_name: meta.authorName ?? meta.siteName,
      author_url: target.toString(),
      ...(meta.imagePath
        ? {
            thumbnail_url: `${apiOrigin}${meta.imagePath}`,
            thumbnail_width: 1200,
            thumbnail_height: 630,
          }
        : {}),
    });
  });

  logger.debug('OpenGraph', 'Routes /api/og/* enregistrées');
  return router;
}
