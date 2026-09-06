/**
 * Dette de points de clan.
 *
 * Un membre peut engager plus de points qu'il n'en possède (paris à crédit).
 * Le manque devient une dette, prélevée sur ses gains futurs avant tout crédit
 * au classement.
 *
 * La dette appartient à la couche clans, pas au module qui l'a creusée : c'est
 * ce qui permet à un gain de progression, de boost ou du Daily Algo de la
 * rembourser sans que les clans aient à connaître les paris.
 */
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { applyDebtRepayment, BET_DEBT_CEILING } from '@kotbo/shared';
import { kotboEventBus } from '@kotbo/core';
import { broadcastDashboardStateChange } from '../../api/shared.js';

/**
 * Prévient les tableaux de bord ouverts qu'une dette a bougé.
 *
 * Un remboursement se fait en silence, sur un gain quelconque : sans cette
 * annonce, l'onglet Paris affiche des dettes déjà soldées jusqu'au prochain
 * rechargement de la page. Même canal que les paris, dont les dettes partagent
 * l'onglet.
 */
function notifyDebtsChanged(guildId: string): void {
  broadcastDashboardStateChange(guildId, 'clan_bets_updated');
}

export type ClanDebtSource = 'BET';

export async function getClanPointDebt(guildId: string, userId: string): Promise<number> {
  const row = await prisma.clanPointDebt.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { amount: true },
  });
  return row?.amount ?? 0;
}

/** Creuse ou aggrave une dette. Retourne le total dû après opération. */
export async function openClanPointDebt(params: {
  guildId: string;
  userId: string;
  amount: number;
  source?: ClanDebtSource;
}): Promise<number> {
  const amount = Math.floor(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return getClanPointDebt(params.guildId, params.userId);

  const row = await prisma.clanPointDebt.upsert({
    where: { guildId_userId: { guildId: params.guildId, userId: params.userId } },
    update: { amount: { increment: amount } },
    create: { guildId: params.guildId, userId: params.userId, amount, source: params.source ?? 'BET' },
  });

  // Le plafond est vérifié à l'ouverture du pari, mais deux acceptations
  // simultanées peuvent le franchir ensemble : on borne ici aussi, sans quoi la
  // colonne finirait par déborder l'entier 32 bits de Postgres.
  const total = row.amount > BET_DEBT_CEILING
    ? (await prisma.clanPointDebt.update({
        where: { guildId_userId: { guildId: params.guildId, userId: params.userId } },
        data: { amount: BET_DEBT_CEILING },
      })).amount
    : row.amount;

  if (total !== row.amount) {
    logger.warn('ClanDebt', `Dette de ${params.userId} bornée au plafond sur ${params.guildId}.`);
  }

  notifyDebtsChanged(params.guildId);

  kotboEventBus.publish('clan:debt-opened', {
    guildId: params.guildId,
    userId: params.userId,
    amount,
    total,
    source: params.source ?? 'BET',
    timestamp: Date.now(),
  });

  return total;
}

/**
 * Efface une part de dette sans contrepartie en points (annulation d'un pari).
 * La ligne disparaît dès qu'elle retombe à zéro : une dette nulle qui traîne
 * ferait payer une lecture inutile à chaque gain de points du membre.
 */
export async function cancelClanPointDebt(guildId: string, userId: string, amount: number): Promise<number> {
  const toCancel = Math.floor(amount);
  if (!Number.isFinite(toCancel) || toCancel <= 0) return getClanPointDebt(guildId, userId);

  const existing = await prisma.clanPointDebt.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { amount: true },
  });
  if (!existing) return 0;

  const remaining = Math.max(0, existing.amount - toCancel);
  if (remaining === 0) {
    await prisma.clanPointDebt.delete({ where: { guildId_userId: { guildId, userId } } }).catch(() => undefined);
    notifyDebtsChanged(guildId);
    return 0;
  }

  const updated = await prisma.clanPointDebt.update({
    where: { guildId_userId: { guildId, userId } },
    data: { amount: remaining },
  });
  notifyDebtsChanged(guildId);
  return updated.amount;
}

/**
 * Prélève sur un gain de quoi rembourser la dette, et retourne ce qu'il reste à
 * créditer.
 *
 * Appelé par `creditClanContribution` sur chaque crédit positif : c'est le seul
 * point de passage commun à toutes les origines de points, donc le seul endroit
 * où le remboursement ne peut pas être oublié par un module.
 */
