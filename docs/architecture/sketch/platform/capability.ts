/**
 * Capabilities, and the types that make an unsupported response step
 * UNCONSTRUCTABLE rather than merely rejected.
 *
 * The whole design turns on one inversion from the capability matrix:
 *
 *   > The DM is not the universal capability. The public comment reply is.
 *
 * So the product primitive is `respond to a comment`, expressed as an ordered
 * list of steps. Each step kind declares the capabilities it consumes. A
 * platform declares a capability CEILING. A connected account, at connect time,
 * negotiates a set that is a SUBSET of that ceiling (TikTok in the EEA has
 * strictly fewer capabilities than TikTok in Vietnam — capability-matrix §4).
 *
 * Two gates, deliberately different in kind:
 *
 *   1. COMPILE TIME (this file). `StepBuilders<"youtube">` has no `followGate`
 *      property, because YouTube's ceiling contains no FOLLOW_GATE. Templates,
 *      seeds, tests and any first-party code that constructs a plan get a type
 *      error, not a runtime rejection. There is no stub to call.
 *
 *   2. BOUNDARY (campaign/compile.ts). Campaigns are authored in a browser and
 *      stored as JSON, so the real gate is one parse at the persistence
 *      boundary against the ACCOUNT's negotiated set. Inside that boundary the
 *      branded types are trusted, per boundary-discipline.
 */

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * A thing a platform can do on behalf of a connected account. Deliberately
 * named for the product effect, not the vendor endpoint: `DIRECT_MESSAGE` is
 * Instagram's private reply AND Facebook's private reply, which are the same
 * effect with different windows.
 */
export type Capability =
  /** Post a public reply under a comment. Every platform has this. */
  | "PUBLIC_REPLY"
  /** Open a private conversation addressed BY a comment (Meta private reply). */
  | "DIRECT_MESSAGE"
  /** Send inside an already-open conversation (reveal, follow-up, autoreply). */
  | "CONVERSATION_MESSAGE"
  /** Structured message with tappable buttons. */
  | "BUTTON_TEMPLATE"
  /** Button taps arrive back as an inbound event we can route to a run. */
  | "POSTBACK_SIGNAL"
  /** Read receipts arrive, enabling the read-but-never-tapped fallback. */
  | "READ_SIGNAL"
  /** Can ask whether a user follows this account (`is_user_follow_business`). */
  | "FOLLOW_GATE"
  /** Inbound DMs arrive and can start a run (the portable trigger). */
  | "INBOUND_MESSAGE_TRIGGER"
  /** Can ask BEFORE sending whether a private reply is possible (FB's `can_reply_privately`). */
  | "PREFLIGHT_DM_ELIGIBILITY"
  /**
   * Can LIST conversations and read their message history — the dashboard
   * inbox, distinct from `CONVERSATION_MESSAGE` (which only sends).
   *
   * Called out because all four arena candidates silently dropped the existing
   * inbox feature (`app/api/instagram/conversations/*`, `app/(dashboard)/inbox`).
   * It is a real shipped capability that splits per platform, so it is modelled
   * rather than special-cased: the inbox page renders per connected account and
   * omits accounts whose platform lacks this, using the same negotiation the
   * campaign builder uses.
   */
  | "CONVERSATION_HISTORY";

/**
 * The per-platform ceiling. This is the ONLY place a platform's capability set
 * is written down; adapters, the UI, the compiler and the type-level builders
 * all derive from it. Adding a fifth platform adds one key here.
 *
 * An account's negotiated set is always a subset. It is never a superset —
 * that invariant is enforced in `negotiateCapabilities`.
 */
export interface PlatformCeiling {
  instagram:
    | "PUBLIC_REPLY"
    | "DIRECT_MESSAGE"
    | "CONVERSATION_MESSAGE"
    | "BUTTON_TEMPLATE"
    | "POSTBACK_SIGNAL"
    | "READ_SIGNAL"
    | "FOLLOW_GATE"
    | "INBOUND_MESSAGE_TRIGGER"
    | "CONVERSATION_HISTORY";

  // Everything Instagram does except the follow gate (no `is_user_follow_business`
  // on Pages), plus a pre-flight eligibility probe Instagram lacks.
  facebook:
    | "PUBLIC_REPLY"
    | "DIRECT_MESSAGE"
    | "CONVERSATION_MESSAGE"
    | "BUTTON_TEMPLATE"
    | "POSTBACK_SIGNAL"
    | "INBOUND_MESSAGE_TRIGGER"
    | "PREFLIGHT_DM_ELIGIBILITY"
    // Conversations API, but note it is the tightest limit on the platform:
    // 2 calls/s per Page. An ordinary BucketSpec, not a special case.
    | "CONVERSATION_HISTORY";

  // research-youtube.md: the Data API has no messaging resource at all, and the
  // `comment` resource exposes no identifier a message could be routed to.
  // One capability. Not a reduced version of the others — a different product.
  youtube: "PUBLIC_REPLY";

