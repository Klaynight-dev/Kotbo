import { Prisma } from '@prisma/client';
import { IncomingMessage, ServerResponse } from 'node:http';
import {
  Client,
  ChannelType,
  DiscordAPIError,
  GuildPremiumTier,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import pLimit from 'p-limit';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { isGuildActivated, activateGuild } from '../../../utils/activation.js';
import { isOnboardingBacktrack } from '@kotbo/contracts';
import {
  trackAcquisitionStep,
  trackDashboardOpen,
} from '../../../services/analytics/acquisitionService.js';
import { translate } from '../../../services/integrations/translationService.js';
import { cache } from '../../../utils/cache.js';
import { getGuildLanguageState, normalizeLocale } from '../../../utils/i18n.js';
import { DEFAULT_TIMEZONE, isValidTimezone, listSupportedTimezones, normalizeTimezone } from '@kotbo/contracts';
import { rerenderPersistentPanels } from '../../../services/core/panelRerenderService.js';
import {
  canFinishOnboardingWithoutPayment,
  isOnboardingFeatureEnabled,
  markOnboardingComplete,
} from '../../../services/core/onboardingGate.js';
import {
  json,
  readJsonBody,
  getGuildName,
  resolveAdminAccess,
  resolveDashboardAccess,
  getGuildState,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';

/**
 * Limites du dépôt d'emoji, imposées par Discord et non par nous : 256 Ko et
 * des formats d'image que le CDN sait servir. Les rappeler ici évite un
 * aller-retour réseau pour un fichier qui sera refusé de toute façon.
 */
const GUILD_EMOJI_MAX_BYTES = 256 * 1024;
const GUILD_EMOJI_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Fuseau de lecture choisi par un utilisateur, ou `null` pour « suivre le
 * navigateur ».
 *
 * `normalizeTimezone` ne convient pas ici : il replie sur Europe/Paris, ce qui
 * transformerait une valeur invalide en choix explicite et figerait le lecteur
 * dans un fuseau qu'il n'a pas demande.
 */
function normalizeStoredTimezone(value: unknown): string | null {
  return isValidTimezone(value) ? value : null;
}

/**
 * Ecran courant du parcours, tel que le dashboard l'enregistre.
 *
 * L'etat du parcours est un JSON libre, borne en taille mais non valide champ
 * par champ : c'est le dashboard qui se le relit a lui-meme. On n'en extrait
 * donc que ce dont le tunnel a besoin, et on se mefie du reste.
 */
function readWizardStep(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const step = (state as { step?: unknown }).step;
  return typeof step === 'string' && step.trim() ? step.trim().slice(0, 64) : null;
}

/** Le visiteur est-il revenu sur ses pas ? Delegue a l'ordre des ecrans. */
function wentBackward(from: string | null, to: string | null): boolean {
  return isOnboardingBacktrack(from, to);
}


export async function handleGeneralRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims
): Promise<boolean> {
  const method = req.method;

  // POST /api/dashboard/translate
  if (parts.length === 3 && parts[2] === 'translate' && method === 'POST') {
    try {
      const body = await readJsonBody<{ text: string; targetLang?: string }>(req);
      if (!body?.text) {
        json(res, 400, { error: 'Texte à traduire requis' });
        return true;
      }
      const translatedText = await translate(body.text, body.targetLang || 'fr');
      json(res, 200, { translatedText });
    } catch (err) {
      logger.error('GeneralAPI', 'Error translating text:', err);
      json(res, 500, { error: 'Erreur lors de la traduction' });
    }
    return true;
  }

  // GET|PATCH /api/dashboard/guilds/:guildId/language
  //
  // Expose la carte « Langue du bot » de l'accueil. `language: null` cote base
  // signifie « detection automatique » : la cascade retombe alors sur la langue
  // declaree du serveur Discord, puis sur l'anglais.
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'language' && (method === 'GET' || method === 'PATCH')) {
    const guildId = parts[3]!;
    try {
      const access = await resolveDashboardAccess(client, guildId, user.userId);
      if (!access.canViewDashboard) {
        json(res, 403, { error: 'Accès refusé' });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId) ?? null;
      const detected = normalizeLocale(discordGuild?.preferredLocale ?? null);

      if (method === 'PATCH') {
        if (!access.canManageSettings) {
          json(res, 403, { error: 'Accès refusé' });
          return true;
        }

        const body = await readJsonBody<{ mode?: 'auto' | 'manual'; language?: string | null }>(req);
        const wantsAuto = body?.mode === 'auto' || body?.language === null;
        const requested = wantsAuto ? null : normalizeLocale(body?.language);

        if (!wantsAuto && !requested) {
          json(res, 400, { error: "Langue invalide : utilisez 'fr', 'en', ou mode 'auto'" });
          return true;
        }

        const before = await getGuildLanguageState(guildId, discordGuild?.preferredLocale ?? null);

        await prisma.guild.upsert({
          where: { id: guildId },
          update: { language: requested },
          create: { id: guildId, language: requested },
        });
        await cache.invalidateGuild(guildId);

        const after = await getGuildLanguageState(guildId, discordGuild?.preferredLocale ?? null);

        // Ecrire la langue ne reecrit pas les messages deja publies : sans ce
        // re-rendu, les panneaux persistants restent dans l'ancienne langue et le
        // reglage passe pour inoperant. C'est ce que fait `/languages rerender`,
        // qui reste utile apres une modification de gabarit.
        const rerender = after.locale === before.locale
          ? null
          : await rerenderPersistentPanels(client, guildId);

        json(res, 200, {
          mode: after.mode,
          locale: after.locale,
          detected,
          available: ['fr', 'en'],
          rerender: rerender && {
            updated: rerender.updated,
            skipped: rerender.skipped,
            failed: rerender.failed,
          },
        });
        return true;
      }

      const state = await getGuildLanguageState(guildId, discordGuild?.preferredLocale ?? null);
      json(res, 200, {
        mode: state.mode,
        locale: state.locale,
        detected,
        available: ['fr', 'en'],
        rerender: null,
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error handling language for guild ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de la gestion de la langue' });
    }
    return true;
  }

  // GET|PATCH /api/dashboard/guilds/:guildId/timezone
  //
  // Le bot tourne en UTC : sans ce reglage, une reunion saisie a 21h etait
  // enregistree a 23h heure de Paris et annoncee a 19h dans les notifications.
  if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'timezone' && (method === 'GET' || method === 'PATCH')) {
    const guildId = parts[3]!;
    try {
      const access = await resolveDashboardAccess(client, guildId, user.userId);
      if (!access.canViewDashboard) {
        json(res, 403, { error: 'Accès refusé' });
        return true;
      }

      if (method === 'PATCH') {
        if (!access.canManageSettings) {
          json(res, 403, { error: 'Accès refusé' });
          return true;
        }

        const body = await readJsonBody<{ timezone?: string | null }>(req);
        const requested = body?.timezone;

        // Pas de repli sur le defaut : une requete malformee remettrait
        // silencieusement le serveur sur Europe/Paris.
        if (!isValidTimezone(requested)) {
          json(res, 400, { error: 'Fuseau horaire invalide : utilisez un identifiant IANA (ex. Europe/Paris)' });
          return true;
        }

        await prisma.guild.upsert({
          where: { id: guildId },
          update: { timezone: requested },
          create: { id: guildId, timezone: requested },
        });
        await cache.invalidateGuild(guildId);

        json(res, 200, {
          timezone: requested,
          default: DEFAULT_TIMEZONE,
          available: listSupportedTimezones(requested),
        });
        return true;
      }

      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { timezone: true },
      });

      const current = normalizeTimezone(guild?.timezone);
      json(res, 200, {
        timezone: current,
        default: DEFAULT_TIMEZONE,
        available: listSupportedTimezones(current),
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error handling timezone for guild ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de la gestion du fuseau horaire' });
    }
    return true;
  }

  // GET /api/dashboard/guilds
  if (parts.length === 3 && parts[2] === 'guilds' && method === 'GET') {
    try {
      const guilds = await prisma.guild.findMany({
        orderBy: { updatedAt: 'desc' },
        select: { id: true, updatedAt: true }
      });

      const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
      const visibleGuilds = guilds
        .map((guild) => ({ guild, activated: isGuildActivated(guild.id) }))
        .filter(({ activated }) => activated || isGlobalAdmin);

      // Cette route est le chemin critique de l'ecran de connexion : elle
      // s'executait en serie alors que `resolveDashboardAccess` fait un
      // `members.fetch()` Discord par serveur. Sur un compte present dans
      // plusieurs dizaines de serveurs, les allers-retours s'additionnaient.
      //
      // La concurrence est bornee pour ne pas envoyer d'un coup autant de
      // requetes que de serveurs a l'API Discord.
      const limit = pLimit(10);
      const resolved = await Promise.all(
        visibleGuilds.map(({ guild, activated }) =>
          limit(async () => {
            const access = await resolveDashboardAccess(client, guild.id, user.userId);
            if (!access.canViewDashboard) return null;

            return {
              id: guild.id,
              name: getGuildName(client, guild.id),
              updatedAt: guild.updatedAt.toISOString(),
              accessLevel: (access.level === 'admin' ? 'admin' : 'moderator') as 'admin' | 'moderator',
              activated,
            };
          })
        )
      );

      // `Promise.all` preserve l'ordre : le tri par `updatedAt` desc est conserve.
      json(res, 200, { guilds: resolved.filter((entry) => entry !== null) });
    } catch (err) {
      logger.error('GeneralAPI', 'Error listing guilds:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des serveurs' });
    }
    return true;
  }

  // GET /api/dashboard/presets/shared/:token - public access by share token
  if (parts.length === 5 && parts[2] === 'presets' && parts[3] === 'shared' && method === 'GET') {
    const shareToken = parts[4];
    try {
      const preset = await prisma.dashboardLayoutPreset.findUnique({
        where: { shareToken },
        select: { id: true, name: true, description: true, creatorId: true, guildId: true, layout: true, isPublic: true, shareToken: true, createdAt: true, updatedAt: true }
      });
      if (!preset || !preset.isPublic) {
        json(res, 404, { error: 'Preset partagé introuvable.' });
        return true;
      }
      json(res, 200, { preset });
    } catch (err) {
      logger.error('GeneralAPI', `Error fetching shared preset ${shareToken}:`, err);
      json(res, 500, { error: 'Erreur lors de la récupération du preset partagé.' });
    }
    return true;
  }

  return false;
}

