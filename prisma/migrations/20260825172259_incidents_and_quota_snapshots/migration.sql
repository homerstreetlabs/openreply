-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('TOKEN_EXPIRED', 'TOKEN_REFRESH_FAILED', 'REAUTH_REQUIRED', 'PERMISSION_REVOKED', 'WEBHOOK_UNSUBSCRIBED', 'REGION_INELIGIBLE', 'PLAN_INVALIDATED', 'QUOTA_EXHAUSTED', 'DELIVERY_FAILING', 'QUEUE_BACKLOG', 'POLICY_HOLD', 'EMAIL_SUPPRESSED', 'NO_ACTIVE_CAMPAIGNS');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "connectedAccountId" TEXT,
    "campaignId" TEXT,
    "kind" "IncidentKind" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "openKey" "IncidentKind",

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotaSnapshot" (
    "id" TEXT NOT NULL,
    "bucketName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "connectedAccountId" TEXT,
    "providerAppId" TEXT,
    "workspaceId" TEXT,
    "used" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "shareUsed" INTEGER,
    "shareCeiling" INTEGER,
    "windowResetsAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_workspaceId_idx" ON "Incident"("workspaceId");

-- CreateIndex
CREATE INDEX "Incident_kind_idx" ON "Incident"("kind");

-- CreateIndex
CREATE INDEX "Incident_severity_lastSeenAt_idx" ON "Incident"("severity", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Incident_resolvedAt_idx" ON "Incident"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_connectedAccountId_openKey_key" ON "Incident"("connectedAccountId", "openKey");

-- CreateIndex
CREATE UNIQUE INDEX "QuotaSnapshot_bucketName_key" ON "QuotaSnapshot"("bucketName");

-- CreateIndex
CREATE INDEX "QuotaSnapshot_connectedAccountId_idx" ON "QuotaSnapshot"("connectedAccountId");

-- CreateIndex
CREATE INDEX "QuotaSnapshot_providerAppId_idx" ON "QuotaSnapshot"("providerAppId");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotaSnapshot" ADD CONSTRAINT "QuotaSnapshot_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
