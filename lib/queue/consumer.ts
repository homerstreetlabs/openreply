/**
 * The queue consumer boundary.
 *
 * Turns a Cloudflare Queues message body into the job shape the send logic
 * already expects, and validates it on the way in. The engine Worker owns
 * retries and acking; this owns "is this a job at all".
 */

import { z } from "zod";
import { processJob, recordWorkerFailure, type JobLike } from "@/lib/queue/dm-worker";
import type { DmQueueJob } from "@/lib/queue/client";
import {
  COMMENT_JOB_NAME,
  FOLLOWUP_JOB_NAME,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
} from "@/lib/queue/client";

/** The envelope, not the job inside it. */
const envelopeSchema = z.object({
  name: z.enum([COMMENT_JOB_NAME, POSTBACK_JOB_NAME, FOLLOWUP_JOB_NAME, MESSAGE_JOB_NAME]),
  // Validated as an object and typed as the union, with no assertion. The job's
  // own fields are checked by the handler that receives it, because each name
  // carries a different payload and a job enqueued before a deploy may
  // legitimately lack a newer field.
  data: z.custom<DmQueueJob>((value) => typeof value === "object" && value !== null),
  dedupeKey: z.string().optional(),
  attempt: z.number().optional(),
});

/** A queue message is JSON by construction. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Process one message. Throws so the caller can retry; the caller decides the
 * backoff because only it knows the delivery attempt count.
 */
export async function processQueueBatch(body: Json): Promise<void> {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    // Not retryable. A malformed body is malformed on every redelivery, so
    // retrying only delays it reaching the dead-letter queue.
    console.error("[consumer] discarding unrecognised message:", parsed.error.message);
    return;
  }

  const envelope = parsed.data;
  const job: JobLike<DmQueueJob> = {
    name: envelope.name,
    data: envelope.data,
    attemptsMade: envelope.attempt ?? 0,
    id: envelope.dedupeKey,
  };

  try {
    await processJob(job);
  } catch (error) {
    await recordWorkerFailure(job, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
