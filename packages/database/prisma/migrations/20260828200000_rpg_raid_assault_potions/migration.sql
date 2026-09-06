-- Potions d'assaut de raid.
--
-- Une potion peut désormais rendre des assauts en plus du quota de la semaine. Elle ne se
-- boit que pendant une fenêtre ouverte : le bonus vaut pour ce raid, et la ligne disparaît
-- avec lui plutôt que de laisser arriver au suivant avec une avance accumulée.
ALTER TABLE "rpg_items" ADD COLUMN "raidAssaultBonus" INTEGER NOT NULL DEFAULT 0;

-- Le plafond garde l'enveloppe proportionnelle à l'effectif : sans lui, un joueur fortuné
-- abat le boss seul et la réserve calculée sur l'équipe ne veut plus rien dire.
ALTER TABLE "economy_configs" ADD COLUMN "raidBoughtAssaultsMax" INTEGER NOT NULL DEFAULT 3;

-- Le plafond est recopié sur la fenêtre comme les autres réglages : une potion bue en
-- plein raid doit valoir ce que le serveur annonçait à l'ouverture.
ALTER TABLE "rpg_raids" ADD COLUMN "boughtAssaultsMax" INTEGER NOT NULL DEFAULT 3;

CREATE TABLE "rpg_raid_bonuses" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extraAssaults" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rpg_raid_bonuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rpg_raid_bonuses_raidId_userId_key" ON "rpg_raid_bonuses"("raidId", "userId");

ALTER TABLE "rpg_raid_bonuses" ADD CONSTRAINT "rpg_raid_bonuses_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "rpg_raids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
