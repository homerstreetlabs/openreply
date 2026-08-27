-- Additive only. Existing rows read as "route not recorded", which is honest:
-- they predate the column and cannot be attributed to one.
ALTER TABLE "WebhookEvent" ADD COLUMN "route" TEXT;
