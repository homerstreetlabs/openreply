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
  /** Sample public reply, which can only point at a DM where one is sent. */
  readonly publicReplyExample: string;
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
    publicReplyExample: dm ? "Sent you a DM! 📩" : "Thanks for asking! 🙌",
  };
}

/**
 * Whether a campaign sends a DM, which is not whether its platform can. An
 * Instagram campaign with no DM written replies under the comment and stops,
 * exactly as a YouTube one does.
 */
export function sendsDm(platform: Platform, dmMessage: string): boolean {
  return campaignOptions(platform).dm && dmMessage.trim() !== "";
}

/**
 * The fields that decide what a campaign sends, named as the builder posts them
 * and the row stores them.
 */
export interface CampaignActions {
  readonly dmMessage: string;
  readonly publicReplyEnabled: boolean;
  readonly publicReplyMessages: readonly string[];
  /** The single reply stored before variants existed. */
  readonly publicReplyMessage?: string | null;
  readonly openingDmEnabled: boolean;
  readonly requireFollow: boolean;
  readonly followUpEnabled: boolean;
  readonly dmTriggerEnabled: boolean;
  readonly trackedDestinationUrl?: string | null;
  readonly secondaryDestinationUrl?: string | null;
}

/**
 * Why a campaign cannot be saved as written, or null when it can. It has to
 * send something, and a setting that only works inside a DM needs one to work
 * in. The builder and the API both ask this, so they refuse the same campaigns
 * in the same words.
 */
export function campaignActionsError(
  platform: Platform,
  campaign: CampaignActions
): string | null {
  if (sendsDm(platform, campaign.dmMessage)) return null;

  const canDm = campaignOptions(platform).dm;
  const publicReply =
    campaign.publicReplyEnabled &&
    [...campaign.publicReplyMessages, campaign.publicReplyMessage ?? ""].some((m) => m.trim());
  if (!publicReply) {
    return canDm
      ? "Write the DM or a public reply, so this campaign has something to send."
      : `${platformName(platform)} has no messaging API, so this campaign needs a public reply.`;
  }

  const hasLink = Boolean(
    campaign.trackedDestinationUrl?.trim() || campaign.secondaryDestinationUrl?.trim()
  );
  const dmOnly: [on: boolean, fix: string][] = [
    [campaign.openingDmEnabled, "turn off the opening DM"],
    [campaign.requireFollow, "turn off the follow requirement"],
    [campaign.followUpEnabled, "turn off the follow-up message"],
    [campaign.dmTriggerEnabled, "turn off replying when someone DMs"],
    [hasLink, "remove the link"],
  ];
  const fix = dmOnly.find(([on]) => on)?.[1];
  if (!fix) return null;
  return canDm
    ? `Write the DM, or ${fix}.`
    : `${platformName(platform)} has no messaging API, so ${fix}.`;
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

/**
 * `ConnectedAccount.username` is a handle on two platforms and a display name
 * on the other two: Facebook stores the Page's name and YouTube the channel's
 * title, because neither hands out a handle at connect time. Prefixing all four
 * with "@" prints "@My Business Page", which a creator reads as a bug in the
 * product rather than in one template.
 */
const USERNAME_IS_HANDLE = {
  INSTAGRAM: true,
  FACEBOOK: false,
  YOUTUBE: false,
  TIKTOK: true,
} satisfies Record<Platform, boolean>;

export function accountLabel(platform: Platform, username: string): string {
  return USERNAME_IS_HANDLE[platform] ? `@${username}` : username;
}
