/**
 * accessService.ts
 *
 * Gestion de l'accès **à durée limitée** d'un serveur : périodes d'essai et,
 * plus tard, abonnements payants.
 *
 * L'activation historique (code → `guild.activated = true`) reste inchangée et
 * correspond à `accessType = 'PERMANENT'`. Ce service ajoute par-dessus une
 * couche générique : un accès porte un type, une date de fin, des rappels déjà
 * envoyés. Tout ce qui accorde du temps d'accès (code d'activation « essai »,
 * geste commercial depuis le dashboard, futur webhook de paiement) passe par
 * `grantAccess` / `extendAccess` et hérite gratuitement des rappels, de
 * l'expiration automatique et des embeds.
 *
 * Le cycle de vie est balayé chaque minute par un cron (`access-lifecycle`),
 * la minute étant la granularité d'une durée d'accès.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import { v2Message } from '@arcscord/components';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { kotboContainer, COLORS_RAW } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

export type AccessType = 'PERMANENT' | 'TRIAL' | 'SUBSCRIPTION';

const MS_PER_MINUTE = 60_000;

/** Colonnes d'accès d'une guilde, telles que manipulées par ce service. */
export interface AccessFields {
  accessType: AccessType;
  accessExpiresAt: Date | null;
  accessExpiredAt: Date | null;
  accessDurationMinutes: number | null;
  accessRemindersSent: number[];
}

export interface AccessStatus extends AccessFields {
  guildId: string;
  activated: boolean;
  /** Minutes restantes arrondies au supérieur ; null si l'accès n'expire pas. */
  minutesLeft: number | null;
  /** true si la date de fin est dépassée (que l'expiration ait été traitée ou non). */
  expired: boolean;
}

// ─────────────────────────────────────────────────────────────
// Calculs purs (testables sans base ni client Discord)
// ─────────────────────────────────────────────────────────────

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 1440;

/** Date de fin d'un accès de `durationMinutes` minutes démarré à `from`. */
export function computeExpiry(durationMinutes: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + durationMinutes * MS_PER_MINUTE);
}

/** Minutes restantes avant `expiresAt`, arrondies au supérieur (0 si dépassé). */
export function minutesUntil(expiresAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_MINUTE));
}

/**
 * Palier de mi-parcours, arrondi à une unité lisible : on préfère annoncer
 * « 7 jours » que « 7 jours 12 heures ». L'arrondi suit l'échelle de la période :
 * au jour pour une période de plusieurs jours, à l'heure pour plusieurs
 * heures, à la minute en dessous.
 */
