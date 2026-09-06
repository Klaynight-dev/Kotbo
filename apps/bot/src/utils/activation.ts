import crypto from 'node:crypto';
import prisma from './db.js';
import { logger } from './logger.js';
import { getClient } from './client.js';
import { buildAccessFields, type AccessType } from '../services/system/accessService.js';
import { invalidateLevelConfigCache } from '../services/progression/levelingService.js';

function hashActivationCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export const activatedGuilds = new Set<string>();

/**
 * Loads all activated guilds from the database into the in-memory cache.
 */
export async function loadActivatedGuilds(): Promise<void> {
  try {
    const guilds = await prisma.guild.findMany({
      where: { activated: true },
      select: { id: true }
    });
    
    activatedGuilds.clear();
    for (const guild of guilds) {
      activatedGuilds.add(guild.id);
    }
    
    logger.success('Activation', `Chargement réussi : ${activatedGuilds.size} serveur(s) activé(s) mis en cache.`);
  } catch (error) {
    logger.error('Activation', 'Erreur lors du chargement des serveurs activés :', error);
    throw error;
  }
}

/**
 * Checks if a guild is activated in-memory.
 */
export function isGuildActivated(guildId: string): boolean {
  return activatedGuilds.has(guildId);
}

/**
 * Résultat d'une activation, décrivant l'accès accordé au serveur.
 * `expiresAt` est null pour un accès permanent (comportement historique).
 */
export interface ActivationResult {
  accessType: AccessType;
  durationMinutes: number | null;
  expiresAt: Date | null;
}

/**
 * Activates a guild in the database and updates the cache.
 *
 * Le type d'accès (permanent, essai, abonnement) et sa durée sont portés par le
 * code consommé : un code « essai 15 jours » pose directement la date de fin sur
 * la guilde, que le cron `access-lifecycle` se chargera ensuite de faire vivre.
 */
export async function activateGuild(guildId: string, code: string): Promise<ActivationResult> {
  const normalizedCode = code.trim().toUpperCase();
  const activatedAt = new Date();
  let result: ActivationResult = { accessType: 'PERMANENT', durationMinutes: null, expiresAt: null };

  await prisma.$transaction(async (tx) => {
    const activationCode = await tx.activationCode.findUnique({
      where: { code: normalizedCode },
    });

    if (!activationCode || !activationCode.isActive || activationCode.usedAt) {
      throw new Error('Code invalide, déjà utilisé ou expiré.');
    }

    const accessFields = buildAccessFields(
      (activationCode.accessType as AccessType) ?? 'PERMANENT',
      activationCode.durationMinutes,
      activatedAt,
    );
    result = {
      accessType: accessFields.accessType,
      durationMinutes: accessFields.accessExpiresAt ? activationCode.durationMinutes : null,
      expiresAt: accessFields.accessExpiresAt,
    };

    await tx.activationCode.update({
      where: { code: normalizedCode },
      data: {
        usedAt: activatedAt,
        usedByGuildId: guildId,
        isActive: false,
      },
    });

    await tx.guild.upsert({
      where: { id: guildId },
      update: {
        activated: true,
        activatedAt,
        activationCode: hashActivationCode(normalizedCode),
        activatedViaStaffLink: false,
        ...accessFields,
      },
      create: {
        id: guildId,
        activated: true,
        activatedAt,
        activationCode: hashActivationCode(normalizedCode),
        activatedViaStaffLink: false,
        ...accessFields,
      },
    });
  });

  logger.success(
    'Activation',
    `Le serveur ${guildId} a été activé` +
      (result.expiresAt ? ` (${result.accessType}, fin le ${result.expiresAt.toISOString()}).` : '.'),
  );

  // Origine de l'activation : un serveur venu d'un code partenaire et un
  // serveur venu du libre-service ne se comportent ni a la conversion ni a la
  // retention, et l'axe n'a de sens que si on le pose au moment ou on le sait.
  const { trackAcquisitionStep } = await import('../services/analytics/acquisitionService.js');
  trackAcquisitionStep({
    step: 'code_activated',
    guildId,
    metadata: { origin: 'CODE', accessType: result.accessType, durationMinutes: result.durationMinutes },
    occurredAt: activatedAt,
  });

  await broadcastActivationChange(guildId, true);
  schedulePostActivationSync(guildId);
  syncGuildCommandsForActivation(guildId, true);

  // Ce serveur peut être le principal d'un ou plusieurs serveurs staff en attente.
  await cascadeToLinkedStaffGuilds(guildId);

  return result;
}

