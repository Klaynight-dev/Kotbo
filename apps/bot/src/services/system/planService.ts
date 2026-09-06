/**
 * planService.ts
 *
 * Offre commerciale d'un serveur : lecture, écriture, et conséquences.
 *
 * Trois couches se partagent le sujet et il faut savoir laquelle fait quoi :
 *
 *   - `planService` (ici)      : *quoi* est vendu - l'offre courante d'un serveur
 *                                et les modules qu'elle ouvre.
 *   - `accessService`          : *jusqu'à quand* - la date de fin, les rappels,
 *                                l'expiration automatique.
 *   - `stripeService` / webhook : *qui a payé* - la traduction d'un événement
 *                                Stripe en appels aux deux services ci-dessus.
 *
 * Aucune de ces couches n'écrit dans le domaine d'une autre : le webhook appelle
 * `setGuildPlan` puis `grantAccess`, il ne touche jamais `accessExpiresAt` ni
 * `plan` directement. C'est ce qui permet de poser une offre à la main depuis
 * l'administration (accord sur mesure, geste commercial) sans passer par Stripe
 * et sans rien casser.
 */

import { normalizePlanKey, planIncludesModule, type PlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../utils/cache.js';
import { invalidateModuleStates } from '../core/moduleGate.js';

export type { PlanKey };

/**
 * Offre d'un serveur inconnu de la base. `FREE` et non `CUSTOM` : un serveur qui
 * n'a jamais rien enregistré n'a rien acheté.
 */
const DEFAULT_PLAN: PlanKey = 'FREE';

const cacheKeyFor = (guildId: string) => `guild:${guildId}:plan`;

/** Aligné sur le cache d'état des modules : les deux se lisent ensemble. */
const CACHE_TTL_SECONDS = 30;

/**
 * Offre courante d'un serveur.
 *
 * Appelée sur des chemins chauds (chaque garde de module côté dashboard), d'où
 * le cache. `moduleGate` ne passe volontairement pas par ici : il lit déjà la
 * ligne `Guild` complète et y trouve la colonne, une requête de moins.
 */
export async function getGuildPlan(guildId: string): Promise<PlanKey> {
  const cached = await cache.get<PlanKey>(cacheKeyFor(guildId));
  if (cached) return cached;

  try {
    const row = await prisma.guild.findUnique({ where: { id: guildId }, select: { plan: true } });
    const plan = normalizePlanKey(row?.plan);
    await cache.set(cacheKeyFor(guildId), plan, CACHE_TTL_SECONDS);
    return plan;
  } catch (err) {
    // Une base injoignable ne doit pas offrir le catalogue complet à tout le
    // monde : on retombe sur l'offre la plus basse, comme `normalizePlanKey`.
    logger.error('Plan', `Lecture de l'offre impossible pour ${guildId}:`, err);
    return DEFAULT_PLAN;
  }
}

/**
 * Pose l'offre d'un serveur et purge les caches qui en dépendent.
 *
 * Ne touche ni à `activated` ni aux dates d'accès : la durée est le domaine
 * d'`accessService`. Un appelant qui vend un abonnement enchaîne les deux.
 */
export async function setGuildPlan(guildId: string, plan: PlanKey, reason: string): Promise<void> {
  await prisma.guild.update({ where: { id: guildId }, data: { plan } });
  await invalidatePlan(guildId);
  logger.info('Plan', `Offre de ${guildId} passée à ${plan} (${reason}).`);
}

/** À appeler après toute écriture de `Guild.plan` faite hors de ce service. */
export async function invalidatePlan(guildId: string): Promise<void> {
  await cache.delete(cacheKeyFor(guildId));
  // L'offre décide des modules ouverts : leur état calculé n'est plus valable.
  await invalidateModuleStates(guildId);
}

/**
 * Le module est-il compris dans l'offre du serveur ?
 *
 * À ne pas confondre avec `isModuleEnabled` : ici on répond « c'est vendu ou
 * non », là-bas « c'est allumé ou non ». Un module peut être compris dans
 * l'offre et volontairement éteint par un administrateur ; l'inverse est ce que
 * la page Modules affiche sous forme de cadenas.
 */
export async function isModuleInPlan(guildId: string, moduleKey: string): Promise<boolean> {
  return planIncludesModule(await getGuildPlan(guildId), moduleKey);
}
