-- AlterTable
ALTER TABLE "guilds" ADD COLUMN     "ticketSatisfactionLogChannelId" TEXT,
ADD COLUMN     "ticketSatisfactionLogAnonymous" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ticket_satisfactions" ADD COLUMN     "reviewLogChannelId" TEXT,
ADD COLUMN     "reviewLogMessageId" TEXT;
