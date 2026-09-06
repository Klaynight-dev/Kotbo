-- Index du palmarès de raid.
--
-- Les assauts ne se lisaient jusqu'ici que par équipe. Le palmarès du serveur, lui, les
-- agrège par membre sur tous les raids : sans cet index, chaque affichage balaierait la
-- table entière, qui grossit d'un raid à l'autre et ne se purge jamais.
CREATE INDEX "rpg_raid_assaults_guildId_userId_idx" ON "rpg_raid_assaults"("guildId", "userId");
