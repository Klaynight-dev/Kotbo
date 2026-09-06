-- Part à crédit d'un mouvement de points de clan.
--
-- Une mise payée en partie avec des points qu'on ne possède pas ne bouge le
-- score que du montant réellement prélevé ; le reste ouvre une dette, invisible
-- dans le flux public. Le remboursement, lui, y apparaît plus tard : le lecteur
-- voit une ligne « dette » sans jamais avoir vu l'emprunt. Journaliser celui-ci
-- comme un mouvement à part le compterait deux fois dans une colonne de score,
-- d'où cette colonne portée par la ligne de mise elle-même.
ALTER TABLE "clan_contribution_events" ADD COLUMN "credit" INTEGER;
