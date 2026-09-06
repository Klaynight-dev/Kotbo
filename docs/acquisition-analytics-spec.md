# Tunnel d'acquisition et statistiques commerciales

Spécification du chantier « `/admin/analytics` » : mesurer d'où viennent les
serveurs, où ils décrochent, ce qu'ils paient, pourquoi ils partent — et relier
tout ça à ce qu'ils font réellement du produit.

Statut : **spécification, à valider avant développement.**
Périmètre : dépôt `Kotbo` (bot + dashboard + base) et dépôt `kotbo-landing`.

---

## 1. Ce qui existe, et pourquoi ça ne suffit pas

| Donnée | Où | Ce qu'elle permet | Ce qui manque |
| --- | --- | --- | --- |
| `Guild.createdAt`, `activatedAt`, `onboardingCompletedAt` | `guild.prisma` | Savoir *où en est* un serveur | Pas *quand* ni *comment* il y est arrivé ; écrasé au re-passage |
| `Guild.plan`, `stripe*`, `accessExpiresAt` | `guild.prisma` | L'état commercial courant | Aucun historique : un serveur passé de PRO à FREE ne laisse aucune trace |
| `BillingTrial`, `BillingGift` | `billing.prisma` | Essais et cadeaux | Pas les abandons de checkout hors essai |
| `BillingEvent` | `billing.prisma` | Webhooks bruts, purgés à 3 jours | Ni montants exploitables, ni historique |
| `ModuleActivationStat` / `UsageStat` | `analytics.prisma` | Modules allumés et utilisés | Jamais croisés avec le plan ni la rétention |
| `GuildDailyStat` | `analytics.prisma` | Activité par serveur et par jour | Jamais croisé avec le paiement |
| `logger.info` dans `GuildDelete` | `apps/bot/src/index.ts:612` | Rien de requêtable | **Aucun churn mesurable** |
| `?utm_source=` sur `/api/public/invite` | `routes/public/invite.ts:113` | Un log texte | Le commentaire du fichier annonce déjà « en attente de la table du tunnel d'acquisition » |

Trois trous structurants : **pas d'historique**, **pas de montants réels**,
**pas de churn**. Tout le reste en découle.

> ⚠️ `services/analytics/inviteService.ts` est un homonyme : il gère les
> invitations *de membres dans un serveur Discord*, pas l'acquisition de
> serveurs par Kotbo. Ne pas y ajouter le tunnel commercial.

---

## 2. Décisions arrêtées

| Sujet | Décision |
| --- | --- |
| Historique | Journal d'événements **et** snapshot quotidien agrégé |
| Chiffre d'affaires | Stripe réel, mis en cache dans une table locale |
| Tunnel | De la visite du site jusqu'au churn, étapes d'onboarding comprises |
| Provenance | Paramètre de campagne sur les liens **et** événements depuis la landing |
| Emplacement | Une page `/admin/analytics` à quatre onglets |
| Backfill | Maximal : factures Stripe + reconstruction depuis l'état actuel |
| Rétention | Événements détaillés 13 mois, agrégats à vie, anonymisation au départ |
| Méthode | Spec d'abord, puis développement en commits successifs |

---

## 3. Modèle de données

Cinq nouveaux modèles, dans un fichier `packages/database/prisma/acquisition.prisma`.

### 3.1 `AcquisitionEvent` — le journal du tunnel

Une ligne par franchissement d'étape. C'est la seule table à fort volume.

```prisma
model AcquisitionEvent {
  id String @id @default(cuid())

  /// Étape franchie. Valeurs closes, cf. ACQUISITION_STEPS (@kotbo/contracts).
  step String

  /// Serveur concerné. Null avant que le bot ne soit posé : une visite du site
  /// et un clic sur « Ajouter » n'ont pas encore de serveur.
  guildId String?

  /// Personne, pseudonymisée : HMAC-SHA256 du discordUserId avec un secret
  /// d'instance. Jamais l'identifiant en clair - il suffit à compter les
  /// parcours distincts et à recoller les étapes d'une même personne, sans
  /// constituer un fichier d'utilisateurs identifiés.
  actorHash String?

  /// Visiteur anonyme, le temps de sa session. Seul moyen de relier « a vu les
  /// tarifs » à « a posé le bot » avant qu'un serveur n'existe. Purgé à 30 j.
  visitorId String?

  /// Provenance et campagne, telles que normalisées par l'API publique.
  source   String?
  campaign String?
  /// Emplacement précis du clic sur la landing (hero, pricing, faq, footer…).
  content  String?

  /// Contexte de l'étape : étape d'onboarding visée, plan, périodicité,
  /// montant, motif de départ. Jamais de contenu Discord.
  metadata Json?

  occurredAt DateTime @default(now())

  @@index([step, occurredAt])
  @@index([guildId, occurredAt])
  @@index([visitorId])
  @@index([occurredAt])
  @@map("acquisition_events")
}
```

