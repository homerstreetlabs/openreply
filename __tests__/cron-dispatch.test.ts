/**
 * Engine cron dispatch — Unit Tests
 *
 * The regression these lock down: `scheduled()` ran the comment reconciler on
 * every tick and ignored `controller.cron`, so the three daily jobs silently
 * never ran.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const jobs = vi.hoisted(() => ({
  reconcileComments: vi.fn(async () => undefined),
  refreshTokens: vi.fn(async () => undefined),
  attachNextReel: vi.fn(async () => undefined),
  snapshotFollowers: vi.fn(async () => undefined),
  snapshotQuota: vi.fn(async () => undefined),
  refreshDerivedCapacity: vi.fn(async () => []),
}));

/**
 * Not part of `jobs`, because it shares the five-minute tick with the reconciler.
 * Keeping it out preserves "routes to this job and to nothing else" as a real
 * assertion.
 */
const sweepPollOnlyAccounts = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/lib/polling/poll-sweep", () => ({ sweepPollOnlyAccounts }));

/** Shares the five-minute tick with the reconciler, for the same reason. */
const advanceDueRuns = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("@/lib/runtime/dispatch", () => ({ advanceDueRuns }));

vi.mock("@/lib/polling/comment-reconciler", () => ({
  reconcileComments: jobs.reconcileComments,
}));
vi.mock("@/lib/jobs/refresh-tokens", () => ({ refreshTokens: jobs.refreshTokens }));
vi.mock("@/lib/jobs/attach-next-reel", () => ({ attachNextReel: jobs.attachNextReel }));
vi.mock("@/lib/jobs/snapshot-followers", () => ({
  snapshotFollowers: jobs.snapshotFollowers,
}));
vi.mock("@/lib/ops/quota-snapshot", () => ({ snapshotQuota: jobs.snapshotQuota }));
vi.mock("@/lib/jobs/refresh-capacity", () => ({
  refreshDerivedCapacity: jobs.refreshDerivedCapacity,
}));

const { scopeCalls } = vi.hoisted(() => ({ scopeCalls: { count: 0 } }));
vi.mock("@/lib/db/client", () => ({
  withPrismaScope: async (fn: () => Promise<unknown>) => {
    scopeCalls.count += 1;
    return fn();
  },
}));

/** Importing the consumer for real would drag the whole send path into a dispatch test. */
vi.mock("@/lib/queue/consumer", () => ({ processQueueBatch: vi.fn() }));

import engine from "@/workers/engine/index";

const EXPECTED: Array<[string, keyof typeof jobs]> = [
  ["*/5 * * * *", "reconcileComments"],
  ["*/15 * * * *", "snapshotQuota"],
  ["0 5 * * *", "refreshTokens"],
  ["0 6 * * *", "attachNextReel"],
  ["0 7 * * *", "snapshotFollowers"],
  ["0 8 * * *", "refreshDerivedCapacity"],
];

/**
 * Bindings the engine receives as a handler argument, because it is a raw
 * wrangler Worker with no ambient adapter context. Only the shape matters here;
 * nothing in a dispatch test calls through them.
 */
const ENV = {
  RESPONSE_QUEUE: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
  RESPONSE_DLQ: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
  RATE_LIMITER: { idFromName: vi.fn(), get: vi.fn() },
  QUOTA: { idFromName: vi.fn(), get: vi.fn() },
} as unknown as Parameters<typeof engine.scheduled>[1];

async function tick(cron: string) {
  const pending: Promise<unknown>[] = [];
  await engine.scheduled({ cron }, ENV, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

beforeEach(() => {
  vi.clearAllMocks();
  scopeCalls.count = 0;
});

describe("scheduled dispatch", () => {
  for (const [cron, name] of EXPECTED) {
    it(`routes ${cron} to ${name} and to nothing else`, async () => {
      await tick(cron);

      expect(jobs[name]).toHaveBeenCalledTimes(1);
      for (const other of Object.keys(jobs) as Array<keyof typeof jobs>) {
        if (other !== name) expect(jobs[other]).not.toHaveBeenCalled();
      }
    });
  }

  it("runs the job inside a prisma scope, under waitUntil", async () => {
    const pending: Promise<unknown>[] = [];
    await engine.scheduled({ cron: "0 6 * * *" }, ENV, { waitUntil: (p) => pending.push(p) });

    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(scopeCalls.count).toBe(1);
    expect(jobs.attachNextReel).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing job instead of rejecting the tick", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    jobs.snapshotFollowers.mockRejectedValueOnce(new Error("Graph API 500"));

    await expect(tick("0 7 * * *")).resolves.toBeUndefined();
    await expect(tick("0 8 * * *")).resolves.toBeUndefined();
    expect(error.mock.calls[0].join(" ")).toContain("Graph API 500");
    error.mockRestore();
  });
});

describe("unrecognised cron expressions", () => {
  it("warns and names the expression instead of doing nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await tick("0 3 * * *");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("0 3 * * *");
    for (const job of Object.values(jobs)) expect(job).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("wrangler.engine.jsonc triggers", () => {
  /** Scoped to the triggers block so the `//` in the local connection string is not read as a comment. */
  const crons = [
    ...readFileSync("wrangler.engine.jsonc", "utf8")
      .match(/"crons"\s*:\s*\[([^\]]*)\]/)![1]
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);

  it("declares exactly the expressions the dispatcher knows", () => {
    expect(crons).toEqual(EXPECTED.map(([cron]) => cron));
  });

  for (const cron of crons) {
    it(`dispatches the configured ${cron}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await tick(cron);

      expect(warn).not.toHaveBeenCalled();
      expect(Object.values(jobs).filter((j) => j.mock.calls.length)).toHaveLength(1);
      warn.mockRestore();
    });
  }
});
