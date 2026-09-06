/**
 * renewalNoticeService.ts
 *
 * Prévenir avant qu'un abonnement annuel se reconduise.
 *
 * L'article L215-1 du code de la consommation impose au professionnel
 * d'informer le consommateur, « au plus tôt trois mois et au plus tard un mois
 * avant le terme », de la possibilité de ne pas reconduire un contrat à
 * reconduction tacite. La sanction n'est pas symbolique : à défaut
 * d'information, le client peut résilier gratuitement à tout moment à compter
 * de la reconduction, et les sommes prélevées après cette date lui sont dues.
 *
 * Ne concerne que les abonnements **annuels** : un abonnement mensuel se
 * reconduit sur une période si courte que l'obligation ne trouve pas à
 * s'appliquer de la même façon, et un avis mensuel serait du harcèlement plutôt
 * qu'une information.
 *
 * ── Ce que ce module ne fait pas encore ────────────────────────────────────
 *
 * Le texte exige une information « par écrit ou par courrier électronique »,
 * c'est-à-dire sur un support durable. Un message Discord n'en est pas un au
 * sens strict : il vit sur une plateforme tierce, peut être supprimé, et le
 * destinataire n'en garde aucune copie propre. Kotbo n'a aujourd'hui aucun
 * moyen d'envoyer un courriel - aucune dépendance SMTP ni fournisseur d'envoi
 * n'est configurée.
 *
 * Ce module envoie donc l'avis par les canaux dont on dispose (message privé au
 * payeur, avis dans le serveur) et laisse `sendRenewalEmail` en point
 * d'extension unique : le jour où un envoyeur de courriels existe, il n'y a que
 * cette fonction à remplir. En l'état, l'obligation est **partiellement**
 * couverte, et c'est écrit ici plutôt que passé sous silence.
 */

import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { v2Message } from '@arcscord/components';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { kotboContainer, COLORS_RAW } from '../../utils/embeds.js';
import { getPlanDefinition, normalizePlanKey } from '@kotbo/contracts';
import { planForPriceId } from './stripeService.js';

/**
 * Fenêtre d'envoi, en jours avant l'échéance.
 *
 * La loi ouvre entre 90 et 30 jours. On vise plus étroit des deux côtés : la
 * tâche tourne une fois par jour et peut manquer un passage (redémarrage,
 * incident, serveur injoignable), il faut donc de la marge pour réessayer sans
 * jamais sortir de la fenêtre légale. Un envoi à 89 jours ou à 31 jours serait
 * valide mais ne laisserait aucun droit à l'erreur.
 */
