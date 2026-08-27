import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The run state machine under at-least-once delivery.
 *
 * Every test here is about a second consumer, a redelivery, or a crash. Those
 * are the ordinary case on Cloudflare Queues, which has no dedup key, not the
 * exceptional one.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    responseRun: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    stepOutcome: { findMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { advanceRun, leaseRun, startRuns, type StepResult } from "../lib/runtime/engine";
import { builders } from "../lib/campaigns/steps";

const ig = builders("INSTAGRAM");
const plan = [
  ig.publicReply({ variants: ["thanks"] }),
  ig.openingDm(
    { text: "tap to get it", buttonLabel: "send it" },
    { awaits: { signals: ["postback", "read"], timeoutMs: 300_000, onTimeout: "continue" } }
  ),
  ig.conversationMessage({ text: "here it is", linkSlugs: [], primaryLabel: null }),
];

/**
 * The last call's argument, or a failure that says which mock was empty.
 * `.at(-1)` is optional at the type level and every use here has already
 * asserted the call happened.
 */
function lastArg(mock: { mock: { calls: unknown[][] } }, name: string) {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error(`${name} was never called`);
  return call[0] as { data: Record<string, unknown>; where: Record<string, unknown> };
}

function leaseGranted() {
  mockPrisma.responseRun.updateMany.mockResolvedValue({ count: 1 });
}
function leaseRefused() {
  mockPrisma.responseRun.updateMany.mockResolvedValue({ count: 0 });
}
function runAt(cursor: number, extra: Record<string, unknown> = {}) {
  mockPrisma.responseRun.findUnique.mockResolvedValue({
    cursor,
    awaitingSignals: [],
    onTimeout: null,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  leaseGranted();
  runAt(0);
  mockPrisma.responseRun.update.mockResolvedValue({});
  mockPrisma.stepOutcome.findMany.mockResolvedValue([]);
  mockPrisma.stepOutcome.create.mockResolvedValue({});
});

describe("leasing", () => {
  it("refuses a run another consumer already holds", async () => {
    leaseRefused();

    expect(await leaseRun("run_1")).toBeNull();
  });

  it("takes a run whose lease has expired, so a crash cannot wedge it", async () => {
    leaseGranted();

    await leaseRun("run_1");

    const where = mockPrisma.responseRun.updateMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { leaseToken: null },
      { leaseExpiresAt: { lte: expect.any(Date) } },
    ]);
  });

  it("does no work at all when it cannot take the lease", async () => {
    leaseRefused();
    const execute = vi.fn();

    const result = await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    expect(execute).not.toHaveBeenCalled();
    expect(result.advanced).toBe(false);
  });
});

describe("advancing the plan", () => {
  it("runs steps in order until one parks", async () => {
    const seen: string[] = [];
    const execute = vi.fn(async (step): Promise<StepResult> => {
      seen.push(step.kind);
      return step.kind === "openingDm" ? { kind: "await" } : { kind: "done" };
    });

    const result = await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    expect(seen).toEqual(["publicReply", "openingDm"]);
    expect(result.parkedAt).toBe(1);
  });

  it("records what the parked step waits for, so a signal can find it", async () => {
    const execute = vi.fn(async (step): Promise<StepResult> =>
      step.kind === "openingDm" ? { kind: "await" } : { kind: "done" }
    );

    await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    const parked = lastArg(mockPrisma.responseRun.update, "run update").data;
    expect(parked.awaitingSignals).toEqual(["postback", "read"]);
    expect(parked.awaitUntil).toBeInstanceOf(Date);
    expect(parked.onTimeout).toBe("continue");
  });

  it("resumes from the cursor rather than replaying the plan", async () => {
    runAt(2);
    const seen: string[] = [];
    const execute = vi.fn(async (step): Promise<StepResult> => {
      seen.push(step.kind);
      return { kind: "done" };
    });

    await advanceRun("run_1", { kind: "signal", signal: "postback" }, plan, execute, "INSTAGRAM");

    expect(seen).toEqual(["conversationMessage"]);
  });

  it("marks the run sent when the plan runs out", async () => {
    const execute = vi.fn(async (): Promise<StepResult> => ({ kind: "done" }));

    const result = await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    expect(result.reason).toBe("plan complete");
    const finished = lastArg(mockPrisma.responseRun.update, "run update").data;
    expect(finished.status).toBe("SENT");
  });
});

/**
 * The outcome row, not a read-then-write check, is what stops a step happening
 * twice. Two consumers both pass a check; only one wins a unique constraint.
 */