**Pas de relation vers `Guild`.** Toutes les relations de `Guild` sont en
`onDelete: Cascade` : brancher le journal dessus effacerait le churn au moment
précis où il devient intéressant. Le `guildId` reste une colonne libre.

### 3.2 `GuildLifecycle` — l'état du parcours, un serveur par ligne

Dérivé du journal, mis à jour à chaque événement. Sans lui, chaque cohorte
rescanne tout le journal ; avec lui, l'explorateur de serveurs est une seule
requête. Il survit à la purge des événements à 13 mois.

```prisma
model GuildLifecycle {
  guildId String @id

  // ── Provenance ────────────────────────────────────────────────────────────
  source   String?
  campaign String?
  content  String?
  /// Provenance de l'activation : SELF_SERVE | CODE | STAFF_LINK | GIFT | ADMIN
  activationOrigin String?
  instanceId String?          // white-label

  // ── Horodatage du tunnel ──────────────────────────────────────────────────
  invitedAt              DateTime?
  dashboardFirstOpenedAt DateTime?
  onboardingStartedAt    DateTime?
  onboardingCompletedAt  DateTime?
  /// Dernière étape atteinte, et toutes celles vues avec leur horodatage.
  onboardingLastStep     String?
  onboardingSteps        Json?
  /// Temps total passé dans le parcours, en secondes.
  onboardingSeconds      Int?

  pricingViewedAt   DateTime?
  checkoutStartedAt DateTime?
  checkoutAbandonedAt DateTime?
  trialStartedAt    DateTime?
  trialEndsAt       DateTime?
  trialConvertedAt  DateTime?
  firstPaidAt       DateTime?

  // ── État commercial courant ───────────────────────────────────────────────
  plan     String  @default("FREE")
  interval String?
  /// MRR normalisé en centimes (un annuel est ramené au mois).
  mrrCents Int     @default(0)
  /// Total réellement encaissé depuis le début, en centimes.
  lifetimeCents Int @default(0)

  // ── Sortie ────────────────────────────────────────────────────────────────
  churnedAt    DateTime?
  /// VOLUNTARY | PAYMENT_FAILED | TRIAL_EXPIRED | BOT_REMOVED | DOWNGRADE
  churnReason  String?
  botRemovedAt DateTime?
  /// Un serveur qui remet le bot après l'avoir retiré : compté, pas écrasé.
  reinstallCount Int @default(0)

  // ── Segmentation ──────────────────────────────────────────────────────────
  /// Effectif au moment de l'arrivée et effectif courant : le palier tarifaire
  /// se lit sur le second, la cohorte sur le premier.
  memberCountAtInvite Int?
  memberCount         Int?
  /// Type de communauté déclaré à l'étape Kind, pistes de l'étape Tracks.
  serverKind String?
  tracks     String[] @default([])
  locale     String?
  timezone   String?

  updatedAt DateTime @updatedAt

  @@index([plan, churnedAt])
  @@index([source])
  @@index([firstPaidAt])
  @@index([churnedAt])
  @@map("guild_lifecycles")
}
```

### 3.3 `BillingInvoice` — le chiffre d'affaires réel

```prisma
model BillingInvoice {
  /// `in_...` de Stripe : l'identité vient de Stripe, la reprise est idempotente.
  id String @id

  guildId        String?
  customerId     String?
  subscriptionId String?

  plan     String
  interval String?
  /// paid | open | void | uncollectible | draft
  status   String

  currency          String @default("eur")
  subtotalCents     Int    @default(0)
  discountCents     Int    @default(0)
  taxCents          Int    @default(0)
  totalCents        Int    @default(0)
  amountPaidCents   Int    @default(0)
  amountRefundedCents Int  @default(0)

  periodStart DateTime?
  periodEnd   DateTime?
  issuedAt    DateTime
  paidAt      DateTime?

  /// Trace de reprise : distingue une ligne posée par le webhook d'une ligne
  /// rattrapée par le backfill, quand les deux se recouvrent.
  ingestedBy String @default("webhook")

  @@index([guildId, issuedAt])
  @@index([issuedAt])
  @@index([status])
  @@map("billing_invoices")
}
```

