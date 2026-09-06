-- Essai gratuit : une fois par compte Discord, et une fois par serveur.
--
-- Les deux contraintes d'unicité sont la règle de gestion elle-même, pas une
-- optimisation : c'est l'échec d'insertion qui refuse un second essai, sans
-- lecture préalable ni verrou applicatif.

CREATE TABLE "billing_trials" (
  "discordUserId"     TEXT NOT NULL,
  "guildId"           TEXT NOT NULL,
  "plan"              TEXT NOT NULL,
  "interval"          TEXT NOT NULL,
  "checkoutSessionId" TEXT,
  "subscriptionId"    TEXT,
  "reservedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"         TIMESTAMP(3),

  CONSTRAINT "billing_trials_pkey" PRIMARY KEY ("discordUserId")
);

CREATE UNIQUE INDEX "billing_trials_guildId_key"           ON "billing_trials"("guildId");
CREATE UNIQUE INDEX "billing_trials_checkoutSessionId_key" ON "billing_trials"("checkoutSessionId");
CREATE INDEX        "billing_trials_guildId_idx"           ON "billing_trials"("guildId");
