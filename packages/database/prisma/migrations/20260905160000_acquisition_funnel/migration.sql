-- Tunnel d'acquisition et statistiques commerciales.
--
-- Trois trous motivent ces tables : le depart d'un serveur ne laissait aucune
-- trace (donc aucun churn mesurable), aucun montant reellement encaisse n'etait
-- conserve, et `guilds` ne porte que l'etat courant - un serveur passe de PRO a
-- FREE ne laisse rien derriere lui.
--
-- Aucune cle etrangere vers `guilds` : toutes ses relations sont en CASCADE, et
-- y rattacher le journal effacerait l'historique d'un serveur au moment precis
-- ou il devient interessant, son depart. Les `guildId` sont donc des colonnes
-- libres, volontairement non contraintes.

-- ── Journal du tunnel ───────────────────────────────────────────────────────
-- Seule table a fort volume. Purgee a treize mois : treize et non douze, pour
-- qu'une comparaison d'un mois a celui de l'annee precedente ait encore ses
-- deux termes.
CREATE TABLE IF NOT EXISTS "acquisition_events" (
    "id"         TEXT NOT NULL,
    "step"       TEXT NOT NULL,
    "guildId"    TEXT,
    -- HMAC-SHA256 de l'identifiant Discord : jamais l'identifiant en clair.
    "actorHash"  TEXT,
    -- Visiteur anonyme, purge a trente jours. C'est cette brievete qui maintient
    -- la mesure dans l'exemption de consentement pour la mesure d'audience.
    "visitorId"  TEXT,
    "source"     TEXT,
    "campaign"   TEXT,
    "content"    TEXT,
    "metadata"   JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "acquisition_events_step_occurredAt_idx"
    ON "acquisition_events" ("step", "occurredAt");
CREATE INDEX IF NOT EXISTS "acquisition_events_guildId_occurredAt_idx"
    ON "acquisition_events" ("guildId", "occurredAt");
CREATE INDEX IF NOT EXISTS "acquisition_events_visitorId_idx"
    ON "acquisition_events" ("visitorId");
CREATE INDEX IF NOT EXISTS "acquisition_events_occurredAt_idx"
    ON "acquisition_events" ("occurredAt");

-- ── Etat du parcours, un serveur par ligne ──────────────────────────────────
-- Derive du journal, mais tenu a part : une cohorte de retention qui rescanne
-- le journal entier a chaque affichage ne tient pas la charge, et cette table
-- survit a la purge des evenements - un serveur parti il y a deux ans doit
-- rester comptable dans les courbes.
CREATE TABLE IF NOT EXISTS "guild_lifecycles" (
    "guildId" TEXT NOT NULL,

    "source"           TEXT,
    "campaign"         TEXT,
    "content"          TEXT,
    "activationOrigin" TEXT,
    "instanceId"       TEXT,

    "invitedAt"              TIMESTAMP(3),
    "dashboardFirstOpenedAt" TIMESTAMP(3),
    "onboardingStartedAt"    TIMESTAMP(3),
    "onboardingCompletedAt"  TIMESTAMP(3),
    "onboardingLastStep"     TEXT,
    "onboardingSteps"        JSONB,
    "onboardingSeconds"      INTEGER,

    "pricingViewedAt"     TIMESTAMP(3),
    "checkoutStartedAt"   TIMESTAMP(3),
    "checkoutAbandonedAt" TIMESTAMP(3),
    "trialStartedAt"      TIMESTAMP(3),
    "trialEndsAt"         TIMESTAMP(3),
    "trialConvertedAt"    TIMESTAMP(3),
    "firstPaidAt"         TIMESTAMP(3),

    "plan"          TEXT NOT NULL DEFAULT 'FREE',
    "interval"      TEXT,
    -- Revenu mensuel normalise : un annuel est ramene au mois.
    "mrrCents"      INTEGER NOT NULL DEFAULT 0,
    "lifetimeCents" INTEGER NOT NULL DEFAULT 0,

    "churnedAt"      TIMESTAMP(3),
    "churnReason"    TEXT,
    "botRemovedAt"   TIMESTAMP(3),
    -- Sans ce compteur, une reinstallation ressemblerait a une acquisition
    -- neuve et gonflerait le haut du tunnel.
    "reinstallCount" INTEGER NOT NULL DEFAULT 0,

    -- Effectif a l'arrivee et effectif courant : le palier tarifaire se lit sur
    -- le second, la cohorte sur le premier.
    "memberCountAtInvite" INTEGER,
    "memberCount"         INTEGER,
    "serverKind"          TEXT,
    "tracks"              TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locale"              TEXT,
    "timezone"            TEXT,

    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_lifecycles_pkey" PRIMARY KEY ("guildId")
);

CREATE INDEX IF NOT EXISTS "guild_lifecycles_plan_churnedAt_idx"
    ON "guild_lifecycles" ("plan", "churnedAt");
CREATE INDEX IF NOT EXISTS "guild_lifecycles_source_idx"
    ON "guild_lifecycles" ("source");
CREATE INDEX IF NOT EXISTS "guild_lifecycles_firstPaidAt_idx"
    ON "guild_lifecycles" ("firstPaidAt");
CREATE INDEX IF NOT EXISTS "guild_lifecycles_churnedAt_idx"
    ON "guild_lifecycles" ("churnedAt");
CREATE INDEX IF NOT EXISTS "guild_lifecycles_invitedAt_idx"
    ON "guild_lifecycles" ("invitedAt");

-- ── Factures Stripe ─────────────────────────────────────────────────────────
-- `billing_events` garde les webhooks bruts trois jours, le temps de servir de
-- verrou d'idempotence : ce n'est pas un historique comptable. Sans cette
-- table, le seul chiffre d'affaires disponible serait une estimation a partir
-- des tarifs affiches, fausse des qu'intervient une remise ou un remboursement.
CREATE TABLE IF NOT EXISTS "billing_invoices" (
    "id"             TEXT NOT NULL,
    "guildId"        TEXT,
    "customerId"     TEXT,
    "subscriptionId" TEXT,

    "plan"     TEXT NOT NULL,
    "interval" TEXT,
    "status"   TEXT NOT NULL,

    "currency"            TEXT NOT NULL DEFAULT 'eur',
    "subtotalCents"       INTEGER NOT NULL DEFAULT 0,
    "discountCents"       INTEGER NOT NULL DEFAULT 0,
    "taxCents"            INTEGER NOT NULL DEFAULT 0,
    "totalCents"          INTEGER NOT NULL DEFAULT 0,
    "amountPaidCents"     INTEGER NOT NULL DEFAULT 0,
    "amountRefundedCents" INTEGER NOT NULL DEFAULT 0,

    "periodStart" TIMESTAMP(3),
    "periodEnd"   TIMESTAMP(3),
    "issuedAt"    TIMESTAMP(3) NOT NULL,
    "paidAt"      TIMESTAMP(3),

    -- Distingue ce qui a ete observe en direct de ce qui a ete rattrape.
    "ingestedBy" TEXT NOT NULL DEFAULT 'webhook',

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "billing_invoices_guildId_issuedAt_idx"
    ON "billing_invoices" ("guildId", "issuedAt");
CREATE INDEX IF NOT EXISTS "billing_invoices_issuedAt_idx"
    ON "billing_invoices" ("issuedAt");
CREATE INDEX IF NOT EXISTS "billing_invoices_status_idx"
    ON "billing_invoices" ("status");
CREATE INDEX IF NOT EXISTS "billing_invoices_subscriptionId_idx"
    ON "billing_invoices" ("subscriptionId");

-- ── Instantanes quotidiens agreges ──────────────────────────────────────────
-- Une table pour tous les axes, et un JSONB pour les compteurs : ajouter un axe
-- de decoupage ou une metrique ne demande alors aucune migration. On perd le
-- typage fort sur `metrics`, on gagne un schema qui ne bouge pas a chaque
-- question nouvelle posee aux donnees.
--
-- Ne porte aucun identifiant : c'est ce qui permet de le garder indefiniment
-- quand le journal detaille, lui, est purge a treize mois.
CREATE TABLE IF NOT EXISTS "analytics_daily_snapshots" (
    "id"        TEXT NOT NULL,
    -- YYYY-MM-DD, fuseau Europe/Paris. Le process tourne en UTC : sans fuseau
    -- de reference explicite, la frontiere d'un jour se deplacerait deux fois
    -- par an.
    "dateKey"   TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    -- Chaine vide pour l'axe `global`.
    "bucket"    TEXT NOT NULL,
    "metrics"   JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_daily_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "analytics_daily_snapshots_dateKey_dimension_bucket_key"
    ON "analytics_daily_snapshots" ("dateKey", "dimension", "bucket");
CREATE INDEX IF NOT EXISTS "analytics_daily_snapshots_dimension_dateKey_idx"
    ON "analytics_daily_snapshots" ("dimension", "dateKey");

-- ── Memoire des alertes ─────────────────────────────────────────────────────
-- Sans elle, une alerte de churn se repeterait a chaque passage du cron tant
-- que le seuil reste franchi - et une alerte qui se repete finit ignoree.
CREATE TABLE IF NOT EXISTS "acquisition_alert_states" (
    "key"         TEXT NOT NULL,
    "lastFiredAt" TIMESTAMP(3) NOT NULL,
    "lastValue"   DOUBLE PRECISION,

    CONSTRAINT "acquisition_alert_states_pkey" PRIMARY KEY ("key")
);
