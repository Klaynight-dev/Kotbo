/**
 * Activation d'un module depuis le dashboard.
 *
 * Un module se lit a deux endroits : `dashboardFeatureConfig`, qui porte le
 * statut affiche, et le champ propre au module quand il en a un
 * (`autoNicknameModerationEnabled`, `levelConfig.enabled`...). Ecrire l'un sans
 * l'autre laisse le serveur dans un etat ou la page dit une chose et le bot en
 * fait une autre. Les deux colonnes a ecrire ne sont plus enumerees ici : elles
 * viennent du registre (`@kotbo/contracts`), qui decrit aussi les dependances
 * entre modules.
 *
 * La bascule depuis la page Modules et la mise en place guidee du serveur
 * passent donc toutes deux par ici plutot que d'ecrire chacune sa version.
 */
import {
  MODULE_REGISTRY,
  canonicalModuleKey,
  getModuleDefinition,
  getModuleDependents,
  getModuleRequirements,
  isCoreModule,
  lowestPlanWithModule,
  normalizePlanKey,
  planIncludesModule,
  type PlanKey,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { invalidateLevelConfigCache } from '../progression/levelingService.js';
import { invalidateRankedConfigCache } from '../progression/ranked/rankedConfigService.js';
import { invalidateStarboardCache } from '../features/starboardService.js';
import { type KotboModule, setModuleActivation } from '../analytics/moduleStatsService.js';
import { getModuleStates, invalidateModuleStates } from './moduleGate.js';

const KOTBO_MODULE_BY_KEY: Record<string, KotboModule> = {
  'codepolice': 'codePolice',
  'daily_algo': 'dailyAlgo',
  'translation': 'translation',
  'sanctions': 'sanction',
  'nickname_moderation': 'nicknameModeration',
  'auto_thread': 'autoThread',
  'fun': 'fun',
  'leveling': 'leveling',
  'tickets': 'ticket',
  'analytics': 'analytics',
};

/**
 * Inverse du precedent, construit une fois : `autoThread` -> `auto_thread`.
 * Complete des noms de suivi qui designent une sous-partie d'un module : les
 * vocaux temporaires et le honeypot vivent dans « Gestion des salons », les
 * comptes multiples dans « Multi-comptes ».
 */
const KEY_BY_KOTBO_MODULE: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(KOTBO_MODULE_BY_KEY).map(([key, kotboModule]) => [kotboModule, key]),
  ),
  tempVoice: 'auto_thread',
  honeypot: 'auto_thread',
  altAccount: 'double_accounts',
};

function normalizeModuleName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
}

const KEY_BY_NORMALIZED_NAME = new Map<string, string>(
  MODULE_REGISTRY.map((mod) => [normalizeModuleName(mod.key), mod.key]),
);

/**
 * Ramene un nom de module venu du suivi statistique (`autoThread`, `ticket`) a
 * la cle du registre (`auto_thread`, `tickets`).
 *
 * Les outils MCP parlent la langue de `KOTBO_MODULES`, qui n'est pas celle des
 * cles canoniques : ecrire l'etat sous le nom recu creait une ligne que la
 * garde d'execution ne lit jamais, et la bascule n'avait donc aucun effet sur
 * le bot. Renvoie `undefined` quand aucun module du registre ne correspond,
 * pour que l'appelant le dise plutot que d'ecrire dans le vide.
 */
export function resolveModuleKey(name: string): string | undefined {
  const trimmed = name.trim();
  const canonical = canonicalModuleKey(trimmed);
  if (getModuleDefinition(canonical)) return canonical;
  const mapped = KEY_BY_KOTBO_MODULE[trimmed];
  if (mapped) return mapped;
  return KEY_BY_NORMALIZED_NAME.get(normalizeModuleName(trimmed));
}

export class CoreModuleError extends Error {
  constructor(moduleKey: string) {
    super(`Le module « ${moduleKey} » fait partie du cœur du bot et ne peut pas être désactivé.`);
    this.name = 'CoreModuleError';
  }
}

/**
 * Tentative d'allumer un module que l'offre du serveur ne comprend pas.
 *
 * Refuser ici et pas seulement dans l'interface : `moduleGate` éteignait déjà
 * ces modules à la lecture, mais l'écriture, elle, passait. Le serveur
 * répondait donc « c'est fait » à une bascule sans effet, et l'interrupteur
 * revenait à sa place au rechargement suivant - le module paraissait
 * s'éteindre tout seul, indéfiniment. C'est aussi la seule garde qui vaille :
 * l'interface n'est qu'un client parmi d'autres (outils MCP, appels directs à
 * l'API), et un client ne se garde pas lui-même.
 */
