-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "providerAppId" TEXT;

-- CreateTable
CREATE TABLE "ProviderApp" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT,
    "appIdEnvVar" TEXT,
    "appSecretEnvVar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderApp_platform_slug_key" ON "ProviderApp"("platform", "slug");

-- AddForeignKey
ALTER TABLE "InstagramAccount" ADD CONSTRAINT "InstagramAccount_providerAppId_fkey" FOREIGN KEY ("providerAppId") REFERENCES "ProviderApp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

