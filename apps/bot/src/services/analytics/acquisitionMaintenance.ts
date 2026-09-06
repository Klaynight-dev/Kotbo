/**
 * acquisitionMaintenance.ts
 *
 * Ce que le tunnel doit oublier, et ce qu'il doit remarquer tout seul.
 *
 * Trois tâches de fond, aucune n'étant cosmétique : deux tiennent les
 * engagements pris sur la page /cookies et dans la politique de
 * confidentialité, la troisième repère les parcours abandonnés, qu'aucun
 * événement ne signale par nature - personne n'envoie « j'abandonne ».
 */

import {
  ACQUISITION_EVENT_RETENTION_DAYS,
  VISITOR_ID_RETENTION_DAYS,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { trackAcquisitionStep } from './acquisitionService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purge du journal détaillé, et effacement anticipé des identifiants de visite.
 *
 * Deux durées parce que deux engagements distincts :
 *
 *   - treize mois pour l'événement lui-même, ce qui laisse ses deux termes à
 *     une comparaison d'une année sur l'autre ;
 *   - trente jours pour le `visitorId`, et c'est cette brièveté qui maintient
 *     la mesure d'audience dans l'exemption de consentement. L'allonger
 *     obligerait à afficher une bannière sur tout le site.
 *
 * Les instantanés agrégés ne sont jamais purgés : ils ne portent aucun
 * identifiant, et ce sont eux qui font vivre les courbes anciennes.
 */
export async function pruneAcquisitionEvents(): Promise<void> {
  const now = Date.now();

  try {
    const visitorCutoff = new Date(now - VISITOR_ID_RETENTION_DAYS * DAY_MS);
    const anonymised = await prisma.acquisitionEvent.updateMany({
      where: { visitorId: { not: null }, occurredAt: { lt: visitorCutoff } },
      data: { visitorId: null },
    });
    if (anonymised.count > 0) {
      logger.info('Acquisition', `${anonymised.count} identifiants de visite effacés.`);
    }
  } catch (error) {
    logger.error('Acquisition', 'Effacement des identifiants de visite en échec :', error);
  }

  try {
    const cutoff = new Date(now - ACQUISITION_EVENT_RETENTION_DAYS * DAY_MS);
    const removed = await prisma.acquisitionEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    if (removed.count > 0) {
      logger.info('Acquisition', `${removed.count} événements de plus de 13 mois purgés.`);
    }
  } catch (error) {
    logger.error('Acquisition', 'Purge du journal du tunnel en échec :', error);
  }
}

/**
 * Efface les identifiants de personnes rattachés à un serveur qui est parti.
 *
 * Engagement pris dans la politique de confidentialité : le départ du bot
 * déclenche l'anonymisation sous trente jours. `GuildLifecycle` est conservé -
 * il ne porte que des dates et des montants - mais le journal, lui, garde des
 * empreintes de comptes Discord dont on n'a plus de raison de disposer.
 */
export async function anonymiseDepartedGuilds(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 30 * DAY_MS);
    const departed = await prisma.guildLifecycle.findMany({
      where: { botRemovedAt: { not: null, lt: cutoff } },
      select: { guildId: true },
    });
    if (departed.length === 0) return;

    const result = await prisma.acquisitionEvent.updateMany({
      where: {
        guildId: { in: departed.map((row) => row.guildId) },
        OR: [{ actorHash: { not: null } }, { visitorId: { not: null } }],
      },
      data: { actorHash: null, visitorId: null },
    });
    if (result.count > 0) {
      logger.info('Acquisition', `${result.count} événements anonymisés pour ${departed.length} serveurs partis.`);
    }
  } catch (error) {
    logger.error('Acquisition', 'Anonymisation des serveurs partis en échec :', error);
  }
}

/**
 * Délai au-delà duquel un parcours entamé et laissé de côté est tenu pour
 * abandonné.
 *
 * Soixante-douze heures : assez pour laisser passer un week-end - beaucoup de
 * serveurs se montent le vendredi soir et se reprennent le lundi - et assez peu
 * pour que l'abandon soit constaté tant qu'il est encore rattrapable.
 */
const ABANDON_AFTER_HOURS = 72;

/**
 * Marque les parcours abandonnés.
 *
 * L'abandon est la seule étape du tunnel que personne n'émet : un visiteur qui
 * renonce ferme simplement l'onglet. Elle ne peut donc être que déduite, et
 * c'est le rôle de cette tâche.
 *
 * L'idempotence ne vient pas d'un drapeau mais d'une lecture du journal : un
 * serveur déjà marqué comme abandonné n'est pas remarqué, et s'il reprend son
 * parcours, la progression le rendra de nouveau éligible plus tard.
 */
export async function scanAbandonedOnboardings(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ABANDON_AFTER_HOURS * 60 * 60 * 1000);

    const candidates = await prisma.guildLifecycle.findMany({
      where: {
        onboardingStartedAt: { not: null },
        onboardingCompletedAt: null,
        churnedAt: null,
        updatedAt: { lt: cutoff },
      },
      select: { guildId: true, onboardingLastStep: true, updatedAt: true },
      take: 500,
    });
    if (candidates.length === 0) return;

    // Un seul aller-retour pour savoir lesquels ont déjà été signalés, plutôt
    // qu'une requête par serveur.
    const already = await prisma.acquisitionEvent.findMany({
      where: {
        step: 'onboarding_abandoned',
        guildId: { in: candidates.map((row) => row.guildId) },
      },
      select: { guildId: true, occurredAt: true },
    });
    const lastFlagged = new Map<string, Date>();
    for (const event of already) {
      if (!event.guildId) continue;
      const previous = lastFlagged.get(event.guildId);
      if (!previous || event.occurredAt > previous) lastFlagged.set(event.guildId, event.occurredAt);
    }

    let flagged = 0;
    for (const row of candidates) {
      // Déjà signalé, et rien n'a bougé depuis : on n'y revient pas.
      const previous = lastFlagged.get(row.guildId);
      if (previous && previous >= row.updatedAt) continue;

      trackAcquisitionStep({
        step: 'onboarding_abandoned',
        guildId: row.guildId,
        metadata: { step: row.onboardingLastStep, idleHours: ABANDON_AFTER_HOURS },
      });
      flagged += 1;
    }

    if (flagged > 0) {
      logger.info('Acquisition', `${flagged} parcours de configuration marqués comme abandonnés.`);
    }
  } catch (error) {
    logger.error('Acquisition', 'Détection des parcours abandonnés en échec :', error);
  }
}
