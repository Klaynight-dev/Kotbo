-- Instantané des dettes à la clôture d'une saison.
--
-- La dette n'a pas de saison : elle suit le membre et se rembourse au fil de ses
-- gains, sans jamais repartir de zéro. Rien ne permettait donc de revenir à ce
-- qu'un membre devait à la fin d'une saison donnée - qui devait 500 à la fin de
-- la saison 1 et n'en devait plus que 100 deux saisons plus tard gardait ses 100
-- après un retour arrière, alors que la saison 1 s'était close sur 500.
CREATE TABLE "clan_debt_snapshots" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'BET',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clan_debt_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clan_debt_snapshots_guildId_season_userId_key" ON "clan_debt_snapshots"("guildId", "season", "userId");
CREATE INDEX "clan_debt_snapshots_guildId_season_idx" ON "clan_debt_snapshots"("guildId", "season");

ALTER TABLE "clan_debt_snapshots" ADD CONSTRAINT "clan_debt_snapshots_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
