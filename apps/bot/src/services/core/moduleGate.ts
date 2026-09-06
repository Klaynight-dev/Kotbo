/**
 * Garde d'exécution des modules.
 *
 * Le dashboard écrivait l'état d'un module sans que rien ne le relise : couper
 * « Tickets » laissait la commande, les boutons, les crons et les routes API
 * parfaitement opérationnels. Ce fichier est le point de lecture unique qui
 * manquait - tous les points d'entrée du bot passent par `isModuleEnabled`.
 *
 * Résolution de l'état d'un module, dans l'ordre :
 *   1. module `core` → toujours actif, il n'existe pas d'état à lire ;
 *   2. ligne `DashboardFeatureConfig` (clé canonique ou alias historique) ;
 *   3. table propre au module quand il en a une (`LevelConfig`, `RankedConfig`,
 *      `BanAppealConfig`), qui portait l'état bien avant le registre ;
 *   4. colonne `legacyField` de `Guild`, pour les serveurs configurés avant le
 *      registre et qui n'ont pas encore de ligne ;
 *   5. `defaultEnabled` du registre.
 * Un module dont une dépendance est éteinte est éteint, quelle que soit sa
 * propre valeur : la cascade est appliquée à la lecture et pas seulement à
 * l'écriture, pour qu'une donnée devenue incohérente (import, écriture directe
 * en base, migration) ne rouvre pas une fonctionnalité fermée.
 *
 * L'offre commerciale du serveur (`Guild.plan`) est appliquée **par-dessus**
 * tout cela, en dernier : un module hors offre est éteint quoi qu'en dise sa
 * ligne de configuration. Ce choix de placement est délibéré - la garde étant
 * le point de lecture unique, la grille tarifaire s'applique du même coup au
 * runtime du bot, au filtrage des routes API et à la navigation du dashboard,
 * sans qu'un seul des 59 modules ait à connaître l'existence de Stripe.
 */
import {
  MODULE_REGISTRY,
  canonicalModuleKey,
  getModuleDefinition,
  getModuleRequirements,
  normalizePlanKey,
  planIncludesModule,
  type PlanKey,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

export type ModuleStates = Record<string, boolean>;

/**
 * Clé sous le préfixe `guild:<id>:` pour être emportée par
 * `cache.invalidateGuild()`, que toutes les écritures du dashboard déclenchent
 * déjà.
 */
const cacheKeyFor = (guildId: string) => `guild:${guildId}:module_states`;

/** Court : une bascule doit se voir presque tout de suite même sans invalidation. */
const CACHE_TTL_SECONDS = 30;

/**
 * Requêtes en vol, par serveur. Un pic de messages sur un gros serveur
 * déclencherait autant de lectures identiques que de messages tant que le cache
 * est froid ; elles partagent ici la même promesse.
 */
const inFlight = new Map<string, Promise<ModuleStates>>();

function readLegacyFlag(guild: Record<string, unknown> | null, field: string | undefined): boolean | undefined {
  if (!guild || !field) return undefined;
  const value = guild[field];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * État déclaré d'un module, avant l'offre commerciale et la cascade : ce que la
 * ligne de configuration, la table propre au module ou la colonne historique
 * disent de lui. C'est la valeur à écrire quand on crée une ligne manquante -
 * l'état complet y figerait une dépendance éteinte ou une offre du moment.
 */
export async function getDeclaredModuleStates(guildId: string): Promise<ModuleStates> {
  return (await loadDeclaredModuleStates(guildId)).states;
}

async function loadDeclaredModuleStates(guildId: string): Promise<{ states: ModuleStates; plan: PlanKey }> {
  const [guild, featureConfigs, levelConfig, rankedConfig, banAppealConfig] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.dashboardFeatureConfig.findMany({
      where: { guildId },
      select: { featureKey: true, enabled: true },
    }),
    prisma.levelConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
    prisma.rankedConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
    prisma.banAppealConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
  ]);

  // Modules dont l'état vit dans leur propre table depuis avant le registre.
  // Sans cette lecture, un serveur qui n'a jamais touché à la page Modules
  // retombe sur `defaultEnabled: false` et voit sa page se fermer.
  const ownTableStates: Record<string, boolean | undefined> = {
    leveling: levelConfig?.enabled,
    prestige: rankedConfig?.enabled,
    ban_appeals: banAppealConfig?.enabled,
  };

  // Les alias historiques sont repliés sur la clé canonique. Si les deux
  // existent (`dailyalgo` et `daily_algo`), la canonique gagne : c'est celle que
  // le dashboard écrit désormais.
  const stored = new Map<string, boolean>();
  for (const config of featureConfigs) {
    const key = canonicalModuleKey(config.featureKey);
    if (config.featureKey === key || !stored.has(key)) stored.set(key, config.enabled);
  }

  const states: ModuleStates = {};
  for (const mod of MODULE_REGISTRY) {
    if (mod.core) {
      states[mod.key] = true;
      continue;
    }

    const storedState = stored.get(mod.key);
    if (storedState !== undefined) {
      states[mod.key] = storedState;
      continue;
    }

    const ownTableState = ownTableStates[mod.key];
    if (ownTableState !== undefined) {
      states[mod.key] = ownTableState;
      continue;
    }

    const legacy = readLegacyFlag(guild as Record<string, unknown> | null, mod.legacyField);
    states[mod.key] = legacy ?? mod.defaultEnabled;
  }

  return { states, plan: normalizePlanKey((guild as { plan?: unknown } | null)?.plan) };
}

