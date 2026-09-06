-- Quêtes RPG : objectifs de jeu, portée personnelle ou collective.
--
-- Distinctes des quêtes de discussion, qui comptent des messages et des minutes de vocal :
-- ni les objectifs, ni les récompenses, ni la portée d'équipe n'ont d'équivalent là-bas.
CREATE TYPE "RpgQuestObjective" AS ENUM ('MONSTER_KILLS', 'BOSS_KILLS', 'RAID_ASSAULTS', 'RAID_DAMAGE', 'ITEMS_LOOTED', 'FISH_CAUGHT');
CREATE TYPE "RpgQuestScope" AS ENUM ('MEMBER', 'TEAM');

CREATE TABLE "rpg_quests" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '📜',
    "objective" "RpgQuestObjective" NOT NULL,
    "target" INTEGER NOT NULL DEFAULT 10,
    "scope" "RpgQuestScope" NOT NULL DEFAULT 'MEMBER',
    "teamMode" TEXT NOT NULL DEFAULT 'CLAN',
    "windowHours" INTEGER NOT NULL DEFAULT 24,
    "rewardCoins" INTEGER NOT NULL DEFAULT 0,
    "rewardXp" INTEGER NOT NULL DEFAULT 0,
    "rewardClanPoints" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rpg_quests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rpg_quests_guildId_name_key" ON "rpg_quests"("guildId", "name");
CREATE INDEX "rpg_quests_guildId_enabled_idx" ON "rpg_quests"("guildId", "enabled");

CREATE TABLE "rpg_quest_progress" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "teamKey" TEXT NOT NULL DEFAULT '',
    "current" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rpg_quest_progress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rpg_quest_progress_questId_userId_windowKey_teamKey_key" ON "rpg_quest_progress"("questId", "userId", "windowKey", "teamKey");
CREATE INDEX "rpg_quest_progress_guildId_userId_windowKey_idx" ON "rpg_quest_progress"("guildId", "userId", "windowKey");
CREATE INDEX "rpg_quest_progress_questId_windowKey_teamKey_idx" ON "rpg_quest_progress"("questId", "windowKey", "teamKey");

CREATE TABLE "rpg_quest_team_progress" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "teamKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "current" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rpg_quest_team_progress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rpg_quest_team_progress_questId_teamKey_windowKey_key" ON "rpg_quest_team_progress"("questId", "teamKey", "windowKey");
CREATE INDEX "rpg_quest_team_progress_guildId_windowKey_idx" ON "rpg_quest_team_progress"("guildId", "windowKey");

ALTER TABLE "rpg_quests" ADD CONSTRAINT "rpg_quests_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_quest_progress" ADD CONSTRAINT "rpg_quest_progress_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_quest_progress" ADD CONSTRAINT "rpg_quest_progress_questId_fkey" FOREIGN KEY ("questId") REFERENCES "rpg_quests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_quest_team_progress" ADD CONSTRAINT "rpg_quest_team_progress_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rpg_quest_team_progress" ADD CONSTRAINT "rpg_quest_team_progress_questId_fkey" FOREIGN KEY ("questId") REFERENCES "rpg_quests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
