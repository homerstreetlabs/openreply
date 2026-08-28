import { describe, expect, it, vi } from "vitest";

vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "tt_secret");

import { ADAPTERS } from "../lib/platforms/registry";
import { TOKEN_REFRESH_CRON, cronIntervalMs } from "../lib/jobs/refresh-tokens";
import type { Platform } from "../lib/platforms/types";

const PLATFORMS = Object.keys(ADAPTERS) as Platform[];

/**
 * An adapter's `refreshWithinMs` is a request, and the cron is the only thing
 * that answers it. Nothing refreshes a token lazily before use, so a tick that
 * fires less often than the window can never catch a token inside it.
 *
 * Instagram survived this because 60 days against a 10-day window leaves room
 * for a daily tick. YouTube's token lives an hour and asks for ten minutes'
 * notice, so a daily tick reaches it for about one connect time in a hundred.
 */
describe("token refresh cadence", () => {
  const interval = cronIntervalMs(TOKEN_REFRESH_CRON);

  it.each(PLATFORMS)(
    "%s is checked more often than its refresh window",
    (platform) => {
      const lifetime = ADAPTERS[platform].tokens;
      if (lifetime.kind === "permanent") return;

      expect(
        interval,
        `${platform} wants refreshing within ${lifetime.refreshWithinMs / 60_000}min ` +
          `but the cron fires every ${interval / 60_000}min`
      ).toBeLessThan(lifetime.refreshWithinMs);
    }
  );

  /**
   * The window also has to fit inside the token's life, or the account is dead
   * before it is ever eligible. This is what makes the check above sufficient
   * rather than merely necessary.
   */
  it("leaves at least two ticks inside every refresh window", () => {
    for (const platform of PLATFORMS) {
      const lifetime = ADAPTERS[platform].tokens;
      if (lifetime.kind === "permanent") continue;

      const ticksInWindow = lifetime.refreshWithinMs / interval;
      expect(ticksInWindow, `${platform} gets ${ticksInWindow} ticks`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("cronIntervalMs", () => {
  it("reads a minute step", () => {
    expect(cronIntervalMs("*/5 * * * *")).toBe(300_000);
    expect(cronIntervalMs("*/15 * * * *")).toBe(900_000);
  });

  it("treats a fixed daily time as daily", () => {
    expect(cronIntervalMs("0 5 * * *")).toBe(86_400_000);
  });

  /**
   * The invariant this feeds is only as good as this reader. A shape it cannot
   * parse has to stop the build rather than yield a plausible default.
   */
  it("refuses a shape it cannot read", () => {
    expect(() => cronIntervalMs("0 */2 * * *")).toThrow();
    expect(() => cronIntervalMs("not a cron")).toThrow();
  });
});
