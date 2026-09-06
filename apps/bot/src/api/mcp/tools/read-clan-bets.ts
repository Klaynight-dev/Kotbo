/** Outils MCP - lecture des paris en points de clan (permission READ_COMMUNITY). */
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { buildBettorStandings, engagedAmount, firmDebtOf } from '@kotbo/shared';
import { getEngagedBetCredit } from '../../../services/community/clanBetService.js';
import { type McpToolContext, err, ok, resolveMember } from '../toolkit.js';

const BET_STATUSES = ['PENDING', 'ACTIVE', 'RESOLVED', 'REFUNDED', 'DECLINED', 'CANCELLED', 'EXPIRED'] as const;

const WITH_SIDES = {
  sides: {
    orderBy: { position: 'asc' },
    include: { participants: { orderBy: { joinedAt: 'asc' } } },
  },
} as const;

type BetRow = {
  id: string;
  subject: string;
  stake: number;
  stakeMode: string;
  shape: string;
  access: string;
  season: number;
  status: string;
  expiresAt: Date;
  winningSideId: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  sides: Array<{
    id: string;
    position: number;
    label: string;
    capacity: number | null;
    participants: Array<{ userId: string; status: string; escrow: number; debt: number; payout: number }>;
  }>;
};

/** L'argent d'un pari vit sur ses participants, jamais sur le pari lui-même. */
const joinedOf = (bet: BetRow) =>
  bet.sides.flatMap((side) =>
    side.participants
      .filter((entry) => entry.status === 'JOINED')
      .map((entry) => ({ ...entry, sideId: side.id, sideLabel: side.label, won: side.id === bet.winningSideId })),
  );

function summarize(bet: BetRow) {
  const joined = joinedOf(bet);
  return {
    id: bet.id,
    subject: bet.subject,
    shape: bet.shape,
    access: bet.access,
    status: bet.status,
    season: bet.season,
    stake: bet.stake,
    stakeMode: bet.stakeMode,
    pot: joined.reduce((sum, entry) => sum + engagedAmount(entry), 0),
    onCredit: joined.reduce((sum, entry) => sum + Math.max(0, entry.debt), 0),
    playerCount: joined.length,
    // La position sert à trancher : c'est elle que `resolve_clan_bet` attend, et
    // elle ne bouge pas quand un libellé est réécrit.
    sides: bet.sides.map((side) => ({
      position: side.position,
      label: side.label,
      capacity: side.capacity,
      won: side.id === bet.winningSideId,
      members: side.participants
        .filter((entry) => entry.status !== 'DECLINED')
        .map((entry) => ({
          userId: entry.userId,
          status: entry.status,
          engaged: engagedAmount(entry),
          onCredit: Math.max(0, entry.debt),
          payout: entry.payout,
        })),
    })),
    winningSideLabel: bet.sides.find((side) => side.id === bet.winningSideId)?.label ?? null,
    resolvedById: bet.resolvedById,
    resolvedAt: bet.resolvedAt?.toISOString() ?? null,
    expiresAt: bet.expiresAt.toISOString(),
    createdAt: bet.createdAt.toISOString(),
  };
}