const NOTICE_WINDOW_DAYS = { from: 75, to: 35 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statuts d'abonnement qui vont réellement donner lieu à une reconduction.
 * Un abonnement déjà impayé ou résilié n'a rien à reconduire, et prévenir son
 * titulaire d'une échéance qui n'arrivera pas ne l'aiderait pas.
 */
const RENEWING_STATUSES = ['active', 'trialing'];

function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Envoi par courriel, seul support durable au sens du texte.
 *
 * Volontairement vide : il n'existe aucun envoyeur de courriels dans le projet.
 * La fonction est là pour que le manque ait une adresse unique et visible,
 * plutôt que d'être dilué dans un commentaire. Renvoie `false` tant que rien
 * n'est branché, ce qui fait apparaître l'avis comme non pleinement délivré
 * dans les journaux.
 */
async function sendRenewalEmail(_guildId: string, _periodEnd: Date): Promise<boolean> {
  return false;
}

interface RenewalTarget {
  id: string;
  plan: string;
  stripePriceId: string | null;
  stripeCurrentPeriodEnd: Date | null;
  billingOwnerId: string | null;
  broadcastChannelId: string | null;
  logChannelId: string | null;
}

/** Contenu de l'avis, identique en message privé et en salon. */
function noticeContent(target: RenewalTarget, periodEnd: Date) {
  const definition = getPlanDefinition(normalizePlanKey(target.plan));
  return {
    color: COLORS_RAW.info,
    title: 'Votre abonnement Kotbo se reconduit bientôt',
    body:
      `L'abonnement **${definition.name}** de ce serveur arrive à échéance le **${formatDate(periodEnd)}**.\n\n`
      + `Sauf résiliation de votre part avant cette date, il **se reconduira automatiquement** pour une nouvelle `
      + `année, au tarif alors en vigueur.\n\n`
      + `Vous n'avez rien à faire pour continuer. Si vous préférez ne pas reconduire, la résiliation se fait en `
      + `quelques clics depuis la page **Facturation** de votre tableau de bord, à tout moment d'ici l'échéance. `
      + `Votre accès resterait alors ouvert jusqu'au ${formatDate(periodEnd)}.`,
    footer: 'Information préalable à reconduction — art. L215-1 du code de la consommation',
  };
}

/**
 * Envoie l'avis à un serveur et note l'échéance traitée.
 *
 * L'avis part au **payeur** en priorité, et non au propriétaire du serveur :
 * c'est lui qui a engagé la dépense, c'est lui que la reconduction prélève, et
 * la page Facturation lui reste ouverte même s'il a perdu ses droits
 * d'administration Discord. Le propriétaire ne sert que de repli.
 */
async function sendNotice(client: Client, target: RenewalTarget, periodEnd: Date): Promise<void> {
  const content = noticeContent(target, periodEnd);
  const message = v2Message(
    kotboContainer({
      color: content.color,
      title: content.title,
      fields: [content.body],
      footerTitle: content.footer,
    }),
  );

  let delivered = await sendRenewalEmail(target.id, periodEnd);

  // Message privé au payeur.
  if (target.billingOwnerId) {
    try {
      const user = await client.users.fetch(target.billingOwnerId);
      await user.send(message);
      delivered = true;
    } catch {
      // Messages privés fermés : l'avis en salon prend le relais.
    }
  }

  // Avis dans le serveur, qui touche l'équipe même si le payeur est injoignable.
  const guild = await client.guilds.fetch(target.id).catch(() => null);
  if (guild) {
    const preferred = [target.broadcastChannelId, target.logChannelId, guild.systemChannelId];
    const me = guild.members.me;
    for (const channelId of preferred) {
      if (!channelId || !me) continue;
      const channel = guild.channels.cache.get(channelId);
      if (
        !channel
        || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
      ) {
        continue;
      }
      try {
        await channel.send(message);
        delivered = true;
        break;
      } catch {
        // Salon indisponible : on tente le suivant.
      }
    }
  }

  // L'échéance est marquée même si rien n'a pu partir : sans cela, la tâche
  // réessaierait chaque jour sur un serveur devenu injoignable, et le journal
  // d'un serveur disparu masquerait les envois réels. L'échec est journalisé en
  // avertissement, ce qui le rend repérable et rattrapable à la main.
  await prisma.guild.update({
    where: { id: target.id },
    data: { renewalNoticeSentFor: periodEnd },
  });

  if (delivered) {
    logger.info('Billing', `Avis de reconduction envoyé à ${target.id} pour l'échéance du ${formatDate(periodEnd)}.`);
  } else {
    logger.warn(
      'Billing',
      `Avis de reconduction non délivré pour ${target.id} (échéance du ${formatDate(periodEnd)}) : `
        + `ni message privé ni salon disponible. Obligation d'information non satisfaite pour ce serveur.`,
    );
  }
}

/**
 * Balayage quotidien : envoie les avis de reconduction dus.
 *
 * Idempotent : `renewalNoticeSentFor` porte l'échéance traitée, si bien qu'un
 * double passage dans la journée n'envoie rien deux fois, et que la
 * reconduction suivante - qui déplace `stripeCurrentPeriodEnd` d'un an - rouvre
 * naturellement le droit à un nouvel avis.
 */
export async function runRenewalNoticeCheck(client: Client): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(now + NOTICE_WINDOW_DAYS.to * DAY_MS);
  const windowEnd = new Date(now + NOTICE_WINDOW_DAYS.from * DAY_MS);

  const candidates = await prisma.guild.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      stripeSubscriptionStatus: { in: RENEWING_STATUSES },
      // Une résiliation déjà programmée signifie qu'il n'y aura pas de
      // reconduction : il n'y a rien à annoncer.
      stripeCancelAtPeriodEnd: false,
      stripeCurrentPeriodEnd: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      plan: true,
      stripePriceId: true,
      stripeCurrentPeriodEnd: true,
      renewalNoticeSentFor: true,
      billingOwnerId: true,
      broadcastChannelId: true,
      logChannelId: true,
    },
  });

  for (const candidate of candidates) {
    const periodEnd = candidate.stripeCurrentPeriodEnd;
    if (!periodEnd) continue;

    // Avis déjà envoyé pour cette échéance précise.
    if (candidate.renewalNoticeSentFor?.getTime() === periodEnd.getTime()) continue;

    // Seuls les abonnements annuels sont concernés. Sans prix connu, on
    // s'abstient : mieux vaut ne pas prévenir que prévenir à tort un abonné
    // mensuel douze fois par an.
    const resolved = candidate.stripePriceId ? planForPriceId(candidate.stripePriceId) : null;
    if (resolved?.interval !== 'year') continue;

    await sendNotice(client, candidate, periodEnd).catch((error) => {
      logger.warn('Billing', `Avis de reconduction en échec pour ${candidate.id}: ${String(error)}`);
    });
  }
}
