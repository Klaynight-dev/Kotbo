import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../utils/cache.js';
import { BRAND_THEME_COLOR } from '../../utils/brandPalette.js';
import { resolveGuildLocale, type BotLocale, FALLBACK_LOCALE } from '../../utils/i18n.js';
import { sanitizeFormTheme } from '../../utils/formCustomization.js';
import type { CustomFormStructure } from '../features/customFormService.js';
import { normalizeAccent, type OgCardSpec } from './ogImageService.js';
import * as m from '../../lib/paraglide/messages.js';

// ============================================================================
// METADONNEES D'APERCU DES LIENS (Open Graph / Twitter Cards / oEmbed)
//
// Le dashboard est une SPA servie statiquement : un robot d'indexation - celui
// de Discord au premier chef - n'execute pas le bundle et ne voit donc que le
// squelette `index.html`. Tous les liens Kotbo partages dans un salon
// s'affichaient pour cette raison avec le meme titre generique.
//
// Ce module resout un CHEMIN du dashboard vers les metadonnees de la page
// correspondante. Il est la seule source de verite : la page HTML servie aux
// robots (routes/public/og.ts) et l'image de carte (ogImageService) en sortent
// toutes les deux, ce qui garantit qu'un embed ne peut pas annoncer autre chose
// que ce que son image montre.
//
// Regle de confidentialite : une metadonnee est lue sans authentification.
// Ce qui n'est pas deja public sur la page ne doit jamais remonter ici - une
// page protegee obtient un embed qui decrit sa NATURE (« transcription de
// ticket, acces reserve ») et jamais son contenu, et repart en `noindex`.
// ============================================================================

export interface OgMetadata {
  title: string;
  description: string;
  /** Chemin absolu de l'image de carte sur l'API, ou null (pas d'illustration). */
  imagePath: string | null;
  imageAlt: string;
  /** Couleur de la barre laterale de l'embed Discord (`<meta name="theme-color">`). */
  themeColor: string;
  siteName: string;
  /** Ligne « auteur » de l'embed, alimentee via oEmbed (nom du serveur). */
  authorName: string | null;
  ogType: 'website' | 'article' | 'profile';
  /** Les pages protegees ou personnelles ne doivent pas finir dans un index. */
  robots: 'index, follow' | 'noindex, nofollow';
  locale: BotLocale;
  /** Specification de la carte a rendre, null si la page n'en merite pas. */
  card: OgCardSpec | null;
}

const SITE_NAME = 'Kotbo';

// ---------------------------------------------------------------------------
// Petites aides de formatage
// ---------------------------------------------------------------------------

const SNOWFLAKE = /^\d{17,20}$/;
const CUID = /^[a-zA-Z0-9_-]{6,64}$/;

function formatNumber(value: number, locale: BotLocale): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US').format(value);
}

function formatDate(date: Date, locale: BotLocale): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Duree compacte (`2 j 4 h`, `18 min`) : un embed n'a pas la place d'une phrase. */
function formatDuration(ms: number, locale: BotLocale): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const unit = locale === 'fr'
    ? { d: 'j', h: 'h', m: 'min' }
    : { d: 'd', h: 'h', m: 'min' };

  if (days > 0) return hours > 0 ? `${days} ${unit.d} ${hours} ${unit.h}` : `${days} ${unit.d}`;
  if (hours > 0) return minutes > 0 ? `${hours} ${unit.h} ${minutes} ${unit.m}` : `${hours} ${unit.h}`;
  return `${Math.max(1, minutes)} ${unit.m}`;
}

function guildIdentity(client: Client, guildId: string): { name: string; iconUrl?: string } {
  const guild = client.guilds.cache.get(guildId);
  return {
    name: guild?.name ?? `Serveur ${guildId}`,
    iconUrl: guild?.iconURL({ extension: 'png', size: 256 }) ?? undefined,
  };
}

/** Chemin de l'image de carte pour un chemin de page donne. */
function imagePathFor(path: string, version: string): string {
  return `/api/og/image?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`;
}

/**
 * Nombre de messages d'une transcription.
 *
 * Le HTML d'une transcription pese couramment plusieurs megaoctets : on ne le
 * rapatrie pas pour compter des bulles. Le comptage se fait dans Postgres, et
 * le resultat est memorise - une transcription etant immuable, le cache peut
 * etre long.
 */
