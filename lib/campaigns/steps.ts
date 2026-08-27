/**
 * A campaign is an ordered list of response steps, and a step a platform cannot
 * perform is unconstructable rather than rejected.
 *
 * The product primitive is `respond to a comment`, not `send a DM`, because the
 * DM is not the universal capability and the public reply is. Each step kind
 * declares the capabilities it consumes; a platform declares a ceiling; and
 * `StepsAvailableOn<P>` is the intersection, computed by the type checker.
 *
 * There are two gates and they are deliberately different in kind. This file is
 * the compile-time one: `StepBuilders<"YOUTUBE">` has no `followGate` property,
 * so templates, seeds and tests get a type error rather than a runtime
 * rejection. Campaigns authored in a browser arrive as JSON and are checked by
 * the second gate in `compile.ts`, against the account's negotiated set.
 *
 * The ceiling is derived from `PLATFORM_CAPABILITIES` rather than restated, so
 * a capability added there reaches the builders with no second edit.
 */

import type { Platform } from "@/app/generated/prisma/client";
import { PLATFORM_CAPABILITIES } from "@/lib/platforms/types";
import type { Capability } from "@/lib/platforms/types";

export type CeilingOf<P extends Platform> = (typeof PLATFORM_CAPABILITIES)[P][number];

/**
 * Every step kind, mapped to the capabilities it consumes.
 *
 * A step is available on a platform only when every capability it lists is in
 * that platform's ceiling.
 */
export interface StepRequirements {
  /** Post a public reply under the triggering comment. */
  publicReply: readonly ["PUBLIC_REPLY"];
  /** Private-reply to the comment with plain text. */
  directMessage: readonly ["PRIVATE_REPLY"];
  /** Private-reply to the comment with tappable link buttons. */
  linkButtons: readonly ["PRIVATE_REPLY", "BUTTON_TEMPLATE"];
  /** Opening DM whose button tap advances the run to the next step. */
  openingDm: readonly ["PRIVATE_REPLY", "BUTTON_TEMPLATE", "POSTBACK_SIGNAL"];
  /** Require a follow before continuing; re-prompts until satisfied. */
  followGate: readonly ["FOLLOW_GATE", "BUTTON_TEMPLATE", "POSTBACK_SIGNAL"];
  /** Send inside the now-open conversation. */
  conversationMessage: readonly ["CONVERSATION_MESSAGE"];
  /** Delayed message inside the open conversation. */
  followUp: readonly ["CONVERSATION_MESSAGE"];
}

export const STEP_REQUIREMENTS = {
  publicReply: ["PUBLIC_REPLY"],
  directMessage: ["PRIVATE_REPLY"],
  linkButtons: ["PRIVATE_REPLY", "BUTTON_TEMPLATE"],
  openingDm: ["PRIVATE_REPLY", "BUTTON_TEMPLATE", "POSTBACK_SIGNAL"],
  followGate: ["FOLLOW_GATE", "BUTTON_TEMPLATE", "POSTBACK_SIGNAL"],
  conversationMessage: ["CONVERSATION_MESSAGE"],
  followUp: ["CONVERSATION_MESSAGE"],
} as const satisfies StepRequirements;

export type StepKind = keyof StepRequirements;

export const STEP_KINDS = [
  "publicReply",
  "directMessage",
  "linkButtons",
  "openingDm",
  "followGate",
  "conversationMessage",
  "followUp",
] as const satisfies readonly StepKind[];

/**
 * Adding a kind to `StepRequirements` without listing it above is a compile
 * error rather than a step the runtime silently never offers.
 */
type _EveryKindIsListed = [StepKind] extends [(typeof STEP_KINDS)[number]]
  ? true
  : ["missing from STEP_KINDS", Exclude<StepKind, (typeof STEP_KINDS)[number]>];
const _everyKindIsListed: _EveryKindIsListed = true;
void _everyKindIsListed;

/**
 * The step kinds constructible on platform P.
 *
 * `StepRequirements[K][number]` is a union of everything K needs, and it is not
 * a naked type parameter, so the conditional does not distribute: the whole
 * union must extend the ceiling. That is the "all requirements present" check,
 * done by the compiler.
 */
export type StepsAvailableOn<P extends Platform> = {
  [K in StepKind]: StepRequirements[K][number] extends CeilingOf<P> ? K : never;
}[StepKind];

export type SignalKind = "postback" | "read" | "inboundMessage";

/** What a parked step is waiting for, and what to do if it never arrives. */
export interface AwaitSpec {
  readonly signals: readonly SignalKind[];
  readonly timeoutMs: number;
  /**
   * `"continue"` reproduces the read-receipt fallback: the person read the
   * opening DM and never tapped, so deliver anyway after a grace period.
   */
  readonly onTimeout: "continue" | "abandon";
}

/** Text carrying `{username}` and `{link}` tokens, rendered at execution time. */
export type MessageTemplate = string;

export interface StepSpec {
  publicReply: {
    /** Variants, picked at random. More than one is what avoids a spam flag. */
    readonly variants: readonly MessageTemplate[];
  };
  directMessage: { readonly text: MessageTemplate };
  linkButtons: {
    readonly bodyText: MessageTemplate;
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
    readonly delayMinutes: number;
  };
}

