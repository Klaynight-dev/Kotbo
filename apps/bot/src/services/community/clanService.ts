import { Client, EmbedBuilder, ChannelType, CategoryChannel, type Guild, type GuildMember, type Role } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { pushAudit, broadcastDashboardStateChange } from '../../api/shared.js';
import { getClient } from '../../utils/client.js';
import type { ClanMemberContribution } from '@prisma/client';
import { MAX_CLAN_SEASON_POINTS } from '@kotbo/shared';
import { isModuleEnabled } from '../core/moduleGate.js';

export const clanTasks = new Map<string, { type: 'distribute' | 'clear' | 'dedupe'; processed: number; total: number }>();

/**
 * Refus d'une opération de masse quand une autre tourne déjà.
 *
 * Le message nomme la tâche en cours et son avancement : sans ça, un refus sec
 * ressemble à une panne, alors qu'il suffit d'attendre.
 */
function busyTaskError(guildId: string): Error {
  const task = clanTasks.get(guildId);
  const label = task?.type === 'distribute' ? 'la distribution des clans'
    : task?.type === 'dedupe' ? 'le nettoyage des clans multiples'
    : 'le retrait des rôles de clan';
  const progress = task && task.total > 0 ? ` (${task.processed}/${task.total})` : '';

  return new Error(
    `Impossible de lancer cette opération : ${label}${progress} est encore en cours sur ce serveur. `
    + 'Sa progression est affichée sur le Dashboard, réessayez une fois terminée.'
  );
}

// ─── Balise de champion sur la catégorie QG ──────────────────────────────────
// Format unifié : « <nom de base> [🏆 CHAMPION · <bonus>] ». La balise est
// toujours placée en fin de nom, ce qui permet de la retirer proprement (peu
// importe où elle a été ajoutée par une version précédente) via stripTrophyTag.

/** Origines possibles d'un gain de points de clan, telles qu'affichées côté public. */
export type ClanContributionSource =
  | 'XP' | 'ADMIN' | 'BOOST' | 'DAILY_ALGO' | 'BET' | 'DEBT' | 'DROP'
  // Les primes du podium des parieurs gardent leur marche : versées sur la saison
  // suivante, elles y apparaîtraient sinon comme un pari gagné le premier jour.
  | 'BET_TOP1' | 'BET_TOP2' | 'BET_TOP3'
  // Les trois origines du RPG sont distinguées : le flux public dit d'où vient le gain,
  // un boss valant rarement le même effort qu'un monstre croisé au hasard.
  | 'RPG_BOSS' | 'RPG_MOB' | 'RPG_ITEM'
  // Le raid hebdomadaire se distingue du boss solo : c'est un gain collectif, versé une
  // fois par semaine, que le flux public ne doit pas confondre avec du farm individuel.
  | 'RPG_RAID'
  // Une quête d'équipe se gagne à plusieurs sur une fenêtre donnée : le flux public doit
  // pouvoir la distinguer d'un raid comme d'un gain individuel.
  | 'RPG_QUEST';

/**
 * Crédite des points de clan pour une saison et renvoie le montant réellement
 * inscrit.
 *
 * Le total d'une saison vit dans une colonne `Int`. Sans plafond, un barème mal
 * calibré finit par déborder l'entier 32 bits : Postgres rejette alors
 * l'écriture au milieu de l'attribution, et le `catch` qui entoure les appelants
 * fait disparaître le gain sans trace exploitable. On incrémente puis on ramène
 * au plafond, ce qui reste juste quand deux gains arrivent en même temps.
 *
 * Un montant négatif est accepté (retrait manuel décidé par un administrateur).
 * Le score d'un membre est alors ramené à zéro plutôt que de passer sous la
 * barre : personne ne doit se retrouver avec un score négatif au classement.
 *
 * `allowNegativeBalance` lève ce plancher, et sert au pseudo-membre qui porte
 * les points donnés au clan entier : le total d'un clan étant la somme de
 * toutes ses lignes, c'est la seule façon de retirer des points à un clan dont
 * le score vient des membres. Le solde reste borné à l'opposé du plafond, pour
 * la même raison qu'en haut : sous -2 147 483 648, Postgres rejette l'écriture.
 *
 * Un membre endetté voit son gain servir d'abord à rembourser : c'est le seul
 * point de passage commun à toutes les origines de points, donc le seul endroit
 * où le remboursement ne peut pas être oublié par un module. `skipDebt` le
 * court-circuite pour un mouvement qui rend ce qui vient d'être pris au lieu
 * d'apporter un gain - le remboursement d'une mise annulée - qui irait sinon
 * solder une dette que l'annulation vient déjà d'effacer.
 */
export async function creditClanContribution(params: {
  guildId: string;
  clanId: string;
  userId: string;
  season: number;
  amount: number;
  allowNegativeBalance?: boolean;
  skipDebt?: boolean;
}): Promise<{ granted: number; contribution: ClanMemberContribution | null; debtRepaid: number }> {
  const { guildId, clanId, userId, season, allowNegativeBalance = false, skipDebt = false } = params;
  let amount = params.amount;
  if (!Number.isFinite(amount) || amount === 0) return { granted: 0, contribution: null, debtRepaid: 0 };

  // Le remboursement précède l'écriture : le classement ne doit jamais afficher,
  // même une fraction de seconde, des points déjà engagés ailleurs.
  let debtRepaid = 0;
  if (amount > 0 && !skipDebt) {
    const { settleDebtFromGain } = await import('./clanDebtService.js');
    const settled = await settleDebtFromGain(guildId, userId, amount);
    debtRepaid = settled.repaid;
    amount = settled.credited;

    // Le remboursement est journalisé à part, en négatif. Sans cette ligne, le
    // flux public n'afficherait que le solde net d'un gain : un membre qui
    // gagne 100 en devant 70 y verrait « +30 », sans rien qui explique l'écart
    // avec le montant annoncé sur Discord.
    if (debtRepaid > 0) {
      await logClanContribution(guildId, clanId, userId, -debtRepaid, 'DEBT', season);
    }
    if (amount === 0) return { granted: 0, contribution: null, debtRepaid };
  }

  const where = { guildId_clanId_userId_season: { guildId, clanId, userId, season } };

  // Un retrait sur une ligne inexistante n'a rien à retirer : la créer laisserait
  // un participant à zéro point dans les classements.
  if (amount < 0 && !allowNegativeBalance) {
    const existing = await prisma.clanMemberContribution.findUnique({ where, select: { xp: true } });
    if (!existing) return { granted: 0, contribution: null, debtRepaid };
  }

  const contribution = await prisma.clanMemberContribution.upsert({
    where,
    update: { xp: { increment: amount } },
    create: { guildId, clanId, userId, season, xp: amount },
  });

  const minimum = allowNegativeBalance ? -MAX_CLAN_SEASON_POINTS : 0;
  const bounded = Math.min(MAX_CLAN_SEASON_POINTS, Math.max(minimum, contribution.xp));
  if (bounded === contribution.xp) return { granted: amount, contribution, debtRepaid };

  const clamped = await prisma.clanMemberContribution
    .update({ where, data: { xp: bounded } })
    .catch(() => null);
  logger.warn(
    'ClanService',
    contribution.xp < 0
      ? `Retrait borné pour ${userId} dans le clan ${clanId} : total ramené à ${bounded}.`
      : `Plafond de points de saison atteint pour ${userId} dans le clan ${clanId}, gain rogné.`,
  );

  return {
    granted: amount - (contribution.xp - bounded),
    contribution: clamped ?? contribution,
    debtRepaid,
  };
}

/**
 * Le membre appartient-il à un clan ?
 *
 * L'appartenance se lit sur les rôles Discord, seule source de vérité : c'est ce que
 * `awardClanPointsToMembers` regarde pour décider d'un versement. Sert à refuser en amont
 * ce qui ne rapporterait rien - un objet consommé pour des points que personne ne toucherait.
 */
export async function memberHasClan(guildId: string, member: GuildMember): Promise<boolean> {
  const clans = await prisma.clan.findMany({ where: { guildId }, select: { roleId: true } });
  return clans.some((clan) => member.roles.cache.has(clan.roleId));
}

