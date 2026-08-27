/**
 * Turning one step into one platform call.
 *
 * Split in two on purpose. `planStep` is pure: given a step and a context it
 * says which one-shot claims the step consumes, which budgets it draws from,
 * and what it costs. `deliverStep` is the only part that touches the network.
 *
 * The split is not a pipeline, it is pure versus effectful. Both halves own the
 * same knowledge and sit in one module, so a new step kind is one change rather
 * than two that can disagree. What it buys is that the engine can take claims
 * and reserve budget before anything is sent, and release both when the send
 * provably never happened.
 */

import type { Platform } from "@/app/generated/prisma/client";
import type { Step, StepKind, StepSpec } from "@/lib/campaigns/steps";
import type { ExclusiveClaim } from "@/lib/runtime/claims";
import { acquireClaims, classifyAttempt, releaseIfUnattempted, settleClaims } from "@/lib/runtime/claims";
import { reserve, type BucketSpec, type Spend } from "@/lib/runtime/quota";
import { responseBuckets, type AccountBudget } from "@/lib/runtime/send-quota";
import { adapterFor } from "@/lib/platforms/registry";
import { renderMessageWithTracking } from "@/lib/tracking/message";
import { resolveFollowGate, canReprompt, type ContactState } from "@/lib/runtime/follow-gate";
import { rememberContact } from "@/lib/runtime/contacts";
import type { StepContext, StepResult } from "@/lib/runtime/engine";

export interface TrackedLink {
  slug: string;
  label: string | null;
  destinationUrl: string;
}

/** Everything a step needs that is not in the step itself. */
export interface RunTarget {
  readonly platform: Platform;
  readonly accessToken: string;
  readonly accountExternalId: string;
  readonly connectedAccountId: string;
  readonly campaignId: string;
  /** The comment or message that opened the run. */
  readonly triggerKey: string;
  /** The post the trigger sits under, where a platform meters per post. */
  readonly postId: string | null;
  readonly counterpartyId: string;
  readonly counterpartyName: string | null;
  readonly trackedLinks: readonly TrackedLink[];
  readonly budget: AccountBudget;
}

export interface DeliveryPlan {
  /** One-shot resources this step consumes, empty where it consumes none. */
  readonly claims: readonly ExclusiveClaim[];
  readonly buckets: readonly BucketSpec[];
  readonly cost: Spend;
  /**
   * Whether the platform can be asked, before sending, if this will work.
   * Facebook answers `can_reply_privately`; Instagram makes you find out.
   */
  readonly preflight: boolean;
}

/**
 * What a step consumes, decided without touching the network.
 *
 * The claim policy comes from the adapter, not from here, which is how
 * Instagram's one-private-reply-per-comment rule generalises: Facebook returns
 * the same shape and gets the rule for free, and YouTube returns nothing and
 * never touches the ledger.
 */
export function planStep(
  step: Step<Platform, StepKind>,
  target: RunTarget
): DeliveryPlan {
  const adapter = adapterFor(target.platform);
  const messaging = adapter.messaging;

  const consumesTheOneShot =
    step.kind === "directMessage" || step.kind === "linkButtons" || step.kind === "openingDm";

  const action = step.kind === "publicReply" ? "publicReply" : "privateReply";
  const { buckets, cost } = responseBuckets(target.platform, action, {
    ...target.budget,
    postId: target.postId,
  });

  return {
    claims:
      consumesTheOneShot && messaging
        ? messaging.claimsForPrivateReply(target.triggerKey)
        : [],
    buckets,
    cost,
    preflight: consumesTheOneShot && Boolean(messaging?.checkReplyEligibility),
  };
}

function render(text: string, target: RunTarget): string {
  return renderMessageWithTracking({
    message: text,
    commenterName: target.counterpartyName,
    trackedLinks: [...target.trackedLinks],
  });
}

/**
 * Run one step: claim, reserve, send, settle.
 *
 * Ordering is the whole point. The claim is taken before the send, so a
 * redelivered job and a sweep racing for the same comment cannot both get
 * through. The budget is reserved before the send and refunded when the send
 * provably did not happen. The claim is settled only once the platform has
 * acted, so a crash in between lets the claim lapse rather than forfeiting the
 * comment's only reply.
 */
