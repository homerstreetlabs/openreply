/**
 * The platform adapter: seven members, and everything vendor-shaped lives
 * behind them.
 *
 * What is hidden here: OAuth dialects and token lifetimes, region discovery,
 * webhook signature schemes and payload shapes, poll cursors and their quirks
 * (TikTok's 500-comment duplicate window), addressing (a Meta `comment_id`, a
 * PSID, a YouTube `parentId`), delivery strategy including Instagram's
 * button-template -> inline-text fallback, and the vendor error taxonomy.
 *
 * What is NOT on this surface, on purpose: no `fetch`, no `Response`, no
 * vendor JSON. Wire types are parsed into domain types inside the adapter, per
 * boundary-discipline. The engine never sees `graph.instagram.com`.
 *
 * The `plan` / `deliver` split is pure-vs-effectful, not a pipeline. `plan` is
 * a pure function returning the cost, the exclusive claims and the addressing
 * a step needs, so the engine can reserve quota and take claims BEFORE any
 * network call. Both halves own the same knowledge and live in the same
 * module, so this is not temporal decomposition.
 */

import type {
  AccountCapabilities,
  AnyStep,
  CeilingOf,
  PlatformId,
  SignalKind,
  StepKind,
} from "./capability";
import type { BucketSpec, QuotaCost } from "../runtime/quota";
import type { ExclusiveClaim } from "../runtime/claims";

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * One set of app credentials for one platform. Multiple rows per platform are
 * required, not optional: per research-facebook.md §6, "You can only add one
 * setup per app", so Instagram-Login and Pages/Messenger need two Meta apps
 * with different secrets. YouTube's row also carries the Google Cloud project
 * id, which IS the identity of its 10,000-unit/day quota pool.
 */
export interface ProviderApp {
  readonly id: string;
  readonly platform: PlatformId;
  /** URL-safe; forms the ingest path `/api/ingest/{platform}/{slug}`. */
  readonly slug: string;
  readonly clientId: string;
  /** Decrypted at use; AES-256-GCM at rest, unchanged from today. */
  readonly clientSecret: string;
  /** The secret that signs inbound webhooks. Often NOT `clientSecret`. */
  readonly webhookSecret: string | null;
  readonly verifyToken: string | null;
  /**
   * Identity of any quota pool shared by every account on this app. YouTube:
   * the Google Cloud project. TikTok: the app, for its 600 QPM ceiling.
   * Instagram/Facebook: null — their budgets are per-account.
   */
  readonly quotaPoolKey: string | null;
}

/** A connected social account, platform-neutral. Replaces `InstagramAccount`. */
export interface ConnectedAccount<P extends PlatformId = PlatformId> {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerAppId: string;
  readonly platform: P;
  /**
   * The platform's own id for the account, and the key webhooks arrive under.
   * Instagram: the professional account id (`user_id`, NOT the app-scoped id) —
   * the exact value today's `instagramId` column holds.
   * Facebook: the Page id. TikTok: `open_id`. YouTube: the channel id.
   */
  readonly externalId: string;
  readonly handle: string;
  readonly displayName: string | null;
  readonly capabilities: AccountCapabilities<P>;
}