/**
 * Journalise un gain de points de clan pour le flux « derniers scores » public.
 * `source` : 'XP' (progression), 'ADMIN' (attribution manuelle), 'BOOST' (boost du
 * serveur), 'DAILY_ALGO' (conversion des points de la semaine), 'BET' (pari
 * entre deux membres), 'BET_TOP1' à 'BET_TOP3' (prime du podium des parieurs de
 * la saison écoulée), 'DEBT' (part d'un gain partie en remboursement),
 * 'DROP' (drop aléatoire ramassé dans un salon), 'RPG_BOSS' ou 'RPG_MOB' (créature
 * vaincue) et 'RPG_ITEM' (objet de la boutique RPG consommé).
 * `userId` : identifiant du membre, ou 'system_manual_points' pour un gain
 * attribué au clan entier (affiché au nom du clan côté public).
 * `credit` : part du mouvement financée à crédit, quand il y en a une. Elle ne
 * s'ajoute pas au montant - elle n'a bougé aucun score - mais elle explique le
 * remboursement qui apparaîtra plus tard dans le flux. Une mise entièrement à
 * crédit se journalise donc avec un montant nul et cette seule part.
 * Best-effort : n'interrompt jamais le flux appelant en cas d'erreur.
 */
export async function logClanContribution(
  guildId: string,
  clanId: string,
  userId: string,
  amount: number,
  source: ClanContributionSource,
  season: number,
  credit?: number,
): Promise<void> {
  try {
    const creditShare = credit && credit > 0 ? Math.floor(credit) : null;
    if (!amount && !creditShare) return;
    await prisma.clanContributionEvent.create({
      data: { guildId, clanId, userId, amount, source, season, credit: creditShare },
    });
  } catch (err) {
    logger.error('ClanService', `Erreur lors de la journalisation d'un gain de clan (${clanId}, ${userId}):`, err);
  }
}

/**
 * Attribue des points de clan à plusieurs membres d'un coup.
 *
 * Fonction **générique et sans opinion** : elle reçoit des montants déjà calculés
 * et un simple libellé d'origine. C'est volontaire - les clans n'ont pas à
 * connaître le Daily Algo ni aucun autre module. Le sens de la dépendance va
 * toujours du module appelant vers les clans, jamais l'inverse.
 *
 * Ne fait rien si les clans sont désactivés, si aucun clan n'existe, ou pour un
 * membre qui n'appartient à aucun clan : ces cas sont normaux, pas des erreurs.
 *
 * Retourne, par identifiant d'origine, le nombre de points réellement attribués.
 */
export async function awardClanPointsToMembers(params: {
  guildId: string;
  client: Client;
  source: ClanContributionSource;
  /** Montants déjà calculés et arrondis par l'appelant. */
  awards: Array<{ userId: string; amount: number }>;
  reason?: string;
}): Promise<Map<string, number>> {
  const granted = new Map<string, number>();

  const positiveAwards = params.awards.filter((award) => award.amount > 0);
  if (positiveAwards.length === 0) return granted;

  const guildConfig = await prisma.guild.findUnique({
    where: { id: params.guildId },
    select: { clansEnabled: true, currentClanSeason: true },
  });

  if (!guildConfig?.clansEnabled) return granted;

  const clans = await prisma.clan.findMany({
    where: { guildId: params.guildId },
    select: { id: true, name: true, roleId: true },
  });
  if (clans.length === 0) return granted;

  const discordGuild = params.client.guilds.cache.get(params.guildId)
    ?? await params.client.guilds.fetch(params.guildId).catch(() => null);
  if (!discordGuild) return granted;

  const { getAllLinkedUserIds } = await import('../moderation/altAccountService.js');

  for (const award of positiveAwards) {
    try {
      const member = discordGuild.members.cache.get(award.userId)
        ?? await discordGuild.members.fetch(award.userId).catch(() => null);

      // Membre parti du serveur : on n'attribue rien, sans lever d'erreur.
      if (!member || member.user.bot) continue;

      const memberClanRole = member.roles.cache.find((role) => clans.some((clan) => clan.roleId === role.id));
      if (!memberClanRole) continue; // Aucun clan : cas normal.

      const clan = clans.find((entry) => entry.roleId === memberClanRole.id);
      if (!clan) continue;

      // Identifiant canonique : sans ça, un membre avec un double compte se
      // retrouverait avec deux lignes de contribution pour la même saison.
      const linkedIds = await getAllLinkedUserIds(params.guildId, member.id).catch(() => [member.id]);
      const canonicalUserId = linkedIds.sort()[0] ?? member.id;

      await creditClanContribution({
        guildId: params.guildId,
        clanId: clan.id,
        userId: canonicalUserId,
        season: guildConfig.currentClanSeason,
        amount: award.amount,
      });

      await logClanContribution(
        params.guildId,
        clan.id,
        canonicalUserId,
        award.amount,
        params.source,
        guildConfig.currentClanSeason,
      );

      granted.set(award.userId, award.amount);
    } catch (err) {
      logger.error('ClanService', `Erreur lors de l'attribution de points de clan à ${award.userId} :`, err);
    }
  }

  if (granted.size > 0) {
    const total = [...granted.values()].reduce((sum, value) => sum + value, 0);
    logger.info(
      'ClanService',
      `${total} point(s) de clan attribué(s) à ${granted.size} membre(s) (${params.source}${params.reason ? ` · ${params.reason}` : ''}) sur ${params.guildId}.`,
    );
    broadcastDashboardStateChange(params.guildId, 'clans_updated');

    // Les pages publiques servent une reponse mise en cache trente secondes : sans cette
    // invalidation, des points gagnes a l'instant mettaient jusqu'a une demi-minute a
    // apparaitre, ce qui se lit comme un compteur qui ne bouge pas. Seules les deux cles
    // concernees sont retirees : balayer tout le prefixe du serveur reviendrait a vider
    // l'analytique a chaque monstre vaincu.
    const { cache } = await import('../../utils/cache.js');
    await Promise.all([
      cache.delete(`guild:${params.guildId}:public-clans`),
      cache.delete(`guild:${params.guildId}:public-rpg`),
    ]).catch(() => null);
  }

  return granted;
}

