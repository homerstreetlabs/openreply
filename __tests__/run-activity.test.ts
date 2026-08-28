import { describe, expect, it } from "vitest";
import { runAction, runOutcome } from "../lib/tracking/activity";

/**
 * The conflation this replaces: `ResponseRun` is a run ledger, and every tile
 * and filter read it as a DM ledger. A YouTube public reply — on a platform
 * with no messaging API to have sent a DM with — was counted under "DMs Sent".
 */
describe("runAction", () => {
  it("calls a public-reply-only run what it is", () => {
    expect(
      runAction({ dmSentAt: null, publicReplySentAt: new Date("2026-08-01") })
    ).toBe("PUBLIC_REPLY");
  });

  it("calls a DM a DM", () => {
    expect(
      runAction({ dmSentAt: new Date("2026-08-01"), publicReplySentAt: null })
    ).toBe("DIRECT_MESSAGE");
  });

  /**
   * A campaign can post a public reply and open a DM. The DM is the outcome the
   * creator cares about; the public reply is the nudge that carries someone to
   * it, so counting the run as a public reply would undercount DMs.
   */
  it("attributes a run that did both to the DM", () => {
    expect(
      runAction({
        dmSentAt: new Date("2026-08-01T00:01:00Z"),
        publicReplySentAt: new Date("2026-08-01T00:00:00Z"),
      })
    ).toBe("DIRECT_MESSAGE");
  });

  it("does not invent a channel for a run that has sent nothing", () => {
    expect(runAction({ dmSentAt: null, publicReplySentAt: null })).toBe(
      "DIRECT_MESSAGE"
    );
  });
});

describe("runOutcome", () => {
  it("collapses every skip reason into one outcome", () => {
    for (const status of [
      "SKIPPED_DEDUP",
      "SKIPPED_RATE_LIMIT",
      "SKIPPED_PLAN_LIMIT",
      "SKIPPED_NO_MATCH",
    ] as const) {
      expect(runOutcome(status)).toBe("SKIPPED");
    }
  });

  it("keeps delivered, failed and pending distinct", () => {
    expect(runOutcome("SENT")).toBe("DELIVERED");
    expect(runOutcome("FAILED")).toBe("FAILED");
    expect(runOutcome("PENDING")).toBe("PENDING");
  });
});
