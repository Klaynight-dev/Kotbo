-- Preuve du consentement recueilli sur la page de paiement, et avis de
-- reconduction des abonnements annuels.
--
-- Kotbo ouvre les modules des la confirmation du paiement. Pour un
-- consommateur, fournir un contenu numerique avant la fin du delai de quatorze
-- jours suppose une demande expresse d'execution immediate et une renonciation
-- expresse a la retractation (art. L221-25 et L221-28 du code de la
-- consommation). La case est desormais recueillie par Stripe, mais la session
-- Stripe n'est pas un support dont nous soyons maitres : une renonciation qu'on
-- ne sait pas produire des mois plus tard ne vaut rien. D'ou cette copie, qui
-- porte aussi la version des CGV alors en vigueur.
CREATE TABLE IF NOT EXISTS "billing_consents" (
    "checkoutSessionId"  TEXT NOT NULL,
    "guildId"            TEXT,
    "discordUserId"      TEXT,
    "kind"               TEXT NOT NULL,
    "documentVersion"    TEXT NOT NULL,
    "termsAcceptedAt"    TIMESTAMP(3),
    "withdrawalWaivedAt" TIMESTAMP(3),
    "plan"               TEXT,
    "interval"           TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_consents_pkey" PRIMARY KEY ("checkoutSessionId")
);

CREATE INDEX IF NOT EXISTS "billing_consents_guildId_createdAt_idx"
    ON "billing_consents" ("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "billing_consents_discordUserId_idx"
    ON "billing_consents" ("discordUserId");

-- Echeance annuelle pour laquelle l'avis de reconduction a deja ete envoye.
--
-- L'article L215-1 impose de prevenir entre trois mois et un mois avant le
-- terme d'un contrat a reconduction tacite. On stocke la date d'echeance visee
-- plutot qu'un booleen : a la reconduction suivante, `stripeCurrentPeriodEnd`
-- change d'un an, et l'avis repart de lui-meme.
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "renewalNoticeSentFor" TIMESTAMP(3);
