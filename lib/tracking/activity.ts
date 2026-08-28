/**
 * What a campaign run actually did.
 *
 * `ResponseRun` is a run ledger, and it was being read as a DM ledger. The
 * worker writes a row for every delivery attempt on every platform, so a
 * YouTube public reply — on a platform with no messaging API at all — was
 * counted under a tile labelled "DMs Sent" and filtered on a page called
 * "DM Logs".
 *
 * Both values below are derived from the row rather than stored beside it.
 * A stored `action` column would be a second source of truth that has to be
 * kept in step with the timestamps that already answer the question.
 */

import type { DmStatus } from "@/app/generated/prisma/client";

/** Which channel the run used. */
export type RunAction = "DIRECT_MESSAGE" | "PUBLIC_REPLY";

/** Where the run ended up, collapsing the six skip reasons into one outcome. */
export type RunOutcome = "DELIVERED" | "FAILED" | "SKIPPED" | "PENDING";

export interface RunTimestamps {
  readonly dmSentAt: Date | string | null;
  readonly publicReplySentAt: Date | string | null;
}

/**
 * A run that sent a DM is a DM, whatever else it also did.
 *
 * A campaign can post a public reply *and* open a DM, and the DM is the outcome
 * the creator cares about — the public reply is the nudge that carries someone
 * to it. A run that only ever replied publicly is a public reply. A run that
 * has sent nothing yet is attributed by what it was going to do, which is why
 * the unsent case falls through to DIRECT_MESSAGE only when no public reply
 * exists to claim it.
 */
export function runAction(run: RunTimestamps): RunAction {
  if (run.dmSentAt) return "DIRECT_MESSAGE";
  if (run.publicReplySentAt) return "PUBLIC_REPLY";
  return "DIRECT_MESSAGE";
}

export function runOutcome(status: DmStatus): RunOutcome {
  if (status === "SENT") return "DELIVERED";
  if (status === "FAILED") return "FAILED";
  if (status === "PENDING") return "PENDING";
  return "SKIPPED";
}

/**
 * The statuses that mean a run reached someone. One list, so the tiles, the
 * chart and the CTR denominator cannot drift apart.
 */
export const DELIVERED_STATUSES = ["SENT"] as const satisfies readonly DmStatus[];
