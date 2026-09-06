/**
 * Point d'entrée des événements de la landing.
 *
 * kotbo.fr est un site statique servi par Cloudflare : il n'a pas de serveur à
 * lui. C'est donc ici qu'arrive ce qu'il observe - une page vue, une section
 * tarifs réellement affichée, un clic sur « Ajouter le bot ». Sans ce point de
 * collecte, le tunnel commencerait à l'arrivée du bot, c'est-à-dire aux seuls
 * gagnants.
 *
 * ── Une route ouverte à Internet, traitée comme telle ───────────────────────
 *
 * Personne n'est authentifié ici, et il n'y a rien à authentifier : le visiteur
 * n'a pas de compte. Trois garde-fous en découlent, et aucun n'est facultatif :
 *
 *   1. `isPublicAcquisitionStep` restreint ce qui peut être déclaré à l'amont
 *      du tunnel. Sans ce filtre, n'importe qui posterait `first_payment` en
 *      boucle et rendrait les revenus fantaisistes.
 *   2. Le corps est plafonné et chaque champ tronqué : ces valeurs viennent du
 *      navigateur, donc de n'importe où.
 *   3. Limitation par IP, pour qu'un script ne remplisse pas la table.
 *
 * ── Ce que la route ne fait pas ─────────────────────────────────────────────
 *
 * Elle ne journalise pas l'adresse IP, pas même tronquée, et ne pose aucun
 * cookie. C'est une condition de l'exemption de consentement dont bénéficie la
 * mesure d'audience (voir la page /cookies du site) : la lever ici obligerait à
 * afficher une bannière sur tout le site.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  ACQUISITION_REFERRERS,
  isPublicAcquisitionStep,
  normalizeAcquisitionSource,
  type AcquisitionReferrer,
} from '@kotbo/contracts';
import { rateLimit } from '../../middleware/rateLimit.js';
import { funnelRateLimiter } from '../../../limiters.js';
import { trackAcquisitionStep } from '../../../../services/analytics/acquisitionService.js';

/**
 * Taille maximale du corps accepté.
 *
 * Un événement du tunnel tient en deux cents octets. Mille suffisent largement,
 * et refuser au-delà évite d'avoir à lire ce qu'on n'utilisera pas.
 */
const MAX_BODY_BYTES = 1_024;

/** Longueur maximale de chaque champ court, après quoi on tronque. */
const FIELD_MAX = 64;
/** Le chemin d'une page peut être plus long, sans être illimité. */
const PATH_MAX = 200;

function field(value: unknown, max = FIELD_MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

const REFERRER_SET = new Set<string>(ACQUISITION_REFERRERS);

/**
 * Le canal est classé par la landing, jamais ici : c'est elle qui voit le
 * référent, et elle n'en transmet que la catégorie. On se contente donc de
 * vérifier que la valeur reçue en fait bien partie - une URL complète arrivant
 * dans ce champ serait le signe d'un bug côté site, et on la refuse plutôt que
 * de la stocker.
 */
function referrer(value: unknown): AcquisitionReferrer | null {
  const candidate = field(value);
  return candidate && REFERRER_SET.has(candidate) ? (candidate as AcquisitionReferrer) : null;
}

export function createPublicFunnelRouter(): OpenAPIHono {
  const router = new OpenAPIHono();

  // Trente événements par minute et par adresse : une visite normale en produit
  // trois ou quatre, un onglet laissé ouvert n'en produit plus aucun.
  router.use(
    '/api/public/funnel',
    rateLimit(funnelRateLimiter, 30, 60_000, 'Trop de mesures envoyées.'),
  );

  // POST /api/public/funnel
  //
  // Répond toujours 204, y compris quand l'événement est ignoré. Le site n'a
  // rien à faire de la réponse - il envoie par `sendBeacon`, qui ne la lit
  // jamais - et détailler ce qui a été refusé n'aiderait qu'à chercher la
  // faille. Une mesure perdue n'a aucune conséquence pour le visiteur.
  router.post('/api/public/funnel', async (c) => {
    const raw = await c.req.text().catch(() => '');
    if (!raw || raw.length > MAX_BODY_BYTES) return c.body(null, 204);

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.body(null, 204);
      payload = parsed as Record<string, unknown>;
    } catch {
      return c.body(null, 204);
    }

    const step = field(payload.step);
    if (!isPublicAcquisitionStep(step)) return c.body(null, 204);

    const metadata: Record<string, unknown> = {};
    const from = referrer(payload.referrer);
    if (from) metadata.referrer = from;
    const path = field(payload.path, PATH_MAX);
    if (path) metadata.path = path;

    trackAcquisitionStep({
      step,
      visitorId: field(payload.visitorId),
      // Une page de la landing déclare toujours `landing` ; on normalise quand
      // même, le corps venant du navigateur.
      source: normalizeAcquisitionSource(payload.source ?? 'landing'),
      campaign: field(payload.campaign),
      content: field(payload.content),
      metadata: Object.keys(metadata).length ? metadata : null,
    });

    return c.body(null, 204);
  });

  return router;
}