/** Decrypted credentials for one account. Never logged, never returned to a route. */
export interface Credential {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

/** A request as it arrives at the ingest route, before any parsing. */
export interface RawWebhook {
  readonly rawBody: string;
  readonly headers: Headers;
  readonly query: URLSearchParams;
}

/**
 * Something that starts a run. Both variants carry `contact`, which is what
 * drives the follow gate's fail-closed-on-first-contact rule (see
 * runtime/follow-gate.ts) — the gate reads provenance, not platform.
 */
export type StartTrigger =
  | {
      readonly kind: "comment";
      readonly accountExternalId: string;
      /** Frozen: becomes `ResponseRun.triggerKey` verbatim, as today. */
      readonly commentId: string;
      readonly text: string;
      readonly authorId: string;
      readonly authorName: string | null;
      /** Post/video/reel id the comment sits under. */
      readonly postExternalId: string;
      readonly contact: "FIRST_CONTACT";
    }
  | {
      readonly kind: "inboundMessage";
      readonly accountExternalId: string;
      readonly messageId: string;
      readonly text: string;
      readonly senderId: string;
      readonly contact: "FIRST_CONTACT";
    };

/** Something that advances an already-parked run. */
export interface RunSignal {
  readonly kind: "signal";
  readonly signal: SignalKind;
  readonly accountExternalId: string;
  readonly userId: string;
  /**
   * Which run this resolves. `{ byRun }` is the current encoding (postback
   * payload `r:<runId>`). `{ byUser }` covers read receipts, which name no
   * run — the engine resolves them to that user's parked runs on this account.
   */
  readonly target:
    | { readonly byRun: string }
    | { readonly byUser: { readonly userId: string } };
  /** True for a speculative resolution (read receipt), false for a real tap. */
  readonly speculative: boolean;
  readonly contact: "USER_CONFIRMED";
}

export type IngestedEvent = StartTrigger | RunSignal;

export interface WebhookIngest {
  /** GET handshake (Meta's `hub.challenge`). Returns the body to echo, or null. */
  verifyChallenge(raw: RawWebhook, app: ProviderApp): string | null;
  /**
   * Constant-time verification against EXACTLY ONE bound secret. Today's
   * `verifyWebhookSignature` tries every known secret against every payload;
   * capability-matrix §7 calls that out as a posture that weakens with each
   * platform. Here the route is `/api/ingest/{platform}/{slug}`, so the app —
   * and therefore the secret — is known before the body is read.
   */
  verifySignature(raw: RawWebhook, app: ProviderApp): boolean;
  /**
   * Wire payload -> domain events. Drops echoes, non-`add` verbs, hidden
   * comments and self-comments here so nothing downstream sees them. Pure:
   * no I/O, so it is directly unit-testable against captured payloads — this
   * is where today's `__tests__/webhook.test.ts` fixtures land unchanged.
   */
  parse(rawBody: string, app: ProviderApp): readonly IngestedEvent[];
}

// ─── Discovery (polling) ─────────────────────────────────────────────────────

/**
 * How this platform finds comments. Three real shapes, one type:
 *   Instagram — webhook + `sweep` as safety net (`priority: "safetyNet"`)
 *   Facebook / TikTok — webhook + optional low-frequency reconcile
 *   YouTube — `ingest: null`, `sweep.priority: "primary"`, metered
 */
export interface SweepSpec {
  readonly priority: "primary" | "safetyNet";
  /** Quota units one sweep costs. YouTube: 1 for `commentThreads.list`. */
  readonly costPerSweep: QuotaCost;
  readonly baseIntervalMs: number;
  /**
   * Ceiling the scheduler may stretch to under quota pressure. The scheduler
   * degrades by lengthening, never by failing (capability-matrix §3).
   */
  readonly maxIntervalMs: number;
  readonly lookbackMs: number;
  /** Hard cap on comments one sweep may emit, so a viral post drains gradually. */
  readonly maxItemsPerSweep: number;
}

export interface SweepResult {
  readonly events: readonly StartTrigger[];
  /** Opaque to the engine; stored on the account and handed back next sweep. */
  readonly cursor: string | null;
  /** Actual units consumed, which may exceed the estimate on a paginated sweep. */
  readonly unitsSpent: QuotaCost;
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Everything the engine needs to know about a step before it runs, computed
 * without touching the network. This is what keeps `platform === ...` out of
 * the engine.
 */
export interface DeliveryPlan<P extends PlatformId> {
  readonly step: AnyStep<P>;
  /**
   * Scarce one-shot resources this delivery consumes. Instagram and Facebook
   * both return a `private_reply` claim on the comment id — the same rule with
   * different windows. YouTube returns `[]`. This is how the
   * one-private-reply-per-comment rule stops being an `if` in the send path.
   */
  readonly claims: readonly ExclusiveClaim[];
  /**
   * Buckets to debit, SCARCEST FIRST. The engine reserves in order and
   * compensates on partial failure.
   */
  readonly buckets: readonly BucketSpec[];
  readonly cost: QuotaCost;
  /**
   * Platform-opaque addressing. The engine passes it straight back to
   * `deliver`. Keeping it opaque is what stops a `comment_id` or a PSID from
   * appearing on the engine's types (information leakage).
   */
  readonly addressing: unknown;
  /**
   * Set when the adapter can cheaply ask, before sending, whether this
   * delivery is possible — Facebook's `can_reply_privately`. When present the
   * engine calls it and records `SKIPPED_INELIGIBLE` rather than burning the
   * account's single allowed private reply on a comment that cannot take one.
   */
  readonly preflight: ((cred: Credential) => Promise<PreflightResult>) | null;
}

export type PreflightResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

export interface RenderedContent {
  /** `{username}` / `{link}` already substituted by the engine. */
  readonly text: string;
  readonly buttons: readonly { readonly title: string; readonly url: string }[];
  /** Postback payload for button steps: `r:<runId>`. */
  readonly postbackPayload: string | null;
}

export interface DeliveryReceipt {
  /** Platform message/comment id, stored for audit and for the shadow-hide check. */
  readonly externalId: string | null;
  /**
   * Facebook returns the commenter's PSID only in the private-reply response.
   * Persisting it is the only way to continue the conversation later.
   */
  readonly discoveredUserId: string | null;
  readonly deliveredAt: Date;
}

/**
 * A vendor error, classified into terms the engine can act on. This replaces
 * `isTemplateRejection()`'s regex-over-error-strings, which capability-matrix
 * §7 names as the strongest argument for putting "can I respond this way?"
 * inside the adapter.
 */
export interface Failure {
  readonly kind:
    | "RETRYABLE" // transient; requeue with backoff
    | "RATE_LIMITED" // vendor-side throttle; requeue after `retryAfterMs`
    | "TOKEN_INVALID" // raises a TOKEN_EXPIRED incident, pauses the account
    | "PERMISSION_DENIED" // raises PERMISSION_REVOKED
    | "WINDOW_CLOSED" // messaging window shut; not retryable, not the user's fault
    | "INELIGIBLE" // this recipient/comment can never take this delivery
    | "PERMANENT"; // malformed, rejected content, etc.
  /**
   * Whether the vendor may have acted despite the error. Load-bearing: if a
   * private reply was attempted, Meta has consumed the comment's one allowed
   * reply even though we saw an error, so the exclusive claim must NOT be
   * released. `"unknown"` is treated as `"yes"` — conservative by design.
   */
  readonly attempted: "yes" | "no" | "unknown";
  readonly retryAfterMs: number | null;
  readonly message: string;
  /** Mapped by the engine into a cross-platform incident on the admin view. */
  readonly incident: IncidentHint | null;
}

export type IncidentHint =
  | "TOKEN_EXPIRED"
  | "PERMISSION_REVOKED"
  | "QUOTA_EXHAUSTED"
  | "WEBHOOK_UNSUBSCRIBED"
  | "REGION_INELIGIBLE"
  | "POLICY_HOLD";

// ─── The adapter ─────────────────────────────────────────────────────────────

export interface PlatformAdapter<P extends PlatformId> {
  readonly platform: P;

