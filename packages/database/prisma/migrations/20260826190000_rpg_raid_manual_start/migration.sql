-- Ouverture automatique du raid, débrayable.
--
-- Un serveur peut préférer lancer son raid à la main, quand son équipe est là, plutôt
-- qu'à heure fixe. À faux, plus rien n'est planifié ni ouvert tout seul.
ALTER TABLE "economy_configs" ADD COLUMN "raidAutoSchedule" BOOLEAN NOT NULL DEFAULT true;
