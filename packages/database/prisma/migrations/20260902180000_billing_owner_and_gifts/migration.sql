-- Payeur du serveur et cadeaux Kotbo.
--
-- Le schema portait deja ces champs, sans migration pour les creer : chaque
-- `guild.findUnique` echouait en P2022 (« column guilds.billingOwnerId does not
-- exist »), donc `moduleGate` ne pouvait plus lire l'etat des modules d'aucun
-- serveur. Le bot etait a l'arret.
--
-- Strictement additif. Le diff complet du schema contient aussi des
-- suppressions de tables et de colonnes venues d'autres derives ; elles ne sont
-- pas ici, parce qu'elles ne sont pas necessaires a la remise en marche et
-- qu'une migration qui supprime des donnees se decide separement.

-- AlterTable
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "billingOwnerId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "billingStaffAccess" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "billing_gifts" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "plan" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "purchasedById" TEXT NOT NULL,
    "purchasedFromGuildId" TEXT,
    "targetGuildId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'PURCHASE_CODE',
    "stripeSessionId" TEXT,
    "amountCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "redeemedByGuildId" TEXT,
    "redeemedById" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_gifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "billing_gifts_code_key" ON "billing_gifts"("code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "billing_gifts_stripeSessionId_key" ON "billing_gifts"("stripeSessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "billing_gifts_purchasedById_createdAt_idx" ON "billing_gifts"("purchasedById", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "billing_gifts_targetGuildId_idx" ON "billing_gifts"("targetGuildId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "billing_gifts_redeemedByGuildId_idx" ON "billing_gifts"("redeemedByGuildId");
