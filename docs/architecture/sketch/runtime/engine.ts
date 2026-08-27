/**
 * The engine. One state machine, four platforms, zero `platform === ...`
 * branches.
 *
 * ── The trace, webhook to sent response ──────────────────────────────────────
 *
 *   POST /api/ingest/instagram/main            cloudflare/entry.ts
 *     -> app = lookupProviderApp("instagram", "main")
 *     -> adapter.ingest.verifySignature(raw, app)          ONE bound secret
 *     -> adapter.ingest.parse(rawBody, app)     -> IngestedEvent[]
 *     -> env.RESPONSE_QUEUE.sendBatch(events)   -> 200 within Meta's 5s budget
 *                                                  (no DB write on this path)
 *
 *   queue("response-queue")                     cloudflare/entry.ts
 *     -> dispatch(ctx, event)                   this file
 *          StartTrigger -> startRuns()  -> one ResponseRun per matching campaign
 *          RunSignal    -> resolveSignal() -> the parked run(s) it advances
 *     -> advanceRun(ctx, runId, cause)          this file
 *          leaseRun()                           at-least-once delivery guard
 *          parseStoredPlan()                    capability re-check
 *          for each step from cursor:
 *            executeStep()                      this file
 *              adapter.plan(step, ...)          PURE -> claims, buckets, cost
 *              gate?  resolveFollowGate(...)    PURE
 *              claims.acquire(...)              DB unique constraint
 *              quota.reserve(cost, buckets)     Durable Objects
 *              preflight?                       FB can_reply_privately
 *              renderContent(...)               {username} / {link}
 *              adapter.deliver(...)             the ONLY network call
 *              lease.settle("commit"|"release")
 *              recordOutcome()                  StepOutcome, unique per step
 *            step.awaits -> park + scheduleAdvance()
 *
 * ── Why there is no platform branch ─────────────────────────────────────────
 *
 * Everything that differs per platform has already been turned into data by
 * the time the engine sees it: which steps exist (`compile`), what a step
 * costs and consumes (`adapter.plan`), how it is delivered
 * (`adapter.deliver`), and what an error means (`adapter.classify`). The
 * engine's job is the part that genuinely IS universal — ordering,
 * idempotency, budget, gating, outcome recording.
 */

