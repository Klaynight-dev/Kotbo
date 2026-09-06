/**
 * Crée dans Stripe les produits et les prix décrits par `PLAN_REGISTRY`.
 *
 * Créer une offre à la main dans l'interface Stripe demande une dizaine de
 * clics, et il faut le refaire à l'identique dans le compte de test *et* dans
 * celui de production. Une divergence entre les deux ne se voit qu'au moment où
 * un vrai client paie le mauvais montant. Ce script part du registre, qui est
 * déjà la source de vérité du code, et rend les deux comptes identiques.
 *
 * Idempotent : il retrouve les objets déjà créés par leurs métadonnées et les
 * réutilise. On peut le relancer sans rien dupliquer.
 *
 * Un prix Stripe est **immuable** : changer un tarif ne le modifie pas, cela en
 * crée un nouveau et archive l'ancien. Les abonnements en cours restent sur
 * l'ancien prix - c'est le comportement voulu, un client ne doit pas voir son
 * tarif augmenter sans y avoir consenti.
 *
 * Usage :
 *   STRIPE_SECRET_KEY=sk_test_... bun run scripts/stripe-bootstrap.ts
 *   STRIPE_SECRET_KEY=sk_test_... bun run scripts/stripe-bootstrap.ts --dry-run
 */

import Stripe from 'stripe';
import { PLAN_REGISTRY, type BillingInterval, type PlanDefinition } from '@kotbo/contracts';

const DRY_RUN = process.argv.includes('--dry-run');
const CURRENCY = 'eur';

const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
if (!secretKey) {
  console.error('STRIPE_SECRET_KEY manquante. Exemple :');
  console.error('  STRIPE_SECRET_KEY=sk_test_... bun run scripts/stripe-bootstrap.ts');
  process.exit(1);
}

const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
const live = secretKey.startsWith('sk_live_');

/**
 * Marqueur posé sur tout ce que ce script crée. C'est lui qui permet de
 * retrouver les objets au second passage, et de ne jamais toucher à un produit
 * créé à la main par ailleurs.
 */
const OWNER_TAG = { kotboManaged: 'true' };

async function findProduct(plan: PlanDefinition): Promise<Stripe.Product | null> {
  // `search` n'indexe qu'avec un léger décalage : après une création juste
  // avant, la liste est plus fiable.
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata?.kotboPlan === plan.key) return product;
  }
  return null;
}

async function findPrice(productId: string, interval: BillingInterval, amount: number): Promise<Stripe.Price | null> {
  for await (const price of stripe.prices.list({ product: productId, active: true, limit: 100 })) {
    if (
      price.recurring?.interval === interval &&
      price.unit_amount === amount &&
      price.currency === CURRENCY
    ) {
      return price;
    }
  }
  return null;
}

const envLines: string[] = [];

async function bootstrapPlan(plan: PlanDefinition): Promise<void> {
  if (!plan.priceEnv || !plan.displayPriceCents) {
    console.log(`· ${plan.name.padEnd(10)} - offre hors Stripe, rien à créer.`);
    return;
  }

  let product = await findProduct(plan);

  if (product) {
    console.log(`· ${plan.name.padEnd(10)} - produit existant ${product.id}`);
  } else if (DRY_RUN) {
    console.log(`· ${plan.name.padEnd(10)} - produit À CRÉER`);
    product = { id: '<dry-run>' } as Stripe.Product;
  } else {
    product = await stripe.products.create({
      name: `Kotbo ${plan.name}`,
      description: plan.description,
      metadata: { ...OWNER_TAG, kotboPlan: plan.key },
    });
    console.log(`· ${plan.name.padEnd(10)} - produit créé ${product.id}`);
  }

  for (const interval of ['month', 'year'] as BillingInterval[]) {
    const amount = plan.displayPriceCents[interval];
    const envName = plan.priceEnv[interval];

    const existing = product.id === '<dry-run>' ? null : await findPrice(product.id, interval, amount);

    if (existing) {
      console.log(`    ${interval.padEnd(5)} ${(amount / 100).toFixed(2)} €  → ${existing.id} (existant)`);
      envLines.push(`${envName}=${existing.id}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`    ${interval.padEnd(5)} ${(amount / 100).toFixed(2)} €  → À CRÉER`);
      envLines.push(`${envName}=<à créer>`);
      continue;
    }

    const price = await stripe.prices.create({
      product: product.id,
      currency: CURRENCY,
      unit_amount: amount,
      recurring: { interval },
      // Les prix sont annoncés TTC sur la page tarifs : Stripe doit déduire la
      // TVA du montant plutôt que l'ajouter par-dessus.
      tax_behavior: 'inclusive',
      metadata: { ...OWNER_TAG, kotboPlan: plan.key, kotboInterval: interval },
    });

    console.log(`    ${interval.padEnd(5)} ${(amount / 100).toFixed(2)} €  → ${price.id} (créé)`);
    envLines.push(`${envName}=${price.id}`);
  }
}

async function main(): Promise<void> {
  console.log(`\nCompte Stripe : ${live ? '⚠️  PRODUCTION' : 'test'}${DRY_RUN ? '  (simulation)' : ''}\n`);

  if (live && !DRY_RUN && !process.argv.includes('--yes')) {
    console.error('Compte de production : relancer avec --yes pour confirmer.');
    process.exit(1);
  }

  for (const plan of PLAN_REGISTRY) {
    await bootstrapPlan(plan);
  }

  console.log('\n─── À recopier dans votre .env ───\n');
  console.log(envLines.join('\n'));
  console.log('');
}

main().catch((err) => {
  console.error('\nÉchec :', err instanceof Error ? err.message : err);
  process.exit(1);
});