/**
 * Active un serveur sans code, a son arrivee.
 *
 * Le code d'activation etait la seule porte d'entree : il fallait le demander a
 * un administrateur Kotbo, ce qui convient a une distribution sur invitation
 * mais interdit tout parcours en libre-service - personne ne va reclamer un
 * code a un inconnu pour essayer un bot. Le serveur entre donc desormais seul,
 * en offre `FREE`.
 *
 * Ouvrir la porte ne donne rien : `FREE` ne comprend aucun module, et
 * `moduleGate` les eteint tous. Ce que l'activation ouvre, c'est le dashboard
 * et la possibilite de se configurer - pas le service. La barriere commerciale
 * est la grille tarifaire, pas ce verrou-ci, qui ne servait qu'a filtrer qui
 * pouvait entrer.
 *
 * `activateGuild` reste en place pour les cas manuels : partenariats, geste
 * commercial, acces negocie. Un code porte un type d'acces et une duree, ce que
 * cette fonction ne fait pas.
 *
 * Sans effet si le serveur est deja active : on ne reecrit pas `activatedAt`
 * d'un serveur qui revient apres un redemarrage, sans quoi son anciennete
 * repartirait de zero a chaque reconnexion.
 */
export async function activateGuildSelfServe(guildId: string): Promise<boolean> {
  const existing = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { activated: true },
  });
  if (existing?.activated) return false;

  const activatedAt = new Date();

  await prisma.guild.upsert({
    where: { id: guildId },
    update: {
      activated: true,
      activatedAt,
      // Aucun code consomme : la colonne reste nulle, ce qui distingue en base
      // une entree libre-service d'une activation par code.
      activationCode: null,
      activatedViaStaffLink: false,
    },
    create: {
      id: guildId,
      activated: true,
      activatedAt,
      activationCode: null,
      activatedViaStaffLink: false,
    },
  });

  logger.success('Activation', `Le serveur ${guildId} s'est active en libre-service (offre FREE).`);

  await broadcastActivationChange(guildId, true);
  schedulePostActivationSync(guildId);
  syncGuildCommandsForActivation(guildId, true);
  await cascadeToLinkedStaffGuilds(guildId);

  return true;
}

async function broadcastActivationChange(guildId: string, activated: boolean): Promise<void> {
  if (activated) {
    activatedGuilds.add(guildId);
  } else {
    activatedGuilds.delete(guildId);
  }

  try {
    const client = getClient();
    if (client.shard) {
      const activationPath = import.meta.url;
      await client.shard.broadcastEval(async (_c: unknown, context: { id: string; activationPath: string; activated: boolean }) => {
        const m = await import(context.activationPath);
        if (context.activated) {
          m.activatedGuilds.add(context.id);
        } else {
          m.activatedGuilds.delete(context.id);
        }
      }, { context: { id: guildId, activationPath, activated } }).catch((err: unknown) => {
        logger.error('Activation', `Failed to broadcast activation change for ${guildId}:`, err);
      });
    }
  } catch {
    // client might not be initialized yet in some contexts (e.g. CLI seed scripts)
  }
}

export type StaffGuildReconcileResult = 'activated' | 'deactivated' | 'unchanged';

