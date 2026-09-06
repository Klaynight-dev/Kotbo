-- Campagnes marketing : suite de messages programmes, adressee a une audience
-- choisie, dont on mesure la portee.

DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignStepStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignDelivery" AS ENUM ('CHANNEL', 'DM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "campaigns" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "startAt" TIMESTAMP(3),
    "audienceRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "audienceExcludeRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "audienceMinLevel" INTEGER,
    "audienceMinTenureDays" INTEGER,
    "audienceInactiveDays" INTEGER,
    "targetGuildIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "inviteCode" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "campaign_steps" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "offsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "delivery" "CampaignDelivery" NOT NULL DEFAULT 'CHANNEL',
    "channelId" TEXT,
    "content" TEXT NOT NULL,
    "embed" JSONB,
    "status" "CampaignStepStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "lastError" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "reactionCount" INTEGER NOT NULL DEFAULT 0,
    "metricsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "campaigns_guildId_status_idx" ON "campaigns"("guildId", "status");
CREATE INDEX IF NOT EXISTS "campaigns_status_startAt_idx" ON "campaigns"("status", "startAt");
CREATE INDEX IF NOT EXISTS "campaign_steps_campaignId_position_idx" ON "campaign_steps"("campaignId", "position");
CREATE INDEX IF NOT EXISTS "campaign_steps_status_idx" ON "campaign_steps"("status");

DO $$ BEGIN
  ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