/** Retire toute balise trophée « [🏆 ...] » d'un nom de catégorie (début, milieu ou fin). */
export function stripTrophyTag(name: string): string {
  return name.replace(/\s*\[🏆[^\]]*\]\s*/gu, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Construit le nom de catégorie du QG d'un clan pour une fin de saison.
 * - Perdant : nom de base nettoyé (aucune balise).
 * - Gagnant : nom de base + « [🏆 CHAMPION] » (avec la liste des bonus actifs si présents).
 */
export function buildCategoryName(currentName: string, isWinner: boolean, rewards: string[] = []): string {
  const base = stripTrophyTag(currentName);
  if (!isWinner) return base;
  const suffix = rewards.length > 0 ? `CHAMPION · ${rewards.join(' + ')}` : 'CHAMPION';
  return `${base} [🏆 ${suffix}]`;
}

/**
 * Cadence des notifications de progression.
 *
 * Chaque `broadcastDashboardStateChange` fait recharger l'état complet de la
 * guilde à tous les panels ouverts. Prévenir à chaque membre traité, soit toutes
 * les 450 ms, revenait à leur faire retélécharger salons, rôles et catégories
 * des centaines de fois pour une barre de progression. On prévient donc au
 * rythme de l'oeil, et systématiquement à la fin.
 */
const CLAN_TASK_PROGRESS_INTERVAL_MS = 2_000;

export async function runDistribution(guildId: string, client: Client, initiatorName: string): Promise<string> {
  // Le verrou est posé avant le premier `await`. La préparation (lecture des
  // clans, fetch du serveur et surtout `members.fetch()`) dure plusieurs secondes
  // sur un gros serveur : en le posant après, deux clics rapprochés - ou deux
  // administrateurs - franchissaient tous les deux le test et lançaient deux
  // distributions concurrentes sur les mêmes membres.
  if (clanTasks.has(guildId)) {
    throw busyTaskError(guildId);
  }
  clanTasks.set(guildId, { type: 'distribute', processed: 0, total: 0 });

  let targetList: GuildMember[];
  let assignableClans: { roleId: string; count: number }[];
  let discordGuild: Guild;

  try {
    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length === 0) {
      throw new Error('Veuillez configurer au moins un clan avant de lancer la distribution.');
    }

    const resolvedGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!resolvedGuild) {
      throw new Error('Serveur introuvable sur Discord.');
    }
    discordGuild = resolvedGuild;

    // Récupérer tous les membres
    const allMembers = await discordGuild.members.fetch().catch(() => null);
    if (!allMembers) {
      throw new Error('Impossible de récupérer la liste des membres Discord.');
    }

    const clanRoleIds = clans.map((c) => c.roleId);

    // Un clan dont le rôle Discord a été supprimé ne peut rien recevoir. Le
    // garder dans la répartition serait pire que l'ignorer : son effectif
    // resterait à zéro, donc il serait choisi à chaque tour comme « le plus
    // petit clan », et toutes les attributions échoueraient en silence.
    assignableClans = clans
      .filter((clan) => discordGuild.roles.cache.has(clan.roleId))
      .map((clan) => ({
        roleId: clan.roleId,
        count: discordGuild.roles.cache.get(clan.roleId)?.members.size ?? 0,
      }));

    if (assignableClans.length === 0) {
      throw new Error('Aucun clan configuré ne correspond à un rôle existant sur Discord. Vérifiez la configuration des clans.');
    }

    if (assignableClans.length < clans.length) {
      logger.warn(
        'ClanService',
        `${clans.length - assignableClans.length} clan(s) ignoré(s) sur ${guildId} : leur rôle Discord n'existe plus.`,
      );
    }

    // Filtrer les humains qui n'ont pas encore de rôle de clan
    const membersWithoutClan = allMembers.filter((member) => {
      if (member.user.bot) return false;
      return !member.roles.cache.some((r) => clanRoleIds.includes(r.id));
    });

    if (membersWithoutClan.size === 0) {
      clanTasks.delete(guildId);
      return 'Tous les membres ont déjà un clan.';
    }

    targetList = [...membersWithoutClan.values()];
  } catch (err) {
    // La préparation a échoué : le verrou ne doit pas rester posé, sinon plus
    // aucune opération de masse n'est possible jusqu'au redémarrage du bot.
    clanTasks.delete(guildId);
    throw err;
  }

  clanTasks.set(guildId, { type: 'distribute', processed: 0, total: targetList.length });
  broadcastDashboardStateChange(guildId, 'clans_updated');

  // Lancement asynchrone non-bloquant
  (async () => {
    logger.info('ClanService', `Lancement de la distribution équilibrée pour ${targetList.length} membres dans "${discordGuild.name}" par ${initiatorName}`);

    // Mélanger la liste pour préserver le côté aléatoire
    const shuffledList = [...targetList].sort(() => Math.random() - 0.5);
    const clanCounts = [...assignableClans];
    const failuresByRoleId = new Map<string, number>();
    let lastProgressAt = 0;

    for (let i = 0; i < shuffledList.length; i++) {
      const currentTask = clanTasks.get(guildId);
      if (!currentTask || currentTask.type !== 'distribute') break;

      if (clanCounts.length === 0) {
        logger.error('ClanService', `Distribution interrompue sur ${guildId} : plus aucun clan attribuable.`);
        break;
      }

      const member = shuffledList[i];

      // Trouver le clan qui a actuellement le moins de membres
      clanCounts.sort((a, b) => a.count - b.count);
      const targetClan = clanCounts[0];

      try {
        await member.roles.add(targetClan.roleId, 'Distribution globale et équilibrée des clans');
        targetClan.count++; // Incrémenter pour la répartition suivante
        failuresByRoleId.delete(targetClan.roleId);
      } catch (e) {
        logger.warn('ClanService', `Impossible d'attribuer le clan à ${member.user.tag}:`, e);

        // Un rôle que le bot ne peut pas poser (hiérarchie, permissions) échoue
        // à tous les coups et reste éternellement le plus petit : on le sort de
        // la répartition plutôt que de laisser toute la distribution échouer.
        const failures = (failuresByRoleId.get(targetClan.roleId) ?? 0) + 1;
        failuresByRoleId.set(targetClan.roleId, failures);

        if (failures >= 3) {
          clanCounts.splice(clanCounts.indexOf(targetClan), 1);
          logger.error(
            'ClanService',
            `Rôle ${targetClan.roleId} retiré de la distribution sur ${guildId} après 3 échecs consécutifs (permissions ou hiérarchie).`,
          );
        }
      }

      clanTasks.set(guildId, {
        type: 'distribute',
        processed: i + 1,
        total: shuffledList.length,
      });

      const now = Date.now();
      if (now - lastProgressAt >= CLAN_TASK_PROGRESS_INTERVAL_MS || i === shuffledList.length - 1) {
        lastProgressAt = now;
        broadcastDashboardStateChange(guildId, 'clans_updated');
      }

      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    logger.info('ClanService', `Distribution équilibrée terminée pour "${discordGuild.name}"`);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  })().catch((e) => {
    logger.error('ClanService', 'Erreur critique dans le thread de distribution:', e);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  });

  await pushAudit(guildId, {
    user: initiatorName,
    action: 'Lancement distribution de clans',
    context: discordGuild.name,
    module: 'Clans',
    eventType: 'Manuel',
    details: `Distribution aléatoire lancée pour ${targetList.length} membres.`,
    channelId: null,
  }).catch(() => null);

  return `La distribution aléatoire des clans à ${targetList.length} membres a commencé en arrière-plan. Cette opération s'effectue progressivement pour respecter les limites de requêtes de Discord et peut prendre plusieurs minutes. Vous pouvez suivre l'avancement sur le Dashboard.`;
}

/**
 * Vide un rôle de tous ses porteurs en le remplaçant par un jumeau vierge :
 * on recrée le rôle à l'identique, on lui transfère les autorisations de salon,
 * puis on supprime l'ancien - Discord le retire alors de tout le monde d'un coup.
 *
 * Retirer le rôle membre par membre coûte une requête par personne, soit des
 * dizaines de minutes sur un gros serveur ; ici c'est une poignée de requêtes,
 * quel que soit l'effectif. En contrepartie l'identifiant du rôle change : tout
 * réglage extérieur qui le désigne (autre bot, permission posée à la main
 * ailleurs qu'en salon) est à refaire.
 *
 * Retourne le nouveau rôle, ou `null` si l'échange n'a pas pu se faire.
 */
async function swapRoleForEmptyTwin(guild: Guild, roleId: string, reason: string): Promise<Role | null> {
  const oldRole = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!oldRole) return null;

  let twin: Role;
  try {
    twin = await guild.roles.create({
      name: oldRole.name,
      color: oldRole.color,
      hoist: oldRole.hoist,
      mentionable: oldRole.mentionable,
      permissions: oldRole.permissions,
      position: oldRole.position,
      reason,
    });
  } catch (err) {
    logger.warn('ClanService', `Impossible de recréer le rôle "${oldRole.name}" :`, err);
    return null;
  }

  // Décorations réservées aux serveurs boostés : leur absence n'est pas un échec.
  if (oldRole.unicodeEmoji) await twin.setUnicodeEmoji(oldRole.unicodeEmoji, reason).catch(() => null);
  else if (oldRole.icon) await twin.setIcon(oldRole.iconURL(), reason).catch(() => null);

  // Sans ce report, un QG réservé au rôle deviendrait inaccessible - ou public.
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread()) continue;

    const overwrite = channel.permissionOverwrites.cache.get(oldRole.id);
    if (!overwrite) continue;

    const options: Record<string, boolean> = {};
    for (const perm of overwrite.allow.toArray()) options[perm] = true;
    for (const perm of overwrite.deny.toArray()) options[perm] = false;

    await channel.permissionOverwrites.create(twin, options, { reason }).catch((err: unknown) => {
      logger.warn('ClanService', `Autorisations non reportées sur #${channel.name} pour "${oldRole.name}" :`, err);
    });
  }

  try {
    await oldRole.delete(reason);
  } catch (err) {
    // L'ancien rôle survit : on annule le jumeau plutôt que de laisser un doublon.
    logger.warn('ClanService', `Suppression du rôle "${oldRole.name}" refusée, échange annulé :`, err);
    await twin.delete('Annulation de l\'échange de rôle').catch(() => null);
    return null;
  }

  return twin;
}

