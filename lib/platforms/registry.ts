/**
 * The adapter registry.
 *
 * Typed so a platform in the Prisma enum with no adapter is a compile error,
 * rather than a lookup that returns undefined on a live webhook.
 */

import type { Platform } from "@/app/generated/prisma/client";
import type { PlatformAdapter } from "./types";
import { instagramAdapter } from "./instagram";
import { facebookAdapter } from "./facebook";
import { youtubeAdapter } from "./youtube";
import { tiktokAdapter } from "./tiktok";

const ADAPTERS = {
  INSTAGRAM: instagramAdapter,
  FACEBOOK: facebookAdapter,
  YOUTUBE: youtubeAdapter,
  TIKTOK: tiktokAdapter,
} satisfies { [P in Platform]: PlatformAdapter };

export function adapterFor(platform: Platform): PlatformAdapter {
  return ADAPTERS[platform];
}

/**
 * Platforms with no comment webhook, so the sweep is the only way they are
 * discovered. Derived from the registry rather than listed, so adding a fifth
 * platform cannot leave a stale copy behind in a caller.
 */
export function pollOnlyPlatforms(): Platform[] {
  // SAFETY: ADAPTERS is `satisfies { [P in Platform]: PlatformAdapter }`, so its
  // keys are exactly the Platform union and the compiler enforces that.
  return (Object.keys(ADAPTERS) as Platform[]).filter(
    (platform) => ADAPTERS[platform].discovery.kind === "poll"
  );
}

/**
 * Platforms a webhook delivers for, so the reconciler is their safety net
 * rather than their only path. The complement of `pollOnlyPlatforms`, derived
 * the same way so the two can never disagree.
 */
export function webhookPlatforms(): Platform[] {
  // SAFETY: ADAPTERS is `satisfies { [P in Platform]: PlatformAdapter }`, so its
  // keys are exactly the Platform union and the compiler enforces that.
  return (Object.keys(ADAPTERS) as Platform[]).filter(
    (platform) => ADAPTERS[platform].discovery.kind === "webhook"
  );
}

export { ADAPTERS };
