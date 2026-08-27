import { describe, it, expect } from "vitest";

import { bucketName, colocate, type BucketSpec } from "../lib/runtime/quota";
import {
  discoveryBuckets,
  planSweep,
  sweepIntervalSeconds,
} from "../lib/runtime/discovery";
import { youtubeAdapter } from "../lib/platforms/youtube";
import { instagramAdapter } from "../lib/platforms/instagram";
import { adapterFor, pollOnlyPlatforms } from "../lib/platforms/registry";

function bucket(overrides: Partial<BucketSpec> = {}): BucketSpec {
  return {
    scope: { kind: "account", id: "acct_1" },
    meter: "meta:private_reply",
    window: { kind: "rolling", ms: 3_600_000 },
    capacity: { kind: "fixed", units: 750 },
    ...overrides,
  };
}

describe("bucket identity", () => {
  /**
   * Raising a cap or refreshing a derived ceiling must not orphan the running
   * counter, so policy is deliberately not part of the object's name.
   */
  it("excludes window and capacity from the name", () => {
    const a = bucket();
    const b = bucket({
      window: { kind: "rolling", ms: 60_000 },
      capacity: { kind: "fixed", units: 1 },
    });
    expect(bucketName(a)).toBe(bucketName(b));
  });

  it("separates meters on the same scope", () => {
    expect(bucketName(bucket())).not.toBe(bucketName(bucket({ meter: "meta:public_reply" })));
  });

  it("separates accounts", () => {
    expect(bucketName(bucket())).not.toBe(
      bucketName(bucket({ scope: { kind: "account", id: "acct_2" } }))
    );
  });
});

describe("colocation", () => {
  /**
   * TikTok meters per account and per app at once. Serving both from the coarser
   * object makes the pair atomic instead of two-phase across two objects.
   */
  it("serves a nested account and app spend from one object", () => {
    const groups = colocate([
      bucket({ scope: { kind: "account", id: "acct_1" }, meter: "tiktok:qpm" }),
      bucket({ scope: { kind: "app", id: "app_1" }, meter: "tiktok:qpm" }),
    ]);

    expect(groups.size).toBe(1);
    expect([...groups.keys()][0]).toContain("app:app_1");
  });

  it("keeps an account-only spend in its own object", () => {
    const groups = colocate([bucket()]);
    expect(groups.size).toBe(1);
    expect([...groups.keys()][0]).toContain("account:acct_1");
  });

  it("carries every bucket into a group", () => {
    const spend = [
      bucket({ scope: { kind: "account", id: "acct_1" }, meter: "tiktok:qpm" }),
      bucket({ scope: { kind: "app", id: "app_1" }, meter: "tiktok:qpm" }),
    ];
    const carried = [...colocate(spend).values()].flat();
    expect(carried).toHaveLength(spend.length);
  });
});

/**
 * On YouTube a refusal means comments are never discovered at all, so the
 * scheduler slows down rather than stopping.
 */
describe("sweep pacing", () => {
  it("runs at the floor when nothing is spent", () => {
    expect(sweepIntervalSeconds(0, true)).toBe(300);
  });

  it("stretches as the budget fills", () => {
    const easy = sweepIntervalSeconds(0.1, true);
    const tight = sweepIntervalSeconds(0.9, true);
    expect(tight).toBeGreaterThan(easy);
  });

  it("never stops a primary sweep, even at an exhausted budget", () => {
    const interval = sweepIntervalSeconds(1, true);
    expect(Number.isFinite(interval)).toBe(true);
    expect(interval).toBeLessThanOrEqual(3600);
  });

  it("clamps a nonsensical pressure rather than inverting the interval", () => {
    expect(sweepIntervalSeconds(-5, true)).toBe(300);
    expect(sweepIntervalSeconds(50, true)).toBeLessThanOrEqual(3600);
  });
});

describe("planSweep", () => {
  it("treats a poll-only platform as primary and prices the pass", () => {
    const plan = planSweep(youtubeAdapter, 0);
    expect(plan.primary).toBe(true);
    expect(plan.cost).toBe(1);
  });

  it("treats a webhook platform's sweep as a free safety net", () => {
    const plan = planSweep(instagramAdapter, 0);
    expect(plan.primary).toBe(false);
    expect(plan.cost).toBe(0);
  });
});

describe("discovery buckets", () => {
  it("charges a webhook platform nothing", () => {
    expect(discoveryBuckets(instagramAdapter, "acct_1", "app_1")).toHaveLength(0);
  });

  /**
   * The 10,000 units belong to the Google Cloud project, not to a creator, which
   * is why the scope is the app and every account is a participant in one pool.
   */
  it("scopes YouTube's pool to the provider app, not the account", () => {
    const [b] = discoveryBuckets(youtubeAdapter, "channel_1", "gcp_project_1");

    expect(b.scope).toEqual({ kind: "app", id: "gcp_project_1" });
    expect(b.participantId).toBe("channel_1");
    expect(b.capacity).toMatchObject({ kind: "pooled", units: 10_000 });
  });

  it("resets on YouTube's Pacific day boundary", () => {
    const [b] = discoveryBuckets(youtubeAdapter, "channel_1", "gcp_1");
    expect(b.window).toEqual({ kind: "calendarDay", resetHourUtc: 8 });
  });

  /**
   * A poll costs 1 and a reply costs 50. Without a reserve, a channel posting
   * replies divides away every other channel's ability to look.
   */
  it("withholds a reserve so a quiet channel keeps discovering", () => {
    const [b] = discoveryBuckets(youtubeAdapter, "channel_1", "gcp_1");
    if (b.capacity.kind !== "pooled") throw new Error("expected a pooled capacity");

    expect(b.capacity.share.reserve).toBeGreaterThan(0);
    expect(b.capacity.share.floor).toBeGreaterThan(0);
  });
});

describe("poll-only platforms", () => {
  /**
   * Two callers derive their account filter from this. It reads the registry
   * rather than a written-out list, so adding a fifth platform cannot leave a
   * stale copy behind in one of them.
   */
  it("names exactly the platforms whose discovery is a poll", () => {
    expect(pollOnlyPlatforms()).toEqual(["YOUTUBE"]);
  });

  /** TikTok pushes comments, so it is discovered like Meta rather than swept. */
  it("excludes every platform that gets a webhook", () => {
    for (const platform of ["INSTAGRAM", "FACEBOOK", "TIKTOK"] as const) {
      expect(pollOnlyPlatforms()).not.toContain(platform);
    }
  });

  it("agrees with each adapter's own declaration", () => {
    for (const platform of pollOnlyPlatforms()) {
      expect(adapterFor(platform).discovery.kind).toBe("poll");
    }
  });
});
