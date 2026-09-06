/**
 * backfill-acquisition.ts
 *
 * Script de reprise d'historique pour le tunnel d'acquisition et les revenus.
 * Idempotent et relançable en toute sécurité avec `--dry-run`.
 *
 * Étapes :
 *   1. Factures Stripe : liste paginée des factures depuis Stripe (si configuré),
 *      rattachées aux serveurs par `stripeCustomerId` et écrites dans `billing_invoices`.
 *   2. Événements déduits : reconstitue les étapes passées (`bot_joined`,
 *      `code_activated`, `onboarding_completed`, `trial_started`, `trial_converted`,
 *      `first_payment`, `gift_redeemed`) depuis les tables existantes (`guilds`,
 *      `billing_trials`, `billing_gifts`, `billing_invoices`).
 *      Chaque événement porte `metadata.backfilled = true`.
 *   3. GuildLifecycle : initialise ou synchronise la ligne de cycle de vie pour
 *      chaque serveur présent en base (MRR normalisé, cumul encaissé, paliers).
 *   4. Instantanés quotidiens : génère les `AnalyticsDailySnapshot` rétroactifs
 *      jour par jour sur la période demandée.
 *
 * Usage :
 *   bun run scripts/backfill-acquisition.ts
 *   bun run scripts/backfill-acquisition.ts --dry-run
 *   bun run scripts/backfill-acquisition.ts --days=60
 *   bun run scripts/backfill-acquisition.ts --skip-stripe
 */

import Stripe from 'stripe';
import {
  PLAN_REGISTRY,
  getPlanDefinition,
  normalizePlanKey,
  type PlanKey,
  type BillingInterval,
} from '@kotbo/contracts';
import prisma from '../apps/bot/src/utils/db.js';
import { planForPriceId } from '../apps/bot/src/services/billing/stripeService.js';
import { writeDailySnapshot, dateKeyFor } from '../apps/bot/src/services/analytics/acquisitionSnapshotService.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_STRIPE = process.argv.includes('--skip-stripe');
const DAYS_ARG = process.argv.find((a) => a.startsWith('--days='));
const DAYS_COUNT = DAYS_ARG ? Math.max(1, Number.parseInt(DAYS_ARG.split('=')[1], 10)) : 90;

console.log('═'.repeat(70));
console.log(`🚀 REPRISE D'HISTORIQUE ACQUISITION & REVENUS ${DRY_RUN ? '(MODE SIMULATION --dry-run)' : ''}`);
console.log(`📅 Fenêtre d'instantanés : ${DAYS_COUNT} derniers jours`);
console.log('═'.repeat(70));