export async function executeStep(
  step: Step<Platform, StepKind>,
  context: StepContext,
  target: RunTarget
): Promise<StepResult> {
  const adapter = adapterFor(target.platform);
  const messaging = adapter.messaging;
  const plan = planStep(step, target);
  const runKey = `${target.campaignId}:${target.triggerKey}`;

  if (step.kind !== "publicReply" && !messaging) {
    return { kind: "skip", reason: `${target.platform} has no messaging API` };
  }

  if (step.kind === "followGate") {
    return followGate(step.spec, context, target, messaging);
  }

  const claim = await acquireClaims(plan.claims, target.campaignId, runKey);
  if (!claim.held) {
    return {
      kind: "abandon",
      reason: claim.holderCampaignName
        ? `Campaign "${claim.holderCampaignName}" already used the one reply this comment allows`
        : "Another campaign already used the one reply this comment allows",
    };
  }

  if (plan.preflight && messaging?.checkReplyEligibility) {
    const eligibility = await messaging.checkReplyEligibility(
      target.accessToken,
      target.triggerKey
    );
    if (eligibility === "ineligible") {
      return { kind: "abandon", reason: "This comment can no longer accept a private reply" };
    }
  }

  const budget = await reserve(plan.buckets, plan.cost);
  if (!budget.ok) {
    await releaseIfUnattempted(plan.claims, runKey, "no");
    return {
      kind: "failed",
      error: `Out of ${budget.refusal.bucket} budget, ${budget.refusal.remaining} left`,
      retryable: budget.refusal.retryAfterMs !== null,
    };
  }

  try {
    const externalId = await send(step, target, messaging);
    await budget.lease.settle("commit");
    await settleClaims(plan.claims, runKey);
    return { kind: "done", externalId };
  } catch (error) {
    await budget.lease.settle("release");
    await releaseIfUnattempted(plan.claims, runKey, classifyAttempt(error));
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

type Messaging = NonNullable<ReturnType<typeof adapterFor>["messaging"]>;

async function send(
  step: Step<Platform, StepKind>,
  target: RunTarget,
  messaging: Messaging | null
): Promise<string | undefined> {
  const adapter = adapterFor(target.platform);

  switch (step.kind) {
    case "publicReply": {
      const spec = step.spec;
      // Varied copy is a platform requirement, not a flourish. TikTok hides
      // replies it reads as spam and sends no signal when it does.
      const chosen = spec.variants[Math.floor(Math.random() * spec.variants.length)];
      const result = await adapter.postPublicReply(
        target.accessToken,
        target.accountExternalId,
        target.triggerKey,
        render(chosen, target)
      );
      return result.id;
    }

    case "directMessage": {
      if (!messaging) return undefined;
      const spec = step.spec;
      const result = await messaging.sendPrivateReply(
        target.accessToken,
        target.accountExternalId,
        target.triggerKey,
        render(spec.text, target)
      );
      await recordContact(target, result);
      return result.messageId;
    }

    case "linkButtons": {
      if (!messaging) return undefined;
      const spec = step.spec;
      const buttons = target.trackedLinks
        .filter((l) => spec.linkSlugs.includes(l.slug))
        .map((l) => ({ title: l.label ?? spec.primaryLabel ?? "Open", url: l.destinationUrl }));
      const result = await messaging.sendPrivateReplyWithButtons(
        target.accessToken,
        target.accountExternalId,
        target.triggerKey,
        render(spec.bodyText, target),
        buttons
      );
      await recordContact(target, result);
      return result.messageId;
    }

    case "openingDm": {
      if (!messaging) return undefined;
      const spec = step.spec;
      const result = await messaging.sendPrivateReplyWithPostback(
        target.accessToken,
        target.accountExternalId,
        target.triggerKey,
        render(spec.text, target),
        spec.buttonLabel,
        `reveal:${target.triggerKey}`
      );
      await recordContact(target, result);
      return result.messageId;
    }

    case "conversationMessage":
    case "followUp": {
      if (!messaging) return undefined;
      const spec = step.spec;
      const result = await messaging.sendDirectMessage(
        target.accessToken,
        target.accountExternalId,
        target.counterpartyId,
        render(spec.text, target)
      );
      return result.messageId;
    }

    case "followGate":
      // Handled before this switch, because it decides rather than sends.
      return undefined;
  }
}

async function recordContact(
  target: RunTarget,
  result: { discoveredUserId?: string; messageId?: string }
): Promise<void> {
  await rememberContact({
    connectedAccountId: target.connectedAccountId,
    platform: target.platform,
    platformUserId: target.counterpartyId,
    displayName: target.counterpartyName,
    result,
  });
}

/**
 * The gate decides; it does not send.
 *
 * A pass advances the run. A prompt is a send, so it goes through the ordinary
 * path as an opening DM would. The decision itself is the pure table, and the
 * provenance comes from the cause rather than the call site, which is what
 * stops the three historical variants of this rule reappearing.
 */
async function followGate(
  spec: StepSpec["followGate"],
  context: StepContext,
  target: RunTarget,
  messaging: Messaging | null
): Promise<StepResult> {
  const status = (await messaging?.checkFollowStatus?.(
    target.accessToken,
    target.accountExternalId,
    target.counterpartyId
  )) ?? null;

  const contact: ContactState =
    context.cause.kind === "signal" ? "USER_CONFIRMED" : "FIRST_CONTACT";
  // A timeout is speculative: the person read the prompt and never answered, so
  // prompting again would pester someone who never engaged.
  const outcome = resolveFollowGate(
    status,
    contact,
    canReprompt(context.cause.kind === "timeout")
  );

  if (outcome === "PASS") return { kind: "skip", reason: "already following" };
  if (outcome === "DROP") return { kind: "abandon", reason: "Not following, and not asking again" };

  if (!messaging) return { kind: "skip", reason: "no messaging API to prompt through" };
  await messaging.sendPrivateReplyWithPostback(
    target.accessToken,
    target.accountExternalId,
    target.triggerKey,
    render(spec.promptText, target),
    spec.buttonLabel,
    `followcheck:${target.triggerKey}`
  );
  return { kind: "await" };
}