function halfwayMilestone(durationMinutes: number): number {
  const half = Math.floor(durationMinutes / 2);
  if (durationMinutes >= 2 * MINUTES_PER_DAY) return Math.floor(half / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  if (durationMinutes >= 2 * MINUTES_PER_HOUR) return Math.floor(half / MINUTES_PER_HOUR) * MINUTES_PER_HOUR;
  return half;
}

/**
 * Paliers de rappel (exprimés en minutes restantes) : mi-parcours, J-3 et J-1.
 *
 * Les paliers qui ne tiennent pas dans la période sont écartés, ce qui rend la
 * cadence auto-adaptative quelle que soit l'échelle : 15 jours → 7j / 3j / 1j,
 * 7 jours → 3j / 1j, 30 minutes → 15 min. Une période d'une minute ne déclenche
 * aucun rappel, seul le message de fin est envoyé.
 */
export function reminderMilestones(durationMinutes: number): number[] {
  const candidates = [halfwayMilestone(durationMinutes), 3 * MINUTES_PER_DAY, MINUTES_PER_DAY];
  const kept = candidates.filter((ms) => ms >= 1 && ms < durationMinutes);
  return [...new Set(kept)].sort((a, b) => b - a);
}

/**
 * Palier de rappel à envoyer maintenant, et paliers à marquer comme traités.
 *
 * On retient le **plus petit** palier non envoyé encore atteignable : si le bot
 * a été hors ligne un moment, on n'envoie pas un « plus que 7 jours » alors
 * qu'il n'en reste que 2 : on envoie le bon message et on classe les paliers
 * dépassés comme déjà traités.
 */
export function dueReminder(
  minutesLeft: number,
  milestones: number[],
  alreadySent: number[],
): { milestone: number | null; sent: number[] } {
  const reached = milestones.filter((ms) => ms >= minutesLeft);
  const pending = reached.filter((ms) => !alreadySent.includes(ms));
  const milestone = pending.length > 0 ? Math.min(...pending) : null;
  const sent = [...new Set([...alreadySent, ...reached])].sort((a, b) => b - a);
  return { milestone, sent };
}

/**
 * Rend une durée en minutes lisible : « 15 jours », « 2 heures », « 30 minutes »,
 * et compose deux unités quand le reste est significatif (« 1 jour 12 heures »).
 */
export function formatDuration(minutes: number, locale: 'fr' | 'en' = 'fr'): string {
  const units =
    locale === 'en'
      ? { day: ['day', 'days'], hour: ['hour', 'hours'], minute: ['minute', 'minutes'] }
      : { day: ['jour', 'jours'], hour: ['heure', 'heures'], minute: ['minute', 'minutes'] };

  const plural = (value: number, [one, many]: string[]) => `${value} ${value > 1 ? many : one}`;

  if (minutes < MINUTES_PER_HOUR) return plural(Math.max(1, minutes), units.minute);

  if (minutes < MINUTES_PER_DAY) {
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const rest = minutes % MINUTES_PER_HOUR;
    return rest === 0 ? plural(hours, units.hour) : `${plural(hours, units.hour)} ${plural(rest, units.minute)}`;
  }

  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const restHours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  return restHours === 0 ? plural(days, units.day) : `${plural(days, units.day)} ${plural(restHours, units.hour)}`;
}

/** Garde-fou : au-delà, mieux vaut un accès permanent qu'une date absurde. */
export const MAX_ACCESS_DURATION_MINUTES = 3650 * MINUTES_PER_DAY;

/**
 * Valide une demande d'accès venue de l'extérieur (API admin, futur webhook de
 * paiement) et la ramène à un couple type/durée exploitable.
 */
export function normalizeAccessGrant(
  rawType: unknown,
  rawMinutes: unknown,
): { accessType: AccessType; durationMinutes: number | null } | { error: string } {
  const type = typeof rawType === 'string' ? rawType.toUpperCase() : 'PERMANENT';

  if (type === 'PERMANENT') return { accessType: 'PERMANENT', durationMinutes: null };
  if (type !== 'TRIAL' && type !== 'SUBSCRIPTION') {
    return { error: "Type d'accès invalide (PERMANENT, TRIAL ou SUBSCRIPTION attendu)." };
  }

  const minutes = typeof rawMinutes === 'number' ? rawMinutes : Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ACCESS_DURATION_MINUTES) {
    return {
      error: `La durée doit être un nombre entier de minutes entre 1 et ${MAX_ACCESS_DURATION_MINUTES}.`,
    };
  }

  return { accessType: type, durationMinutes: minutes };
}

/**
 * Colonnes à écrire pour accorder un accès. Exposé à part pour pouvoir être
 * injecté dans un `upsert` existant (cf. `activateGuild`) sans écriture en plus.
 */
export function buildAccessFields(
  type: AccessType,
  durationMinutes: number | null | undefined,
  from: Date = new Date(),
): AccessFields {
  if (type === 'PERMANENT' || !durationMinutes || durationMinutes <= 0) {
    return {
      accessType: 'PERMANENT',
      accessExpiresAt: null,
      accessExpiredAt: null,
      accessDurationMinutes: null,
      accessRemindersSent: [],
    };
  }

  return {
    accessType: type,
    accessExpiresAt: computeExpiry(durationMinutes, from),
    accessExpiredAt: null,
    accessDurationMinutes: durationMinutes,
    accessRemindersSent: [],
  };
}

// ─────────────────────────────────────────────────────────────
// Lecture / écriture de l'accès
// ─────────────────────────────────────────────────────────────

function toStatus(guildId: string, row: {
  activated: boolean;
  accessType: string;
  accessExpiresAt: Date | null;
  accessExpiredAt: Date | null;
  accessDurationMinutes: number | null;
  accessRemindersSent: number[];
}, now: Date = new Date()): AccessStatus {
  return {
    guildId,
    activated: row.activated,
    accessType: row.accessType as AccessType,
    accessExpiresAt: row.accessExpiresAt,
    accessExpiredAt: row.accessExpiredAt,
    accessDurationMinutes: row.accessDurationMinutes,
    accessRemindersSent: row.accessRemindersSent,
    minutesLeft: row.accessExpiresAt ? minutesUntil(row.accessExpiresAt, now) : null,
    expired: row.accessExpiresAt ? row.accessExpiresAt.getTime() <= now.getTime() : false,
  };
}