export class PlanLockedError extends Error {
  constructor(
    readonly moduleKey: string,
    readonly currentPlan: PlanKey,
    readonly requiredPlan: PlanKey | null,
  ) {
    super(
      requiredPlan
        ? `Le module « ${moduleKey} » n'est pas compris dans l'offre ${currentPlan} : il demande l'offre ${requiredPlan}.`
        : `Le module « ${moduleKey} » n'est pas compris dans l'offre ${currentPlan}.`,
    );
    this.name = 'PlanLockedError';
  }
}

export interface ModuleActivationOptions {
  /**
   * Autorise l'écriture d'un module que l'offre ne comprend pas encore.
   *
   * Réservé à la mise en place guidée : elle configure un serveur qui n'a pas
   * encore choisi d'offre, et lui refuser l'écriture reviendrait à lui
   * interdire de se préparer. La ligne enregistrée reste sans effet - la garde
   * de lecture la masque - jusqu'au paiement, qui la révèle sans qu'aucun
   * traitement n'ait à repasser derrière.
   */
  recordIntentWhenLocked?: boolean;
}

/** Ce qu'une bascule a réellement changé, au-delà du module demandé. */
export interface ModuleActivationResult {
  moduleKey: string;
  enabled: boolean;
  /** Dépendances allumées en même temps (activation). */
  enabledRequirements: string[];
  /** Dépendants éteints en même temps (désactivation). */
  disabledDependents: string[];
  /**
   * L'intention a été enregistrée, mais l'offre du serveur ne comprend pas le
   * module : il reste inerte jusqu'au paiement. L'appelant s'en sert pour dire
   * « préparé » plutôt que « activé ».
   */
  preparedOnly: boolean;
}

/** Écrit l'état d'un seul module, sans se soucier des dépendances. */
async function writeModuleState(
  guildId: string,
  moduleKey: string,
  enabled: boolean,
  featureName?: string,
): Promise<void> {
  const definition = getModuleDefinition(moduleKey);

  const fields = Object.fromEntries((definition?.guildFields ?? []).map((field) => [field, enabled]));
  if (Object.keys(fields).length > 0) {
    await prisma.guild.update({ where: { id: guildId }, data: fields });
  }

  // Le niveau vit dans sa propre table, creee au besoin : un serveur qui n'a
  // jamais touche au module n'a pas encore de ligne.
  if (moduleKey === 'leveling') {
    await prisma.levelConfig.upsert({
      where: { guildId },
      create: { guildId, enabled },
      update: { enabled },
    });
    await invalidateLevelConfigCache(guildId);
  }

  // Meme cas que le leveling : le prestige porte son etat dans sa propre table.
  // Sans cette ecriture, la bascule depuis la page Modules ne changeait que la
  // pastille, et la page Prestige continuait d'afficher son propre interrupteur
  // dans l'etat inverse.
  if (moduleKey === 'prestige') {
    await prisma.rankedConfig.upsert({
      where: { guildId },
      create: { guildId, enabled },
      update: { enabled },
    });
    await invalidateRankedConfigCache(guildId);
  }

  // Idem pour Starlight : le service de mise en avant lit `StarboardConfig`
  // directement, sans passer par la garde. Sans cette ecriture, allumer le
  // module depuis la page ne changerait que la pastille.
  if (moduleKey === 'starboard') {
    await prisma.starboardConfig.upsert({
      where: { guildId },
      create: { guildId, enabled },
      update: { enabled },
    });
    await invalidateStarboardCache(guildId);
  }

  // Idem pour les appels de bannissement : leur formulaire public lit
  // `BanAppealConfig.enabled` sans passer par la garde.
  if (moduleKey === 'ban_appeals') {
    await prisma.banAppealConfig.upsert({
      where: { guildId },
      create: { guildId, enabled },
      update: { enabled },
    });
  }

  const kotboModule = KOTBO_MODULE_BY_KEY[moduleKey];
  if (kotboModule) {
    // Suivi statistique : son echec ne doit pas faire echouer la bascule.
    await setModuleActivation(guildId, kotboModule, enabled, { featureKey: moduleKey })
      .catch((err) => logger.warn('ModuleActivation', 'Suivi d\'activation impossible :', err));
  }

  await prisma.dashboardFeatureConfig.upsert({
    where: { guildId_featureKey: { guildId, featureKey: moduleKey } },
    create: {
      guildId,
      featureKey: moduleKey,
      featureName: featureName ?? definition?.name ?? moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1),
      enabled,
      loggingEnabled: true,
      userActivityTracking: true,
      notifyViaDiscordChannel: true,
    },
    update: { enabled },
  });
}

