/**
 * The campaign compiler. One pure function, run in three places, and it is the
 * ONLY place a capability can be refused.
 *
 *   1. In the browser, on every keystroke, so the builder greys out and
 *      explains what this account cannot do.
 *   2. In `POST /api/campaigns`, so a hand-crafted request cannot save a plan
 *      the account cannot execute.
 *   3. On load in the engine (`parseStoredPlan`), so a capability that
 *      SHRANK since the campaign was saved — a TikTok creator who moved to the
 *      UK, a revoked scope, a token downgraded to Standard Access — pauses the
 *      campaign instead of failing at send time.
 *
 * That third call is the one that matters and it is why the compiled plan
 * carries a `capabilityFingerprint`. Capabilities can shrink under a running
 * campaign; nothing in today's system would notice.
 */

import type {
  AccountCapabilities,
  AnyStep,
  CopyRule,
  PlatformId,
  StepKind,
  StepSpec,
  StepsAvailableOn,
} from "../platform/capability";

// ─── The authoring draft ─────────────────────────────────────────────────────

/**
 * What the campaign builder produces. Loose on purpose: this is untrusted
 * input from a browser and it is the ONLY loose type in the design. Everything
 * past `compile` is branded and trusted, per boundary-discipline.
 */
export interface CampaignDraft {
  readonly name: string;
  readonly connectedAccountId: string;
  readonly target: TargetSpec;
  readonly match: MatchSpec;
  /** Which inbound events may start this campaign. */
  readonly triggers: readonly ("comment" | "inboundMessage")[];
  /** Ordered, untyped step drafts. `kind` is a plain string here. */
  readonly steps: readonly DraftStep[];
  readonly isActive: boolean;
}

export interface DraftStep {
  readonly kind: string;
  readonly spec: unknown;
  readonly repeat?: "once" | "everySignal";
}

/** Generalises `postId` / `matchAnyPost` / `pendingNextReel`. */
export type TargetSpec =
  | { readonly kind: "post"; readonly postExternalId: string; readonly url: string | null }
  | { readonly kind: "anyPost" }
  /** Binds to the next post the creator publishes; resolved by a daily cron. */
  | { readonly kind: "nextPost"; readonly armedAt: Date };

/** Unchanged semantics; `lib/utils/keyword-matcher.ts` moves across untouched. */
export interface MatchSpec {
  readonly keywords: readonly string[];
  readonly matchAnyWord: boolean;
  readonly wholeWordMatch: boolean;
}

// ─── The compiled plan ───────────────────────────────────────────────────────

/**
 * Executable, and executable ONLY by the adapter for `platform` — the shared
 * `P` between `CompiledPlan<P>` and `PlatformAdapter<P>` makes running a plan
 * against the wrong adapter a type error rather than a runtime surprise.
 */
export interface CompiledPlan<P extends PlatformId = PlatformId> {
  readonly platform: P;
  readonly steps: readonly AnyStep<P>[];
  readonly target: TargetSpec;
  readonly match: MatchSpec;
  readonly triggers: readonly ("comment" | "inboundMessage")[];
  /** Must equal the account's current `AccountCapabilities.fingerprint`. */
  readonly capabilityFingerprint: string;
}

export interface CompileError {
  /** JSON path into the draft, so the builder can highlight the exact field. */
  readonly path: string;
  readonly code:
    | "CAPABILITY_UNAVAILABLE"
    | "COPY_POLICY_VIOLATION"
    | "SPEC_INVALID"
    | "STEP_UNREACHABLE"
    | "TRIGGER_UNAVAILABLE";
  /** Creator-facing. For a declined capability this quotes the platform. */
  readonly message: string;
}

export type CompileResult<P extends PlatformId> =
  | { readonly ok: true; readonly plan: CompiledPlan<P> }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

/**
 * Draft + this account's negotiated capabilities -> executable plan.
 *
 * PURE. No database, no network, no clock. That is what lets the same function
 * run in a React component and in a Worker.
 *
 * What it decides, in order:
 *   1. Every step's `kind` is in `StepsAvailableOn<P>` AND in the ACCOUNT's
 *      granted set (which is a subset of the ceiling — a UK TikTok account
 *      loses `CONVERSATION_MESSAGE` even though the platform has it). A
 *      declined capability's `DeclineReason.message` becomes the error text,
 *      so the creator reads "The Business Messaging API is not yet available
 *      in the European Economic Area, Switzerland or the UK market" and not
 *      "unsupported step".
 *   2. `copyPolicy` rules run over creator-authored text. YouTube declines any
 *      step whose copy incentivises commenting (Developer Policy §III.F);
 *      TikTok requires at least three public-reply variants, because identical
 *      high-volume replies are what its spam classifier hides.
 *   3. Reachability: a step that awaits a signal must be followed by at least
 *      one step, and a step after an `awaits` step is only reachable through
 *      it. An `openingDm` with nothing after it is a bug the builder should
 *      not let a creator ship.
 *   4. Canonical ordering: steps that consume no exclusive claim and no
 *      messaging window are hoisted ahead of steps that do. This is what
 *      preserves the current public-reply-first decoupling — the public reply
 *      is posted before the DM leg can fail, and it is a property of the
 *      compiled order, not a hardcoded leg in the send path.
 *   5. Link buttons are capped at 3 (Meta's template limit) and the excess is
 *      reported, not silently dropped.
 */
