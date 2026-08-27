/**
 * Which credentials connect an account.
 *
 * One Meta app cannot hold both an Instagram-Login setup and a Facebook-Login
 * Instagram setup, and use cases are irreversible once added. So the fallback
 * for a greyed-out dashboard is a second app, and that has to be a row rather
 * than a rename of two environment variables.
 *
 * The row records which app exists and what it is for. The secret itself never
 * touches the database: the row names the environment variables, and the Worker
 * holds the values.
 */

import { prisma } from "@/lib/db/client";
import type { Platform } from "@/app/generated/prisma/client";

export interface ProviderAppCredentials {
  readonly id: string;
  readonly slug: string;
  readonly platform: Platform;
  readonly appId: string;
  readonly appSecret: string;
}

/** The variables a platform falls back to when no row names its own. */
const DEFAULT_ENV = {
  INSTAGRAM: { id: "INSTAGRAM_APP_ID", secret: "INSTAGRAM_APP_SECRET" },
  FACEBOOK: { id: "FACEBOOK_APP_ID", secret: "FACEBOOK_APP_SECRET" },
  YOUTUBE: { id: "YOUTUBE_CLIENT_ID", secret: "YOUTUBE_CLIENT_SECRET" },
  TIKTOK: { id: "TIKTOK_CLIENT_KEY", secret: "TIKTOK_CLIENT_SECRET" },
} as const satisfies Record<Platform, { id: string; secret: string }>;

export class ProviderAppUnavailable extends Error {
  constructor(platform: Platform, missing: readonly string[]) {
    super(
      `${platform} is not configured on this instance. Missing: ${missing.join(", ")}.`
    );
    this.name = "ProviderAppUnavailable";
  }
}

/**
 * Resolve the credentials for one platform.
 *
 * Falls back to the default variables when no row exists, which is what keeps
 * the original single-app Instagram install working untouched. Throws rather
 * than returning null, so a half-configured platform fails at the connect
 * button with the variable names rather than at the OAuth redirect with a
 * message from the vendor.
 */
export async function lookupProviderApp(
  platform: Platform,
  slug = "main"
): Promise<ProviderAppCredentials> {
  const row = await prisma.providerApp.findUnique({
    where: { platform_slug: { platform, slug } },
    select: { id: true, slug: true, appIdEnvVar: true, appSecretEnvVar: true },
  });

  const idVar = row?.appIdEnvVar ?? DEFAULT_ENV[platform].id;
  const secretVar = row?.appSecretEnvVar ?? DEFAULT_ENV[platform].secret;

  const appId = process.env[idVar];
  const appSecret = process.env[secretVar];

  if (!appId || !appSecret) {
    const missing = [!appId ? idVar : null, !appSecret ? secretVar : null].filter(
      (name): name is string => name !== null
    );
    throw new ProviderAppUnavailable(platform, missing);
  }

  return {
    id: row?.id ?? `env:${platform.toLowerCase()}`,
    slug: row?.slug ?? slug,
    platform,
    appId,
    appSecret,
  };
}

/** Whether this instance can connect a platform at all. */
export async function platformIsConfigured(platform: Platform): Promise<boolean> {
  try {
    await lookupProviderApp(platform);
    return true;
  } catch {
    return false;
  }
}
