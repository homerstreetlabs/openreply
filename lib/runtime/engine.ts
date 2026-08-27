/**
 * One operation instead of four job types.
 *
 * The send path grew four handlers around a log table: a comment handler, a
 * postback handler, a delayed follow-up and a read-receipt fallback. They are
 * the same operation observed at four moments. Promoting the log to a resumable
 * state machine collapses them: steps advance a run, and a run parks on a
 * signal or a deadline.
 *
 * The three things that make it correct under at-least-once delivery:
 *
 *   A run leases itself with a conditional UPDATE, because Cloudflare Queues
 *   has no dedup key and two consumers can hold the same message at once.
 *
 *   A step's terminal outcome is a row with `@@unique([runId, stepIndex])`, so
 *   "has this already happened" is a database constraint rather than a
 *   read-then-write check that two consumers both pass.
 *
 *   The cursor advances only after the outcome is recorded, so a crash replays
 *   one step rather than skipping it. Replaying is safe because the outcome row
 *   is what the replay reads.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { Platform, Prisma } from "@/app/generated/prisma/client";
import type { Step, StepKind, SignalKind } from "@/lib/campaigns/steps";

/** How long a consumer may hold a run before another may take it. */
const LEASE_MS = 5 * 60_000;

export type Cause =
  /** A new comment or inbound DM opened this run. */
  | { readonly kind: "trigger" }
  /** The person acted: a button tap, a read receipt, a reply. */
  | { readonly kind: "signal"; readonly signal: SignalKind; readonly payload?: string }
  /** The run parked on a deadline and the deadline passed. */
  | { readonly kind: "timeout" };

/** What a step did, as the engine records it. */
export type StepResult =
  | { readonly kind: "done"; readonly externalId?: string }
  /** Park the run here. The step will re-run when the signal or deadline lands. */
  | { readonly kind: "await" }
  /** Nothing to do, and nothing wrong. Move on without a terminal outcome. */
  | { readonly kind: "skip"; readonly reason: string }
  /** End the run here, without an error the creator could act on. */
  | { readonly kind: "abandon"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string; readonly retryable: boolean };

export interface StepContext {
  readonly runId: string;
  readonly stepIndex: number;
  readonly platform: Platform;
  readonly cause: Cause;
}

/** Executes one step. Supplied by the caller so the engine owns no I/O. */
export type StepExecutor = (
  step: Step<Platform, StepKind>,
  context: StepContext
) => Promise<StepResult>;

export interface AdvanceOutcome {
  readonly advanced: boolean;
  /** Null when the run finished or was not leased. */
  readonly parkedAt: number | null;
  readonly reason: string;
}

/**
 * Take the run, or report that someone else holds it.
 *
 * A conditional UPDATE rather than a lock: the row has to be read anyway, and a
 * Durable Object holding this would still have to be right after eviction.
 * An expired lease is takeable, which is what stops a crashed consumer wedging
 * a run forever.
 */