/** Repli quand l'échange de rôle échoue : retrait un par un, à la cadence Discord. */
async function removeRoleMemberByMember(guild: Guild, roleId: string, reason: string): Promise<void> {
  await guild.members.fetch().catch(() => null);
  const role = guild.roles.cache.get(roleId);
  if (!role) return;

  for (const member of [...role.members.values()]) {
    await member.roles.remove(roleId, reason).catch((e) => {
      logger.warn('ClanService', `Impossible de retirer le clan de ${member.user.tag}:`, e);
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
}

export async function runClear(guildId: string, client: Client, initiatorName: string): Promise<string> {
  // Même verrou anticipé que pour la distribution : voir le commentaire là-bas.
  if (clanTasks.has(guildId)) {
    throw busyTaskError(guildId);
  }
  clanTasks.set(guildId, { type: 'clear', processed: 0, total: 0 });

  let clans: { id: string; name: string; roleId: string }[];
  let discordGuild: Guild;

  try {
    clans = await prisma.clan.findMany({
      where: { guildId },
      select: { id: true, name: true, roleId: true },
    });
    if (clans.length === 0) {
      throw new Error('Aucun clan n\'est configuré sur ce serveur.');
    }

    const resolvedGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!resolvedGuild) {
      throw new Error('Serveur introuvable sur Discord.');
    }
    discordGuild = resolvedGuild;
  } catch (err) {
    clanTasks.delete(guildId);
    throw err;
  }

  clanTasks.set(guildId, { type: 'clear', processed: 0, total: clans.length });
  broadcastDashboardStateChange(guildId, 'clans_updated');

  // Lancement asynchrone
  (async () => {
    logger.info('ClanService', `Lancement du retrait de tous les clans (${clans.length} rôle(s)) dans "${discordGuild.name}" par ${initiatorName}`);

    for (let i = 0; i < clans.length; i++) {
      const currentTask = clanTasks.get(guildId);
      if (!currentTask || currentTask.type !== 'clear') break;

      const clan = clans[i];
      const role = discordGuild.roles.cache.get(clan.roleId);

      // Un rôle que le bot ne peut ni supprimer ni retirer (au-dessus de lui,
      // géré par une intégration, ou @everyone) : ni l'échange ni le retrait un
      // par un ne passeront, autant le dire tout de suite que de marteler
      // Discord d'un refus par membre.
      if (role && (!role.editable || role.id === discordGuild.id)) {
        logger.warn('ClanService', `Rôle du clan "${clan.name}" hors de portée du bot (hiérarchie, intégration ou @everyone) : clan ignoré.`);
        clanTasks.set(guildId, { type: 'clear', processed: i + 1, total: clans.length });
        continue;
      }

      const twin = await swapRoleForEmptyTwin(discordGuild, clan.roleId, 'Retrait global de tous les rôles de clan');

      if (twin) {
        await prisma.clan.update({ where: { id: clan.id }, data: { roleId: twin.id } }).catch((e) => {
          logger.error('ClanService', `Le clan "${clan.name}" pointe encore sur l'ancien rôle supprimé :`, e);
        });
        logger.info('ClanService', `Rôle du clan "${clan.name}" vidé par échange (${clan.roleId} → ${twin.id}).`);
      } else {
        logger.warn('ClanService', `Échange impossible pour "${clan.name}", retrait membre par membre.`);
        await removeRoleMemberByMember(discordGuild, clan.roleId, 'Retrait global de tous les rôles de clan');
      }

      clanTasks.set(guildId, { type: 'clear', processed: i + 1, total: clans.length });
      broadcastDashboardStateChange(guildId, 'clans_updated');
    }

    logger.info('ClanService', `Retrait de tous les clans terminé pour "${discordGuild.name}"`);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  })().catch((e) => {
    logger.error('ClanService', 'Erreur critique dans le thread de retrait:', e);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  });

  await pushAudit(guildId, {
    user: initiatorName,
    action: 'Lancement retrait de clans',
    context: discordGuild.name,
    module: 'Clans',
    eventType: 'Manuel',
    details: `Retrait des clans lancé sur ${clans.length} rôle(s), par recréation du rôle.`,
    channelId: null,
  }).catch(() => null);

  return `Les ${clans.length} rôle(s) de clan sont en cours de remise à zéro : chacun est recréé à l'identique puis l'ancien est supprimé, ce qui le retire de tous les membres d'un coup. Les autorisations de salon sont reportées sur le nouveau rôle.`;
}

/**
 * Retire la balise de champion des catégories QG.
 *
 * Utilisée par la réinitialisation totale, qui supprime les clans en base :
 * sinon un QG reste décoré du trophée d'une saison qui n'existe plus. Les rôles
 * des membres ne sont volontairement pas touchés - remettre les compteurs à zéro
 * n'a pas à défaire l'appartenance des gens à leur clan. Les clans sont passés
 * en paramètre, la base étant vidée dans la foulée.
 */
export async function runClanArtifactCleanup(
  guildId: string,
  client: Client,
  clans: { generalChannelId: string | null }[],
  initiatorName: string
): Promise<void> {
  if (clans.length === 0) return;

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  logger.info('ClanService', `Nettoyage des balises de champion sur "${discordGuild.name}" par ${initiatorName}`);

  for (const clan of clans) {
    if (!clan.generalChannelId) continue;

    const channel = discordGuild.channels.cache.get(clan.generalChannelId)
      || await discordGuild.channels.fetch(clan.generalChannelId).catch(() => null);
    const category = channel?.parent?.type === ChannelType.GuildCategory
      ? channel.parent as CategoryChannel
      : null;
    if (!category) continue;

    const targetName = stripTrophyTag(category.name);
    if (category.name !== targetName) {
      await category.setName(targetName, 'Réinitialisation totale des clans').catch((err) => {
        logger.warn('ClanService', `Impossible de renommer la catégorie ${category.name}:`, err);
      });
    }
  }
}

/**
 * Répare les membres qui portent plusieurs rôles de clan.
 *
 * La sécurité de clan unique est **réactive** : elle se déclenche à l'ajout d'un
 * rôle et ne repasse jamais sur l'existant. Un cumul né avant son activation,
 * pendant une coupure de la passerelle, ou d'un retrait de rôle refusé par
 * Discord, reste donc en place indéfiniment et gonfle les effectifs affichés.
 *
 * Clan conservé, dans l'ordre : celui où le membre a le plus contribué cette
 * saison - on ne lui fait pas perdre son XP - sinon le moins peuplé, ce qui
 * rééquilibre au passage. Les rôles retirés voient leurs contributions migrées
 * vers le clan conservé.
 */
export async function runDeduplicate(guildId: string, client: Client, initiatorName: string): Promise<string> {
  if (clanTasks.has(guildId)) {
    throw busyTaskError(guildId);
  }
  clanTasks.set(guildId, { type: 'dedupe', processed: 0, total: 0 });

  let duplicates: { member: GuildMember; clanIds: string[] }[];
  let discordGuild: Guild;
  let clansById: Map<string, { id: string; name: string; roleId: string }>;
  let currentSeason: number;

  try {
    const guildData = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { currentClanSeason: true },
    });
    currentSeason = guildData?.currentClanSeason ?? 1;

    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length < 2) {
      throw new Error('Il faut au moins deux clans configurés pour qu\'un doublon soit possible.');
    }

    const resolvedGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!resolvedGuild) {
      throw new Error('Serveur introuvable sur Discord.');
    }
    discordGuild = resolvedGuild;

    const allMembers = await discordGuild.members.fetch().catch(() => null);
    if (!allMembers) {
      throw new Error('Impossible de récupérer la liste des membres Discord.');
    }

    clansById = new Map(clans.map((clan) => [clan.id, { id: clan.id, name: clan.name, roleId: clan.roleId }]));
    const clanByRoleId = new Map(clans.map((clan) => [clan.roleId, clan]));

    duplicates = [];
    for (const member of allMembers.values()) {
      const held = member.roles.cache
        .filter((role) => clanByRoleId.has(role.id))
        .map((role) => clanByRoleId.get(role.id)!.id);

      if (held.length > 1) {
        duplicates.push({ member, clanIds: held });
      }
    }

    if (duplicates.length === 0) {
      clanTasks.delete(guildId);
      return 'Aucun membre ne cumule plusieurs clans.';
    }
  } catch (err) {
    clanTasks.delete(guildId);
    throw err;
  }

  clanTasks.set(guildId, { type: 'dedupe', processed: 0, total: duplicates.length });
  broadcastDashboardStateChange(guildId, 'clans_updated');

  const total = duplicates.length;

  (async () => {
    logger.info('ClanService', `Nettoyage de ${total} membre(s) à clans multiples dans "${discordGuild.name}" par ${initiatorName}`);

    // Import dynamique, comme dans `awardClanPointsToMembers` : le module des
    // doubles comptes n'a pas à être chargé pour qui n'utilise pas les clans.
    const { getAllLinkedUserIds } = await import('../moderation/altAccountService.js');

    // Effectifs courants, pour départager les membres sans contribution en
    // faveur du clan le moins peuplé.
    const counts = new Map<string, number>();
    for (const clan of clansById.values()) {
      counts.set(clan.id, discordGuild.roles.cache.get(clan.roleId)?.members.size ?? 0);
    }

    let lastProgressAt = 0;
    let repaired = 0;

    for (let i = 0; i < duplicates.length; i++) {
      const currentTask = clanTasks.get(guildId);
      if (!currentTask || currentTask.type !== 'dedupe') break;

      const { member, clanIds } = duplicates[i];

      // Les contributions sont stockées sous l'identifiant canonique d'un groupe
      // de comptes liés (cf. `awardClanPointsToMembers`). Chercher sur le seul
      // `member.id` ferait lire zéro XP à un double compte, et on le déplacerait
      // alors vers un clan où il n'a rien construit.
      const linkedIds = await getAllLinkedUserIds(guildId, member.id).catch(() => [member.id]);
      const canonicalUserId = linkedIds.sort()[0] ?? member.id;

      const contributions = await prisma.clanMemberContribution.groupBy({
        by: ['clanId'],
        where: { guildId, userId: canonicalUserId, season: currentSeason, clanId: { in: clanIds } },
        _sum: { xp: true },
      }).catch(() => [] as { clanId: string; _sum: { xp: number | null } }[]);

      const xpByClanId = new Map(contributions.map((row) => [row.clanId, row._sum.xp ?? 0]));

      const keptClanId = [...clanIds].sort((a, b) => {
        const xpDiff = (xpByClanId.get(b) ?? 0) - (xpByClanId.get(a) ?? 0);
        if (xpDiff !== 0) return xpDiff;
        return (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
      })[0];

      const removedClanIds = clanIds.filter((clanId) => clanId !== keptClanId);
      const rolesToRemove = removedClanIds
        .map((clanId) => clansById.get(clanId)?.roleId)
        .filter((roleId): roleId is string => !!roleId);

      try {
        await member.roles.remove(rolesToRemove, 'Nettoyage : un membre ne peut appartenir qu\'à un seul clan');
        repaired += 1;

        for (const clanId of removedClanIds) {
          counts.set(clanId, Math.max(0, (counts.get(clanId) ?? 1) - 1));
          // L'XP gagnée sous l'ancien rôle suit le membre : la retirer serait
          // le punir d'un doublon qu'il n'a pas provoqué.
          await migrateContributions(guildId, canonicalUserId, clanId, keptClanId, currentSeason);
        }

        logger.info(
          'ClanService',
          `${member.user.tag} conservé dans "${clansById.get(keptClanId)?.name}", retiré de [${removedClanIds.map((id) => clansById.get(id)?.name).join(', ')}].`,
        );
      } catch (e) {
        logger.warn('ClanService', `Impossible de nettoyer les clans de ${member.user.tag}:`, e);
      }

      clanTasks.set(guildId, { type: 'dedupe', processed: i + 1, total });

      const now = Date.now();
      if (now - lastProgressAt >= CLAN_TASK_PROGRESS_INTERVAL_MS || i === duplicates.length - 1) {
        lastProgressAt = now;
        broadcastDashboardStateChange(guildId, 'clans_updated');
      }

      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    logger.info('ClanService', `Nettoyage des clans multiples terminé pour "${discordGuild.name}" : ${repaired}/${total} membre(s) corrigé(s).`);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  })().catch((e) => {
    logger.error('ClanService', 'Erreur critique dans le thread de nettoyage:', e);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  });

  await pushAudit(guildId, {
    user: initiatorName,
    action: 'Nettoyage des clans multiples',
    context: discordGuild.name,
    module: 'Clans',
    eventType: 'Manuel',
    details: `Nettoyage lancé pour ${total} membre(s) portant plusieurs rôles de clan.`,
    channelId: null,
  }).catch(() => null);

  return `${total} membre(s) portent plusieurs clans. Le nettoyage a commencé en arrière-plan et progresse doucement pour respecter les limites de Discord. Le clan conservé est celui où le membre a le plus contribué cette saison.`;
}

/**
 * Synchronise les clans pour les comptes reliés (doubles comptes).
 * Si un utilisateur (ou les deux) possède déjà un clan, on harmonise.
 */
export async function syncMemberClanFromDcLink(
  guildId: string,
  userId: string,
  otherUserId: string | null
): Promise<void> {
  try {
    const client = getClient();
    // 1. Vérifier si les clans sont activés
    const guildSettings = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true, currentClanSeason: true },
    });
    if (!guildSettings?.clansEnabled) return;
    const currentSeason = guildSettings.currentClanSeason;

    // 2. Si otherUserId n'est pas fourni, on cherche les liens validés pour userId
    let u1 = userId;
    let u2 = otherUserId;
    if (!u2) {
      const link = await prisma.linkedAccount.findFirst({
        where: {
          guildId,
          status: 'VALIDATED',
          OR: [
            { user1Id: userId },
            { user2Id: userId },
          ],
        },
      });
      if (!link) return;
      u1 = link.user1Id;
      u2 = link.user2Id;
    }

    // 3. Récupérer la guilde Discord
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    // 4. Récupérer les membres Discord
    const member1 = discordGuild.members.cache.get(u1) || await discordGuild.members.fetch(u1).catch(() => null);
    const member2 = discordGuild.members.cache.get(u2) || await discordGuild.members.fetch(u2).catch(() => null);

    if (!member1 || !member2) return;

    // 5. Récupérer les clans configurés
    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length === 0) return;

    // 6. Identifier le clan de chaque membre
    const clan1 = clans.find(c => member1.roles.cache.has(c.roleId));
    const clan2 = clans.find(c => member2.roles.cache.has(c.roleId));

    // Si aucun des deux n'a de clan, rien à faire
    if (!clan1 && !clan2) return;

    let targetClan = clan1 || clan2;
    if (!targetClan) return;

    // Si les deux ont un clan différent, on choisit celui qui a le plus d'XP/niveau
    if (clan1 && clan2 && clan1.id !== clan2.id) {
      const [lvl1, lvl2] = await Promise.all([
        prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId: u1 } } }),
        prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId: u2 } } }),
      ]);
      const xp1 = lvl1?.xp ?? 0;
      const xp2 = lvl2?.xp ?? 0;

      if (xp1 >= xp2) {
        targetClan = clan1;
        logger.info('ClanService', `Synchro DC : Alignement de ${member2.user.tag} vers le clan de ${member1.user.tag} ("${clan1.name}" avec ${xp1} XP vs ${xp2} XP)`);
        
        // Retirer le rôle du clan 2 à member2 puis ajouter celui du clan 1.
        //
        // L'ajout est conditionné à la réussite du retrait : si Discord refuse
        // le retrait (hiérarchie, permissions, coupure), poser quand même le
        // second rôle laissait le membre avec **deux clans**, en silence, et
        // définitivement - la sécurité de clan unique ne repasse jamais sur
        // l'existant. Mieux vaut le laisser sur son clan d'origine.
        const removed2 = await member2.roles.remove(clan2.roleId, `Double compte aligné sur ${member1.user.tag} (synchro auto)`)
          .then(() => true)
          .catch((err: unknown) => {
            logger.error('ClanService', `Retrait du clan "${clan2.name}" impossible pour ${member2.user.tag}, alignement abandonné :`, err);
            return false;
          });

        if (removed2) {
          await member2.roles.add(clan1.roleId, `Double compte aligné sur ${member1.user.tag} (synchro auto)`).catch(() => null);

          // Migrer les contributions de member2 du clan2 vers clan1
          await migrateContributions(guildId, u2, clan2.id, clan1.id, currentSeason);
        }
      } else {
        targetClan = clan2;
        logger.info('ClanService', `Synchro DC : Alignement de ${member1.user.tag} vers le clan de ${member2.user.tag} ("${clan2.name}" avec ${xp2} XP vs ${xp1} XP)`);
        
        // Même précaution que ci-dessus : pas d'ajout sans retrait réussi.
        const removed1 = await member1.roles.remove(clan1.roleId, `Double compte aligné sur ${member2.user.tag} (synchro auto)`)
          .then(() => true)
          .catch((err: unknown) => {
            logger.error('ClanService', `Retrait du clan "${clan1.name}" impossible pour ${member1.user.tag}, alignement abandonné :`, err);
            return false;
          });

        if (removed1) {
          await member1.roles.add(clan2.roleId, `Double compte aligné sur ${member2.user.tag} (synchro auto)`).catch(() => null);

          // Migrer les contributions de member1 du clan1 vers clan2
          await migrateContributions(guildId, u1, clan1.id, clan2.id, currentSeason);
        }
      }
    } else {
      // Attribuer le clan à celui qui ne l'a pas
      if (!clan1 && targetClan) {
        logger.info('ClanService', `Synchro DC : Attribution du clan "${targetClan.name}" à ${member1.user.tag} (lié à ${member2.user.tag})`);
        await member1.roles.add(targetClan.roleId, `Double compte de ${member2.user.tag} (synchro auto)`).catch(() => null);
      }
      if (!clan2 && targetClan) {
        logger.info('ClanService', `Synchro DC : Attribution du clan "${targetClan.name}" à ${member2.user.tag} (lié à ${member1.user.tag})`);
        await member2.roles.add(targetClan.roleId, `Double compte de ${member1.user.tag} (synchro auto)`).catch(() => null);
      }
    }
  } catch (err) {
    logger.error('ClanService', `Erreur synchro clan DC pour ${userId}:`, err);
  }
}

