-- CreateTable
CREATE TABLE "MessagingContact" (
    "id" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "channelAddress" TEXT,
    "displayName" TEXT,
    "windowExpiresAt" TIMESTAMP(3),
    "messagesRemaining" INTEGER,
    "firstContactAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessagingContact_connectedAccountId_windowExpiresAt_idx" ON "MessagingContact"("connectedAccountId", "windowExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingContact_connectedAccountId_platformUserId_key" ON "MessagingContact"("connectedAccountId", "platformUserId");

-- AddForeignKey
ALTER TABLE "MessagingContact" ADD CONSTRAINT "MessagingContact_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

