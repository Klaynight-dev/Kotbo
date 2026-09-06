-- Récompenses de raid réglées par membre.
--
-- L'enveloppe d'une équipe suit désormais son effectif, comme sa réserve de points de vie :
-- à enveloppe fixe, une équipe d'une personne touchait autant qu'une de vingt pour une
-- épreuve bien moindre, et se scinder en équipes minuscules était la seule façon
-- rationnelle de jouer le raid.
--
-- Seules les valeurs par défaut changent ici, pour que les serveurs à venir partent sur des
-- montants cohérents avec la nouvelle lecture. Les réglages déjà saisis restent tels quels :
-- ils décrivent l'intention d'un serveur, qu'une division arbitraire trahirait. Les serveurs
-- qui jouent déjà le raid ont à les revoir depuis le dashboard.
ALTER TABLE "economy_configs" ALTER COLUMN "raidXpReward" SET DEFAULT 60;
ALTER TABLE "economy_configs" ALTER COLUMN "raidCoinReward" SET DEFAULT 45;
ALTER TABLE "economy_configs" ALTER COLUMN "raidClanPoints" SET DEFAULT 6;
