-- Salons exclus des logs avances.
--
-- Les evenements de message (suppression, edition, purge) et de vocal
-- (arrivee, depart, deplacement) ne sont plus journalises quand ils viennent
-- d'un de ces salons. Un fil suit l'exclusion de son salon parent.

ALTER TABLE "guilds"
ADD COLUMN IF NOT EXISTS "logIgnoredChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
