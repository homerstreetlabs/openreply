import { describe, expect, it } from "vitest";
import { responseBuckets, type ResponseAction } from "../lib/runtime/send-quota";
import type { Capacity } from "../lib/runtime/quota";

const budget = {
  accountExternalId: "acct",
  postId: "video-1",
  providerAppId: "default",
  derivedCapacityUnits: null,
  derivedCapacityAt: null,
};

function units(capacity: Capacity): number {
  switch (capacity.kind) {
    case "fixed":
    case "pooled":
      return capacity.units;
    case "derived":
      return capacity.floor;
  }
}

describe("response budgets", () => {
  // The broker spends one cost against every bucket in a reservation, so a
  // bucket whose capacity is smaller than that cost refuses every response.
  for (const platform of ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK"] as const) {
    for (const action of ["privateReply", "publicReply"] as ResponseAction[]) {
      it(`${platform} ${action} fits inside every bucket it draws from`, () => {
        const { buckets, cost } = responseBuckets(platform, action, budget);
        for (const bucket of buckets) {
          expect(units(bucket.capacity), bucket.meter).toBeGreaterThanOrEqual(cost.units);
        }
      });
    }
  }

  it("still caps a YouTube video at 20 replies a day", () => {
    const { buckets, cost } = responseBuckets("YOUTUBE", "publicReply", budget);
    const perVideo = buckets.find((b) => b.scope.id.endsWith(":video-1"));
    expect(perVideo && units(perVideo.capacity) / cost.units).toBe(20);
  });
});
