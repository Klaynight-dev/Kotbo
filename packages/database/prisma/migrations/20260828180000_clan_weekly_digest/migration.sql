-- Bilan hebdomadaire du clan, publié dans son QG.
--
-- Le salon de QG ne servait qu'à deux moments : le nettoyage d'artefacts et l'annonce de
-- fin de saison au clan vainqueur. Entre deux saisons, donc pendant des mois, il ne recevait
-- rien du bot alors que le journal des contributions a de quoi raconter chaque semaine.
--
-- Éteint par défaut : c'est un salon de discussion, et personne n'y a demandé un rapport.
ALTER TABLE "guilds" ADD COLUMN "clanWeeklyDigest" BOOLEAN NOT NULL DEFAULT false;

-- Une publication par clan et par semaine. La ligne est écrite avant l'envoi : au pire un
-- bilan manque, jamais deux ne se suivent à quelques minutes après un redémarrage.
CREATE TABLE "clan_weekly_digests" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clan_weekly_digests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clan_weekly_digests_clanId_weekKey_key" ON "clan_weekly_digests"("clanId", "weekKey");
CREATE INDEX "clan_weekly_digests_guildId_weekKey_idx" ON "clan_weekly_digests"("guildId", "weekKey");

ALTER TABLE "clan_weekly_digests" ADD CONSTRAINT "clan_weekly_digests_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clan_weekly_digests" ADD CONSTRAINT "clan_weekly_digests_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
