-- Contestation des sanctions au-delà du seul ban définitif.
--
-- 1. Le module Appels sait quels types de sanction sont contestables, avec une
--    fenêtre, un cooldown et un formulaire par type.
-- 2. Une sanction peut être archivée (désactivée mais conservée) ou verrouillée
--    (plus contestable), en plus de la suppression déjà existante.
-- 3. Un appel porte désormais sur zéro, une ou plusieurs sanctions, chacune
--    tranchée séparément.

-- CreateEnum
CREATE TYPE "AppealItemOutcome" AS ENUM ('PENDING', 'UPHELD', 'ARCHIVED', 'DELETED', 'LOCKED');

-- AlterTable: configuration du module Appels
ALTER TABLE "ban_appeal_configs"
  ADD COLUMN "appealableTypes" "SanctionType"[] DEFAULT ARRAY['BAN']::"SanctionType"[],
  ADD COLUMN "maxSanctionsPerAppeal" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "appealWindowDays" INTEGER,
  ADD COLUMN "cooldownByType" JSONB,
  ADD COLUMN "formIdByType" JSONB,
  ADD COLUMN "notifyOnSanctionDM" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "excludeIssuingModerator" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifyIssuingModerator" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: archivage et verrou d'appel sur les sanctions
ALTER TABLE "sanctions"
  ADD COLUMN "appealable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "appealLockedAt" TIMESTAMP(3),
  ADD COLUMN "appealLockedByUserId" TEXT,
  ADD COLUMN "appealLockReason" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedByUserId" TEXT,
  ADD COLUMN "archiveReason" TEXT;

-- AlterTable: réglages serveur liés à l'archivage
ALTER TABLE "guilds"
  ADD COLUMN "countArchivedInWarnScore" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "warnAutoArchiveDays" INTEGER;

-- CreateTable
CREATE TABLE "ban_appeal_sanctions" (
    "id" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sanctionId" TEXT,
    "sanctionType" "SanctionType" NOT NULL,
    "sanctionReason" TEXT NOT NULL,
    "sanctionCreatedAt" TIMESTAMP(3) NOT NULL,
    "moderatorUserId" TEXT,
    "moderatorTag" TEXT,
    "memberStatement" TEXT,
    "outcome" "AppealItemOutcome" NOT NULL DEFAULT 'PENDING',
    "outcomeNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decidedByTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ban_appeal_sanctions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ban_appeal_sanctions_appealId_idx" ON "ban_appeal_sanctions"("appealId");
CREATE INDEX "ban_appeal_sanctions_guildId_outcome_idx" ON "ban_appeal_sanctions"("guildId", "outcome");
CREATE INDEX "ban_appeal_sanctions_sanctionId_idx" ON "ban_appeal_sanctions"("sanctionId");
CREATE INDEX "sanctions_guildId_archivedAt_idx" ON "sanctions"("guildId", "archivedAt");
CREATE INDEX "sanctions_guildId_targetUserId_archivedAt_idx" ON "sanctions"("guildId", "targetUserId", "archivedAt");

-- AddForeignKey
ALTER TABLE "ban_appeal_sanctions" ADD CONSTRAINT "ban_appeal_sanctions_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "ban_appeals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ban_appeal_sanctions" ADD CONSTRAINT "ban_appeal_sanctions_sanctionId_fkey" FOREIGN KEY ("sanctionId") REFERENCES "sanctions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ban_appeal_sanctions" ADD CONSTRAINT "ban_appeal_sanctions_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