/** État d'accès d'un serveur, ou null s'il n'a jamais été enregistré. */
export async function getAccessStatus(guildId: string): Promise<AccessStatus | null> {
  const row = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      activated: true,
      accessType: true,
      accessExpiresAt: true,
      accessExpiredAt: true,
      accessDurationMinutes: true,
      accessRemindersSent: true,
    },
  });

  return row ? toStatus(guildId, row) : null;
}

/**
 * Accorde (ou remplace) l'accès d'un serveur déjà activé.
 *
 * Point d'entrée pour les couches externes : un module de paiement appelle
 * `grantAccess(guildId, { type: 'SUBSCRIPTION', durationMinutes: 30 * 1440 })`
 * et tout le cycle de vie (rappels, expiration, embeds) suit sans code
 * supplémentaire.
 */
export async function grantAccess(
  guildId: string,
  options: { type: AccessType; durationMinutes?: number | null; from?: Date },
): Promise<AccessStatus> {
  const fields = buildAccessFields(options.type, options.durationMinutes, options.from);

  const row = await prisma.guild.update({
    where: { id: guildId },
    data: fields,
    select: {
      activated: true,
      accessType: true,
      accessExpiresAt: true,
      accessExpiredAt: true,
      accessDurationMinutes: true,
      accessRemindersSent: true,
    },
  });

  logger.info(
    'Access',
    `Accès ${fields.accessType} accordé à ${guildId}` +
      (fields.accessExpiresAt ? ` jusqu'au ${fields.accessExpiresAt.toISOString()}.` : ' (sans expiration).'),
  );

  return toStatus(guildId, row);
}

/**
 * Prolonge l'accès de `minutes` minutes. La prolongation part de la date de fin
 * existante si elle est encore dans le futur (on ne perd pas le temps restant),
 * sinon de maintenant. Les rappels déjà envoyés sont remis à zéro pour que la
 * nouvelle période notifie à nouveau.
 *
 * La durée de référence des paliers devient celle de la nouvelle période, du
 * report éventuel compris : c'est bien elle que le serveur va vivre.
 *
 * Un accès PERMANENT n'est jamais dégradé : on le laisse tel quel.
 */
export async function extendAccess(
  guildId: string,
  minutes: number,
  options: { type?: AccessType } = {},
): Promise<AccessStatus | null> {
  if (minutes <= 0) throw new Error('La durée de prolongation doit être positive.');

  const current = await getAccessStatus(guildId);
  if (!current) return null;
  if (current.accessType === 'PERMANENT' && !options.type) return current;

  const now = new Date();
  const base =
    current.accessExpiresAt && current.accessExpiresAt.getTime() > now.getTime()
      ? current.accessExpiresAt
      : now;
  const expiresAt = computeExpiry(minutes, base);

  const row = await prisma.guild.update({
    where: { id: guildId },
    data: {
      accessType: options.type ?? current.accessType,
      accessExpiresAt: expiresAt,
      accessExpiredAt: null,
      accessDurationMinutes: minutesUntil(expiresAt, now),
      accessRemindersSent: [],
    },
    select: {
      activated: true,
      accessType: true,
      accessExpiresAt: true,
      accessExpiredAt: true,
      accessDurationMinutes: true,
      accessRemindersSent: true,
    },
  });

  logger.info(
    'Access',
    `Accès de ${guildId} prolongé de ${formatDuration(minutes)} → ${row.accessExpiresAt?.toISOString()}.`,
  );
  return toStatus(guildId, row);
}

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────

function canSendIn(guild: Guild, channel: GuildBasedChannel | undefined): boolean {
  if (!channel) return false;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return false;
  const me = guild.members.me;
  if (!me) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ?? false;
}

/**
 * Salon où publier les messages de cycle de vie : salon de broadcast configuré,
 * sinon salon de logs, sinon salon système Discord, sinon le premier salon
 * textuel où le bot peut écrire.
 */
export async function resolveNoticeChannel(guild: Guild): Promise<GuildBasedChannel | null> {
  const dbGuild = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: { broadcastChannelId: true, logChannelId: true },
  });

  const preferred = [dbGuild?.broadcastChannelId, dbGuild?.logChannelId, guild.systemChannelId];
  for (const channelId of preferred) {
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId);
    if (canSendIn(guild, channel)) return channel!;
  }

  return guild.channels.cache.find((c) => canSendIn(guild, c)) ?? null;
}

interface NoticeContent {
  color: number;
  title: string;
  body: string;
  footer: string;
}

