-- Objectifs de quête au delà du combat.
--
-- Le catalogue ne visait que le combat, le raid et la pêche, alors que le jeu instrumente
-- déjà l'artisanat, la forge, les deux boutiques et l'aventure. Chaque objectif manquant
-- était un type de quête que le serveur ne pouvait pas écrire, faute d'un compteur.
ALTER TYPE "RpgQuestObjective" ADD VALUE 'ITEMS_CRAFTED';
ALTER TYPE "RpgQuestObjective" ADD VALUE 'UPGRADES_SUCCEEDED';
ALTER TYPE "RpgQuestObjective" ADD VALUE 'SHOP_PURCHASES';
ALTER TYPE "RpgQuestObjective" ADD VALUE 'BLACK_MARKET_PURCHASES';
ALTER TYPE "RpgQuestObjective" ADD VALUE 'COINS_SPENT';
ALTER TYPE "RpgQuestObjective" ADD VALUE 'ADVENTURES_COMPLETED';
ALTER TYPE "RpgQuestObjective" ADD VALUE 'DAILY_CLAIMS';
