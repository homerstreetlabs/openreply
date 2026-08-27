import { describe, it, expect } from "vitest";
import {
  negotiate,
  regionBlocksMessaging,
  storedCapabilities,
} from "../lib/platforms/negotiate";
import { platformCeiling } from "../lib/campaigns/steps";

const ALL_IG = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
];

/**
 * Capability is a fact about the account, not the network. Two creators on one
 * platform in one workspace can differ, which a per-platform constant cannot
 * express.
 */
describe("negotiating one account's capabilities", () => {
  it("grants the whole ceiling when every scope was accepted", () => {
    const caps = negotiate({
      platform: "INSTAGRAM",
      region: "US",
      grantedScopes: ALL_IG,
    });

    expect(caps.granted).toEqual(platformCeiling("INSTAGRAM"));
    expect(caps.declined.size).toBe(0);
  });

  it("withholds what a declined scope covers, and says which scope", () => {
    const caps = negotiate({
      platform: "INSTAGRAM",
      region: "US",
      grantedScopes: ["instagram_business_basic", "instagram_business_manage_comments"],
    });

    expect(caps.granted.has("PRIVATE_REPLY")).toBe(false);
    expect(caps.granted.has("PUBLIC_REPLY")).toBe(true);
    expect(caps.declined.get("PRIVATE_REPLY")?.code).toBe("SCOPE_NOT_GRANTED");
    expect(caps.declined.get("PRIVATE_REPLY")?.message).toContain(
      "instagram_business_manage_messages"
    );
  });

  it("still grants a UK TikTok account the public reply, which is not gated", () => {
    const caps = negotiate({
      platform: "TIKTOK",
      region: "GB",
      grantedScopes: ["comment.list.manage"],
    });

    expect(caps.granted.has("PUBLIC_REPLY")).toBe(true);
  });

  it("accounts for every ceiling capability, granted or explained", () => {
    for (const platform of ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK"] as const) {
      const caps = negotiate({ platform, region: "GB", grantedScopes: [] });
      const covered = caps.granted.size + caps.declined.size;

      expect(covered).toBe(platformCeiling(platform).size);
    }
  });
});

describe("reading a stored negotiation", () => {
  it("falls back to the ceiling for an account connected before negotiation existed", () => {
    const caps = storedCapabilities({ platform: "INSTAGRAM", grantedCapabilities: [] });

    expect(caps).toEqual(platformCeiling("INSTAGRAM"));
  });

  /**
   * A stored set is a subset by construction and must stay one, so a row that
   * outlived a shrinking ceiling can only ever narrow.
   */
  it("intersects with the ceiling rather than trusting the row", () => {
    const caps = storedCapabilities({
      platform: "YOUTUBE",
      grantedCapabilities: ["PUBLIC_REPLY", "PRIVATE_REPLY"],
    });

    expect([...caps]).toEqual(["PUBLIC_REPLY"]);
  });
});

/**
 * Verbatim from TikTok: the Business Messaging API is "not yet available in the
 * European Economic Area, Switzerland or the UK market… developers cannot call
 * the Business Messaging API on behalf of these accounts."
 *
 * TikTok ships here as public-reply-only, so this decides nothing yet. It is
 * tested now because the moment approval lands and the ceiling grows, a UK
 * account must not quietly be granted something TikTok says we may not do.
 */
describe("markets where TikTok messaging is unavailable", () => {
  it.each(["GB", "gb", "DE", "FR", "CH", "IE", "NO"])("bars %s", (region) => {
    expect(regionBlocksMessaging("TIKTOK", region)).toBe(true);
  });

  it.each(["VN", "ID", "TH", "US", "BR"])("allows %s", (region) => {
    expect(regionBlocksMessaging("TIKTOK", region)).toBe(false);
  });

  it("does not apply to other platforms", () => {
    expect(regionBlocksMessaging("INSTAGRAM", "GB")).toBe(false);
    expect(regionBlocksMessaging("FACEBOOK", "DE")).toBe(false);
  });

  it("treats an unreported region as unblocked, since the platform never said", () => {
    expect(regionBlocksMessaging("TIKTOK", null)).toBe(false);
  });
});