/**
 * Réconcilie l'activation d'un serveur staff avec celle de son/ses serveur(s) principal(aux) lié(s).
 * Un serveur staff n'a pas son propre code : il hérite de l'activation du principal tant qu'un
 * StaffServerLink actif existe. Ne touche jamais une guilde activée directement par son propre code.
 */
export async function reconcileStaffGuildActivation(staffGuildId: string): Promise<StaffGuildReconcileResult> {
  const links = await prisma.staffServerLink.findMany({
    where: { staffGuildId, enabled: true },
    include: { mainGuild: { select: { id: true, activated: true, activationCode: true } } },
  });

  const activeMain = links.find((l) => l.mainGuild.activated);
  const shouldBeActive = !!activeMain;

  const current = await prisma.guild.findUnique({
    where: { id: staffGuildId },
    select: { activated: true, activatedViaStaffLink: true },
  });

  if (shouldBeActive && !current?.activated) {
    await prisma.guild.upsert({
      where: { id: staffGuildId },
      update: {
        activated: true,
        activatedAt: new Date(),
        activationCode: activeMain!.mainGuild.activationCode,
        activatedViaStaffLink: true,
      },
      create: {
        id: staffGuildId,
        activated: true,
        activatedAt: new Date(),
        activationCode: activeMain!.mainGuild.activationCode,
        activatedViaStaffLink: true,
      },
    });

    await broadcastActivationChange(staffGuildId, true);
    schedulePostActivationSync(staffGuildId);
    syncGuildCommandsForActivation(staffGuildId, true);
    logger.success('Activation', `Le serveur staff ${staffGuildId} a été activé automatiquement via le lien avec ${activeMain!.mainGuild.id}.`);

    await applyStaffServerFeatureDefaults(staffGuildId);
    return 'activated';
  }

  if (!shouldBeActive && current?.activated && current.activatedViaStaffLink) {
    await prisma.guild.update({
      where: { id: staffGuildId },
      data: {
        activated: false,
        activatedAt: null,
        activationCode: null,
        activatedViaStaffLink: false,
      },
    });

    await broadcastActivationChange(staffGuildId, false);
    syncGuildCommandsForActivation(staffGuildId, false);
    logger.success('Activation', `Le serveur staff ${staffGuildId} a été désactivé (plus aucun serveur principal lié activé).`);
    return 'deactivated';
  }

  return 'unchanged';
}

function schedulePostActivationSync(guildId: string): void {
  try {
    const client = getClient();
    void import('../services/analytics/guildDataSyncService.js')
      .then(({ scheduleGuildDataSync }) => scheduleGuildDataSync(client, guildId))
      .catch((error) => {
        logger.error('Activation', `Impossible de planifier la synchronisation de ${guildId}:`, error);
      });
  } catch {
    // Certains contextes sans client Discord (tests, scripts CLI) activent aussi
    // des guildes. Le prochain ClientReady reprendra alors la synchronisation.
  }
}

/**
 * Publie ou retire les commandes de guilde selon l'activation.
 *
 * Les commandes sont déployées serveur par serveur : un serveur qui vient
 * d'être activé n'en a encore aucune, et un serveur désactivé doit les perdre -
 * sinon le bot laisse une liste de commandes qui répondront toutes « activation
 * requise ».
 */
function syncGuildCommandsForActivation(guildId: string, activated: boolean): void {
  void (async () => {
    try {
      const client = getClient();
      const { syncGuildCommands, clearGuildCommands } = await import(
        '../services/core/commandDeployment.js'
      );
      if (activated) await syncGuildCommands(client, guildId);
      else await clearGuildCommands(client, guildId);
    } catch (error) {
      // Sans client (script CLI, test) il n'y a rien à publier ; une erreur
      // réseau, elle, sera rattrapée par la réconciliation au démarrage.
      logger.warn('Activation', `Commandes non synchronisées pour ${guildId}:`, error);
    }
  })();
}

/**
 * Désactive par défaut les modules communautaires (économie, leveling) sur un serveur staff
 * qui vient d'être activé pour la première fois via un lien. Défaut appliqué une seule fois :
 * un admin peut les réactiver manuellement ensuite sans que le bot ne les réimpose.
 */
