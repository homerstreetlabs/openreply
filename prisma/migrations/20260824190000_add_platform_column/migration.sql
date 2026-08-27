-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'FACEBOOK');

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "platform" "Platform" NOT NULL DEFAULT 'INSTAGRAM';

-- CreateIndex
CREATE INDEX "InstagramAccount_platform_idx" ON "InstagramAccount"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramAccount_platform_instagramId_key" ON "InstagramAccount"("platform", "instagramId");

