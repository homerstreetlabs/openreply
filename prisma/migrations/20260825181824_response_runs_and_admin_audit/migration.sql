-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN     "awaitUntil" TIMESTAMP(3),
ADD COLUMN     "awaitingSignals" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "commentExternalId" TEXT,
ADD COLUMN     "cursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseToken" TEXT,
ADD COLUMN     "onTimeout" TEXT,
ADD COLUMN     "postExternalId" TEXT;

-- CreateTable
CREATE TABLE "StepOutcome" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "DmStatus" NOT NULL,
    "externalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAccessLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "grantId" TEXT,
    "action" TEXT NOT NULL,
    "tier" "PlatformGrantTier" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepOutcome_runId_idx" ON "StepOutcome"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "StepOutcome_runId_stepIndex_key" ON "StepOutcome"("runId", "stepIndex");

-- CreateIndex
CREATE INDEX "AdminAccessLog_workspaceId_createdAt_idx" ON "AdminAccessLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAccessLog_adminUserId_createdAt_idx" ON "AdminAccessLog"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "DmLog_awaitUntil_idx" ON "DmLog"("awaitUntil");

-- CreateIndex
CREATE INDEX "DmLog_instagramAccountId_commenterId_idx" ON "DmLog"("instagramAccountId", "commenterId");

-- AddForeignKey
ALTER TABLE "StepOutcome" ADD CONSTRAINT "StepOutcome_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DmLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAccessLog" ADD CONSTRAINT "AdminAccessLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAccessLog" ADD CONSTRAINT "AdminAccessLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAccessLog" ADD CONSTRAINT "AdminAccessLog_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PlatformGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