Les cadeaux (`BillingGift.amountCents`, source `PURCHASE_*`) sont un revenu
ponctuel : ils entrent dans le CA encaissé mais **jamais dans le MRR**, qui est
récurrent par définition. Un cadeau `ADMIN` vaut 0 €.

### 3.4 `AnalyticsDailySnapshot` — l'agrégat à vie

Une table plutôt qu'une par axe : ajouter un axe de segmentation ne demande
alors aucune migration.

```prisma
model AnalyticsDailySnapshot {
  id      String @id @default(cuid())
  dateKey String                      // YYYY-MM-DD, fuseau Europe/Paris

  /// global | plan | size | source | origin | kind | instance | locale | interval
  dimension String
  /// Valeur dans cette dimension ('PRO', '1k-10k', 'landing'…). '' pour global.
  bucket    String

  /// Tous les compteurs du jour pour ce découpage. Cf. §6.
  metrics Json

  createdAt DateTime @default(now())

  @@unique([dateKey, dimension, bucket])
  @@index([dimension, dateKey])
  @@map("analytics_daily_snapshots")
}
```

### 3.5 `AcquisitionAlertState` — mémoire des alertes

Évite qu'une alerte se répète à chaque passage du cron.

```prisma
model AcquisitionAlertState {
  key         String   @id     // 'churn-rate', 'past-due:<guildId>'…
  lastFiredAt DateTime
  lastValue   Float?
  @@map("acquisition_alert_states")
}
```

---

## 4. Catalogue des étapes

Défini dans `packages/contracts/src/types/acquisition.ts`, importé par le bot,
le dashboard et la landing. Liste close : une valeur inconnue est rejetée à
l'entrée de l'API.

### Amont (pas encore de serveur)

| Étape | Déclencheur | Posé par |
| --- | --- | --- |
| `site_visit` | Première page de kotbo.fr dans la session (`metadata.referrer`, `metadata.path`) | Landing |
| `pricing_viewed` | Section tarifs réellement affichée à l'écran | Landing |
| `comparison_viewed` | Section comparatif affichée | Landing |
| `faq_opened` | Ouverture d'une question | Landing |
| `sales_clicked` | Clic sur « Prendre rendez-vous » | Landing |
| `invite_clicked` | Clic sur un bouton d'invitation | Landing |
| `invite_redirected` | Passage par `/api/public/invite` | Bot |
| `dashboard_servers_seen` | Arrivée sur `/servers` avec un `utm_source` | Dashboard |
| `discord_authorize_opened` | Départ vers l'écran d'autorisation Discord | Dashboard |

### Installation et prise en main

| Étape | Déclencheur | Posé par |
| --- | --- | --- |
| `bot_joined` | `Events.GuildCreate` | Bot |
| `dashboard_first_open` | Premier chargement du dashboard pour ce serveur | Bot (API) |
| `onboarding_started` | Première étape validée | Dashboard → API |
| `onboarding_step` | Chaque étape validée (`metadata.step`) | Dashboard → API |
| `onboarding_back` | Retour arrière (indique une étape mal comprise) | Dashboard → API |
| `onboarding_abandoned` | 72 h sans progression, parcours non terminé | Cron |
| `onboarding_completed` | `onboardingCompletedAt` posé | Bot |

Les ~22 étapes du parcours sont celles de `WIZARD_STEPS` (welcome, kind,
migration-bots, migration-findings, tracks, identity, theme, tickets, structure,
moderation, logs, staff, greeting, rules, levels, economy, economy-shop, quests,
drops, mcp, recap, checkout). Le parcours étant à embranchements, un taux
d'abandon se calcule **sur les serveurs pour qui l'étape était au programme**,
pas sur tous — sinon une étape sautée par construction ressort comme un
décrochage.

### Paiement