/**
 * Attribue automatiquement un clan à un membre qui vient de rejoindre le serveur,
 * en choisissant le clan ayant actuellement le moins de membres.
 *
 * Ne fait rien si :
 * - Le module clans n'est pas activé, ou si l'option d'auto-assignation est désactivée.
 * - Le membre possède déjà un rôle de clan (ex: déjà aligné via syncMemberClanFromDcLink).
 * - Le membre est reconnu comme un double compte déjà validé (LinkedAccount VALIDATED) :
 *   dans ce cas, c'est la synchronisation de double compte (syncMemberClanFromDcLink) qui
 *   se charge d'aligner son clan sur celui de son compte principal.
 */
export async function autoAssignClanOnJoin(guildId: string, member: GuildMember): Promise<void> {
  try {
    if (member.user.bot) return;

    const guildSettings = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true, clanAutoAssignOnJoin: true },
    });
    if (!guildSettings?.clansEnabled || !guildSettings?.clanAutoAssignOnJoin) return;

    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length === 0) return;

    const clanRoleIds = clans.map((c) => c.roleId);

    // Le membre a déjà un clan (ex: synchro de double compte déjà exécutée juste avant) : ne rien faire.
    if (member.roles.cache.some((r) => clanRoleIds.includes(r.id))) return;

    // Exclusion : ne pas assigner automatiquement un double compte déjà validé.
    const validatedLink = await prisma.linkedAccount.findFirst({
      where: {
        guildId,
        status: 'VALIDATED',
        OR: [{ user1Id: member.id }, { user2Id: member.id }],
      },
    });
    if (validatedLink) {
      logger.info('ClanService', `Auto-assignation ignorée pour ${member.user.tag} : double compte déjà validé.`);
      return;
    }

    // Trouver le clan qui a actuellement le moins de membres sur Discord.
    const clanCounts = clans.map((c) => ({
      clan: c,
      count: member.guild.roles.cache.get(c.roleId)?.members.size ?? 0,
    }));
    clanCounts.sort((a, b) => a.count - b.count);
    const targetClan = clanCounts[0]?.clan;
    if (!targetClan) return;

    await member.roles.add(targetClan.roleId, 'Attribution automatique à la jointure (clan le moins peuplé)');

    logger.info('ClanService', `Clan "${targetClan.name}" attribué automatiquement à ${member.user.tag} à la jointure.`);

    await pushAudit(guildId, {
      user: 'Système (Auto-assignation)',
      action: 'Attribution automatique de clan',
      context: member.guild.name,
      module: 'Clans',
      eventType: 'Automatique',
      details: `Clan "${targetClan.name}" attribué automatiquement à ${member.user.tag} à son arrivée sur le serveur.`,
      channelId: null,
    }).catch(() => null);

    broadcastDashboardStateChange(guildId, 'clans_updated');
  } catch (err) {
    logger.error('ClanService', `Erreur lors de l'auto-assignation de clan pour ${member.user.tag}:`, err);
  }
}

