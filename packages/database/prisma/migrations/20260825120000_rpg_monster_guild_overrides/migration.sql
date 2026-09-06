-- Personnalisation du bestiaire par serveur.
--
-- Les monstres livrés de base sont globaux (guildId NULL) : les modifier depuis un
-- dashboard toucherait tous les serveurs. Un serveur qui personnalise un monstre
-- global en crée donc une copie locale portant le même nom, et cette copie masque
-- l'originale à la lecture. `enabled` permet la même chose pour une simple
-- désactivation, sans avoir à supprimer quoi que ce soit du catalogue global.
ALTER TABLE "rpg_monsters" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- Le masquage se fait par nom : deux monstres homonymes dans un même serveur
-- rendraient le résultat indéterminé. On renomme les doublons éventuels plutôt que
-- de les supprimer, leurs combats passés y étant rattachés.
UPDATE "rpg_monsters" m
SET "name" = m."name" || ' (' || substr(m."id", 1, 6) || ')'
WHERE m."guildId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "rpg_monsters" o
    WHERE o."guildId" = m."guildId" AND o."name" = m."name" AND o."id" < m."id"
  );

CREATE UNIQUE INDEX "rpg_monsters_guildId_name_key" ON "rpg_monsters"("guildId", "name");
