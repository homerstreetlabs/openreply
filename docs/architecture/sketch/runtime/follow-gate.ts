/**
 * The follow gate's decision table, extracted as a pure function.
 *
 * Today this rule is spread across three call sites in `dm-worker.ts` with
 * three different shapes, and the difference between them is the single most
 * subtle piece of behaviour in the codebase — the comments in the current code
 * spend more lines explaining it than the code takes to express it:
 *
 *   processComment  (first contact)  `follows !== true`  -> prompt   FAIL CLOSED
 *   processMessage  (first contact)  `follows !== true`  -> prompt   FAIL CLOSED
 *   processPostback (after a tap)    `follows === false` -> prompt   FAIL OPEN
 *   processPostback (read fallback)  `follows === false` -> drop     FAIL OPEN
 *
 * The axis is not the platform and not the trigger type. It is PROVENANCE:
 * has the user already claimed to follow? On first contact an unverifiable
 * status must not hand out the link; after a tap the user has claimed to
 * follow and trapping a real follower is the worse error.
 *
 * The second axis is whether a re-prompt is appropriate: a real button tap is
 * an invitation to answer; a speculative read-receipt fallback is not, and
 * re-prompting there would spam someone who never engaged.
 *
 * Keeping this in the core rather than in the Instagram adapter is deliberate:
 * the PROBE is Instagram-only (`is_user_follow_business`; no other platform
 * has it, so `probeFollowStatus` is an optional adapter member and the gate
 * step is unconstructable elsewhere), but the CONSENT POLICY is the product's.
 * If Facebook ever ships a follow signal, this table is already correct for it.
 */

import type { FollowStatus } from "../platform/adapter";

export type ContactState =
  /** Comment, or an inbound DM that starts a run. The user has claimed nothing. */
  | "FIRST_CONTACT"
  /** A button tap, or a read receipt on a message we already delivered. */
  | "USER_CONFIRMED";

export type GateOutcome =
  /** Continue to the next step. */
  | "PASS"
  /** Send the follow prompt (again) and park the run. */
  | "PROMPT"
  /** End the run silently. No log entry the creator can act on. */
  | "DROP";

/**
 * The whole rule, in one place, with no I/O.
 *
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
  throw new Error("not implemented");
}

/**
 * `canReprompt` is false exactly when the signal was speculative — today's
 * `fallback: true` on the read-receipt path. Derived rather than passed
 * around, so the two cannot drift.
 */
export function canReprompt(signalWasSpeculative: boolean): boolean {
  return !signalWasSpeculative;
}
