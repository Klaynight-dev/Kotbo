-- Objets de boutique qui versent des récompenses des modules voisins.
--
-- La boutique RPG peut vendre de l'XP du module Niveaux et des points de clan.
-- Les deux colonnes valent zéro par défaut : aucun objet existant ne change de
-- comportement, et un objet qui en porte est retiré de la vente tant que le
-- module concerné est éteint.
ALTER TABLE "rpg_items" ADD COLUMN "levelXpReward" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "rpg_items" ADD COLUMN "clanPointsReward" INTEGER NOT NULL DEFAULT 0;
