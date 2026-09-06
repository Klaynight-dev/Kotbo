# Stripe - mise en place complète

Ce document part de zéro : aucun compte, aucun produit, aucune clé. À la fin,
un serveur Discord pourra payer un abonnement Plus, Pro ou Ultimate et voir ses
modules se débloquer tout seuls.

Prévoir **1 h 30** pour la partie test, et une deuxième session plus courte pour
le passage en production (qui attend surtout la validation de Stripe).

---

## Sommaire

1. [Comment ça marche, en une page](#1-comment-ça-marche-en-une-page)
2. [Le vocabulaire Stripe](#2-le-vocabulaire-stripe)
3. [Créer le compte](#3-créer-le-compte)
4. [Récupérer les clés d'API](#4-récupérer-les-clés-dapi)
5. [Créer les produits et les prix](#5-créer-les-produits-et-les-prix)
6. [Brancher le webhook en local](#6-brancher-le-webhook-en-local)
7. [Faire un premier paiement de test](#7-faire-un-premier-paiement-de-test)
8. [Vérifier que tout a fonctionné](#8-vérifier-que-tout-a-fonctionné)
9. [Passer en production](#9-passer-en-production)
10. [Ce qu'il reste à faire côté juridique](#10-ce-quil-reste-à-faire-côté-juridique)
11. [Exploitation courante](#11-exploitation-courante)
12. [Dépannage](#12-dépannage)

---

## 1. Comment ça marche, en une page

Le principe à retenir : **on ne touche jamais à l'argent ni aux cartes.** Kotbo
ouvre des pages hébergées par Stripe, et Stripe nous rappelle pour dire ce qui
s'est passé. C'est ce qui nous évite toute la conformité bancaire (PCI-DSS).

Le parcours complet, quand un administrateur clique sur « Passer à Pro » :

```
  Dashboard                Bot (API)                    Stripe
      │                        │                           │
      │  POST /billing/checkout│                           │
      ├───────────────────────►│                           │
      │                        │  crée une session         │
      │                        ├──────────────────────────►│
      │                        │◄──────────────────────────┤
      │      { url: ... }      │      url de paiement      │
      │◄───────────────────────┤                           │
      │                                                    │
      │  redirection du navigateur vers la page Stripe     │
      ├───────────────────────────────────────────────────►│
      │                                                    │
      │                     l'utilisateur saisit sa carte  │
      │                                                    │
      │                        │   POST /billing/webhook   │
      │                        │◄──────────────────────────┤
      │                        │   customer.subscription.* │
      │                        │                           │
      │                        │ plan = PRO                │
      │                        │ accessExpiresAt = fin de  │
      │                        │   période Stripe          │
      │                        │                           │
      │  retour sur /billing?checkout=success              │
      │◄───────────────────────────────────────────────────┤
```

Le point crucial : **c'est le webhook qui accorde l'accès, pas la redirection.**
Un utilisateur peut fermer son navigateur juste après avoir payé, ou fabriquer
une fausse URL `?checkout=success` : dans les deux cas, seul l'événement signé
reçu de Stripe modifie quoi que ce soit en base.

### Où vit quoi dans le code

| Fichier | Rôle |
|---|---|
| `packages/contracts/src/types/plans.ts` | **La grille tarifaire.** Quelles offres, quels modules dans chacune, quels prix affichés. C'est le seul fichier à modifier pour changer l'offre commerciale. |
| `apps/bot/src/services/billing/stripeService.ts` | Tout ce qui parle à l'API Stripe. Le seul fichier qui importe le paquet `stripe`. |
| `apps/bot/src/services/billing/subscriptionSync.ts` | Traduit un abonnement Stripe en état Kotbo (offre + date de fin). |
| `apps/bot/src/services/billing/trialService.ts` | L'essai gratuit : éligibilité, réservation, libération. |
| `apps/bot/src/api/hono/routes/billing.ts` | Le webhook, et les 3 routes du dashboard. |
| `apps/bot/src/services/system/planService.ts` | Lecture/écriture de l'offre d'un serveur, avec cache. |
| `apps/bot/src/services/core/moduleGate.ts` | Applique la grille : un module hors offre est éteint. |
| `apps/dashboard/src/pages/Billing.svelte` | La page vue par le client. |
| `scripts/stripe-bootstrap.ts` | Crée les produits et prix dans Stripe à partir de la grille. |

### L'essai gratuit de 15 jours

Il n'y a pas de mécanique séparée : l'essai est le parcours d'achat normal, avec
`trial_period_days: 15` sur la session de paiement. Stripe demande une carte
sans la débiter, envoie lui-même le rappel de fin d'essai imposé en Europe, et
bascule l'abonnement de `trialing` à `active` au quinzième jour. Le webhook ne
voit qu'un `customer.subscription.updated` de plus, et `trialing` fait déjà
partie des statuts qui ouvrent le service : rien de particulier à traiter.

Ce qui nous appartient en propre, c'est le **droit** à cet essai. La règle est
« une fois », avec deux sujets, tenus par deux contraintes d'unicité sur la
table `billing_trials` :

- une fois par **compte Discord** (`discordUserId`, clé primaire) - sinon il
  suffit de créer un serveur neuf à chaque fois ;
- une fois par **serveur** (`guildId`, unique) - sinon il suffit de faire
  cliquer chaque administrateur à tour de rôle.

La ligne est écrite **avant** la redirection vers Stripe : c'est elle qui
réserve l'essai, et c'est son unicité qui rend la réservation atomique, deux
clics simultanés ne pouvant pas ouvrir deux essais. Si le paiement est
abandonné, `checkout.session.expired` supprime la réservation - regarder la page
de paiement ne doit rien coûter. Une fois l'abonnement créé, la ligne porte son
identifiant et n'est plus libérable : l'essai est consommé.

Le client qui n'y a plus droit n'est pas bloqué pour autant : la route ouvre
simplement un parcours d'achat sans essai, facturé dès le premier jour.

### Les trois couches, à ne pas confondre

C'est la distinction la plus importante pour ne pas se perdre ensuite :

- **`plan`** (`planService`) - *quoi* : quels modules sont ouverts.
- **`accessExpiresAt`** (`accessService`) - *jusqu'à quand* : les rappels et la
  coupure automatique, qui existaient déjà pour les périodes d'essai.
- **Stripe** (`subscriptionSync`) - *qui a payé* : traduit les paiements en
  appels aux deux couches ci-dessus.

Aucune ne touche au domaine d'une autre. C'est ce qui permet de donner un accès
à la main (geste commercial, accord sur mesure) sans passer par Stripe.

---

## 2. Le vocabulaire Stripe

Cinq mots reviennent partout, et le sens n'est pas toujours celui qu'on imagine.

| Terme | Ce que c'est |
|---|---|
| **Product** (produit) | La chose vendue, sans prix. « Kotbo Pro ». |
| **Price** (prix) | Un montant + une périodicité, rattaché à un produit. « 7,99 € / mois ». Un produit a plusieurs prix : mensuel, annuel, promotionnel. |
| **Customer** (client) | Qui paie. Chez nous, c'est **un serveur Discord**, pas un utilisateur. |
| **Subscription** (abonnement) | Le lien vivant entre un client et un prix. C'est lui qui porte le statut (`active`, `past_due`…) et la date de fin de période. |
| **Webhook** | L'URL que Stripe appelle chez nous quand quelque chose bouge. |

Deux pièges classiques :

- **Un prix est immuable.** On ne modifie pas un tarif : on crée un nouveau prix
  et on archive l'ancien. Les abonnés en cours restent sur l'ancien prix, ce qui
  est exactement ce qu'on veut (personne ne subit une hausse sans y consentir).
- **Le mode test et le mode production sont deux mondes séparés.** Clés
  différentes, produits différents, clients différents, webhooks différents.
  Rien ne se copie automatiquement de l'un à l'autre - d'où le script de
  bootstrap.

---

## 3. Créer le compte

1. Aller sur <https://dashboard.stripe.com/register> et créer le compte avec
   l'adresse professionnelle.
2. Confirmer l'e-mail.
3. **Rester en mode test.** L'interrupteur est en haut à droite du tableau de
   bord et doit afficher « Mode test ». Tout ce qui suit dans les sections 4 à 8
   se fait en mode test.

À ce stade le compte n'est pas activé pour les paiements réels, et c'est très
bien : le mode test fonctionne intégralement sans aucune vérification d'identité.
L'activation (section 9) demandera un justificatif d'entreprise et un IBAN, et
prend quelques jours - on la lance quand tout le reste marche.

> **Sur le refus de LemonSqueezy** - Stripe n'a pas de politique équivalente sur
> les bots Discord, mais lira quand même la description de l'activité. Décrire
> Kotbo comme « logiciel SaaS d'administration de communautés en ligne, par
> abonnement mensuel » plutôt que « bot Discord » évite une révision inutile :
> c'est exact et c'est le vocabulaire que leurs équipes attendent.

---

## 4. Récupérer les clés d'API

Dans **Développeurs → Clés d'API** :

| Clé | Forme | Où elle va |
|---|---|---|
| Clé publiable | `pk_test_...` | **Nulle part.** Notre intégration ne l'utilise pas : le paiement se fait sur une page Stripe, pas dans un formulaire chez nous. |
| Clé secrète | `sk_test_...` | Dans le `.env` du bot, variable `STRIPE_SECRET_KEY`. |

Dans le fichier `.env` à la racine du monorepo :

```dotenv
STRIPE_SECRET_KEY=sk_test_51Abc...
```

> ⚠️ La clé secrète permet de débiter des cartes et de rembourser. Elle ne doit
> **jamais** être commitée, ni transmise au dashboard (qui tourne dans le
> navigateur du client). Elle reste côté bot. Si elle fuite, la révoquer
> immédiatement depuis la même page.

Redémarrer le bot. Le log doit afficher :

```
[Billing] Stripe initialisé (test).
```

Si rien ne s'affiche, ou `STRIPE_SECRET_KEY absente : facturation désactivée`,
le `.env` n'est pas lu - vérifier qu'il est bien à la racine du monorepo.

---

## 5. Créer les produits et les prix

On pourrait tout créer à la main dans l'interface, mais il faudrait le refaire
à l'identique en production, et une divergence entre les deux ne se voit qu'au
moment où un vrai client paie le mauvais montant.

Un script fait le travail à partir de `PLAN_REGISTRY` - la grille tarifaire qui
est déjà la source de vérité du code.

**D'abord, une simulation** (ne crée rien, montre juste ce qui serait fait) :

```bash
bun run stripe:bootstrap:dry
```

```
Compte Stripe : test  (simulation)

· Gratuit    - offre hors Stripe, rien à créer.
· Plus    - produit À CRÉER
    month  5,00 €  → À CRÉER
    year   30,00 € → À CRÉER
· Pro        - produit À CRÉER
    month  7,99 €  → À CRÉER
    year   76,70 € → À CRÉER
· Ultimate   - produit À CRÉER
    month  19,99 € → À CRÉER
    year   191,90 €→ À CRÉER
· Sur mesure - offre hors Stripe, rien à créer.
```

**Si les montants conviennent**, lancer pour de vrai :

```bash
bun run stripe:bootstrap
```

Le script affiche à la fin les six lignes à recopier dans le `.env` :

```dotenv
STRIPE_PRICE_PLUS_MONTHLY=price_1Mno...
STRIPE_PRICE_PLUS_YEARLY=price_1Pqr...
STRIPE_PRICE_PRO_MONTHLY=price_1Abc...
STRIPE_PRICE_PRO_YEARLY=price_1Def...
STRIPE_PRICE_ULTIMATE_MONTHLY=price_1Ghi...
STRIPE_PRICE_ULTIMATE_YEARLY=price_1Jkl...
```

Le script est **idempotent** : le relancer ne duplique rien, il retrouve ce qui
existe déjà.

### Changer les prix

Éditer `displayPriceCents` dans `packages/contracts/src/types/plans.ts`, puis
relancer le script : il créera de nouveaux prix (les anciens étant immuables) et
affichera les nouveaux identifiants à mettre dans le `.env`.

Ne pas oublier d'archiver les anciens prix dans l'interface Stripe une fois que
plus personne n'y est abonné.

### Changer quels modules sont dans quelle offre

Toujours dans `plans.ts` : `FREE_MODULES` et `PRO_CATEGORIES` en haut du fichier.
Aucune migration, aucun redéploiement de Stripe - la grille est appliquée à la
lecture. Les tests de `planRegistry.test.ts` vérifient qu'on ne casse pas les
invariants (échelle monotone, modules du cœur toujours inclus…).

---

## 6. Brancher le webhook en local

C'est l'étape où l'on se plante le plus souvent, parce que Stripe doit pouvoir
appeler une URL sur votre machine - qui n'est pas sur Internet.

### Installer la CLI Stripe

```bash
# Linux / WSL
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
  | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
  | sudo tee -a /etc/apt/sources.list.d/stripe.list
sudo apt update && sudo apt install stripe
```

```bash
stripe login   # ouvre le navigateur pour autoriser la CLI
```

### Ouvrir le tunnel

```bash
stripe listen --forward-to localhost:8787/api/billing/webhook
```

La commande affiche, **à garder** :

```
> Ready! Your webhook signing secret is whsec_1a2b3c4d...
```

Recopier dans le `.env` :

```dotenv
STRIPE_WEBHOOK_SECRET=whsec_1a2b3c4d...
```

Redémarrer le bot. **Laisser `stripe listen` tourner** dans son terminal pendant
tous les tests : c'est lui qui relaie les événements.

> Ce secret est propre à cette session `stripe listen`. Il **change** à chaque
> relancement de la commande, et il sera **différent** de celui de production.
> C'est la cause n°1 des « signature invalide ».

---

## 7. Faire un premier paiement de test

1. Ouvrir le dashboard, choisir un serveur, aller dans **Facturation**.
2. Cliquer sur **Essayer Pro 15 jours** (ou **Passer à Pro** si l'essai est
   déjà consommé pour ce compte ou ce serveur).
3. Sur la page Stripe, utiliser une carte de test :

| Carte | Comportement |
|---|---|
| `4242 4242 4242 4242` | Paiement accepté |
| `4000 0025 0000 3155` | Demande une authentification 3D Secure |
| `4000 0000 0000 9995` | Refusée pour fonds insuffisants |

Date d'expiration : n'importe quelle date future. CVC : n'importe quels 3
chiffres. Adresse : n'importe laquelle.

4. Valider. Retour automatique sur `/billing?checkout=success`.

Dans le terminal de `stripe listen`, on doit voir défiler :

```
checkout.session.completed          [evt_...]
customer.subscription.created       [evt_...]
invoice.paid                        [evt_...]
```

Et dans les logs du bot :

```
[Billing] Session de paiement cs_test_... ouverte pour 1234567890 (PRO/month, essai de 15 jours).
[Billing] Essai de 15 jours démarré pour 1234567890 (sub_...).
[Access]  Accès TRIAL accordé à 1234567890 jusqu'au 2026-09-16T...
[Billing] Serveur 1234567890 synchronisé : offre PRO, statut trialing, période jusqu'au ...
```

Le premier compte qui teste consomme son essai : le statut est `trialing` et non
`active`, la carte n'est pas débitée, et la période s'arrête dans 15 jours. Pour
tester le parcours **payant**, relancer avec un autre compte Discord - ou
supprimer la ligne de `billing_trials` (cf. § 11).

Pour vérifier la bascule de fin d'essai sans attendre quinze jours : Stripe →
l'abonnement → **Actions** → *End trial now*. L'abonnement passe en `active`,
le prélèvement a lieu, et le webhook remet l'accès à la nouvelle échéance.

---

## 8. Vérifier que tout a fonctionné

### En base

```sql
SELECT id, plan, activated, "stripeSubscriptionStatus",
       "stripeCurrentPeriodEnd", "accessExpiresAt"
FROM guilds WHERE id = 'VOTRE_GUILD_ID';
```

Attendu : `plan = 'PRO'`, `activated = true`, `stripeSubscriptionStatus =
'active'`, et `accessExpiresAt` aligné sur `stripeCurrentPeriodEnd`.

### Dans le dashboard

- La page **Facturation** affiche « Pro », le badge vert « Actif », la date de
  renouvellement, et le bouton « Gérer mon abonnement ».
- La page **Modules** : les modules Pro ne sont plus verrouillés. Les modules
  Ultimate (analytics, workflows, YouTube, Twitch, cross-serveur) le restent.

### Dans Discord

Une commande d'un module Pro (par exemple `/economy`) doit répondre. Une
commande d'un module Ultimate doit rester fermée.

### Tester la résiliation

Cliquer sur **Gérer mon abonnement** → **Annuler l'abonnement**. Vérifier que
la page affiche « Résiliation demandée - accès conservé jusqu'au … » et que le
serveur garde bien son offre jusqu'à cette date.

### Tester l'idempotence

Dans l'interface Stripe → **Développeurs → Événements**, choisir un événement
déjà traité et cliquer sur **Renvoyer**. Les logs doivent afficher :

```
[Billing] Événement evt_... déjà traité, ignoré.
```

Si l'accès est prolongé une seconde fois, c'est un bug - signaler.

---

## 9. Passer en production

À faire **seulement** quand toute la section 8 est verte en mode test.

### 9.1 Activer le compte

Dans le tableau de bord Stripe → **Activer le compte**. Il faudra :

- le SIRET et les statuts de la société (ou le statut d'auto-entrepreneur) ;
- une pièce d'identité du dirigeant ;
- un IBAN pour les virements ;
- une description de l'activité (voir l'encadré de la section 3) ;
- l'URL du site - la landing suffit, mais elle doit mentionner les tarifs, les
  CGV et un moyen de contact (voir section 10).

Compter 1 à 3 jours ouvrés.

### 9.2 Basculer en mode production

Passer l'interrupteur « Mode test » sur off, puis :

1. **Clé secrète** : Développeurs → Clés d'API → révéler la clé `sk_live_...`.
2. **Produits et prix** : relancer le bootstrap avec la clé de production.

   ```bash
   STRIPE_SECRET_KEY=sk_live_... bun run scripts/stripe-bootstrap.ts --yes
   ```

   Le `--yes` est obligatoire sur un compte de production : c'est un garde-fou
   contre un lancement par mégarde.

3. **Webhook** : Développeurs → **Webhooks** → **Ajouter un endpoint**.

   - URL : `https://api.kotbo.fr/api/billing/webhook`
     *(adapter au domaine réel de l'API du bot, pas celui du dashboard)*
   - Événements à sélectionner - **exactement ces cinq** :
     - `checkout.session.completed`
     - `checkout.session.expired`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`

     `checkout.session.expired` est celui qu'on oublie : il libère l'essai
     gratuit réservé par quelqu'un qui a ouvert la page de paiement puis fermé
     l'onglet. Sans lui, ces personnes perdent leurs 15 jours sans les avoir
     utilisés, et il faut supprimer leur ligne `billing_trials` à la main.
   - Après création, révéler le **secret de signature** (`whsec_...`).

4. **Portail client** : Paramètres → Facturation → **Portail client**. Activer
   au minimum : mise à jour du moyen de paiement, historique des factures,
   annulation de l'abonnement. Sans cette configuration, le bouton « Gérer mon
   abonnement » renvoie une erreur.

5. **TVA** : Paramètres → Impôts. Renseigner le régime de TVA et activer
   **Stripe Tax** - le code demande `automatic_tax: { enabled: true }`, et un
   compte sans configuration fiscale refusera les sessions de paiement.

### 9.3 Variables de production

```dotenv
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...        # celui de l'endpoint créé en 9.2, pas celui de stripe listen
STRIPE_PRICE_PLUS_MONTHLY=price_... # ceux affichés par le bootstrap en mode live
STRIPE_PRICE_PLUS_YEARLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_ULTIMATE_MONTHLY=price_...
STRIPE_PRICE_ULTIMATE_YEARLY=price_...
```

### 9.4 Migration de la base

```bash
bun run db:migrate:deploy
```

La migration `20260901200000_stripe_billing` ajoute les colonnes, et **bascule
tous les serveurs déjà activés en `plan = 'CUSTOM'`** - c'est-à-dire tout le
catalogue, hors Stripe. Personne ne perd d'accès le jour du déploiement, et la
grille tarifaire ne s'applique qu'aux nouveaux venus.

Il faudra ensuite décider, serveur par serveur, lesquels basculer vers une offre
payante :

```sql
UPDATE guilds SET plan = 'FREE' WHERE id = '...';
```

### 9.5 Vérification finale

Faire un vrai paiement avec une vraie carte, sur un vrai serveur, puis se
rembourser depuis l'interface Stripe. C'est le seul test qui vérifie la chaîne
complète, TVA et virement compris.

---

## 10. Ce qu'il reste à faire côté juridique

Le code est prêt ; ces points-là ne le sont pas et **bloquent** une mise en
vente réelle. Ils recoupent le chantier RGPD déjà en cours.

> ⚠️ **Réglage Stripe obligatoire, sans quoi plus aucun paiement n'aboutit.**
> Les sessions de paiement demandent désormais `consent_collection.terms_of_service`
> (voir `checkoutConsent` dans `stripeService.ts`). Stripe exige alors qu'une
> **adresse de conditions de service** soit renseignée dans le tableau de bord :
> *Réglages → Paiements → Checkout et Payment Links → Conditions de service*.
> Y mettre `https://kotbo.fr/cgv`. Sans cette adresse, `checkout.sessions.create`
> échoue et **aucun abonnement ni cadeau ne peut plus être vendu**. À faire en
> test **et** en production.

- [x] **CGV** - publiées sur `kotbo-landing/src/routes/cgv`. Couvrent le prix
      TTC, la reconduction tacite, la résiliation, la rétractation, l'essai, les
      cadeaux, les impayés et la garantie légale de conformité. Restent à
      compléter avant mise en ligne : dénomination exacte et adresse
      professionnelle.
- [x] **Droit de rétractation** - tranché : renonciation expresse à
      l'activation. La case est recueillie par Stripe
      (`consent_collection.terms_of_service: 'required'`), le texte qui la porte
      vit dans `stripeService.ts`, et la preuve est conservée en base par
      `recordBillingConsent` dans la table `billing_consents`. Une session
      encaissée sans consentement est journalisée en avertissement.
- [ ] **Résiliation en trois clics** - obligatoire en France depuis juin 2023
      pour tout abonnement souscrit en ligne. Le portail Stripe la fournit ; il
      faut vérifier que le chemin dashboard → « Gérer mon abonnement » →
      « Annuler » tient bien en trois clics.
- [ ] **Reconduction annuelle (loi Chatel)** - pour un abonnement **annuel**
      souscrit par un **consommateur**, l'article L215-1 du code de la
      consommation impose de prévenir entre trois mois et un mois avant
      l'échéance. Assuré par le cron `billing-renewal-notice`.
- [ ] **Mentions légales** - la page existe (`kotbo-landing/src/routes/mentions-legales`),
      mais elle déclare encore une édition « à titre non professionnel » sans
      SIREN, ce qui contredit les CGV. À réécrire avec SIRET 101 303 535 00021
      et TVA FR 14 101303535.
- [ ] **Médiateur de la consommation** - obligatoire dès la première vente à un
      particulier (art. L616-1). Aucun organisme désigné à ce jour ; le manque
      est signalé dans les CGV.
- [x] **Page tarifs sur la landing** - en place (`Pricing.svelte`), alignée sur
      `PLAN_REGISTRY`.
- [ ] **Politique de confidentialité** - mentionner Stripe comme sous-traitant
      (destinataire des données de facturation, transfert hors UE encadré).
- [ ] **Facturation** - Stripe génère les factures, mais leur en-tête doit
      porter la raison sociale et le numéro de TVA (Paramètres → Facturation →
      Modèle de facture).

---

## 11. Exploitation courante

### Donner un accès sans passer par Stripe

Pour un partenaire, un ami, un accord négocié :

```sql
UPDATE guilds SET plan = 'CUSTOM', activated = true WHERE id = '...';
```

Puis vider le cache (ou attendre 30 secondes, c'est le TTL). Aucun abonnement
Stripe n'est créé, rien ne sera facturé, et le serveur a tout le catalogue.

### Rendre son essai à quelqu'un

L'essai est consommé dès qu'il a démarré. Pour le rendre (geste commercial,
essai gâché par une panne de notre côté) :

```sql
DELETE FROM billing_trials WHERE "discordUserId" = '...';   -- ou "guildId" = '...'
```

La personne peut alors en rouvrir un. Attention : la contrainte porte sur les
deux colonnes, supprimer la ligne rend l'essai **et** au compte **et** au
serveur qu'elle portait.

### Changer la durée de l'essai

`TRIAL_DAYS` dans `packages/contracts/src/types/plans.ts`. La valeur n'est ni en
base ni dans le `.env` : elle est annoncée sur la page tarifs et dans les CGU,
elle doit être la même partout. Les essais **déjà en cours** ne bougent pas -
leur durée est portée par l'abonnement Stripe créé à l'époque.

### Rembourser un client

Depuis l'interface Stripe uniquement (Paiements → le paiement → Rembourser).
Si le remboursement s'accompagne d'une résiliation, l'événement
`customer.subscription.deleted` fera le reste automatiquement.

### Surveiller

- **Stripe → Développeurs → Webhooks** : le taux d'échec doit rester à 0 %.
  Stripe désactive un endpoint qui échoue trop longtemps.
- **En base** : les événements reçus.

  ```sql
  SELECT id, type, "guildId", error, "receivedAt"
  FROM billing_events ORDER BY "receivedAt" DESC LIMIT 50;
  ```

  La colonne `error` est presque toujours vide, et ce n'est pas bon signe en
  soi : un traitement en échec **supprime** sa ligne juste après, pour que le
  rejeu de Stripe ne soit pas rejeté comme un doublon. La trace d'un échec est
  donc à chercher dans les logs du bot (`Traitement de l'événement … en échec`)
  et dans l'onglet Webhooks de Stripe, pas ici.

- Les lignes sont purgées après 90 jours par le cron `billing-events-prune`.

---

## 12. Dépannage

### « Signature invalide » dans les logs, webhook en échec

Le `STRIPE_WEBHOOK_SECRET` ne correspond pas à l'endpoint qui envoie. Rappel :
celui de `stripe listen` change à chaque lancement, et celui de production est
encore différent. Recopier le bon et redémarrer le bot.

### Le paiement passe, mais l'offre ne change pas

Le webhook n'arrive pas. Vérifier dans l'ordre :

1. `stripe listen` tourne-t-il toujours (en local) ?
2. Stripe → Développeurs → Webhooks → l'endpoint est-il en erreur ? Le détail
   d'une tentative montre la réponse HTTP reçue.
3. L'URL est-elle joignable depuis l'extérieur ? Un `POST` sans signature doit
   répondre `400 Signature Stripe absente` - s'il répond `404`, le routage est
   en cause ; s'il ne répond rien, c'est le pare-feu ou le reverse proxy.

### « Aucun prix Stripe configuré pour l'offre PRO »

Une variable `STRIPE_PRICE_*` est absente ou porte un identifiant du mauvais
mode (un `price_` de test avec une clé `sk_live_`, ou l'inverse). Relancer le
bootstrap avec la bonne clé.

### Les boutons « Passer à … » n'apparaissent pas

La route renvoie `purchasable: false` quand un prix manque. Vérifier les quatre
variables. Le message « Facturation non activée sur cette instance » signifie
que `STRIPE_SECRET_KEY` est absente.

### Un serveur a payé mais l'abonnement n'est rattaché à aucune guilde

Log : `Abonnement sub_... sans serveur rattaché`. Arrive si l'abonnement a été
créé à la main dans l'interface Stripe. Correction : ajouter `guildId` dans les
métadonnées de l'abonnement côté Stripe, puis renvoyer l'événement
`customer.subscription.updated` depuis Développeurs → Événements.

### « Vous avez déjà utilisé votre essai gratuit » alors que non

La personne a ouvert une page de paiement puis fermé l'onglet, et l'événement
`checkout.session.expired` n'est pas remonté (endpoint mal configuré, ou plus de
24 h pas encore écoulées - Stripe attend l'expiration réelle de la session).
Vérifier la ligne :

```sql
SELECT * FROM billing_trials WHERE "discordUserId" = '...';
```

Une ligne dont `subscriptionId` est `NULL` est une réservation, pas un essai
consommé : la supprimer sans crainte. Une ligne avec un `subscriptionId` est un
essai réellement servi.

### Un module reste verrouillé alors que l'offre est bonne

Trois causes possibles, dans cet ordre :

1. Le cache (30 s) n'a pas expiré.
2. Le module est éteint depuis la page Modules - l'offre l'ouvre, mais un
   administrateur l'a coupé.
3. Une **dépendance** du module est hors offre : `marketplace` dépend
   d'`economy`, et la cascade éteint le dépendant. La page Modules affiche
   `blockedBy` dans ce cas.
