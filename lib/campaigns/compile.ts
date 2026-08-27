/**
 * The boundary gate.
 *
 * Campaigns are authored in a browser and stored as JSON, so the type-level
 * gate in `steps.ts` cannot be the real one. This is: one parse at the
 * persistence boundary, against the capabilities the account actually has.
 * Inside that boundary the branded types are trusted.
 *
 * `compile` and `parseStoredPlan` are the same check run at different times.
 * Compiling validates a draft before it is stored; parsing re-validates stored
 * JSON on every load, because a campaign can outlive the capability it was
 * written against. A TikTok account that moves region, a Meta permission
 * revoked at review, a scope the creator declined on reconnect: all of them
 * shrink the granted set under a plan that was legal when it was saved.
 *
 * Pure. No I/O, no database, no clock. The same function runs in the browser on
 * every keystroke and on the server before a write, so the two cannot disagree.
 */

import { z } from "zod";
import type { Platform } from "@/app/generated/prisma/client";
import type { Capability } from "@/lib/platforms/types";
import {
  STEP_KINDS,
  STEP_REQUIREMENTS,
  builders,
  type AllStepBuilders,
  type BuildOptions,
  type Step,
  type StepBuilders,
  type StepKind,
} from "./steps";

/** A step as it arrives from the browser or the database, before checking. */
export interface DraftStep {
  readonly kind: string;
  readonly spec: unknown;
  readonly repeat?: string;
  readonly awaits?: unknown;
}

export interface CompileError {
  /** Where the problem is, for the builder to highlight. */
  readonly path: string;
  readonly code:
    | "UNKNOWN_STEP"
    | "CAPABILITY_UNAVAILABLE"
    | "MALFORMED_SPEC"
    | "COPY_POLICY_VIOLATION"
    | "EMPTY_PLAN";
  readonly message: string;
}

export type CompileResult<P extends Platform> =
  | { readonly ok: true; readonly steps: readonly Step<P, StepKind>[] }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

/**
 * A constraint on creator-authored copy.
 *
 * A pure predicate returning null when the text passes, so the same rule runs
 * client-side for live feedback and server-side for enforcement. These are
 * platform policy, not taste: breaking one risks the creator's account, not
 * ours.
 */
export interface CopyRule {
  readonly id: string;
  readonly appliesTo: readonly StepKind[];
  readonly check: (text: string, allVariants: readonly string[]) => string | null;
}

/**
 * Phrases that offer something in exchange for commenting.
 *
 * YouTube Developer Policy section III.F prohibits offering "incentives,
 * rewards, or other compensation" for "adding comments". The comment-triggered
 * reply is defensible; incentivising the comment that triggers it is not. This
 * is the growth mechanic the product is built around on Instagram, so it has to
 * be blocked where the creator writes it rather than where it sends.
 */
const INCENTIVISED_COMMENT =
  /\b(comment|drop|type|reply)\b[^.!?]{0,40}\b(below|down below|this word|the word)?\b[^.!?]{0,40}\b(and (i'?ll|i will|we'?ll|we will)|to (get|receive|unlock)|for (a|the|your) (free|link|guide|code|discount))\b/i;

export const YOUTUBE_COPY_RULES: readonly CopyRule[] = [
  {
    id: "youtube:no-comment-incentive",
    appliesTo: ["publicReply"],
    check: (text) =>
      INCENTIVISED_COMMENT.test(text)
        ? "YouTube Developer Policy III.F prohibits offering anything in exchange for a comment. Reply to the comment without asking for one."
        : null,
  },
  {
    id: "youtube:vary-reply-copy",
    appliesTo: ["publicReply"],
    check: (_text, allVariants) =>
      allVariants.length < 2
        ? "YouTube treats high-volume identical replies as comment spam, and the strike lands on the creator's channel. Write at least two variants."
        : null,
  },
];

/**
 * TikTok's warning is explicit: a high volume of similar comments in a short
 * window is flagged as spam and hidden, and the `set_to_public` webhook that
 * would tell us never arrives.
 */
