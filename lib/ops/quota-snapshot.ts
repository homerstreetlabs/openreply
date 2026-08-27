/**
 * Mirroring the quota Durable Objects into the database for the admin overview.
 *
 * The Durable Object is the source of truth. This is a stale copy refreshed on a
 * cron, and nothing reads it to make a decision. The reason it exists at all is
 * that a dashboard cannot fan out to one object per account on every page load,
 * and the reason it is named "snapshot" is so nobody later mistakes it for the
 * ledger and starts admitting sends against it.
 */

import { prisma } from "@/lib/db/client";
import { tryBindings } from "@/lib/cloudflare/bindings";
import { adapterFor, pollOnlyPlatforms } from "@/lib/platforms/registry";
import { discoveryBuckets } from "@/lib/runtime/discovery";
import { bucketName, pressure } from "@/lib/runtime/quota";
import type { Capacity, Window } from "@/lib/runtime/quota";

/**
 * One pass over the accounts whose platform meters discovery.
 *
 * Webhook platforms produce no buckets, so they are skipped rather than written
 * as rows with a zero that looks like a measurement.
 */
export async function snapshotQuota(): Promise<void> {
  // Without a Durable Object binding there is nothing to mirror, and `pressure`
  // reports 0 for "no runtime" exactly as it does for "empty bucket". Writing
  // then would fill an admin-facing table with fabricated zeroes.
  if (!tryBindings()) return;

  const accounts = await prisma.connectedAccount.findMany({
    where: { platform: { in: pollOnlyPlatforms() } },
    select: {
      id: true,
      platform: true,
      instagramId: true,
      providerAppId: true,
      workspaceId: true,
    },
  });

  for (const account of accounts) {
    const adapter = adapterFor(account.platform);
    const appId = account.providerAppId ?? "default";
    const buckets = discoveryBuckets(adapter, account.instagramId, appId);

    for (const spec of buckets) {
      const name = bucketName(spec);
      const capacity = capacityOf(spec.capacity);
      const filled = await pressure([spec]);
      const reading = {
        used: Math.round(filled * capacity),
        capacity,
        windowResetsAt: windowResetAt(spec.window),
        observedAt: new Date(),
      };

      await prisma.quotaSnapshot
        .upsert({
          where: { bucketName: name },
          create: {
            bucketName: name,
            label: `${account.platform.toLowerCase()} discovery`,
            connectedAccountId: account.id,
            providerAppId: account.providerAppId,
            workspaceId: account.workspaceId,
            ...reading,
          },
          update: reading,
        })
        .catch(() => {});
    }
  }

}

function capacityOf(capacity: Capacity): number {
  switch (capacity.kind) {
    case "fixed":
    case "pooled":
      return capacity.units;
    case "derived":
      // An unmeasured Page reports its floor, matching what the bucket will
      // actually grant rather than a ceiling nothing can justify.
      return capacity.units ?? capacity.floor;
  }
}

function windowResetAt(window: Window): Date {
  if (window.kind === "rolling") return new Date(Date.now() + window.ms);

  const now = new Date();
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    window.resetHourUtc
  );
  return new Date(reset > Date.now() ? reset : reset + 86_400_000);
}
