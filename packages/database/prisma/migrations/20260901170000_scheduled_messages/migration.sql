-- Messages programmes : nouveau type SEND_MESSAGE sur les taches planifiees.
--
-- `scheduled_tasks` n'a jamais eu de migration de creation - le modele vient du
-- db push initial. On la cree si elle manque avant d'y toucher : c'est
-- exactement ce qui a fait echouer la migration du module Fun sur
-- `fun_game_states`, et un CREATE IF NOT EXISTS ne coute rien quand la table
-- est deja la.
CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "targetId" TEXT,
    "lastRun" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scheduled_tasks_guildId_idx" ON "scheduled_tasks"("guildId");

DO $$ BEGIN
  ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "message" TEXT;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "messageEmbed" JSONB;
-- Refus par defaut : une tache qui se repete ne doit pas pinger tout le serveur
-- sans que quelqu'un l'ait explicitement voulu.
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "allowMentions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "runOnce" BOOLEAN NOT NULL DEFAULT false;
