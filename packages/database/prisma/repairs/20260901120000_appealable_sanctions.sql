-- Réparation idempotente : contestation des sanctions (archivage / verrou /
-- appels multi-sanctions). Rejouable sur une base déjà partiellement migrée.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppealItemOutcome') THEN
    CREATE TYPE "AppealItemOutcome" AS ENUM ('PENDING', 'UPHELD', 'ARCHIVED', 'DELETED', 'LOCKED');
  END IF;
END $$;

ALTER TABLE "ban_appeal_configs"
  ADD COLUMN IF NOT EXISTS "appealableTypes" "SanctionType"[] DEFAULT ARRAY['BAN']::"SanctionType"[],
  ADD COLUMN IF NOT EXISTS "maxSanctionsPerAppeal" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "appealWindowDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "cooldownByType" JSONB,
  ADD COLUMN IF NOT EXISTS "formIdByType" JSONB,
  ADD COLUMN IF NOT EXISTS "notifyOnSanctionDM" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "excludeIssuingModerator" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notifyIssuingModerator" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "sanctions"
  ADD COLUMN IF NOT EXISTS "appealable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "appealLockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "appealLockedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "appealLockReason" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "archiveReason" TEXT;

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "countArchivedInWarnScore" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "warnAutoArchiveDays" INTEGER;

CREATE TABLE IF NOT EXISTS "ban_appeal_sanctions" (
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

CREATE INDEX IF NOT EXISTS "ban_appeal_sanctions_appealId_idx" ON "ban_appeal_sanctions"("appealId");
CREATE INDEX IF NOT EXISTS "ban_appeal_sanctions_guildId_outcome_idx" ON "ban_appeal_sanctions"("guildId", "outcome");
CREATE INDEX IF NOT EXISTS "ban_appeal_sanctions_sanctionId_idx" ON "ban_appeal_sanctions"("sanctionId");
CREATE INDEX IF NOT EXISTS "sanctions_guildId_archivedAt_idx" ON "sanctions"("guildId", "archivedAt");
CREATE INDEX IF NOT EXISTS "sanctions_guildId_targetUserId_archivedAt_idx" ON "sanctions"("guildId", "targetUserId", "archivedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ban_appeal_sanctions_appealId_fkey') THEN
    ALTER TABLE "ban_appeal_sanctions" ADD CONSTRAINT "ban_appeal_sanctions_appealId_fkey"
      FOREIGN KEY ("appealId") REFERENCES "ban_appeals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ban_appeal_sanctions_sanctionId_fkey') THEN
    ALTER TABLE "ban_appeal_sanctions" ADD CONSTRAINT "ban_appeal_sanctions_sanctionId_fkey"
      FOREIGN KEY ("sanctionId") REFERENCES "sanctions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ban_appeal_sanctions_guildId_fkey') THEN
    ALTER TABLE "ban_appeal_sanctions" ADD CONSTRAINT "ban_appeal_sanctions_guildId_fkey"
      FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
