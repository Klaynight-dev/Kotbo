-- Ponts de salons multi-serveurs.
--
-- Un pont ne relie plus deux salons mais N : la configuration de relais vit sur le groupe,
-- chaque salon participant devient un membre avec son propre mode et son propre webhook.
--
-- Les liens existants sont recopies en groupes de deux membres, en reprenant l'identifiant
-- du lien comme identifiant du groupe : les correspondances de messages et de threads
-- suivent sans avoir a etre reliees a nouveau. Les tables "channel_links",
-- "channel_link_messages" et "channel_link_threads" ne sont plus lues par le bot mais
-- restent en place le temps de la recette ; une migration ulterieure les supprimera.

CREATE TYPE "ChannelLinkMemberMode" AS ENUM ('BOTH', 'SEND_ONLY', 'RECEIVE_ONLY');

CREATE TABLE "channel_link_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "ownerGuildId" TEXT NOT NULL,
    "relayText" BOOLEAN NOT NULL DEFAULT true,
    "relayImages" BOOLEAN NOT NULL DEFAULT true,
    "relayEmbeds" BOOLEAN NOT NULL DEFAULT false,
    "relayReactions" BOOLEAN NOT NULL DEFAULT false,
    "relayEdits" BOOLEAN NOT NULL DEFAULT true,
    "relayDeletes" BOOLEAN NOT NULL DEFAULT true,
    "relayThreads" BOOLEAN NOT NULL DEFAULT false,
    "relayPolls" BOOLEAN NOT NULL DEFAULT false,
    "relayPins" BOOLEAN NOT NULL DEFAULT true,
    "updateTopic" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_link_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "channel_link_groups_ownerGuildId_idx" ON "channel_link_groups"("ownerGuildId");
CREATE INDEX "channel_link_groups_enabled_idx" ON "channel_link_groups"("enabled");

CREATE TABLE "channel_link_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "mode" "ChannelLinkMemberMode" NOT NULL DEFAULT 'BOTH',
    "relayMode" "ChannelLinkRelayMode" NOT NULL DEFAULT 'WEBHOOK',
    "webhookId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_link_group_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_link_group_members_groupId_guildId_channelId_key" ON "channel_link_group_members"("groupId", "guildId", "channelId");
CREATE INDEX "channel_link_group_members_guildId_channelId_idx" ON "channel_link_group_members"("guildId", "channelId");
CREATE INDEX "channel_link_group_members_groupId_idx" ON "channel_link_group_members"("groupId");

-- La cle inclut le salon de destination : un message source a desormais autant de copies
-- que le pont compte de destinataires.
CREATE TABLE "channel_link_group_messages" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "relayedMessageId" TEXT NOT NULL,
    "relayedChannelId" TEXT NOT NULL,
    "relayedGuildId" TEXT NOT NULL,
    "webhookId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_link_group_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_link_group_messages_origin_dest_key" ON "channel_link_group_messages"("groupId", "sourceMessageId", "relayedChannelId");
CREATE INDEX "channel_link_group_messages_groupId_sourceMessageId_idx" ON "channel_link_group_messages"("groupId", "sourceMessageId");
CREATE INDEX "channel_link_group_messages_groupId_relayedMessageId_idx" ON "channel_link_group_messages"("groupId", "relayedMessageId");
CREATE INDEX "channel_link_group_messages_sourceChannelId_sourceMessageId_idx" ON "channel_link_group_messages"("sourceChannelId", "sourceMessageId");
CREATE INDEX "channel_link_group_messages_dest_lookup_idx" ON "channel_link_group_messages"("relayedChannelId", "relayedMessageId");
CREATE INDEX "channel_link_group_messages_createdAt_idx" ON "channel_link_group_messages"("createdAt");

CREATE TABLE "channel_link_group_threads" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sourceThreadId" TEXT NOT NULL,
    "sourceGuildId" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "relayedThreadId" TEXT NOT NULL,
    "relayedGuildId" TEXT NOT NULL,
    "relayedChannelId" TEXT NOT NULL,
    "webhookId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_link_group_threads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_link_group_threads_origin_dest_key" ON "channel_link_group_threads"("groupId", "sourceThreadId", "relayedChannelId");
CREATE INDEX "channel_link_group_threads_groupId_sourceThreadId_idx" ON "channel_link_group_threads"("groupId", "sourceThreadId");
CREATE INDEX "channel_link_group_threads_groupId_relayedThreadId_idx" ON "channel_link_group_threads"("groupId", "relayedThreadId");

