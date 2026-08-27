/**
 * Compile-time evidence that a capability a platform lacks is unconstructable,
 * not merely rejected.
 *
 * Without this file, "a YouTube follow gate cannot be written" is a claim in a
 * document. Here it is a build failure. Every `@ts-expect-error` below is a
 * negative test: if a refactor made the illegal thing constructible, tsc
 * reports the now-unused directive and the typecheck goes red.
 *
 * This file must stay in the typecheck target. It is not a test fixture, and
 * nothing imports it at runtime.
 *
 * Scope, stated honestly: this proves the first of two gates. First-party code
 * cannot express an impossible step. Campaigns authored in a browser arrive as
 * data and are checked by the second gate, `parseStoredPlan`, against the
 * account's negotiated set, which is a subset of the ceiling proven here.
 */

import { builders, type AnyStep, type Step, type StepsAvailableOn } from "./steps";

type Assert<T extends true> = T;
type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// ─── The ceilings, as the type checker sees them ─────────────────────────────

type _YoutubeIsReplyOnly = Assert<Eq<StepsAvailableOn<"YOUTUBE">, "publicReply">>;

type _TiktokCannotBeDmd = Assert<Eq<StepsAvailableOn<"TIKTOK">, "publicReply">>;

/** Facebook has everything Instagram has except the follow gate. */
type _FacebookHasNoFollowGate = Assert<
  Eq<Extract<StepsAvailableOn<"FACEBOOK">, "followGate">, never>
>;
type _FacebookStillDms = Assert<
  Eq<Extract<StepsAvailableOn<"FACEBOOK">, "directMessage">, "directMessage">
>;
type _InstagramHasFollowGate = Assert<
  Eq<Extract<StepsAvailableOn<"INSTAGRAM">, "followGate">, "followGate">
>;

// ─── The builders refuse to construct what the platform cannot do ────────────

const youtube = builders("YOUTUBE");
const facebook = builders("FACEBOOK");
const instagram = builders("INSTAGRAM");

youtube.publicReply({ variants: ["sent it your way, check the pinned comment"] });

// @ts-expect-error YouTube has no messaging API of any kind.
youtube.directMessage({ text: "here is the link" });

// @ts-expect-error A follow gate needs FOLLOW_GATE, which YouTube lacks.
youtube.followGate({ promptText: "follow first", buttonLabel: "done" });

// @ts-expect-error Facebook Pages expose no `is_user_follow_business`.
facebook.followGate({ promptText: "follow first", buttonLabel: "done" });

facebook.directMessage({ text: "here is the link" });
instagram.followGate({ promptText: "follow first", buttonLabel: "done" });

// ─── A step cannot be forged by writing the object shape ─────────────────────

// @ts-expect-error The brand is a non-exported unique symbol, so no literal
// satisfies `Step`. `builders` and `parseStoredPlan` are the only doors in.
const _forged: Step<"YOUTUBE", "publicReply"> = {
  kind: "publicReply",
  spec: { variants: ["x"] },
  repeat: "once",
  awaits: null,
};

// ─── A platform's steps do not leak into another's ───────────────────────────

const igGate = instagram.followGate({ promptText: "p", buttonLabel: "b" });

// @ts-expect-error An Instagram step is branded with its platform and is not an
// `AnyStep<"YOUTUBE">`, so a plan cannot be assembled across platforms.
const _crossPlatform: AnyStep<"YOUTUBE"> = igGate;
