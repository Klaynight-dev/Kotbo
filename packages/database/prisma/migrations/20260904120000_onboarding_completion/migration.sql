-- Le parcours de configuration se termine, il ne se contourne plus.
--
-- Jusqu'ici, « ce serveur doit-il voir le parcours ? » se deduisait de son
-- offre : FREE sans abonnement, sans acces accorde et sans code. Une offre
-- CUSTOM posee a la main, un code d'activation genere depuis le panneau
-- d'administration ou un geste commercial suffisaient donc a faire disparaitre
-- le parcours d'un serveur qui ne l'avait jamais traverse - c'est ce qui donnait
-- l'impression qu'un administrateur du bot y echappait, alors que ce sont ses
-- serveurs qui portaient deja un acces.
--
-- La question est desormais posee au serveur lui-meme : a-t-il fini son
-- parcours ? Une seule colonne y repond, et rien d'autre - ni le plan, ni le
-- navigateur, ni l'identite du visiteur.
--
-- Reprise de l'existant : les serveurs que l'ancienne regle exemptait sont
-- marques comme ayant fini. Les rejeter dans le parcours leur ferait reposer
-- salons et roles sur une installation qui tourne depuis des mois. Les serveurs
-- actuellement dans le parcours (FREE, entres en libre-service) gardent la
-- colonne nulle : ils y restent, comme avant.

ALTER TABLE "guilds" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);

UPDATE "guilds"
SET "onboardingCompletedAt" = COALESCE("activatedAt", CURRENT_TIMESTAMP)
WHERE "plan" <> 'FREE'
   OR "stripeSubscriptionId" IS NOT NULL
   OR "accessType" <> 'PERMANENT'
   OR "activationCode" IS NOT NULL;
