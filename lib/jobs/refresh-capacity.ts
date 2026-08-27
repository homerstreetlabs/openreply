/**
 * Measure the ceiling for platforms whose budget is a function of live data.
 *
 * Facebook allows 4800 calls a day times the Page's engaged users, so the real
 * ceiling is only knowable by asking. Without this the `derived` capacity never
 * has a measured value and every Page runs on the floor forever, which is safe
 * but wrong: a busy Page is throttled to a fraction of what Meta would allow.
 *
 * Failure leaves the previous measurement in place rather than clearing it. A
 * stale number is still better than none, and the broker already treats one
 * past `staleAfterMs` as unmeasured.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";

/** Meta's documented multiplier: calls per 24 hours per engaged user. */
const CALLS_PER_ENGAGED_USER = 4_800;

export interface CapacityStat {
  connectedAccountId: string;
  handle: string;
  units: number | null;
  error: string | null;
}

export async function refreshDerivedCapacity(): Promise<CapacityStat[]> {
  const accounts = await prisma.connectedAccount.findMany({
    // Only Facebook meters this way. Instagram is a constant, YouTube is a
    // pooled project budget, and TikTok is two fixed tiers, so none of them has
    // anything to measure.
    where: { platform: "FACEBOOK", accessToken: { not: "" } },
    select: { id: true, instagramId: true, username: true, accessToken: true },
  });

  const stats: CapacityStat[] = [];

  for (const account of accounts) {
    try {
      const token = decryptToken(account.accessToken);
      const engaged = await engagedUsers(token, account.instagramId);
      const units = engaged === null ? null : engaged * CALLS_PER_ENGAGED_USER;

      if (units !== null) {
        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: { derivedCapacityUnits: units, derivedCapacityAt: new Date() },
        });
      }

      stats.push({
        connectedAccountId: account.id,
        handle: account.username,
        units,
        error: units === null ? "Page returned no engagement figure" : null,
      });
    } catch (error) {
      stats.push({
        connectedAccountId: account.id,
        handle: account.username,
        units: null,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return stats;
}

/**
 * Yesterday's engaged users for a Page.
 *
 * Insights lag, so the most recent complete day is the freshest honest figure.
 * A Page with no data yet returns null rather than zero, because zero would
 * compute a ceiling of zero and stop the Page sending entirely.
 */
async function engagedUsers(
  accessToken: string,
  pageId: string
): Promise<number | null> {
  const url = new URL(
    `https://graph.facebook.com/${getMetaGraphApiVersion()}/${pageId}/insights`
  );
  url.searchParams.set("metric", "page_engaged_users");
  url.searchParams.set("period", "day");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  // SAFETY: every field is optional, and the error branch below runs before any
  // value is read, so a payload of another shape yields null rather than a
  // fabricated ceiling.
  const body = (await response.json()) as {
    data?: Array<{ values?: Array<{ value?: number }> }>;
    error?: { message?: string };
  };
  if (!response.ok || body.error) {
    throw new Error(
      `Facebook insights error: ${body.error?.message ?? response.statusText}`
    );
  }

  const values = body.data?.[0]?.values ?? [];
  const latest = values.at(-1)?.value;
  return typeof latest === "number" && latest > 0 ? latest : null;
}
