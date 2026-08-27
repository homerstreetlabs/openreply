-- CreateTable
CREATE TABLE "DeliveryClaim" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryClaim_automationId_idx" ON "DeliveryClaim"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryClaim_scope_key_key" ON "DeliveryClaim"("scope", "key");

-- AddForeignKey
ALTER TABLE "DeliveryClaim" ADD CONSTRAINT "DeliveryClaim_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill from history. Without this, every comment already answered before the
-- ledger existed looks unclaimed, and a redelivered webhook or a polling sweep
-- would send a second private reply to someone who already got one.
--
-- Only bare comment ids qualify. DmLog.commentId is overloaded: `reveal:<user>`
-- rows are button taps and `dm:<mid>` rows are inbound-message triggers, and
-- neither consumes a comment's one-shot reply.
--
-- Every pre-existing row is Instagram, because the platform column was added
-- with DEFAULT 'INSTAGRAM' and Facebook could not be connected before it.
INSERT INTO "DeliveryClaim" ("id", "scope", "key", "automationId", "runKey", "createdAt")
SELECT
    gen_random_uuid()::text,
    'ig:private_reply',
    d."commentId",
    MIN(d."automationId"),
    'backfill',
    MIN(d."dmSentAt")
FROM "DmLog" d
WHERE d."status" = 'SENT'
  AND d."commentId" NOT LIKE 'reveal:%'
  AND d."commentId" NOT LIKE 'dm:%'
GROUP BY d."commentId"
ON CONFLICT ("scope", "key") DO NOTHING;
