import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

// La page de vérification résout la langue du serveur, ce qui passe par le cache
// Redis puis la base. Sans ce mock le test compose la vraie infrastructure : il
// n'est plus hors-ligne et il expire dès que la connexion traîne.
const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const cacheJsPath = path.resolve(import.meta.dir, '../../utils/cache.js');
// Seule la lecture de configuration est neutralisée : le reste du module garde
// ses exports réels, dont d'autres modules dépendent.
const cacheStub = { ...(await import('../../utils/cache.js')), getCachedGuild: async () => null };
mock.module(cachePath, () => cacheStub);
mock.module(cacheJsPath, () => cacheStub);

const { normalizeOgPath, resolveOgMetadata } = await import('../../services/system/ogMetadataService.js');
const { escapeHtml, renderPreviewHtml } = await import('../../api/hono/routes/public/og.js');
const { normalizeAccent, renderOgCard } = await import('../../services/system/ogImageService.js');

// Les chemins testés ici (dashboard, page inconnue) sont résolus sans toucher à
// la base : un client Discord vide suffit, et le test reste hors-ligne.
const emptyClient = { guilds: { cache: new Map() }, users: { fetch: async () => null } } as unknown as Client;

// Le rendu d'une carte compose une image 1200x630 : quelques secondes par appel,
// et bien davantage quand la suite tourne en parallèle. Les scripts de test
// relèvent déjà le délai global ; ce plafond garde le fichier exécutable seul,
// où bun coupe à 5 s.
const RENDER_TIMEOUT_MS = 30_000;

describe('normalizeOgPath', () => {
  test('accepte un chemin simple et retire le slash final', () => {
    expect(normalizeOgPath('/form/abc')).toBe('/form/abc');
    expect(normalizeOgPath('/form/abc/')).toBe('/form/abc');
    expect(normalizeOgPath('/')).toBe('/');
  });

  test('ne garde que le chemin d\'une URL complète', () => {
    expect(normalizeOgPath('https://dash.kotbo.fr/transcripts/xyz?a=1#z')).toBe('/transcripts/xyz');
  });

  test('coupe la query et le fragment', () => {
    expect(normalizeOgPath('/form/abc?token=secret')).toBe('/form/abc');
    expect(normalizeOgPath('/form/abc#section')).toBe('/form/abc');
  });

  test('refuse une traversée de chemin', () => {
    // Le chemin sert de clé de routage : une traversée n'y a aucun sens et
    // brouillerait la correspondance de routes.
    expect(normalizeOgPath('/form/../../etc/passwd')).toBe('/');
  });

  test('remet un slash initial et borne la longueur', () => {
    expect(normalizeOgPath('form/abc')).toBe('/form/abc');
    expect(normalizeOgPath(`/${'a'.repeat(2000)}`).length).toBe(512);
  });

  test('retombe sur la racine pour une entrée vide ou illisible', () => {
    expect(normalizeOgPath(null)).toBe('/');
    expect(normalizeOgPath('')).toBe('/');
    expect(normalizeOgPath('http://[invalide')).toBe('/');
  });
});

describe('resolveOgMetadata - pages du dashboard', () => {
  test('nomme la section plutôt que le dashboard entier', async () => {
    const meta = await resolveOgMetadata(emptyClient, '/security/sanctions');
    expect(meta.title).toContain('Sanctions');
    expect(meta.card?.title).toContain('Sanctions');
  });

  test('le préfixe le plus long gagne', async () => {
    // Sans ce tri, `/security` capterait `/security/anti-raid` et l'embed
    // annoncerait la mauvaise page.
    const overview = await resolveOgMetadata(emptyClient, '/security');
    const antiRaid = await resolveOgMetadata(emptyClient, '/security/anti-raid');
    expect(overview.title).not.toBe(antiRaid.title);
    expect(antiRaid.title).toContain('Anti-raid');
  });

  test('un espace d\'administration ne doit jamais être indexé', async () => {
    const meta = await resolveOgMetadata(emptyClient, '/members');
    expect(meta.robots).toBe('noindex, nofollow');
  });

  test('une page inconnue garde un aperçu de marque', async () => {
    const meta = await resolveOgMetadata(emptyClient, '/route-qui-nexiste-pas');
    expect(meta.title).toBeTruthy();
    expect(meta.card).not.toBeNull();
  });
});

describe('resolveOgMetadata - ressources protégées', () => {
  test('une pièce de dossier de sanction ne décrit que sa nature', async () => {
    const meta = await resolveOgMetadata(emptyClient, '/sanction-evidence/abc123');
    expect(meta.robots).toBe('noindex, nofollow');
    // La carte doit parler d'accès restreint, pas du dossier lui-même.
    expect(meta.card?.art?.type).toBe('redactedChat');
    expect(meta.description.toLowerCase()).toContain('sanction');
  });

  test('un lien de vérification ne dépend pas de son jeton', async () => {
    // Deux jetons différents pour un même serveur doivent produire la même
    // carte : sinon le jeton se retrouverait dans une URL d'image publique.
    const a = await resolveOgMetadata(emptyClient, '/verify/123456789012345678/jeton-a');
    const b = await resolveOgMetadata(emptyClient, '/verify/123456789012345678/jeton-b');
    expect(a.imagePath).toBe(b.imagePath!);
    expect(a.imagePath).not.toContain('jeton');
    expect(a.robots).toBe('noindex, nofollow');
  });
});