async function loadModuleStates(guildId: string): Promise<ModuleStates> {
  const { states, plan } = await loadDeclaredModuleStates(guildId);

  // Offre commerciale : un module non vendu est éteint, même si sa ligne de
  // configuration dit le contraire. Appliqué avant la cascade pour que les
  // dépendants d'un module verrouillé s'éteignent eux aussi.
  for (const mod of MODULE_REGISTRY) {
    if (mod.core) continue;
    if (!planIncludesModule(plan, mod.key)) states[mod.key] = false;
  }

  // Cascade : un dépendant ne peut pas être plus actif que ce dont il dépend.
  for (const mod of MODULE_REGISTRY) {
    if (!states[mod.key]) continue;
    if (getModuleRequirements(mod.key).some((requirement) => states[requirement] === false)) {
      states[mod.key] = false;
    }
  }

  return states;
}

/** État de tous les modules d'un serveur, mis en cache. */
export async function getModuleStates(guildId: string): Promise<ModuleStates> {
  const key = cacheKeyFor(guildId);

  const cached = await cache.get<ModuleStates>(key);
  if (cached) return cached;

  const pending = inFlight.get(guildId);
  if (pending) return pending;

  const promise = loadModuleStates(guildId)
    .then(async (states) => {
      await cache.set(key, states, CACHE_TTL_SECONDS);
      return states;
    })
    .catch((err) => {
      // Une base injoignable ne doit pas éteindre le serveur entier : on repart
      // sur les défauts du registre, qui laissent le bot dans son état nominal.
      logger.error('ModuleGate', `Lecture de l'état des modules impossible pour ${guildId}:`, err);
      const fallback: ModuleStates = {};
      for (const mod of MODULE_REGISTRY) fallback[mod.key] = mod.core ? true : mod.defaultEnabled;
      return fallback;
    })
    .finally(() => {
      inFlight.delete(guildId);
    });

  inFlight.set(guildId, promise);
  return promise;
}

/**
 * Un module inconnu du registre est considéré actif : la garde ne doit pas
 * éteindre une fonctionnalité qu'elle ne sait pas décrire.
 */
export async function isModuleEnabled(guildId: string | null | undefined, moduleKey: string): Promise<boolean> {
  if (!guildId) return true;
  const definition = getModuleDefinition(moduleKey);
  if (!definition) return true;
  if (definition.core) return true;

  const states = await getModuleStates(guildId);
  return states[definition.key] !== false;
}

/** Variante pour plusieurs modules : une seule lecture d'état. */
export async function areModulesEnabled(
  guildId: string,
  moduleKeys: string[],
): Promise<Record<string, boolean>> {
  const states = await getModuleStates(guildId);
  const result: Record<string, boolean> = {};
  for (const moduleKey of moduleKeys) {
    const definition = getModuleDefinition(moduleKey);
    result[moduleKey] = !definition || definition.core || states[definition.key] !== false;
  }
  return result;
}

export async function invalidateModuleStates(guildId: string): Promise<void> {
  inFlight.delete(guildId);
  await cache.delete(cacheKeyFor(guildId));
}

/**
 * Restreint une liste de serveurs à ceux où le module tourne. Les crons
 * balayent toutes les guildes activées : sans ce filtre, un module éteint
 * continue son travail de fond une fois par heure.
 */
export async function filterGuildsWithModule(
  guildIds: Iterable<string>,
  moduleKey: string,
): Promise<string[]> {
  const ids = [...guildIds];
  const results = await Promise.all(
    ids.map(async (guildId) => ((await isModuleEnabled(guildId, moduleKey)) ? guildId : null)),
  );
  return results.filter((guildId): guildId is string => guildId !== null);
}
