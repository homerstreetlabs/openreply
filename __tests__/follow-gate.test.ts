import { describe, it, expect } from "vitest";
import { resolveFollowGate, canReprompt } from "../lib/runtime/follow-gate";

/**
 * The axis is provenance, not platform. On first contact an unverifiable
 * status must not hand over the link; after a tap, trapping a real follower is
 * the worse error.
 */
describe("the follow gate", () => {
  it("passes anyone the platform confirms is following", () => {
    expect(resolveFollowGate(true, "FIRST_CONTACT", true)).toBe("PASS");
    expect(resolveFollowGate(true, "FIRST_CONTACT", false)).toBe("PASS");
    expect(resolveFollowGate(true, "USER_CONFIRMED", true)).toBe("PASS");
    expect(resolveFollowGate(true, "USER_CONFIRMED", false)).toBe("PASS");
  });

  it("fails closed on first contact when the platform will not answer", () => {
    expect(resolveFollowGate(null, "FIRST_CONTACT", true)).toBe("PROMPT");
    expect(resolveFollowGate(null, "FIRST_CONTACT", false)).toBe("DROP");
  });

  it("fails open once the person has claimed to follow", () => {
    expect(resolveFollowGate(null, "USER_CONFIRMED", true)).toBe("PASS");
    expect(resolveFollowGate(null, "USER_CONFIRMED", false)).toBe("PASS");
  });

  it("prompts a confirmed non-follower, and only where prompting is invited", () => {
    expect(resolveFollowGate(false, "USER_CONFIRMED", true)).toBe("PROMPT");
    expect(resolveFollowGate(false, "USER_CONFIRMED", false)).toBe("DROP");
    expect(resolveFollowGate(false, "FIRST_CONTACT", true)).toBe("PROMPT");
    expect(resolveFollowGate(false, "FIRST_CONTACT", false)).toBe("DROP");
  });

  /**
   * A read receipt is not an answer. Prompting there pesters someone who never
   * engaged, which is why the speculative path cannot re-prompt.
   */
  it("does not re-prompt on a speculative signal", () => {
    expect(canReprompt(true)).toBe(false);
    expect(canReprompt(false)).toBe(true);
  });
});
