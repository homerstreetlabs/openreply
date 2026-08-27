/**
 * Raising and clearing incidents.
 *
 * Cloudflare Notifications has no Workers alert type, so nothing external will
 * tell us an account went dark. This is what notices.
 *
 * The hard requirement is deduplication. A token that expired on Friday fails
 * every send for the whole weekend, and four thousand rows would bury the one
 * fact an admin needs. `openKey` holds the kind while the incident is open and
 * NULL once resolved, so the unique on (account, openKey) turns raising into an
 * upsert: the first failure inserts, every later one increments.
 */

import { prisma } from "@/lib/db/client";
import type { IncidentKind, IncidentSeverity, Prisma } from "@/app/generated/prisma/client";

export interface RaiseParams {
  kind: IncidentKind;
  connectedAccountId: string;
  workspaceId?: string | null;
  campaignId?: string | null;
  severity?: IncidentSeverity;
  message: string;
  detail?: Prisma.InputJsonValue;
}

/**
 * Record that something is wrong, or that it is still wrong.
 *
 * Idempotent by (account, kind): calling it on every failed send yields one row
 * whose count tracks how bad it is, not a row per failure.
 */
export async function raiseIncident(params: RaiseParams): Promise<void> {
  const now = new Date();

  // The newest message wins. An expiry that became a revocation should read as
  // the latter, and the count still says how long it has been running.
  const update: Prisma.IncidentUpdateInput = {
    count: { increment: 1 },
    lastSeenAt: now,
    message: params.message,
  };
  if (params.detail !== undefined) update.detail = params.detail;
  if (params.severity) update.severity = params.severity;

  // Best effort. An alert we failed to record must never take down the send path
  // that was already failing, nor the one that just succeeded.
  try {
    await prisma.incident.upsert({
      where: {
        connectedAccountId_openKey: {
          connectedAccountId: params.connectedAccountId,
          openKey: params.kind,
        },
      },
      create: {
        kind: params.kind,
        openKey: params.kind,
        connectedAccountId: params.connectedAccountId,
        workspaceId: params.workspaceId ?? null,
        campaignId: params.campaignId ?? null,
        severity: params.severity ?? "WARNING",
        message: params.message,
        detail: params.detail,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update,
    });
  } catch {
    return;
  }
}

/**
 * Clear an incident once the thing works again.
 *
 * Clearing `openKey` is what frees the slot, so the next failure of the same
 * kind opens a fresh incident with its own first-seen time rather than
 * resurrecting a stale count.
 */
export async function resolveIncident(
  connectedAccountId: string,
  kind: IncidentKind
): Promise<void> {
  try {
    await prisma.incident.updateMany({
      where: { connectedAccountId, openKey: kind },
      data: { openKey: null, resolvedAt: new Date() },
    });
  } catch {
    return;
  }
}

/**
 * Map a provider failure onto the cross-platform vocabulary.
 *
 * Every adapter's errors funnel through here so the fleet view can group a
 * Meta token expiry and a TikTok one under a single heading. An unrecognised
 * failure becomes DELIVERY_FAILING rather than being dropped, because an
 * unclassified outage is still an outage.
 */
export function classifyFailure(error: unknown): IncidentKind {
  const text = error instanceof Error ? error.message : String(error);

  if (/session has been invalidated|expired|code\D*190/i.test(text)) return "TOKEN_EXPIRED";
  if (/refresh/i.test(text) && /fail/i.test(text)) return "TOKEN_REFRESH_FAILED";
  if (/reauthenticate|re-?auth/i.test(text)) return "REAUTH_REQUIRED";
  if (/permission|scope|code\D*200|not authorized/i.test(text)) return "PERMISSION_REVOKED";
  if (/unsubscrib/i.test(text)) return "WEBHOOK_UNSUBSCRIBED";
  if (/region|country|not available in/i.test(text)) return "REGION_INELIGIBLE";
  if (/quota|rate limit|code\D*4|too many requests/i.test(text)) return "QUOTA_EXHAUSTED";
  if (/policy|restricted|blocked/i.test(text)) return "POLICY_HOLD";
  return "DELIVERY_FAILING";
}
