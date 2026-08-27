-- CreateEnum
CREATE TYPE "PlatformGrantTier" AS ENUM ('SUPPORT_READ', 'SUPPORT_FULL', 'ADMIN');

-- CreateTable
CREATE TABLE "CreatorInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "creatorName" TEXT,
    "token" TEXT NOT NULL,
    "status" "WorkspaceInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByUserId" TEXT,
    "workspaceId" TEXT,
    "deliveryError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "PlatformGrantTier" NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "PlatformGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorInvitation_email_key" ON "CreatorInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorInvitation_token_key" ON "CreatorInvitation"("token");

-- CreateIndex
CREATE INDEX "CreatorInvitation_status_idx" ON "CreatorInvitation"("status");

-- CreateIndex
CREATE INDEX "CreatorInvitation_email_idx" ON "CreatorInvitation"("email");

-- CreateIndex
CREATE INDEX "PlatformGrant_userId_revokedAt_idx" ON "PlatformGrant"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "PlatformGrant_tier_idx" ON "PlatformGrant"("tier");

-- AddForeignKey
ALTER TABLE "CreatorInvitation" ADD CONSTRAINT "CreatorInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorInvitation" ADD CONSTRAINT "CreatorInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformGrant" ADD CONSTRAINT "PlatformGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformGrant" ADD CONSTRAINT "PlatformGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

