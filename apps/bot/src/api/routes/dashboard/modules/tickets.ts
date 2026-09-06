/** Routes dashboard du module `tickets`. */
import { cache } from '../../../../utils/cache.js';
import prisma from '../../../../utils/db.js';
import { COLORS, successEmbed } from '../../../../utils/embeds.js';
import { errorMessage, errorStack } from '../../../../utils/errors.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { logger } from '../../../../utils/logger.js';
import * as m from '../../../../lib/paraglide/messages.js';
import { broadcastDashboardStateChange, extractMediaUrls, getDashboardUrl, getGuildName, json, parseDiscordMarkdown, pushAudit, readJsonBody, resolveMemberFeatureAccess } from '../../../shared.js';
import { type ProvisionedEntry, acquireProvisionLock, missingProvisionPermissions, provisionCooldown, provisionCooldownMessage, releaseProvisionLock, startProvisionCooldown } from '../../../../services/core/channelProvisioningService.js';
import { Prisma } from '@prisma/client';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type ColorResolvable, EmbedBuilder, type OverwriteResolvable, PermissionFlagsBits, TextChannel } from 'discord.js';
import { type ModuleRouteContext, msgEmbedsMap } from './_shared.js';
import { clampCommentTimeout } from '../../../../services/features/ticketSatisfactionService.js';

/** Champs acceptes pour une macro, valides un par un plutot qu'en bloc. */
type MacroData = {
  name: string;
  category: string | null;
  emoji: string | null;
  content: string;
  enabled: boolean;
  position: number;
  ticketTypeIds: string[];
  allowedRoleIds: string[];
  keywords: string[];
  autoSendOnOpen: boolean;
  setTicketTypeId: string | null;
  addRoleId: string | null;
  removeRoleId: string | null;
  requestSatisfaction: boolean;
  closeTicket: boolean;
};

/**
 * Valide le corps d'une macro. Nom et contenu sont les deux seuls champs
 * obligatoires : une macro sans texte n'a rien a envoyer, une macro sans nom
 * est introuvable dans le selecteur Discord.
 */
function parseMacroInput(body: Record<string, unknown>): { data: MacroData } | { error: string } {
  const text = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 50) : [];

  const name = text(body.name, 100);
  if (!name) return { error: 'Le nom de la macro est obligatoire.' };

  // 2000 caracteres : la limite d'un message Discord. Au-dela, l'envoi
  // echouerait au moment ou le staff clique, pas a l'enregistrement.
  const content = text(body.content, 2000);
  if (!content) return { error: 'Le contenu de la macro est obligatoire.' };

  const position = Number(body.position);

  return {
    data: {
      name,
      category: text(body.category, 60) || null,
      emoji: text(body.emoji, 16) || null,
      content,
      enabled: body.enabled !== false,
      position: Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0,
      ticketTypeIds: ids(body.ticketTypeIds),
      allowedRoleIds: ids(body.allowedRoleIds),
      keywords: Array.isArray(body.keywords)
        ? body.keywords
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim().slice(0, 60))
            .filter((v) => v.length > 0)
            .slice(0, 50)
        : [],
      autoSendOnOpen: body.autoSendOnOpen === true,
      setTicketTypeId: text(body.setTicketTypeId, 100) || null,
      addRoleId: text(body.addRoleId, 40) || null,
      removeRoleId: text(body.removeRoleId, 40) || null,
      requestSatisfaction: body.requestSatisfaction === true,
      closeTicket: body.closeTicket === true,
    },
  };
}