export const TIKTOK_COPY_RULES: readonly CopyRule[] = [
  {
    id: "tiktok:vary-reply-copy",
    appliesTo: ["publicReply"],
    check: (_text, allVariants) =>
      allVariants.length < 2
        ? "TikTok hides replies it reads as spam, and it sends no signal when it does. Write at least two variants."
        : null,
  },
];

export function copyRulesFor(platform: Platform): readonly CopyRule[] {
  switch (platform) {
    case "YOUTUBE":
      return YOUTUBE_COPY_RULES;
    case "TIKTOK":
      return TIKTOK_COPY_RULES;
    case "INSTAGRAM":
    case "FACEBOOK":
      return [];
  }
}

const AWAIT = z.object({
  signals: z.array(z.enum(["postback", "read", "inboundMessage"])),
  timeoutMs: z.number().int().nonnegative(),
  onTimeout: z.enum(["continue", "abandon"]).default("continue"),
});

const TEXT = z.string().trim().min(1);
const SLUGS = z.array(z.string());

/**
 * One schema per step kind, parsed at the boundary.
 *
 * Hand-rolled `typeof` guards were the alternative and they were worse in a
 * specific way: they proved the shape to a reader without proving it to the
 * compiler, so every use downstream needed an assertion to get the type back.
 */
const SPEC = {
  publicReply: z.object({ variants: z.array(TEXT).min(1) }),
  directMessage: z.object({ text: TEXT }),
  linkButtons: z.object({
    bodyText: TEXT,
    linkSlugs: SLUGS,
    primaryLabel: z.string().nullish().transform((v) => v ?? null),
  }),
  openingDm: z.object({ text: TEXT, buttonLabel: TEXT }),
  followGate: z.object({ promptText: TEXT, buttonLabel: TEXT }),
  conversationMessage: z.object({
    text: TEXT,
    linkSlugs: SLUGS,
    primaryLabel: z.string().nullish().transform((v) => v ?? null),
  }),
  followUp: z.object({ text: TEXT, delayMinutes: z.number().nonnegative() }),
} satisfies Record<StepKind, z.ZodType>;

const STEP_KIND = z.enum(STEP_KINDS);

const DRAFT = z.object({
  kind: z.string(),
  spec: z.unknown(),
  repeat: z.enum(["once", "everySignal"]).optional(),
  awaits: AWAIT.nullish().transform((v) => v ?? null),
});

interface Built<P extends Platform> {
  readonly step: Step<P, StepKind>;
  /** Every template the copy rules should read. */
  readonly texts: readonly string[];
}

/**
 * Parse one step's spec and construct it.
 *
 * One case per kind rather than a lookup, because each kind's schema produces a
 * different type and its builder expects that type. A lookup would collapse
 * both into unions and need an assertion to pull them apart again.
 */
function buildStep<P extends Platform>(
  build: StepBuilders<P>,
  kind: StepKind,
  spec: unknown,
  options: BuildOptions
): Built<P> | null {
  // SAFETY: every branch below narrows `kind` to a literal, and the builder map
  // carries every kind at runtime. The type only hides the ones P cannot do,
  // and the caller has already checked P's capabilities cover this kind.
  const all = build as AllStepBuilders<P>;

  switch (kind) {
    case "publicReply": {
      const parsed = SPEC.publicReply.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.publicReply(parsed.data, options), texts: parsed.data.variants };
    }
    case "directMessage": {
      const parsed = SPEC.directMessage.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.directMessage(parsed.data, options), texts: [parsed.data.text] };
    }
    case "linkButtons": {
      const parsed = SPEC.linkButtons.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.linkButtons(parsed.data, options), texts: [parsed.data.bodyText] };
    }
    case "openingDm": {
      const parsed = SPEC.openingDm.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.openingDm(parsed.data, options), texts: [parsed.data.text] };
    }
    case "followGate": {
      const parsed = SPEC.followGate.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.followGate(parsed.data, options), texts: [parsed.data.promptText] };
    }
    case "conversationMessage": {
      const parsed = SPEC.conversationMessage.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.conversationMessage(parsed.data, options), texts: [parsed.data.text] };
    }
    case "followUp": {
      const parsed = SPEC.followUp.safeParse(spec);
      if (!parsed.success) return null;
      return { step: all.followUp(parsed.data, options), texts: [parsed.data.text] };
    }
  }
}

