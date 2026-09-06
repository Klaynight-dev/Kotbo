-- Refonte de la console admin globale.
--
-- 1. broadcast_media : images de broadcast hebergees par Kotbo. Discord refuse
--    les URL `data:` et fait expirer ses liens CDN signes, donc une image
--    uploadee doit etre servie par une URL publique stable.
-- 2. broadcast_templates : modeles reutilisables pour l'editeur d'annonces.
-- 3. broadcast_deliveries : resultat serveur par serveur d'un envoi.
-- 4. admin_audit_logs : journal des actions sensibles de la console.
-- 5. broadcast_logs gagne un cycle de vie (brouillon, programme, en cours...).

CREATE TABLE IF NOT EXISTS "broadcast_media" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_media_token_key" ON "broadcast_media"("token");
CREATE INDEX IF NOT EXISTS "broadcast_media_uploadedBy_idx" ON "broadcast_media"("uploadedBy");

CREATE TABLE IF NOT EXISTS "broadcast_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "message" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#5865F2',
    "thumbnailUrl" TEXT,
    "imageUrl" TEXT,
    "footerText" TEXT,
    "target" TEXT NOT NULL DEFAULT 'ALL',
    "targetGuilds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channelPref" TEXT NOT NULL DEFAULT 'AUTO',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "broadcast_templates_createdBy_idx" ON "broadcast_templates"("createdBy");

ALTER TABLE "broadcast_logs"
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'SENT',
ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT;

CREATE INDEX IF NOT EXISTS "broadcast_logs_status_idx" ON "broadcast_logs"("status");
CREATE INDEX IF NOT EXISTS "broadcast_logs_scheduledAt_idx" ON "broadcast_logs"("scheduledAt");
CREATE INDEX IF NOT EXISTS "broadcast_logs_createdAt_idx" ON "broadcast_logs"("createdAt");

CREATE TABLE IF NOT EXISTS "broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "guildName" TEXT NOT NULL,
    "channelId" TEXT,
    "channelName" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "broadcast_deliveries_broadcastId_idx" ON "broadcast_deliveries"("broadcastId");
CREATE INDEX IF NOT EXISTS "broadcast_deliveries_guildId_idx" ON "broadcast_deliveries"("guildId");
CREATE INDEX IF NOT EXISTS "broadcast_deliveries_status_idx" ON "broadcast_deliveries"("status");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'broadcast_deliveries_broadcastId_fkey'
    ) THEN
        ALTER TABLE "broadcast_deliveries"
        ADD CONSTRAINT "broadcast_deliveries_broadcastId_fkey"
        FOREIGN KEY ("broadcastId") REFERENCES "broadcast_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'OK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_audit_logs_actorId_idx" ON "admin_audit_logs"("actorId");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_targetType_targetId_idx" ON "admin_audit_logs"("targetType", "targetId");
