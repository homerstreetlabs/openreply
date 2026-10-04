import { describe, it, expect } from "vitest";

import {
  accountLabel,
  campaignActionsError,
  campaignOptions,
  platformName,
  sendsDm,
  type CampaignActions,
} from "../lib/campaigns/options";
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

  it("never suggests a public reply that promises a DM the platform cannot send", () => {
    for (const platform of ALL) {
      const o = campaignOptions(platform);
      if (!o.dm) expect(o.publicReplyExample).not.toMatch(/DM/);
    }
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

describe("what a campaign sends", () => {
  const commentOnly: CampaignActions = {
    dmMessage: "",
    publicReplyEnabled: true,
    publicReplyMessages: ["thanks for asking!"],
    openingDmEnabled: false,
    requireFollow: false,
    followUpEnabled: false,
    dmTriggerEnabled: false,
    trackedDestinationUrl: "",
    secondaryDestinationUrl: "",
  };

  it("sends a DM only where the platform can and one is written", () => {
    expect(sendsDm("INSTAGRAM", "here's the link")).toBe(true);
    expect(sendsDm("INSTAGRAM", "")).toBe(false);
    expect(sendsDm("INSTAGRAM", "   ")).toBe(false);
    expect(sendsDm("YOUTUBE", "here's the link")).toBe(false);
  });

  it("accepts a public reply with no DM on a platform that can DM", () => {
    expect(campaignActionsError("INSTAGRAM", commentOnly)).toBeNull();
    expect(campaignActionsError("FACEBOOK", commentOnly)).toBeNull();
  });

  it("accepts a DM with no public reply", () => {
    expect(
      campaignActionsError("INSTAGRAM", {
        ...commentOnly,
        dmMessage: "here's the link",
        publicReplyEnabled: false,
        publicReplyMessages: [],
      })
    ).toBeNull();
  });

  it("refuses a campaign that sends nothing", () => {
    for (const nothing of [
      { ...commentOnly, publicReplyEnabled: false },
      { ...commentOnly, publicReplyMessages: ["  "] },
    ]) {
      expect(campaignActionsError("INSTAGRAM", nothing)).toMatch(/DM or a public reply/);
      expect(campaignActionsError("YOUTUBE", nothing)).toMatch(/YouTube .* needs a public reply/);
    }
  });

  it("counts a reply stored before variants existed", () => {
    expect(
      campaignActionsError("INSTAGRAM", {
        ...commentOnly,
        publicReplyMessages: [],
        publicReplyMessage: "thanks for asking!",
      })
    ).toBeNull();
  });

  it("refuses each setting that only works inside a DM when there is none", () => {
    const cases: [Partial<CampaignActions>, RegExp][] = [
      [{ openingDmEnabled: true }, /opening DM/],
      [{ requireFollow: true }, /follow requirement/],
      [{ followUpEnabled: true }, /follow-up/],
      [{ dmTriggerEnabled: true }, /someone DMs/],
      [{ trackedDestinationUrl: "https://example.com" }, /link/],
      [{ secondaryDestinationUrl: "https://example.com" }, /link/],
    ];
    for (const [setting, named] of cases) {
      const error = campaignActionsError("INSTAGRAM", { ...commentOnly, ...setting });
      expect(error).toMatch(/^Write the DM, or /);
      expect(error).toMatch(named);
      expect(
        campaignActionsError("INSTAGRAM", { ...commentOnly, ...setting, dmMessage: "hi" })
      ).toBeNull();
    }
  });

  it("does not ask for a DM the platform cannot send", () => {
    const error = campaignActionsError("YOUTUBE", { ...commentOnly, requireFollow: true });
    expect(error).toMatch(/follow requirement/);
    expect(error).not.toMatch(/Write the DM/);
  });
});
