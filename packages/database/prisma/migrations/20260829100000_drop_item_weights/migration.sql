-- Taux de rareté par objet dans un drop.
--
-- La liste ne disait que « ces objets peuvent tomber », à chances égales. Un serveur veut
-- pouvoir rendre une pièce rare : 1 % pour l'une, 49 et 50 pour les deux autres.
--
-- La colonne précédente est remplacée plutôt que complétée. Deux tableaux parallèles - les
-- identifiants d'un côté, les taux de l'autre - se désynchronisent au premier oubli, et le
-- tirage lirait alors un poids qui appartient à un autre objet.
ALTER TABLE "drop_configs" DROP COLUMN IF EXISTS "itemIds";
ALTER TABLE "drop_configs" ADD COLUMN "items" JSONB NOT NULL DEFAULT '[]';