  // — Connection —

  /** Build the authorize URL. State is HMAC-signed and carries the workspace. */
  authorizeUrl(app: ProviderApp, redirectUri: string, state: string): string;

  /**
   * Exchange the code, resolve the account identity, subscribe webhooks, and
   * negotiate capabilities in one call. Deep on purpose: today's callback route
   * coordinates five steps (exchange -> long-lived token -> user info ->
   * subscribe -> upsert) and every platform sequences them differently.
   */
  connect(
    app: ProviderApp,
    code: string,
    redirectUri: string
  ): Promise<{
    readonly account: Omit<ConnectedAccount<P>, "id" | "workspaceId" | "providerAppId">;
    readonly credential: Credential;
  }>;

  /**
   * Refresh, or decline to. Facebook Page tokens never expire, so Facebook
   * returns `{ kind: "notNeeded" }` — today's `refresh-tokens` cron assumes
   * every account is refreshable, which is wrong for three of four platforms.
   * Also re-negotiates: a shrunken capability set is how a region change or a
   * revoked scope becomes visible.
   */
  refresh(
    app: ProviderApp,
    account: ConnectedAccount<P>,
    cred: Credential
  ): Promise<
    | { readonly kind: "notNeeded" }
    | { readonly kind: "refreshed"; readonly credential: Credential }
    | { readonly kind: "reauthRequired"; readonly reason: string }
  >;

