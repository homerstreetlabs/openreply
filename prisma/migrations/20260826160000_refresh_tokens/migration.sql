-- Additive only. Instagram refreshes by presenting the access token itself and
-- Facebook Page tokens never expire, so every existing row is correct as null.
ALTER TABLE "InstagramAccount" ADD COLUMN "refreshToken" TEXT;