import type {
  ConnectedAccount,
  Credential,
  Failure,
  IngestedEvent,
  PlatformAdapter,
  RunSignal,
  StartTrigger,
} from "../platform/adapter";
import type { AnyStep, PlatformId } from "../platform/capability";
import type { CompiledPlan } from "../campaign/compile";
import type { ClaimLedger } from "./claims";
import { canReprompt, resolveFollowGate } from "./follow-gate";
import type { QuotaBroker } from "./quota";

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Everything the engine needs, resolved once per queue batch. Passed
 * explicitly rather than imported, so the engine is testable with fakes and
 * has no module-level state — which is also what Workers requires (a client
 * cached on `globalThis` throws "Cannot perform I/O on behalf of a different
 * request").
 */
export interface EngineContext {
  readonly db: Db;
  readonly quota: QuotaBroker;
  readonly claims: ClaimLedger;
  readonly incidents: IncidentSink;
  readonly credentials: CredentialStore;
  readonly schedule: Scheduler;
  readonly now: () => Date;
  /** Resolves the adapter for a platform. The only place platform id is switched on. */
  adapterFor<P extends PlatformId>(platform: P): PlatformAdapter<P>;
}

/** Narrow port over Prisma so the engine's tests do not need a database. */
export interface Db {
  findAccountByExternalId(
    platform: PlatformId,
    externalId: string
  ): Promise<ConnectedAccount | null>;
  findCampaignsFor(
    accountId: string,
    trigger: StartTrigger
  ): Promise<readonly StoredCampaign[]>;
  upsertRun(input: NewRun): Promise<ResponseRun>;
  loadRun(runId: string): Promise<ResponseRun | null>;
  /**
   * Conditional UPDATE ... WHERE leaseExpiresAt IS NULL OR leaseExpiresAt < now()
   * RETURNING *. Postgres makes this atomic, which is all the mutual exclusion
   * a run needs — see `leaseRun`.
   */
  leaseRun(runId: string, token: string, ttlMs: number): Promise<ResponseRun | null>;
  releaseLease(runId: string, token: string): Promise<void>;
  recordOutcome(o: StepOutcome): Promise<void>;
  loadOutcomes(runId: string): Promise<readonly StepOutcome[]>;
  parkRun(runId: string, park: RunPark): Promise<void>;
  completeRun(runId: string, status: RunStatus): Promise<void>;
  findParkedRunsForUser(accountId: string, userId: string): Promise<readonly ResponseRun[]>;
}

export interface CredentialStore {
  /** Decrypts AES-256-GCM. Unchanged crypto; `node:crypto` works on Workers. */
  get(accountId: string): Promise<Credential | null>;
}

export interface IncidentSink {
  raise(input: RaiseIncident): Promise<void>;
  resolve(accountId: string, kind: string): Promise<void>;
}

export interface Scheduler {
  /**
   * Enqueue an advance at `at`. Cloudflare Queues caps `delaySeconds` at
   * 86,400 (exactly 24h) and `followUpDelayMinutes` maxes at 1440 (exactly
   * 24h) — zero headroom. So beyond 24h this enqueues a HOP that re-schedules
   * on arrival, which turns a hard platform limit into a non-issue and lets
   * Facebook's 7-day window be used.
   */
  advanceAt(runId: string, at: Date): Promise<void>;
}

// ─── Run state ───────────────────────────────────────────────────────────────

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  /** Parked on `awaitingSignals` / `awaitUntil`. */
  | "AWAITING"
  | "COMPLETED"
  | "FAILED"
  /** Gate dropped it, or its await timed out with `onTimeout: "abandon"`. */
  | "ABANDONED";

/**
 * The central data structure. Replaces `DmLog` — the same row, the same
 * `@@unique([campaignId, triggerKey])` (physically the existing
 * `@@unique([automationId, commentId])`), promoted from an outcome ledger to a
 * resumable state machine.
 *
 * This is what collapses today's three BullMQ job types
 * (`process-comment`, `process-postback`, `process-followup`) plus the delayed
 * read-fallback into ONE operation: `advanceRun`.
 */
export interface ResponseRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly connectedAccountId: string;
  /**
   * FROZEN FORMAT. Instagram rows use exactly today's encodings so the live
   * idempotency contract survives the migration byte-for-byte:
   *   `<commentId>`        comment-triggered
   *   `dm:<messageId>`     inbound-DM-triggered
   *   `reveal:<userId>`    legacy standalone reveal (pre-migration rows only)
   */
  readonly triggerKey: string;
  readonly counterpartyId: string;
  readonly counterpartyName: string | null;
  readonly triggerText: string;
  readonly matchedKeyword: string | null;
  readonly commentExternalId: string | null;
  readonly postExternalId: string | null;
  readonly status: RunStatus;
  /** Index of the next step to attempt. */
  readonly cursor: number;
  readonly awaitingSignals: readonly string[];
  readonly awaitUntil: Date | null;
  readonly onTimeout: "continue" | "abandon" | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly attempts: number;
}

export interface NewRun {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly connectedAccountId: string;
  readonly triggerKey: string;
  readonly counterpartyId: string;
  readonly counterpartyName: string | null;
  readonly triggerText: string;
  readonly matchedKeyword: string | null;
  readonly commentExternalId: string | null;
  readonly postExternalId: string | null;
}

export interface RunPark {
  readonly cursor: number;
  readonly awaitingSignals: readonly string[];
  readonly awaitUntil: Date;
  readonly onTimeout: "continue" | "abandon";
}

/**
 * One row per (run, step). `@@unique([runId, stepIndex])` is the idempotency
 * primitive, generalising today's `publicReplySentAt`: a step with a terminal
 * outcome and `repeat: "once"` is never executed again, no matter how many
 * times the queue redelivers or the reconciler re-finds the comment.
 */
export interface StepOutcome {
  readonly runId: string;
  readonly stepIndex: number;
  readonly kind: string;
  readonly status: StepStatus;
  readonly externalId: string | null;
  readonly error: string | null;
  readonly at: Date;
}

export type StepStatus =
  | "SENT"
  | "FAILED"
  /** Another campaign holds the platform's one-shot. Today's SKIPPED_DEDUP. */
  | "SKIPPED_DEDUP"
  /** A renewable bucket refused and the retry budget is spent. */
  | "SKIPPED_RATE_LIMIT"
  /** A non-renewable bucket refused (workspace month, YouTube day). */
  | "SKIPPED_PLAN_LIMIT"
  /** Pre-flight said this recipient can never take this delivery. */
  | "SKIPPED_INELIGIBLE"
  /** The follow gate said DROP. */
  | "DROPPED_BY_GATE";

