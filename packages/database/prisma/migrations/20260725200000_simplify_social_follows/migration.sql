-- Simplify YouTube/Twitch follows: one Discord channel + one mention per follow
-- instead of one per event type (live/video/short). Existing per-type
-- destinations are dropped as part of the rebuild.

-- AlterTable
ALTER TABLE "youtube_channel_follows"
  DROP COLUMN "liveChannelId",
  DROP COLUMN "shortChannelId",
  DROP COLUMN "videoChannelId",
  DROP COLUMN "liveMention",
  DROP COLUMN "videoMention",
  DROP COLUMN "shortMention",
  ADD COLUMN     "discordChannelId" TEXT,
  ADD COLUMN     "mention" TEXT;

-- AlterTable
ALTER TABLE "twitch_channel_follows"
  DROP COLUMN "liveChannelId",
  DROP COLUMN "otherChannelId",
  ADD COLUMN     "discordChannelId" TEXT,
  ADD COLUMN     "mention" TEXT,
  ADD COLUMN     "liveMessage" TEXT;
