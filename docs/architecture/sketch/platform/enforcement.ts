/**
 * enforcement.ts — the two checks that make this design's structural claims
 * fail the build instead of drifting.
 *
 * GRAFTED from arena candidate 2 (`sketch/platform/registry.ts`, `sketch/usage.ts`).
 *
 * These are distinct from `assertRegistryInvariants()` in `registry.ts`. That
 * function checks invariants ACROSS adapters at runtime ("a platform with no
 * webhook must have a primary sweep"). These two check invariants about the
 * SHAPE OF THE SOURCE TREE, and they can only run as tests:
 *
 *   1. The adapter registry and the Prisma `Platform` enum agree.
 *   2. No platform name appears anywhere in the platform-agnostic core.
 *
 * Claim 2 is the one that rots silently. "The engine contains zero
 * `platform ===`" is true the day it is written and untrue the first time
 * someone is in a hurry. A grep in CI is worth more than a paragraph in a
 * design document.
 */

import { PLATFORM_IDS, type PlatformId } from "./capability";

// ─── 1. Registry completeness ────────────────────────────────────────────────

/**
 * The typed registry `{ [P in PlatformId]: PlatformAdapter<P> }` already makes
 * a MISSING adapter a compile error. What it cannot see is the database: a
 * platform present in the Prisma `Platform` enum but absent from `PLATFORM_IDS`
 * (or vice versa) produces rows nothing can execute, and the failure surfaces
 * as a runtime lookup miss on a live webhook.
 *
 * Runs as a test with the generated Prisma client imported, so the enum is the
 * real one and not a copy.
 *
 * TODO:
 *   const prismaValues = Object.values(Prisma.Platform).sort();
 *   const registryKeys = [...PLATFORM_IDS].sort();
 *   assert.deepEqual(registryKeys, prismaValues,
 *     "PLATFORM_IDS and the Prisma Platform enum have diverged. Adding a " +
 *     "platform means: one adapter file, one PlatformCeiling key, one line in " +
 *     "ADAPTERS, one enum value + migration.");
 *   for (const id of PLATFORM_IDS) assert.ok(adapterFor(id), `no adapter for ${id}`);
 */
export function assertRegistryMatchesSchema(): void {
  throw new Error("not implemented");
}

// ─── 2. The core knows no platform names ─────────────────────────────────────

/**
 * Directories that must remain platform-agnostic. Everything platform-shaped
 * has already been turned into data by the time code in here runs — that is the
 * whole design, and this is where it is enforced.
 *
 * `platform/` is deliberately absent: that is where platform knowledge belongs.
 */
export const PLATFORM_AGNOSTIC_DIRS = [
  "sketch/runtime",
  "sketch/campaign",
  "sketch/tenancy",
  "sketch/health",
] as const;

/**
 * Fails if a platform id appears as an identifier, string literal, or import
 * path anywhere under `PLATFORM_AGNOSTIC_DIRS`.
 *
 * Comments are exempt on purpose. The core is full of sentences like "Facebook
 * gets the rule free by returning the same claim shape" — that prose is how a
 * reader learns WHY the abstraction has the shape it does, and deleting it to
 * satisfy a linter would trade understanding for tidiness. Code is checked;
 * explanations are not.
 *
 * TODO:
 *   for (const dir of PLATFORM_AGNOSTIC_DIRS) {
 *     for (const file of walk(dir, ".ts")) {
 *       const src = stripCommentsAndJsxText(read(file));   // keep string literals
 *       for (const id of PLATFORM_IDS) {
 *         // word-boundary match, case-insensitive: catches `"instagram"`,
 *         // `Instagram`, `INSTAGRAM`, and `from "../platform/instagram"`.
 *         const hit = new RegExp(`\\b${id}\\b`, "i").exec(src);
 *         if (hit) fail(
 *           `${file} names the platform "${id}" at offset ${hit.index}. ` +
 *           `Platform-shaped behaviour belongs in an adapter or a capability, ` +
 *           `not in the core. If this is genuinely cross-cutting, add a ` +
 *           `Capability and let the ceiling decide.`
 *         );
 *       }
 *     }
 *   }
 *
 * Known escape hatch, deliberately not automated: a genuine one-off (say, a
 * platform-specific migration backfill) should live under `platform/` or carry
 * an explicit `// eslint-disable-next-line openreply/no-platform-names` with a
 * reason. Making the exception loud is the point.
 */
export function assertCoreIsPlatformAgnostic(): void {
  throw new Error("not implemented");
}

// ─── Type-level companion ────────────────────────────────────────────────────

/**
 * A compile-time half of check 1: `PLATFORM_IDS` must list every `PlatformId`,
 * not merely some of them. If a fifth platform is added to `PlatformCeiling`
 * and forgotten here, this errors without waiting for the test run.
 */
type _ids_exhaustive = [PlatformId] extends [(typeof PLATFORM_IDS)[number]]
  ? true
  : ["PLATFORM_IDS is missing a PlatformId", Exclude<PlatformId, (typeof PLATFORM_IDS)[number]>];
export type _assert_ids_exhaustive = _ids_exhaustive extends true ? true : never;
