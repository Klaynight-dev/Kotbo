-- AlterTable: EconomyConfig anti-abuse guards (gambling caps, transfer caps)
ALTER TABLE "economy_configs"
  ADD COLUMN "maxBetAmount" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "maxDailyBets" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "maxTransferAmount" INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN "transferCooldownMin" INTEGER NOT NULL DEFAULT 15;

-- AlterTable: RpgProfile energy regen fix + adventure cooldown + gambling/transfer anti-abuse
ALTER TABLE "rpg_profiles"
  ADD COLUMN "lastTravelEndedAt" TIMESTAMP(3),
  ADD COLUMN "lastEnergyTick" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "dailyBetCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dailyBetWindowStart" TIMESTAMP(3),
  ADD COLUMN "lastTransferAt" TIMESTAMP(3);

-- Backfill lastEnergyTick for existing rows so regen timing starts fresh instead of from NULL
UPDATE "rpg_profiles" SET "lastEnergyTick" = "updatedAt" WHERE "lastEnergyTick" IS NULL;
