-- Sanctionner un bot n'a ni victime a documenter ni membre a qui rendre des
-- comptes : le rapport de sanction n'apporte rien. Le serveur peut desormais
-- s'en dispenser. Desactive par defaut pour ne rien changer a l'existant.
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "sanctionReportSkipBots" BOOLEAN NOT NULL DEFAULT false;