export interface StoredCampaign {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly connectedAccountId: string;
  readonly compiledPlan: unknown;
  readonly draft: unknown;
  readonly isActive: boolean;
  readonly trackedLinks: readonly TrackedLink[];
}

export interface TrackedLink {
  readonly slug: string;
  readonly label: string | null;
  readonly destinationUrl: string;
}

export interface RaiseIncident {
  readonly connectedAccountId: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly message: string;
  readonly detail: unknown;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** One queue message. Idempotent: safe to redeliver, safe to run concurrently. */
export async function dispatch(ctx: EngineContext, event: IngestedEvent): Promise<void> {
  // TODO:
  //   comment | inboundMessage -> startRuns(ctx, event)
  //   signal                   -> resolveSignal(ctx, event)
  throw new Error("not implemented");
}

/**
 * Match the trigger against this account's active campaigns and create (or
 * find) one run per match, then advance each.
 *
 * Keyword matching is unchanged — `matchKeywords(text, keywords, wholeWordMatch)`
 * from `lib/utils/keyword-matcher.ts` moves across untouched, tests and all.
 *
 * Creating a run is an upsert on `(campaignId, triggerKey)`. Two concurrent
 * deliveries of the same comment produce one row; the loser re-reads and
 * proceeds to the lease, so nothing is lost and nothing is duplicated.
 */
export async function startRuns(
  ctx: EngineContext,
  trigger: StartTrigger
): Promise<readonly string[]> {
  throw new Error("not implemented");
}

/**
 * Route a signal to the run(s) it advances.
 *
 * `{ byRun }` — a button tap. The postback payload is `r:<runId>`.
 * `{ byUser }` — a read receipt, which names no run: resolve to that user's
 *   runs parked on `"read"` for this account. This is the read-receipt
 *   fallback, now expressed as an ordinary signal rather than a bespoke
 *   delayed job.
 *
 * Legacy: postback payloads minted before the migration are
 * `reveal:<automationId>` / `followcheck:<automationId>`. `parsePostbackTarget`
 * accepts both for one deprecation window (Instagram's messaging window is
 * 24h, so 48h suffices) and resolves the legacy form to the user's most recent
 * run on that campaign.
 */
export async function resolveSignal(ctx: EngineContext, signal: RunSignal): Promise<void> {
  throw new Error("not implemented");
}

// ─── The state machine ───────────────────────────────────────────────────────

export type AdvanceCause =
  | { readonly kind: "start" }
  | { readonly kind: "signal"; readonly signal: RunSignal }
  | { readonly kind: "timeout" }
  | { readonly kind: "retry"; readonly attempt: number };

/**
 * Execute steps from the run's cursor until the plan ends, a step parks the
 * run, or a step fails retryably.
 *
 * Concurrency: Cloudflare Queues is at-least-once and has no deterministic
 * job-id dedup (BullMQ's `jobId` has no equivalent). Rather than add a
 * Durable Object for locking, the run row leases ITSELF with a conditional
 * UPDATE — the row already has to be read, so the lease is free, it is
 * strongly consistent, it expires on its own, and it keeps the run's identity
 * and its mutual exclusion in one place instead of two.
 *
 * Crash safety: every step's effect is recorded before the cursor moves, and
 * every step is guarded by either a `StepOutcome` row or an `ExclusiveClaim`.
 * A crash between `deliver` and `recordOutcome` is the one real gap: the claim
 * is already held by THIS run, so the retry re-acquires it (`firstAcquired:
 * false`) and re-sends. For a claim-bearing step the platform refuses the
 * second send and `classify` returns `INELIGIBLE`, which records SENT-or-
 * ineligible rather than a spurious failure. For claim-free steps (a public
 * reply) a duplicate is possible and accepted — see Tradeoffs.
 */
export async function advanceRun(
  ctx: EngineContext,
  runId: string,
  cause: AdvanceCause
): Promise<RunStatus> {
  throw new Error("not implemented");
}

/**
 * One step. The only function in the engine that touches an adapter, and it
 * touches it through four members: `plan`, `deliver`, `classify`, and the
 * optional `probeFollowStatus`.
 */
export async function executeStep<P extends PlatformId>(
  ctx: EngineContext,
  adapter: PlatformAdapter<P>,
  run: ResponseRun,
  account: ConnectedAccount<P>,
  plan: CompiledPlan<P>,
  stepIndex: number,
  cause: AdvanceCause
): Promise<StepResolution> {
  // TODO, in order — and note that not one of these lines names a platform:
  //
  //   1. const step = plan.steps[stepIndex]
  //      const prior = outcomes[stepIndex]
  //      if (prior?.terminal && step.repeat === "once") return { kind: "skip" }
  //
  //   2. const dp = adapter.plan(step, runContext(run, cause), account)   // pure
  //
  //   3. if (step.kind === "followGate"):
  //        const status = await adapter.probeFollowStatus!(account, cred, run.counterpartyId)
  //        switch (resolveFollowGate(status, contactOf(cause), canReprompt(cause)))
  //          PASS   -> return { kind: "advance" }        // gate consumed nothing
  //          PROMPT -> fall through and deliver the prompt, then park
  //          DROP   -> record DROPPED_BY_GATE, return { kind: "abandon" }
  //      `probeFollowStatus!` is safe: a followGate step is unconstructable on
  //      a platform whose ceiling lacks FOLLOW_GATE, and an adapter whose
  //      ceiling has it must implement the probe.
  //
  //   4. const claim = await ctx.claims.acquire(dp.claims, run.id)
  //      if (!claim.held) -> record SKIPPED_DEDUP with the holder's campaign
  //      name, return { kind: "advance" }.  Empty claims list -> trivially held,
  //      so YouTube never touches the ledger.
  //
  //   5. const res = await ctx.quota.reserve(dp.cost, dp.buckets)
  //      if (!res.ok):
  //        onRefusal === "skip"       -> SKIPPED_PLAN_LIMIT, advance
  //        onRefusal === "retryAfter" -> if attempt < MAX_REQUEUE (3)
  //                                        requeue after refusal.retryAfterMs
  //                                      else SKIPPED_RATE_LIMIT, advance
  //      (This is today's 750/hr requeue-30min-x3 behaviour, now derived from
  //      the bucket's own policy instead of a constant in the limiter.)
  //
  //   6. if (dp.preflight) { const p = await dp.preflight(cred)
  //        if (!p.eligible) -> release the lease, record SKIPPED_INELIGIBLE,
  //        keep the claim released (nothing was attempted), advance }
  //
  //   7. const content = renderContent(step, run, campaign.trackedLinks, run.id)
  //
  //   8. try { receipt = await adapter.deliver(dp, content, cred)
  //            await res.lease.settle("commit")
  //            recordOutcome(SENT, receipt.externalId) }
  //      catch (e) {
  //        const f = adapter.classify(e)
  //        await res.lease.settle("release")
  //        if (f.attempted === "no") await ctx.claims.releaseUnattempted(dp.claims, run.id)
  //        if (f.incident) await ctx.incidents.raise(...)
  //        RETRYABLE | RATE_LIMITED -> { kind: "retry", afterMs }
  //        WINDOW_CLOSED | INELIGIBLE -> record and advance (not the creator's
  //                                       problem; today's read-fallback path
  //                                       logs and returns rather than failing)
  //        else -> record FAILED, { kind: "fail" }
  //      }
  //
  //   9. if (step.awaits) -> parkRun + ctx.schedule.advanceAt(run.id,
  //        now + step.awaits.timeoutMs); return { kind: "park" }
  //      else return { kind: "advance" }
  throw new Error("not implemented");
}

export type StepResolution =
  | { readonly kind: "advance" }
  | { readonly kind: "skip" }
  | { readonly kind: "park" }
  | { readonly kind: "abandon" }
  | { readonly kind: "retry"; readonly afterMs: number }
  | { readonly kind: "fail"; readonly failure: Failure };

/**
 * `{username}` and `{link}` substitution plus tracked-URL rewriting.
 * `lib/tracking/message.ts` moves across unchanged; this wraps it and adds the
 * postback payload (`r:<runId>`) so button steps carry their own continuation.
 */
export function renderContent<P extends PlatformId>(
  step: AnyStep<P>,
  run: ResponseRun,
  links: readonly TrackedLink[],
  runId: string
): import("../platform/adapter").RenderedContent {
  throw new Error("not implemented");
}

/** Retry budget for a renewable-bucket refusal. Today's MAX_REQUEUE_ATTEMPTS. */
export const MAX_REQUEUE_ATTEMPTS = 3;

/** Exact BullMQ parity: `msg.retry({ delaySeconds: BACKOFF_SECONDS[attempt] })`. */
export const BACKOFF_SECONDS = [300, 900, 2700] as const;