  // research-tiktok.md: replies ship globally; DMs exist but may only be sent
  // into a conversation the user started, so CONVERSATION_MESSAGE is present
  // and DIRECT_MESSAGE is absent. The "DM me the keyword" funnel is exactly
  // INBOUND_MESSAGE_TRIGGER + CONVERSATION_MESSAGE, which is why it works.
  // `CONVERSATION_HISTORY` via `/business/message/conversation/list/` +
  // `/business/message/content/list/`. Note the list returns `conversation_id`
  // but NOT `unique_identifier`, so attributing a TikTok conversation to the
  // commenter who started it requires the `MessagingContact` join persisted
  // from the webhook. That is what that model is for.
  tiktok:
    | "PUBLIC_REPLY"
    | "CONVERSATION_MESSAGE"
    | "INBOUND_MESSAGE_TRIGGER"
    | "CONVERSATION_HISTORY";
}

export type PlatformId = keyof PlatformCeiling;
export type CeilingOf<P extends PlatformId> = PlatformCeiling[P];

export const PLATFORM_IDS = [
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
] as const satisfies readonly PlatformId[];

// ─── Step kinds and their requirements ───────────────────────────────────────

/**
 * Every step kind, mapped to the capabilities it consumes. A step is available
 * on a platform only when EVERY capability it lists is in that platform's
 * ceiling — see `StepsAvailableOn`.
 */
export interface StepRequirements {
  /** Post a public reply under the triggering comment. */
  publicReply: readonly ["PUBLIC_REPLY"];
  /** Private-reply to the comment with plain text. */
  directMessage: readonly ["DIRECT_MESSAGE"];
  /** Private-reply to the comment with up to 3 tappable link buttons. */
  linkButtons: readonly ["DIRECT_MESSAGE", "BUTTON_TEMPLATE"];
  /** Opening DM whose button tap advances the run to the next step. */
  openingDm: readonly ["DIRECT_MESSAGE", "BUTTON_TEMPLATE", "POSTBACK_SIGNAL"];
  /** Require a follow before continuing; re-prompts until satisfied. */
  followGate: readonly ["FOLLOW_GATE", "BUTTON_TEMPLATE", "POSTBACK_SIGNAL"];
  /** Send inside the now-open conversation (the "reveal"). */
  conversationMessage: readonly ["CONVERSATION_MESSAGE"];
  /** Delayed appreciation message inside the open conversation. */
  followUp: readonly ["CONVERSATION_MESSAGE"];
}

export type StepKind = keyof StepRequirements;

/**
 * The step kinds constructible on platform P.
 *
 * `StepRequirements[K][number]` is a union of every capability K needs, and it
 * is NOT a naked type parameter, so the conditional does not distribute: the
 * whole union must extend the ceiling. That is the "all requirements present"
 * check, done by the type checker.
 *
 *   StepsAvailableOn<"instagram"> = every kind
 *   StepsAvailableOn<"facebook">  = every kind except followGate
 *   StepsAvailableOn<"youtube">   = "publicReply"
 *   StepsAvailableOn<"tiktok">    = "publicReply" | "conversationMessage" | "followUp"
 */
export type StepsAvailableOn<P extends PlatformId> = {
  [K in StepKind]: StepRequirements[K][number] extends CeilingOf<P> ? K : never;
}[StepKind];

// ─── Branded steps ───────────────────────────────────────────────────────────

/**
 * Not exported as a value, so nothing outside this module can produce a value
 * of type `Step`. Object literals cannot satisfy it. The only way to obtain a
 * step is through `StepBuilders<P>` (first-party code) or `parseStoredPlan`
 * (stored campaigns, re-checked against live account capabilities).
 */
declare const MINTED: unique symbol;

export interface Step<P extends PlatformId, K extends StepKind = StepKind> {
  readonly kind: K;
  readonly spec: StepSpec[K];
  /**
   * Whether a repeat signal re-executes this step.
   * `"once"` — a terminal outcome blocks re-execution (public reply, follow-up).
   * `"everySignal"` — deliberately re-sends, preserving today's documented
   * "every button tap re-sends the reveal" behaviour.
   */
  readonly repeat: "once" | "everySignal";
  /** Set when this step parks the run waiting for the user to act. */
  readonly awaits: AwaitSpec | null;
  readonly [MINTED]: P;
}

export type AnyStep<P extends PlatformId> = Step<P, StepsAvailableOn<P>>;

/** What a parked step is waiting for, and what to do if it never arrives. */
export interface AwaitSpec {
  readonly signals: readonly SignalKind[];
  /** Milliseconds after parking at which the timeout fires. */
  readonly timeoutMs: number;
  /**
   * `"continue"` reproduces the Instagram read-receipt fallback: the user read
   * the opening DM and never tapped, so deliver anyway after the grace period.
   * `"abandon"` ends the run.
   */
  readonly onTimeout: "continue" | "abandon";
}

export type SignalKind = "postback" | "read" | "inboundMessage";

// ─── Step specs (authoring payloads, platform-neutral) ───────────────────────

/** Text with `{username}` / `{link}` tokens, rendered at execution time. */
export type MessageTemplate = string;