export async function handleGuildGeneralRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

  // GET /api/dashboard/guilds/:guildId or /api/dashboard/guilds/:guildId/state
  if ((parts.length === 4 || (parts.length === 5 && parts[4] === 'state')) && method === 'GET') {
    try {
      const state = await getGuildState(client, guildId, access, user.userId, {
        overview: url.searchParams.get('scope') === 'overview',
      });
      if (!state) {
        json(res, 404, { error: 'Guilde introuvable' });
        return true;
      }
      json(res, 200, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('GeneralAPI', `Error getting guild state for ${guildId}:`, err);
      const hint = /column|sidebarFavorites|commandRestrictions|channelId/i.test(message)
        ? 'Exécutez les migrations Prisma : bun run db:migrate:deploy'
        : undefined;
      json(res, 500, {
        error: "Erreur interne de chargement de l'état de la guilde",
        ...(hint ? { hint } : {}),
      });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/onboarding/complete - clore le parcours
  //
  // La seule sortie du tunnel qui ne passe pas par un paiement, et elle ne
  // s'ouvre que pour un serveur qui n'a rien a payer : instance sans
  // facturation, ou acces deja accorde (offre posee a la main, abonnement,
  // code de partenariat). Ailleurs, c'est Stripe qui clot le parcours, par
  // `syncSubscription` - sans quoi cette route serait le contournement qu'on
  // vient precisement de retirer.
  //
  // L'ecriture est deja reservee aux administrateurs du dashboard par la garde
  // commune (`handleDashboardRoutes`) : personne d'autre ne peut l'appeler.
  if (parts.length === 6 && parts[4] === 'onboarding' && parts[5] === 'complete' && method === 'POST') {
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          onboardingCompletedAt: true,
          plan: true,
          stripeSubscriptionId: true,
          accessType: true,
          activationCode: true,
        },
      });

      if (!guild) {
        json(res, 404, { error: 'Guilde introuvable' });
        return true;
      }

      // Deja clos, ou instance qui ne presente pas de parcours : rejouer
      // l'appel ne doit pas devenir une erreur, la page peut le refaire apres
      // un retour de paiement ou un simple rafraichissement.
      if (!guild.onboardingCompletedAt && isOnboardingFeatureEnabled()) {
        if (!canFinishOnboardingWithoutPayment(guild)) {
          json(res, 402, {
            error: "La mise en service passe par le paiement : le parcours ne peut pas être clos ici.",
          });
          return true;
        }

        await markOnboardingComplete(guildId, 'dernier écran, rien à payer');
      }

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('GeneralAPI', `Error completing onboarding for ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de la clôture du parcours de configuration.' });
    }
    return true;
  }

  // GET|PUT /api/dashboard/guilds/:guildId/onboarding/state - reprise du parcours
  //
  // Le navigateur reste la source rapide : il ecrit a chaque clic, sans
  // attendre le reseau, et le parcours n'a jamais a patienter pour avancer.
  // Cette route ne fait que doubler cette memoire, pour qu'un changement
  // d'appareil ne reparte pas du premier ecran.
  //
  // Le corps n'est pas relu ligne a ligne : ce sont les reponses d'un
  // formulaire que le dashboard se relit a lui-meme, aucune n'est appliquee a
  // Discord depuis ici - chaque etape ecrit par sa propre route, gardee comme
  // il faut. On borne en revanche la taille : une colonne JSON libre est une
  // invitation a y deposer autre chose que le parcours.
  if (parts.length === 6 && parts[4] === 'onboarding' && parts[5] === 'state') {
    if (method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { onboardingState: true },
        });
        if (!guild) {
          json(res, 404, { error: 'Guilde introuvable' });
          return true;
        }
        // Le parcours vient de se charger : quelqu'un est reellement venu se
        // servir du bot, la ou beaucoup de serveurs le posent puis l'oublient.
        trackDashboardOpen(guildId);
        json(res, 200, { state: guild.onboardingState ?? null });
      } catch (err) {
        logger.error('GeneralAPI', `Error reading onboarding state for ${guildId}:`, err);
        json(res, 500, { error: "Erreur lors de la lecture du parcours de configuration." });
      }
      return true;
    }

    if (method === 'PUT') {
      try {
        const body = await readJsonBody<{ state?: unknown }>(req);
        const state = body?.state;

        // `null` efface : c'est ce que fait « recommencer le parcours ».
        if (state === null) {
          await prisma.guild.update({ where: { id: guildId }, data: { onboardingState: Prisma.DbNull } });
          json(res, 200, { ok: true });
          return true;
        }

        if (typeof state !== 'object' || Array.isArray(state)) {
          json(res, 400, { error: "L'état du parcours doit être un objet." });
          return true;
        }

        // 16 Ko : le parcours n'y met qu'une poignee de reponses et de clefs
        // d'etapes. Au-dela, ce n'est plus un parcours qu'on enregistre.
        const serialized = JSON.stringify(state);
        if (serialized.length > 16_384) {
          json(res, 413, { error: "L'état du parcours est trop volumineux." });
          return true;
        }

        // L'etape franchie se deduit de la difference : le parcours envoie son
        // etat complet, jamais « je viens de passer tel ecran ». Comparer avant
        // d'ecrire est donc le seul moment ou l'on peut savoir si le visiteur a
        // avance ou recule - et un retour en arriere ne dit pas la meme chose
        // qu'un abandon : il signale un ecran mal compris.
        const previous = await prisma.guild
          .findUnique({ where: { id: guildId }, select: { onboardingState: true } })
          .catch(() => null);
        const previousStep = readWizardStep(previous?.onboardingState);
        const nextStep = readWizardStep(state);

        await prisma.guild.update({
          where: { id: guildId },
          data: { onboardingState: state as Prisma.InputJsonValue },
        });

        if (nextStep && nextStep !== previousStep) {
          if (!previousStep) {
            trackAcquisitionStep({ step: 'onboarding_started', guildId, metadata: { step: nextStep } });
          }
          trackAcquisitionStep({
            step: wentBackward(previousStep, nextStep) ? 'onboarding_back' : 'onboarding_step',
            guildId,
            metadata: { step: nextStep, from: previousStep },
          });
        }

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('GeneralAPI', `Error writing onboarding state for ${guildId}:`, err);
        json(res, 500, { error: "Erreur lors de l'enregistrement du parcours de configuration." });
      }
      return true;
    }
  }

  // GET /api/dashboard/guilds/:guildId/channels - salons Discord (texte, vocal, catégories)
  if (parts.length === 5 && parts[4] === 'channels' && method === 'GET') {
    try {
      let discordGuild = client.guilds.cache.get(guildId) ?? null;
      if (!discordGuild) {
        discordGuild = await client.guilds.fetch(guildId).catch(() => null) as Guild | null;
      }
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur Discord introuvable' });
        return true;
      }
      if (discordGuild.channels.cache.size === 0) {
        await discordGuild.channels.fetch().catch(() => null);
      }
      const allCh = Array.from(discordGuild.channels.cache.values()) as GuildBasedChannel[];
      const textChannelTypes = new Set([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildVoice,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ]);
      const channelTypeLabel = (type: ChannelType) => {
        switch (type) {
          case ChannelType.GuildAnnouncement: return 'announcement';
          case ChannelType.GuildVoice: return 'voice';
          case ChannelType.GuildForum: return 'forum';
          case ChannelType.GuildMedia: return 'media';
          case ChannelType.PublicThread:
          case ChannelType.PrivateThread:
          case ChannelType.AnnouncementThread:
            return 'thread';
          default: return 'text';
        }
      };
      const textChannels = allCh
        .filter((ch) => textChannelTypes.has(ch.type))
        .map((ch) => ({ id: ch.id, name: ch.name, mention: `<#${ch.id}>`, position: 'rawPosition' in ch ? ch.rawPosition : 0, type: channelTypeLabel(ch.type) }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention, type }) => ({ id, name, mention, type }));
      const voiceChannels = allCh
        .filter((ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)
        .map((ch) => ({ id: ch.id, name: ch.name, mention: `<#${ch.id}>`, position: ch.rawPosition ?? 0 }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }));
      const categories = allCh
        .filter((ch) => ch.type === ChannelType.GuildCategory)
        .map((ch) => ({ id: ch.id, name: ch.name, mention: `<#${ch.id}>`, position: ch.rawPosition ?? 0 }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }));

      json(res, 200, { textChannels, voiceChannels, categories });
    } catch (err) {
      logger.error('GeneralAPI', `Error getting guild channels for ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de la récupération des salons Discord' });
    }
    return true;
  }

  // GET|POST /api/dashboard/guilds/:guildId/emojis - emojis personnalisés du serveur
  //
  // Les sélecteurs d'emoji du dashboard (monnaie, objets, quêtes...) ne
  // proposaient que de l'Unicode : un serveur qui a sa propre pièce ne pouvait
  // pas l'utiliser comme symbole de sa monnaie. Cette route expose le jeu
  // d'emojis de la guilde, et laisse en déposer un nouveau sans passer par
  // Discord - l'image est envoyée au serveur et l'emoji y est créé.
  if (parts.length === 5 && parts[4] === 'emojis' && (method === 'GET' || method === 'POST')) {
    let emojiGuild = client.guilds.cache.get(guildId) ?? null;
    if (!emojiGuild) {
      emojiGuild = await client.guilds.fetch(guildId).catch(() => null) as Guild | null;
    }
    if (!emojiGuild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }
    const guild = emojiGuild;

    // Le nombre d'emplacements suit le niveau de boost, et vaut autant pour les
    // emojis fixes que pour les animés : sans ce chiffre, le dashboard ne peut
    // pas dire pourquoi un dépôt est refusé.
    const slotsForTier = (tier: GuildPremiumTier): number => {
      switch (tier) {
        case GuildPremiumTier.Tier1: return 100;
        case GuildPremiumTier.Tier2: return 150;
        case GuildPremiumTier.Tier3: return 250;
        default: return 50;
      }
    };

    const respondWithEmojis = async (status: number, extra: Record<string, unknown> = {}) => {
      if (guild.emojis.cache.size === 0) {
        await guild.emojis.fetch().catch(() => null);
      }
      const emojis = Array.from(guild.emojis.cache.values())
        .map((emoji) => ({
          id: emoji.id,
          name: emoji.name ?? emoji.id,
          animated: emoji.animated === true,
          available: emoji.available !== false,
          url: emoji.imageURL({ size: 64 }),
          // La forme que Discord attend dans un message ou une réaction.
          mention: `<${emoji.animated ? 'a' : ''}:${emoji.name ?? '_'}:${emoji.id}>`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

      json(res, status, {
        emojis,
        slots: {
          total: slotsForTier(guild.premiumTier),
          staticUsed: emojis.filter((e) => !e.animated).length,
          animatedUsed: emojis.filter((e) => e.animated).length,
        },
        canUpload: access.canManageSettings
          && guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions) === true,
        ...extra,
      });
    };

    if (method === 'GET') {
      try {
        await respondWithEmojis(200);
      } catch (err) {
        logger.error('GeneralAPI', `Error listing emojis for ${guildId}:`, err);
        json(res, 500, { error: 'Erreur lors de la récupération des emojis du serveur' });
      }
      return true;
    }

    // Créer un emoji modifie le serveur Discord, pas seulement un réglage :
    // c'est une écriture réservée aux administrateurs du dashboard.
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Accès refusé' });
      return true;
    }

    try {
      const body = await readJsonBody<{ name?: string; mimeType?: string; data?: string }>(req);
      const rawName = (body?.name ?? '').trim();
      const mimeType = (body?.mimeType ?? '').trim().toLowerCase();
      const data = body?.data ?? '';

      if (!rawName || !mimeType || !data) {
        json(res, 400, { error: 'name, mimeType et data sont requis.' });
        return true;
      }

      // Discord n'accepte que lettres, chiffres et tirets bas, entre 2 et 32
      // caractères. Corriger silencieusement serait pire : l'utilisateur
      // chercherait ensuite un emoji qui ne porte pas le nom qu'il a saisi.
      if (!/^\w{2,32}$/.test(rawName)) {
        json(res, 400, { error: "Nom d'emoji invalide : 2 à 32 caractères, lettres, chiffres et tirets bas uniquement." });
        return true;
      }

      if (!GUILD_EMOJI_MIME_TYPES.includes(mimeType)) {
        json(res, 400, { error: 'Format non supporté. Utilisez PNG, JPEG, GIF ou WEBP.' });
        return true;
      }

      const buffer = Buffer.from(data, 'base64');
      if (buffer.length === 0) {
        json(res, 400, { error: 'Image vide ou illisible.' });
        return true;
      }
      if (buffer.length > GUILD_EMOJI_MAX_BYTES) {
        json(res, 413, { error: `Image trop lourde : ${Math.round(GUILD_EMOJI_MAX_BYTES / 1024)} Ko maximum.` });
        return true;
      }

      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
        json(res, 403, { error: "Le bot n'a pas la permission « Gérer les expressions » sur ce serveur." });
        return true;
      }

      const created = await guild.emojis.create({
        attachment: buffer,
        name: rawName,
        reason: `Emoji ajouté depuis le dashboard par ${user.userId}`,
      });

      await respondWithEmojis(201, {
        created: {
          id: created.id,
          name: created.name ?? rawName,
          animated: created.animated === true,
          url: created.imageURL({ size: 64 }),
          mention: `<${created.animated ? 'a' : ''}:${created.name ?? rawName}:${created.id}>`,
        },
      });
    } catch (err) {
      // Emplacements saturés, image refusée par Discord : le message de l'API
      // est plus utile que « erreur interne », c'est lui qui dit quoi faire.
      const apiMessage = err instanceof DiscordAPIError ? err.message : null;
      logger.error('GeneralAPI', `Error creating emoji for ${guildId}:`, err);
      json(res, apiMessage ? 400 : 500, { error: apiMessage ?? "Erreur lors de la création de l'emoji" });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/activate - Activate a guild with a code
  if (parts.length === 5 && parts[4] === 'activate' && method === 'POST') {
    try {
      const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
      const canActivate = isGlobalAdmin || access.level === 'admin';
      if (!canActivate) {
        json(res, 403, { error: 'Seuls les administrateurs du serveur ou les administrateurs globaux peuvent activer ce serveur.' });
        return true;
      }

      const body = await readJsonBody<{ code?: string }>(req);
      const rawCode = body?.code?.trim() || '';
      if (!rawCode) {
        json(res, 400, { error: "Le code d'activation est requis." });
        return true;
      }

      const codeRow = await prisma.activationCode.findUnique({
        where: { code: rawCode.toUpperCase() }
      });

      if (!codeRow) {
        json(res, 404, { error: "Code d'activation introuvable." });
        return true;
      }

      if (!codeRow.isActive || codeRow.usedAt) {
        json(res, 400, { error: "Ce code d'activation a déjà été utilisé ou est désactivé." });
        return true;
      }

      await activateGuild(guildId, rawCode);
      json(res, 200, { ok: true, message: 'Le serveur a été activé avec succès.' });
    } catch (err) {
      logger.error('GeneralAPI', `Error activating guild ${guildId}:`, err);
      json(res, 500, { error: "Erreur lors de l'activation du serveur." });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/user-settings
  if (parts.length === 5 && parts[4] === 'user-settings' && method === 'GET') {
    try {
      const settings = await prisma.dashboardUserSettings.findUnique({
        where: {
          guildId_userId: {
            guildId,
            userId: user.userId
          }
        }
      });
      
      if (!settings) {
        json(res, 200, {
          bentoLayout: null,
          themeId: 'dark',
          customTheme: null,
          accentColor: 'violet',
          sidebarBehavior: 'auto',
          compactMode: false,
          // Nul = suivre le fuseau du navigateur, ce que le dashboard resout
          // lui-meme : le serveur n'a pas a deviner d'ou on le consulte.
          timezone: null
        });
        return true;
      }
      
      json(res, 200, {
        bentoLayout: settings.bentoLayout,
        themeId: settings.themeId,
        customTheme: settings.customTheme,
        accentColor: settings.accentColor,
        sidebarBehavior: settings.sidebarBehavior,
        compactMode: settings.compactMode,
        timezone: settings.timezone
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error fetching user-settings for ${guildId} / ${user.userId}:`, err);
      json(res, 500, { error: 'Erreur lors de la récupération des préférences.' });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/user-settings
  if (parts.length === 5 && parts[4] === 'user-settings' && method === 'PUT') {
    try {
      const body = await readJsonBody<any>(req);
      const settings = await prisma.dashboardUserSettings.upsert({
        where: {
          guildId_userId: {
            guildId,
            userId: user.userId
          }
        },
        create: {
          guildId,
          userId: user.userId,
          bentoLayout: body?.bentoLayout ?? null,
          themeId: body?.themeId ?? 'dark',
          customTheme: body?.customTheme ?? null,
          accentColor: body?.accentColor ?? 'violet',
          sidebarBehavior: body?.sidebarBehavior ?? 'auto',
          compactMode: body?.compactMode ?? false,
          timezone: normalizeStoredTimezone(body?.timezone)
        },
        update: {
          bentoLayout: body?.bentoLayout !== undefined ? body.bentoLayout : undefined,
          themeId: body?.themeId !== undefined ? body.themeId : undefined,
          customTheme: body?.customTheme !== undefined ? body.customTheme : undefined,
          accentColor: body?.accentColor !== undefined ? body.accentColor : undefined,
          sidebarBehavior: body?.sidebarBehavior !== undefined ? body.sidebarBehavior : undefined,
          compactMode: body?.compactMode !== undefined ? body.compactMode : undefined,
          timezone: body?.timezone !== undefined ? normalizeStoredTimezone(body.timezone) : undefined
        }
      });
      
      json(res, 200, {
        ok: true,
        settings: {
          bentoLayout: settings.bentoLayout,
          themeId: settings.themeId,
          customTheme: settings.customTheme,
          accentColor: settings.accentColor,
          sidebarBehavior: settings.sidebarBehavior,
          compactMode: settings.compactMode,
          timezone: settings.timezone
        }
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error updating user-settings for ${guildId} / ${user.userId}:`, err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des préférences.' });
    }
    return true;
  }

  // ============================================================================
  // BENTO LAYOUT PRESETS
  // ============================================================================

  // GET /api/dashboard/guilds/:guildId/layout-presets
  if (parts.length === 5 && parts[4] === 'layout-presets' && method === 'GET') {
    try {
      const presets = await prisma.dashboardLayoutPreset.findMany({
        where: { guildId, creatorId: user.userId },
        orderBy: { updatedAt: 'desc' }
      });
      json(res, 200, { presets });
    } catch (err) {
      logger.error('GeneralAPI', `Error fetching presets for ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de la récupération des presets.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/layout-presets
  if (parts.length === 5 && parts[4] === 'layout-presets' && method === 'POST') {
    try {
      const body = await readJsonBody<{ name: string; description?: string; layout: any[]; isPublic?: boolean }>(req);
      if (!body?.name || !body?.layout) {
        json(res, 400, { error: 'Nom et layout requis.' });
        return true;
      }
      const preset = await prisma.dashboardLayoutPreset.create({
        data: {
          guildId,
          creatorId: user.userId,
          name: body.name,
          description: body.description || '',
          layout: body.layout,
          isPublic: body.isPublic ?? false
        }
      });
      json(res, 201, { preset });
    } catch (err) {
      logger.error('GeneralAPI', `Error creating preset for ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de la création du preset.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/layout-presets/import
  if (parts.length === 6 && parts[4] === 'layout-presets' && parts[5] === 'import' && method === 'POST') {
    try {
      const body = await readJsonBody<{ name: string; description?: string; layout: any[] }>(req);
      if (!body?.name || !body?.layout) {
        json(res, 400, { error: 'Nom et layout requis.' });
        return true;
      }
      const preset = await prisma.dashboardLayoutPreset.create({
        data: {
          guildId,
          creatorId: user.userId,
          name: body.name,
          description: body.description || 'Importé',
          layout: body.layout,
          isPublic: false
        }
      });
      json(res, 201, { preset });
    } catch (err) {
      logger.error('GeneralAPI', `Error importing preset for ${guildId}:`, err);
      json(res, 500, { error: 'Erreur lors de l\'import du preset.' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/layout-presets/:presetId
  if (parts.length === 6 && parts[4] === 'layout-presets' && method === 'DELETE') {
    const presetId = parts[5];
    try {
      const existing = await prisma.dashboardLayoutPreset.findFirst({
        where: { id: presetId, guildId, creatorId: user.userId }
      });
      if (!existing) {
        json(res, 404, { error: 'Preset introuvable ou accès refusé.' });
        return true;
      }
      await prisma.dashboardLayoutPreset.delete({ where: { id: presetId } });
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('GeneralAPI', `Error deleting preset ${presetId}:`, err);
      json(res, 500, { error: 'Erreur lors de la suppression du preset.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/layout-presets/:presetId/share
  if (parts.length === 7 && parts[4] === 'layout-presets' && parts[6] === 'share' && method === 'POST') {
    const presetId = parts[5];
    try {
      const existing = await prisma.dashboardLayoutPreset.findFirst({
        where: { id: presetId, guildId, creatorId: user.userId }
      });
      if (!existing) {
        json(res, 404, { error: 'Preset introuvable ou accès refusé.' });
        return true;
      }
      // Generate a unique share token
      const shareToken = existing.shareToken ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      const updated = await prisma.dashboardLayoutPreset.update({
        where: { id: presetId },
        data: { shareToken, isPublic: true }
      });
      json(res, 200, { shareToken: updated.shareToken, shareUrl: `/?importPreset=${updated.shareToken}` });
    } catch (err) {
      logger.error('GeneralAPI', `Error sharing preset ${presetId}:`, err);
      json(res, 500, { error: 'Erreur lors du partage du preset.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/layout-presets/:presetId/apply
  if (parts.length === 7 && parts[4] === 'layout-presets' && parts[6] === 'apply' && method === 'POST') {
    const presetId = parts[5];
    try {
      // User can apply their own presets or public ones
      const preset = await prisma.dashboardLayoutPreset.findFirst({
        where: { id: presetId, guildId, OR: [{ creatorId: user.userId }, { isPublic: true }] }
      });
      if (!preset) {
        json(res, 404, { error: 'Preset introuvable ou accès refusé.' });
        return true;
      }
      // Apply by updating user settings
      await prisma.dashboardUserSettings.upsert({
        where: { guildId_userId: { guildId, userId: user.userId } },
        create: { guildId, userId: user.userId, bentoLayout: preset.layout as Prisma.InputJsonValue },
        update: { bentoLayout: preset.layout as Prisma.InputJsonValue }
      });
      json(res, 200, { ok: true, layout: preset.layout });
    } catch (err) {
      logger.error('GeneralAPI', `Error applying preset ${presetId}:`, err);
      json(res, 500, { error: 'Erreur lors de l\'application du preset.' });
    }
    return true;
  }

  return false;
}
