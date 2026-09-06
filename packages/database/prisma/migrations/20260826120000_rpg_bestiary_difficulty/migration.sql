-- Palier de difficulté du bestiaire, réglé séparément pour les boss et pour les
-- monstres ordinaires.
--
-- Rien n'est calculé à partir de ces colonnes pendant le jeu : appliquer un palier
-- réécrit les statistiques sur les fiches des créatures. La valeur ne sert qu'à
-- savoir de quel palier partir la fois suivante, sans quoi deux applications
-- successives se multiplieraient entre elles.
ALTER TABLE "economy_configs" ADD COLUMN "bossDifficulty" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "economy_configs" ADD COLUMN "monsterDifficulty" TEXT NOT NULL DEFAULT 'NORMAL';
