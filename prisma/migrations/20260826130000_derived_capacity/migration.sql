-- Additive only. Both columns are nullable, so existing rows read as
-- "never measured" and the broker falls back to the floor, which is the
-- under-granting direction the Capacity variant was designed around.
ALTER TABLE "InstagramAccount" ADD COLUMN "derivedCapacityUnits" INTEGER;
ALTER TABLE "InstagramAccount" ADD COLUMN "derivedCapacityAt" TIMESTAMP(3);