/**
 * Not exported as a value, so nothing outside this module can produce a `Step`.
 * An object literal cannot satisfy it. The only doors in are `StepBuilders` and
 * `parseStoredPlan`, which is what makes the compile-time gate meaningful.
 */
declare const MINTED: unique symbol;

interface StepOf<P extends Platform, K extends StepKind> {
  readonly kind: K;
  readonly spec: StepSpec[K];
  /**
   * Whether a repeated signal re-executes this step. `"everySignal"` preserves
   * the documented behaviour where every button tap re-sends the reveal.
   */
  readonly repeat: "once" | "everySignal";
  readonly awaits: AwaitSpec | null;
  readonly [MINTED]: P;
}

/**
 * Distributive on purpose, so `Step<P>` is a union of one member per kind
 * rather than one member whose `spec` is a union. Switching on `kind` then
 * narrows `spec` to that kind's payload, which is what keeps the executor free
 * of an assertion per branch.
 */
export type Step<P extends Platform, K extends StepKind = StepKind> = K extends unknown
  ? StepOf<P, K>
  : never;

export type AnyStep<P extends Platform> = Step<P, StepsAvailableOn<P>>;

/**
 * Steps that re-run on every signal rather than once.
 *
 * Only the conversation message does. A public reply posted twice is visible
 * and embarrassing, and a follow-up is a scheduled one-shot.
 */
const REPEAT_DEFAULT = {
  publicReply: "once",
  directMessage: "once",
  linkButtons: "once",
  openingDm: "once",
  followGate: "everySignal",
  conversationMessage: "everySignal",
  followUp: "once",
} as const satisfies Record<StepKind, "once" | "everySignal">;

export interface BuildOptions {
  repeat?: "once" | "everySignal";
  awaits?: AwaitSpec | null;
}

export type AllStepBuilders<P extends Platform> = {
  readonly [K in StepKind]: (spec: StepSpec[K], options?: BuildOptions) => Step<P, K>;
};

/**
 * `Pick` rather than a mapped type over the available kinds, so the narrowing
 * is a subtype relation the compiler checks rather than an assertion. Building
 * the full map and returning it as this needs no cast at all.
 */
export type StepBuilders<P extends Platform> = Pick<
  AllStepBuilders<P>,
  StepsAvailableOn<P>
>;

/**
 * Step constructors for one platform.
 *
 * ```ts
 * const yt = builders("YOUTUBE");
 * yt.publicReply({ variants: ["thanks!"] });  // ok
 * yt.followGate({ ... });                     // Property 'followGate' does not
 *                                             // exist on StepBuilders<"YOUTUBE">
 * ```
 */
export function builders<P extends Platform>(_platform: P): StepBuilders<P> {
  function make<K extends StepKind>(kind: K) {
    return (spec: StepSpec[K], options?: BuildOptions): Step<P, K> =>
      // SAFETY: the brand is phantom and has no runtime representation, so
      // there is nothing to construct for it. Every other field is assigned on
      // the lines above.
      ({
        kind,
        spec,
        repeat: options?.repeat ?? REPEAT_DEFAULT[kind],
        awaits: options?.awaits ?? null,
      }) as Step<P, K>;
  }

  // Written out rather than looped, because `Object.fromEntries` collapses the
  // per-kind spec types into a union and the map would need an assertion to get
  // them back. The full map is a supertype of the return type, so this needs
  // none.
  const all = {
    publicReply: make("publicReply"),
    directMessage: make("directMessage"),
    linkButtons: make("linkButtons"),
    openingDm: make("openingDm"),
    followGate: make("followGate"),
    conversationMessage: make("conversationMessage"),
    followUp: make("followUp"),
  } satisfies AllStepBuilders<P>;
  return all;
}

export interface StepAvailability {
  readonly kind: StepKind;
  readonly available: boolean;
  /** Which capabilities are missing. Empty when the step is available. */
  readonly missing: readonly Capability[];
}

/**
 * What the campaign builder may offer for a capability set.
 *
 * Takes the granted set rather than the platform, because an account's set is a
 * subset of its platform's ceiling. A UK TikTok account has strictly fewer
 * capabilities than a Vietnamese one, and the builder must show that.
 */
export function availableSteps(
  granted: ReadonlySet<Capability>
): StepAvailability[] {
  return STEP_KINDS.map((kind) => {
    const missing = STEP_REQUIREMENTS[kind].filter((c) => !granted.has(c));
    return { kind, available: missing.length === 0, missing };
  });
}

/** The capability ceiling of a platform, as a set. */
export function platformCeiling(platform: Platform): ReadonlySet<Capability> {
  // SAFETY: `PLATFORM_CAPABILITIES` is `satisfies Record<Platform, readonly
  // Capability[]>`, so every member is a Capability. The widening only lets the
  // Set accept the full union rather than one platform's narrower tuple.
  return new Set(PLATFORM_CAPABILITIES[platform] as readonly Capability[]);
}
