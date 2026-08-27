/**
 * What a campaign may offer on a given platform.
 *
 * This is a pure function of the capability table rather than a set of checks
 * spread through the form, so the options the builder shows and the actions the
 * worker will attempt are derived from one source. A platform added to the enum
 * gets its options from its adapter without touching the form.
 */

import type { Platform } from "@/app/generated/prisma/client";
import { supports } from "@/lib/platforms/types";

export interface CampaignOptions {
  /** DM sections. False on platforms with no messaging API. */
  readonly dm: boolean;
  /** Replying under the comment. */
  readonly publicReply: boolean;
  /** Whether the public reply can be switched off, or is the only action. */
  readonly publicReplyRequired: boolean;
  /** Triggering on an inbound DM, which needs somewhere to receive one. */
  readonly dmTrigger: boolean;
}

export function campaignOptions(platform: Platform): CampaignOptions {
  const dm = supports(platform, "PRIVATE_REPLY");
  const publicReply = supports(platform, "PUBLIC_REPLY");

  return {
    dm,
    publicReply,
    // With no DM to fall back on, a campaign that also declines the public reply
    // sends nothing at all, so the choice is not offered.
    publicReplyRequired: publicReply && !dm,
    dmTrigger: dm,
  };
}

const PLATFORM_NAMES = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
} satisfies Record<Platform, string>;

export function platformName(platform: Platform): string {
  return PLATFORM_NAMES[platform];
}
