/**
 * What one account can actually do.
 *
 * Capability is a fact about the account, not the network. TikTok's Business
 * Messaging API is unavailable to accounts registered in the EEA, Switzerland
 * and the UK, and its only comment-to-DM path reaches three countries. Two
 * creators on the same platform in the same workspace can differ, so a
 * per-platform constant cannot express it and a config flag would be a lie.
 *
 * The negotiated set is always a subset of the ceiling and never a superset.
 * Every ceiling capability is either granted or carries a reason, so the
 * campaign builder can render a complete matrix with no silent gaps.
 */

import type { Platform } from "@/app/generated/prisma/client";
import type { Capability } from "./types";
import { platformCeiling } from "@/lib/campaigns/steps";

export type DeclineCode = "REGION_INELIGIBLE" | "SCOPE_NOT_GRANTED" | "REVIEW_PENDING";

export interface DeclineReason {
  readonly code: DeclineCode;
  /** Shown to the creator. Quote the platform's own words where they exist. */
  readonly message: string;
}

export interface AccountCapabilities {
  readonly granted: ReadonlySet<Capability>;
  readonly declined: ReadonlyMap<Capability, DeclineReason>;
  readonly region: string | null;
}

/**
 * Whether an account's registration market bars it from messaging at all.
 *
 * Exported and pure because it outlives the current ceiling. TikTok ships as
 * public-reply-only today, so this decides nothing yet; the moment Business
 * Messaging approval lands and the ceiling grows, connecting a UK account must
 * not quietly grant it. Getting that wrong means calling an API on a creator's
 * behalf that TikTok says we may not call for them.
 */
export function regionBlocksMessaging(
  platform: Platform,
  region: string | null
): boolean {
  if (platform !== "TIKTOK" || !region) return false;
  return TIKTOK_MESSAGING_BLOCKED.has(region.toUpperCase());
}

/**
 * Verbatim: the Business Messaging API is "not yet available in the European
 * Economic Area, Switzerland or the UK market… developers cannot call the
 * Business Messaging API on behalf of these accounts."
 */
const TIKTOK_MESSAGING_BLOCKED = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", "IS", "LI", "NO", "CH", "GB",
]);

/**
 * Narrow a platform's ceiling to one account.
 *
 * `scopes` is what the platform actually granted at authorization, which is not
 * always what was asked for: a creator can decline one on the consent screen.
 */
export function negotiate(params: {
  platform: Platform;
  region: string | null;
  grantedScopes: readonly string[];
  /** Capabilities the platform's own response says are unavailable here. */
  reviewPending?: readonly Capability[];
}): AccountCapabilities {
  const ceiling = platformCeiling(params.platform);
  const granted = new Set<Capability>();
  const declined = new Map<Capability, DeclineReason>();
  const region = params.region?.toUpperCase() ?? null;

  for (const capability of ceiling) {
    const reason = declineReason(params.platform, capability, region, params);
    if (reason) declined.set(capability, reason);
    else granted.add(capability);
  }

  return { granted, declined, region };
}

function declineReason(
  platform: Platform,
  capability: Capability,
  region: string | null,
  params: { grantedScopes: readonly string[]; reviewPending?: readonly Capability[] }
): DeclineReason | null {
  if (params.reviewPending?.includes(capability)) {
    return {
      code: "REVIEW_PENDING",
      message: "Waiting on the platform to approve this for your app.",
    };
  }

  const messagingCapability =
    capability === "CONVERSATION_MESSAGE" ||
    capability === "INBOUND_MESSAGE_TRIGGER" ||
    capability === "CONVERSATION_HISTORY";
  if (messagingCapability && regionBlocksMessaging(platform, region)) {
    return {
      code: "REGION_INELIGIBLE",
      message: `TikTok's Business Messaging API is not available for accounts registered in ${region}, so this account can only reply publicly.`,
    };
  }

  const scopes: Partial<Record<Capability, string>> = REQUIRED_SCOPE[platform];
  const scope = scopes[capability];
  if (scope && !params.grantedScopes.includes(scope)) {
    return {
      code: "SCOPE_NOT_GRANTED",
      message: `This account did not grant "${scope}", which this needs. Reconnect and accept it to turn this on.`,
    };
  }

  return null;
}

/**
 * The scope each capability rides on, where declining it on the consent screen
 * is possible. Absent means the capability comes with the connection itself.
 */
const REQUIRED_SCOPE = {
  INSTAGRAM: {
    PRIVATE_REPLY: "instagram_business_manage_messages",
    CONVERSATION_MESSAGE: "instagram_business_manage_messages",
    CONVERSATION_HISTORY: "instagram_business_manage_messages",
    PUBLIC_REPLY: "instagram_business_manage_comments",
  },
  FACEBOOK: {
    PRIVATE_REPLY: "pages_messaging",
    CONVERSATION_MESSAGE: "pages_messaging",
    CONVERSATION_HISTORY: "pages_messaging",
    PUBLIC_REPLY: "pages_manage_engagement",
    PREFLIGHT_REPLY_ELIGIBILITY: "pages_read_engagement",
  },
  TIKTOK: {
    PUBLIC_REPLY: "comment.list.manage",
  },
  // The only write scope Google offers. There is no narrower one for posting a
  // comment reply, which is why the consent screen reads as broadly as it does.
  YOUTUBE: {
    PUBLIC_REPLY: "https://www.googleapis.com/auth/youtube.force-ssl",
  },
} as const satisfies Record<Platform, Partial<Record<Capability, string>>>;

/**
 * Read a stored negotiation back.
 *
 * An account negotiated before this existed has an empty set, and falls back to
 * the ceiling. That is deliberately the permissive direction: those accounts
 * were connected under the old model and already work, and narrowing them on a
 * guess would break campaigns that are running.
 */
export function storedCapabilities(account: {
  platform: Platform;
  grantedCapabilities: readonly string[];
}): ReadonlySet<Capability> {
  if (account.grantedCapabilities.length === 0) return platformCeiling(account.platform);

  const ceiling = platformCeiling(account.platform);
  // Intersected with the ceiling rather than trusted, so a stale row can only
  // ever narrow. A stored set is a subset by construction and must stay one
  // even if the ceiling shrinks under it.
  return new Set(
    [...ceiling].filter((c) => account.grantedCapabilities.includes(c))
  );
}
