-- Paris à plusieurs camps : pool, équipes, et paris libres que n'importe qui
-- peut rejoindre.
--
-- Le couple challenger/opponent ne monte pas au-delà de deux, et il portait
-- l'argent (escrow, dette, clan) dans ses colonnes. Il est remplacé par des
-- camps et des participants, le duel devenant deux camps d'une place. Le moteur
-- de résolution n'a plus qu'un cas à traiter : le camp gagnant se partage le
-- pot au prorata de ce que ses membres ont réellement engagé.
--
-- Les paris existants sont transférés dans la nouvelle forme plus bas. Le
-- transfert est joué avant la suppression des anciennes colonnes, faute de quoi
-- il ne resterait rien à lire.
ALTER TABLE "guilds" ADD COLUMN     "betAllowPool" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betAllowTeams" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betAllowOpen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betStakeMode" TEXT NOT NULL DEFAULT 'PER_MEMBER',
ADD COLUMN     "betMaxParticipants" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "betMaxSides" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "clan_bets" ADD COLUMN     "authorId" TEXT,
ADD COLUMN     "shape" TEXT NOT NULL DEFAULT 'DUEL',
ADD COLUMN     "access" TEXT NOT NULL DEFAULT 'TARGETED',
ADD COLUMN     "stakeMode" TEXT NOT NULL DEFAULT 'PER_MEMBER',
ADD COLUMN     "winningSideId" TEXT;

CREATE TABLE "clan_bet_sides" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "capacity" INTEGER,

    CONSTRAINT "clan_bet_sides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clan_bet_sides_betId_position_key" ON "clan_bet_sides"("betId", "position");

ALTER TABLE "clan_bet_sides" ADD CONSTRAINT "clan_bet_sides_betId_fkey" FOREIGN KEY ("betId") REFERENCES "clan_bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "clan_bet_participants" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "sideId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userKey" TEXT NOT NULL,
    "clanId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'JOINED',
    "stake" INTEGER NOT NULL DEFAULT 0,
    "escrow" INTEGER NOT NULL DEFAULT 0,
    "debt" INTEGER NOT NULL DEFAULT 0,
    "payout" INTEGER NOT NULL DEFAULT 0,
    "debtRepaid" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clan_bet_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clan_bet_participants_betId_userKey_key" ON "clan_bet_participants"("betId", "userKey");
CREATE INDEX "clan_bet_participants_betId_sideId_joinedAt_idx" ON "clan_bet_participants"("betId", "sideId", "joinedAt");
CREATE INDEX "clan_bet_participants_userId_status_idx" ON "clan_bet_participants"("userId", "status");

ALTER TABLE "clan_bet_participants" ADD CONSTRAINT "clan_bet_participants_betId_fkey" FOREIGN KEY ("betId") REFERENCES "clan_bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clan_bet_participants" ADD CONSTRAINT "clan_bet_participants_sideId_fkey" FOREIGN KEY ("sideId") REFERENCES "clan_bet_sides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Transfert des paris existants ───────────────────────────────────────────
-- Chaque pari devient deux camps d'une place, le premier pour l'auteur, le
-- second pour la personne défiée. Les identifiants de camp sont dérivés de
-- celui du pari : le participant doit pouvoir retrouver son camp sans table de
-- correspondance temporaire.
UPDATE "clan_bets" SET "authorId" = "challengerId" WHERE "authorId" IS NULL;
ALTER TABLE "clan_bets" ALTER COLUMN "authorId" SET NOT NULL;

INSERT INTO "clan_bet_sides" ("id", "betId", "position", "label", "capacity")
SELECT "id" || '-s0', "id", 0, 'Auteur', 1 FROM "clan_bets";

INSERT INTO "clan_bet_sides" ("id", "betId", "position", "label", "capacity")
SELECT "id" || '-s1', "id", 1, 'Adversaire', 1 FROM "clan_bets";

