/**
 * Cron routes — Unit Tests
 *
 * The job logic moved into `lib/jobs/`. These hold the boundary in place: the
 * bearer check still gates the work, and the JSON envelope is unchanged for
 * anyone hitting these routes by hand.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const j = vi.hoisted(() => ({
  refreshTokens: vi.fn(async () => ({ totalProcessed: 2, results: [] })),
  attachNextReel: vi.fn(async () => ({ checked: 3, bound: 1, failedAccounts: 0 })),
  snapshotFollowers: vi.fn(async () => ({ accounts: 4, recorded: 4, backfilled: 30, failures: [] })),
}));
vi.mock("@/lib/jobs/refresh-tokens", () => ({ refreshTokens: j.refreshTokens }));
vi.mock("@/lib/jobs/attach-next-reel", () => ({ attachNextReel: j.attachNextReel }));
vi.mock("@/lib/jobs/snapshot-followers", () => ({ snapshotFollowers: j.snapshotFollowers }));

import { GET as refresh } from "@/app/api/cron/refresh-tokens/route";
import { GET as attach } from "@/app/api/cron/attach-next-reel/route";
import { GET as snapshot } from "@/app/api/cron/snapshot-followers/route";
import type { NextRequest } from "next/server";

const req = (auth?: string) =>
  ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "s3cret");
});

const cases = [
  ["refresh-tokens", refresh, j.refreshTokens] as const,
  ["attach-next-reel", attach, j.attachNextReel] as const,
  ["snapshot-followers", snapshot, j.snapshotFollowers] as const,
];

describe("cron routes called by hand", () => {
  for (const [name, handler, job] of cases) {
    it(`${name}: 401 + no job run without the bearer`, async () => {
      const res = await handler(req());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "Unauthorized" });
      expect(job).not.toHaveBeenCalled();
    });

    it(`${name}: 401 on a wrong bearer`, async () => {
      const res = await handler(req("Bearer nope"));
      expect(res.status).toBe(401);
      expect(job).not.toHaveBeenCalled();
    });

    it(`${name}: 200 wrapping the job result under data`, async () => {
      const res = await handler(req("Bearer s3cret"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: await job.mock.results[0].value });
    });
  }
});
