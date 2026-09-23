import { describe, expect, it } from "vitest";
import { QuotaBucket } from "../workers/engine/quota-bucket";

function bucket() {
  const store = new Map<string, unknown>();
  return new QuotaBucket({
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void store.set(key, value),
      list: async <T>() => new Map<string, T>(),
    },
  });
}

const day = { kind: "rolling", ms: 86_400_000 } as const;

describe("QuotaBucket", () => {
  // One object serves every bucket in a co-located group, and is named after the
  // coarsest. Reporting the object's name blamed the 10,000-unit pool for a
  // refusal that came from the per-video cap.
  it("names the bucket that refused, not the first one checked", async () => {
    const response = await bucket().fetch(
      new Request("https://quota/reserve", {
        method: "POST",
        body: JSON.stringify({
          op: "reserve",
          spend: { units: 50 },
          buckets: [
            { scope: { kind: "app", id: "default" }, meter: "units", window: day, capacity: { kind: "fixed", units: 10_000 } },
            { scope: { kind: "account", id: "video-1" }, meter: "units_per_video", window: day, capacity: { kind: "fixed", units: 20 } },
          ],
        }),
      })
    );

    const reply = (await response.json()) as { allowed: boolean; refusedBy: string | null };
    expect(reply.allowed).toBe(false);
    expect(reply.refusedBy).toBe("account:video-1:units_per_video");
  });
});
