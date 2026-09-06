/**
 * Quotas d'ouverture et de charge du module Tickets.
 *
 * Chaque quota s'active independamment et, desactive, n'impose aucune limite.
 * Les valeurs vivent sur la guilde ; un type de ticket peut les surcharger dans
 * le JSON `ticketTypes`, ou `null` signifie « herite du serveur » - la meme
 * convention tri-etat que `lockUntilClaim` et `requireApproval`.
 *
 * Les fonctions de decision sont separees des comptages en base pour rester
 * testables sans base de donnees.
 */
import prisma from '../../utils/db.js';

/** Statuts qui font qu'un ticket occupe encore une place dans le quota. */
export const ACTIVE_TICKET_STATUSES = ['PENDING', 'OPEN', 'CLAIMED'] as const;

export type StaffLoadMode = 'OFF' | 'WARN' | 'BLOCK';

export type ResolvedTicketQuotas = {
  /** `null` = pas de limite. */
  openMax: number | null;
  cooldownMinutes: number | null;
  periodMax: number | null;
  periodHours: number;
  reopenMax: number | null;
  staffLoad: {
    mode: StaffLoadMode;
    max: number;
    bypassRoleIds: string[];
  };
};

/**
 * Surcharges portees par un type de ticket. Absent ou `null` = herite.
 * Un `0` est une valeur legitime (« aucun ticket de ce type »), il ne doit donc
 * pas etre confondu avec « non defini » - d'ou le test explicite sur `null`.
 */
type TicketTypeQuotaOverrides = {
  quotaOpenMax?: number | null;
  quotaCooldownMinutes?: number | null;
  quotaPeriodMax?: number | null;
  quotaReopenMax?: number | null;
};

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : null;
}

function asStaffLoadMode(value: unknown): StaffLoadMode {
  return value === 'WARN' || value === 'BLOCK' ? value : 'OFF';
}

/**
 * Combine les reglages du serveur et les surcharges du type de ticket.
 *
 * Un quota desactive au niveau du serveur reste desactive meme si le type
 * propose une valeur : l'interrupteur du serveur commande, la surcharge ne fait
 * qu'ajuster le seuil.
 */
export function resolveTicketQuotas(
  guildConfig: Record<string, unknown>,
  ticketType?: TicketTypeQuotaOverrides | null,
): ResolvedTicketQuotas {
  const override = (value: unknown, fallback: number): number =>
    asPositiveInt(value) ?? fallback;

  const openEnabled = guildConfig.ticketQuotaOpenEnabled === true;
  const cooldownEnabled = guildConfig.ticketQuotaCooldownEnabled === true;
  const periodEnabled = guildConfig.ticketQuotaPeriodEnabled === true;
  const reopenEnabled = guildConfig.ticketQuotaReopenEnabled === true;

  return {
    openMax: openEnabled
      ? override(ticketType?.quotaOpenMax, asPositiveInt(guildConfig.ticketQuotaOpenMax) ?? 1)
      : null,
    cooldownMinutes: cooldownEnabled
      ? override(ticketType?.quotaCooldownMinutes, asPositiveInt(guildConfig.ticketQuotaCooldownMinutes) ?? 30)
      : null,
    periodMax: periodEnabled
      ? override(ticketType?.quotaPeriodMax, asPositiveInt(guildConfig.ticketQuotaPeriodMax) ?? 5)
      : null,
    periodHours: asPositiveInt(guildConfig.ticketQuotaPeriodHours) || 24,
    reopenMax: reopenEnabled
      ? override(ticketType?.quotaReopenMax, asPositiveInt(guildConfig.ticketQuotaReopenMax) ?? 3)
      : null,
    staffLoad: {
      mode: asStaffLoadMode(guildConfig.ticketQuotaStaffLoadMode),
      max: asPositiveInt(guildConfig.ticketQuotaStaffLoadMax) ?? 5,
      bypassRoleIds: Array.isArray(guildConfig.ticketQuotaStaffLoadBypassRoleIds)
        ? (guildConfig.ticketQuotaStaffLoadBypassRoleIds as unknown[]).filter(
            (id): id is string => typeof id === 'string',
          )
        : [],
    },
  };
}

