-- Part de consolation du raid, réglable.
--
-- Une équipe qui n'abattait pas son boss touchait le quart de l'enveloppe, chiffre écrit
-- en dur alors que tout le reste du raid se règle au dashboard - durée, assauts, énergie,
-- récompenses. Un serveur peut vouloir ne récompenser que la victoire : zéro ferme la
-- consolation.
ALTER TABLE "economy_configs" ADD COLUMN "raidConsolationShare" INTEGER NOT NULL DEFAULT 25;

-- Recopiée sur la fenêtre comme les autres réglages : une équipe qui a frappé toute la
-- nuit doit toucher ce que le serveur annonçait à l'ouverture.
ALTER TABLE "rpg_raids" ADD COLUMN "consolationShare" INTEGER NOT NULL DEFAULT 25;