/**
 * Attribue des points de clan au membre qui vient de booster le serveur, si l'option
 * « Gain par boost du serveur » est activée. Fonctionne comme le gain de passage de
 * niveau : les points vont au clan du membre, avec résolution du compte canonique
 * (double compte) et journalisation de l'événement (source 'BOOST').
 */
export async function awardClanPointsOnBoost(guildId: string, member: GuildMember): Promise<void> {
  try {
    if (member.user.bot) return;

    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true, currentClanSeason: true, clanXpFromBoost: true, clanXpPerBoost: true },
    });
    if (!guildConfig?.clansEnabled || !guildConfig.clanXpFromBoost || guildConfig.clanXpPerBoost <= 0) return;

    const clans = await prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true, roleId: true } });
    if (clans.length === 0) return;

    const memberClanRole = member.roles.cache.find(r => clans.some(c => c.roleId === r.id));
    if (!memberClanRole) return; // Le booster n'appartient à aucun clan
    const clan = clans.find(c => c.roleId === memberClanRole.id);
    if (!clan) return;

    // Résoudre l'identifiant canonique (double compte) comme pour le level-up
    const { getAllLinkedUserIds } = await import('../moderation/altAccountService.js');
    const linkedIds = await getAllLinkedUserIds(guildId, member.id).catch(() => [member.id]);
    const canonicalUserId = linkedIds.sort()[0];

    const { granted: grantedBoostPoints } = await creditClanContribution({
      guildId,
      clanId: clan.id,
      userId: canonicalUserId,
      season: guildConfig.currentClanSeason,
      amount: guildConfig.clanXpPerBoost,
    });
    if (grantedBoostPoints <= 0) return;

    await logClanContribution(guildId, clan.id, canonicalUserId, grantedBoostPoints, 'BOOST', guildConfig.currentClanSeason);

    logger.info('ClanService', `Points de clan (${grantedBoostPoints}) attribués à ${member.user.tag} pour son boost du serveur dans le clan "${clan.name}"`);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  } catch (err) {
    logger.error('ClanService', `Erreur lors de l'attribution des points de boost pour ${member.user.tag}:`, err);
  }
}

/**
 * Migre les contributions d'un utilisateur d'un clan vers un autre pour la
 * saison en cours, en fusionnant l'XP s'il en avait déjà dans le clan cible.
 *
 * Les saisons closes ne bougent pas : leur classement a déjà été proclamé, et le
 * rollback comme l'historique les recalculent depuis ces lignes. Déplacer une
 * contribution passée d'un clan à l'autre réécrirait un palmarès.
 */
async function migrateContributions(
  guildId: string,
  userId: string,
  sourceClanId: string,
  targetClanId: string,
  season: number
): Promise<void> {
  try {
    const sourceContribs = await prisma.clanMemberContribution.findMany({
      where: { guildId, clanId: sourceClanId, userId, season },
    });

    // Utiliser une transaction pour garantir l'intégrité de la migration
    await prisma.$transaction(async (tx) => {
      for (const contrib of sourceContribs) {
        const targetContrib = await tx.clanMemberContribution.findUnique({
          where: {
            guildId_clanId_userId_season: {
              guildId,
              clanId: targetClanId,
              userId,
              season: contrib.season,
            },
          },
        });

        if (targetContrib) {
          // Fusionner l'XP (utilisation d'increment atomique pour éviter les race conditions)
          await tx.clanMemberContribution.update({
            where: { id: targetContrib.id },
            data: { xp: { increment: contrib.xp } },
          });
          // Supprimer l'ancienne contribution source
          await tx.clanMemberContribution.delete({
            where: { id: contrib.id },
          });
        } else {
          // Simplement changer le clanId
          await tx.clanMemberContribution.update({
            where: { id: contrib.id },
            data: { clanId: targetClanId },
          });
        }
      }
    });
    logger.info('ClanService', `Contributions de l'utilisateur ${userId} migrées avec succès de ${sourceClanId} vers ${targetClanId}`);
  } catch (err) {
    logger.error('ClanService', `Erreur lors de la migration des contributions pour ${userId} de ${sourceClanId} vers ${targetClanId}:`, err);
  }
}

/**
 * Gère le sacre et l'attribution des bonus de fin de saison.
 */
/**
 * Solde le raid en cours avant qu'une saison ne bascule.
 *
 * Vit au point d'appel et non dans `handleEndSeason` : les points d'un raid sont crédités
 * dans la saison lue en base au moment du versement, et la clôture manuelle incrémente le
 * compteur *avant* de lancer la fin de saison en arrière-plan. Appelé de là, le solde
 * aurait crédité la saison suivante, c'est-à-dire exactement ce qu'il vise à éviter.
 *
 * Les autres traitements de fin de saison ne s'y trompent pas : ils reçoivent la saison en
 * paramètre plutôt que de la relire.
 */
export async function settleRaidBeforeSeasonEnd(guildId: string, client: Client, season: number): Promise<void> {
  try {
    const { settleRaidForSeasonEnd } = await import('../features/rpg/rpgRaidService.js');
    if (await settleRaidForSeasonEnd(client, guildId)) {
      logger.info('ClanService', `Raid soldé à la clôture de la saison ${season} sur ${guildId}.`);
    }
  } catch (err) {
    logger.error('ClanService', `Solde du raid à la clôture de la saison ${season} impossible sur ${guildId} :`, err);
  }
}

