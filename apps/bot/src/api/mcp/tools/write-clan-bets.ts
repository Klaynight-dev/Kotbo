/** Outils MCP - arbitrage des paris en points de clan (permission WRITE_COMMUNITY). */
import { z } from 'zod';
import prisma from '../../../utils/db.js';
import {
  betPotOf,
  describeBetSides,
  getEngagedBetCredit,
  loadFullBet,
  settleBetBySide,
  voidBetById,
} from '../../../services/community/clanBetService.js';
import { firmDebtOf } from '@kotbo/shared';
import { cancelClanPointDebt } from '../../../services/community/clanDebtService.js';
import { type McpToolContext, err, ok, resolveMember } from '../toolkit.js';

export function registerWriteClanBetsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta, audit } = ctx;

  if (!shouldRegister('WRITE_COMMUNITY')) return;

  server.registerTool(
    'resolve_clan_bet',
    {
      description:
        "Désigne le camp gagnant d'un pari en points de clan et distribue le pot. "
        + 'Le camp gagnant se partage le pot au prorata de ce que chacun a engagé, les perdants perdent leur mise. '
        + 'Action irréversible : lire le pari avec `get_clan_bet` avant de trancher.',
      inputSchema: {
        bet_id: z.string().describe('Identifiant du pari, visible en pied de son annonce'),
        side: z
          .union([z.number().int(), z.string()])
          .describe('Camp gagnant : sa position (0, 1, ...) ou son libellé exact'),
        key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ bet_id, side, key_name }) => {
      // Le verdict n'est attribué à personne : aucun membre n'a cliqué, et
      // désigner un responsable ferait porter la décision à quelqu'un qui ne
      // l'a pas prise. Le journal d'audit garde la trace de la clé qui l'a
      // demandée.
      const settled = await settleBetBySide({
        client,
        guildId,
        betId: bet_id,
        side: typeof side === 'number' ? side : String(side),
        resolvedById: null,
      });

      if (!settled.ok) return err(settled.message);

      const sides = describeBetSides(settled.bet);
      const winningPosition = settled.bet.sides.find((entry) => entry.id === settled.bet.winningSideId)?.position;
      const winners = sides.find((entry) => entry.position === winningPosition);

      await audit(
        key_name,
        'Verdict de pari MCP',
        settled.bet.subject,
        `Pari ${settled.bet.id} tranché en faveur de « ${winners?.label ?? '?'} », ${betPotOf(settled.bet)} point(s) distribués.`,
      );

      return ok({
        ok: true,
        betId: settled.bet.id,
        subject: settled.bet.subject,
        pot: betPotOf(settled.bet),
        winningSide: winners?.label ?? null,
        winners: winners?.members.map((member) => ({ userId: member.userId, engaged: member.engaged })) ?? [],
        sides,
      });
    })
  );

  server.registerTool(
    'void_clan_bet',
    {
      description:
        'Annule un pari en points de clan et rend sa mise à chaque parieur, part à crédit comprise. '
        + "À préférer à un verdict arbitraire quand le pari n'a plus lieu d'être.",
      inputSchema: {
        bet_id: z.string().describe('Identifiant du pari, visible en pied de son annonce'),
        key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ bet_id, key_name }) => {
      const before = await loadFullBet(bet_id);
      if (!before || before.guildId !== guildId) return err('Pari introuvable sur ce serveur.');

      const settled = await voidBetById({ client, guildId, betId: bet_id, resolvedById: null });
      if (!settled.ok) return err(settled.message);

      await audit(
        key_name,
        'Annulation de pari MCP',
        settled.bet.subject,
        `Pari ${settled.bet.id} annulé, ${betPotOf(before)} point(s) rendus.`,
      );

      return ok({
        ok: true,
        betId: settled.bet.id,
        subject: settled.bet.subject,
        status: settled.bet.status,
        refunded: betPotOf(before),
      });
    })
  );

  server.registerTool(
    'clear_clan_point_debt',
    {
      description:
        "Efface tout ou partie de la dette de points de clan d'un membre, sans contrepartie. "
        + 'Geste de correction : la dette disparaît sans que personne ne la rembourse. '
        + "Par défaut, seule la part ferme part : le crédit engagé dans des paris non tranchés reste dû "
        + "tant que le verdict n'est pas rendu.",
      inputSchema: {
        member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        amount: z.number().int().min(1).optional().describe('Montant à effacer ; par défaut, la dette ferme, paris en cours exclus'),
        key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ member, amount, key_name }) => {
      const resolved = await resolveMember(guildId, member);
      if (!resolved.ok) return resolved.response;

      const debt = await prisma.clanPointDebt.findUnique({
        where: { guildId_userId: { guildId, userId: resolved.userId } },
        select: { amount: true },
      });
      if (!debt || debt.amount <= 0) return err("Ce membre n'a aucune dette de points de clan.");

      const engaged = Math.min(debt.amount, (await getEngagedBetCredit(guildId, [resolved.userId])).get(resolved.userId) ?? 0);
      const firm = firmDebtOf(debt.amount, engaged);
      if (amount === undefined && firm <= 0) {
        return err(
          `Toute la dette de ce membre (${debt.amount}) est engagée dans des paris en cours. `
          + 'Précise un montant pour l\'effacer quand même.',
        );
      }

      const remaining = await cancelClanPointDebt(guildId, resolved.userId, amount ?? firm);
      const cleared = debt.amount - remaining;

      await audit(
        key_name,
        'Effacement de dette de clan MCP',
        resolved.userId,
        `${cleared} point(s) de dette effacé(s), reste ${remaining}.`,
      );

      return ok({ ok: true, userId: resolved.userId, cleared, remaining, engaged });
    })
  );
}
