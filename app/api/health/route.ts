import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { queueHealth } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Database check failed",
    };
  }
}

interface QueueCounts {
  backlog: number;
  deadLettered: number | null;
  oldestMessageAgeMs: number | null;
}

async function checkQueue(): Promise<HealthCheck & { counts?: QueueCounts }> {
  try {
    const health = await queueHealth();
    if (!health) {
      return { status: "error", detail: "Queue binding unavailable" };
    }
    return {
      status: "ok",
      counts: {
        backlog: health.backlog,
        deadLettered: health.deadLettered,
        oldestMessageAgeMs: health.oldestMessageAgeMs,
      },
    };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

export async function GET() {
  const [database, queue, worker] = await Promise.all([
    checkDatabase(),
    checkQueue(),
    getWorkerHealth().catch((error) => ({
      healthy: false,
      backlog: null,
      oldestMessageAgeMs: null,
      deadLettered: null,
      detail: error instanceof Error ? error.message : "Engine check failed",
    })),
  ]);

  const healthy =
    database.status === "ok" && queue.status === "ok" && worker.healthy;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database,
        queue,
        engine: worker,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
