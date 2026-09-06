-- Récompenses du podium des parieurs, remises à la clôture d'une saison.
--
-- Le palmarès des parieurs existait déjà mais ne débouchait sur rien. Les primes
-- sont versées sur la saison suivante : créditées sur celle qui vient de se
-- clore, elles n'apparaîtraient dans aucun classement consultable. Elles valent
-- zéro par défaut, pour qu'activer la récompense n'avantage pas un clan au
-- départ de la saison suivante sans décision explicite.
ALTER TABLE "guilds" ADD COLUMN     "betSeasonRewardEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betSeasonRewardRoleId" TEXT,
ADD COLUMN     "betRewardTop1" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "betRewardTop2" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "betRewardTop3" INTEGER NOT NULL DEFAULT 0;
