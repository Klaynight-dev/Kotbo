-- Marque une saison dont le podium des parieurs a déjà été récompensé.
--
-- Deux clôtures de la même saison - deux clics sur la remise à zéro qui lisent
-- le même numéro avant de l'incrémenter, ou un cron qui repasse pendant que le
-- précédent travaille encore - versaient les primes deux fois. La ligne est
-- posée avant le premier versement, et son unicité fait foi.
CREATE TABLE "clan_bet_season_awards" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "laureates" INTEGER NOT NULL DEFAULT 0,
    "awardedPoints" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clan_bet_season_awards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clan_bet_season_awards_guildId_season_key" ON "clan_bet_season_awards"("guildId", "season");

ALTER TABLE "clan_bet_season_awards" ADD CONSTRAINT "clan_bet_season_awards_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