  /** Re-derive `AccountCapabilities` from live platform state. */
  negotiate(
    app: ProviderApp,
    account: Pick<ConnectedAccount<P>, "externalId">,
    cred: Credential
  ): Promise<AccountCapabilities<P>>;

  // — Discovery —

  /** `null` when the platform has no comment webhook. YouTube is null. */
  readonly ingest: WebhookIngest | null;
  /** `null` when polling is not used at all. */
  readonly sweep: SweepSpec | null;

  runSweep(
    account: ConnectedAccount<P>,
    cred: Credential,
    cursor: string | null,
    budget: { readonly maxItems: number; readonly maxUnits: QuotaCost }
  ): Promise<SweepResult>;

  /**
   * Resolve "the next post this creator publishes" — generalises today's
   * `pendingNextReel` + `attach-next-reel` cron. Instagram reads recent media;
   * YouTube reads the uploads playlist; a platform without the notion returns
   * null and the campaign builder never offers the option.
   */
  resolveNextPost(
    account: ConnectedAccount<P>,
    cred: Credential,
    since: Date
  ): Promise<{ readonly postExternalId: string; readonly url: string } | null>;

  // — Execution —

  /** PURE. No I/O. Called before any quota is spent. */
  plan(
    step: AnyStep<P>,
    trigger: RunContextForPlan,
    account: ConnectedAccount<P>
  ): DeliveryPlan<P>;

  /**
   * The only method that talks to the platform on the send path. Owns retries
   * WITHIN one delivery — notably Instagram's button-template -> inline-text
   * fallback, which never surfaces to the engine.
   */
  deliver(
    dp: DeliveryPlan<P>,
    content: RenderedContent,
    cred: Credential
  ): Promise<DeliveryReceipt>;

  /** Vendor error -> `Failure`. The engine never inspects a raw error. */
  classify(error: unknown): Failure;

  /**
   * Buckets this account's sends and reads debit. Called at connect and by the
   * daily cron; the returned specs are what makes the four rate-limit shapes
   * data rather than code. Facebook's engagement-derived capacity is refreshed
   * here (`4800 x engaged users`), which is why it needs a credential.
   */
  quotaBuckets(
    account: ConnectedAccount<P>,
    app: ProviderApp,
    cred: Credential | null
  ): Promise<readonly BucketSpec[]>;

  /**
   * Optional probe, present only when `FOLLOW_GATE` is in the ceiling. Its
   * absence from the type is what makes a follow gate unexecutable as well as
   * unconstructable.
   */
  readonly probeFollowStatus?: (
    account: ConnectedAccount<P>,
    cred: Credential,
    userId: string
  ) => Promise<FollowStatus>;

  /**
   * Optional: re-read a delivery we made to see whether the platform hid it.
   * TikTok's missing `set_to_public` webhook and YouTube's
   * `moderationStatus=heldForReview` are the same product event —
   * "our reply is invisible" — and both raise a POLICY_HOLD incident.
   */
  readonly checkDeliveryVisibility?: (
    account: ConnectedAccount<P>,
    cred: Credential,
    receiptExternalId: string
  ) => Promise<"visible" | "hidden" | "unknown">;
}

/** `true` follows, `false` does not, `null` unverifiable. */
export type FollowStatus = true | false | null;

/** The slice of run state `plan` may read. Deliberately narrow. */
export interface RunContextForPlan {
  readonly runId: string;
  readonly triggerKey: string;
  readonly counterpartyId: string;
  readonly commentExternalId: string | null;
  readonly postExternalId: string | null;
  readonly contact: "FIRST_CONTACT" | "USER_CONFIRMED";
}
