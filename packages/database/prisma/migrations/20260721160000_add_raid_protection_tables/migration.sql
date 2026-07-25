-- CreateTable
CREATE TABLE "raid_protection_configs" (
    "guildId" TEXT NOT NULL,
    "captchaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "captchaChannelId" TEXT,
    "captchaUnverifiedRoleId" TEXT,
    "captchaTimeoutMinutes" INTEGER NOT NULL DEFAULT 10,
    "captchaMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "captchaFailAction" TEXT NOT NULL DEFAULT 'KICK',
    "captchaLogChannelId" TEXT,
    "antiRaidEnabled" BOOLEAN NOT NULL DEFAULT false,
    "antiRaidJoinThreshold" INTEGER NOT NULL DEFAULT 10,
    "antiRaidJoinWindowSec" INTEGER NOT NULL DEFAULT 60,
    "antiRaidAction" TEXT NOT NULL DEFAULT 'LOCK',
    "antiRaidAlertChannelId" TEXT,
    "antiRaidAutoDisableMinutes" INTEGER NOT NULL DEFAULT 30,
    "raidModeActive" BOOLEAN NOT NULL DEFAULT false,
    "raidModeActivatedAt" TIMESTAMP(3),
    "raidModeManual" BOOLEAN NOT NULL DEFAULT false,
    "joinLockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "joinLockUntil" TIMESTAMP(3),
    "joinLockKick" BOOLEAN NOT NULL DEFAULT true,
    "joinLockMessage" TEXT NOT NULL DEFAULT 'Le serveur est temporairement fermé aux nouvelles arrivées. Merci de réessayer plus tard.',
    "dmLockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dmLockUntil" TIMESTAMP(3),
    "reportsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reportsChannelId" TEXT,
    "reportsCooldownSec" INTEGER NOT NULL DEFAULT 60,
    "reportsAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "tagRoleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tagRoleId" TEXT,
    "scamFilterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scamFilterAction" TEXT NOT NULL DEFAULT 'DELETE_AND_TIMEOUT',
    "scamFilterTimeoutMin" INTEGER NOT NULL DEFAULT 60,
    "scamFilterCustomDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scamFilterWhitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scamFilterAlertChannelId" TEXT,
    "scamImageFilterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inviteGuardEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inviteEmergencyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inviteRequireUnitary" BOOLEAN NOT NULL DEFAULT false,
    "inviteValidationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inviteSpamThreshold" INTEGER NOT NULL DEFAULT 5,
    "inviteSpamWindowSec" INTEGER NOT NULL DEFAULT 60,
    "inviteAlertChannelId" TEXT,
    "inviteBypassRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raid_protection_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "captcha_sessions" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "captcha_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scam_image_hashes" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "hash" TEXT NOT NULL,
    "filename" TEXT,
    "source" TEXT NOT NULL DEFAULT 'HONEYPOT',
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scam_image_hashes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_approval_requests" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "inviteCode" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "maxAgeSec" INTEGER NOT NULL DEFAULT 86400,
    "temporary" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "approvedInviteCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_reports" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "messageContent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "captcha_sessions_guildId_userId_status_idx" ON "captcha_sessions"("guildId", "userId", "status");

-- CreateIndex
CREATE INDEX "captcha_sessions_status_expiresAt_idx" ON "captcha_sessions"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "scam_image_hashes_hash_idx" ON "scam_image_hashes"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "scam_image_hashes_guildId_hash_key" ON "scam_image_hashes"("guildId", "hash");

-- CreateIndex
CREATE INDEX "invite_approval_requests_guildId_status_idx" ON "invite_approval_requests"("guildId", "status");

-- CreateIndex
CREATE INDEX "member_reports_guildId_status_createdAt_idx" ON "member_reports"("guildId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "member_reports_guildId_targetId_idx" ON "member_reports"("guildId", "targetId");

-- AddForeignKey
ALTER TABLE "raid_protection_configs" ADD CONSTRAINT "raid_protection_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captcha_sessions" ADD CONSTRAINT "captcha_sessions_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scam_image_hashes" ADD CONSTRAINT "scam_image_hashes_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_approval_requests" ADD CONSTRAINT "invite_approval_requests_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_reports" ADD CONSTRAINT "member_reports_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
