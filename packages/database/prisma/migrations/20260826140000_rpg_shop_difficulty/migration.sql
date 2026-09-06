-- Palier de difficulté appliqué au prix des objets de la boutique, indépendant des deux
-- paliers du bestiaire.
ALTER TABLE "economy_configs" ADD COLUMN "shopDifficulty" TEXT NOT NULL DEFAULT 'NORMAL';
