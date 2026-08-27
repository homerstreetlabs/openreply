/**
 * The bridge from the flat campaign columns to a step plan.
 *
 * Campaigns were a fixed set of toggles: a public reply, an optional follow
 * gate, an optional opening DM, a message, an optional follow-up. That is
 * already an ordered plan, it just could not be written down. This reads the
 * columns and says what they always meant.
 *
 * Kept separate from the compiler because it is a translation, not a check. It
 * produces a draft; `compile` decides whether the account can run it.
 */

/**
 * A step as it is stored.
 *
 * A type alias rather than an interface, and every field a JSON scalar, so it
 * assigns straight into the `compiledPlan` column with no cast. `compile`
 * accepts unknown elements and parses them, so one array serves both.
 */
export type PlanStep = {
  kind: string;
  spec: { [field: string]: string | number | string[] | null };
  awaits?: { signals: string[]; timeoutMs: number; onTimeout: string };
};

/** How long to wait for a tap before delivering anyway. */
const OPENING_DM_GRACE_MS = 5 * 60_000;

export interface CampaignColumns {
  readonly dmMessage: string;
  readonly openingDmEnabled: boolean;
  readonly openingDmMessage: string | null;
  readonly openingDmButtonLabel: string | null;
  readonly linkButtonLabel: string | null;
  readonly requireFollow: boolean;
  readonly followPromptMessage: string | null;
  readonly followPromptButtonLabel: string | null;
  readonly followUpEnabled: boolean;
  readonly followUpMessage: string | null;
  readonly followUpDelayMinutes: number;
  readonly publicReplyEnabled: boolean;
  readonly publicReplyMessage: string | null;
  readonly publicReplyMessages: readonly string[];
}

export function draftFromColumns(
  campaign: CampaignColumns,
  linkSlugs: readonly string[] = []
): PlanStep[] {
  const steps: PlanStep[] = [];

  const variants =
    campaign.publicReplyMessages.length > 0
      ? [...campaign.publicReplyMessages]
      : campaign.publicReplyMessage
        ? [campaign.publicReplyMessage]
        : [];

  if (campaign.publicReplyEnabled && variants.length > 0) {
    steps.push({ kind: "publicReply", spec: { variants } });
  }

  if (campaign.requireFollow && campaign.followPromptMessage) {
    steps.push({
      kind: "followGate",
      spec: {
        promptText: campaign.followPromptMessage,
        buttonLabel: campaign.followPromptButtonLabel ?? "I'm following",
      },
    });
  }

  if (campaign.openingDmEnabled && campaign.openingDmMessage) {
    // The opening DM parks the run. A tap advances it; a read receipt with no
    // tap delivers anyway after the grace period, which is the fallback that
    // stops someone who clearly saw the message being left with nothing.
    steps.push({
      kind: "openingDm",
      spec: {
        text: campaign.openingDmMessage,
        buttonLabel: campaign.openingDmButtonLabel ?? "Send it",
      },
      awaits: {
        signals: ["postback", "read"],
        timeoutMs: OPENING_DM_GRACE_MS,
        onTimeout: "continue",
      },
    });

    // With a conversation already open, the payload goes inside it rather than
    // spending the comment's one private reply.
    steps.push({
      kind: "conversationMessage",
      spec: {
        text: campaign.dmMessage,
        linkSlugs: [...linkSlugs],
        primaryLabel: campaign.linkButtonLabel,
      },
    });
  } else if (linkSlugs.length > 0) {
    steps.push({
      kind: "linkButtons",
      spec: {
        bodyText: campaign.dmMessage,
        linkSlugs: [...linkSlugs],
        primaryLabel: campaign.linkButtonLabel,
      },
    });
  } else {
    steps.push({ kind: "directMessage", spec: { text: campaign.dmMessage } });
  }

  if (campaign.followUpEnabled && campaign.followUpMessage) {
    steps.push({
      kind: "followUp",
      spec: {
        text: campaign.followUpMessage,
        delayMinutes: campaign.followUpDelayMinutes,
      },
      awaits: {
        signals: [],
        timeoutMs: campaign.followUpDelayMinutes * 60_000,
        onTimeout: "continue",
      },
    });
  }

  return steps;
}
