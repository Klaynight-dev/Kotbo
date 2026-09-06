-- Retrait d'un objet du tirage du marché noir.
--
-- Le tirage prenait tout objet achetable. Un objet qui vend de l'XP ou des points
-- de clan s'y retrouvait bradé de 20 à 50 %, ce qui vide de son sens le prix fixé
-- au dashboard. L'exclusion est un réglage par objet, et non une règle en dur :
-- un serveur peut vouloir de vraies promotions dessus.
ALTER TABLE "rpg_items" ADD COLUMN "blackMarketEligible" BOOLEAN NOT NULL DEFAULT true;

-- Les objets à récompense de module n'existent pas encore en base (colonnes créées
-- par la migration précédente), mais la mise à jour reste écrite pour le cas d'une
-- base où ces valeurs auraient déjà été posées à la main.
UPDATE "rpg_items"
SET "blackMarketEligible" = false
WHERE "levelXpReward" > 0 OR "clanPointsReward" > 0;
