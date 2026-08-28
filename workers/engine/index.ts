/**
 * The engine Worker. Replaces the always-on `tsx worker/dm-worker.ts` process.
 *
 * That process did three things at once: consume a BullMQ queue, sweep for
 * missed comments on a timer, and write a heartbeat. On Cloudflare those are
 * three different primitives, and separating them is not a workaround. The
 * heartbeat existed to prove a process was alive; a queue's oldest-message age
 * proves work is actually moving, which is the question the heartbeat was a
 * proxy for.
 *
 * Deployed separately from the web Worker. Two reasons, both real: a Worker
 * that exports Durable Objects gets no Preview URLs, and Prisma's WASM query
 * compiler is 1.8 MB before any application code, against a 10 MB ceiling the
 * web Worker already shares with all of Next.js.
 */

import { processQueueBatch } from "@/lib/queue/consumer";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { sweepPollOnlyAccounts } from "@/lib/polling/poll-sweep";
import { snapshotQuota } from "@/lib/ops/quota-snapshot";
import { attachNextReel } from "@/lib/jobs/attach-next-reel";
import { refreshTokens, TOKEN_REFRESH_CRON } from "@/lib/jobs/refresh-tokens";
import { snapshotFollowers } from "@/lib/jobs/snapshot-followers";
import { refreshDerivedCapacity } from "@/lib/jobs/refresh-capacity";
import { advanceDueRuns } from "@/lib/runtime/dispatch";
import { z } from "zod";
import { withPrismaScope } from "@/lib/db/client";
import { withBindings, type OpenReplyEnv } from "@/lib/cloudflare/bindings";

export { AccountRateLimiter } from "./rate-limiter";
export { QuotaBucket } from "./quota-bucket";

interface ScheduledController {
  cron: string;
}

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Whatever the queue delivered. A queue message is JSON by construction, and the
 * consumer is what validates it into an envelope.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type QueueMessageBody = Json;

interface MessageBatch {
  messages: Array<{
    body: QueueMessageBody;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
}

/** Matches the BullMQ backoff this replaces, exactly. */
const BACKOFF_SECONDS = [300, 900, 2700];

/**
 * Keyed by the exact strings in `wrangler.engine.jsonc`. Cloudflare hands
 * `controller.cron` back character for character as configured, so an entry that
 * stops matching is a typo in one of the two files rather than a schedule this
 * Worker chose to ignore.
 *
 * Each job's own result is discarded here. The dispatcher's job is to run one
 * and contain its failure, and a route still returns the detail to anyone who
 * calls it by hand.
 */
const CRON_JOBS = {
  "*/5 * * * *": async () => {
    // Parked runs first. A run waiting on a read receipt or a delayed follow-up
    // has already engaged someone, and letting new discovery starve it would
    // strand a conversation that is halfway done.
    await advanceDueRuns();
    // Webhook platforms next. Their sweep is a safety net and costs nothing
    // metered, so it must not be starved by a poll-only platform's budget.
    await reconcileComments();
    await sweepPollOnlyAccounts();
  },
  [TOKEN_REFRESH_CRON]: async () => void (await refreshTokens()),
  "0 6 * * *": async () => void (await attachNextReel()),
  "0 7 * * *": async () => void (await snapshotFollowers()),
  "0 8 * * *": async () => void (await refreshDerivedCapacity()),
  // Every 15 minutes. The mirror only has to be fresh enough to read, and the
  // Durable Object stays the source of truth for every actual decision.
  "*/15 * * * *": async () => void (await snapshotQuota()),
} satisfies Record<string, () => Promise<void>>;

const engine = {
  /**
   * Cron triggers are best-effort. Cloudflare publishes no SLA, no retry
   * policy, and no delivery guarantee, and states scheduled Workers "run on
   * underutilized machines". So this stays a thin producer: a missed tick is
   * recoverable because the next one re-derives what is due from the database,
   * where a tick that did real work inline would silently lose it.
   */
  async scheduled(controller: ScheduledController, env: OpenReplyEnv, ctx: ExecutionCtx) {
    // SAFETY: a miss is expected and handled. `controller.cron` is whatever
    // wrangler was configured with, so an expression with no entry falls to the
    // warning below rather than being assumed present.
    const job = CRON_JOBS[controller.cron as keyof typeof CRON_JOBS];
    if (!job) {
      console.warn(`[engine] no job registered for cron=${controller.cron}`);
      return;
    }

    ctx.waitUntil(
      // The engine is a raw wrangler Worker, so its bindings arrive here rather
      // than through the adapter's ambient context. Without this the database
      // client cannot see Hyperdrive and dials the origin directly.
      withBindings(env, () =>
        withPrismaScope(async () => {
        try {
          await job();
        } catch (error) {
          console.error(
            "[engine] scheduled job failed:",
            error instanceof Error ? error.message : error,
            `cron=${controller.cron}`
          );
        }
        })
      )
    );
  },

  /**
   * Delivery is at-least-once, so every handler downstream has to be
   * idempotent. That is not a new constraint: the DM ledger's unique key
   * already enforced it under BullMQ, which is why the deterministic job id
   * could move into the payload without inventing a dedup store.
   */
  async queue(batch: MessageBatch, env: OpenReplyEnv) {
    await withBindings(env, () =>
      withPrismaScope(async () => {
      for (const message of batch.messages) {
        try {
          await processQueueBatch(message.body);
          message.ack();
        } catch (error) {
          const attempts = readAttempts(message.body);
          const delaySeconds =
            BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)];
          console.error(
            "[engine] job failed, retrying:",
            error instanceof Error ? error.message : error
          );
          message.retry({ delaySeconds });
        }
      }
      })
    );
  },
};

export default engine;

const attemptCarrier = z.object({ attempt: z.number() }).partial();

function readAttempts(body: QueueMessageBody): number {
  const parsed = attemptCarrier.safeParse(body);
  return parsed.success ? (parsed.data.attempt ?? 0) : 0;
}