export type MemberQuotaVerdict =
  | { ok: true }
  /** Le membre occupe deja toutes ses places. `pendingTicket` porte la demande
   *  en attente de validation, pour distinguer les deux messages de refus. */
  | { ok: false; kind: 'OPEN'; max: number; blocking: BlockingTicket | null }
  | { ok: false; kind: 'COOLDOWN'; retryAtMs: number }
  | { ok: false; kind: 'PERIOD'; max: number; hours: number; retryAtMs: number };

type BlockingTicket = {
  id: string;
  status: string;
  channelId: string | null;
  staffServerGuildId: string | null;
};

/**
 * Verifie les quotas qui s'opposent a l'ouverture d'un ticket.
 *
 * L'ordre des controles suit ce que le membre peut corriger le plus vite : un
 * ticket deja ouvert se traite tout de suite, un cooldown s'attend, un quota de
 * periode s'attend plus longtemps.
 */
export async function checkMemberTicketQuota(params: {
  guildId: string;
  userId: string;
  quotas: ResolvedTicketQuotas;
}): Promise<MemberQuotaVerdict> {
  const { guildId, userId, quotas } = params;

  if (quotas.openMax !== null) {
    const active = await prisma.ticket.findMany({
      where: { guildId, userId, status: { in: [...ACTIVE_TICKET_STATUSES] } },
      select: { id: true, status: true, channelId: true, staffServerGuildId: true },
      orderBy: { createdAt: 'asc' },
    });

    if (active.length >= quotas.openMax) {
      // Une demande en attente de validation merite son propre message : le
      // membre n'a pas de salon a rejoindre, il n'a qu'a patienter.
      const pending = active.find((t) => t.status === 'PENDING') ?? null;
      return { ok: false, kind: 'OPEN', max: quotas.openMax, blocking: pending ?? active[0] ?? null };
    }
  }

  if (quotas.cooldownMinutes !== null && quotas.cooldownMinutes > 0) {
    const last = await prisma.ticket.findFirst({
      where: { guildId, userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (last) {
      const retryAtMs = last.createdAt.getTime() + quotas.cooldownMinutes * 60_000;
      if (Date.now() < retryAtMs) return { ok: false, kind: 'COOLDOWN', retryAtMs };
    }
  }

  if (quotas.periodMax !== null) {
    const windowMs = quotas.periodHours * 3_600_000;
    const since = new Date(Date.now() - windowMs);
    const recent = await prisma.ticket.findMany({
      where: { guildId, userId, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    if (recent.length >= quotas.periodMax) {
      // La place se libere quand le plus ancien ticket de la fenetre en sort.
      const oldest = recent[recent.length - quotas.periodMax];
      const retryAtMs = (oldest?.createdAt.getTime() ?? Date.now()) + windowMs;
      return { ok: false, kind: 'PERIOD', max: quotas.periodMax, hours: quotas.periodHours, retryAtMs };
    }
  }

  return { ok: true };
}

export type StaffLoadVerdict = {
  /** OFF quand aucun plafond ne s'applique a ce membre du staff. */
  mode: StaffLoadMode;
  current: number;
  max: number;
  exceeded: boolean;
};

/**
 * Charge courante d'un membre du staff : tickets qu'il a pris en charge et qui
 * ne sont pas encore clos. Un role de contournement ramene le mode a OFF plutot
 * que de mentir sur le compte - l'appelant peut ainsi afficher la charge reelle.
 */
export async function checkStaffTicketLoad(params: {
  guildId: string;
  staffUserId: string;
  staffRoleIds: string[];
  quotas: ResolvedTicketQuotas;
}): Promise<StaffLoadVerdict> {
  const { guildId, staffUserId, staffRoleIds, quotas } = params;
  const { mode, max, bypassRoleIds } = quotas.staffLoad;

  const bypassed = bypassRoleIds.length > 0 && staffRoleIds.some((id) => bypassRoleIds.includes(id));
  const effectiveMode: StaffLoadMode = mode === 'OFF' || bypassed ? 'OFF' : mode;

  if (effectiveMode === 'OFF') {
    return { mode: 'OFF', current: 0, max, exceeded: false };
  }

  const current = await prisma.ticket.count({
    where: { guildId, claimedById: staffUserId, status: { in: ['OPEN', 'CLAIMED'] } },
  });

  return { mode: effectiveMode, current, max, exceeded: current >= max };
}

/** Formate un instant futur pour un message Discord (horodatage relatif). */
export function relativeTimestamp(atMs: number): string {
  return `<t:${Math.ceil(atMs / 1000)}:R>`;
}
