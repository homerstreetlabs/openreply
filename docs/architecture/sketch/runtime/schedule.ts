/**
 * Trigger discovery scheduling: one mechanism for three shapes, degrading by
 * lengthening rather than by failing.
 *
 *   Instagram   webhook primary, sweep as safety net       (5 min, free)
 *   Facebook    webhook primary, sweep rarely              (engagement-derived
 *               budget is small on a quiet Page, so sweeps are the first thing
 *               to stretch)
 *   TikTok      webhook primary and the payload carries `text`, so a sweep
 *               only reconciles; ~15 accounts polling once a minute would
 *               exhaust the app-wide 600 QPM ceiling
 *   YouTube     sweep is the ONLY path, every sweep costs metered units, and
 *               the budget is shared across every tenant
 *
 * Today's `COMMENT_POLL_INTERVAL_MS` env var cannot serve both a free safety
 * net and a metered primary path. Here the interval is computed, per account,
 * per sweep, from live budget pressure.
 */

import type { SweepSpec } from "../platform/adapter";
import type { BudgetPressure } from "./quota";

/**
 * PURE. The entire quota-aware scheduling policy, testable with no Durable
 * Object and no network.
 *
 *   pressure 0.0  -> baseIntervalMs
 *   pressure 1.0  -> maxIntervalMs
 *   in between    -> geometric interpolation, so the interval stretches
 *                    gently while budget is plentiful and sharply as it runs
 *                    out. A YouTube project at 80% of its 10,000 units moves
 *                    from 5-minute to ~25-minute sweeps rather than stopping.
 *
 * A `safetyNet` sweep stretches to `maxIntervalMs` and then STOPS being
 * scheduled — losing the safety net is acceptable. A `primary` sweep never
 * stops; at maximum pressure it runs at `maxIntervalMs` forever, because
 * stopping it would mean the platform silently ceases to work.
 */
export function computeNextSweep(
  spec: SweepSpec,
  pressure: BudgetPressure,
  now: Date
): Date | null {
  throw new Error("not implemented");
}

/**
 * Runs on the `* * * * *` cron in `openreply-engine`.
 *
 * A thin PRODUCER, never a worker: Cloudflare's scheduled Workers carry no
 * SLA, no retry policy and no delivery guarantee, and run "on underutilized
 * machines". So it selects due accounts and enqueues; the sweep itself happens
 * on `discovery-queue`, which does have retries and a DLQ.
 *
 *   SELECT id FROM ConnectedAccount
 *   WHERE nextSweepAt <= now() AND sweepEnabled
 *   ORDER BY sweepPriority DESC, nextSweepAt ASC
 *   LIMIT :batch
 *
 * `nextSweepAt` is a plain indexed column, so "which accounts are due" is one
 * index scan — no per-account alarm, no DO per account, and the schedule
 * survives a Worker redeploy.
 */
export async function planSweeps(deps: SweepPlannerDeps, batch: number): Promise<number> {
  throw new Error("not implemented");
}

/**
 * One sweep, on `discovery-queue`. Debits the same quota buckets as sends —
 * that is the point: on YouTube a poll and a reply come out of ONE 10,000-unit
 * budget, at 1 unit and 50 units respectively, so a busy campaign day
 * automatically slows polling instead of running the project dry.
 */
export async function runSweep(deps: SweepRunnerDeps, accountId: string): Promise<void> {
  // TODO:
  //   1. spec = adapter.sweep; if null -> clear nextSweepAt, return
  //   2. pressure = quota.pressure(buckets)
  //   3. reserve spec.costPerSweep; refused -> push nextSweepAt out, no error
  //   4. result = adapter.runSweep(account, cred, cursor, budget)
  //   5. drop events already in SeenTrigger (the shared dedup set today's
  //      ProcessedComment provides), enqueue the rest onto response-queue
  //   6. persist result.cursor; settle the lease with the ACTUAL unitsSpent
  //   7. nextSweepAt = computeNextSweep(spec, freshPressure, now)
  throw new Error("not implemented");
}

export interface SweepPlannerDeps {
  readonly dueAccounts: (batch: number) => Promise<readonly string[]>;
  readonly enqueueSweep: (accountId: string) => Promise<void>;
}

export interface SweepRunnerDeps {
  readonly loadAccount: (id: string) => Promise<unknown>;
  readonly enqueueTriggers: (events: readonly unknown[]) => Promise<void>;
  readonly markSeen: (accountId: string, externalIds: readonly string[]) => Promise<readonly string[]>;
  readonly setSweepState: (id: string, cursor: string | null, nextAt: Date | null) => Promise<void>;
}

// ─── Delayed advances ────────────────────────────────────────────────────────

/**
 * Cloudflare Queues caps `delaySeconds` at 86,400 — exactly 24 hours, and
 * exactly what `followUpDelayMinutes` maxes out at today. Zero headroom.
 *
 * So a delay beyond 24h is chained: enqueue a hop at now+24h whose only job is
 * to call this again. Four lines, and it turns a hard platform limit into a
 * non-issue — which matters because Facebook's private-reply window is 7 days,
 * so a 2-day follow-up is a reasonable thing for a creator to want.
 *
 * Idempotent: a duplicate hop finds the run's step outcome already terminal
 * and no-ops.
 */
export function splitDelay(totalMs: number): { readonly firstHopMs: number; readonly remainingMs: number } {
  throw new Error("not implemented");
}

export const MAX_QUEUE_DELAY_MS = 86_400_000;

/**
 * The five-minute safety-net cron. Scheduled Workers have no delivery
 * guarantee, so a delayed message CAN be lost; this finds runs whose
 * `awaitUntil` has passed and advances them. Idempotent by construction — a
 * run advanced by both its delayed message and this sweep executes each step
 * once, guarded by `StepOutcome`.
 */
export async function reapExpiredAwaits(deps: {
  readonly expiredRuns: (before: Date, limit: number) => Promise<readonly string[]>;
  readonly enqueueAdvance: (runId: string) => Promise<void>;
}): Promise<number> {
  throw new Error("not implemented");
}