async function publishNotice(guild: Guild, content: NoticeContent): Promise<boolean> {
  const channel = await resolveNoticeChannel(guild);
  if (!channel || !channel.isTextBased()) {
    logger.warn('Access', `Aucun salon disponible pour notifier ${guild.id}.`);
    return false;
  }

  try {
    await channel.send(
      v2Message(
        kotboContainer({
          color: content.color,
          title: content.title,
          fields: [content.body],
          footerTitle: content.footer,
        }),
      ),
    );
    return true;
  } catch (err) {
    logger.warn('Access', `Échec de l'envoi de la notification d'accès dans ${guild.id}:`, err);
    return false;
  }
}

/** Le message de fin part aussi en MP au propriétaire : c'est lui le décideur. */
async function dmOwner(guild: Guild, content: NoticeContent): Promise<void> {
  try {
    const owner = await guild.fetchOwner();
    await owner.send(
      v2Message(
        kotboContainer({
          color: content.color,
          title: content.title,
          fields: [content.body],
          footerTitle: content.footer,
        }),
      ),
    );
  } catch {
    // MP fermés ou propriétaire injoignable : le message en salon suffit.
  }
}

/**
 * Langue des messages de cycle de vie.
 *
 * Ces messages partent d'un cron, sans interaction pour porter la langue : il
 * faut donc alimenter nous-memes le deuxieme palier de la cascade avec la langue
 * declaree du serveur Discord. Sans lui, tout serveur laisse en mode automatique
 * (`Guild.language` a null, le defaut) retombait directement sur l'anglais.
 */
async function noticeLocale(guild: Guild) {
  return resolveGuildLocale(guild.id, guild.preferredLocale);
}

/** `<t:…:F>` : Discord affiche la date dans le fuseau de chaque lecteur. */
function discordDate(date: Date, style: 'F' | 'R' = 'F'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

async function trialStartedContent(
  guild: Guild,
  expiresAt: Date,
  durationMinutes: number,
): Promise<NoticeContent> {
  const locale = await noticeLocale(guild);
  const duration = formatDuration(durationMinutes, locale);
  return {
    color: COLORS_RAW.success,
    title: `${E.fire} ${m.access_trial_started_title({ duration }, { locale })}`,
    body: m.access_trial_started_desc(
      { duration, date: discordDate(expiresAt), relative: discordDate(expiresAt, 'R') },
      { locale },
    ),
    footer: m.access_notice_footer({}, { locale }),
  };
}

async function reminderContent(
  guild: Guild,
  type: AccessType,
  expiresAt: Date,
  minutesLeft: number,
): Promise<NoticeContent> {
  const locale = await noticeLocale(guild);
  const remaining = formatDuration(minutesLeft, locale);
  const args = { remaining, date: discordDate(expiresAt), relative: discordDate(expiresAt, 'R') };
  return {
    color: COLORS_RAW.warning,
    title: `${E.clock} ${
      type === 'SUBSCRIPTION'
        ? m.access_sub_reminder_title({ remaining }, { locale })
        : m.access_trial_reminder_title({ remaining }, { locale })
    }`,
    body:
      type === 'SUBSCRIPTION'
        ? m.access_sub_reminder_desc(args, { locale })
        : m.access_trial_reminder_desc(args, { locale }),
    footer: m.access_notice_footer({}, { locale }),
  };
}

async function endedContent(guild: Guild, type: AccessType): Promise<NoticeContent> {
  const locale = await noticeLocale(guild);
  const guildName = guild.name;
  return {
    color: COLORS_RAW.danger,
    title: `${E.warning} ${
      type === 'SUBSCRIPTION'
        ? m.access_sub_ended_title({}, { locale })
        : m.access_trial_ended_title({}, { locale })
    }`,
    body:
      type === 'SUBSCRIPTION'
        ? m.access_sub_ended_desc({ guild: guildName }, { locale })
        : m.access_trial_ended_desc({ guild: guildName }, { locale }),
    footer: m.access_notice_footer({}, { locale }),
  };
}

async function revokedContent(guild: Guild): Promise<NoticeContent> {
  const locale = await noticeLocale(guild);
  return {
    color: COLORS_RAW.danger,
    title: `${E.warning} ${m.access_revoked_title({}, { locale })}`,
    body: m.access_revoked_desc({ guild: guild.name }, { locale }),
    footer: m.access_notice_footer({}, { locale }),
  };
}

/**
 * Prévient un serveur que son accès vient d'être retiré depuis l'administration
 * Kotbo (code supprimé, ou désactivation manuelle).
 *
 * Distinct de l'expiration : ici la période n'est pas arrivée à son terme, c'est
 * une décision humaine. Sans ce message le serveur perd tout du jour au
 * lendemain sans la moindre explication.
 */
export async function announceAccessRevoked(client: Client, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const content = await revokedContent(guild);
  await publishNotice(guild, content);
  await dmOwner(guild, content);
}

/**
 * Annonce publiquement le démarrage d'une période d'essai. Appelé juste après
 * l'activation par un code « essai ».
 */
export async function announceTrialStart(
  client: Client,
  guildId: string,
  expiresAt: Date,
  durationMinutes: number,
): Promise<void> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const content = await trialStartedContent(guild, expiresAt, durationMinutes);
  await publishNotice(guild, content);
}