export async function handleTicketsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, url, client, user, guildId, access, method, auditUser, moduleKey } = ctx;

  // Tickets routes
  if (moduleKey === 'tickets') {
    const isStaff = access.level === 'admin' || access.level === 'moderator';
    if (!isStaff) {
      json(res, 403, { error: 'Accès refusé. Réservé au staff.' });
      return true;
    }

    // Masquer la section dans la navigation ne suffit pas : sans ce controle,
    // l'URL et l'API continuent de servir les tickets et leurs transcripts a
    // un staff a qui le role interdit la page.
    const featureAccess = await resolveMemberFeatureAccess(client, guildId, access, user.userId);
    if (!featureAccess.tickets?.canView) {
      json(res, 403, { error: 'Accès refusé. Votre rôle ne donne pas accès aux tickets.' });
      return true;
    }

    // Voir n'est pas effacer : sans ce controle, tout staff a qui la section
    // est ouverte pouvait supprimer une macro ou vider la liste noire.
    const canDeleteTickets = () => !!featureAccess.tickets?.canDelete;

    // GET /api/dashboard/guilds/:guildId/tickets/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
      try {
        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            ticketCategoryId: true,
            ticketLogChannelId: true,
            ticketStaffRoleId: true,
            ticketChannelId: true,
            ticketEmbedTitle: true,
            ticketEmbedDesc: true,
            ticketEmbedButtonText: true,
            ticketEmbedColor: true,
            ticketEmbedType: true,
            ticketMode: true,
            ticketDmRelayChannelId: true,
            ticketTypes: true,
            ticketFormEnabled: true,
            ticketFormCustomFields: true,
            ticketEmbedThumbnail: true,
            ticketEmbedImage: true,
            ticketEmbedFooter: true,
            ticketEmbedAuthorName: true,
            ticketEmbedAuthorIcon: true,
            ticketWelcomeTitle: true,
            ticketWelcomeDesc: true,
            ticketWelcomeColor: true,
            ticketWelcomeThumbnail: true,
            ticketWelcomeImage: true,
            ticketWelcomeFooter: true,
            ticketAllowOverclaim: true,
            ticketOverclaimPermission: true,
            ticketAutoClaimOnReply: true,
            ticketInactivityEnabled: true,
            ticketInactivityHours: true,
            ticketInactivityMessage: true,
            ticketSatisfactionCommentEnabled: true,
            ticketSatisfactionCommentQuestion: true,
            ticketSatisfactionCommentTimeout: true,
            ticketSatisfactionLogChannelId: true,
            ticketSatisfactionLogAnonymous: true,
            ticketLockUntilClaim: true,
            ticketApprovalEnabled: true,
            ticketApprovalChannelId: true,
            ticketArchiveCategoryId: true,
            ticketArchiveKeepOpenerView: true,
            ticketHistoryPanelEnabled: true,
            ticketSelfReopenEnabled: true,
            ticketSelfDeleteEnabled: true,
            ticketQuotaOpenEnabled: true,
            ticketQuotaOpenMax: true,
            ticketQuotaCooldownEnabled: true,
            ticketQuotaCooldownMinutes: true,
            ticketQuotaPeriodEnabled: true,
            ticketQuotaPeriodMax: true,
            ticketQuotaPeriodHours: true,
            ticketQuotaStaffLoadMode: true,
            ticketQuotaStaffLoadMax: true,
            ticketQuotaStaffLoadBypassRoleIds: true,
            ticketQuotaReopenEnabled: true,
            ticketQuotaReopenMax: true,
          }
        });
        json(res, 200, guildConfig || {});
      } catch (err) {
        logger.error('TicketsAPI', 'Error getting ticket config:', err);
        json(res, 500, { error: 'Erreur configuration' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets/transcripts?q=&from=&to=&limit=&offset=
    if (parts.length === 6 && parts[5] === 'transcripts' && method === 'GET') {
      try {
        const q = url.searchParams.get('q')?.trim() || '';
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
        const includeTotal = url.searchParams.get('includeTotal') !== 'false';

        const where: Record<string, unknown> = { guildId };
        if (q) {
          where.OR = [
            { channelName: { contains: q, mode: 'insensitive' } },
            { channelId: { contains: q } },
            { id: { contains: q } },
          ];
        }
        if (from || to) {
          const createdAt: Record<string, Date> = {};
          if (from) { const d = new Date(from); if (!isNaN(d.getTime())) createdAt.gte = d; }
          if (to) { const d = new Date(to); if (!isNaN(d.getTime())) createdAt.lte = d; }
          if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
        }

        const [transcripts, total] = await Promise.all([
          prisma.transcript.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: offset,
            take: limit,
            select: {
              id: true,
              guildId: true,
              channelId: true,
              channelName: true,
              startMessageId: true,
              endMessageId: true,
              startTime: true,
              endTime: true,
              createdAt: true
            }
          }),
          includeTotal ? prisma.transcript.count({ where }) : Promise.resolve(null),
        ]);
        json(res, 200, { transcripts, total, limit, offset });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error listing transcripts: ${(err as Error).message}`);
        json(res, 500, { error: 'Erreur lors de la récupération des transcriptions' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/tickets/transcripts/:transcriptId
    if (parts.length === 7 && parts[5] === 'transcripts' && method === 'DELETE') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer des transcriptions.' });
        return true;
      }
      const transcriptId = parts[6];
      if (!/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
        json(res, 400, { error: 'ID de transcription invalide' });
        return true;
      }
      try {
        const transcript = await prisma.transcript.findUnique({
          where: { id: transcriptId },
          select: { id: true, guildId: true },
        });
        if (!transcript || transcript.guildId !== guildId) {
          json(res, 404, { error: 'Transcription introuvable' });
          return true;
        }
        await prisma.transcript.delete({ where: { id: transcriptId } });
        json(res, 200, { ok: true });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error deleting transcript: ${(err as Error).message}`);
        json(res, 500, { error: 'Erreur lors de la suppression de la transcription' });
      }
      return true;
    }

    // Une transcription s'ouvre uniquement par la page /transcripts/:id du
    // dashboard, qui verifie les droits via /api/public/transcripts/:id/access
    // avant de charger le HTML signe dans son iframe. Le second point d'entree
    // qui vivait ici (.../tickets/transcripts/:id/signed-url) distribuait le
    // meme lien signe sans passer par cette page : il a ete retire.

    // PATCH /api/dashboard/guilds/:guildId/tickets/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent modifier la configuration.' });
        return true;
      }

      interface TicketConfigInput {
        ticketCategoryId?: string | null;
        ticketLogChannelId?: string | null;
        ticketStaffRoleId?: string | null;
        ticketChannelId?: string | null;
        ticketEmbedTitle?: string | null;
        ticketEmbedDesc?: string | null;
        ticketEmbedButtonText?: string | null;
        ticketEmbedColor?: string | null;
        ticketEmbedType?: string | null;
        ticketMode?: string | null;
        ticketDmRelayChannelId?: string | null;
        ticketFormEnabled?: boolean | null;
        ticketFormCustomFields?: Record<string, unknown> | unknown[] | null;
        ticketEmbedThumbnail?: string | null;
        ticketEmbedImage?: string | null;
        ticketEmbedFooter?: string | null;
        ticketEmbedAuthorName?: string | null;
        ticketEmbedAuthorIcon?: string | null;
        ticketWelcomeTitle?: string | null;
        ticketWelcomeDesc?: string | null;
        ticketWelcomeColor?: string | null;
        ticketWelcomeThumbnail?: string | null;
        ticketWelcomeImage?: string | null;
        ticketWelcomeFooter?: string | null;
        /** Types de tickets proposes a l'ouverture, valides plus bas champ par champ. */
        ticketTypes?: unknown;
        ticketAllowOverclaim?: unknown;
        ticketInactivityEnabled?: unknown;
        ticketInactivityHours?: unknown;
        ticketInactivityMessage?: unknown;
        ticketSatisfactionCommentEnabled?: unknown;
        ticketSatisfactionCommentQuestion?: unknown;
        ticketSatisfactionCommentTimeout?: unknown;
        ticketSatisfactionLogChannelId?: string | null;
        ticketSatisfactionLogAnonymous?: unknown;
        ticketOverclaimPermission?: unknown;
        ticketAutoClaimOnReply?: unknown;
        ticketLockUntilClaim?: unknown;
        ticketApprovalEnabled?: unknown;
        ticketApprovalChannelId?: string | null;
        ticketArchiveCategoryId?: string | null;
        ticketArchiveKeepOpenerView?: unknown;
        ticketHistoryPanelEnabled?: unknown;
        ticketSelfReopenEnabled?: unknown;
        ticketSelfDeleteEnabled?: unknown;
        ticketQuotaOpenEnabled?: unknown;
        ticketQuotaOpenMax?: unknown;
        ticketQuotaCooldownEnabled?: unknown;
        ticketQuotaCooldownMinutes?: unknown;
        ticketQuotaPeriodEnabled?: unknown;
        ticketQuotaPeriodMax?: unknown;
        ticketQuotaPeriodHours?: unknown;
        ticketQuotaStaffLoadMode?: unknown;
        ticketQuotaStaffLoadMax?: unknown;
        ticketQuotaStaffLoadBypassRoleIds?: unknown;
        ticketQuotaReopenEnabled?: unknown;
        ticketQuotaReopenMax?: unknown;
      }

      /**
       * Surcharge numerique d'un type de ticket. Absente ou invalide = `null`,
       * c'est-a-dire « suivre le serveur » - la meme convention que
       * `inheritedFlag` pour les booleens.
       */
      const inheritedNumber = (value: unknown, max: number): number | null => {
        const parsed = Number(value);
        if (value === null || value === undefined || value === '' || !Number.isFinite(parsed)) return null;
        return Math.min(max, Math.max(1, Math.floor(parsed)));
      };

      /**
       * Borne un quota numerique. Le plancher est a 1 : un quota a 0 fermerait
       * la fonction en silence, ce qui se regle en decochant l'interrupteur.
       */
      const quotaNumber = (value: unknown, fallback: number, max: number): number => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(1, Math.floor(parsed)));
      };

      /** Reglage tri-etat d'un type de ticket : `null` = suivre le serveur. */
      const inheritedFlag = (value: unknown): boolean | null => {
        if (value === true) return true;
        if (value === false) return false;
        return null;
      };

      /**
       * Questions personnalisees d'un type de ticket. Le dashboard envoie de la
       * saisie libre : on borne ici tout ce que Discord refuse a l'ouverture
       * (intitule vide, identifiant absent ou en double, style inconnu), sans
       * quoi un seul champ bancal fait echouer le formulaire entier cote bot.
       */
      const customFormFields = (value: unknown): Array<Record<string, unknown>> | null => {
        if (!Array.isArray(value)) return null;
        const usedIds = new Set<string>();
        return value
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item, index: number) => {
            const style = item.style === 'PARAGRAPH' || item.style === 'SELECT' || item.style === 'RADIO' || item.style === 'FILE'
              ? item.style
              : 'SHORT';
            // Les choix arrivent en tableau, ou en texte a virgules si le
            // dashboard n'a pas eu le temps de les decouper.
            const rawChoices = Array.isArray(item.choices)
              ? item.choices
              : typeof item.choicesString === 'string'
                ? item.choicesString.split(',')
                : [];
            const requestedId = typeof item.id === 'string' ? item.id.trim() : '';
            let id = requestedId || `field_${index + 1}`;
            while (usedIds.has(id)) id = `${id}_${index + 1}`;
            usedIds.add(id);
            return {
              id,
              label: typeof item.label === 'string' ? item.label.trim().slice(0, 45) : '',
              placeholder: typeof item.placeholder === 'string' ? item.placeholder.trim().slice(0, 100) : '',
              style,
              required: item.required !== false,
              // 25 options pour un menu deroulant, 5 boutons pour un radio.
              choices: rawChoices
                .map((choice: unknown) => String(choice ?? '').trim().slice(0, 100))
                .filter((choice: string) => choice.length > 0)
                .slice(0, style === 'RADIO' ? 5 : 25),
            };
          })
          .filter((field) => field.label.length > 0)
          .slice(0, 5);
      };

      try {
        const body = (await readJsonBody<TicketConfigInput>(req)) ?? {};
        const updated = await prisma.guild.update({
          where: { id: guildId },
          data: {
            ticketCategoryId: body.ticketCategoryId || null,
            ticketLogChannelId: body.ticketLogChannelId || null,
            ticketStaffRoleId: body.ticketStaffRoleId || null,
            ticketChannelId: body.ticketChannelId || null,
            // Un champ vide est conserve tel quel : c'est ainsi que le bot sait
            // qu'il doit composer le texte par defaut dans la langue du serveur.
            // Y reecrire un texte francais le figerait a chaque enregistrement.
            ticketEmbedTitle: body.ticketEmbedTitle ?? '',
            ticketEmbedDesc: body.ticketEmbedDesc ?? '',
            ticketEmbedButtonText: body.ticketEmbedButtonText ?? '',
            ticketEmbedColor: body.ticketEmbedColor || '#5865F2',
            ticketEmbedType: body.ticketEmbedType === 'DROPDOWN' ? 'DROPDOWN' : 'BUTTONS',
            ticketMode: body.ticketMode === 'DM' || body.ticketMode === 'THREAD' ? body.ticketMode : 'CHANNEL',
            ticketDmRelayChannelId: body.ticketDmRelayChannelId || null,
            ticketFormEnabled: body.ticketFormEnabled ?? true,
            ticketFormCustomFields: (body.ticketFormCustomFields ?? null) as Prisma.InputJsonValue,
            ticketEmbedThumbnail: body.ticketEmbedThumbnail || null,
            ticketEmbedImage: body.ticketEmbedImage || null,
            ticketEmbedFooter: body.ticketEmbedFooter || null,
            ticketEmbedAuthorName: body.ticketEmbedAuthorName || null,
            ticketEmbedAuthorIcon: body.ticketEmbedAuthorIcon || null,
            ticketWelcomeTitle: body.ticketWelcomeTitle ?? '',
            ticketWelcomeDesc: body.ticketWelcomeDesc ?? '',
            ticketWelcomeColor: body.ticketWelcomeColor || "#5865F2",
            ticketWelcomeThumbnail: body.ticketWelcomeThumbnail || null,
            ticketWelcomeImage: body.ticketWelcomeImage || null,
            ticketWelcomeFooter: body.ticketWelcomeFooter ?? '',
            ...(body.ticketTypes !== undefined
              ? {
                  ticketTypes: Array.isArray(body.ticketTypes)
                    ? body.ticketTypes
                        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
                        .map((item, index: number) => ({
                          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `ticket-type-${index + 1}`,
                          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : `Ticket ${index + 1}`,
                          description: typeof item.description === 'string' ? item.description.trim().slice(0, 200) : null,
                          emoji: typeof item.emoji === 'string' ? item.emoji.trim().slice(0, 16) : null,
                          categoryId: typeof item.categoryId === 'string' && item.categoryId.trim() ? item.categoryId.trim() : null,
                          staffRoleId: typeof item.staffRoleId === 'string' && item.staffRoleId.trim() ? item.staffRoleId.trim() : null,
                          buttonStyle: item.buttonStyle === 'SECONDARY' || item.buttonStyle === 'SUCCESS' || item.buttonStyle === 'DANGER'
                            ? item.buttonStyle
                            : 'PRIMARY',
                          mode: item.mode === 'CHANNEL' || item.mode === 'DM' || item.mode === 'THREAD' ? item.mode : null,
                          anonymous: item.anonymous === true,
                          staffServerRelay: item.staffServerRelay === true,
                          staffServerChannel: item.staffServerChannel === true,
                          staffServerCategoryId: typeof item.staffServerCategoryId === 'string' && item.staffServerCategoryId.trim() ? item.staffServerCategoryId.trim() : null,
                          formEnabled: item.formEnabled !== false,
                          lockUntilClaim: inheritedFlag(item.lockUntilClaim),
                          requireApproval: inheritedFlag(item.requireApproval),
                          fields: Array.isArray(item.fields) ? item.fields : null,
                          formCustomFields: customFormFields(item.formCustomFields),
                          // Surcharges de quota : `null` = herite du serveur.
                          quotaOpenMax: inheritedNumber(item.quotaOpenMax, 50),
                          quotaCooldownMinutes: inheritedNumber(item.quotaCooldownMinutes, 10080),
                          quotaPeriodMax: inheritedNumber(item.quotaPeriodMax, 500),
                          quotaReopenMax: inheritedNumber(item.quotaReopenMax, 50),
                        })) as unknown as Prisma.InputJsonValue
                    : Prisma.JsonNull,
                }
              : {}),
            ticketAllowOverclaim: typeof body.ticketAllowOverclaim === 'boolean' ? body.ticketAllowOverclaim : true,
            ticketOverclaimPermission: typeof body.ticketOverclaimPermission === 'string' ? body.ticketOverclaimPermission : 'ANY',
            ticketAutoClaimOnReply: body.ticketAutoClaimOnReply === true,
            ticketInactivityEnabled: typeof body.ticketInactivityEnabled === 'boolean' ? body.ticketInactivityEnabled : false,
            ticketInactivityHours: body.ticketInactivityHours !== undefined ? Number(body.ticketInactivityHours) : 24,
            ticketInactivityMessage: body.ticketInactivityMessage !== undefined ? String(body.ticketInactivityMessage) : '',
            ticketSatisfactionCommentEnabled: typeof body.ticketSatisfactionCommentEnabled === 'boolean' ? body.ticketSatisfactionCommentEnabled : true,
            // Vide = le bot pose sa question par defaut, comme pour les textes d'embed.
            ticketSatisfactionCommentQuestion: typeof body.ticketSatisfactionCommentQuestion === 'string' ? body.ticketSatisfactionCommentQuestion.trim().slice(0, 200) : '',
            ticketSatisfactionCommentTimeout: clampCommentTimeout(body.ticketSatisfactionCommentTimeout),
            ticketSatisfactionLogChannelId: body.ticketSatisfactionLogChannelId || null,
            ticketSatisfactionLogAnonymous: body.ticketSatisfactionLogAnonymous === true,
            ticketLockUntilClaim: body.ticketLockUntilClaim === true,
            ticketApprovalEnabled: body.ticketApprovalEnabled === true,
            ticketApprovalChannelId: body.ticketApprovalChannelId || null,
            ticketArchiveCategoryId: body.ticketArchiveCategoryId || null,
            ticketArchiveKeepOpenerView: body.ticketArchiveKeepOpenerView === true,
            // Ces deux-la sont actifs par defaut : `!== false` et non `=== true`,
            // pour qu'un formulaire qui ne les renvoie pas ne les eteigne pas.
            ticketHistoryPanelEnabled: body.ticketHistoryPanelEnabled !== false,
            ticketSelfReopenEnabled: body.ticketSelfReopenEnabled !== false,
            ticketSelfDeleteEnabled: body.ticketSelfDeleteEnabled === true,
            // Quotas : chaque interrupteur commande, la valeur n'est qu'un seuil.
            ticketQuotaOpenEnabled: body.ticketQuotaOpenEnabled === true,
            ticketQuotaOpenMax: quotaNumber(body.ticketQuotaOpenMax, 1, 50),
            ticketQuotaCooldownEnabled: body.ticketQuotaCooldownEnabled === true,
            ticketQuotaCooldownMinutes: quotaNumber(body.ticketQuotaCooldownMinutes, 30, 10080),
            ticketQuotaPeriodEnabled: body.ticketQuotaPeriodEnabled === true,
            ticketQuotaPeriodMax: quotaNumber(body.ticketQuotaPeriodMax, 5, 500),
            ticketQuotaPeriodHours: quotaNumber(body.ticketQuotaPeriodHours, 24, 720),
            ticketQuotaStaffLoadMode:
              body.ticketQuotaStaffLoadMode === 'WARN' || body.ticketQuotaStaffLoadMode === 'BLOCK'
                ? body.ticketQuotaStaffLoadMode
                : 'OFF',
            ticketQuotaStaffLoadMax: quotaNumber(body.ticketQuotaStaffLoadMax, 5, 200),
            ticketQuotaStaffLoadBypassRoleIds: Array.isArray(body.ticketQuotaStaffLoadBypassRoleIds)
              ? (body.ticketQuotaStaffLoadBypassRoleIds as unknown[]).filter((id): id is string => typeof id === 'string')
              : [],
            ticketQuotaReopenEnabled: body.ticketQuotaReopenEnabled === true,
            ticketQuotaReopenMax: quotaNumber(body.ticketQuotaReopenMax, 3, 50),
          }
        });

        broadcastDashboardStateChange(guildId, 'tickets_updated');
        json(res, 200, { success: true, config: updated });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error updating ticket config: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/config/send-embed
    if (parts.length === 7 && parts[5] === 'config' && parts[6] === 'send-embed' && method === 'POST') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent envoyer le panel.' });
        return true;
      }

      try {
        const { sendTicketSetupEmbed } = await import('../../../../services/features/ticketService.js');
        await sendTicketSetupEmbed(client, guildId);
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error sending ticket setup embed: ${errorMessage(err)}`);
        json(res, 500, { error: errorMessage(err) || "Erreur lors de l'envoi de l'embed" });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/config/setup
    if (parts.length === 7 && parts[5] === 'config' && parts[6] === 'setup' && method === 'POST') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent mettre le module en route.' });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur Discord introuvable.' });
        return true;
      }

      const lockKey = `tickets:${guildId}`;
      if (!acquireProvisionLock(lockKey)) {
        json(res, 409, { error: 'Une mise en route est déjà en cours sur ce serveur.' });
        return true;
      }

      const items: ProvisionedEntry[] = [];
      const data: Prisma.GuildUpdateInput = {};
      // Ecrits au fil de l'eau : si une creation echoue en cours de route, la
      // tentative suivante reprend ce qui existe deja au lieu de le dupliquer.
      const persist = async () => {
        if (Object.keys(data).length > 0) {
          await prisma.guild.update({ where: { id: guildId }, data });
        }
      };

      try {
        const cooldown = await provisionCooldown(lockKey);
        if (cooldown) {
          json(res, 429, { error: provisionCooldownMessage(cooldown, 'La mise en route a déjà été lancée') });
          return true;
        }

        const missing = await missingProvisionPermissions(discordGuild, [PermissionFlagsBits.ManageChannels]);
        if (missing.length > 0) {
          json(res, 400, { error: `Le bot n'a pas les permissions nécessaires : ${missing.join(', ')}.` });
          return true;
        }

        // Les salons crees portent le nom dans la langue du serveur : ils sont
        // lus par ses membres, pas par l'admin qui clique depuis le dashboard.
        // Le motif inscrit au journal d'audit Discord la suit pour la meme
        // raison, c'est le serveur qui le relit.
        const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
        const reason = m.setup_reason_tickets({ user: auditUser }, { locale });

        const { provisionTicketChannels } = await import('../../../../services/features/ticketProvisioning.js');
        const outcome = await provisionTicketChannels(discordGuild, { locale, reason, items, data, persist });

        // Sur un salon repris comme sur un salon neuf : l'envoi retire
        // d'abord les panneaux qui s'y trouvent, donc plus rien a empiler.
        let panelSent = false;
        if (outcome) {
          const { sendTicketSetupEmbed } = await import('../../../../services/features/ticketService.js');
          await sendTicketSetupEmbed(client, guildId);
          panelSent = true;
        }

        // Arme apres l'envoi du panel : un echec a cette etape doit pouvoir
        // etre repris tout de suite, la reprise par identifiant garantissant
        // qu'aucun salon ne sera cree une seconde fois.
        if (items.some(item => item.created)) {
          // Le pseudo seul : l'identifiant Discord alourdit un message d'interface,
          // et le journal d'audit le porte deja pour qui veut remonter la trace.
          await startProvisionCooldown(lockKey, user.username ?? 'Utilisateur');
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise en route tickets',
          context: getGuildName(client, guildId),
          module: 'Tickets',
          eventType: 'Manuel',
          details: `Créés : ${items.filter(i => i.created).map(i => i.name).join(', ') || 'aucun'}. Repris : ${items.filter(i => !i.created).map(i => i.name).join(', ') || 'aucun'}.`,
          channelId: outcome.panelChannelId,
        });

        await cache.invalidateGuild(guildId);
        json(res, 200, { success: true, items, panelSent });
      } catch (err: unknown) {
        await persist().catch(() => null);
        logger.error('TicketsAPI', `Error provisioning ticket module: ${errorMessage(err)}`, errorStack(err));
        json(res, 500, { error: `Mise en route interrompue : ${errorMessage(err)}`, items });
      } finally {
        releaseProvisionLock(lockKey);
      }
      return true;
    }

    // Les routes `blacklist` et `macros` passent avant `/tickets/:ticketId` :
    // sans cela, elles seraient lues comme des identifiants de ticket.

    // GET /api/dashboard/guilds/:guildId/tickets/macros
    if (parts.length === 6 && parts[5] === 'macros' && method === 'GET') {
      try {
        const macros = await prisma.ticketMacro.findMany({
          where: { guildId },
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
        });
        json(res, 200, { macros });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error listing ticket macros: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération des macros' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/macros
    if (parts.length === 6 && parts[5] === 'macros' && method === 'POST') {
      try {
        const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
        const parsed = parseMacroInput(body);
        if ('error' in parsed) {
          json(res, 400, { error: parsed.error });
          return true;
        }

        const macro = await prisma.ticketMacro.create({ data: { guildId, ...parsed.data } });
        json(res, 201, { macro });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error creating ticket macro: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la création de la macro' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/tickets/macros/:macroId
    if (parts.length === 7 && parts[5] === 'macros' && method === 'PATCH') {
      try {
        const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
        const parsed = parseMacroInput(body);
        if ('error' in parsed) {
          json(res, 400, { error: parsed.error });
          return true;
        }

        // `updateMany` plutot que `update` : la clause porte aussi le guildId,
        // ce qui interdit de modifier la macro d'un autre serveur en devinant
        // son identifiant.
        const { count } = await prisma.ticketMacro.updateMany({
          where: { id: parts[6], guildId },
          data: parsed.data,
        });
        if (count === 0) {
          json(res, 404, { error: 'Macro introuvable' });
          return true;
        }

        const macro = await prisma.ticketMacro.findUnique({ where: { id: parts[6] } });
        json(res, 200, { macro });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error updating ticket macro: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la macro' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/tickets/macros/:macroId
    if (parts.length === 7 && parts[5] === 'macros' && method === 'DELETE') {
      if (!canDeleteTickets()) {
        json(res, 403, { error: 'Accès refusé. Votre rôle ne permet pas de supprimer dans les tickets.' });
        return true;
      }
      try {
        const { count } = await prisma.ticketMacro.deleteMany({ where: { id: parts[6], guildId } });
        if (count === 0) {
          json(res, 404, { error: 'Macro introuvable' });
          return true;
        }
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error deleting ticket macro: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression de la macro' });
      }
      return true;
    }


    // GET /api/dashboard/guilds/:guildId/tickets/blacklist
    if (parts.length === 6 && parts[5] === 'blacklist' && method === 'GET') {
      try {
        // Les entrées échues sont purgées à la lecture : la liste montrée au
        // staff ne doit contenir que des interdictions encore en vigueur.
        await prisma.ticketBlacklist.deleteMany({
          where: { guildId, expiresAt: { not: null, lte: new Date() } },
        });

        const entries = await prisma.ticketBlacklist.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
          take: 500,
        });

        const enriched = entries.map((entry) => {
          const cached = client.users.cache.get(entry.userId);
          return {
            ...entry,
            username: entry.username || cached?.username || null,
            avatarUrl: cached?.displayAvatarURL({ size: 64 })
              ?? `https://cdn.discordapp.com/embed/avatars/${(BigInt(entry.userId) >> 22n) % 6n}.png`,
          };
        });

        json(res, 200, { entries: enriched });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error listing ticket blacklist: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération de la blacklist' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/blacklist
    if (parts.length === 6 && parts[5] === 'blacklist' && method === 'POST') {
      try {
        const body = (await readJsonBody<{ userId?: string; reason?: string; durationDays?: unknown; allowReopen?: unknown }>(req)) ?? {};
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
        if (!/^\d{15,25}$/.test(userId)) {
          json(res, 400, { error: 'Identifiant Discord invalide.' });
          return true;
        }

        const durationDays = Number(body.durationDays);
        const expiresAt = Number.isFinite(durationDays) && durationDays > 0
          ? new Date(Date.now() + Math.min(durationDays, 3650) * 24 * 60 * 60 * 1000)
          : null;
        const reason = typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim().slice(0, 500)
          : null;

        // La blacklist ferme la creation de tickets. Elle ne ferme la
        // reouverture d'un dossier deja traite que si le staff le decide : un
        // membre exclu peut avoir un litige en cours a ne pas enterrer.
        const allowReopen = body.allowReopen === true;

        const discordUser = client.users.cache.get(userId) ?? await client.users.fetch(userId).catch(() => null);

        const entry = await prisma.ticketBlacklist.upsert({
          where: { guildId_userId: { guildId, userId } },
          create: {
            guildId,
            userId,
            username: discordUser?.username ?? null,
            reason,
            expiresAt,
            allowReopen,
            addedByUserId: user.userId,
            addedByTag: user.username,
          },
          update: {
            username: discordUser?.username ?? null,
            reason,
            expiresAt,
            allowReopen,
            addedByUserId: user.userId,
            addedByTag: user.username,
          },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Blacklist tickets',
          context: getGuildName(client, guildId),
          module: 'Tickets',
          eventType: 'Manuel',
          details: `${discordUser?.username ?? userId} ne peut plus ouvrir de ticket${expiresAt ? ` jusqu'au ${expiresAt.toISOString()}` : ''}.${allowReopen ? ' Réouverture de ses anciens tickets autorisée.' : ''}${reason ? ` Raison : ${reason}` : ''}`,
          channelId: null,
        });

        json(res, 200, { success: true, entry });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error adding to ticket blacklist: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout à la blacklist" });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/tickets/blacklist/:userId
    if (parts.length === 7 && parts[5] === 'blacklist' && method === 'DELETE') {
      if (!canDeleteTickets()) {
        json(res, 403, { error: 'Accès refusé. Votre rôle ne permet pas de supprimer dans les tickets.' });
        return true;
      }
      const targetUserId = parts[6];
      try {
        const deleted = await prisma.ticketBlacklist.deleteMany({ where: { guildId, userId: targetUserId } });
        if (deleted.count === 0) {
          json(res, 404, { error: 'Entrée introuvable' });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Retrait blacklist tickets',
          context: getGuildName(client, guildId),
          module: 'Tickets',
          eventType: 'Manuel',
          details: `${targetUserId} peut de nouveau ouvrir un ticket.`,
          channelId: null,
        });

        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error removing from ticket blacklist: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors du retrait de la blacklist' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets
    if (parts.length === 5 && method === 'GET') {
      try {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '75', 10) || 75, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
        const requestedStatus = url.searchParams.get('status');
        const status = requestedStatus === 'PENDING' || requestedStatus === 'OPEN' || requestedStatus === 'CLAIMED'
          || requestedStatus === 'CLOSED' || requestedStatus === 'REJECTED'
          ? requestedStatus
          : null;

        const avatarFromCache = (discordId: string, size = 64): string | null => {
          try {
            const cachedUser = client.users.cache.get(discordId);
            if (cachedUser) return cachedUser.displayAvatarURL({ size: size as 64 | 128 });
            // La liste doit rester une lecture locale et rapide. Une URL
            // d'avatar par défaut est déterministe à partir du snowflake, sans
            // déclencher un appel REST Discord par ligne.
            return `https://cdn.discordapp.com/embed/avatars/${(BigInt(discordId) >> 22n) % 6n}.png`;
          } catch {
            return null;
          }
        };

        const [ticketRows, guildConfig] = await Promise.all([
          prisma.ticket.findMany({
            where: { guildId, ...(status ? { status } : {}) },
            orderBy: { createdAt: 'desc' },
            skip: offset,
            // Une ligne supplémentaire permet de signaler la page suivante
            // sans imposer un COUNT(*) à chaque affichage.
            take: limit + 1,
            select: {
              id: true,
              userId: true,
              username: true,
              reason: true,
              status: true,
              claimedById: true,
              claimedByName: true,
              transcriptId: true,
              createdAt: true,
            },
          }),
          prisma.guild.findUnique({
            where: { id: guildId },
            select: {
              ticketCategoryId: true,
              ticketLogChannelId: true,
              ticketStaffRoleId: true,
              ticketChannelId: true,
              ticketEmbedTitle: true,
              ticketEmbedDesc: true,
              ticketEmbedButtonText: true,
              ticketEmbedColor: true,
              ticketEmbedType: true,
              ticketMode: true,
              ticketDmRelayChannelId: true,
              ticketTypes: true,
              ticketFormEnabled: true,
              ticketFormCustomFields: true,
              ticketEmbedThumbnail: true,
              ticketEmbedImage: true,
              ticketEmbedFooter: true,
              ticketEmbedAuthorName: true,
              ticketEmbedAuthorIcon: true,
              ticketWelcomeTitle: true,
              ticketWelcomeDesc: true,
              ticketWelcomeColor: true,
              ticketWelcomeThumbnail: true,
              ticketWelcomeImage: true,
              ticketWelcomeFooter: true,
              ticketAllowOverclaim: true,
              ticketOverclaimPermission: true,
              ticketAutoClaimOnReply: true,
              ticketInactivityEnabled: true,
              ticketInactivityHours: true,
              ticketInactivityMessage: true,
              ticketSatisfactionCommentEnabled: true,
              ticketSatisfactionCommentQuestion: true,
              ticketSatisfactionCommentTimeout: true,
              ticketSatisfactionLogChannelId: true,
              ticketSatisfactionLogAnonymous: true,
              ticketLockUntilClaim: true,
              ticketApprovalEnabled: true,
              ticketApprovalChannelId: true,
            }
          }),
        ]);

        const hasMore = ticketRows.length > limit;
        const tickets = hasMore ? ticketRows.slice(0, limit) : ticketRows;
        const enrichedTickets = tickets.map((t) => {
          const userAvatar = avatarFromCache(t.userId);
          const claimedByAvatar = t.claimedById ? avatarFromCache(t.claimedById) : null;
          return { ...t, userAvatar, claimedByAvatar };
        });

        json(res, 200, {
          tickets: enrichedTickets,
          config: guildConfig || {},
          pagination: {
            limit,
            offset,
            hasMore,
            nextOffset: hasMore ? offset + limit : null,
          },
        });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error listing tickets: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération des tickets' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets/:ticketId
    if (parts.length === 6 && method === 'GET') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findFirst({
          where: { id: ticketId, guildId }
        });

        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        let channelName: string | null = null;
        let messages: unknown[] = [];
        if (ticket.channelId) {
          const discordChannel = client.channels.cache.get(ticket.channelId);
          if (discordChannel && discordChannel instanceof TextChannel) {
            channelName = discordChannel.name;
            try {
              const fetched = await discordChannel.messages.fetch({ limit: 50 });
              const guild = discordChannel.guild;
              messages = fetched.map(m => ({
                id: m.id,
                authorId: m.author.id,
                authorName: m.member?.displayName || m.author.displayName || m.author.username,
                authorAvatar: m.author.displayAvatarURL(),
                isStaff: m.author.bot,
                content: m.content,
                htmlContent: parseDiscordMarkdown(m.content, guild),
                mediaUrls: extractMediaUrls(m.content),
                stickers: m.stickers ? m.stickers.map(s => ({ id: s.id, name: s.name, url: s.url })) : [],
                attachments: m.attachments.map(a => ({ url: a.url, contentType: a.contentType })),
                embeds: msgEmbedsMap(m.embeds, guild),
                createdAt: m.createdAt.toISOString()
              }));
              messages.reverse();
            } catch { /* ignored */ }
          }
        }

        const fetchAvatarDetail = async (discordId: string, size = 128): Promise<string | null> => {
          try {
            const u = client.users.cache.get(discordId) || await client.users.fetch(discordId);
            return u.displayAvatarURL({ size: size as 64 | 128 });
          } catch {
            return `https://cdn.discordapp.com/embed/avatars/${(BigInt(discordId) >> 22n) % 6n}.png`;
          }
        };
        const [userAvatar, claimedByAvatar] = await Promise.all([
          fetchAvatarDetail(ticket.userId, 128),
          ticket.claimedById ? fetchAvatarDetail(ticket.claimedById) : Promise.resolve(null),
        ]);

        json(res, 200, { ticket: { ...ticket, channelName, userAvatar, claimedByAvatar }, messages });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error reading ticket details: ${errorStack(err)}`);
        json(res, 500, { error: `Erreur lors de la récupération du ticket: ${errorStack(err)}` });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/message
    if (parts.length === 7 && parts[6] === 'message' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket || !ticket.channelId) {
          json(res, 404, { error: 'Ticket introuvable ou salon inactif' });
          return true;
        }

        const body = await readJsonBody<{ content: string }>(req);
        if (!body?.content) {
          json(res, 400, { error: 'Contenu du message requis' });
          return true;
        }

        const discordChannel = client.channels.cache.get(ticket.channelId);
        if (!discordChannel || !(discordChannel instanceof TextChannel)) {
          json(res, 400, { error: 'Salon Discord introuvable' });
          return true;
        }

        const sent = await discordChannel.send(`💬 **[Kotbo Dashboard - ${user.username}]** ${body.content}`);
        
        json(res, 200, {
          success: true,
          message: {
            id: sent.id,
            author: {
              id: client.user?.id || 'bot',
              username: 'Kotbo',
              displayName: 'Kotbo',
              avatar: client.user?.displayAvatarURL() || '',
              bot: true
            },
            content: sent.content,
            createdAt: sent.createdAt.toISOString()
          }
        });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error sending message to ticket: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'envoi du message" });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/claim
    if (parts.length === 7 && parts[6] === 'claim' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        if (!guildConfig) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const allowOverclaim = guildConfig.ticketAllowOverclaim ?? true;
        const overclaimPermission = guildConfig.ticketOverclaimPermission || 'ANY';

        if (ticket.status === 'CLAIMED') {
          if (!allowOverclaim || overclaimPermission === 'NONE') {
            json(res, 400, { error: `Ce ticket est déjà pris en charge par ${ticket.claimedByName || ticket.claimedById}.` });
            return true;
          }

          if (ticket.claimedById === user.userId) {
            json(res, 400, { error: 'Vous prenez déjà en charge ce ticket.' });
            return true;
          }

          if (overclaimPermission === 'SUPERIOR_OR_EQUAL') {
            const isDashboardAdmin = access.level === 'admin';
            if (!isDashboardAdmin) {
              const getStaffLevelLocal = async (uid: string) => {
                const staff = await prisma.staffMember.findUnique({
                  where: { guildId_userId: { guildId, userId: uid } }
                });
                if (!staff) return 0;
                const role = await prisma.staffRole.findFirst({
                  where: { guildId, name: staff.grade, enabled: true }
                });
                return role ? role.level : 0;
              };

              const claimantLevel = await getStaffLevelLocal(user.userId);
              const currentLevel = ticket.claimedById ? await getStaffLevelLocal(ticket.claimedById) : 0;

              if (claimantLevel < currentLevel) {
                json(res, 403, { error: 'Votre grade est insuffisant pour sur-revendiquer ce ticket.' });
                return true;
              }
            }
          }
        }

        const updated = await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            status: 'CLAIMED',
            claimedById: user.userId,
            claimedByName: user.username,
            // Prise en charge depuis le dashboard : le verrou d'attente doit
            // tomber comme il le ferait sur un clic Discord.
            ...(ticket.lockUntilClaim ? { lockUntilClaim: false } : {}),
          }
        });

        if (ticket.lockUntilClaim) {
          const { applyTicketLockState } = await import('../../../../services/features/ticketService.js');
          await applyTicketLockState(client, ticket, guildConfig, false);
        }

        if (ticket.channelId) {
          const ch = client.channels.cache.get(ticket.channelId);
          if (ch && ch instanceof TextChannel) {
            try {
              const welcomeMsg = (await ch.messages.fetch({ limit: 50 })).find(m => m.author.id === client.user?.id && m.embeds.length > 0 && m.embeds[0].title?.startsWith('🎫'));
              if (welcomeMsg) {
                const oldEmbed = welcomeMsg.embeds[0];
                if (oldEmbed) {
                  const updatedEmbed = EmbedBuilder.from(oldEmbed)
                    .setColor(COLORS.warning as ColorResolvable)
                    .setDescription(`Ce ticket est actuellement pris en charge par **${user.username}**.\n\n**Auteur :** <@${ticket.userId}>\n**Raison :** ${ticket.reason}\n**Description :** ${ticket.description}`)
                    .setFields([
                      { name: 'Statut', value: `🛠️ Pris en charge par <@${user.userId}>`, inline: true }
                    ]);

                  const componentsList: ButtonBuilder[] = [];
                  if (allowOverclaim && overclaimPermission !== 'NONE') {
                    componentsList.push(
                      new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel('Sur-revendiquer').setStyle(ButtonStyle.Primary).setEmoji('🛠️')
                    );
                  }
                  componentsList.push(
                    new ButtonBuilder().setCustomId(`ticket:info:${ticketId}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
                    new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
                  );

                  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(componentsList);
                  await welcomeMsg.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => null);
                }
              }
            } catch (welcomeErr) {
              logger.error('TicketsAPI', `Error updating welcome embed from dashboard API: ${welcomeErr}`);
            }

            await ch.send({
              embeds: [successEmbed('Pris en charge', `Ce ticket a été revendiqué depuis le Dashboard Kotbo par **${user.username}**.`)]
            }).catch(() => null);
          }
        }

        broadcastDashboardStateChange(guildId, 'tickets_updated');
        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error claiming ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la prise en charge du ticket' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/close
    if (parts.length === 7 && parts[6] === 'close' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const { closeTicket } = await import('../../../../services/features/ticketService.js');
        const updated = await closeTicket(client, ticketId, user.userId, user.username ?? user.userId);

        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error closing ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/reopen
    if (parts.length === 7 && parts[6] === 'reopen' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        // Un ticket archivé sort d'abord des archives : sans cela le salon
        // resterait rangé et muet pendant que le ticket repasse ouvert.
        if (ticket.status === 'ARCHIVED') {
          const { unarchiveTicket } = await import('../../../../services/features/ticketLifecycleService.js');
          await unarchiveTicket(client, ticketId, { id: user.userId, username: user.username || 'Staff' })
            .catch((err) => logger.error('TicketsAPI', `Error unarchiving before reopen: ${errorMessage(err)}`));
        }

        const updated = await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            status: 'OPEN',
            closedById: null,
            closedByName: null,
            closedAt: null,
            archivedById: null,
            archivedByName: null,
            archivedAt: null,
            archivedFromCategoryId: null
          }
        });

        if (ticket.channelId) {
          const ch = client.channels.cache.get(ticket.channelId);
          if (ch && ch instanceof TextChannel) {
            await ch.permissionOverwrites.edit(ticket.userId, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true
            }).catch(() => {});

            const { renameChannelToOpen } = await import('../../../../services/features/ticketService.js');
            await renameChannelToOpen(client, ticket.channelId).catch(() => {});

            await ch.send({
              embeds: [successEmbed('Ticket Réouvert', `Le ticket a été réouvert depuis le Dashboard Kotbo par **${user.username}**.`)]
            }).catch(() => null);
          }
        }

        broadcastDashboardStateChange(guildId, 'tickets_updated');
        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error reopening ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/rename
    if (parts.length === 7 && parts[6] === 'rename' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const body = await readJsonBody<{ name?: string }>(req);
        const requestedName = body?.name?.trim();
        if (!requestedName) {
          json(res, 400, { error: 'Le nouveau nom est requis' });
          return true;
        }

        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        if (!guildConfig) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const { renameTicketChannel } = await import('../../../../services/features/ticketService.js');
        const finalName = await renameTicketChannel(
          client,
          ticket,
          guildConfig!,
          { id: user.userId, username: user.username || 'Utilisateur' },
          requestedName,
        );

        broadcastDashboardStateChange(guildId, 'tickets_updated');
        json(res, 200, { success: true, channelName: finalName });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error renaming ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors du renommage du ticket' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/restore
    if (parts.length === 7 && parts[6] === 'restore' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        // Quotas et rejeu de la transcription vivent dans le service : le
        // bouton Discord de l'historique membre applique exactement les memes
        // regles, ce que deux implantations paralleles ne garantiraient pas.
        const { checkRestoreEligibility, restoreTicketFromTranscript } = await import('../../../../services/features/ticketLifecycleService.js');
        const { resolveTicketQuotas } = await import('../../../../services/features/ticketQuotaService.js');
        const quotaConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { ticketQuotaReopenEnabled: true, ticketQuotaReopenMax: true },
        });
        const eligibility = checkRestoreEligibility(
          ticket,
          resolveTicketQuotas((quotaConfig ?? {}) as Record<string, unknown>).reopenMax,
        );
        if (!eligibility.ok) {
          json(res, 429, { error: eligibility.error });
          return true;
        }

        const result = await restoreTicketFromTranscript(
          client,
          ticketId,
          { id: user.userId, username: user.username || 'Staff' },
          'DASHBOARD',
        );

        json(res, 200, { success: true, channelId: result.channelId, restoreCount: result.ticket.restoreCount });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error restoring ticket: ${errorStack(err)}`);
        json(res, 500, { error: `Erreur lors de la restauration: ${errorMessage(err)}` });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/archive
    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/unarchive
    if (parts.length === 7 && (parts[6] === 'archive' || parts[6] === 'unarchive') && method === 'POST') {
      const ticketId = parts[5];
      const archiving = parts[6] === 'archive';
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const actor = { id: user.userId, username: user.username || 'Staff' };
        const { archiveTicket, unarchiveTicket } = await import('../../../../services/features/ticketLifecycleService.js');
        const { logTicketEvent } = await import('../../../../services/features/ticketService.js');
        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });

        if (archiving) {
          const result = await archiveTicket(client, ticketId, actor);
          if (guildConfig) {
            const link = result.transcriptId
              ? `${getDashboardUrl().replace(/\/$/, '')}/transcripts/${result.transcriptId}`
              : undefined;
            await logTicketEvent(client, guildConfig, 'ARCHIVED', result.ticket, actor, link);
          }
          json(res, 200, { success: true, ticket: result.ticket, transcriptId: result.transcriptId });
        } else {
          const updated = await unarchiveTicket(client, ticketId, actor);
          if (guildConfig) await logTicketEvent(client, guildConfig, 'UNARCHIVED', updated, actor);
          json(res, 200, { success: true, ticket: updated });
        }
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error on ticket ${parts[6]}: ${errorMessage(err)}`);
        json(res, 400, { error: errorMessage(err) });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/lock
    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/unlock
    if (parts.length === 7 && (parts[6] === 'lock' || parts[6] === 'unlock') && method === 'POST') {
      const ticketId = parts[5];
      const locking = parts[6] === 'lock';
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const actor = { id: user.userId, username: user.username || 'Staff' };
        const { lockTicketDeletion, unlockTicketDeletion } = await import('../../../../services/features/ticketLifecycleService.js');
        const { logTicketEvent } = await import('../../../../services/features/ticketService.js');
        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });

        let updated;
        if (locking) {
          const body = await readJsonBody<{ durationMs?: number | null; reason?: string | null }>(req);
          updated = await lockTicketDeletion(ticketId, actor, {
            durationMs: typeof body?.durationMs === 'number' ? body.durationMs : null,
            reason: body?.reason ?? null,
          });
          if (guildConfig) {
            await logTicketEvent(
              client, guildConfig, 'LOCKED', updated, actor,
              updated.deletionLockedUntil ? `<t:${Math.floor(updated.deletionLockedUntil.getTime() / 1000)}:f>` : undefined,
            );
          }
        } else {
          updated = await unlockTicketDeletion(ticketId);
          if (guildConfig) await logTicketEvent(client, guildConfig, 'UNLOCKED', updated, actor);
        }

        json(res, 200, { success: true, ticket: updated });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error on ticket ${parts[6]}: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la mise à jour du verrou' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/delete
    if (parts.length === 7 && parts[6] === 'delete' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        // Le verrou vaut pour toutes les surfaces : il ne servirait à rien si
        // le dashboard pouvait passer outre ce que Discord refuse.
        const { resolveDeletionLock } = await import('../../../../services/features/ticketLifecycleService.js');
        const lock = resolveDeletionLock(ticket);
        if (lock.locked) {
          json(res, 423, {
            error: 'Ce ticket est protégé contre la suppression.',
            lockedUntil: lock.until,
            lockReason: lock.reason,
            lockedByName: lock.byName,
          });
          return true;
        }

        if (!ticket.channelId) {
          json(res, 200, { success: true });
          return true;
        }

        const ch = client.channels.cache.get(ticket.channelId);
        if (ch && ch instanceof TextChannel) {
          const { generateTranscript } = await import('../../../../services/features/transcriptService.js');
          const transcriptData = await generateTranscript(ch);
          
          await prisma.ticket.update({
            where: { id: ticketId },
            data: {
              channelId: null,
              status: 'CLOSED',
              transcriptId: transcriptData.id
            }
          });

          const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
          const { getDashboardUrl } = await import('../../../shared.js');
          const dashboardUrl = getDashboardUrl();
          const publicLink = `${dashboardUrl}/transcripts/${transcriptData.id}`;
          
          const usersToDm = new Set<string>();
          if (ticket.userId) usersToDm.add(ticket.userId);
          if (ticket.claimedById) usersToDm.add(ticket.claimedById);
          if (ticket.closedById) usersToDm.add(ticket.closedById);
          if (user.userId) usersToDm.add(user.userId);
          
           const serverName = getGuildName(client, guildId);
           const dmEmbed = new EmbedBuilder()
            .setTitle('📄 Transcription de ticket')
            .setDescription(`Le ticket d'assistance **${ticket.reason}** du serveur **${serverName}** a été supprimé.\n\nVoici le lien pour consulter la transcription complète :`)
            .addFields([{ name: "Lien d'accès", value: `🌐 [Consulter le transcript](${publicLink})` }])
            .setColor('#5865F2')
            .setTimestamp()
            .setFooter({ text: `Serveur : ${serverName}` });
            
          for (const dmUserId of usersToDm) {
            try {
              const dmUser = await client.users.fetch(dmUserId);
              if (dmUser) await dmUser.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } });
            } catch { /* ignored */ }
          }

          if (guildConfig && guildConfig.ticketLogChannelId) {
            const logCh = client.channels.cache.get(guildConfig.ticketLogChannelId);
            if (logCh && logCh instanceof TextChannel) {
              const logEmbed = new EmbedBuilder()
                .setTitle('🗑️ Ticket Supprimé')
                .setDescription(`Le ticket ouvert par **${ticket.username}** a été définitivement supprimé par **${user.username}** depuis le Dashboard.`)
                .setColor(0x000000)
                .addFields([
                  { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
                  { name: 'Supprimé par', value: `<@${user.userId}>`, inline: true },
                  { name: 'Transcription publique', value: `🌐 [Consulter le transcript](${publicLink})` }
                ])
                .setTimestamp()
                .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });
              await logCh.send({ embeds: [logEmbed], allowedMentions: { parse: [] } }).catch(() => {});
            }
          }

          setTimeout(async () => {
            await ch.delete(`Ticket supprimé depuis le Dashboard par ${user.username}`).catch(() => {});
          }, 1000);

          broadcastDashboardStateChange(guildId, 'tickets_updated');
          json(res, 200, { success: true, transcriptId: transcriptData.id });
        } else {
          await prisma.ticket.update({
            where: { id: ticketId },
            data: { channelId: null }
          });
          broadcastDashboardStateChange(guildId, 'tickets_updated');
          json(res, 200, { success: true });
        }
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error deleting ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }
  }

  return false;
}