export function registerReadClanBetsTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (!shouldRegister('READ_COMMUNITY')) return;

  server.registerTool(
    'get_clan_bets',
    {
      description:
        'Liste les paris en points de clan du serveur (duels, pools, équipes) avec leurs camps, '
        + 'leurs parieurs et le pot engagé. Utiliser `status: "ACTIVE"` pour trouver les paris qui attendent un verdict.',
      inputSchema: {
        status: z.enum(BET_STATUSES).optional().describe('Ne garder que les paris dans cet état'),
        season: z.number().int().optional().describe('Saison de clan ; par défaut, toutes'),
        member: z.string().optional().describe('Ne garder que les paris impliquant ce membre'),
        limit: z.number().int().min(1).max(100).optional().describe('Nombre maximum de paris (défaut 25)'),
      },
      _meta: toolMeta,
    },
    guard('READ_COMMUNITY', async ({ status, season, member, limit }) => {
      let userIds: string[] | undefined;
      if (member) {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        userIds = [resolved.userId];
      }

      const bets = await prisma.clanBet.findMany({
        where: {
          guildId,
          status: status ?? undefined,
          season: season ?? undefined,
          participants: userIds ? { some: { userId: { in: userIds } } } : undefined,
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 25,
        include: WITH_SIDES,
      });

      return ok({ count: bets.length, bets: bets.map((bet) => summarize(bet as BetRow)) });
    })
  );

  server.registerTool(
    'get_clan_bet',
    {
      description: "Détail d'un pari en points de clan à partir de son identifiant.",
      inputSchema: { bet_id: z.string().describe('Identifiant du pari, visible en pied de son annonce') },
      _meta: toolMeta,
    },
    guard('READ_COMMUNITY', async ({ bet_id }) => {
      const bet = await prisma.clanBet.findUnique({ where: { id: bet_id }, include: WITH_SIDES });
      if (!bet || bet.guildId !== guildId) return err('Pari introuvable sur ce serveur.');
      return ok(summarize(bet as BetRow));
    })
  );

  server.registerTool(
    'get_bettor_standings',
    {
      description:
        'Palmarès des parieurs d\'une saison : victoires, défaites, gain net et meilleure série. '
        + 'Le gain net est ce qui a été touché moins ce qui avait été engagé, jamais le pot.',
      inputSchema: {
        season: z.number().int().optional().describe('Saison de clan ; par défaut, la saison en cours'),
        limit: z.number().int().min(1).max(50).optional().describe('Nombre de parieurs (défaut 10)'),
      },
      _meta: toolMeta,
    },
    guard('READ_COMMUNITY', async ({ season, limit }) => {
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { currentClanSeason: true } });
      const target = season ?? guild?.currentClanSeason ?? 1;

      const bets = await prisma.clanBet.findMany({
        where: { guildId, season: target, status: 'RESOLVED', winningSideId: { not: null } },
        take: 5_000,
        include: WITH_SIDES,
      });

      const standings = buildBettorStandings(
        bets.map((bet) => ({
          entries: joinedOf(bet as BetRow).map((entry) => ({
            userId: entry.userId,
            engaged: engagedAmount(entry),
            payout: entry.payout,
            won: entry.won,
          })),
          resolvedAt: bet.resolvedAt ?? bet.updatedAt,
        })),
      );

      return ok({ season: target, settledBets: bets.length, standings: standings.slice(0, limit ?? 10) });
    })
  );

  server.registerTool(
    'get_clan_point_debts',
    {
      description:
        'Dettes de points de clan ouvertes sur le serveur. Une dette naît quand un membre mise des points '
        + "qu'il n'a pas, et se rembourse automatiquement sur ses gains suivants. `engaged` est la part encore "
        + 'engagée dans des paris non tranchés, effacée si le pari est annulé ou si la saison se termine ; '
        + '`firm` est ce qui reste dû quoi qu\'il arrive.',
      inputSchema: {
        member: z.string().optional().describe("Ne regarder que ce membre ; sinon, toutes les dettes ouvertes"),
        limit: z.number().int().min(1).max(100).optional().describe('Nombre maximum de lignes (défaut 25)'),
      },
      _meta: toolMeta,
    },
    guard('READ_COMMUNITY', async ({ member, limit }) => {
      let userId: string | undefined;
      if (member) {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        userId = resolved.userId;
      }

      const debts = await prisma.clanPointDebt.findMany({
        where: { guildId, amount: { gt: 0 }, userId },
        orderBy: { amount: 'desc' },
        take: limit ?? 25,
      });

      const engagedByUser = await getEngagedBetCredit(guildId, debts.map((row) => row.userId));
      const rows = debts.map((row) => {
        const engaged = Math.min(row.amount, engagedByUser.get(row.userId) ?? 0);
        return {
          userId: row.userId,
          amount: row.amount,
          engaged,
          firm: firmDebtOf(row.amount, engaged),
          source: row.source,
          since: row.createdAt.toISOString(),
        };
      });

      return ok({
        count: rows.length,
        totalOwed: rows.reduce((sum, row) => sum + row.amount, 0),
        totalEngaged: rows.reduce((sum, row) => sum + row.engaged, 0),
        debts: rows,
      });
    })
  );
}
