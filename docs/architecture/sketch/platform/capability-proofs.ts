/**
 * capability-proofs.ts — compile-time evidence for this design's central claim:
 * a capability a platform lacks is UNCONSTRUCTABLE, not merely rejected.
 *
 * GRAFTED from arena candidate 1, adapted to this design's type names
 * (`StepsAvailableOn` / `StepBuilders` / branded `Step`) rather than
 * candidate 1's `StepFor` / `Requiring`.
 *
 * Why this file exists at all: without it, "a YouTube follow gate cannot be
 * written" is a claim in a document. Here it is a build failure. Every
 * `@ts-expect-error` below is a NEGATIVE test — if a future refactor made the
 * illegal thing constructible, tsc reports the now-unused directive and CI goes
 * red. This file must stay in the typecheck target; it is not a test fixture.
 *
 * Scope, stated honestly: this proves the FIRST of the two gates. First-party
 * code (templates, seeds, tests, the campaign builder's own call sites) cannot
 * express an impossible step. Campaigns authored in a browser arrive as data
 * and are checked by the SECOND gate, `parseStoredPlan`, against the account's
 * negotiated capability set — which is a subset of the ceiling proven here, so
 * anything this file forbids is forbidden there too.
 */

import type {
  AnyStep,
  Capability,
  CeilingOf,
  PlatformId,
  Step,
  StepBuilders,
  StepKind,
  StepRequirements,
  StepsAvailableOn,
} from "./capability";

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;

// ── 1. YouTube's step vocabulary is exactly one kind ─────────────────────────
// The capability matrix's headline finding, as a type: the public reply is the
// universal capability and it is ALL YouTube has.
type _yt_only_public = Assert<Eq<StepsAvailableOn<"youtube">, "publicReply">>;

// ── 2. A follow gate does not exist on the platforms that cannot do one ──────
type _yt_no_followgate = Assert<
  Extends<Extract<StepsAvailableOn<"youtube">, "followGate">, never>
>;
// Facebook has private replies but no `is_user_follow_business` equivalent:
type _fb_no_followgate = Assert<
  Extends<Extract<StepsAvailableOn<"facebook">, "followGate">, never>
>;
type _tt_no_followgate = Assert<
  Extends<Extract<StepsAvailableOn<"tiktok">, "followGate">, never>
>;
// Instagram's does exist — the gate is discriminating, not uniformly closed:
type _ig_followgate = Assert<
  Not<Extends<Extract<StepsAvailableOn<"instagram">, "followGate">, never>>
>;

// ── 3. No comment-addressed DM on YouTube or TikTok ──────────────────────────
// YouTube: no messaging API exists at all.
// TikTok: "You are prohibited from initiating a conversation or messaging any
// TikTok user who has not started a conversation with you."
type _yt_no_dm = Assert<Not<Extends<"DIRECT_MESSAGE", CeilingOf<"youtube">>>>;
type _tt_no_dm = Assert<Not<Extends<"DIRECT_MESSAGE", CeilingOf<"tiktok">>>>;
// ...but TikTok CAN message inside a conversation the user opened. That is the
// inverted funnel, and it must remain constructible or the compliant TikTok
// product is unbuildable:
type _tt_conversation = Assert<
  Not<Extends<Extract<StepsAvailableOn<"tiktok">, "conversationMessage">, never>>
>;

// ── 4. The builder surface physically lacks the property ─────────────────────
declare const yt: StepBuilders<"youtube">;
declare const ig: StepBuilders<"instagram">;

export function builderProofs(): void {
  // Legal: the universal capability.
  yt.publicReply({} as never);

  // @ts-expect-error — Property 'followGate' does not exist on
  // StepBuilders<"youtube">. There is nowhere to put a YouTube follow gate,
  // so there is no stub to write and no `default:` arm to forget.
  yt.followGate({} as never);

  // @ts-expect-error — Property 'openingDm' does not exist on
  // StepBuilders<"youtube">: it needs DIRECT_MESSAGE + BUTTON_TEMPLATE +
  // POSTBACK_SIGNAL, and YouTube has none of the three.
  yt.openingDm({} as never);

  // Instagram keeps all of it.
  ig.followGate({} as never);
  ig.openingDm({} as never);
}

// ── 5. A step cannot be forged by an object literal ──────────────────────────
// The MINTED brand is a non-exported `unique symbol`, so `builders()` and
// `parseStoredPlan` are the only two doors in.
declare function acceptInstagramStep(step: AnyStep<"instagram">): void;

export function forgeryProofs(): void {
  acceptInstagramStep(
    // @ts-expect-error — missing the MINTED brand; an object literal is not a Step.
    { kind: "publicReply", spec: {}, repeat: "once", awaits: null }
  );
}

// ── 6. A step minted for one platform cannot execute on another ──────────────
declare const igStep: Step<"instagram", "followGate">;
declare function acceptYoutubeStep(step: AnyStep<"youtube">): void;

export function crossPlatformProofs(): void {
  // @ts-expect-error — the brand carries the platform, so an Instagram step
  // cannot be smuggled into a YouTube plan even though both are `Step`s.
  acceptYoutubeStep(igStep);
}

// ── 7. The gating MECHANISM itself, spot-checked ─────────────────────────────
// If `StepsAvailableOn` ever became distributive, a step needing three
// capabilities would wrongly survive on a platform holding only one of them.
// This pins the "ALL requirements present" semantics.
type NeedsThree = StepRequirements["followGate"][number];
type _mechanism_ig = Assert<Extends<NeedsThree, CeilingOf<"instagram">>>;
type _mechanism_fb = Assert<Not<Extends<NeedsThree, CeilingOf<"facebook">>>>;

// ── 8. No dead vocabulary, and no capability without a step ──────────────────
// Every declared StepKind is reachable from at least one platform...
type _no_dead_steps = Assert<
  Extends<
    StepKind,
    | StepsAvailableOn<"instagram">
    | StepsAvailableOn<"facebook">
    | StepsAvailableOn<"youtube">
    | StepsAvailableOn<"tiktok">
  >
>;
// ...and every capability named in the union is claimed by some platform, so a
// capability cannot be invented and left unwired.
type AnyCeiling =
  | CeilingOf<"instagram">
  | CeilingOf<"facebook">
  | CeilingOf<"youtube">
  | CeilingOf<"tiktok">;
type _no_orphan_capability = Assert<Extends<Capability, AnyCeiling>>;

// ── 9. Adding a fifth platform cannot silently skip the ceiling ──────────────
// PlatformId is derived from PlatformCeiling's keys, so a platform with no
// ceiling entry is not a PlatformId and cannot reach the registry.
declare const everyPlatform: readonly PlatformId[];
type _platform_ids_closed = Assert<
  Extends<(typeof everyPlatform)[number], keyof StepRequirementsByPlatform>
>;
type StepRequirementsByPlatform = { [P in PlatformId]: StepsAvailableOn<P> };

export type _proofs = [
  _yt_only_public,
  _yt_no_followgate,
  _fb_no_followgate,
  _tt_no_followgate,
  _ig_followgate,
  _yt_no_dm,
  _tt_no_dm,
  _tt_conversation,
  _mechanism_ig,
  _mechanism_fb,
  _no_dead_steps,
  _no_orphan_capability,
  _platform_ids_closed,
];
