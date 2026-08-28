import { describe, it, expect } from "vitest";

import { accountLabel, campaignOptions, platformName } from "../lib/campaigns/options";
import type { Platform } from "../app/generated/prisma/client";

const ALL: Platform[] = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK"];

describe("campaign options", () => {
  it("offers DM sections where a messaging API exists", () => {
    expect(campaignOptions("INSTAGRAM").dm).toBe(true);
    expect(campaignOptions("FACEBOOK").dm).toBe(true);
  });

  /**
   * YouTube has no messaging API at all and TikTok prohibits initiating a DM
   * outside three countries. A DM field shown for either is a promise the send
   * path cannot keep.
   */
  it("hides DM sections where there is no messaging API", () => {
    expect(campaignOptions("YOUTUBE").dm).toBe(false);
    expect(campaignOptions("TIKTOK").dm).toBe(false);
  });

  it("makes the public reply mandatory when it is the only action", () => {
    expect(campaignOptions("YOUTUBE").publicReplyRequired).toBe(true);
    expect(campaignOptions("TIKTOK").publicReplyRequired).toBe(true);
  });

  it("keeps the public reply optional where a DM can carry the campaign", () => {
    expect(campaignOptions("INSTAGRAM").publicReplyRequired).toBe(false);
    expect(campaignOptions("FACEBOOK").publicReplyRequired).toBe(false);
  });

  it("offers an inbound DM trigger only where DMs can be received", () => {
    expect(campaignOptions("INSTAGRAM").dmTrigger).toBe(true);
    expect(campaignOptions("YOUTUBE").dmTrigger).toBe(false);
  });

  /** Every platform must be able to send something, or it cannot run a campaign. */
  it("leaves no platform with nothing to send", () => {
    for (const platform of ALL) {
      const o = campaignOptions(platform);
      expect(o.dm || o.publicReply).toBe(true);
    }
  });

  it("names every platform", () => {
    for (const platform of ALL) {
      expect(platformName(platform)).toBeTruthy();
    }
  });

  /**
   * Facebook stores the Page's name and YouTube the channel's title, so an "@"
   * on those two prints "@My Business Page".
   */
  it("prefixes a handle but not a display name", () => {
    expect(accountLabel("INSTAGRAM", "creator")).toBe("@creator");
    expect(accountLabel("TIKTOK", "creator")).toBe("@creator");
    expect(accountLabel("FACEBOOK", "My Business Page")).toBe("My Business Page");
    expect(accountLabel("YOUTUBE", "Anojh's Channel")).toBe("Anojh's Channel");
  });

  it("labels every platform without dropping the name", () => {
    for (const platform of ALL) {
      expect(accountLabel(platform, "handle")).toContain("handle");
    }
  });
});