-- Le statut du participant se déduit de celui du pari : tout ce qui n'a jamais
-- dépassé la proposition n'a rien prélevé, et la personne défiée n'y était
-- qu'invitée. Un refus explicite est conservé comme tel.
INSERT INTO "clan_bet_participants"
  ("id", "betId", "sideId", "userId", "userKey", "clanId", "status", "stake", "escrow", "debt", "payout", "debtRepaid", "joinedAt")
SELECT
  gen_random_uuid()::text,
  "id",
  "id" || '-s0',
  "challengerId",
  "challengerId",
  "challengerClanId",
  'JOINED',
  "stake",
  "challengerEscrow",
  "challengerDebt",
  CASE WHEN "winnerId" = "challengerId"
    THEN "challengerEscrow" + "challengerDebt" + "opponentEscrow" + "opponentDebt"
    ELSE 0 END,
  CASE WHEN "winnerId" = "challengerId" THEN "winnerDebtRepaid" ELSE 0 END,
  "createdAt"
FROM "clan_bets";

INSERT INTO "clan_bet_participants"
  ("id", "betId", "sideId", "userId", "userKey", "clanId", "status", "stake", "escrow", "debt", "payout", "debtRepaid", "joinedAt")
SELECT
  gen_random_uuid()::text,
  "id",
  "id" || '-s1',
  "opponentId",
  "opponentId",
  "opponentClanId",
  CASE
    WHEN "status" = 'DECLINED' THEN 'DECLINED'
    WHEN "status" IN ('PENDING', 'LOCKED', 'CANCELLED', 'EXPIRED') THEN 'INVITED'
    ELSE 'JOINED'
  END,
  "stake",
  "opponentEscrow",
  "opponentDebt",
  CASE WHEN "winnerId" = "opponentId"
    THEN "challengerEscrow" + "challengerDebt" + "opponentEscrow" + "opponentDebt"
    ELSE 0 END,
  CASE WHEN "winnerId" = "opponentId" THEN "winnerDebtRepaid" ELSE 0 END,
  "createdAt"
FROM "clan_bets"
-- Le nouveau modèle n'admet qu'une ligne par personne et par pari. Une donnée
-- héritée où les deux camps portent le même identifiant - corrigée à la main,
-- importée d'ailleurs - ferait échouer toute la migration sur la contrainte
-- d'unicité, pour un pari qui n'aurait de toute façon aucun sens.
ON CONFLICT ("betId", "userKey") DO NOTHING;

-- Les propositions encore en attente sont closes plutôt que transférées.
--
-- L'ancien modèle ne prélevait rien avant l'acceptation : leur auteur arriverait
-- dans le nouveau avec une mise à zéro, et la personne défiée paierait seule un
-- pari dont l'enjeu serait la moitié de ce qui lui a été annoncé. Rien n'ayant
-- été prélevé, les clore ne coûte de points à personne.
UPDATE "clan_bets" SET "status" = 'EXPIRED', "resolvedAt" = NOW()
WHERE "status" IN ('PENDING', 'LOCKED');

UPDATE "clan_bets" SET "winningSideId" = CASE
  WHEN "winnerId" = "challengerId" THEN "id" || '-s0'
  WHEN "winnerId" = "opponentId" THEN "id" || '-s1'
  ELSE NULL
END
WHERE "winnerId" IS NOT NULL;

DROP INDEX IF EXISTS "clan_bets_guildId_challengerId_status_idx";
DROP INDEX IF EXISTS "clan_bets_guildId_opponentId_status_idx";
CREATE INDEX "clan_bets_guildId_season_status_idx" ON "clan_bets"("guildId", "season", "status");

ALTER TABLE "clan_bets" DROP COLUMN "challengerId",
DROP COLUMN "opponentId",
DROP COLUMN "challengerClanId",
DROP COLUMN "opponentClanId",
DROP COLUMN "challengerEscrow",
DROP COLUMN "opponentEscrow",
DROP COLUMN "challengerDebt",
DROP COLUMN "opponentDebt",
DROP COLUMN "challengerPlannedDebt",
DROP COLUMN "winnerId",
DROP COLUMN "winnerDebtRepaid";