async function transcriptMessageCount(transcriptId: string): Promise<number | null> {
  const cacheKey = `og:transcript-count:${transcriptId}`;
  const cached = await cache.get<number>(cacheKey);
  if (typeof cached === 'number') return cached;

  try {
    const marker = '<div class="message-group">';
    const rows = await prisma.$queryRaw<{ count: bigint | number }[]>`
      SELECT (length(html) - length(replace(html, ${marker}, ''))) / length(${marker}) AS count
      FROM transcripts WHERE id = ${transcriptId}
    `;
    const raw = rows[0]?.count;
    if (raw === undefined || raw === null) return null;
    const count = Number(raw);
    if (!Number.isFinite(count)) return null;
    await cache.set(cacheKey, count, 86_400);
    return count;
  } catch (err) {
    logger.warn('OpenGraph', `Comptage des messages impossible pour la transcription ${transcriptId}: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sections du dashboard
//
// Les pages authentifiees n'exposent aucune donnee au robot : leur embed sert a
// dire OU mene le lien, pour qu'un lien colle dans un salon staff s'affiche
// « Sanctions - Kotbo » et pas « Kotbo Dashboard ». Les libelles sont tenus ici
// plutot que tires du catalogue Svelte (apps/dashboard/src/lib/config/pages.ts) :
// le bot ne compile pas les messages du dashboard, et cette table n'a besoin
// que du niveau « section ».
// ---------------------------------------------------------------------------
const DASHBOARD_SECTIONS: { prefix: string; fr: string; en: string }[] = [
  { prefix: '/analytics', fr: 'Analytique', en: 'Analytics' },
  { prefix: '/pulse', fr: 'Pulse', en: 'Pulse' },
  { prefix: '/inbox', fr: 'Boite de reception', en: 'Inbox' },
  { prefix: '/members', fr: 'Membres', en: 'Members' },
  { prefix: '/invitations', fr: 'Invitations', en: 'Invites' },
  { prefix: '/logs', fr: 'Journaux Discord', en: 'Discord logs' },
  { prefix: '/message-search', fr: 'Recherche de messages', en: 'Message search' },
  { prefix: '/transcripts-list', fr: 'Transcriptions', en: 'Transcripts' },
  { prefix: '/activity', fr: "Journal d'activite", en: 'Activity log' },
  { prefix: '/events', fr: 'Evenements', en: 'Events' },
  { prefix: '/forms', fr: 'Formulaires', en: 'Forms' },
  { prefix: '/dailyalgo', fr: 'Daily Algo', en: 'Daily Algo' },
  { prefix: '/security/quick-setup', fr: 'Securite - Demarrage rapide', en: 'Security - Quick setup' },
  { prefix: '/security/anti-raid', fr: 'Securite - Anti-raid', en: 'Security - Anti-raid' },
  { prefix: '/security/filters', fr: 'Securite - Filtres', en: 'Security - Filters' },
  { prefix: '/security/accounts', fr: 'Securite - Comptes', en: 'Security - Accounts' },
  { prefix: '/security/sanctions', fr: 'Securite - Sanctions', en: 'Security - Sanctions' },
  { prefix: '/security', fr: 'Securite', en: 'Security' },
  { prefix: '/leveling', fr: 'Niveaux', en: 'Leveling' },
  { prefix: '/prestige', fr: 'Prestige', en: 'Prestige' },
  { prefix: '/seasons', fr: 'Saisons', en: 'Seasons' },
  { prefix: '/reputation', fr: 'Reputation', en: 'Reputation' },
  { prefix: '/clans', fr: 'Clans', en: 'Clans' },
  { prefix: '/drops', fr: 'Drops', en: 'Drops' },
  { prefix: '/economy-setup', fr: 'Economie - Demarrage rapide', en: 'Economy - Quick setup' },
  { prefix: '/economy', fr: 'Economie', en: 'Economy' },
  { prefix: '/marketplace', fr: 'Marche', en: 'Marketplace' },
  { prefix: '/quests', fr: 'Quetes', en: 'Quests' },
  { prefix: '/giveaways', fr: 'Giveaways', en: 'Giveaways' },
  { prefix: '/announcement', fr: 'Annonces', en: 'Announcements' },
  { prefix: '/reaction-roles', fr: 'Roles par reaction', en: 'Reaction roles' },
  { prefix: '/triggers', fr: 'Declencheurs', en: 'Triggers' },
  { prefix: '/suggestions', fr: 'Suggestions', en: 'Suggestions' },
  { prefix: '/embed-builder', fr: "Constructeur d'embeds", en: 'Embed builder' },
  { prefix: '/regulation', fr: 'Reglement', en: 'Rules' },
  { prefix: '/news', fr: 'Actualites', en: 'News' },
  { prefix: '/fun', fr: 'Salons fun', en: 'Fun channels' },
  { prefix: '/social-networks', fr: 'Reseaux sociaux', en: 'Social networks' },
  { prefix: '/staff-management', fr: 'Gestion du staff', en: 'Staff management' },
  { prefix: '/recruitment', fr: 'Recrutement', en: 'Recruitment' },
  { prefix: '/tickets', fr: 'Tickets', en: 'Tickets' },
  { prefix: '/tutoring', fr: 'Tutorat', en: 'Tutoring' },
  { prefix: '/meetings', fr: 'Reunions', en: 'Meetings' },
  { prefix: '/planning', fr: 'Planning', en: 'Planning' },
  { prefix: '/channel-links', fr: 'Liens de salons', en: 'Channel links' },
  { prefix: '/staff-server', fr: 'Serveurs staff', en: 'Staff servers' },
  { prefix: '/management', fr: 'Centre de gestion', en: 'Management center' },
  { prefix: '/modules', fr: 'Modules', en: 'Modules' },
  { prefix: '/channel-health', fr: 'Sante des salons', en: 'Channel health' },
  { prefix: '/channels-management', fr: 'Salons', en: 'Channels' },
  { prefix: '/command-access', fr: 'Commandes', en: 'Commands' },
  { prefix: '/settings', fr: 'Parametres', en: 'Settings' },
  { prefix: '/backups', fr: 'Sauvegardes', en: 'Backups' },
  { prefix: '/schedules', fr: 'Taches planifiees', en: 'Scheduled tasks' },
  { prefix: '/mcp-settings', fr: 'API & MCP', en: 'API & MCP' },
  { prefix: '/custom-bot', fr: 'Bot personnalise', en: 'Custom bot' },
  { prefix: '/setup', fr: 'Prise en main', en: 'Getting started' },
  { prefix: '/admin', fr: 'Administration', en: 'Administration' },
  { prefix: '/profile', fr: 'Mon profil', en: 'My profile' },
  { prefix: '/userSettings', fr: 'Preferences', en: 'Preferences' },
];

function resolveDashboardSection(path: string, locale: BotLocale): string | null {
  // Le prefixe le plus long gagne, sinon `/security` capterait
  // `/security/anti-raid` et l'embed annoncerait la mauvaise page.
  const ordered = [...DASHBOARD_SECTIONS].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const section of ordered) {
    if (path === section.prefix || path.startsWith(`${section.prefix}/`)) {
      return locale === 'fr' ? section.fr : section.en;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function baseMetadata(locale: BotLocale): OgMetadata {
  return {
    title: m.og_default_title({}, { locale }),
    description: m.og_default_desc({}, { locale }),
    imagePath: null,
    imageAlt: SITE_NAME,
    themeColor: BRAND_THEME_COLOR,
    siteName: SITE_NAME,
    authorName: null,
    ogType: 'website',
    robots: 'index, follow',
    locale,
    card: null,
  };
}

/**
 * Normalise le chemin recu du proxy : on ne travaille que sur un chemin absolu,
 * sans query ni fragment, et sans slash final parasite.
 */
export function normalizeOgPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  let path = raw.trim();
  // Le proxy peut transmettre une URL complete : seul le chemin nous interesse.
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return '/';
    }
  }
  path = path.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  // Une traversee (`/../`) n'a pas de sens ici et brouillerait le routage.
  if (path.includes('..')) return '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path.slice(0, 512);
}

export async function resolveOgMetadata(client: Client, rawPath: string): Promise<OgMetadata> {
  const path = normalizeOgPath(rawPath);
  const segments = path.split('/').filter(Boolean);

  try {
    const resolved = await resolveByRoute(client, path, segments);
    if (resolved) return resolved;
  } catch (err) {
    logger.error('OpenGraph', `Resolution des metadonnees impossible pour ${path}`, err);
  }

  // Repli : page inconnue ou ressource supprimee. On garde une carte de marque
  // plutot qu'un embed nu, mais on ne pretend rien sur le contenu.
  const locale = FALLBACK_LOCALE;
  const fallback = baseMetadata(locale);
  const section = resolveDashboardSection(path, locale);
  if (section) return dashboardMetadata(path, section, locale);
  fallback.imagePath = imagePathFor(path, 'generic');
  fallback.card = {
    cacheKey: `generic:${path}`,
    kicker: m.og_kicker_kotbo({}, { locale }),
    title: fallback.title,
    subtitle: fallback.description,
  };
  return fallback;
}

function dashboardMetadata(path: string, section: string, locale: BotLocale): OgMetadata {
  const meta = baseMetadata(locale);
  meta.title = `${section} · ${SITE_NAME}`;
  meta.description = m.og_dashboard_desc({ section }, { locale });
  // Le dashboard est un espace d'administration : rien a indexer.
  meta.robots = 'noindex, nofollow';
  meta.imagePath = imagePathFor(path, 'section');
  meta.card = {
    cacheKey: `dashboard:${path}`,
    kicker: m.og_kicker_dashboard({}, { locale }),
    title: section,
    subtitle: m.og_dashboard_desc({ section }, { locale }),
    badges: [m.og_badge_login_required({}, { locale })],
  };
  return meta;
}

async function resolveByRoute(client: Client, path: string, segments: string[]): Promise<OgMetadata | null> {
  // ── Ressources identifiees par un id ────────────────────────────────────
  if (segments[0] === 'transcripts' && segments[1] && !segments[2]) {
    return transcriptMetadata(client, path, segments[1]);
  }
  if (segments[0] === 'form' && segments[1] && !segments[2]) {
    return formMetadata(client, path, segments[1]);
  }
  if (segments[0] === 'appeal' && segments[1] && !segments[2]) {
    return appealMetadata(client, path, segments[1]);
  }
  if (segments[0] === 'verify') {
    return verifyMetadata(client, path, segments[1]);
  }
  if (segments[0] === 'sanction-evidence' && segments[1]) {
    return evidenceMetadata(path);
  }
  if (segments[0] === 'profile' && segments[1] && SNOWFLAKE.test(segments[1])) {
    return profileMetadata(client, path, segments[1]);
  }

  // ── Pages publiques d'un serveur : /:guildId/... ────────────────────────
  if (segments[0] && SNOWFLAKE.test(segments[0])) {
    return guildPageMetadata(client, path, segments[0], segments.slice(1));
  }

  // ── Pages du dashboard ──────────────────────────────────────────────────
  const section = resolveDashboardSection(path, FALLBACK_LOCALE);
  if (section) return dashboardMetadata(path, section, FALLBACK_LOCALE);

  return null;
}

/**
 * Transcription de ticket.
 *
 * La page exige une connexion Discord ET un droit sur le serveur : l'embed ne
 * doit donc pas la contourner. Le nom du salon (`ticket-<pseudo>`) et les
 * participants sont volontairement absents - ils identifieraient l'auteur du
 * ticket aupres de quiconque recupere le lien. Restent la nature de la
 * ressource, le serveur, le volume et la periode couverte.
 */
async function transcriptMetadata(client: Client, path: string, transcriptId: string): Promise<OgMetadata | null> {
  if (!CUID.test(transcriptId)) return null;

  const transcript = await prisma.transcript.findUnique({
    where: { id: transcriptId },
    select: { id: true, guildId: true, startTime: true, endTime: true, createdAt: true },
  });
  if (!transcript) return null;

  const locale = await resolveGuildLocale(transcript.guildId);
  const guild = guildIdentity(client, transcript.guildId);
  const meta = baseMetadata(locale);
  const count = await transcriptMessageCount(transcript.id);

  const spanMs = transcript.startTime && transcript.endTime
    ? transcript.endTime.getTime() - transcript.startTime.getTime()
    : null;

  meta.title = m.og_transcript_title({ guild: guild.name }, { locale });
  meta.description = m.og_transcript_desc(
    {
      count: count === null ? '?' : formatNumber(count, locale),
      date: formatDate(transcript.createdAt, locale),
    },
    { locale },
  );
  meta.authorName = guild.name;
  meta.ogType = 'article';
  meta.robots = 'noindex, nofollow';
  meta.imagePath = imagePathFor(path, String(transcript.createdAt.getTime()));
  meta.imageAlt = meta.title;

  const stats: { value: string; label: string }[] = [];
  if (count !== null) stats.push({ value: formatNumber(count, locale), label: m.og_stat_messages({}, { locale }) });
  if (spanMs !== null && spanMs > 0) {
    stats.push({ value: formatDuration(spanMs, locale), label: m.og_stat_span({}, { locale }) });
  }
  stats.push({ value: formatDate(transcript.createdAt, locale), label: m.og_stat_archived({}, { locale }) });

  meta.card = {
    cacheKey: `transcript:${transcript.id}:${transcript.createdAt.getTime()}`,
    kicker: m.og_transcript_kicker({}, { locale }),
    title: m.og_transcript_card_title({}, { locale }),
    subtitle: m.og_transcript_card_subtitle({}, { locale }),
    guildName: guild.name,
    guildIconUrl: guild.iconUrl,
    stats,
    art: { type: 'redactedChat', rows: 6 },
    footerRight: m.og_badge_login_required({}, { locale }),
  };
  return meta;
}

/**
 * Formulaire public.
 *
 * Tout ce qui figure ici est deja servi sans authentification par
 * `/api/public/forms/:id` : intitules des questions, theme, statut. L'embed
 * peut donc etre genereux, et c'est ce qui le rend utile - on sait avant de
 * cliquer ce qu'on va devoir remplir et combien de temps cela prendra.
 */
async function formMetadata(client: Client, path: string, formId: string): Promise<OgMetadata | null> {
  if (!CUID.test(formId)) return null;

  const form = await prisma.customForm.findUnique({
    where: { id: formId },
    select: {
      id: true,
      guildId: true,
      name: true,
      description: true,
      isActive: true,
      isRecruitment: true,
      requiresDiscordAuth: true,
      structure: true,
      theme: true,
      updatedAt: true,
    },
  });
  if (!form) return null;

  const locale = await resolveGuildLocale(form.guildId);
  const guild = guildIdentity(client, form.guildId);
  const meta = baseMetadata(locale);

  const structure = (form.structure ?? {}) as Partial<CustomFormStructure>;
  const fields = Array.isArray(structure.fields) ? structure.fields : [];
  // `discord_connect` est un bouton de liaison de compte, pas une question :
  // l'annoncer comme telle gonflerait le compteur sans rien dire d'utile.
  const questions = fields.filter((field) => field?.type !== 'discord_connect');
  const requiresLogin = Boolean(form.isRecruitment || form.requiresDiscordAuth);

  // Une minute par question courte, deux par question longue : une estimation
  // grossiere mais honnete, qui vaut mieux qu'aucun repere avant de cliquer.
  const estimatedMinutes = Math.max(
    1,
    questions.reduce((total, field) => total + (field?.type === 'paragraph' ? 2 : 1), 0),
  );

  const theme = sanitizeFormTheme(form.theme);
  const accent = normalizeAccent(theme?.accentColor, BRAND_THEME_COLOR);

  const title = structure.title?.trim() || form.name;
  const description = form.description?.trim() || structure.description?.trim() || '';

  meta.title = `${title} · ${guild.name}`;
  meta.description = description || m.og_form_desc(
    { count: String(questions.length), minutes: String(estimatedMinutes) },
    { locale },
  );
  meta.authorName = guild.name;
  meta.themeColor = accent;
  meta.robots = form.isActive ? 'index, follow' : 'noindex, nofollow';
  meta.imagePath = imagePathFor(path, String(form.updatedAt.getTime()));
  meta.imageAlt = meta.title;

  const badges = [
    form.isActive ? m.og_badge_open({}, { locale }) : m.og_badge_closed({}, { locale }),
  ];
  if (requiresLogin) badges.push(m.og_badge_login_required({}, { locale }));
  if (form.isRecruitment) badges.push(m.og_badge_recruitment({}, { locale }));

  meta.card = {
    cacheKey: `form:${form.id}:${form.updatedAt.getTime()}`,
    kicker: form.isRecruitment
      ? m.og_form_kicker_recruitment({}, { locale })
      : m.og_form_kicker({}, { locale }),
    title,
    subtitle: description || undefined,
    guildName: guild.name,
    guildIconUrl: guild.iconUrl,
    accent,
    badges,
    stats: [
      { value: formatNumber(questions.length, locale), label: m.og_stat_questions({}, { locale }) },
      { value: `~${estimatedMinutes} min`, label: m.og_stat_duration({}, { locale }) },
    ],
    art: {
      type: 'questions',
      items: questions.slice(0, 3).map((field) => field.label ?? ''),
      more: Math.max(0, questions.length - 3),
    },
  };
  return meta;
}

/** Formulaire d'appel de bannissement : page publique, statut du module inclus. */
async function appealMetadata(client: Client, path: string, guildId: string): Promise<OgMetadata | null> {
  if (!SNOWFLAKE.test(guildId)) return null;

  const config = await prisma.banAppealConfig.findUnique({
    where: { guildId },
    select: { enabled: true, cooldownDays: true },
  });

  const locale = await resolveGuildLocale(guildId);
  const guild = guildIdentity(client, guildId);
  const meta = baseMetadata(locale);
  const enabled = Boolean(config?.enabled);

  meta.title = m.og_appeal_title({ guild: guild.name }, { locale });
  meta.description = enabled
    ? m.og_appeal_desc({ guild: guild.name }, { locale })
    : m.og_appeal_desc_closed({ guild: guild.name }, { locale });
  meta.authorName = guild.name;
  // Un formulaire d'appel n'a rien a faire dans un moteur de recherche : il est
  // adresse a une personne precise, par message prive.
  meta.robots = 'noindex, nofollow';
  meta.imagePath = imagePathFor(path, enabled ? 'open' : 'closed');
  meta.imageAlt = meta.title;
  meta.card = {
    cacheKey: `appeal:${guildId}:${enabled ? 'open' : 'closed'}`,
    kicker: m.og_appeal_kicker({}, { locale }),
    title: m.og_appeal_title({ guild: guild.name }, { locale }),
    subtitle: meta.description,
    guildName: guild.name,
    guildIconUrl: guild.iconUrl,
    badges: [enabled ? m.og_badge_open({}, { locale }) : m.og_badge_closed({}, { locale })],
  };
  return meta;
}

/**
 * Page de verification.
 *
 * L'URL porte un jeton a usage unique. On ne rend donc ni image parametree par
 * le chemin ni description qui reprendrait le jeton, et l'ensemble part en
 * `noindex` : un lien de verification ne doit laisser aucune trace ailleurs.
 */
async function verifyMetadata(client: Client, path: string, guildId?: string): Promise<OgMetadata> {
  const valid = guildId && SNOWFLAKE.test(guildId) ? guildId : null;
  const locale = valid ? await resolveGuildLocale(valid) : FALLBACK_LOCALE;
  const guild = valid ? guildIdentity(client, valid) : null;
  const meta = baseMetadata(locale);

  meta.title = guild ? m.og_verify_title({ guild: guild.name }, { locale }) : m.og_verify_title_generic({}, { locale });
  meta.description = m.og_verify_desc({}, { locale });
  meta.authorName = guild?.name ?? null;
  meta.robots = 'noindex, nofollow';
  // Cle de cache volontairement independante du jeton present dans l'URL.
  meta.imagePath = imagePathFor(valid ? `/verify/${valid}` : '/verify', 'v1');
  meta.imageAlt = meta.title;
  meta.card = {
    cacheKey: `verify:${valid ?? 'generic'}`,
    kicker: m.og_verify_kicker({}, { locale }),
    title: meta.title,
    subtitle: meta.description,
    guildName: guild?.name,
    guildIconUrl: guild?.iconUrl,
  };
  return meta;
}

/** Piece jointe d'un dossier de sanction : strictement protegee, embed neutre. */
function evidenceMetadata(path: string): OgMetadata {
  const locale = FALLBACK_LOCALE;
  const meta = baseMetadata(locale);
  meta.title = m.og_evidence_title({}, { locale });
  meta.description = m.og_evidence_desc({}, { locale });
  meta.robots = 'noindex, nofollow';
  meta.imagePath = imagePathFor(path, 'v1');
  meta.imageAlt = meta.title;
  meta.card = {
    cacheKey: 'evidence:generic',
    kicker: m.og_evidence_kicker({}, { locale }),
    title: meta.title,
    subtitle: meta.description,
    art: { type: 'redactedChat', rows: 4 },
    footerRight: m.og_badge_login_required({}, { locale }),
  };
  return meta;
}

/** Profil public d'un membre : ne rend une carte que si le profil est reellement public. */
async function profileMetadata(client: Client, path: string, userId: string): Promise<OgMetadata | null> {
  const locale = FALLBACK_LOCALE;
  const meta = baseMetadata(locale);
  const user = await client.users.fetch(userId).catch(() => null);

  meta.title = user
    ? m.og_profile_title({ user: user.displayName || user.username }, { locale })
    : m.og_profile_title_generic({}, { locale });
  meta.description = m.og_profile_desc({}, { locale });
  meta.ogType = 'profile';
  // Un profil de membre reste une donnee personnelle : pas d'indexation.
  meta.robots = 'noindex, nofollow';
  meta.imagePath = imagePathFor(path, 'v1');
  meta.imageAlt = meta.title;
  meta.card = {
    cacheKey: `profile:${userId}`,
    kicker: m.og_profile_kicker({}, { locale }),
    title: user ? (user.displayName || user.username) : m.og_profile_title_generic({}, { locale }),
    subtitle: meta.description,
    guildName: user ? user.username : undefined,
    guildIconUrl: user?.displayAvatarURL({ extension: 'png', size: 256 }),
  };
  return meta;
}

// ---------------------------------------------------------------------------
// Pages publiques d'un serveur
// ---------------------------------------------------------------------------

async function guildPageMetadata(
  client: Client,
  path: string,
  guildId: string,
  rest: string[],
): Promise<OgMetadata | null> {
  const locale = await resolveGuildLocale(guildId);
  const guild = guildIdentity(client, guildId);
  const meta = baseMetadata(locale);
  meta.authorName = guild.name;
  meta.imageAlt = guild.name;

  const section = rest.join('/');

  if (section === 'giveaways' || (rest[0] === 'giveaways' && rest[1])) {
    return giveawayMetadata(path, guildId, rest[1], guild, locale, meta);
  }

  const leaderboardKind = {
    'leveling/classement': 'leveling',
    'prestige/classement': 'prestige',
    'leveling/clan': 'clan',
    clan: 'clan',
    rpg: 'rpg',
  }[section];

  if (leaderboardKind) {
    return leaderboardMetadata(path, guildId, leaderboardKind, guild, locale, meta);
  }

  if (section === 'news') {
    meta.title = m.og_news_title({ guild: guild.name }, { locale });
    meta.description = m.og_news_desc({ guild: guild.name }, { locale });
    meta.ogType = 'article';
    meta.imagePath = imagePathFor(path, 'v1');
    meta.card = {
      cacheKey: `news:${guildId}`,
      kicker: m.og_news_kicker({}, { locale }),
      title: m.og_news_title({ guild: guild.name }, { locale }),
      subtitle: meta.description,
      guildName: guild.name,
      guildIconUrl: guild.iconUrl,
    };
    return meta;
  }

  if (section === 'dev') {
    meta.title = m.og_dev_title({ guild: guild.name }, { locale });
    meta.description = m.og_dev_desc({}, { locale });
    meta.imagePath = imagePathFor(path, 'v1');
    meta.card = {
      cacheKey: `dev:${guildId}`,
      kicker: m.og_dev_kicker({}, { locale }),
      title: m.og_dev_title({ guild: guild.name }, { locale }),
      subtitle: meta.description,
      guildName: guild.name,
      guildIconUrl: guild.iconUrl,
    };
    return meta;
  }

  return null;
}

async function giveawayMetadata(
  path: string,
  guildId: string,
  giveawayId: string | undefined,
  guild: { name: string; iconUrl?: string },
  locale: BotLocale,
  meta: OgMetadata,
): Promise<OgMetadata | null> {
  // Liste des giveaways du serveur.
  if (!giveawayId) {
    const running = await prisma.giveaway.count({ where: { guildId, ended: false } });
    meta.title = m.og_giveaways_title({ guild: guild.name }, { locale });
    meta.description = m.og_giveaways_desc({ count: formatNumber(running, locale) }, { locale });
    meta.imagePath = imagePathFor(path, String(running));
    meta.card = {
      cacheKey: `giveaways:${guildId}:${running}`,
      kicker: m.og_giveaway_kicker({}, { locale }),
      title: m.og_giveaways_title({ guild: guild.name }, { locale }),
      subtitle: meta.description,
      guildName: guild.name,
      guildIconUrl: guild.iconUrl,
      stats: [{ value: formatNumber(running, locale), label: m.og_stat_running({}, { locale }) }],
    };
    return meta;
  }

  if (!CUID.test(giveawayId)) return null;
  const giveaway = await prisma.giveaway.findFirst({
    where: { id: giveawayId, guildId },
    select: {
      id: true,
      prize: true,
      description: true,
      winnerCount: true,
      endsAt: true,
      ended: true,
      participants: true,
      updatedAt: true,
    },
  });
  if (!giveaway) return null;

  const remainingMs = giveaway.endsAt.getTime() - Date.now();
  const isOver = giveaway.ended || remainingMs <= 0;

  meta.title = m.og_giveaway_title({ prize: giveaway.prize }, { locale });
  meta.description = isOver
    ? m.og_giveaway_desc_ended({ guild: guild.name }, { locale })
    : m.og_giveaway_desc(
        {
          guild: guild.name,
          remaining: formatDuration(remainingMs, locale),
          participants: formatNumber(giveaway.participants.length, locale),
        },
        { locale },
      );
  meta.ogType = 'article';
  // Le compte a rebours doit vieillir : la version de l'image inclut l'heure,
  // sinon l'embed afficherait « 3 j » pendant trois jours.
  const bucket = isOver ? 'ended' : String(Math.floor(Date.now() / 3_600_000));
  meta.imagePath = imagePathFor(path, `${giveaway.updatedAt.getTime()}-${bucket}`);
  meta.imageAlt = meta.title;
  meta.card = {
    cacheKey: `giveaway:${giveaway.id}:${bucket}`,
    kicker: m.og_giveaway_kicker({}, { locale }),
    title: giveaway.prize,
    subtitle: giveaway.description?.trim() || undefined,
    guildName: guild.name,
    guildIconUrl: guild.iconUrl,
    badges: [isOver ? m.og_badge_ended({}, { locale }) : m.og_badge_open({}, { locale })],
    stats: [
      { value: formatNumber(giveaway.participants.length, locale), label: m.og_stat_participants({}, { locale }) },
      { value: formatNumber(giveaway.winnerCount, locale), label: m.og_stat_winners({}, { locale }) },
    ],
    art: {
      type: 'countdown',
      label: isOver ? m.og_badge_ended({}, { locale }) : m.og_countdown_label({}, { locale }),
      value: isOver ? '-' : formatDuration(remainingMs, locale),
      ended: isOver,
    },
    footerRight: formatDate(giveaway.endsAt, locale),
  };
  return meta;
}

/**
 * Classements publics (niveaux, prestige, clans, RPG).
 *
 * Le podium est lu depuis la base plutot que via les services de classement :
 * ceux-ci agregent bien plus que trois lignes, et une carte d'apercu n'a pas a
 * declencher ce calcul a chaque fois qu'un robot passe.
 */
async function leaderboardMetadata(
  path: string,
  guildId: string,
  kind: string,
  guild: { name: string; iconUrl?: string },
  locale: BotLocale,
  meta: OgMetadata,
): Promise<OgMetadata> {
  const titles: Record<string, string> = {
    leveling: m.og_leaderboard_title_leveling({ guild: guild.name }, { locale }),
    prestige: m.og_leaderboard_title_prestige({ guild: guild.name }, { locale }),
    clan: m.og_leaderboard_title_clan({ guild: guild.name }, { locale }),
    rpg: m.og_leaderboard_title_rpg({ guild: guild.name }, { locale }),
  };

  const title = titles[kind] ?? titles.leveling;
  meta.title = title;
  meta.description = m.og_leaderboard_desc({ guild: guild.name }, { locale });
  meta.imageAlt = title;

  // Le podium n'est dresse que pour les clans : ce sont des entites publiques
  // du serveur. Un classement de MEMBRES reste chiffre - la carte est servie
  // sans authentification, elle n'a pas a nommer des personnes que seule la
  // page, elle, presente en contexte.
  const podium: { name: string; score: string }[] = [];
  let total = 0;
  try {
    if (kind === 'clan' || kind === 'rpg') {
      total = await prisma.clan.count({ where: { guildId } });
      const top = await prisma.clanMemberContribution.groupBy({
        by: ['clanId'],
        where: { guildId },
        _sum: { xp: true },
        orderBy: { _sum: { xp: 'desc' } },
        take: 3,
      });
      if (top.length > 0) {
        const clans = await prisma.clan.findMany({
          where: { id: { in: top.map((row) => row.clanId) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(clans.map((clan) => [clan.id, clan.name]));
        for (const row of top) {
          const name = nameById.get(row.clanId);
          if (!name) continue;
          podium.push({ name, score: `${formatNumber(row._sum.xp ?? 0, locale)} XP` });
        }
      }
    } else {
      total = await prisma.memberLevel.count({ where: { guildId } });
    }
  } catch (err) {
    // Un classement indisponible ne doit pas priver le lien de son embed.
    logger.warn('OpenGraph', `Podium indisponible pour ${guildId} (${kind}): ${String(err)}`);
  }

  meta.imagePath = imagePathFor(path, String(total));
  meta.card = {
    cacheKey: `leaderboard:${guildId}:${kind}:${total}`,
    kicker: m.og_leaderboard_kicker({}, { locale }),
    title,
    subtitle: meta.description,
    guildName: guild.name,
    guildIconUrl: guild.iconUrl,
    stats: [{
      value: formatNumber(total, locale),
      label: kind === 'clan' || kind === 'rpg'
        ? m.og_stat_clans({}, { locale })
        : m.og_stat_members({}, { locale }),
    }],
    art: podium.length > 0 ? { type: 'podium', entries: podium } : { type: 'none' },
  };
  return meta;
}