| Étape | Déclencheur | Posé par |
| --- | --- | --- |
| `plan_viewed` | Ouverture de la page Facturation ou de l'étape checkout | Dashboard → API |
| `checkout_started` | Session Stripe créée (`metadata.plan`, `interval`) | Bot |
| `checkout_abandoned` | `checkout.session.expired` | Webhook |
| `trial_reserved` | Ligne `BillingTrial` posée | Bot |
| `trial_started` | Stripe confirme `trialing` | Webhook |
| `trial_converted` | Passage `trialing` → `active` | Webhook |
| `trial_expired` | Fin d'essai sans paiement | Webhook / cron |
| `first_payment` | Première `invoice.paid` du serveur | Webhook |
| `payment` | Toute `invoice.paid` suivante | Webhook |
| `payment_failed` | `invoice.payment_failed` | Webhook |
| `plan_upgraded` / `plan_downgraded` | Changement de palier | `planService` |
| `gift_redeemed` | Cadeau activé | Bot |
| `code_activated` | Code d'activation consommé | Bot |

### Sortie

| Étape | Déclencheur | Posé par |
| --- | --- | --- |
| `cancel_scheduled` | `cancel_at_period_end` passe à vrai | Webhook |
| `cancel_reverted` | La résiliation est annulée | Webhook |
| `subscription_ended` | `customer.subscription.deleted` | Webhook |
| `access_expired` | `accessExpiresAt` dépassé | Cron `access-lifecycle` |
| `bot_removed` | `Events.GuildDelete` | Bot |
| `bot_reinstalled` | `GuildCreate` sur un serveur déjà connu | Bot |

---

## 5. Points d'instrumentation

Un helper unique, `services/analytics/acquisitionService.ts`, expose
`recordAcquisitionStep()`. Il ne jette **jamais** : une statistique perdue ne
doit pas faire échouer un paiement ni une arrivée sur un serveur. Écriture en
tâche de fond (`void`), jamais dans le chemin critique.

| Fichier | Intervention |
| --- | --- |
| `apps/bot/src/index.ts:554` (`GuildCreate`) | `bot_joined` / `bot_reinstalled`, effectif à l'arrivée, rattachement du `visitorId` |
| `apps/bot/src/index.ts:612` (`GuildDelete`) | `bot_removed` + `GuildLifecycle.botRemovedAt` — aujourd'hui un simple `logger.info` |
| `api/hono/routes/public/invite.ts:113` | `invite_redirected`, remplace le `logger.info` que le fichier annonce comme provisoire ; élargir `KNOWN_SOURCES` |
| `api/hono/routes/public/funnel.ts` | **Nouveau** : point d'entrée des événements de la landing (§7) |
| `api/hono/routes/billing.ts:170-210` | `checkout_*`, `trial_*`, `payment*`, `cancel_*`, `subscription_ended` + écriture `BillingInvoice` sur `invoice.paid` / `invoice.payment_failed` |
| `services/system/planService.ts` | `plan_upgraded` / `plan_downgraded`, recalcul du MRR |
| `services/system/accessService.ts` | `access_expired`, `trial_expired` |
| `services/billing/giftService.ts` | `gift_redeemed` |
| `utils/activation.ts` | `code_activated`, `activationOrigin` |
| `api/routes/dashboard/general.ts` | `onboarding_started`, `onboarding_step`, `onboarding_back`, `onboarding_completed` — le point d'écriture de `onboardingState` existe déjà |
| `pages/Servers.svelte` (dashboard) | `dashboard_servers_seen`, conservation du `utm_source` jusqu'à l'autorisation |
| `events/crons.ts` | Quatre tâches nouvelles (§8) |

---

## 6. Formules

Toutes en centimes, fuseau `Europe/Paris`, jour = `dateKey`.

**MRR** — somme sur les serveurs payants actifs de :
`interval === 'year' ? round(totalCents / 12) : totalCents`, où `totalCents` est
le dernier montant **réellement facturé** (`BillingInvoice`), pas le tarif
affiché. Un serveur `CUSTOM` sans facture pèse 0 et est compté à part, jamais
noyé dans la moyenne.

**ARR** = MRR × 12. **ARPA** = MRR ÷ nombre de serveurs payants.

**Décomposition du MRR** sur un mois M :
```
MRR(M) = MRR(M-1) + nouveau + expansion − contraction − churn + réactivation
```
- *nouveau* : premier paiement dans le mois
- *expansion* : PRO → ULTIMATE, ou mensuel → annuel
- *contraction* : l'inverse
- *churn* : MRR des serveurs dont l'abonnement s'est terminé
- *réactivation* : serveur déjà churné qui repaie

L'écart résiduel entre les deux membres est affiché tel quel : le masquer
reviendrait à maquiller une erreur de calcul.

