/**
 * The response queue, on Cloudflare Queues.
 *
 * Replaces BullMQ, which cannot run here at all: it parks on `BRPOPLPUSH`
 * (no Worker may block indefinitely) and imports `node:worker_threads`, a
 * non-functional stub that fails at bundle time. There is no managed Redis on
 * Cloudflare, so this is a replacement rather than a port.
 *
 * Two BullMQ features have no Queues equivalent and are handled elsewhere:
 *
 *   Deterministic job ids. Queues delivery is at-least-once with no dedup key,
 *   so the job id moves into the payload as `dedupeKey` and idempotency is a
 *   database invariant. A queue that redelivers is normal, not exceptional.
 *
 *   Per-state job counts. `metrics()` reports backlog depth only, so "failed"
 *   is read from the dead-letter queue's depth instead.
 */

import { tryBindings } from "@/lib/cloudflare/bindings";
import type { Platform } from "@/app/generated/prisma/client";

export type CommentSource = "WEBHOOK" | "POLLING";

/**
 * Absent on jobs enqueued before Facebook support existed. Readers default to
 * INSTAGRAM so a job already in flight during the deploy still resolves to the
 * right account.
 */
interface PlatformScoped {
  platform?: Platform;
}

export interface ProcessCommentJob extends PlatformScoped {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  requeueAttempt?: number;
  source?: CommentSource;
}

export interface ProcessPostbackJob extends PlatformScoped {
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
  fallback?: boolean;
}

export interface ProcessFollowUpJob extends PlatformScoped {
  instagramAccountId: string;
  userId: string;
  automationId: string;
  commenterName?: string | null;
}

export interface ProcessMessageJob extends PlatformScoped {
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
}

export type DmQueueJob =
  | ProcessCommentJob
  | ProcessPostbackJob
  | ProcessFollowUpJob
  | ProcessMessageJob;

export const COMMENT_JOB_NAME = "process-comment";
export const POSTBACK_JOB_NAME = "process-postback";
export const FOLLOWUP_JOB_NAME = "process-followup";
export const MESSAGE_JOB_NAME = "process-message";

export type JobName =
  | typeof COMMENT_JOB_NAME
  | typeof POSTBACK_JOB_NAME
  | typeof FOLLOWUP_JOB_NAME
  | typeof MESSAGE_JOB_NAME;

/**
 * The envelope. `name` replaces BullMQ's job name and `dedupeKey` replaces its
 * job id, carried in the body because Queues has nowhere else to put it.
 */
export interface QueueEnvelope<T extends DmQueueJob = DmQueueJob> {
  name: JobName;
  data: T;
  /** What BullMQ enforced for us. Now enforced by the consumer against the DB. */
  dedupeKey: string;
  /** Requeue count across deliberate re-enqueues, distinct from Queues retries. */
  attempt: number;
}

/** Cloudflare's ceiling, and exactly the 24h our longest follow-up needs. */
export const MAX_DELAY_SECONDS = 86_400;

export interface EnqueueOptions {
  delaySeconds?: number;
}

export function clampDelay(seconds: number): number {
  return Math.max(0, Math.min(Math.floor(seconds), MAX_DELAY_SECONDS));
}

/**
 * Enqueue one job. No-ops with a warning when bindings are absent (plain
 * `next dev`), so local page rendering does not explode on a queue write.
 */
export async function enqueue<T extends DmQueueJob>(
  name: JobName,
  data: T,
  dedupeKey: string,
  options: EnqueueOptions = {}
): Promise<void> {
  const env = tryBindings();
  if (!env) {
    console.warn(`[queue] no binding; dropped ${name} ${dedupeKey}`);
    return;
  }
  const envelope: QueueEnvelope<T> = { name, data, dedupeKey, attempt: 0 };
  await env.RESPONSE_QUEUE.send(
    envelope,
    options.delaySeconds ? { delaySeconds: clampDelay(options.delaySeconds) } : undefined
  );
}

/** Re-enqueue an envelope that asked to be retried later (rate-limit requeue). */
export async function requeue(
  envelope: QueueEnvelope,
  delaySeconds: number
): Promise<void> {
  const env = tryBindings();
  if (!env) return;
  await env.RESPONSE_QUEUE.send(
    { ...envelope, attempt: envelope.attempt + 1 },
    { delaySeconds: clampDelay(delaySeconds) }
  );
}

export interface QueueHealth {
  backlog: number;
  oldestMessageAgeMs: number | null;
  deadLettered: number | null;
}

/**
 * Backlog depth and the age of the oldest message. `oldestMessageTimestamp`
 * replaces the Redis worker heartbeat outright: a heartbeat says a process was
 * alive, while a growing oldest-message age says work is not being done, which
 * is the thing anyone actually wanted to know.
 */
export async function queueHealth(): Promise<QueueHealth | null> {
  const env = tryBindings();
  if (!env) return null;

  const [main, dlq] = await Promise.all([
    env.RESPONSE_QUEUE.metrics(),
    env.RESPONSE_DLQ.metrics(),
  ]);

  return {
    backlog: main.backlogCount,
    oldestMessageAgeMs: main.oldestMessageTimestamp
      ? Date.now() - main.oldestMessageTimestamp
      : null,
    deadLettered: dlq.backlogCount,
  };
}
