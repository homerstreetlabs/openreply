-- Claims become leases: a row is reclaimable until the send is confirmed.
--
-- No DDL. `expiresAt` was written and never read, so the column is repurposed
-- via @map rather than renamed, and every existing row is settled to NULL.
-- Rows written by the old code were only ever held on a successful send or an
-- unknown outcome, and treating those as permanent is exactly today's
-- behaviour. Leaving them non-null would make historical claims reclaimable and
-- let a second campaign spend a reply the platform has already refused.
UPDATE "DeliveryClaim" SET "expiresAt" = NULL WHERE "expiresAt" IS NOT NULL;