export async function leaseRun(runId: string): Promise<string | null> {
  const token = randomUUID();
  const now = new Date();

  const taken = await prisma.responseRun.updateMany({
    where: {
      id: runId,
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
  });

  return taken.count === 1 ? token : null;
}

async function releaseRun(runId: string, token: string): Promise<void> {
  await prisma.responseRun.updateMany({
    where: { id: runId, leaseToken: token },
    data: { leaseToken: null, leaseExpiresAt: null },
  });
}

/**
 * Which step indexes already reached a terminal outcome.
 *
 * Read once per advance rather than per step, because a run has few steps and
 * the alternative is a query inside the loop.
 */
async function terminalSteps(runId: string): Promise<Set<number>> {
  const rows = await prisma.stepOutcome.findMany({
    where: { runId },
    select: { stepIndex: true, status: true },
  });
  return new Set(
    rows.filter((r) => r.status === "SENT" || r.status === "SKIPPED_DEDUP").map((r) => r.stepIndex)
  );
}

/** What the outcome row records about a step that did not simply succeed. */
function outcomeNote(
  result: Extract<StepResult, { kind: "done" | "failed" | "abandon" }>
): string | null {
  switch (result.kind) {
    case "done":
      return null;
    case "failed":
      return result.error;
    case "abandon":
      return result.reason;
  }
}

/**
 * Record what a step did.
 *
 * The unique constraint is the idempotency primitive. A second consumer that
 * ran the same step loses the insert and learns it lost, rather than both
 * believing they were first.
 */
async function recordOutcome(
  runId: string,
  stepIndex: number,
  kind: StepKind,
  result: Extract<StepResult, { kind: "done" | "failed" | "abandon" }>
): Promise<boolean> {
  const status =
    result.kind === "done" ? "SENT" : result.kind === "abandon" ? "SKIPPED_DEDUP" : "FAILED";

  try {
    await prisma.stepOutcome.create({
      data: {
        runId,
        stepIndex,
        kind,
        status,
        externalId: result.kind === "done" ? (result.externalId ?? null) : null,
        error: outcomeNote(result),
      },
    });
    return true;
  } catch {
    // Lost the race. Another consumer recorded this step, which means it also
    // performed it, so this one must not perform it again.
    return false;
  }
}

/**
 * Run the plan from wherever it left off.
 *
 * Returns without doing anything when another consumer holds the lease. That is
 * the common case under at-least-once delivery, not an error.
 */
export async function advanceRun(
  runId: string,
  cause: Cause,
  plan: readonly Step<Platform, StepKind>[],
  execute: StepExecutor,
  platform: Platform
): Promise<AdvanceOutcome> {
  const token = await leaseRun(runId);
  if (!token) return { advanced: false, parkedAt: null, reason: "held by another consumer" };

  try {
    const run = await prisma.responseRun.findUnique({
      where: { id: runId },
      select: { cursor: true, awaitingSignals: true, onTimeout: true },
    });
    if (!run) return { advanced: false, parkedAt: null, reason: "run is gone" };

    // A signal for a step the run has already moved past is late, not wrong.
    // Queues redelivers, and a person can tap a button twice.
    if (cause.kind === "signal" && run.awaitingSignals.length > 0) {
      if (!run.awaitingSignals.includes(cause.signal)) {
        return { advanced: false, parkedAt: run.cursor, reason: "not the signal this run awaits" };
      }
    }

    if (cause.kind === "timeout" && run.onTimeout === "abandon") {
      await finish(runId, "SKIPPED_DEDUP", "The person never responded in time");
      return { advanced: true, parkedAt: null, reason: "abandoned on timeout" };
    }

    const done = await terminalSteps(runId);
    let cursor = run.cursor;

    while (cursor < plan.length) {
      const step = plan[cursor];

      if (done.has(cursor) && step.repeat === "once") {
        cursor += 1;
        continue;
      }

      const result = await execute(step, { runId, stepIndex: cursor, platform, cause });

      if (result.kind === "await") {
        await park(runId, cursor, step);
        return { advanced: true, parkedAt: cursor, reason: "waiting on the person" };
      }

      if (result.kind === "skip") {
        cursor += 1;
        await prisma.responseRun.update({ where: { id: runId }, data: { cursor } });
        continue;
      }

      const recorded = await recordOutcome(runId, cursor, step.kind, result);
      if (!recorded) {
        // Another consumer performed this step between the read and the write.
        cursor += 1;
        await prisma.responseRun.update({ where: { id: runId }, data: { cursor } });
        continue;
      }

      if (result.kind === "failed") {
        await finish(runId, "FAILED", result.error);
        return { advanced: true, parkedAt: null, reason: result.error };
      }

      if (result.kind === "abandon") {
        await finish(runId, "SKIPPED_DEDUP", result.reason);
        return { advanced: true, parkedAt: null, reason: result.reason };
      }

      cursor += 1;
      await prisma.responseRun.update({ where: { id: runId }, data: { cursor } });
    }

    await finish(runId, "SENT", null);
    return { advanced: true, parkedAt: null, reason: "plan complete" };
  } finally {
    await releaseRun(runId, token);
  }
}

async function park(
  runId: string,
  cursor: number,
  step: Step<Platform, StepKind>
): Promise<void> {
  const awaits = step.awaits;
  await prisma.responseRun.update({
    where: { id: runId },
    data: {
      cursor,
      status: "PENDING",
      awaitingSignals: awaits ? [...awaits.signals] : [],
      awaitUntil: awaits ? new Date(Date.now() + awaits.timeoutMs) : null,
      onTimeout: awaits?.onTimeout ?? null,
    },
  });
}

async function finish(
  runId: string,
  status: "SENT" | "FAILED" | "SKIPPED_DEDUP",
  error: string | null
): Promise<void> {
  const data: Prisma.ResponseRunUpdateInput = {
    status,
    errorMessage: error,
    awaitingSignals: [],
    awaitUntil: null,
    onTimeout: null,
  };
  if (status === "SENT") data.dmSentAt = new Date();

  await prisma.responseRun.update({ where: { id: runId }, data });
}

/** What opened a run. */
export interface Trigger {
  readonly platform: Platform;
  readonly accountExternalId: string;
  /** Frozen format: a comment id, `dm:<messageId>`, or `reveal:<userId>`. */
  readonly triggerKey: string;
  readonly text: string;
  readonly counterpartyId: string;
  readonly counterpartyName: string | null;
  readonly postId: string | null;
  readonly matchedKeyword: string | null;
}

export interface StartedRun {
  readonly runId: string;
  readonly campaignId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
}

/**
 * Open a run per matching campaign, or find the one already open.
 *
 * The upsert is the whole point. `@@unique([campaignId, triggerKey])` is the
 * live idempotency contract, and it predates this engine: a redelivered webhook
 * and a polling sweep racing over the same comment converge on one row rather
 * than starting two runs that both send.
 */
export async function startRuns(
  trigger: Trigger,
  campaigns: readonly { id: string; workspaceId: string; connectedAccountId: string }[]
): Promise<StartedRun[]> {
  const started: StartedRun[] = [];

  for (const campaign of campaigns) {
    const run = await prisma.responseRun.upsert({
      where: {
        campaignId_triggerKey: {
          campaignId: campaign.id,
          triggerKey: trigger.triggerKey,
        },
      },
      create: {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        connectedAccountId: campaign.connectedAccountId,
        counterpartyId: trigger.counterpartyId,
        counterpartyName: trigger.counterpartyName,
        triggerText: trigger.text,
        triggerKey: trigger.triggerKey,
        matchedKeyword: trigger.matchedKeyword,
        status: "PENDING",
      },
      // Deliberately narrow. A redelivery must not reset the cursor or clear a
      // status the run already reached, or the plan would replay from the top.
      update: { matchedKeyword: trigger.matchedKeyword },
      select: { id: true },
    });

    started.push({
      runId: run.id,
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      connectedAccountId: campaign.connectedAccountId,
    });
  }

  return started;
}
