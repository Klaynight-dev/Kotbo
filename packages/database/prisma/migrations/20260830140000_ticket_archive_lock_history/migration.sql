-- Archivage, verrou anti-suppression et panneau d'historique des tickets.
--
-- Trois besoins distincts qui touchent la meme table :
--   1. Archiver un ticket sans le supprimer : le salon survit en lecture seule
--      dans une categorie dediee, et le staff peut le remettre en service.
--   2. Verrouiller un ticket contre toute suppression, avec ou sans echeance.
--   3. Laisser un membre retrouver ses anciens tickets sous l'embed d'ouverture,
--      y compris quand il est blackliste si la blacklist l'autorise.

ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

ALTER TABLE "tickets"
ADD COLUMN IF NOT EXISTS "archivedById"           TEXT,
ADD COLUMN IF NOT EXISTS "archivedByName"         TEXT,
ADD COLUMN IF NOT EXISTS "archivedAt"             TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "archivedFromCategoryId" TEXT,
ADD COLUMN IF NOT EXISTS "deletionLocked"         BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "deletionLockedUntil"    TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletionLockedById"     TEXT,
ADD COLUMN IF NOT EXISTS "deletionLockedByName"   TEXT,
ADD COLUMN IF NOT EXISTS "deletionLockReason"     TEXT;

ALTER TABLE "ticket_blacklist"
ADD COLUMN IF NOT EXISTS "allowReopen" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "guilds"
ADD COLUMN IF NOT EXISTS "ticketArchiveCategoryId"     TEXT,
ADD COLUMN IF NOT EXISTS "ticketArchiveKeepOpenerView" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "ticketHistoryPanelEnabled"   BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "ticketSelfReopenEnabled"     BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "ticketSelfDeleteEnabled"     BOOLEAN NOT NULL DEFAULT false;
