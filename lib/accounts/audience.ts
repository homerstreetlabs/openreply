/**
 * Total audience across every connected account.
 *
 * The deliberate exception to "no cross-platform aggregate". Summed reach is
 * meaningless because each platform counts a different event, but a follower is
 * a person who chose to follow, and a creator asking "how big is my audience"
 * is asking a real question that no single account answers.
 *
 * What makes it honest is that the parts travel with the total. Four platforms
 * call this by three different nouns, so the breakdown is not a nicety — it is
 * what stops the number claiming to be something it is not.
 */

import { prisma } from "@/lib/db/client";
import { adapterFor } from "@/lib/platforms/registry";
import { decryptToken } from "@/lib/meta/oauth";
import { mapWithConcurrency } from "@/lib/platforms/concurrency";
import type { Platform } from "@/app/generated/prisma/client";

export interface AudienceSlice {
  readonly accountId: string;
  readonly platform: Platform;
  readonly label: string;
  /** The platform's own word: followers, subscribers, fans. */
  readonly noun: string;
  /** Null when the account hides the count, which is not a zero. */
  readonly value: number | null;
}

export interface CombinedAudience {
  readonly total: number;
  readonly slices: readonly AudienceSlice[];
  /** Accounts that could not be counted, so the total can say it is partial. */
  readonly unavailable: number;
  /** Every distinct noun in the sum, for copy that names what was added. */
  readonly nouns: readonly string[];
}

const AUDIENCE_CONCURRENCY = 4;

export async function combinedAudience(
  workspaceId: string
): Promise<CombinedAudience> {
  const rows = await prisma.connectedAccount.findMany({
    where: { workspaceId },
    orderBy: [{ platform: "asc" }, { connectedAt: "desc" }],
    select: {
      id: true,
      platform: true,
      instagramId: true,
      username: true,
      accessToken: true,
    },
  });

  const { accountLabel } = await import("@/lib/campaigns/options");

  const slices = await mapWithConcurrency(rows, AUDIENCE_CONCURRENCY, async (row) => {
    const adapter = adapterFor(row.platform);
    if (!adapter.insights) return null;

    try {
      const audience = await adapter.insights.fetchAudience(
        decryptToken(row.accessToken),
        row.instagramId
      );
      if (!audience) return null;
      return {
        accountId: row.id,
        platform: row.platform,
        label: accountLabel(row.platform, row.username),
        noun: audience.noun,
        value: audience.current,
      } satisfies AudienceSlice;
    } catch {
      // One platform refusing must not cost the other three their numbers.
      return {
        accountId: row.id,
        platform: row.platform,
        label: accountLabel(row.platform, row.username),
        noun: "followers",
        value: null,
      } satisfies AudienceSlice;
    }
  });

  const present = slices.filter((slice): slice is AudienceSlice => slice !== null);

  return {
    total: present.reduce((sum, slice) => sum + (slice.value ?? 0), 0),
    slices: present,
    unavailable: present.filter((slice) => slice.value === null).length,
    nouns: [...new Set(present.map((slice) => slice.noun))],
  };
}