/**
 * Canonical ordering.
 *
 * The public reply always precedes the DM leg. That decoupling is the reason a
 * DM refused for a non-follower never suppresses the visible reply, and making
 * it a property of the compiler rather than a rule in the send path means it
 * cannot be broken by dragging a step in the builder.
 */
const CANONICAL_ORDER = {
  publicReply: 0,
  followGate: 1,
  openingDm: 2,
  directMessage: 3,
  linkButtons: 3,
  conversationMessage: 4,
  followUp: 5,
} as const satisfies Record<StepKind, number>;

/**
 * Check a draft plan against what an account can actually do.
 *
 * `granted` is the account's negotiated set, not the platform's ceiling, which
 * is why two accounts on the same platform can compile differently.
 */
export function compile<P extends Platform>(
  platform: P,
  granted: ReadonlySet<Capability>,
  draft: readonly unknown[]
): CompileResult<P> {
  const errors: CompileError[] = [];
  const build = builders(platform);
  const rules = copyRulesFor(platform);
  const steps: Step<P, StepKind>[] = [];

  if (draft.length === 0) {
    return {
      ok: false,
      errors: [
        { path: "steps", code: "EMPTY_PLAN", message: "A campaign needs at least one step." },
      ],
    };
  }

  draft.forEach((raw, index) => {
    const path = `steps[${index}]`;

    const parsed = DRAFT.safeParse(raw);
    if (!parsed.success) {
      errors.push({ path, code: "MALFORMED_SPEC", message: "This step is not readable." });
      return;
    }
    const { kind, spec, repeat, awaits } = parsed.data;

    const known = STEP_KIND.safeParse(kind);
    if (!known.success) {
      errors.push({ path, code: "UNKNOWN_STEP", message: `Unknown step "${kind}".` });
      return;
    }
    const stepKind = known.data;

    const missing = STEP_REQUIREMENTS[stepKind].filter((c) => !granted.has(c));
    if (missing.length > 0) {
      errors.push({
        path,
        code: "CAPABILITY_UNAVAILABLE",
        message: `This account cannot do "${stepKind}". Missing: ${missing.join(", ")}.`,
      });
      return;
    }

    const options: BuildOptions = { awaits };
    if (repeat) options.repeat = repeat;

    const built = buildStep(build, stepKind, spec, options);
    if (!built) {
      errors.push({
        path: `${path}.spec`,
        code: "MALFORMED_SPEC",
        message: `The "${stepKind}" step is missing something it needs.`,
      });
      return;
    }

    for (const rule of rules) {
      if (!rule.appliesTo.includes(stepKind)) continue;
      for (const [i, text] of built.texts.entries()) {
        const failure = rule.check(text, built.texts);
        if (failure) {
          errors.push({
            path: `${path}.spec[${i}]`,
            code: "COPY_POLICY_VIOLATION",
            message: failure,
          });
          break;
        }
      }
    }

    steps.push(built.step);
  });

  if (errors.length > 0) return { ok: false, errors };

  steps.sort((a, b) => CANONICAL_ORDER[a.kind] - CANONICAL_ORDER[b.kind]);
  return { ok: true, steps };
}

/**
 * Re-check a stored plan against the account's current capabilities.
 *
 * The same check as `compile`, run on load rather than on save. A stored plan
 * is validated input, never a cache: a capability can be revoked between the
 * save and the send, and the run must refuse rather than attempt something the
 * account can no longer do.
 */
export function parseStoredPlan<P extends Platform>(
  platform: P,
  granted: ReadonlySet<Capability>,
  stored: unknown
): CompileResult<P> {
  if (!Array.isArray(stored)) {
    return {
      ok: false,
      errors: [
        {
          path: "steps",
          code: "MALFORMED_SPEC",
          message: "The stored plan is not a list of steps.",
        },
      ],
    };
  }
  return compile(platform, granted, stored);
}