export function compile<P extends PlatformId>(
  draft: CampaignDraft,
  caps: AccountCapabilities<P>
): CompileResult<P> {
  throw new Error("not implemented");
}

/**
 * Re-check and re-mint a stored plan against the account's CURRENT
 * capabilities. Called once per run, cached by
 * `(campaignId, capabilityFingerprint)`.
 *
 * Fast path: fingerprint matches -> re-mint without re-running copy rules.
 * Slow path: fingerprint moved -> full `compile` from the stored draft. If it
 * now fails, the campaign is paused and a `PLAN_INVALIDATED` incident is
 * raised against the account, which is how the creator and the platform admin
 * both find out.
 */
export function parseStoredPlan<P extends PlatformId>(
  stored: unknown,
  draft: CampaignDraft,
  caps: AccountCapabilities<P>
): CompileResult<P>;
export function parseStoredPlan<P extends PlatformId>(): CompileResult<P> {
  throw new Error("not implemented");
}

/**
 * Which step kinds the builder should offer for this account, with a reason
 * for each one it should not. The UI renders straight from this — there is no
 * per-platform branch in any component, which is why adding a fifth platform
 * touches no UI file.
 */
export function availableSteps<P extends PlatformId>(
  caps: AccountCapabilities<P>
): readonly {
  readonly kind: StepKind;
  readonly available: boolean;
  readonly reason: string | null;
}[] {
  throw new Error("not implemented");
}

// ─── Migration of live campaigns ─────────────────────────────────────────────

/**
 * Today's `Automation` columns -> a `CampaignDraft`. Pure, so the existing
 * 142 tests' campaign fixtures become its test corpus directly.
 *
 * The mapping, exhaustively:
 *   publicReplyEnabled + publicReplyMessages/publicReplyMessage
 *                                     -> publicReply   (hoisted first)
 *   requireFollow && !openingDmEnabled -> followGate
 *   openingDmEnabled                   -> openingDm { awaits: postback|read, 5min }
 *   trackedLinks.length > 0            -> linkButtons  else directMessage
 *   (after openingDm / followGate)     -> conversationMessage  (the "reveal")
 *   followUpEnabled                    -> followUp { delayMinutes }
 *   dmTriggerEnabled                   -> triggers += "inboundMessage"
 *   postId/matchAnyPost/pendingNextReel-> TargetSpec
 *
 * Run once during the backfill deploy, then again on demand from the admin
 * console for any campaign whose compile fails.
 */
export function draftFromLegacyAutomation(row: LegacyAutomationRow): CampaignDraft {
  throw new Error("not implemented");
}

/** Exactly the columns the current `Automation` model has. */
export interface LegacyAutomationRow {
  readonly id: string;
  readonly name: string;
  readonly instagramAccountId: string;
  readonly postId: string | null;
  readonly postUrl: string | null;
  readonly pendingNextReel: boolean;
  readonly matchAnyPost: boolean;
  readonly keywords: readonly string[];
  readonly matchAnyWord: boolean;
  readonly wholeWordMatch: boolean;
  readonly dmTriggerEnabled: boolean;
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
  readonly isActive: boolean;
}

/** Shared copy rules, referenced by adapters' `AccountCapabilities.copyPolicy`. */
export const COPY_RULES: Record<string, CopyRule> = {
  /**
   * YouTube Developer Policy §III.F: API Clients "must not offer or provide
   * incentives, rewards, or other compensation to users for engaging with
   * YouTube Applications ... by performing actions like ... adding comments".
   * The "comment LINK below and I'll send you the guide" mechanic is
   * prohibited there, independent of how the response is delivered.
   */
  noIncentivisedCommentCta: {
    id: "noIncentivisedCommentCta",
    appliesTo: ["publicReply"],
    // TODO: match "comment <word> and I'll send", "drop a comment to get",
    // "type X below for the link". Deliberately conservative and explained in
    // the error, since a false positive is a blocked creator.
    check: () => {
      throw new Error("not implemented");
    },
  },
  /**
   * TikTok, verbatim: "avoid posting a high volume of comments with largely
   * similar content within a short timeframe. If a comment is flagged as spam,
   * you will not receive the `comment.update` webhook event with
   * `comment_action` set to `set_to_public`."
   */
  requireVariedReplyCopy: {
    id: "requireVariedReplyCopy",
    appliesTo: ["publicReply"],
    // TODO: >= 3 variants, pairwise normalised-edit-distance above a floor.
    check: () => {
      throw new Error("not implemented");
    },
  },
} satisfies Record<string, CopyRule>;

// Re-exported so consumers import spec types from one place.
export type { StepSpec, StepsAvailableOn };
