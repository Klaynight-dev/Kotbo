-- Paris nominatifs entre deux membres, réglés en points de clan.
--
-- Les mises sont prélevées à l'acceptation et conservées dans les colonnes
-- d'escrow : le verdict ne fait que redistribuer ce qui a réellement été pris.
-- Quand le mode dette est ouvert, la part non couverte par les points devient
-- une ligne de `clan_point_debts`, remboursée sur les gains futurs.
ALTER TABLE "guilds" ADD COLUMN     "betsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betChannelId" TEXT,
ADD COLUMN     "betAnnouncementChannelId" TEXT,
ADD COLUMN     "betMinStake" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "betMaxStake" INTEGER NOT NULL DEFAULT 10000,
ADD COLUMN     "betMaxOpenPerMember" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "betAcceptWindowHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "betAllowDebt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betMaxDebt" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "betDebtResetOnSeason" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "betResolverRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "clan_bets" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "threadId" TEXT,
    "challengerId" TEXT NOT NULL,
    "opponentId" TEXT NOT NULL,
    "challengerClanId" TEXT,
    "opponentClanId" TEXT,
    "challengerEscrow" INTEGER NOT NULL DEFAULT 0,
    "opponentEscrow" INTEGER NOT NULL DEFAULT 0,
    "challengerDebt" INTEGER NOT NULL DEFAULT 0,
    "opponentDebt" INTEGER NOT NULL DEFAULT 0,
    "challengerPlannedDebt" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT NOT NULL,
    "stake" INTEGER NOT NULL,
    "season" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "winnerId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "winnerDebtRepaid" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clan_bets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "clan_bets_guildId_status_expiresAt_idx" ON "clan_bets"("guildId", "status", "expiresAt");
CREATE INDEX "clan_bets_guildId_challengerId_status_idx" ON "clan_bets"("guildId", "challengerId", "status");
CREATE INDEX "clan_bets_guildId_opponentId_status_idx" ON "clan_bets"("guildId", "opponentId", "status");

ALTER TABLE "clan_bets" ADD CONSTRAINT "clan_bets_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dette de points de clan. Sans saison : une dette rattachée à la saison en
-- cours s'effacerait en attendant la clôture.
CREATE TABLE "clan_point_debts" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'BET',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clan_point_debts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clan_point_debts_guildId_userId_key" ON "clan_point_debts"("guildId", "userId");
CREATE INDEX "clan_point_debts_guildId_amount_idx" ON "clan_point_debts"("guildId", "amount");

ALTER TABLE "clan_point_debts" ADD CONSTRAINT "clan_point_debts_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