**Churn serveurs (mensuel)** = serveurs churnés dans M ÷ serveurs payants au
début de M.
**Churn revenu** = MRR perdu ÷ MRR au début de M.
**NRR** = (MRR début + expansion − contraction − churn) ÷ MRR début, sur la
cohorte présente au début.
**Durée de vie moyenne** = 1 ÷ churn mensuel (mois).
**LTV** = ARPA × durée de vie. Affichée avec sa marge d'incertitude tant que
moins de 12 mois d'historique : une LTV calculée sur trois mois de données est
un chiffre inventé, elle est étiquetée comme telle.

**Conversion du tunnel** — chaque étape rapportée à l'étape précédente **et** au
sommet, avec le délai médian. La cohorte est celle des serveurs arrivés dans la
période, suivis jusqu'à aujourd'hui : compter les conversions d'un mois sur les
arrivées du même mois écrase mécaniquement les mois récents.

**Rétention par cohorte** — matrice mois d'arrivée × mois écoulés, en % de
serveurs encore payants. Les mois incomplets sont grisés, jamais extrapolés.

**Modules corrélés à la conversion** — pour chaque module, taux de conversion
des serveurs qui l'ont activé pendant l'essai contre ceux qui ne l'ont pas fait,
avec l'effectif. En dessous de 30 serveurs dans un groupe, le chiffre est affiché
en gris avec la mention « échantillon trop faible » plutôt que masqué : on ne
cache pas un signal, on refuse juste de le lire comme une preuve.

---

## 7. Landing — modifications

Dépôt `kotbo-landing`, branche `feat/tunnel-acquisition` (déjà en cours).

**7.1 Liens d'invitation qualifiés.** Aujourd'hui `+page.svelte:35` porte une
seule constante `?utm_source=landing`, partagée par les cinq boutons de la page.
On ne sait donc pas lequel convertit. Remplacer par un helper
`inviteUrl(content)` produisant `?utm_source=landing&utm_content=<hero|pricing|
comparison|trial-cta|header>&vid=<visitorId>`, propagé aux props des composants
`Modules`, `Comparison`, `Pricing`, `TrialCta`.

**7.2 Provenances : classer le référent, pas seulement la campagne.** Kotbo
n'est diffusé aujourd'hui que par deux canaux : **Discord** et la **recherche
Google**. Or `utm_source=landing` dit seulement qu'on vient du site — pas
comment on est arrivé sur le site. Les deux canaux réels sont donc invisibles
avec le seul paramètre de campagne.

La mesure se fait en deux temps :

- **À la première visite**, la landing classe `document.referrer` en un canal :
  `google`, `bing`, `duckduckgo`, `discord`, `internal`, `direct`, `other`.
  Seule cette *catégorie* est envoyée, jamais l'URL référente complète — qui
  peut contenir la requête tapée, donc une donnée personnelle. C'est ce champ
  qui répond à « combien viennent de Google ».
- **Au clic d'invitation**, `utm_source` continue de dire quelle surface a
  produit le clic (`landing`, `discord`, `docs`, `dashboard`), et
  `utm_content` quel bouton.

`KNOWN_SOURCES` (`invite.ts:88`) garde donc ses cinq valeurs actuelles : rien à
ajouter tant qu'aucun autre canal n'est ouvert. Le mécanisme reste extensible —
une liste close, `other` en repli — pour le jour où Top.gg, un partenariat ou un
réseau social entre en jeu. On ne code pas aujourd'hui des provenances qui
n'existent pas.

`GuildLifecycle.source` retient le canal d'entrée (`google`, `discord`…) et
`content` le bouton : la question « qu'est-ce qui rapporte des serveurs qui
paient » se lit alors directement dans l'onglet Segments.

> Le détail des requêtes Google (impressions, position, mots-clés) ne peut pas
> venir de nos données : il n'existe que dans la Search Console. Un import via
> son API est possible plus tard ; il n'est pas dans ce chantier.

**7.3 Identifiant de visite.** UUID posé en `sessionStorage` (pas `localStorage`,
pas de cookie), transmis dans l'URL d'invitation, conservé 30 jours côté serveur
puis purgé. C'est lui qui relie « a lu les tarifs » à « a posé le bot ».

**7.4 Sonde d'événements.** `navigator.sendBeacon` vers
`POST https://api.kotbo.fr/api/public/funnel`, sur : première vue, section tarifs
visible, comparatif visible, FAQ ouverte, clic invite, clic rendez-vous.
L'`IntersectionObserver` est déjà en place (`lib/actions/reveal.ts`) : on
réutilise le mécanisme plutôt que d'en ajouter un second. Aucune bibliothèque
tierce, aucun script externe, pas de collecte d'IP ni d'`User-Agent` détaillé.

