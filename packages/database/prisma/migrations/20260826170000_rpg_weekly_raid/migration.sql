-- Raid hebdomadaire : chaque équipe affronte sa propre instance d'un boss dédié.
--
-- Les boss de raid sont propres au serveur (pas de catalogue global masqué comme le
-- bestiaire) : les fiches livrées de base y sont recopiées au premier allumage.
CREATE TABLE "rpg_raid_bosses" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '🐲',
    "level" INTEGER NOT NULL DEFAULT 20,
    "attack" INTEGER NOT NULL DEFAULT 60,
    "defense" INTEGER NOT NULL DEFAULT 35,
    "speed" INTEGER NOT NULL DEFAULT 20,
    "spells" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rpg_raid_bosses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rpg_raid_bosses_guildId_name_key" ON "rpg_raid_bosses"("guildId", "name");

-- Les caractéristiques du boss sont recopiées sur le raid : modifier la fiche en pleine
-- fenêtre ne doit pas changer l'épreuve des équipes qui ont déjà frappé.
CREATE TABLE "rpg_raids" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "bossId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "teamMode" TEXT NOT NULL DEFAULT 'CLAN',
    "bossName" TEXT NOT NULL,
    "bossEmoji" TEXT NOT NULL,
    "bossLevel" INTEGER NOT NULL,
    "bossAttack" INTEGER NOT NULL,
    "bossDefense" INTEGER NOT NULL,
    "bossSpeed" INTEGER NOT NULL,
    "bossSpells" JSONB NOT NULL DEFAULT '[]',
    "healthPerMember" INTEGER NOT NULL,
    "healthFloor" INTEGER NOT NULL,
    "healthCap" INTEGER NOT NULL,
    "assaultsPerMember" INTEGER NOT NULL,
    "energyCost" INTEGER NOT NULL,
    "xpReward" INTEGER NOT NULL,
    "coinReward" INTEGER NOT NULL,
    "clanPoints" INTEGER NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "announcedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "announceChannelId" TEXT,
    "announceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rpg_raids_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rpg_raids_guildId_opensAt_idx" ON "rpg_raids"("guildId", "opensAt");
CREATE INDEX "rpg_raids_guildId_status_idx" ON "rpg_raids"("guildId", "status");

CREATE TABLE "rpg_raid_teams" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "teamKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "totalHealth" INTEGER NOT NULL,
    "remainingHealth" INTEGER NOT NULL,
    "defeatedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),

    CONSTRAINT "rpg_raid_teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rpg_raid_teams_raidId_teamKey_key" ON "rpg_raid_teams"("raidId", "teamKey");

CREATE TABLE "rpg_raid_assaults" (
    "id" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "damage" INTEGER NOT NULL DEFAULT 0,
    "killingBlow" BOOLEAN NOT NULL DEFAULT false,
    "survived" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rpg_raid_assaults_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rpg_raid_assaults_raidTeamId_userId_idx" ON "rpg_raid_assaults"("raidTeamId", "userId");

ALTER TABLE "rpg_raid_bosses" ADD CONSTRAINT "rpg_raid_bosses_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_raids" ADD CONSTRAINT "rpg_raids_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_raids" ADD CONSTRAINT "rpg_raids_bossId_fkey" FOREIGN KEY ("bossId") REFERENCES "rpg_raid_bosses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rpg_raid_teams" ADD CONSTRAINT "rpg_raid_teams_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "rpg_raids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_raid_assaults" ADD CONSTRAINT "rpg_raid_assaults_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "rpg_raid_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Réglages du raid.
ALTER TABLE "economy_configs" ADD COLUMN "raidEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "economy_configs" ADD COLUMN "raidTeamMode" TEXT NOT NULL DEFAULT 'CLAN';
ALTER TABLE "economy_configs" ADD COLUMN "raidBossName" TEXT;
ALTER TABLE "economy_configs" ADD COLUMN "raidHealthPerMember" INTEGER NOT NULL DEFAULT 1200;
ALTER TABLE "economy_configs" ADD COLUMN "raidHealthFloor" INTEGER NOT NULL DEFAULT 2500;
ALTER TABLE "economy_configs" ADD COLUMN "raidHealthCap" INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE "economy_configs" ADD COLUMN "raidAssaultsPerMember" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "economy_configs" ADD COLUMN "raidEnergyCost" INTEGER NOT NULL DEFAULT 25;
ALTER TABLE "economy_configs" ADD COLUMN "raidWeekday" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "economy_configs" ADD COLUMN "raidHour" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "economy_configs" ADD COLUMN "raidDurationHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "economy_configs" ADD COLUMN "raidXpReward" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "economy_configs" ADD COLUMN "raidCoinReward" INTEGER NOT NULL DEFAULT 450;
ALTER TABLE "economy_configs" ADD COLUMN "raidClanPoints" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "economy_configs" ADD COLUMN "raidAnnounce" TEXT NOT NULL DEFAULT 'CHANNEL';
ALTER TABLE "economy_configs" ADD COLUMN "raidChannelId" TEXT;
ALTER TABLE "economy_configs" ADD COLUMN "raidRoleId" TEXT;
