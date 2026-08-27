/**
 * Engine health.
 *
 * Was a Redis heartbeat written every 30 seconds by an always-on process, plus
 * a capped alerts list. Neither survives the move: there is no always-on
 * process to beat, and no Redis to write to.
 *
 * The replacement is better, not merely different. A heartbeat proved a process
 * was alive, which was only ever a proxy for "is work getting done". The
 * queue's oldest-message age answers that directly, so a consumer that is
 * running but wedged now reads as unhealthy where a heartbeat would have called
 * it fine.
 *
 * Alerts move to `OperationalEvent` in Postgres, which they were already being
 * written to alongside Redis. That was duplicated state with two writers; per
 * separate-before-serializing-shared-state, one of them had to go, and the
 * durable one stays.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { queueHealth } from "@/lib/queue/client";

/** Backlog older than this means the consumer is not keeping up. */
const STALE_BACKLOG_MS = 5 * 60 * 1000;

export interface WorkerHealth {
  healthy: boolean;
  backlog: number | null;
  oldestMessageAgeMs: number | null;
  deadLettered: number | null;
  detail: string;
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  const health = await queueHealth();

  if (!health) {
    return {
      healthy: false,
      backlog: null,
      oldestMessageAgeMs: null,
      deadLettered: null,
      detail: "Queue bindings unavailable. Not running inside a Worker.",
    };
  }

  // An empty queue has no oldest message, which is the healthiest state there
  // is. Treating null as unhealthy would report a working system as broken
  // exactly when it has caught up.
  const stalled =
    health.oldestMessageAgeMs !== null && health.oldestMessageAgeMs > STALE_BACKLOG_MS;

  return {
    healthy: !stalled,
    backlog: health.backlog,
    oldestMessageAgeMs: health.oldestMessageAgeMs,
    deadLettered: health.deadLettered,
    detail: stalled
      ? `Oldest queued job is ${Math.round(health.oldestMessageAgeMs! / 1000)}s old; the consumer is not keeping up.`
      : "Queue draining normally.",
  };
}

/** What recordWorkerAlert writes. Anything else in the column is ignored. */
const alertFields = z
  .object({
    jobId: z.string().nullish(),
    instagramAccountId: z.string().nullish(),
    commentId: z.string().nullish(),
  })
  .partial();

export interface WorkerAlert {
  level: "warning" | "error";
  message: string;
  jobId?: string;
  instagramAccountId?: string;
  commentId?: string;
  createdAt: string;
}

export async function recordWorkerAlert(alert: Omit<WorkerAlert, "createdAt">) {
  await prisma.operationalEvent
    .create({
      data: {
        source: "WORKER",
        level: alert.level === "error" ? "ERROR" : "WARNING",
        message: alert.message,
        payload: {
          jobId: alert.jobId ?? null,
          instagramAccountId: alert.instagramAccountId ?? null,
          commentId: alert.commentId ?? null,
        },
      },
    })
    .catch(() => {});
}

export async function getWorkerAlerts(limit = 10): Promise<WorkerAlert[]> {
  const rows = await prisma.operationalEvent.findMany({
    where: { source: "WORKER", level: { in: ["WARNING", "ERROR"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { level: true, message: true, payload: true, createdAt: true },
  });

  return rows.map((row) => {
    const fields = alertFields.safeParse(row.payload);
    const detail = fields.success ? fields.data : {};
    return {
      level: row.level === "ERROR" ? "error" : "warning",
      message: row.message,
      jobId: detail.jobId ?? undefined,
      instagramAccountId: detail.instagramAccountId ?? undefined,
      commentId: detail.commentId ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