describe("idempotency", () => {
  it("skips a step that already reached a terminal outcome", async () => {
    mockPrisma.stepOutcome.findMany.mockResolvedValue([
      { stepIndex: 0, status: "SENT" },
    ]);
    const seen: string[] = [];
    const execute = vi.fn(async (step): Promise<StepResult> => {
      seen.push(step.kind);
      return { kind: "await" };
    });

    await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    expect(seen).toEqual(["openingDm"]);
  });

  it("re-runs a step marked everySignal, because a second tap must re-send", async () => {
    runAt(2);
    mockPrisma.stepOutcome.findMany.mockResolvedValue([
      { stepIndex: 2, status: "SENT" },
    ]);
    const execute = vi.fn(async (): Promise<StepResult> => ({ kind: "done" }));

    await advanceRun("run_1", { kind: "signal", signal: "postback" }, plan, execute, "INSTAGRAM");

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("moves on without repeating when it loses the outcome race", async () => {
    mockPrisma.stepOutcome.create.mockRejectedValue(new Error("unique constraint"));
    const seen: string[] = [];
    const execute = vi.fn(async (step): Promise<StepResult> => {
      seen.push(step.kind);
      return { kind: "done" };
    });

    await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    expect(seen).toEqual(["publicReply", "openingDm", "conversationMessage"]);
    expect(seen).toHaveLength(new Set(seen).size);
  });
});

describe("signals and deadlines", () => {
  it("ignores a signal the run is not waiting for", async () => {
    runAt(1, { awaitingSignals: ["postback"] });
    const execute = vi.fn();

    const result = await advanceRun(
      "run_1",
      { kind: "signal", signal: "inboundMessage" },
      plan,
      execute,
      "INSTAGRAM"
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.reason).toContain("not the signal");
  });

  /**
   * The read-receipt grace period. The person read the opening DM and never
   * tapped, so deliver anyway rather than stranding them.
   */
  it("continues past a timeout when that is what the step asked for", async () => {
    runAt(1, { awaitingSignals: ["postback", "read"], onTimeout: "continue" });
    const execute = vi.fn(async (): Promise<StepResult> => ({ kind: "done" }));

    await advanceRun("run_1", { kind: "timeout" }, plan, execute, "INSTAGRAM");

    expect(execute).toHaveBeenCalled();
  });

  it("ends the run on a timeout the step asked to abandon", async () => {
    runAt(1, { awaitingSignals: ["postback"], onTimeout: "abandon" });
    const execute = vi.fn();

    await advanceRun("run_1", { kind: "timeout" }, plan, execute, "INSTAGRAM");

    expect(execute).not.toHaveBeenCalled();
    const finished = lastArg(mockPrisma.responseRun.update, "run update").data;
    expect(finished.status).toBe("SKIPPED_DEDUP");
  });

});

describe("failure", () => {
  it("ends the run and keeps the reason where the creator can read it", async () => {
    const execute = vi.fn(async (): Promise<StepResult> => ({
      kind: "failed",
      error: "token expired",
      retryable: false,
    }));

    await advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM");

    const finished = lastArg(mockPrisma.responseRun.update, "run update").data;
    expect(finished.status).toBe("FAILED");
    expect(finished.errorMessage).toBe("token expired");
  });

  it("releases the lease even when a step throws", async () => {
    const execute = vi.fn(async () => {
      throw new Error("network");
    });

    await expect(
      advanceRun("run_1", { kind: "trigger" }, plan, execute, "INSTAGRAM")
    ).rejects.toThrow("network");

    const release = lastArg(mockPrisma.responseRun.updateMany, "lease release");
    expect(release.data.leaseToken).toBeNull();
  });
});

/**
 * `@@unique([campaignId, triggerKey])` is the live idempotency contract and
 * predates this engine. A redelivered webhook racing a polling sweep must
 * converge on one run, not start two that both send.
 */
describe("starting a run", () => {
  const campaign = { id: "camp_1", workspaceId: "ws_1", connectedAccountId: "acct_1" };
  const trigger = {
    platform: "INSTAGRAM" as const,
    accountExternalId: "ig_1",
    triggerKey: "comment_1",
    text: "LINK",
    counterpartyId: "user_1",
    counterpartyName: "someone",
    postId: "media_1",
    matchedKeyword: "LINK",
  };

  it("converges on one run per campaign and trigger", async () => {
    mockPrisma.responseRun.upsert.mockResolvedValue({ id: "run_1" });

    const started = await startRuns(trigger, [campaign]);

    expect(started).toEqual([
      { runId: "run_1", campaignId: "camp_1", workspaceId: "ws_1", connectedAccountId: "acct_1" },
    ]);
    const call = mockPrisma.responseRun.upsert.mock.calls[0][0];
    expect(call.where.campaignId_triggerKey).toEqual({
      campaignId: "camp_1",
      triggerKey: "comment_1",
    });
  });

  it("does not reset progress when the same trigger arrives again", async () => {
    mockPrisma.responseRun.upsert.mockResolvedValue({ id: "run_1" });

    await startRuns(trigger, [campaign]);

    const update = mockPrisma.responseRun.upsert.mock.calls[0][0].update;
    expect(update.cursor).toBeUndefined();
    expect(update.status).toBeUndefined();
  });
});
