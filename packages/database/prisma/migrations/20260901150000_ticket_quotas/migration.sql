-- Quotas tickets, chacun activable independamment. Desactive = aucune limite.
--
-- ATTENTION : `ticketQuotaOpenEnabled` arrive a false, alors que le code
-- imposait jusqu'ici un seul ticket ouvert par membre. Les serveurs qui
-- veulent garder cette limite doivent activer le quota (valeur 1).
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaOpenEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaOpenMax" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaCooldownEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaCooldownMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaPeriodEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaPeriodMax" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaPeriodHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaStaffLoadMode" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaStaffLoadMax" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaStaffLoadBypassRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaReopenEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketQuotaReopenMax" INTEGER NOT NULL DEFAULT 3;

-- Le plafond de reouvertures, lui, existait deja en dur (3). On l'active donc
-- sur les serveurs existants pour ne pas lever silencieusement une limite qui
-- servait de garde-fou anti-abus.
UPDATE "guilds" SET "ticketQuotaReopenEnabled" = true WHERE "ticketQuotaReopenEnabled" = false;
