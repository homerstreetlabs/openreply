import { describe, it, expect } from "vitest";
import { compile, parseStoredPlan, copyRulesFor } from "../lib/campaigns/compile";
import { availableSteps, platformCeiling } from "../lib/campaigns/steps";
import type { Capability } from "../lib/platforms/types";

const ig = platformCeiling("INSTAGRAM");
const yt = platformCeiling("YOUTUBE");

const reply = { kind: "publicReply", spec: { variants: ["one", "two"] } };
const dm = { kind: "directMessage", spec: { text: "here is the link" } };

describe("the boundary gate", () => {
  it("compiles a plan the account can actually run", () => {
    const result = compile("INSTAGRAM", ig, [reply, dm]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.steps.map((s) => s.kind)).toEqual(["publicReply", "directMessage"]);
  });

  it("refuses a step the platform cannot perform", () => {
    const result = compile("YOUTUBE", yt, [reply, dm]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("CAPABILITY_UNAVAILABLE");
      expect(result.errors[0].message).toContain("PRIVATE_REPLY");
    }
  });

  /**
   * The account's set, not the platform's ceiling. Two accounts on one platform
   * differ when a scope is declined or a region is ineligible.
   */
  it("refuses a step the platform allows but this account was not granted", () => {
    const narrowed = new Set<Capability>(["PUBLIC_REPLY"]);

    const result = compile("INSTAGRAM", narrowed, [dm]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("rejects an unknown step rather than ignoring it", () => {
    const result = compile("INSTAGRAM", ig, [{ kind: "mindControl", spec: {} }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("UNKNOWN_STEP");
  });

  it("rejects a step whose spec is missing what it needs", () => {
    const result = compile("INSTAGRAM", ig, [{ kind: "directMessage", spec: { text: "  " } }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("MALFORMED_SPEC");
  });

  it("refuses an empty plan instead of saving a campaign that does nothing", () => {
    const result = compile("INSTAGRAM", ig, []);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("EMPTY_PLAN");
  });
});

/**
 * The public reply is posted before the DM leg so that a DM refused for a
 * non-follower never suppresses the visible reply. Making it the compiler's
 * job means dragging a step in the builder cannot break it.
 */
describe("canonical ordering", () => {
  it("hoists the public reply ahead of the DM whatever order it arrives in", () => {
    const result = compile("INSTAGRAM", ig, [dm, reply]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.steps[0].kind).toBe("publicReply");
  });
});

/**
 * YouTube Developer Policy III.F prohibits offering anything in exchange for a
 * comment, and the strike lands on the creator's channel rather than ours.
 */
describe("platform copy policy", () => {
  it("blocks the comment-bait mechanic on YouTube", () => {
    const result = compile("YOUTUBE", yt, [
      {
        kind: "publicReply",
        spec: { variants: ["comment LINK below and I'll send you the guide", "second variant"] },
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("COPY_POLICY_VIOLATION");
      expect(result.errors[0].message).toContain("III.F");
    }
  });

  it("allows the same campaign on Instagram, where no such rule exists", () => {
    const result = compile("INSTAGRAM", ig, [
      {
        kind: "publicReply",
        spec: { variants: ["comment LINK below and I'll send you the guide"] },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("requires more than one variant where identical replies read as spam", () => {
    for (const platform of ["YOUTUBE", "TIKTOK"] as const) {
      const result = compile("YOUTUBE", platformCeiling(platform), [
        { kind: "publicReply", spec: { variants: ["the only thing it ever says"] } },
      ]);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].code).toBe("COPY_POLICY_VIOLATION");
    }
  });

  it("leaves the Meta platforms unconstrained", () => {
    expect(copyRulesFor("INSTAGRAM")).toHaveLength(0);
    expect(copyRulesFor("FACEBOOK")).toHaveLength(0);
  });
});

/**
 * A campaign can outlive the capability it was written against: a revoked Meta
 * permission, a TikTok account that changes region, a scope declined on
 * reconnect.
 */
describe("a stored plan is validated input, not a cache", () => {
  it("refuses a plan that was legal when saved and is not now", () => {
    const saved = compile("INSTAGRAM", ig, [reply, dm]);
    expect(saved.ok).toBe(true);

    const shrunk = new Set<Capability>(["PUBLIC_REPLY"]);
    const reloaded = parseStoredPlan("INSTAGRAM", shrunk, [reply, dm]);

    expect(reloaded.ok).toBe(false);
    if (!reloaded.ok) expect(reloaded.errors[0].code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("refuses stored JSON that is not a list of steps", () => {
    const result = parseStoredPlan("INSTAGRAM", ig, { kind: "publicReply" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("MALFORMED_SPEC");
  });
});

describe("what the builder may offer", () => {
  it("offers YouTube only the public reply, and says what the rest need", () => {
    const steps = availableSteps(yt);

    expect(steps.filter((s) => s.available).map((s) => s.kind)).toEqual(["publicReply"]);
    expect(steps.find((s) => s.kind === "followGate")?.missing).toContain("FOLLOW_GATE");
  });

  it("offers Facebook everything except the follow gate", () => {
    const steps = availableSteps(platformCeiling("FACEBOOK"));

    expect(steps.find((s) => s.kind === "followGate")?.available).toBe(false);
    expect(steps.find((s) => s.kind === "directMessage")?.available).toBe(true);
  });
});
