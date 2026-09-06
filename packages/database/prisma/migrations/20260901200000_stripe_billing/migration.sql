-- Facturation Stripe : offre commerciale par serveur et trace des webhooks.
--
-- Point d'attention sur la reprise de l'existant : la colonne `plan` a pour
-- valeur par défaut 'FREE', ce qui fermerait d'un coup les modules payants de
-- tous les serveurs déjà activés. Le second UPDATE les bascule donc en 'CUSTOM'
-- (tout le catalogue, hors Stripe) : ils gardent exactement ce qu'ils avaient,
-- et la grille tarifaire ne s'applique qu'aux nouveaux venus. À ajuster à la
-- main, serveur par serveur, au fil des négociations commerciales.

ALTER TABLE "guilds"
  ADD COLUMN "plan"                     TEXT NOT NULL DEFAULT 'FREE',
  ADD COLUMN "stripeCustomerId"         TEXT,
  ADD COLUMN "stripeSubscriptionId"     TEXT,
  ADD COLUMN "stripeSubscriptionStatus" TEXT,
  ADD COLUMN "stripePriceId"            TEXT,
  ADD COLUMN "stripeCancelAtPeriodEnd"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stripeCurrentPeriodEnd"   TIMESTAMP(3);

CREATE UNIQUE INDEX "guilds_stripeCustomerId_key"     ON "guilds"("stripeCustomerId");
CREATE UNIQUE INDEX "guilds_stripeSubscriptionId_key" ON "guilds"("stripeSubscriptionId");

-- Reprise de l'existant : aucun serveur déjà activé ne doit perdre d'accès
-- le jour du déploiement.
UPDATE "guilds" SET "plan" = 'CUSTOM' WHERE "activated" = true;

CREATE TABLE "billing_events" (
  "id"         TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "guildId"    TEXT,
  "payload"    JSONB NOT NULL,
  "error"      TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_events_guildId_receivedAt_idx" ON "billing_events"("guildId", "receivedAt");
CREATE INDEX "billing_events_receivedAt_idx"         ON "billing_events"("receivedAt");