**7.5 Preuve sociale enrichie.** `/api/public/stats` alimente déjà les chiffres
du site. On peut y ajouter, sans rien exposer de nominatif, le nombre de
serveurs équipés ce mois-ci et le total de membres couverts — des chiffres qui
montent tout seuls et que la page affiche déjà à moitié.

**7.6 Régime juridique retenu : exemption de consentement.**
`src/routes/cookies/+page.svelte:30` affirme aujourd'hui : « Aucune bannière de
consentement nécessaire — Kotbo n'utilise aucun outil de mesure d'audience
web. » La sonde rend cette phrase fausse : la page doit être réécrite.

La mesure est conçue pour rester dans l'exemption prévue par la CNIL pour la
mesure d'audience (art. 82 LIL, lignes directrices cookies). Les conditions à
tenir, qui sont donc des **contraintes d'implémentation** et pas des intentions :

| Condition | Comment elle est tenue |
| --- | --- |
| Finalité strictement limitée à la mesure interne | Aucun usage publicitaire, aucun profilage, aucune personnalisation |
| Pas de transmission à un tiers | Sonde maison vers `api.kotbo.fr`, aucun script externe, aucun CDN tiers |
| Pas de suivi inter-sites | Identifiant first-party, jamais partagé, jamais lu ailleurs |
| Portée limitée à un seul site | `sessionStorage`, purge serveur à 30 jours |
| Pas de recoupement avec d'autres traitements | Le `visitorId` n'est jamais rapproché d'un compte Discord |
| IP non conservée | Non journalisée par la route publique, pas même tronquée |
| Information et opposition | Pages `/cookies` et `/privacy` réécrites, mécanisme d'opposition décrit ci-dessous |

Opposition : respect de `navigator.doNotTrack` et de `navigator.globalPrivacyControl`
— si l'un des deux est actif, **rien n'est envoyé**, sans dégradation du site.
Un interrupteur explicite est également proposé sur la page `/cookies`, mémorisé
en `localStorage` (`kotbo:no-measure`).

Ce que cette exemption **interdit** et qu'il ne faut donc pas ajouter plus tard
sans rouvrir le sujet : un identifiant persistant au-delà de la session, la
conservation du référent complet, le rapprochement d'une visite avec un compte
Discord nominatif, ou tout outil tiers (Plausible hébergé ailleurs, GA, Matomo
cloud) — chacun ferait retomber le site sous consentement.

---

## 8. Agrégation, crons, alertes

| Tâche | Fréquence | Rôle |
| --- | --- | --- |
| `analytics-daily-snapshot` | 03:20 | Écrit les `AnalyticsDailySnapshot` de la veille, tous axes |
| `acquisition-events-prune` | 03:45 | Purge > 13 mois ; purge des `visitorId` > 30 j |
| `acquisition-abandon-scan` | horaire | Pose `onboarding_abandoned` après 72 h d'inactivité |
| `billing-invoice-sync` | 04:00 | Rattrape les factures Stripe manquées par le webhook |

Toutes déclarées dans `events/crons.ts` via `runCronJob`, et ajoutées à l'union
de `infra/queues/backgroundQueue.ts` — comme `billing-events-prune`.

**Alertes** (vers le salon d'administration, mémorisées par
`AcquisitionAlertState` pour ne pas se répéter) : churn mensuel au-dessus d'un
seuil configurable ; impayé (`past_due`) ; résiliation d'un serveur de plus de
N membres ; essai qui se termine sous 48 h sans moyen de paiement ; chute de
plus de 40 % des arrivées sur 7 jours glissants. Plus un récapitulatif
hebdomadaire (lundi 09:00) : MRR, variation, arrivées, départs, top provenances.

---

## 9. API

Un routeur `api/routes/admin/analytics.ts`, monté sous `/api/admin/analytics`,
protégé par `resolveAdminAccess` comme les routes admin existantes.

