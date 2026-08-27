/**
 * Exclusive claims: the mechanism that generalises Instagram's
 * one-private-reply-per-comment rule WITHOUT hoisting the rule into the core.
 *
 * Phase A, constraint 3: "The one-private-reply-per-comment rule is
 * Instagram's, not the product's. A platform abstraction that hoists it to the
 * core will be wrong for Facebook/YouTube."
 *
 * The rule shape, stated platform-neutrally: some deliveries consume a scarce,
 * externally owned, one-shot resource identified by a key. Instagram: one
 * private reply per comment, ever, across every campaign. Facebook: the same
 * sentence ("Only one message can be sent to the person who commented"), 7-day
 * window instead of 24h. TikTok: the comment must not have been replied to by
 * DM in any way. YouTube: nothing — a public reply consumes nothing.
 *
 * So the CORE owns the mechanism (take a key before sending, at most one
 * holder, ever) and the ADAPTER owns the policy (which keys, if any, a step
 * consumes). Facebook gets the rule for free by returning the same claim shape.
 * YouTube returns `[]` and never touches the ledger. There is no `if` anywhere
 * in the engine.
 */

/**
 * A one-shot resource. `scope` namespaces the rule so unrelated one-shots
 * cannot collide; `key` is the platform's own id for the thing.
 *
 *   { scope: "ig:private_reply", key: "17931234567890123" }
 *   { scope: "fb:private_reply", key: "12345_67890" }
 *   { scope: "tt:comment_dm",    key: "7280000000000000000" }
 */
export interface ExclusiveClaim {
  readonly scope: string;
  readonly key: string;
  /**
   * When the platform's window closes. Purely informational for the ledger —
   * a claim is NEVER auto-released on expiry, because the platform's one-shot
   * is spent whether or not the window is still open. Used by the admin view
   * to explain "this comment can no longer be privately replied to".
   */
  readonly expiresAt: Date | null;
}

export type ClaimResult =
  | { readonly held: true; readonly firstAcquired: boolean }
  /**
   * Someone else holds it. Carries enough to reproduce today's message:
   * "Another campaign (X) already sent the one private reply Instagram allows
   * for this comment."
   */
  | {
      readonly held: false;
      readonly holderRunId: string;
      readonly holderCampaignId: string;
      readonly holderCampaignName: string;
    };

export interface ClaimLedger {
  /**
   * Take every claim for `runId`, or none. Re-acquiring a claim this run
   * already holds is a no-op that returns `firstAcquired: false`, which is
   * what makes a queue redelivery safe: Cloudflare Queues is at-least-once, so
   * a step WILL sometimes execute twice.
   *
   * Backed by `DeliveryClaim` with `@@unique([scope, key])`. The database
   * constraint IS the mutual exclusion — no lock, no DO, no race window, and
   * it survives a Worker eviction mid-send.
   */
  acquire(
    claims: readonly ExclusiveClaim[],
    runId: string
  ): Promise<ClaimResult>;

  /**
   * Release claims taken for a delivery the platform PROVABLY did not attempt.
   *
   * The `attempted` discipline is load-bearing and easy to get backwards: when
   * Meta rejects a button template, the comment's single allowed private reply
   * has ALREADY been consumed — today's code says so in a comment
   * ("The first attempt consumed the comment's single private reply, so this
   * one reports 'invalid for a private reply' no matter what the underlying
   * problem was"). So a claim is released only on `Failure.attempted === "no"`.
   * `"unknown"` keeps the claim: over-holding costs one lost send, releasing
   * wrongly costs a permanently confusing failure the creator cannot fix.
   */
  releaseUnattempted(
    claims: readonly ExclusiveClaim[],
    runId: string
  ): Promise<void>;
}
