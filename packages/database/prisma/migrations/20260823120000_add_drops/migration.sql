-- Drops aléatoires : un cadeau posé de lui-même dans un salon, à une heure
-- imprévisible, que les membres ramassent en cliquant.
--
-- Les réglages vivent dans `drop_configs` (une ligne par ressource) plutôt qu'en
-- colonnes sur `guilds` : quatre ressources multipliées par trois modes de
-- ramassage feraient une trentaine de colonnes de plus sur une table déjà large.
ALTER TABLE "guilds" ADD COLUMN     "dropsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dropChannelId" TEXT,
ADD COLUMN     "dropMentionRoleId" TEXT,
ADD COLUMN     "dropLifetimeMinutes" INTEGER NOT NULL DEFAULT 60;

CREATE TABLE "drop_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "channelId" TEXT,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 360,
    "firstEnabled" BOOLEAN NOT NULL DEFAULT true,
    "firstMinAmount" INTEGER NOT NULL DEFAULT 50,
    "firstMaxAmount" INTEGER NOT NULL DEFAULT 250,
    "raceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "raceWinnerCount" INTEGER NOT NULL DEFAULT 3,
    "raceMinAmount" INTEGER NOT NULL DEFAULT 25,
    "raceMaxAmount" INTEGER NOT NULL DEFAULT 125,
    "windowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "windowDurationMinutes" INTEGER NOT NULL DEFAULT 10,
    "windowMinAmount" INTEGER NOT NULL DEFAULT 15,
    "windowMaxAmount" INTEGER NOT NULL DEFAULT 60,
    "nextDropAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drop_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "drop_configs_guildId_type_key" ON "drop_configs"("guildId", "type");
CREATE INDEX "drop_configs_enabled_nextDropAt_idx" ON "drop_configs"("enabled", "nextDropAt");

CREATE TABLE "drops" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "amount" INTEGER NOT NULL,
    "maxClaims" INTEGER NOT NULL DEFAULT 1,
    "claimCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drops_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "drops_closedAt_expiresAt_idx" ON "drops"("closedAt", "expiresAt");
CREATE INDEX "drops_guildId_createdAt_idx" ON "drops"("guildId", "createdAt");

CREATE TABLE "drop_claims" (
    "id" TEXT NOT NULL,
    "dropId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drop_claims_pkey" PRIMARY KEY ("id")
);

-- Un gain par membre et par drop : c'est cette contrainte, et non un contrôle
-- applicatif, qui bloque le double clic.
CREATE UNIQUE INDEX "drop_claims_dropId_userId_key" ON "drop_claims"("dropId", "userId");
CREATE INDEX "drop_claims_guildId_createdAt_idx" ON "drop_claims"("guildId", "createdAt");

ALTER TABLE "drop_configs" ADD CONSTRAINT "drop_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drops" ADD CONSTRAINT "drops_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drops" ADD CONSTRAINT "drops_configId_fkey" FOREIGN KEY ("configId") REFERENCES "drop_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drop_claims" ADD CONSTRAINT "drop_claims_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