| Route | Rôle |
| --- | --- |
| `GET /funnel` | Étapes, volumes, taux, délais médians. `?from&to&compare&dimension&bucket` |
| `GET /funnel/onboarding` | Décrochage étape par étape du parcours |
| `GET /revenue` | MRR, ARR, ARPA, encaissé, décomposition, séries |
| `GET /revenue/cohorts` | Matrice de rétention |
| `GET /segments` | Croisement d'un axe et d'une métrique |
| `GET /modules` | Activés vs utilisés, corrélation conversion et rétention |
| `GET /guilds` | Explorateur : liste filtrée derrière chaque chiffre |
| `GET /risks` | Impayés, résiliations, accès expirants, payés-inactifs |
| `GET /export.csv` | Export de n'importe laquelle des vues ci-dessus |
| `POST /alerts` | Réglage des seuils |

Toutes les lectures passent par les snapshots dès que la période dépasse 7 jours ;
en deçà, calcul direct sur le journal pour que la vue du jour soit fraîche.

`POST /api/public/funnel` (public, sans session) : `{ step, visitorId, source,
campaign, content }`. Limité en débit par IP, valeurs d'étapes closes, IP non
journalisée, corps rejeté au-delà de 1 Ko.

---

## 10. Interface

`apps/dashboard/src/pages/admin/Analytics.svelte`, route `/admin/analytics`
ajoutée dans le bloc `authStore.isBotAdmin` de `App.svelte:696`, avec l'entrée
correspondante dans la navigation admin. Composants existants réutilisés tels
quels : `AdminShell`, `AdminCard`, `AdminStat`, `AdminTimeSeries`,
`AdminSparkline`, `AdminTable`, `AdminToolbar`, `AdminBadge`.

Une barre commune à tous les onglets : période (7 j / 30 j / 90 j / 12 mois /
personnalisé), comparaison à la période précédente, filtre de segment, export CSV.

**Onglet Tunnel** — entonnoir vertical de la visite au premier paiement, taux et
délai médian entre chaque étape ; entonnoir dédié aux 22 étapes de l'onboarding
avec les décrochages ; répartition par provenance et par bouton cliqué.

**Onglet Revenus** — tuiles MRR / ARR / ARPA / encaissé du mois avec variation ;
courbe du MRR ; décomposition en cascade mois par mois ; répartition
mensuel/annuel ; tableau des factures récentes ; bloc « portefeuille à risque »
avec liste actionnable liée à la page Facturation.

