import { describe, it, expect } from "vitest";
import { planStep, type RunTarget } from "../lib/runtime/execute-step";
import { builders } from "../lib/campaigns/steps";
import type { Platform } from "../lib/platforms/types";

function target(platform: Platform): RunTarget {
  return {
    platform,
    accessToken: "token",
    accountExternalId: "acct_1",
    connectedAccountId: "row_1",
    campaignId: "camp_1",
    triggerKey: "comment_1",
    postId: "post_1",
    counterpartyId: "user_1",
    counterpartyName: "someone",
    trackedLinks: [],
    budget: {
      accountExternalId: "acct_1",
      providerAppId: "app_1",
      derivedCapacityUnits: null,
      derivedCapacityAt: null,
    },
  };
}

const ig = builders("INSTAGRAM");
const yt = builders("YOUTUBE");

/**
 * The pure half. What a step consumes is decided without touching the network,
 * which is what lets the engine take claims and reserve budget before anything
 * is sent and release both when the send provably never happened.
 */
describe("planning a step", () => {
  it("claims the comment's one private reply for a DM", () => {
    const plan = planStep(ig.directMessage({ text: "here" }), target("INSTAGRAM"));

    expect(plan.claims).toHaveLength(1);
    expect(plan.claims[0]).toMatchObject({ scope: "ig:private_reply", key: "comment_1" });
  });

  /**
   * A public reply is not scarce, so it consumes nothing and never touches the
   * ledger. This is why YouTube needs no special case in the engine.
   */
  it("claims nothing for a public reply", () => {
    expect(planStep(ig.publicReply({ variants: ["hi"] }), target("INSTAGRAM")).claims).toEqual([]);
    expect(planStep(yt.publicReply({ variants: ["hi"] }), target("YOUTUBE")).claims).toEqual([]);
  });

  it("charges a YouTube reply the documented fifty units", () => {
    const plan = planStep(yt.publicReply({ variants: ["hi"] }), target("YOUTUBE"));

    expect(plan.cost.units).toBe(50);
    expect(plan.buckets.some((b) => b.meter === "youtube:units")).toBe(true);
  });

  /**
   * Facebook answers `can_reply_privately` before the send. Instagram makes you
   * find out by failing, and by then the one reply is spent.
   */
  it("asks first where the platform can answer, and not where it cannot", () => {
    const dm = { text: "here" };
    expect(planStep(ig.directMessage(dm), target("INSTAGRAM")).preflight).toBe(false);
    expect(planStep(ig.directMessage(dm), target("FACEBOOK")).preflight).toBe(true);
  });

  it("claims a longer window on Facebook, which allows seven days not one", () => {
    const fb = planStep(ig.directMessage({ text: "here" }), target("FACEBOOK"));

    expect(fb.claims[0]?.scope).toBe("fb:private_reply");
  });
});