// ─────────────────────────────────────────────────────────────
// Cycle de vie (cron quotidien)
// ─────────────────────────────────────────────────────────────

/**
 * Termine l'accès d'un serveur : désactivation complète (comme un serveur
 * jamais activé) puis message de fin en salon **et** en MP au propriétaire.
 *
 * Contrairement à une désactivation manuelle, le code consommé n'est pas
 * recyclé : un essai arrivé à terme ne doit jamais pouvoir être rejoué.
 */
export async function expireAccess(client: Client, guildId: string): Promise<void> {
  const status = await getAccessStatus(guildId);
  if (!status || status.accessExpiredAt) return;

  const { deactivateGuild } = await import('../../utils/activation.js');
  await deactivateGuild(guildId, { recycleCode: false });

  await prisma.guild.update({
    where: { id: guildId },
    data: { accessExpiredAt: new Date() },
  });

  logger.info('Access', `Accès ${status.accessType} expiré pour ${guildId} : serveur désactivé.`);

  // Fin d'un acces a duree limitee : essai non converti, cadeau arrive a son
  // terme, code epuise. Distinct d'une resiliation, qui passe par Stripe.
  const { trackAcquisitionStep } = await import('../analytics/acquisitionService.js');
  trackAcquisitionStep({
    step: 'access_expired',
    guildId,
    metadata: { accessType: status.accessType },
  });

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const content = await endedContent(guild, status.accessType);
  await publishNotice(guild, content);
  await dmOwner(guild, content);
}

async function processReminder(client: Client, guildId: string, status: AccessStatus): Promise<void> {
  if (!status.accessExpiresAt || status.minutesLeft === null) return;

  // Sans durée de référence (accès posé avant l'introduction de la colonne), on
  // se rabat sur le temps restant : les paliers restent cohérents, seul le
  // premier rappel peut manquer.
  const durationMinutes = status.accessDurationMinutes ?? Math.max(status.minutesLeft, 1);

  const { milestone, sent } = dueReminder(
    status.minutesLeft,
    reminderMilestones(durationMinutes),
    status.accessRemindersSent,
  );

  if (sent.length !== status.accessRemindersSent.length) {
    await prisma.guild.update({ where: { id: guildId }, data: { accessRemindersSent: sent } });
  }

  if (milestone === null) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const content = await reminderContent(guild, status.accessType, status.accessExpiresAt, milestone);
  await publishNotice(guild, content);
  logger.info('Access', `Rappel « ${formatDuration(milestone)} restantes » envoyé à ${guildId}.`);
}

/**
 * Balayage du cycle de vie : envoie les rappels dus et coupe les accès arrivés à
 * échéance. Idempotent : un double passage ne renvoie rien deux fois.
 *
 * Tourne à la minute : c'est la granularité de la durée d'accès, et la requête
 * ne remonte que les serveurs ayant une échéance en cours (index partiel sur
 * `accessExpiresAt`).
 */
export async function runAccessLifecycleCheck(client: Client): Promise<void> {
  const now = new Date();

  const candidates = await prisma.guild.findMany({
    where: {
      activated: true,
      activatedViaStaffLink: false,
      accessExpiresAt: { not: null },
      accessExpiredAt: null,
    },
    select: {
      id: true,
      activated: true,
      accessType: true,
      accessExpiresAt: true,
      accessExpiredAt: true,
      accessDurationMinutes: true,
      accessRemindersSent: true,
    },
  });

  if (candidates.length === 0) return;
  logger.debug('Access', `${candidates.length} serveur(s) à accès limité à vérifier.`);

  for (const row of candidates) {
    const status = toStatus(row.id, row, now);
    try {
      if (status.expired) {
        await expireAccess(client, row.id);
        continue;
      }

      await processReminder(client, row.id, status);
    } catch (err) {
      logger.error('Access', `Erreur de traitement du cycle de vie pour ${row.id}:`, err);
    }
  }
}