**Onglet Segments** — pour un axe choisi (taille, provenance, origine
d'activation, type de communauté, pistes, âge, langue, fuseau, instance) :
serveurs, taux de conversion, MRR, ARPA, churn. Plus un tableau croisé
palier de taille × plan qui met en évidence les serveurs hors palier — un
PLUS au-dessus de 1 000 membres ou un PRO au-dessus de 10 000 est une
conversation commerciale, pas une anomalie technique.

**Onglet Rétention & produit** — courbes de rétention par cohorte ; matrice ;
modules activés vs réellement utilisés par plan ; classement des modules par
corrélation à la conversion et à la rétention ; engagement (messages, membres
actifs, commandes) mis en face du statut de paiement.

Chaque chiffre est cliquable et ouvre le tiroir `AdminDrawer` avec la liste des
serveurs qui le composent, chacun lié à sa fiche Facturation. Un chiffre qui ne
mène à aucune action ne sert à rien.

Identité visuelle : Bento, glassmorphism, dark par défaut, conforme au reste de
l'administration. Séries et graphiques via les composants maison existants,
aucune bibliothèque de graphiques ajoutée.

---

## 11. Backfill

`scripts/backfill-acquisition.ts`, idempotent, relançable, avec `--dry-run`.

1. **Factures Stripe** — `stripe.invoices.list` depuis l'origine, paginé,
   rattaché au serveur par `stripeCustomerId`. Source la plus fiable, et la
   seule qui donne des montants réels rétroactifs.
2. **Événements déduits** — depuis `Guild.createdAt` (`bot_joined`),
   `activatedAt` (`code_activated`), `onboardingCompletedAt`
   (`onboarding_completed`), `BillingTrial` (`trial_*`), `BillingGift`
   (`gift_redeemed`), et la première facture (`first_payment`). Ces lignes
   portent `metadata.backfilled = true` : un événement reconstitué ne se
   présente jamais comme une mesure.
3. **`GuildLifecycle`** — une ligne par serveur connu, remplie de ce qui précède.
4. **Snapshots rétroactifs** — recalculés jour par jour à partir des points 1-3.

Limites, à afficher dans l'interface plutôt qu'à taire : avant la mise en
service, on ne connaît ni les provenances, ni le détail des étapes d'onboarding,
ni les départs de serveurs. Les courbes antérieures portent une mention
« reconstitué » et les taux du tunnel commencent à la date de mise en service.

---

## 12. Données personnelles

- Aucun identifiant Discord de personne en clair dans le journal : HMAC-SHA256
  avec un secret d'instance (`ANALYTICS_HASH_SECRET`, nouvelle variable). Le
  `guildId` reste en clair : c'est une donnée d'entreprise cliente.
- Journal purgé à 13 mois (comparaison année sur année possible), snapshots
  agrégés conservés sans limite — ils ne portent aucun identifiant.
- `visitorId` purgé à 30 jours.
- Départ du bot : `actorHash` et `visitorId` effacés du journal du serveur sous
  30 jours ; `GuildLifecycle` conservé, sans donnée personnelle.
- Branchement sur la page `/admin/gdpr` existante pour l'effacement sur demande.
- `docs/privacy/` et les pages `/privacy`, `/cookies` de la landing mises à jour
  dans le même lot que le code — pas après.

---

## 13. Découpage en commits

| # | Commit | Contenu | Statut |
| --- | --- | --- | --- |
| 1 | `feat(analytics): schéma du tunnel d'acquisition` | `acquisition.prisma`, contrats des étapes, migration | ✅ Terminé (`f7659c99`) |
| 2 | `feat(analytics): service d'enregistrement des étapes` | `acquisitionService`, `GuildLifecycle`, tests | ✅ Terminé (`3319c4a9`) |
| 3 | `feat(analytics): instrumenter arrivée, départ et invitation` | `index.ts`, `invite.ts` | ✅ Terminé (`b0d753af`) |
| 4 | `feat(analytics): instrumenter paiement et facturation` | `billing.ts`, `BillingInvoice`, `planService`, `accessService` | ✅ Terminé (`a873bc72`) |
| 5 | `feat(analytics): instrumenter le parcours de configuration` | `general.ts`, dashboard | ✅ Terminé (`c4e11785`) |
| 6 | `feat(analytics): agrégation quotidienne et crons` | snapshots, purges, scan d'abandon | ✅ Terminé (`a982eb7f`) |
| 7 | `feat(analytics): API d'administration` | `admin/analytics.ts`, export CSV | ✅ Terminé (`038186aa`) |
| 8-9 | `feat(dashboard): interface d'administration acquisition, revenus et cohortes` | 5 onglets complets (Tunnel, Revenus, Segments, Rétention, Alertes) | ✅ Terminé (`2076b875`) |
| 10 | `feat(analytics): alertes Discord et récapitulatif hebdomadaire` | alertes Discord, détection risques, cron hebdo | ✅ Terminé (`ec6b6f28`) |
| 11 | `feat(analytics): script de reprise d'historique` | script backfill et commandes npm | ✅ Terminé (`09717a99`) |
| 12 | `docs(privacy): cadre de conformite CNIL et registre des traitements` | `docs/privacy`, pages légales | ✅ Terminé |
| L1 | *(landing)* `feat(landing): liens d'invitation qualifiés` | helper `inviteUrl`, props | ✅ Terminé (`a6a6b63`) |
| L2-L3 | *(landing)* `docs(cookies): décrire la mesure d'audience et offrir le refus` | beacon, `/cookies`, opt-out | ✅ Terminé (`b30c37f`) |

---

## 14. Points restant à trancher

1. ~~Exemption CNIL ou bannière~~ → **tranché** : exemption, avec réécriture des
   pages légales (§7.6).
2. ~~Canaux de diffusion~~ → **tranché** : Discord et recherche Google
   uniquement. Provenance mesurée par classement du référent (§7.2).
3. **Seuils d'alerte** : quelle valeur de churn, quelle taille de serveur
   déclenche une alerte de résiliation ?
4. **Backfill Stripe** : sur quelle antériorité, et le mode test doit-il être
   exclu ?

---

## 15. Chantier joint : conditions générales de vente

Kotbo est vendu par abonnement à des professionnels et à des particuliers. La
landing publie aujourd'hui des CGU (`/terms`), des mentions légales, une
politique de confidentialité, un DPA et une page cookies — mais **aucune CGV**.
Or ce sont les CGV qui portent le prix, la reconduction, la résiliation, le
remboursement et le droit de rétractation : les obligations qui naissent de la
vente, pas de l'usage.

Elles sont traitées dans le même lot que la mesure d'audience parce que les deux
touchent aux mêmes pages et au même pied de page. Contenu et questions
préalables : voir §16.
