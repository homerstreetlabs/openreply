/**
 * The follow gate's decision table, as one pure function.
 *
 * The rule lives at three call sites in the send path with three different
 * shapes, and the difference between them is the subtlest behaviour in the
 * codebase:
 *
 *   first contact from a comment   `follows !== true`  -> prompt   fail closed
 *   first contact from a DM        `follows !== true`  -> prompt   fail closed
 *   after a button tap             `follows === false` -> prompt   fail open
 *   after a read-receipt fallback  `follows === false` -> drop     fail open
 *
 * The axis is not the platform and not the trigger. It is provenance: has the
 * person already claimed to follow? On first contact an unverifiable status
 * must not hand over the link. After a tap they have claimed to follow, and
 * trapping a real follower is the worse error.
 *
 * The second axis is whether re-prompting is appropriate. A real tap is an
 * invitation to answer. A speculative read-receipt fallback is not, and
 * prompting there would pester someone who never engaged.
 *
 * The probe is Instagram-only, so the gate step is unconstructable elsewhere.
 * The consent policy is the product's, which is why it lives here rather than
 * in the Instagram adapter. If another platform ever ships a follow signal,
 * this table is already right for it.
 */

/** What the platform said. Null means it would not answer, not "no". */
export type FollowStatus = boolean | null;

export type ContactState =
  /** A comment, or an inbound DM that starts a run. Nothing has been claimed. */
  | "FIRST_CONTACT"
  /** A button tap, or a read receipt on a message already delivered. */
  | "USER_CONFIRMED";

export type GateOutcome =
  /** Continue to the next step. */
  | "PASS"
  /** Send the follow prompt again and park the run. */
  | "PROMPT"
  /** End the run silently, with nothing the creator could act on. */
  | "DROP";

/**
 * | status | contact        | canReprompt | outcome |
 * |--------|----------------|-------------|---------|
 * | true   | any            | any         | PASS    |
 * | false  | any            | true        | PROMPT  |
 * | false  | any            | false       | DROP    |
 * | null   | FIRST_CONTACT  | true        | PROMPT  |  fail closed
 * | null   | FIRST_CONTACT  | false       | DROP    |  fail closed
 * | null   | USER_CONFIRMED | any         | PASS    |  fail open
 */
export function resolveFollowGate(
  status: FollowStatus,
  contact: ContactState,
  canReprompt: boolean
): GateOutcome {
  if (status === true) return "PASS";

  // Instagram declines to answer for some accounts, and treating silence as
  // "not following" would trap a real follower behind a gate they already
  // passed. After they have tapped, believe them.
  if (status === null && contact === "USER_CONFIRMED") return "PASS";

  return canReprompt ? "PROMPT" : "DROP";
}

/**
 * Re-prompting is wrong exactly when the signal was speculative.
 *
 * Derived rather than threaded through call sites, so the two cannot drift.
 */
export function canReprompt(signalWasSpeculative: boolean): boolean {
  return !signalWasSpeculative;
}