ALTER TABLE "channel_link_groups" ADD CONSTRAINT "channel_link_groups_ownerGuildId_fkey" FOREIGN KEY ("ownerGuildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_link_group_members" ADD CONSTRAINT "channel_link_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "channel_link_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_link_group_members" ADD CONSTRAINT "channel_link_group_members_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_link_group_messages" ADD CONSTRAINT "channel_link_group_messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "channel_link_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_link_group_threads" ADD CONSTRAINT "channel_link_group_threads_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "channel_link_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Une invitation fait desormais rejoindre un pont existant. Les invitations sans groupe
-- sont celles de l'ancien systeme, laissees telles quelles jusqu'a leur expiration.
ALTER TABLE "channel_link_invites" ADD COLUMN "groupId" TEXT;
ALTER TABLE "channel_link_invites" ADD COLUMN "memberMode" "ChannelLinkMemberMode" NOT NULL DEFAULT 'BOTH';
ALTER TABLE "channel_link_invites" ADD CONSTRAINT "channel_link_invites_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "channel_link_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Reprise des liens existants ────────────────────────────────────────────────

INSERT INTO "channel_link_groups" (
    "id", "ownerGuildId", "relayText", "relayImages", "relayEmbeds", "relayReactions",
    "relayEdits", "relayDeletes", "relayThreads", "relayPolls", "relayPins",
    "updateTopic", "enabled", "createdByUserId", "createdAt", "updatedAt"
)
SELECT
    l."id",
    -- Le serveur createur n'a jamais eu de cle etrangere : s'il a disparu, le pont
    -- revient au serveur source plutot que d'etre perdu avec lui.
    CASE
      WHEN EXISTS (SELECT 1 FROM "guilds" g WHERE g."id" = l."createdByGuildId") THEN l."createdByGuildId"
      ELSE l."sourceGuildId"
    END,
    l."relayText", l."relayImages", l."relayEmbeds", l."relayReactions",
    l."relayEdits", l."relayDeletes", l."relayThreads", l."relayPolls", l."relayPins",
    l."updateTopic", l."enabled", l."createdByUserId", l."createdAt", l."updatedAt"
FROM "channel_links" l
-- Un lien degenere (meme salon des deux cotes) donnerait deux membres identiques,
-- que la cle unique du groupe refuserait : il n'a de toute facon jamais rien relaye.
WHERE NOT (l."sourceGuildId" = l."targetGuildId" AND l."sourceChannelId" = l."targetChannelId");

-- Un lien unidirectionnel allait de la source vers la cible : la source emet, la cible recoit.
INSERT INTO "channel_link_group_members" (
    "id", "groupId", "guildId", "channelId", "mode", "relayMode", "webhookId",
    "enabled", "addedByUserId", "createdAt", "updatedAt"
)
SELECT
    l."id" || '-src', l."id", l."sourceGuildId", l."sourceChannelId",
    (CASE WHEN l."direction" = 'UNIDIRECTIONAL' THEN 'SEND_ONLY' ELSE 'BOTH' END)::"ChannelLinkMemberMode",
    l."sourceRelayMode", l."sourceWebhookId", true, l."createdByUserId", l."createdAt", l."updatedAt"
FROM "channel_links" l
JOIN "channel_link_groups" g ON g."id" = l."id"
WHERE EXISTS (SELECT 1 FROM "guilds" gu WHERE gu."id" = l."sourceGuildId");

INSERT INTO "channel_link_group_members" (
    "id", "groupId", "guildId", "channelId", "mode", "relayMode", "webhookId",
    "enabled", "addedByUserId", "createdAt", "updatedAt"
)
SELECT
    l."id" || '-tgt', l."id", l."targetGuildId", l."targetChannelId",
    (CASE WHEN l."direction" = 'UNIDIRECTIONAL' THEN 'RECEIVE_ONLY' ELSE 'BOTH' END)::"ChannelLinkMemberMode",
    l."targetRelayMode", l."targetWebhookId", true, l."createdByUserId", l."createdAt", l."updatedAt"
FROM "channel_links" l
JOIN "channel_link_groups" g ON g."id" = l."id"
WHERE EXISTS (SELECT 1 FROM "guilds" gu WHERE gu."id" = l."targetGuildId");

-- L'ancienne table ne stockait pas le serveur du salon relaye, ni le salon parent d'un
-- thread : les deux se deduisent du lien. Un lien dont les deux bouts vivent sur le meme
-- serveur ne permet pas de trancher pour un thread ; la ligne recopiee pointe alors le
-- salon source, et le thread se resynchronisera au prochain message s'il s'agissait de
-- l'autre.
INSERT INTO "channel_link_group_messages" (
    "id", "groupId", "sourceMessageId", "sourceChannelId", "relayedMessageId",
    "relayedChannelId", "relayedGuildId", "webhookId", "createdAt"
)
SELECT
    m."id", m."channelLinkId", m."sourceMessageId", m."sourceChannelId", m."relayedMessageId",
    m."relayedChannelId",
    CASE WHEN m."relayedChannelId" = l."sourceChannelId" THEN l."sourceGuildId" ELSE l."targetGuildId" END,
    m."webhookId", m."createdAt"
FROM "channel_link_messages" m
JOIN "channel_links" l ON l."id" = m."channelLinkId"
JOIN "channel_link_groups" g ON g."id" = m."channelLinkId";

INSERT INTO "channel_link_group_threads" (
    "id", "groupId", "sourceThreadId", "sourceGuildId", "sourceChannelId",
    "relayedThreadId", "relayedGuildId", "relayedChannelId", "webhookId", "createdAt"
)
SELECT
    t."id", t."channelLinkId", t."sourceThreadId", t."sourceGuildId",
    CASE WHEN t."sourceGuildId" = l."sourceGuildId" THEN l."sourceChannelId" ELSE l."targetChannelId" END,
    t."relayedThreadId", t."relayedGuildId",
    CASE WHEN t."relayedGuildId" = l."sourceGuildId" THEN l."sourceChannelId" ELSE l."targetChannelId" END,
    t."webhookId", t."createdAt"
FROM "channel_link_threads" t
JOIN "channel_links" l ON l."id" = t."channelLinkId"
JOIN "channel_link_groups" g ON g."id" = t."channelLinkId";
