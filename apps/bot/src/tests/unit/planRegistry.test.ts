/**
 * La grille tarifaire decide de ce qui est ouvert ou ferme sur chaque serveur,
 * et personne ne la relit a la compilation : une erreur dedans se traduit soit
 * par un module payant offert a tout le monde, soit par un client qui a paye et
 * ne recoit rien. Les deux se voient en production, pas avant.
 *
 * Ces tests verifient les invariants qui doivent tenir quoi qu on fasse bouger
 * dans PLAN_REGISTRY ou MODULE_REGISTRY.
 */
import { describe, expect, test } from 'bun:test';
import {
  MODULE_REGISTRY,
  PLAN_KEYS,
  PLAN_MEMBER_THRESHOLDS,
  PLAN_REGISTRY,
  canPurchasePlan,
  comparePlans,
  getPlanDefinition,
  lowestPlanWithModule,
  modulesForPlan,
  normalizePlanKey,
  planAllowsTrial,
  planForMemberCount,
  planIncludesModule,
  TRIAL_DAYS,
  type PlanKey,
} from '@kotbo/contracts';

describe('registre des offres', () => {
  test('chaque cle du type a bien une definition', () => {
    for (const key of PLAN_KEYS) {
      expect(getPlanDefinition(key).key).toBe(key);
    }
    expect(PLAN_REGISTRY.length).toBe(PLAN_KEYS.length);
  });

  test('les modules cites par une offre existent tous dans le registre', () => {
    const known = new Set(MODULE_REGISTRY.map((mod) => mod.key));
    for (const plan of PLAN_REGISTRY) {
      if (plan.modules === 'all') continue;
      for (const moduleKey of plan.modules) {
        expect(known.has(moduleKey)).toBe(true);
      }
    }
  });

  test('une offre vendue en ligne declare ses deux variables de prix', () => {
    for (const plan of PLAN_REGISTRY) {
      if (!plan.selfServe) continue;
      expect(plan.priceEnv).not.toBeNull();
      expect(plan.displayPriceCents).not.toBeNull();
    }
  });

  test("l'annuel revient moins cher que douze mensualites", () => {
    for (const plan of PLAN_REGISTRY) {
      if (!plan.displayPriceCents) continue;
      expect(plan.displayPriceCents.year).toBeLessThan(plan.displayPriceCents.month * 12);
    }
  });
});

describe('modules ouverts par une offre', () => {
  test('les modules core sont ouverts sur toutes les offres, y compris FREE', () => {
    const core = MODULE_REGISTRY.filter((mod) => mod.core).map((mod) => mod.key);
    for (const key of PLAN_KEYS) {
      for (const moduleKey of core) {
        expect(planIncludesModule(key, moduleKey)).toBe(true);
      }
    }
  });

  test("l'echelle est monotone : une offre superieure n'enleve jamais rien", () => {
    const ladder: PlanKey[] = ['FREE', 'PLUS', 'PRO', 'ULTIMATE'];
    for (let i = 1; i < ladder.length; i++) {
      const lower = new Set(modulesForPlan(ladder[i - 1]!));
      const higher = new Set(modulesForPlan(ladder[i]!));
      for (const moduleKey of lower) {
        expect(higher.has(moduleKey)).toBe(true);
      }
    }
  });

  test('toutes les offres payantes ouvrent tout le catalogue', () => {
    // La promesse commerciale est « rien n est en option » : un palier qui
    // ouvrirait moins que le suivant la contredirait, quel que soit son prix.
    const all = MODULE_REGISTRY.length;
    for (const key of ['PLUS', 'PRO', 'ULTIMATE', 'CUSTOM'] as PlanKey[]) {
      expect(modulesForPlan(key).length).toBe(all);
    }
  });

  test('FREE laisse de cote au moins un module de chaque categorie payante', () => {
    // Sinon l'offre gratuite couvre tout et il n'y a plus rien a vendre.
    for (const category of ['staff', 'community', 'integrations'] as const) {
      const inCategory = MODULE_REGISTRY.filter((mod) => mod.category === category && !mod.core);
      expect(inCategory.some((mod) => !planIncludesModule('FREE', mod.key))).toBe(true);
    }
  });

  test('un module inconnu du registre est considere inclus', () => {
    // Meme regle que moduleGate : la garde ne ferme pas ce qu elle ne sait pas
    // decrire, sous peine d eteindre une fonctionnalite par simple oubli.
    expect(planIncludesModule('FREE', 'module_qui_n_existe_pas')).toBe(true);
  });
});

describe('comparaison et normalisation', () => {
  test("l'echelle est ordonnee", () => {
    expect(comparePlans('FREE', 'PRO')).toBeLessThan(0);
    expect(comparePlans('PLUS', 'PRO')).toBeLessThan(0);
    expect(comparePlans('ULTIMATE', 'PRO')).toBeGreaterThan(0);
    expect(comparePlans('PRO', 'PRO')).toBe(0);
    expect(comparePlans('CUSTOM', 'ULTIMATE')).toBeGreaterThan(0);
  });

  test('toute valeur inattendue retombe sur FREE', () => {
    // En cas de donnee corrompue on ferme, on n ouvre pas.
    expect(normalizePlanKey(undefined)).toBe('FREE');
    expect(normalizePlanKey(null)).toBe('FREE');
    expect(normalizePlanKey('')).toBe('FREE');
    expect(normalizePlanKey('GRATUIT')).toBe('FREE');
    expect(normalizePlanKey(42)).toBe('FREE');
  });

  test('la casse de la base est toleree', () => {
    expect(normalizePlanKey('pro')).toBe('PRO');
    expect(normalizePlanKey('Ultimate')).toBe('ULTIMATE');
  });
});

