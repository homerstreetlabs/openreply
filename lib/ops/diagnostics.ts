import { prisma } from "@/lib/db/client";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";

/**
 * Everything the diagnostics page shows for one workspace.
 *
 * The page types itself from this function's return rather than restating the
 * shape, so a renamed field fails typecheck instead of crashing the page in
 * production, which is what happened when `ResponseRun` replaced the
 * automation-era field names.
 */
export async function loadDiagnostics(workspaceId: string) {
  const [
    workerHealth,
    workerAlerts,
    webhookFailures,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
  ] = await Promise.all([
    getWorkerHealth(),
    getWorkerAlerts(10),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, object: true, errorMessage: true, createdAt: true },
    }),
    prisma.responseRun.findMany({
      where: {
        workspaceId,
        status: {
          in: ["FAILED", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT", "SKIPPED_NO_MATCH"],
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        triggerText: true,
        errorMessage: true,
        updatedAt: true,
        campaign: { select: { name: true } },
      },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId, source: "TOKEN_REFRESH", level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, message: true, createdAt: true },
    }),
    prisma.operationalEvent.findMany({
      where: { OR: [{ workspaceId }, { workspaceId: null }] },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, source: true, level: true, message: true, createdAt: true },
    }),
  ]);

  return {
    workerHealth,
    workerAlerts,
    webhookFailures,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
  };
}

export type Diagnostics = Awaited<ReturnType<typeof loadDiagnostics>>;