export interface StepSpec {
  publicReply: {
    /** Pool of variants, picked at random. TikTok's copy policy requires >= 3. */
    readonly variants: readonly MessageTemplate[];
  };
  directMessage: { readonly text: MessageTemplate };
  linkButtons: {
    readonly bodyText: MessageTemplate;
    /** Tracked-link slugs, in order. Capped at 3 by the compiler. */
    readonly linkSlugs: readonly string[];
    readonly primaryLabel: string | null;
  };
  openingDm: {
    readonly text: MessageTemplate;
    readonly buttonLabel: string;
  };
  followGate: {
    readonly promptText: MessageTemplate;
    readonly buttonLabel: string;
  };
  conversationMessage: {
    readonly text: MessageTemplate;
    readonly linkSlugs: readonly string[];
    readonly primaryLabel: string | null;
  };
  followUp: {
    readonly text: MessageTemplate;
    /** 0..1440. Above 1440 the scheduler chains hops (Queues caps delay at 24h). */
    readonly delayMinutes: number;
  };
}

// ─── Builders: the compile-time gate ─────────────────────────────────────────

/**
 * The step constructors available on platform P.
 *
 * ```ts
 * const yt = builders("youtube");
 * yt.publicReply({ variants: ["thanks!"] });   // ok
 * yt.followGate({ ... });                      // TS2339: Property 'followGate'
 *                                              // does not exist on type
 *                                              // StepBuilders<"youtube">
 * ```
 *
 * This is the difference the brief asks for: YouTube does not reject a follow
 * gate, it has nowhere to put one.
 */
export type StepBuilders<P extends PlatformId> = {
  readonly [K in StepsAvailableOn<P>]: (
    spec: StepSpec[K],
    options?: { repeat?: Step<P, K>["repeat"]; awaits?: AwaitSpec | null }
  ) => Step<P, K>;
};

export function builders<P extends PlatformId>(platform: P): StepBuilders<P> {
  // TODO: one generic factory closed over `platform`; the returned object is
  // populated for every StepKind at runtime but typed down to
  // StepsAvailableOn<P>. The runtime superset is unreachable through the type,
  // and `parseStoredPlan` is the only other door in — it checks the account's
  // negotiated set, which is a subset of the ceiling.
  throw new Error("not implemented");
}

// ─── Negotiated, per-account capabilities ────────────────────────────────────

/**
 * What THIS account can actually do, discovered at connect time and re-checked
 * on token refresh. Per capability-matrix §4 this is per-account state, not
 * per-platform config: two TikTok creators in one workspace can differ.
 */
export interface AccountCapabilities<P extends PlatformId = PlatformId> {
  readonly platform: P;
  readonly granted: ReadonlySet<CeilingOf<P>>;
  /**
   * Why a ceiling capability is absent for this account, surfaced verbatim in
   * the campaign builder so a creator sees "TikTok Business Messaging is not
   * available for UK-registered accounts" rather than a greyed-out toggle.
   */
  readonly declined: ReadonlyMap<CeilingOf<P>, DeclineReason>;
  /** ISO country of the account's registration, when the platform reports it. */
  readonly region: string | null;
  /** Copy rules the compiler must run against creator-authored text. */
  readonly copyPolicy: readonly CopyRule[];
  /**
   * Stable hash of `granted` + `copyPolicy`. Stored on every compiled plan; a
   * mismatch on load means capabilities moved under the campaign and the plan
   * must be recompiled or the campaign paused. Single source of truth for
   * "is this plan still valid", derived rather than synced.
   */
  readonly fingerprint: string;
}

export interface DeclineReason {
  readonly code:
    | "PLATFORM_LACKS_CAPABILITY"
    | "REGION_INELIGIBLE"
    | "SCOPE_NOT_GRANTED"
    | "ACCOUNT_TYPE_INELIGIBLE"
    | "APP_REVIEW_PENDING";
  /** Shown to the creator. Quote the platform's own words where they exist. */
  readonly message: string;
}

/**
 * A constraint on creator-authored copy, per capability-matrix §5. YouTube
 * Developer Policy §III.F prohibits incentivising comments, so the "comment
 * LINK below" mechanic must be blocked in the builder, not at send time.
 * A pure predicate: same code runs client-side for live validation and
 * server-side for enforcement.
 */
export interface CopyRule {
  readonly id: string;
  readonly appliesTo: readonly StepKind[];
  /** Returns null when the text passes. */
  readonly check: (text: string, allVariants: readonly string[]) => string | null;
}

/**
 * Narrow the ceiling to what this account really has. Called once at connect
 * and again whenever a token is refreshed or a scope is re-granted.
 *
 * INVARIANT: the returned `granted` set is a subset of `CeilingOf<P>`, and
 * every ceiling member is either granted or has a `declined` entry. Enforced
 * here so the UI can render a complete, explained matrix with no gaps.
 */
export function assertCapabilitiesWellFormed<P extends PlatformId>(
  caps: AccountCapabilities<P>
): void {
  throw new Error("not implemented");
}
