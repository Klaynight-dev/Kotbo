-- « ticket_satisfactions » n'a jamais eu de migration de creation : la table a
-- ete poussee directement par prisma db push. Les bases montees uniquement par
-- migrate deploy n'ont donc pas l'index unique declare par
-- @@unique([guildId, ticketId, userId]), ni les deux index de lecture, et
-- l'upsert du sondage y echoue avec « no unique or exclusion constraint
-- matching the ON CONFLICT specification ».

-- Un doublon ferait echouer la creation de l'index unique. On ne conserve que
-- la reponse la plus recente de chaque membre pour un ticket donne, ce qui est
-- deja la regle appliquee par l'upsert.
DELETE FROM "ticket_satisfactions" a
USING "ticket_satisfactions" b
WHERE a."guildId" = b."guildId"
  AND a."ticketId" = b."ticketId"
  AND a."userId" = b."userId"
  AND (a."respondedAt", a."id") < (b."respondedAt", b."id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_satisfactions_guildId_ticketId_userId_key" ON "ticket_satisfactions"("guildId", "ticketId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_satisfactions_guildId_staffId_idx" ON "ticket_satisfactions"("guildId", "staffId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ticket_satisfactions_guildId_createdAt_idx" ON "ticket_satisfactions"("guildId", "createdAt");