describe('palier decide par la taille du serveur', () => {
  test('chaque tranche renvoie son offre, bornes comprises', () => {
    // Les bornes sont ce qui casse en silence : un `>` mis pour un `>=` fait
    // basculer tout un palier de serveurs sur le mauvais tarif.
    expect(planForMemberCount(0)).toBe('PLUS');
    expect(planForMemberCount(1)).toBe('PLUS');
    expect(planForMemberCount(PLAN_MEMBER_THRESHOLDS.PRO)).toBe('PLUS');
    expect(planForMemberCount(PLAN_MEMBER_THRESHOLDS.PRO + 1)).toBe('PRO');
    expect(planForMemberCount(PLAN_MEMBER_THRESHOLDS.ULTIMATE)).toBe('PRO');
    expect(planForMemberCount(PLAN_MEMBER_THRESHOLDS.ULTIMATE + 1)).toBe('ULTIMATE');
    expect(planForMemberCount(PLAN_MEMBER_THRESHOLDS.CUSTOM)).toBe('ULTIMATE');
    expect(planForMemberCount(PLAN_MEMBER_THRESHOLDS.CUSTOM + 1)).toBe('CUSTOM');
  });

  test('les tranches du registre collent aux seuils', () => {
    // Les cartes affichent `memberRange`, la route de paiement applique les
    // seuils : les deux racontent la meme grille ou le client voit un prix
    // qu il ne peut pas souscrire.
    for (const plan of PLAN_REGISTRY) {
      if (!plan.memberRange) continue;
      expect<PlanKey>(planForMemberCount(plan.memberRange.min)).toBe(plan.key);
      if (plan.memberRange.max !== null) {
        expect<PlanKey>(planForMemberCount(plan.memberRange.max)).toBe(plan.key);
      }
    }
  });

  test('un effectif inconnu ne pousse ni vers le haut ni vers le bas', () => {
    // Ni l offre la plus chere sur la foi d une donnee manquante, ni la moins
    // chere qui laisserait un gros serveur payer le tarif d un petit.
    expect(planForMemberCount(null)).toBe('PRO');
    expect(planForMemberCount(undefined)).toBe('PRO');
    expect(planForMemberCount(Number.NaN)).toBe('PRO');
  });

  test('un serveur ne peut acheter que le palier de sa taille', () => {
    expect(canPurchasePlan('PLUS', 300)).toBe(true);
    expect(canPurchasePlan('PRO', 300)).toBe(false);
    expect(canPurchasePlan('PLUS', 5_000)).toBe(false);
    // CUSTOM passe par un rendez-vous, jamais par Stripe.
    expect(canPurchasePlan('CUSTOM', 200_000)).toBe(false);
  });
});

describe("offre a proposer pour debloquer un module", () => {
  test('seuls les modules du coeur ne renvoient aucune offre', () => {
    // Depuis que l offre gratuite n ouvre plus rien, « pas d offre a proposer »
    // ne veut plus dire « module gratuit » mais « module du coeur » : ceux-la
    // sont ouverts sans abonnement, sans quoi un serveur non abonne perdrait
    // jusqu a la page qui lui permet de s abonner.
    for (const mod of MODULE_REGISTRY) {
      if (mod.core) expect(lowestPlanWithModule(mod.key)).toBeNull();
      else expect(lowestPlanWithModule(mod.key)).not.toBeNull();
    }
  });

  test('tout module verrouille se debloque des la premiere offre payante', () => {
    // Les offres payantes portent le meme catalogue et ne different que par la
    // taille de serveur visee : la plus basse qui ouvre un module est donc
    // toujours l entree de gamme. Ce test tombe si quelqu un remet une
    // exclusivite Pro ou Ultimate sans reprendre le discours commercial
    // « rien n est en option ».
    const locked = MODULE_REGISTRY.filter((mod) => !planIncludesModule('FREE', mod.key));
    expect(locked.length).toBeGreaterThan(0);

    for (const mod of locked) {
      expect(lowestPlanWithModule(mod.key)).toBe('PLUS');
    }
  });

  test('CUSTOM n est jamais propose comme solution a un cadenas', () => {
    for (const mod of MODULE_REGISTRY) {
      expect(lowestPlanWithModule(mod.key)).not.toBe('CUSTOM');
    }
  });
});

describe('essai gratuit', () => {
  test("la duree annoncee est celle promise aux clients", () => {
    // Ecrite dans les CGU et sur la page tarifs : elle ne se change pas par
    // inadvertance au detour d un refactor.
    expect(TRIAL_DAYS).toBe(15);
  });

  test('seules les offres vendues en ligne ouvrent droit a l essai', () => {
    expect(planAllowsTrial('PLUS')).toBe(true);
    expect(planAllowsTrial('PRO')).toBe(true);
    expect(planAllowsTrial('ULTIMATE')).toBe(true);
    // FREE n a rien a essayer, CUSTOM se negocie periode de decouverte comprise.
    expect(planAllowsTrial('FREE')).toBe(false);
    expect(planAllowsTrial('CUSTOM')).toBe(false);
  });
});
