-- Extension du module Fun : chaîne de mots, rébus emoji, "ni oui ni non", salon
-- emoji uniquement, et bascule punitive pour les jeux à compteur (comptage,
-- chaîne de mots) - erreur = reset si actif, sinon simple suppression du message.
--
-- La table de la guilde s'appelle "guilds" (@@map), pas "Guild" : cette
-- migration visait le mauvais nom et echouait, ce qui bloquait toute la file
-- (P3009).
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funWordChainChannelId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funEmojiRiddleChannelId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funNeverSayChannelId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funEmojiOnlyChannelId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funPunitiveMode" BOOLEAN NOT NULL DEFAULT true;

-- `fun_game_states` n'a jamais eu de migration de creation : le modele existe
-- depuis le decoupage du schema, mais la base de production a ete initialisee
-- par `db push` avant qu'il n'apparaisse. Sans ce CREATE, les ALTER qui suivent
-- portent sur une table absente. Les colonnes listees ici sont celles d'avant
-- cette extension ; les nouvelles sont ajoutees juste apres, comme pour une
-- base qui possedait deja la table.
CREATE TABLE IF NOT EXISTS "fun_game_states" (
    "guildId" TEXT NOT NULL,
    "countingCurrent" INTEGER NOT NULL DEFAULT 0,
    "countingLastUserId" TEXT,
    "oneWordStoryLastUserId" TEXT,
    "guessNumberTarget" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fun_game_states_pkey" PRIMARY KEY ("guildId")
);

DO $$ BEGIN
  ALTER TABLE "fun_game_states" ADD CONSTRAINT "fun_game_states_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "fun_game_states" ADD COLUMN IF NOT EXISTS "wordChainLastWord" TEXT;
ALTER TABLE "fun_game_states" ADD COLUMN IF NOT EXISTS "wordChainLastUserId" TEXT;
ALTER TABLE "fun_game_states" ADD COLUMN IF NOT EXISTS "emojiRiddleEmojis" TEXT;
ALTER TABLE "fun_game_states" ADD COLUMN IF NOT EXISTS "emojiRiddleAnswer" TEXT;
