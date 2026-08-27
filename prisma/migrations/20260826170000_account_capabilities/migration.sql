-- Additive only. An empty array means "never negotiated", which callers read as
-- "fall back to the platform ceiling" — exactly today's behaviour for every
-- existing row.
ALTER TABLE "InstagramAccount" ADD COLUMN "grantedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "InstagramAccount" ADD COLUMN "region" TEXT;
ALTER TABLE "InstagramAccount" ADD COLUMN "declinedCapabilities" JSONB;
ALTER TABLE "InstagramAccount" ADD COLUMN "capabilitiesAt" TIMESTAMP(3);
