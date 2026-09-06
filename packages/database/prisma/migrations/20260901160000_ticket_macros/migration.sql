-- Macros de ticket : reponses pre-ecrites que le staff insere en un clic, avec
-- des actions attachees (fermer, requalifier, poser un role, sonder).
CREATE TABLE IF NOT EXISTS "ticket_macros" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "emoji" TEXT,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "ticketTypeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "autoSendOnOpen" BOOLEAN NOT NULL DEFAULT false,
    "setTicketTypeId" TEXT,
    "addRoleId" TEXT,
    "removeRoleId" TEXT,
    "requestSatisfaction" BOOLEAN NOT NULL DEFAULT false,
    "closeTicket" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_macros_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ticket_macros_guildId_enabled_idx" ON "ticket_macros"("guildId", "enabled");
CREATE INDEX IF NOT EXISTS "ticket_macros_guildId_position_idx" ON "ticket_macros"("guildId", "position");

DO $$
BEGIN
    ALTER TABLE "ticket_macros" ADD CONSTRAINT "ticket_macros_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
