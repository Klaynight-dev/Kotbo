-- Le parcours de configuration se souvient d'un appareil a l'autre.
--
-- Jusqu'ici, la progression et les reponses ne vivaient que dans le
-- `localStorage` du navigateur. Commencer sur un poste et finir sur un autre
-- repartait du premier ecran, et le tableau de bord n'avait aucun moyen de
-- savoir ou quelqu'un s'etait arrete pour lui proposer de reprendre.
--
-- Le navigateur reste la source rapide - il ecrit a chaque clic, sans attendre
-- le reseau - et cette colonne recoit la meme chose a chaque etape validee. Au
-- chargement, la version la plus avancee des deux l'emporte.
--
-- Nulle pour tout le monde a la pose : un parcours en cours ailleurs reprendra
-- simplement depuis ce que le navigateur porte, comme avant.

ALTER TABLE "guilds" ADD COLUMN "onboardingState" JSONB;