export async function handleEndSeason(
  guildId: string,
  client: Client,
  initiatorName: string,
  currentSeason: number,
  nextSeason: number
): Promise<void> {
  try {
    const guildSettings = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        clanAnnouncementChannelId: true,
        clanRewardGiveaway: true,
        clanRewardXpBoost: true,
        clanRewardXpBoostRate: true,
        clanRewardLeaderRole: true,
        betDebtResetOnSeason: true,
      },
    });

    if (!guildSettings) return;

    // Aucun pari ne doit enjamber la bascule : les mises reviennent à leurs
    // propriétaires **avant** le calcul des totaux, sinon la saison se fermerait
    // sur un classement amputé de tout ce qui était en jeu.
    try {
      const { settleOpenBetsForSeason } = await import('./clanBetService.js');
      await settleOpenBetsForSeason(client, guildId, currentSeason);
    } catch (err) {
      logger.error('ClanService', `Clôture des paris de la saison ${currentSeason} impossible sur ${guildId} :`, err);
    }

    // Dettes figées telles qu'elles sont à cet instant, pour qu'un retour arrière
    // puisse les rétablir. Avant la purge ci-dessous : celle-ci ouvre la saison
    // suivante, et annuler une clôture doit aussi annuler sa purge.
    try {
      const { snapshotClanDebts } = await import('./clanDebtService.js');
      await snapshotClanDebts(guildId, currentSeason);
    } catch (err) {
      logger.error('ClanService', `Instantané des dettes de la saison ${currentSeason} impossible sur ${guildId} :`, err);
    }

    // Purge des dettes, quand le serveur a choisi de les remettre à zéro d'une
    // saison à l'autre. Après le remboursement des paris ouverts, dont les parts
    // à crédit viennent d'être effacées, et avant les récompenses de fin de
    // saison, qui créditent des points et rembourseraient sinon une dette que le
    // serveur vient de décider d'effacer.
    if (guildSettings.betDebtResetOnSeason) {
      const purged = await prisma.clanPointDebt.deleteMany({ where: { guildId } });
      if (purged.count > 0) {
        logger.info('ClanService', `${purged.count} dette(s) de points effacée(s) à la clôture de la saison ${currentSeason} sur ${guildId}.`);
      }
    }

    // 1. Récupérer les clans
    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length === 0) return;

    // 2. Calculer les totaux d'XP par clan pour la saison et trouver TOUS les clans gagnants (ex æquo)
    const clansWithXp = await Promise.all(
      clans.map(async (clan) => {
        const aggregate = await prisma.clanMemberContribution.aggregate({
          where: { guildId, clanId: clan.id, season: currentSeason },
          _sum: { xp: true },
        });
        const totalXp = aggregate._sum.xp ?? 0;
        return { clan, totalXp };
      })
    );

    const maxClanXp = Math.max(...clansWithXp.map((item) => item.totalXp), 0);
    const winningClans = maxClanXp > 0
      ? clansWithXp.filter((item) => item.totalXp === maxClanXp).map((item) => item.clan)
      : [];

    // Récupérer le serveur Discord
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    // Nettoyer les anciens rôles de chefs de clan de tous les clans
    if (guildSettings.clanRewardLeaderRole) {
      for (const clan of clans) {
        if (!clan.leaderRoleId) continue;
        try {
          const role = discordGuild.roles.cache.get(clan.leaderRoleId)
            || await discordGuild.roles.fetch(clan.leaderRoleId).catch(() => null);
          if (role) {
            const membersWithRole = Array.from(role.members.values());
            await Promise.all(
              membersWithRole.map((m) =>
                m.roles.remove(clan.leaderRoleId!, `Clôture de la Saison ${currentSeason} - Réinitialisation des chefs`).catch(() => null)
              )
            );
          }
        } catch (err) {
          logger.warn('ClanService', `Erreur lors du nettoyage du rôle de chef ${clan.leaderRoleId}:`, err);
        }
      }
    }

    // Podium des parieurs de la saison. Calculé après le règlement des paris
    // ouverts, plus haut : ceux-ci sont alors remboursés et absents du palmarès,
    // qui ne compte donc que des verdicts réellement rendus.
    let bettorLaureates: Awaited<ReturnType<typeof import('./clanBetService.js').awardSeasonBettors>> = [];
    try {
      const { awardSeasonBettors } = await import('./clanBetService.js');
      bettorLaureates = await awardSeasonBettors({ client, guildId, season: currentSeason, nextSeason });
    } catch (err) {
      logger.error('ClanService', `Récompenses des parieurs de la saison ${currentSeason} impossibles sur ${guildId} :`, err);
    }

    // Map pour stocker les chefs (éventuellement multiples par clan en cas d'ex æquo)
    const clanLeadersMap = new Map<string, { userIds: string[]; xp: number }>();

    // 3. Traiter le(s) vainqueur(s)
    if (winningClans.length > 0) {
      const winningIdsString = winningClans.map((c) => c.id).join(',');
      await prisma.guild.update({
        where: { id: guildId },
        data: { lastWinningClanId: winningIdsString },
      });
    } else {
      await prisma.guild.update({
        where: { id: guildId },
        data: { lastWinningClanId: null },
      });
    }

    // 4. Attribuer les rôles de chefs pour TOUS les ex æquo de chaque clan
    for (const { clan, totalXp } of clansWithXp) {
      // Un clan dont le score a été ramené à zéro - retrait manuel décidé par
      // un administrateur - ne sacre personne : les lignes des membres sont
      // restées intactes, et sans ce garde-fou le clan sanctionné couronnait
      // quand même son meilleur contributeur.
      if (totalXp <= 0) continue;

      const topContrib = await prisma.clanMemberContribution.findFirst({
        where: { guildId, clanId: clan.id, season: currentSeason, userId: { not: 'system_manual_points' } },
        orderBy: { xp: 'desc' },
      });

      if (topContrib && topContrib.xp > 0) {
        const topContributors = await prisma.clanMemberContribution.findMany({
          where: {
            guildId,
            clanId: clan.id,
            season: currentSeason,
            userId: { not: 'system_manual_points' },
            xp: topContrib.xp,
          },
        });

        const topUserIds = topContributors.map((c) => c.userId);
        clanLeadersMap.set(clan.id, { userIds: topUserIds, xp: topContrib.xp });

        if (guildSettings.clanRewardLeaderRole && clan.leaderRoleId) {
          for (const userId of topUserIds) {
            const member = discordGuild.members.cache.get(userId)
              || await discordGuild.members.fetch(userId).catch(() => null);
            if (member) {
              await member.roles.add(clan.leaderRoleId, `Chef du clan ${clan.name} (ex æquo) - Fin de la Saison ${currentSeason}`).catch((err) => {
                logger.warn('ClanService', `Impossible d'attribuer le rôle de chef du clan ${clan.name} à ${member.user.tag}:`, err);
              });
            }
          }
        }
      }
    }

    // 5. Envoyer l'annonce globale de fin de saison (avec gestion ex æquo)
    if (guildSettings.clanAnnouncementChannelId) {
      try {
        const announcementChannel = discordGuild.channels.cache.get(guildSettings.clanAnnouncementChannelId)
          || await discordGuild.channels.fetch(guildSettings.clanAnnouncementChannelId).catch(() => null);
          
        if (announcementChannel && announcementChannel.isTextBased()) {
          const isTie = winningClans.length > 1;
          const title = isTie
            ? `🤝 Fin de la Saison de Clans ${currentSeason} (Égalité Ex Æquo) !`
            : `🏁 Fin de la Saison de Clans ${currentSeason} !`;

          const globalEmbed = new EmbedBuilder()
            .setTitle(title)
            .setColor(0xF59E0B) // Amber
            .setTimestamp();

          if (winningClans.length > 0) {
            const winnerNamesText = winningClans.map((c) => `**${c.name}**`).join(' et ');
            let winnerText = isTie
              ? `Les clans ${winnerNamesText} se hissent ex æquo à la première place avec **${maxClanXp.toLocaleString('fr-FR')} XP** chacun ! 🎉\n\n`
              : `Le clan ${winnerNamesText} remporte la victoire pour cette saison avec un total de **${maxClanXp.toLocaleString('fr-FR')} XP** ! 🎉\n\n`;

            winnerText += `Ses membres bénéficient d'avantages exclusifs pour la **Saison ${nextSeason}** :\n`;
            if (guildSettings.clanRewardXpBoost) {
              winnerText += `- **Boost d'XP** : +${Math.round((guildSettings.clanRewardXpBoostRate - 1) * 100)}% d'XP sur tout le serveur !\n`;
            }
            if (guildSettings.clanRewardGiveaway) {
              winnerText += `- **Giveaways** : Plus de chances de remporter les tirages au sort !\n`;
            }

            const winningLeadersMentions: string[] = [];
            for (const winClan of winningClans) {
              const leaderData = clanLeadersMap.get(winClan.id);
              if (leaderData && leaderData.userIds.length > 0) {
                const mentions = leaderData.userIds.map((u) => `<@${u}>`).join(', ');
                winningLeadersMentions.push(`${winClan.name} : ${mentions} (${leaderData.xp.toLocaleString('fr-FR')} XP)`);
              }
            }

            if (winningLeadersMentions.length > 0) {
              winnerText += `\nFélicitations aux **Chefs de Coalition** 👑 :\n` + winningLeadersMentions.map((m) => `• ${m}`).join('\n');
            }

            globalEmbed.setDescription(winnerText);
          } else {
            globalEmbed.setDescription(`La saison de clans ${currentSeason} se termine. Aucun clan n'a accumulé d'XP cette saison.`);
          }

          // Le palmarès des parieurs vit à côté du classement des clans : un
          // parieur peut briller dans un clan qui finit dernier.
          if (bettorLaureates.length > 0) {
            const medals = ['🥇', '🥈', '🥉'];
            const points = (value: number) => value.toLocaleString('fr-FR');
            const lines = bettorLaureates.map((laureate) => {
              // Ce qui est annoncé est ce qui est arrivé au classement. La part
              // partie en remboursement de dette est dite à côté : comptée avec
              // les points, elle annonce un gain que le score ne montrera pas.
              const paid = laureate.credited + laureate.debtRepaid;
              const capped = paid > 0 && paid < laureate.reward ? ` sur ${points(laureate.reward)} prévus` : '';
              const repaid = laureate.debtRepaid > 0
                ? ` (${points(laureate.debtRepaid)} de plus partis en remboursement de dette)`
                : '';

              const prize = laureate.credited > 0
                ? ` - **+${points(laureate.credited)} points**${capped}${repaid}`
                : laureate.debtRepaid > 0
                  ? ` - *prime de ${points(laureate.debtRepaid)} entièrement partie en remboursement de dette*`
                  : laureate.reward > 0
                    ? laureate.memberId
                      ? ' - *prime non versée, aucun clan*'
                      : ' - *prime non versée, lauréat absent du serveur*'
                    : '';
              // Mention du compte réellement présent : la racine des comptes
              // liés peut être un double qui a quitté le serveur.
              return `${medals[laureate.rank - 1] ?? '•'} <@${laureate.memberId ?? laureate.userId}> · `
                + `**${laureate.netGain >= 0 ? '+' : ''}${points(laureate.netGain)}** de gain net`
                + ` sur ${laureate.wins} victoire(s)${prize}`;
            });
            globalEmbed.addFields({
              name: '🎲 Meilleurs parieurs de la saison',
              value: lines.join('\n').slice(0, 1024),
            });
          }

          await announcementChannel.send({ embeds: [globalEmbed] }).catch((err) => {
            logger.warn('ClanService', 'Impossible d\'envoyer l\'annonce globale de fin de saison:', err);
          });
        }
      } catch (err) {
        logger.error('ClanService', 'Erreur lors de l\'envoi de l\'annonce globale de saison:', err);
      }
    }

    // 6. Envoyer l'annonce interne dans le QG de CHAQUE clan gagnant (ex æquo pris en compte)
    for (const winningClan of winningClans) {
      if (!winningClan.generalChannelId) continue;
      try {
        const qgChannel = discordGuild.channels.cache.get(winningClan.generalChannelId)
          || await discordGuild.channels.fetch(winningClan.generalChannelId).catch(() => null);
          
        if (qgChannel && qgChannel.isTextBased()) {
          const isTie = winningClans.length > 1;
          const otherWinners = winningClans.filter((c) => c.id !== winningClan.id).map((c) => `**${c.name}**`).join(' et ');
          
          const title = isTie
            ? `🤝 Victoire du Clan ${winningClan.name} (Ex Æquo) !`
            : `🏆 Victoire du Clan ${winningClan.name} !`;

          const leaderData = clanLeadersMap.get(winningClan.id);
          const leaderMentions = leaderData ? leaderData.userIds.map((u) => `<@${u}>`).join(', ') : '';
          const leaderXpText = leaderData ? `${leaderData.xp.toLocaleString('fr-FR')} XP` : '';

          let description = isTie
            ? `Félicitations à tous les membres ! Notre clan partage la victoire de la **Saison ${currentSeason}** ex æquo avec ${otherWinners} avec un total de **${maxClanXp.toLocaleString('fr-FR')} XP** ! 🎉\n\n`
            : `Félicitations à tous les membres ! Grâce à votre investissement, notre clan remporte la **Saison ${currentSeason}** ! 🎉\n\n`;

          description += `Nos récompenses de vainqueurs sont désormais actives pour toute la **Saison ${nextSeason}**. `;
          if (leaderMentions) {
            const chefLabel = leaderData && leaderData.userIds.length > 1 ? 'nos **Chefs de Coalition**' : 'notre **Chef de Coalition**';
            description += `Un salut spécial à ${chefLabel} ${leaderMentions} pour ce score impressionnant de **${leaderXpText}** ! 👑`;
          }

          const localEmbed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(0x10B981) // Green
            .setTimestamp();

          await qgChannel.send({ embeds: [localEmbed] }).catch((err) => {
            logger.warn('ClanService', `Impossible d'envoyer l'annonce locale de victoire dans le QG de ${winningClan.name}:`, err);
          });
        }
      } catch (err) {
        logger.error('ClanService', `Erreur lors de l'envoi de l'annonce locale QG pour le clan ${winningClan.name}:`, err);
      }
    }
  } catch (err) {
    logger.error('ClanService', `Erreur critique lors de la fin de saison de clans pour le serveur ${guildId}:`, err);
  }
}