async function applyStaffServerFeatureDefaults(guildId: string): Promise<void> {
  await prisma.economyConfig.upsert({
    where: { guildId },
    update: { enabled: false, rpgEnabled: false, shopEnabled: false, guildsEnabled: false },
    create: { guildId, enabled: false, rpgEnabled: false, shopEnabled: false, guildsEnabled: false },
  }).catch((err) => logger.warn('Activation', `Impossible d'appliquer les défauts économie sur ${guildId}:`, err));

  await prisma.levelConfig.upsert({
    where: { guildId },
    update: { enabled: false },
    create: { guildId, enabled: false },
  }).catch((err) => logger.warn('Activation', `Impossible d'appliquer les défauts leveling sur ${guildId}:`, err));
  await invalidateLevelConfigCache(guildId).catch(() => null);
}

/**
 * Quand une guilde (potentiellement "principale") change d'état d'activation, propage la
 * réconciliation vers tous les serveurs staff qui lui sont liés.
 */
async function cascadeToLinkedStaffGuilds(mainGuildId: string): Promise<void> {
  const links = await prisma.staffServerLink.findMany({
    where: { mainGuildId, enabled: true },
    select: { staffGuildId: true },
  });

  for (const link of links) {
    await reconcileStaffGuildActivation(link.staffGuildId).catch((err) =>
      logger.error('Activation', `Erreur de réconciliation pour le serveur staff ${link.staffGuildId}:`, err),
    );
  }
}

export interface DeactivateOptions {
  /**
   * Remet le code consommé en circulation (défaut : true, comportement d'une
   * désactivation manuelle). Mis à false quand l'accès arrive à échéance : un
   * essai terminé ne doit jamais pouvoir être rejoué avec le même code.
   */
  recycleCode?: boolean;
}

/**
 * Deactivates a guild.
 */
export async function deactivateGuild(guildId: string, options: DeactivateOptions = {}): Promise<void> {
  const { recycleCode = true } = options;

  if (recycleCode) {
    // On retrouve le code par le serveur qui l'a consommé, jamais par
    // `guild.activationCode` : cette colonne ne contient qu'une empreinte
    // SHA-256 du code, précisément pour qu'une lecture de la table `guilds` ne
    // livre pas un code réutilisable. Chercher par cette empreinte ne pouvait
    // donc jamais aboutir.
    //
    // `updateMany` ne lève pas quand aucune ligne ne correspond : cas normal
    // d'un serveur staff, qui hérite de l'activation du principal sans posséder
    // de code à lui.
    //
    // Seuls les codes permanents sont remis en circulation : reprendre une
    // licence pour la réattribuer ailleurs est légitime. Un code à durée limitée
    // est consommé une fois pour toutes : sans quoi le même code rejouerait
    // indéfiniment une nouvelle période d'essai. Pour redonner un essai, on
    // génère un nouveau code.
    const { count } = await prisma.activationCode.updateMany({
      where: { usedByGuildId: guildId, accessType: 'PERMANENT' },
      data: {
        usedAt: null,
        usedByGuildId: null,
        isActive: true
      }
    });

    if (count > 0) {
      logger.info('Activation', `${count} code(s) permanent(s) remis en circulation après la désactivation de ${guildId}.`);
    }
  }

  // Deactivate the guild
  await prisma.guild.update({
    where: { id: guildId },
    data: {
      activated: false,
      activatedAt: null,
      activationCode: null,
      activatedViaStaffLink: false,
    }
  });

  logger.success('Activation', `Le serveur ${guildId} a été désactivé.`);

  await broadcastActivationChange(guildId, false);
  syncGuildCommandsForActivation(guildId, false);

  // Ce serveur peut être le principal d'un ou plusieurs serveurs staff : ils perdent leur activation cascadée.
  await cascadeToLinkedStaffGuilds(guildId);
}