async function main() {
  const startedAt = Date.now();

  // ─────────────────────────────────────────────────────────────
  // 1. Factures Stripe
  // ─────────────────────────────────────────────────────────────
  console.log('\n📦 Étape 1/4 : Synchronisation des factures Stripe...');
  let stripeInvoicesCount = 0;
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (SKIP_STRIPE || !stripeKey) {
    console.log('   ℹ️ Facturation Stripe ignorée ou STRIPE_SECRET_KEY absente.');
  } else {
    try {
      const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() });
      const customerGuildMap = new Map<string, string>();

      // Charger tous les serveurs ayant un stripeCustomerId
      const guildsWithStripe = await prisma.guild.findMany({
        where: { stripeCustomerId: { not: null } },
        select: { id: true, stripeCustomerId: true },
      });
      for (const g of guildsWithStripe) {
        if (g.stripeCustomerId) customerGuildMap.set(g.stripeCustomerId, g.id);
      }

      console.log(`   Recherche de factures pour ${customerGuildMap.size} clients Stripe identifiés...`);
      let hasMore = true;
      let startingAfter: string | undefined = undefined;

      while (hasMore) {
        const list = await stripe.invoices.list({
          limit: 100,
          starting_after: startingAfter,
        });

        for (const invoice of list.data) {
          stripeInvoicesCount++;
          const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
          const guildId = customerId ? customerGuildMap.get(customerId) ?? null : null;

          // Résoudre le plan et l'intervalle
          let planKey: PlanKey = 'PRO';
          let intervalKey: BillingInterval = 'month';
          const lineItem = invoice.lines.data[0];
          const priceId = lineItem?.price?.id;
          if (priceId) {
            const mapped = planForPriceId(priceId);
            if (mapped) {
              planKey = mapped.plan;
              intervalKey = mapped.interval;
            }
          }

          const record = {
            id: invoice.id,
            guildId,
            customerId,
            subscriptionId: typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id ?? null,
            plan: planKey,
            interval: intervalKey,
            status: invoice.status ?? 'draft',
            currency: invoice.currency ?? 'eur',
            subtotalCents: invoice.subtotal ?? 0,
            discountCents: invoice.total_discount_amounts?.reduce((a, b) => a + b.amount, 0) ?? 0,
            taxCents: invoice.tax ?? 0,
            totalCents: invoice.total ?? 0,
            amountPaidCents: invoice.amount_paid ?? 0,
            amountRefundedCents: (invoice as unknown as { amount_refunded?: number }).amount_refunded ?? 0,
            periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
            periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
            issuedAt: new Date(invoice.created * 1000),
            paidAt: invoice.status === 'paid' ? new Date(invoice.created * 1000) : null,
            ingestedBy: 'backfill',
          };

          if (!DRY_RUN) {
            await prisma.billingInvoice.upsert({
              where: { id: record.id },
              update: record,
              create: record,
            });
          }
        }

        hasMore = list.has_more;
        if (hasMore && list.data.length > 0) {
          startingAfter = list.data[list.data.length - 1].id;
        }
      }

      console.log(`   ✅ ${stripeInvoicesCount} factures Stripe traitées.`);
    } catch (err) {
      console.warn('   ⚠️ Erreur lors de la synchronisation Stripe (reprise continue sans Stripe) :', err);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Événements déduits (AcquisitionEvent)
  // ─────────────────────────────────────────────────────────────
  console.log('\n📜 Étape 2/4 : Déduction des événements du tunnel...');
  let eventsCount = 0;

  // A. Arrivées de serveurs (bot_joined)
  const allGuilds = await prisma.guild.findMany({
    select: {
      id: true,
      createdAt: true,
      activated: true,
      activatedAt: true,
      activatedViaStaffLink: true,
      onboardingCompletedAt: true,
      plan: true,
      stripeSubscriptionStatus: true,
    },
  });

  for (const g of allGuilds) {
    if (g.createdAt) {
      const eventId = `bf:joined:${g.id}`;
      eventsCount++;
      if (!DRY_RUN) {
        await prisma.acquisitionEvent.upsert({
          where: { id: eventId },
          update: {},
          create: {
            id: eventId,
            step: 'bot_joined',
            guildId: g.id,
            source: 'historic',
            occurredAt: g.createdAt,
            metadata: { backfilled: true },
          },
        }).catch(() => null);
      }
    }

    // B. Activation par code ou staff
    if (g.activatedAt || g.activatedViaStaffLink) {
      const eventId = `bf:activated:${g.id}`;
      eventsCount++;
      if (!DRY_RUN) {
        await prisma.acquisitionEvent.upsert({
          where: { id: eventId },
          update: {},
          create: {
            id: eventId,
            step: 'code_activated',
            guildId: g.id,
            source: g.activatedViaStaffLink ? 'staff_link' : 'code',
            occurredAt: g.activatedAt ?? g.createdAt ?? new Date(),
            metadata: { backfilled: true },
          },
        }).catch(() => null);
      }
    }

    // C. Fin d'onboarding
    if (g.onboardingCompletedAt) {
      const eventId = `bf:onboarded:${g.id}`;
      eventsCount++;
      if (!DRY_RUN) {
        await prisma.acquisitionEvent.upsert({
          where: { id: eventId },
          update: {},
          create: {
            id: eventId,
            step: 'onboarding_completed',
            guildId: g.id,
            occurredAt: g.onboardingCompletedAt,
            metadata: { backfilled: true },
          },
        }).catch(() => null);
      }
    }
  }

  // D. Essais gratuits (BillingTrial)
  const trials = await prisma.billingTrial.findMany().catch(() => []);
  for (const t of trials) {
    const startId = `bf:trial_start:${t.id}`;
    eventsCount++;
    if (!DRY_RUN) {
      await prisma.acquisitionEvent.upsert({
        where: { id: startId },
        update: {},
        create: {
          id: startId,
          step: 'trial_started',
          guildId: t.guildId,
          occurredAt: t.reservedAt,
          metadata: { backfilled: true, plan: t.plan },
        },
      }).catch(() => null);

      if (t.consumedAt) {
        const convId = `bf:trial_conv:${t.id}`;
        eventsCount++;
        await prisma.acquisitionEvent.upsert({
          where: { id: convId },
          update: {},
          create: {
            id: convId,
            step: 'trial_converted',
            guildId: t.guildId,
            occurredAt: t.consumedAt,
            metadata: { backfilled: true, plan: t.plan },
          },
        }).catch(() => null);
      }
    }
  }

  // E. Cadeaux activés (BillingGift)
  const gifts = await prisma.billingGift.findMany().catch(() => []);
  for (const gift of gifts) {
    if (gift.appliedAt && gift.targetGuildId) {
      const giftId = `bf:gift:${gift.id}`;
      eventsCount++;
      if (!DRY_RUN) {
        await prisma.acquisitionEvent.upsert({
          where: { id: giftId },
          update: {},
          create: {
            id: giftId,
            step: 'gift_redeemed',
            guildId: gift.targetGuildId,
            occurredAt: gift.appliedAt,
            metadata: { backfilled: true, plan: gift.plan, months: gift.months },
          },
        }).catch(() => null);
      }
    }
  }

  console.log(`   ✅ ${eventsCount} événements reconstitués ou confirmés.`);

  // ─────────────────────────────────────────────────────────────
  // 3. GuildLifecycle
  // ─────────────────────────────────────────────────────────────
  console.log('\n🏰 Étape 3/4 : Initialisation et mise à jour des cycles de vie (GuildLifecycle)...');
  let lifecyclesCount = 0;

  for (const g of allGuilds) {
    lifecyclesCount++;
    const planKey = normalizePlanKey(g.plan);
    const def = getPlanDefinition(planKey);

    // Calculer le MRR estimé
    let mrrCents = 0;
    if (planKey !== 'FREE' && def.displayPriceCents) {
      mrrCents = def.displayPriceCents.month;
    }

    // Calculer l'historique d'encaissement et premier paiement
    const firstInvoice = await prisma.billingInvoice.findFirst({
      where: { guildId: g.id, status: 'paid' },
      orderBy: { paidAt: 'asc' },
    }).catch(() => null);

    const paidInvoices = await prisma.billingInvoice.findMany({
      where: { guildId: g.id, status: 'paid' },
      select: { amountPaidCents: true },
    }).catch(() => []);
    const lifetimeCents = paidInvoices.reduce((acc, inv) => acc + inv.amountPaidCents, 0);

    const isChurned = !g.activated && planKey === 'FREE' && lifetimeCents > 0;

    const record = {
      guildId: g.id,
      source: g.activatedViaStaffLink ? 'staff_link' : 'historic',
      activationOrigin: g.activatedViaStaffLink ? 'STAFF_LINK' : 'ORGANIC',
      invitedAt: g.createdAt,
      onboardingCompletedAt: g.onboardingCompletedAt,
      firstPaidAt: firstInvoice?.paidAt ?? null,
      plan: planKey,
      mrrCents: isChurned ? 0 : mrrCents,
      lifetimeCents,
      churnedAt: isChurned ? new Date() : null,
      churnReason: isChurned ? 'historic_deactivation' : null,
      updatedAt: new Date(),
    };

    if (!DRY_RUN) {
      await prisma.guildLifecycle.upsert({
        where: { guildId: g.id },
        update: record,
        create: record,
      });
    }
  }

  console.log(`   ✅ ${lifecyclesCount} serveurs synchronisés dans GuildLifecycle.`);

  // ─────────────────────────────────────────────────────────────
  // 4. Instantanés quotidiens (AnalyticsDailySnapshot)
  // ─────────────────────────────────────────────────────────────
  console.log('\n📊 Étape 4/4 : Génération des instantanés quotidiens...');
  let snapshotsDaysCount = 0;
  const now = new Date();

  for (let i = DAYS_COUNT; i >= 1; i--) {
    const targetDate = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const dateKey = dateKeyFor(targetDate);
    snapshotsDaysCount++;

    if (!DRY_RUN) {
      try {
        await writeDailySnapshot(dateKey);
      } catch (err) {
        console.warn(`   ⚠️ Échec de génération de l'instantané du ${dateKey}:`, err);
      }
    }
  }

  console.log(`   ✅ ${snapshotsDaysCount} journées d'instantanés générées.`);

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n' + '═'.repeat(70));
  console.log(`🎉 REPRISE TERMINÉE EN ${durationSec}s !`);
  console.log(`   • Factures Stripe : ${stripeInvoicesCount}`);
  console.log(`   • Événements déduits : ${eventsCount}`);
  console.log(`   • Cycles de vie synchronisés : ${lifecyclesCount}`);
  console.log(`   • Jours d'instantanés : ${snapshotsDaysCount}`);
  console.log('═'.repeat(70));
}

main()
  .catch((err) => {
    console.error('\n❌ Erreur fatale durant la reprise d\'historique :', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