export async function settleDebtFromGain(
  guildId: string,
  userId: string,
  gain: number,
): Promise<{ credited: number; repaid: number }> {
  if (gain <= 0) return { credited: gain, repaid: 0 };

  const debt = await prisma.clanPointDebt.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { amount: true },
  });
  if (!debt || debt.amount <= 0) return { credited: gain, repaid: 0 };

  const plan = applyDebtRepayment(gain, debt.amount);
  if (plan.repaid <= 0) return { credited: gain, repaid: 0 };

  if (plan.remainingDebt === 0) {
    await prisma.clanPointDebt.delete({ where: { guildId_userId: { guildId, userId } } }).catch(() => undefined);
    // Aucun message n'est envoyé d'ici : prévenir ou non le membre est un choix
    // de serveur, qui se règle avec un workflow sur `clan:debt-cleared`.
    kotboEventBus.publish('clan:debt-cleared', { guildId, userId, repaid: plan.repaid, timestamp: Date.now() });
  } else {
    await prisma.clanPointDebt.update({
      where: { guildId_userId: { guildId, userId } },
      data: { amount: plan.remainingDebt },
    });
  }

  notifyDebtsChanged(guildId);

  logger.info(
    'ClanDebt',
    `${plan.repaid} point(s) de ${userId} affecté(s) au remboursement de sa dette sur ${guildId} (reste ${plan.remainingDebt}).`,
  );

  return { credited: plan.credited, repaid: plan.repaid };
}

/**
 * Fige l'état des dettes à la clôture d'une saison.
 *
 * À appeler **avant** l'éventuelle remise à zéro des dettes : celle-ci
 * appartient à l'ouverture de la saison suivante, et annuler une clôture doit
 * aussi annuler sa purge.
 *
 * L'instantané précédent de la même saison est remplacé : reclore une saison
 * déjà annulée doit enregistrer ce qu'elle vaut cette fois-ci, pas ce qu'elle
 * valait au premier essai.
 */
export async function snapshotClanDebts(guildId: string, season: number): Promise<number> {
  const debts = await prisma.clanPointDebt.findMany({
    where: { guildId, amount: { gt: 0 } },
    select: { userId: true, amount: true, source: true },
  });

  await prisma.clanDebtSnapshot.deleteMany({ where: { guildId, season } });
  if (debts.length === 0) return 0;

  await prisma.clanDebtSnapshot.createMany({
    data: debts.map((debt) => ({ guildId, season, userId: debt.userId, amount: debt.amount, source: debt.source })),
    skipDuplicates: true,
  });

  logger.info('ClanDebt', `${debts.length} dette(s) figée(s) à la clôture de la saison ${season} sur ${guildId}.`);
  return debts.length;
}

/**
 * Rétablit les dettes telles qu'elles étaient à la fin d'une saison.
 *
 * Remplace l'état courant plutôt que de le compléter : un membre qui n'avait
 * aucune dette à la fin de la saison visée mais s'est endetté depuis doit voir
 * la sienne disparaître, exactement comme celui qui a remboursé entre-temps
 * doit revoir la sienne remonter.
 *
 * Sans instantané pour cette saison - clôture antérieure à cette mécanique -
 * l'état courant est laissé tel quel : effacer toutes les dettes serait un
 * cadeau, et les inventer une punition.
 */
export async function restoreClanDebts(guildId: string, season: number): Promise<number | null> {
  const snapshot = await prisma.clanDebtSnapshot.findMany({
    where: { guildId, season },
    select: { userId: true, amount: true, source: true },
  });

  // Aucune ligne pour cette saison veut dire deux choses : personne ne devait
  // rien, ou la clôture est antérieure à cette mécanique. La seconde ne se
  // distingue de la première que par l'absence totale d'instantané sur le
  // serveur, et les deux appellent des traitements opposés.
  if (snapshot.length === 0 && (await prisma.clanDebtSnapshot.count({ where: { guildId } })) === 0) {
    logger.warn(
      'ClanDebt',
      `Aucun instantané de dette pour la saison ${season} sur ${guildId} : les dettes courantes sont conservées.`,
    );
    return null;
  }

  await prisma.clanPointDebt.deleteMany({ where: { guildId } });
  if (snapshot.length > 0) {
    await prisma.clanPointDebt.createMany({
      data: snapshot.map((row) => ({ guildId, userId: row.userId, amount: row.amount, source: row.source })),
      skipDuplicates: true,
    });
  }

  logger.info('ClanDebt', `Dettes rétablies à leur état de fin de saison ${season} sur ${guildId} (${snapshot.length} ligne(s)).`);
  return snapshot.length;
}

/**
 * Efface les instantanés des saisons abandonnées par un retour arrière.
 *
 * Sans ce nettoyage, reclore la saison restaurée retrouverait l'ancien
 * instantané de la saison suivante, pris sur une partie qui n'a plus eu lieu.
 */
export async function dropClanDebtSnapshotsAfter(guildId: string, season: number): Promise<number> {
  const { count } = await prisma.clanDebtSnapshot.deleteMany({ where: { guildId, season: { gt: season } } });
  return count;
}
