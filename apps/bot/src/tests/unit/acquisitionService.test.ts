/**
 * Le tunnel d'acquisition sert a decider ou investir : quel canal rapporte des
 * serveurs qui paient, ou l'on decroche dans le parcours, ce que coute
 * reellement un client. Une projection fausse ne se voit pas - elle produit des
 * courbes plausibles et des decisions prises a l'aveugle.
 *
 * L'invariant central teste ici : **une date de premiere fois ne s'ecrase
 * pas**. Si `firstPaidAt` ou `invitedAt` bougeaient a chaque nouvel evenement,
 * les serveurs changeraient de cohorte tout seuls et la retention deviendrait
 * ininterpretable, sans qu'aucune erreur ne soit levee nulle part.
 */
import { describe, expect, test } from 'bun:test';
import {
  ACQUISITION_STEPS,
  ACQUISITION_STEPS_UPSTREAM,
  classifyReferrer,
  isAcquisitionStep,
  isPublicAcquisitionStep,
  normalizeAcquisitionSource,
  sizeBucketFor,
} from '@kotbo/contracts';
import { hashActor, projectStep } from '../../services/analytics/acquisitionService.js';

/** Etat de serveur minimal, complete au cas par cas par les tests. */
function lifecycle(overrides: Record<string, unknown> = {}): never {
  return {
    guildId: 'g1',
    source: null,
    campaign: null,
    content: null,
    activationOrigin: null,
    instanceId: null,
    invitedAt: null,
    dashboardFirstOpenedAt: null,
    onboardingStartedAt: null,
    onboardingCompletedAt: null,
    onboardingLastStep: null,
    onboardingSteps: null,
    onboardingSeconds: null,
    pricingViewedAt: null,
    checkoutStartedAt: null,
    checkoutAbandonedAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialConvertedAt: null,
    firstPaidAt: null,
    plan: 'FREE',
    interval: null,
    mrrCents: 0,
    lifetimeCents: 0,
    churnedAt: null,
    churnReason: null,
    botRemovedAt: null,
    reinstallCount: 0,
    memberCountAtInvite: null,
    memberCount: null,
    serverKind: null,
    tracks: [],
    locale: null,
    timezone: null,
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

const T0 = new Date('2026-01-01T10:00:00.000Z');
const T1 = new Date('2026-06-01T10:00:00.000Z');

describe('catalogue des etapes', () => {
  test('aucun doublon : deux etapes homonymes rendraient le tunnel illisible', () => {
    expect(new Set(ACQUISITION_STEPS).size).toBe(ACQUISITION_STEPS.length);
  });

  test('une valeur inconnue est refusee', () => {
    expect(isAcquisitionStep('bot_joined')).toBe(true);
    expect(isAcquisitionStep('paiement')).toBe(false);
    expect(isAcquisitionStep(null)).toBe(false);
  });

  test('un visiteur anonyme ne peut declarer que l amont du tunnel', () => {
    // La route publique est ouverte a Internet : si `first_payment` y etait
    // acceptable, n'importe qui rendrait les revenus fantaisistes.
    expect(isPublicAcquisitionStep('pricing_viewed')).toBe(true);
    expect(isPublicAcquisitionStep('first_payment')).toBe(false);
    expect(isPublicAcquisitionStep('bot_joined')).toBe(false);
    expect(isPublicAcquisitionStep('subscription_ended')).toBe(false);

    for (const step of ACQUISITION_STEPS_UPSTREAM) {
      expect(isPublicAcquisitionStep(step)).toBe(true);
    }
  });
});

describe('classification du referent', () => {
  test('reconnait les deux canaux de diffusion reels', () => {
    expect(classifyReferrer('https://www.google.com/search?q=bot+discord')).toBe('google');
    expect(classifyReferrer('https://google.fr/')).toBe('google');
    expect(classifyReferrer('https://discord.com/channels/1/2')).toBe('discord');
  });

  test('absence de referent vaut acces direct, pas provenance inconnue', () => {
    expect(classifyReferrer(null)).toBe('direct');
    expect(classifyReferrer('')).toBe('direct');
    expect(classifyReferrer('   ')).toBe('direct');
  });

  test('la navigation interne ne compte pas comme une provenance', () => {
    expect(classifyReferrer('https://kotbo.fr/cgv')).toBe('internal');
  });

  test('tout le reste retombe sur `other` sans jeter', () => {
    expect(classifyReferrer('https://exemple.test/x')).toBe('other');
    expect(classifyReferrer('pas une url du tout')).toBe('other');
  });

  test('un sous-domaine trompeur ne passe pas pour Discord', () => {
    // `discord.com.attaquant.test` ne doit pas etre compte comme Discord.
    expect(classifyReferrer('https://discord.com.attaquant.test/')).toBe('other');
  });
});

describe('provenances et tranches de taille', () => {
  test('une provenance hors liste devient `other`, jamais la valeur brute', () => {
    expect(normalizeAcquisitionSource('landing')).toBe('landing');
    expect(normalizeAcquisitionSource('LANDING')).toBe('landing');
    expect(normalizeAcquisitionSource('<script>')).toBe('other');
    expect(normalizeAcquisitionSource(undefined)).toBe('direct');
  });

  test('les tranches couvrent toute la plage sans trou ni chevauchement', () => {
    expect(sizeBucketFor(0)).toBe('0-100');
    expect(sizeBucketFor(100)).toBe('0-100');
    expect(sizeBucketFor(101)).toBe('100-1k');
    expect(sizeBucketFor(1_000)).toBe('100-1k');
    expect(sizeBucketFor(1_001)).toBe('1k-10k');
    expect(sizeBucketFor(10_000)).toBe('1k-10k');
    expect(sizeBucketFor(10_001)).toBe('10k-100k');
    expect(sizeBucketFor(100_000)).toBe('10k-100k');
    expect(sizeBucketFor(100_001)).toBe('100k+');
    expect(sizeBucketFor(null)).toBe('0-100');
  });
});

describe('pseudonymisation', () => {
  test('sans secret, aucun identifiant n est stocke - meme hache', () => {
    const previous = process.env.ANALYTICS_HASH_SECRET;
    delete process.env.ANALYTICS_HASH_SECRET;
    expect(hashActor('123456789012345678')).toBeNull();
    if (previous !== undefined) process.env.ANALYTICS_HASH_SECRET = previous;
  });

  test('avec secret, le hache est stable et ne contient pas l identifiant', () => {
    const previous = process.env.ANALYTICS_HASH_SECRET;
    process.env.ANALYTICS_HASH_SECRET = 'secret-de-test';

    const id = '123456789012345678';
    const first = hashActor(id);
    expect(first).toBe(hashActor(id));
    expect(first).not.toBeNull();
    expect(first).not.toContain(id);
    expect(first).not.toBe(hashActor('987654321098765432'));

    if (previous === undefined) delete process.env.ANALYTICS_HASH_SECRET;
    else process.env.ANALYTICS_HASH_SECRET = previous;
  });
});

describe('projection : les dates de premiere fois ne bougent pas', () => {
  test('une arrivee deja enregistree ne redate pas le serveur', () => {
    const patch = projectStep({ step: 'bot_joined', guildId: 'g1' }, lifecycle({ invitedAt: T0 }), T1);
    expect(patch.invitedAt).toBeUndefined();
  });

  test('un second paiement ne deplace pas la date du premier', () => {
    const patch = projectStep(
      { step: 'payment', guildId: 'g1', metadata: { amountCents: 999 } },
      lifecycle({ firstPaidAt: T0, lifetimeCents: 999 }),
      T1,
    );
    expect(patch.firstPaidAt).toBeUndefined();
    expect(patch.lifetimeCents).toBe(1_998);
  });

  test('la provenance se pose une fois et ne bouge plus', () => {
    const already = lifecycle({ source: 'google' });
    const patch = projectStep({ step: 'bot_joined', guildId: 'g1', source: 'discord' }, already, T1);
    expect(patch.source).toBeUndefined();
  });

  test('effectif a l arrivee fige, effectif courant suivi', () => {
    const patch = projectStep(
      { step: 'bot_joined', guildId: 'g1', metadata: { memberCount: 4_200 } },
      lifecycle({ invitedAt: T0, memberCountAtInvite: 120 }),
      T1,
    );
    expect(patch.memberCountAtInvite).toBeUndefined();
    expect(patch.memberCount).toBe(4_200);
  });
});

describe('projection : depart, retour et reactivation', () => {
  test('un depart marque le churn et son motif', () => {
    const patch = projectStep({ step: 'bot_removed', guildId: 'g1' }, lifecycle(), T1);
    expect(patch.botRemovedAt).toEqual(T1);
    expect(patch.churnedAt).toEqual(T1);
    expect(patch.churnReason).toBe('BOT_REMOVED');
  });

  test('un depart ne remplace pas un churn anterieur', () => {
    // Un abonnement resilie puis un bot retire : la sortie reste datee de la
    // resiliation, sinon la duree de vie du client serait allongee a tort.
    const patch = projectStep(
      { step: 'bot_removed', guildId: 'g1' },
      lifecycle({ churnedAt: T0, churnReason: 'VOLUNTARY' }),
      T1,
    );
    expect(patch.churnedAt).toBeUndefined();
    expect(patch.churnReason).toBeUndefined();
    expect(patch.botRemovedAt).toEqual(T1);
  });

  test('un retour s incremente au lieu de creer une acquisition neuve', () => {
    const patch = projectStep({ step: 'bot_reinstalled', guildId: 'g1' }, lifecycle({ invitedAt: T0, reinstallCount: 2 }), T1);
    expect(patch.reinstallCount).toBe(3);
    expect(patch.invitedAt).toBeUndefined();
    expect(patch.botRemovedAt).toBeNull();
  });

  test('un paiement apres un depart leve le churn sans redater la premiere fois', () => {
    const patch = projectStep(
      { step: 'payment', guildId: 'g1', metadata: { amountCents: 999 } },
      lifecycle({ firstPaidAt: T0, churnedAt: T0, churnReason: 'VOLUNTARY' }),
      T1,
    );
    expect(patch.churnedAt).toBeNull();
    expect(patch.churnReason).toBeNull();
    expect(patch.firstPaidAt).toBeUndefined();
  });

  test('un impaye n est pas un churn : Stripe reessaie plusieurs jours', () => {
    const patch = projectStep({ step: 'payment_failed', guildId: 'g1' }, lifecycle(), T1);
    expect(patch.churnedAt).toBeUndefined();
  });

  test('une fin d abonnement remet le revenu recurrent a zero', () => {
    const patch = projectStep({ step: 'subscription_ended', guildId: 'g1' }, lifecycle({ mrrCents: 999 }), T1);
    expect(patch.mrrCents).toBe(0);
    expect(patch.churnReason).toBe('VOLUNTARY');
  });
});

describe('projection : parcours de configuration', () => {
  test('chaque ecran garde sa premiere visite, pas la derniere', () => {
    const patch = projectStep(
      { step: 'onboarding_step', guildId: 'g1', metadata: { step: 'tickets' } },
      lifecycle({ onboardingStartedAt: T0, onboardingSteps: { tickets: T0.toISOString() } }),
      T1,
    );
    // L'ecran a deja ete vu : un retour en arriere ne doit pas le faire
    // paraitre plus tardif dans l'entonnoir.
    expect(patch.onboardingSteps).toBeUndefined();
    expect(patch.onboardingLastStep).toBe('tickets');
  });

  test('un ecran nouveau s ajoute sans perdre les precedents', () => {
    const patch = projectStep(
      { step: 'onboarding_step', guildId: 'g1', metadata: { step: 'levels' } },
      lifecycle({ onboardingStartedAt: T0, onboardingSteps: { tickets: T0.toISOString() } }),
      T1,
    ) as { onboardingSteps: Record<string, string> };
    expect(Object.keys(patch.onboardingSteps).sort()).toEqual(['levels', 'tickets']);
  });

  test('la duree du parcours se calcule au moment ou il s acheve', () => {
    const started = new Date('2026-01-01T10:00:00.000Z');
    const done = new Date('2026-01-01T10:25:00.000Z');
    const patch = projectStep(
      { step: 'onboarding_completed', guildId: 'g1' },
      lifecycle({ onboardingStartedAt: started }),
      done,
    );
    expect(patch.onboardingSeconds).toBe(1_500);
  });

  test('une nouvelle tentative de paiement efface l abandon precedent', () => {
    const patch = projectStep({ step: 'checkout_started', guildId: 'g1' }, lifecycle({ checkoutAbandonedAt: T0 }), T1);
    expect(patch.checkoutAbandonedAt).toBeNull();
  });
});

describe('projection : etapes sans serveur', () => {
  test('l amont du tunnel ne touche pas l etat d un serveur', () => {
    const patch = projectStep({ step: 'site_visit' }, lifecycle(), T1);
    expect(Object.keys(patch)).toHaveLength(0);
  });
});
