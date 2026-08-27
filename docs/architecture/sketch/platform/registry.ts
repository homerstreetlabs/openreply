/**
 * The registry, and the answer to "how many files does a fifth platform
 * touch?"
 *
 *   1. `platform/<name>.ts`      the adapter                        NEW
 *   2. `platform/capability.ts`  one key in `PlatformCeiling`       +1 line
 *   3. `platform/registry.ts`    one entry in `ADAPTERS`            +1 line
 *   4. `schema.prisma`           one value in `enum Platform`       +1 line
 *
 * That is it. Specifically NOT touched:
 *   - the ingest route — it is `/api/ingest/[platform]/[slug]`, one file
 *   - the engine — no platform is named in it
 *   - the quota broker — a new rate-limit shape is a new `Capacity` variant
 *     only if it is genuinely new; the four known shapes already cover fixed,
 *     derived, two-level and pooled
 *   - the scheduler — `SweepSpec` covers primary, safety-net and none
 *   - the campaign builder UI — it renders from `availableSteps(caps)`
 *   - the admin overview — it reads `Incident`, which is platform-neutral
 *   - the tests for any existing platform
 *
 * The cost of a fifth platform is the cost of learning that platform's API,
 * which is irreducible. The cost of INTEGRATING it is one file.
 */

import type { PlatformAdapter } from "./adapter";
import type { PlatformId } from "./capability";
import { facebookAdapter } from "./facebook";
import { instagramAdapter } from "./instagram";
import { tiktokAdapter } from "./tiktok";
import { youtubeAdapter } from "./youtube";

/**
 * Typed so a missing platform is a compile error and a mistyped adapter cannot
 * be registered under the wrong key.
 */
export const ADAPTERS: { [P in PlatformId]: PlatformAdapter<P> } = {
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  youtube: youtubeAdapter,
  tiktok: tiktokAdapter,
};

export function adapterFor<P extends PlatformId>(platform: P): PlatformAdapter<P> {
  return ADAPTERS[platform];
}

/**
 * Cross-checks run once at module load, in a test, and in CI. These are the
 * invariants that hold ACROSS adapters and therefore have no natural home
 * inside one.
 *
 *   1. `ingest === null` implies `sweep?.priority === "primary"`. A platform
 *      with neither a webhook nor a primary sweep can never discover a
 *      comment, which would be a silent no-op product.
 *   2. `FOLLOW_GATE` in the ceiling implies `probeFollowStatus` is present.
 *      Type-level unconstructability and runtime executability must agree.
 *   3. Every `ExclusiveClaim.scope` an adapter can emit is prefixed with its
 *      own platform id, so two platforms cannot collide on a shared id space.
 *   4. Every capability in a ceiling is either granted or explained by
 *      `negotiate` for a fully-authorised account. No silent gaps in the UI.
 */
export function assertRegistryInvariants(): void {
  throw new Error("not implemented");
}

/**
 * Resolve the app whose credentials signed an inbound webhook, from the route
 * path. `/api/ingest/instagram/main` -> the ProviderApp row (platform,
 * slug) -> exactly one webhook secret.
 *
 * Multiple rows per platform are expected: one Meta app for Instagram-Login and
 * a second for Pages/Messenger, because one app cannot hold both setups.
 */
export async function lookupProviderApp(
  platform: PlatformId,
  slug: string
): Promise<import("./adapter").ProviderApp | null> {
  throw new Error("not implemented");
}
