-- Drops d'objets RPG.
--
-- Un drop ne pouvait verser que de l'XP, des points de clan ou des pièces, alors que le
-- RPG a un catalogue entier d'objets avec leurs raretés. « +50 pièces » ne fait cliquer
-- personne deux fois ; une arme trouvée dans un salon, si.
--
-- Rien n'est tiré au hasard dans tout le catalogue : le serveur liste les objets qu'il
-- accepte de voir tomber. Liste vide, aucun drop n'est publié.
ALTER TABLE "drop_configs" ADD COLUMN "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- L'objet est tiré à la publication et non au clic : le message annonce une piece
-- precise, elle ne peut pas changer entre l'annonce et le ramassage.
ALTER TABLE "drops" ADD COLUMN "itemId" TEXT;
