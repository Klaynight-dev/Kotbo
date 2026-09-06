-- Apport du RPG au classement des clans.
--
-- Chaque créature du bestiaire porte sa propre prime, réglée au dashboard, et
-- l'interrupteur de serveur permet de couper l'ensemble sans remettre ces
-- primes à zéro une par une.
ALTER TABLE "rpg_monsters" ADD COLUMN "clanPoints" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "guilds" ADD COLUMN "clanPointsFromRpg" BOOLEAN NOT NULL DEFAULT false;