describe('escapeHtml', () => {
  test('neutralise une injection dans un nom de serveur', () => {
    const hostile = '"><script>alert(1)</script>';
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('renderPreviewHtml', () => {
  const meta = {
    title: 'Formulaire "candidature"',
    description: 'Une <description> & un test',
    imagePath: '/api/og/image?path=%2Fform%2Fabc',
    imageAlt: 'Carte',
    themeColor: '#a8c8ff',
    siteName: 'Kotbo',
    authorName: 'Les nerds',
    ogType: 'website' as const,
    robots: 'index, follow' as const,
    locale: 'fr' as const,
    card: null,
  };

  test('porte les balises attendues par Discord', () => {
    const html = renderPreviewHtml(meta, 'https://dash.kotbo.fr/form/abc', 'https://api.kotbo.fr');
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta property="og:image" content="https://api.kotbo.fr/api/og/image');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    // La couleur de la barre latérale de l'embed vient de `theme-color`.
    expect(html).toContain('<meta name="theme-color" content="#a8c8ff"');
    // oEmbed : c'est ce qui fait apparaître le nom du serveur au-dessus du titre.
    expect(html).toContain('type="application/json+oembed"');
    expect(html).toContain('<link rel="canonical" href="https://dash.kotbo.fr/form/abc"');
  });

  test('échappe titre et description', () => {
    const html = renderPreviewHtml(meta, 'https://dash.kotbo.fr/form/abc', 'https://api.kotbo.fr');
    expect(html).toContain('Formulaire &quot;candidature&quot;');
    expect(html).toContain('Une &lt;description&gt; &amp; un test');
    expect(html).not.toContain('<description>');
  });

  test('retombe sur une carte simple sans image', () => {
    const html = renderPreviewHtml({ ...meta, imagePath: null }, 'https://dash.kotbo.fr/x', 'https://api.kotbo.fr');
    expect(html).toContain('content="summary"');
    expect(html).not.toContain('og:image');
  });
});

describe('normalizeAccent', () => {
  test('accepte les formes hexadécimales', () => {
    expect(normalizeAccent('#A8C8FF', '#000000')).toBe('#a8c8ff');
    expect(normalizeAccent('#abc', '#000000')).toBe('#aabbcc');
  });

  test('convertit une couleur rgb() de thème de formulaire', () => {
    expect(normalizeAccent('rgb(168, 200, 255)', '#000000')).toBe('#a8c8ff');
  });

  test('retombe sur la valeur par défaut pour tout le reste', () => {
    expect(normalizeAccent(null, '#a8c8ff')).toBe('#a8c8ff');
    expect(normalizeAccent('javascript:alert(1)', '#a8c8ff')).toBe('#a8c8ff');
    expect(normalizeAccent('url(https://x)', '#a8c8ff')).toBe('#a8c8ff');
  });
});

describe('renderOgCard', () => {
  test('rend un PNG 1200x630 déterministe', async () => {
    const spec = {
      cacheKey: 'test:carte-1',
      kicker: 'Formulaire',
      title: 'Candidature staff',
      subtitle: 'Trois questions, environ 4 minutes.',
      guildName: 'Les nerds',
      badges: ['Ouvert'],
      stats: [{ value: '3', label: 'Questions' }],
      art: { type: 'questions' as const, items: ['Ton pseudo ?', 'Pourquoi toi ?'], more: 1 },
    };

    const first = await renderOgCard(spec);
    // Signature PNG + dimensions lues dans l'en-tête IHDR.
    expect(first.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(first.readUInt32BE(16)).toBe(1200);
    expect(first.readUInt32BE(20)).toBe(630);

    // Même clé de cache => mêmes octets : l'ETag servi aux CDN reste stable.
    const second = await renderOgCard({ ...spec, cacheKey: 'test:carte-1' });
    expect(second.equals(first)).toBe(true);
  }, RENDER_TIMEOUT_MS);

  test('deux clés différentes donnent deux cartes différentes', async () => {
    const base = { kicker: 'Ticket', title: 'Contenu protégé', art: { type: 'redactedChat' as const } };
    const a = await renderOgCard({ ...base, cacheKey: 'test:carte-a' });
    const b = await renderOgCard({ ...base, cacheKey: 'test:carte-b' });
    expect(a.equals(b)).toBe(false);
  }, RENDER_TIMEOUT_MS);
});