/**
 * `featureName` ne sert qu'a la creation de la ligne, et seulement pour les
 * modules absents du registre : sans lui, ils s'afficheraient dans la page
 * Modules sous leur identifiant brut, « Channel_health » par exemple.
 *
 * Les dependances sont propagees dans les deux sens, sinon la page laisserait
 * exister des etats impossibles : eteindre « Leveling » en gardant « Saisons »
 * allume, ou allumer « Marche entre membres » sans economie.
 */
export async function setDashboardModuleStatus(
  guildId: string,
  moduleId: string,
  enabled: boolean,
  featureName?: string,
  options?: ModuleActivationOptions,
): Promise<ModuleActivationResult> {
  const key = canonicalModuleKey(moduleId);

  if (isCoreModule(key)) {
    throw new CoreModuleError(key);
  }

  const states = await getModuleStates(guildId);

  // Offre commerciale : on refuse d'ecrire ce que la garde de lecture
  // eteindrait juste apres. Seulement a l'allumage - eteindre un module hors
  // offre reste permis, sans quoi un serveur retrograde ne pourrait plus
  // ranger sa configuration.
  let preparedOnly = false;

  if (enabled) {
    // Lue en base et non via `planService` : celui-ci met l offre en cache, et
    // un cache tiede repondrait l ancienne offre juste apres un paiement - le
    // module resterait refuse a celui qui vient de l acheter. Une bascule est
    // un geste rare, elle peut se payer une requete exacte.
    const row = await prisma.guild.findUnique({ where: { id: guildId }, select: { plan: true } });
    const plan = normalizePlanKey(row?.plan);
    const locked = [key, ...getModuleRequirements(key)].find(
      (candidate) => !isCoreModule(candidate) && !planIncludesModule(plan, candidate),
    );

    if (locked) {
      // Refus par defaut : c est le cas de l interrupteur du dashboard, ou
      // ecrire l intention ferait revenir le bouton a sa place au rechargement
      // suivant, sans que rien n explique pourquoi.
      if (!options?.recordIntentWhenLocked) {
        throw new PlanLockedError(locked, plan, lowestPlanWithModule(locked));
      }
      // La mise en place guidee, elle, a le droit d ecrire l intention : elle
      // configure un serveur qui n a pas encore paye, et c est precisement ce
      // qu on lui demande. La ligne dit « allume », la garde de lecture la
      // masque tant que l offre ne comprend pas le module, et le jour du
      // paiement le masque tombe de lui-meme - il n y a rien a rejouer.
      preparedOnly = true;
    }
  }

  // Activation : tout ce dont le module a besoin doit suivre, sans quoi la
  // cascade de lecture le rendrait inactif juste apres l'avoir allume.
  const enabledRequirements = enabled
    ? getModuleRequirements(key).filter((requirement) => states[requirement] === false)
    : [];

  // Desactivation : ce qui repose dessus s'arrete aussi. On ne touche qu'aux
  // dependants reellement actifs, pour que le rallumage du parent ne rallume
  // pas des modules que l'admin avait eteints de son cote.
  const disabledDependents = !enabled
    ? getModuleDependents(key).filter((dependent) => states[dependent] !== false)
    : [];

  for (const requirement of enabledRequirements) {
    await writeModuleState(guildId, requirement, true);
  }

  await writeModuleState(guildId, key, enabled, featureName);

  for (const dependent of disabledDependents) {
    await writeModuleState(guildId, dependent, false);
  }

  // Sans cette invalidation, la garde d'execution continuerait de repondre avec
  // l'etat d'avant pendant toute la duree du cache : une desactivation ne
  // prendrait effet qu'une demi-minute plus tard, ce qui se lit comme un bug.
  await invalidateModuleStates(guildId);

  // Les commandes du module doivent disparaitre de la liste Discord, pas
  // seulement etre refusees a l'execution. La republication est differee et
  // groupee : appliquer un preset bascule une dizaine de modules d'affilee.
  scheduleCommandSync(guildId);

  return { moduleKey: key, enabled, enabledRequirements, disabledDependents, preparedOnly };
}

/**
 * Republication differee, sans faire dependre ce service du client Discord.
 *
 * La bascule est appelee depuis une route HTTP, depuis la mise en place guidee
 * et depuis les outils MCP ; certains de ces contextes n'ont pas de client sous
 * la main. On le resout au moment de planifier, et son absence n'est pas une
 * erreur : le script de deploiement et la reconciliation au demarrage
 * rattraperont.
 */
function scheduleCommandSync(guildId: string): void {
  void (async () => {
    try {
      const [{ getClient }, { scheduleGuildCommandSync }] = await Promise.all([
        import('../../utils/client.js'),
        import('./commandDeployment.js'),
      ]);
      scheduleGuildCommandSync(getClient(), guildId);
    } catch {
      /* pas de client dans ce contexte (script, test) : rien a republier */
    }
  })();
}