/**
 * Vérifie si la saison de clans active a atteint sa date de fin et procède
 * au reset et à l'application des récompenses.
 */
export async function checkAndProgressClanSeasons(client: Client): Promise<void> {
  try {
    const now = new Date();

    // Trouver tous les serveurs avec les clans activés et une date de fin de saison dépassée
    const guildsToReset = await prisma.guild.findMany({
      where: {
        clansEnabled: true,
        clanSeasonEndsAt: {
          not: null,
          lte: now,
        },
      },
      select: {
        id: true,
        currentClanSeason: true,
        clanSeasonStartsAt: true,
        clanSeasonEndsAt: true,
      },
    });

    for (const guild of guildsToReset) {
      if (!(await isModuleEnabled(guild.id, 'clans'))) continue;

      logger.info('ClanService', `Déclenchement automatique de la fin de saison de clans pour le serveur ${guild.id}`);

      const nextSeason = guild.currentClanSeason + 1;

      // Déterminer la nouvelle plage de dates si la saison précédente avait une durée planifiée
      let nextStartsAt: Date | null = null;
      let nextEndsAt: Date | null = null;

      // Une durée nulle ou négative (dates mal saisies) donnerait une saison déjà
      // expirée : le cron la clôturerait de nouveau au passage suivant, en boucle.
      // Dans ce cas on laisse la saison non planifiée plutôt que de la reconduire.
      if (guild.clanSeasonStartsAt && guild.clanSeasonEndsAt) {
        const durationMs = guild.clanSeasonEndsAt.getTime() - guild.clanSeasonStartsAt.getTime();
        if (durationMs > 0) {
          nextStartsAt = now;
          nextEndsAt = new Date(now.getTime() + durationMs);
        } else {
          logger.warn('ClanService', `Durée de saison invalide pour le serveur ${guild.id} (fin <= début) : la saison ${nextSeason} démarre sans planification.`);
        }
      }

      // 1. Décerner les bonus, renommer les QG et publier les annonces
      await settleRaidBeforeSeasonEnd(guild.id, client, guild.currentClanSeason);
      await handleEndSeason(guild.id, client, 'Système (Planifié)', guild.currentClanSeason, nextSeason);

      // 2. Mettre à jour la saison et les dates en BDD
      await prisma.guild.update({
        where: { id: guild.id },
        data: {
          currentClanSeason: nextSeason,
          clanSeasonStartsAt: nextStartsAt,
          clanSeasonEndsAt: nextEndsAt,
        },
      });

      logger.info('ClanService', `Saison de clans réinitialisée automatiquement. Nouvelle saison: ${nextSeason} (Fin: ${nextEndsAt})`);
    }
  } catch (err) {
    logger.error('ClanService', 'Erreur lors de la vérification planifiée des saisons de clans:', err);
  }
}
