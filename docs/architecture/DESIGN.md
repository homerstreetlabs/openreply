# Multi-platform OpenReply on Cloudflare

## Problem

OpenReply is a working, revenue-shaped Instagram comment-to-DM engine: a webhook lands, a
BullMQ worker matches campaigns, and ~230 lines in `processComment` encode a lot of
hard-won Meta policy — one private reply per comment ever, the public reply decoupled and
posted first, a button-template fallback gated by a regex over Meta error strings, and a
follow gate that fails closed on first contact and open after a tap. It has to become a
four-platform, multi-tenant creator platform running entirely on Cloudflare, without
regressing any of that.

Three constraints make the shape non-obvious. First, the product's premise is inverted:
the research proves the DM is *not* the universal capability — the public comment reply
is. YouTube has no messaging API at all (the `comment` resource exposes no identifier a
message could be routed to), and TikTok prohibits initiating a conversation outside three
APAC countries. So "send a DM" cannot be the trunk. Second, the four platforms have four
genuinely different rate-limit shapes — a constant, a value derived from live Page
engagement, a two-level QPM tier, and a global per-Google-Cloud-project pool shared across
every tenant that sharding is explicitly forbidden to escape. A `RATE_LIMIT_MAX` constant
cannot express them. Third, Cloudflare has no Redis, no queue-level deduplication, no
usable rate-limiting primitive, and no Workers alerting of any kind — so three things the
current system gets for free have to be built, and BullMQ has to be deleted rather than
ported.

Phase A's constraints the design must honor: Instagram must not regress; the live
`@@unique([automationId, commentId])` idempotency contract must survive a migration over
live data; the one-private-reply-per-comment rule is Instagram's, not the product's, and
must not be hoisted into the core; a platform must be able to *decline* a capability
rather than stub it; and the reconciler exists because webhooks are unreliable — but on
YouTube polling is the only path and quota is the binding constraint.

## Usage (caller's view)

### 1. A platform admin enrolls a creator, who connects their own accounts

```ts
// app/api/admin/creators/route.ts
const admin = await requirePlatformAdmin("ADMIN");

await inviteCreator(admin, {
  email: "jules@example.com",
  creatorName: "Jules",
  expectedPlatforms: ["instagram", "youtube"],
});
// Creates the invitation AND queues the email. There is no `inviteUrl` to
// copy-paste, because a route that returns a URL is a route that becomes the
// only thing anyone calls — which is exactly what happened to the existing
// workspace-invite path.
```

Jules clicks the link, signs in with a magic link, and lands in a workspace that already
exists and is already named. She connects accounts herself:

```ts
// app/api/connect/[platform]/route.ts — one route, all platforms
const ws = await requireWorkspace("ADMIN");
const app = await lookupProviderApp(platform, "main");
const url = adapterFor(platform).authorizeUrl(app, redirectUri, createState(ws.workspaceId));
redirect(url);
```

The callback ends in `adapter.connect(...)`, which exchanges the code, resolves the
account identity, subscribes webhooks, and **negotiates capabilities**, all behind one
call. The negotiated set is per-account, not per-platform — two TikTok creators in one
workspace can differ by registration region.

### 2. Building a campaign, and YouTube declining a follow gate

The builder never branches on platform. It renders from the account's capabilities:

```tsx
// components/campaign-builder.tsx
const steps = availableSteps(account.capabilities);
// [ { kind: "publicReply",  available: true,  reason: null },
//   { kind: "directMessage", available: false,
//     reason: "YouTube has no messaging API of any kind. The Data API exposes no
//              identifier a message could be routed to." },
//   { kind: "followGate",   available: false,
//     reason: "YouTube has no messaging API of any kind. ..." }, ... ]
```

Saving runs one pure function, the same one that runs in the browser on every keystroke:

```ts
const result = compile(draft, account.capabilities);
if (!result.ok) return Response.json({ errors: result.errors }, { status: 422 });
//  [{ path: "steps[1]", code: "CAPABILITY_UNAVAILABLE", message: "YouTube ..." },
//   { path: "steps[0].spec.variants[0]", code: "COPY_POLICY_VIOLATION",
//     message: "YouTube Developer Policy §III.F prohibits incentivising comments.
//               'Comment LINK below and I'll send it' cannot run on YouTube." }]
```

And in first-party code — templates, seeds, tests — the step does not merely fail
validation, it cannot be written:

```ts
const yt = builders("youtube");
yt.publicReply({ variants: ["sent it your way, check the pinned comment 👇"] });  // ok
yt.followGate({ promptText: "follow me first", buttonLabel: "i'm following" });
//  ^ TS2339: Property 'followGate' does not exist on type 'StepBuilders<"youtube">'
```

That is not a lint rule or a runtime guard. `StepsAvailableOn<"youtube">` evaluates to the
single literal `"publicReply"`, because `PlatformCeiling["youtube"]` is the single literal
`"PUBLIC_REPLY"` and a follow gate requires three capabilities YouTube does not have.
`youtubeAdapter.plan()` receives `AnyStep<"youtube">`, so its switch has one case and the
compiler proves it exhaustive: there is no DM stub to write and no `default: return` to
forget.

### 3. A comment arrives on Instagram — the whole trace

```
POST /api/ingest/instagram/main                     ← one route file, all platforms
  app     = lookupProviderApp("instagram", "main")  ← ONE bound webhook secret
  adapter.ingest.verifySignature(raw, app)
  events  = adapter.ingest.parse(rawBody, app)      ← pure; wire → domain
  env.RESPONSE_QUEUE.sendBatch(events)
  return 200                                        ← no DB read; Meta's 5s budget

queue("response-queue") → dispatch(ctx, event)
  startRuns(ctx, trigger)      → upsert ResponseRun per matching campaign
  advanceRun(ctx, runId, cause)
    db.leaseRun(runId, token)                       ← Queues is at-least-once
    parseStoredPlan(campaign.compiledPlan, draft, caps)
    for stepIndex from run.cursor:
      executeStep(...)
        dp = adapter.plan(step, runCtx, account)    ← PURE: claims, buckets, cost
        resolveFollowGate(status, contact, canReprompt)   ← PURE, when gated
        claims.acquire(dp.claims, runId)            ← DB unique constraint
        quota.reserve(dp.cost, dp.buckets)          ← Durable Objects
        dp.preflight?.(cred)                        ← FB can_reply_privately
        adapter.deliver(dp, renderContent(...), cred)     ← the only network call
        lease.settle("commit" | "release")
        db.recordOutcome(...)                       ← @@unique([runId, stepIndex])
      step.awaits → parkRun + schedule.advanceAt(runId, now + timeoutMs)
```

The engine contains zero occurrences of `platform ===`. Everything platform-shaped has
already been turned into data by the time it runs.

### 4. The admin overview

```ts
const rows = await accountHealth(await requirePlatformAdmin("SUPPORT"), { worstFirst: true });
// [{ workspaceName: "Jules", platform: "instagram", handle: "@jules", status: "BROKEN",
//    openIncidents: [{ kind: "TOKEN_EXPIRED", count: 412, lastSeenAt: ... }],
//    sent24h: 0, budgets: [{ label: "Instagram hourly private replies", used: 0, ... }] }]
```

The same function serves a creator's own health page — a `WorkspaceScope` sees one
workspace, a `PlatformScope` sees all of them, and `readableWorkspaces(scope)` is the only
place that decides. Same code, so they cannot drift.

### 5. Adding a fifth platform

```ts
// 1. platform/linkedin.ts — the adapter                                    NEW FILE
// 2. platform/capability.ts — one key in PlatformCeiling                    +1 line
// 3. platform/registry.ts — one entry in ADAPTERS                           +1 line
// 4. schema.prisma — one value in enum Platform                             +1 line
```

Not touched: the ingest route, the engine, the quota broker, the scheduler, the campaign
builder UI, the admin overview, or any existing platform's tests.

## Shape

**The core data structure is `ResponseRun`, a resumable state machine — not a log.**
Today's `DmLog` is an outcome ledger; three separate BullMQ job types plus a delayed
read-fallback job orbit it. Promoting it to a state machine with `cursor`,
`awaitingSignals` and `awaitUntil` collapses `process-comment`, `process-postback`,
`process-followup` and the read fallback into one operation, `advanceRun`. The opening-DM
button, the read-receipt grace period and the delayed follow-up stop being three
mechanisms and become one: *steps advance a run; runs park on a signal or a deadline.*
Physically it is the same table, and `@@unique([automationId, commentId])` becomes
`@@unique([campaignId, triggerKey])` over the same index — the live idempotency contract
survives byte-for-byte, per Phase A constraint 2.

**A capability is refused in two places, deliberately different in kind.** At compile time
`StepBuilders<P>` is a mapped type over `StepsAvailableOn<P>`, so a step whose requirements
are not all in the platform's ceiling has no constructor. Steps are branded with a
non-exported `unique symbol`, so the *only* other door in is `parseStoredPlan`, which
re-checks stored JSON against the **account's** negotiated set — because campaigns are
authored in a browser and stored as data, and because a UK TikTok account has strictly
fewer capabilities than the TikTok platform. That is `encode-lessons-in-structure` for the
code path and `boundary-discipline` for the data path, and it is why the brief's test
question — is a YouTube follow gate unconstructable rather than merely rejected? — answers
*unconstructable*, twice.

**The one-private-reply-per-comment rule is generalised as a mechanism, not hoisted as a
policy.** Phase A warns that lifting Instagram's rule into the core will be wrong for
Facebook and YouTube. So the core owns `ExclusiveClaim` — take a key before sending, at
most one holder, ever — and each adapter decides which keys, if any, a step consumes.
Instagram returns `{ scope: "ig:private_reply", key: commentId }`; Facebook returns the
same shape with a 7-day expiry and gets the rule for free; TikTok returns
`tt:comment_dm`; YouTube returns `[]` and never touches the ledger. Enforcement is
`DeliveryClaim @@unique([scope, key])` — a database constraint, so there is no
read-then-write race and it survives a Worker eviction mid-send. Today's `SKIPPED_DEDUP`
becomes the ledger's refusal path, message and all.

The subtlety that makes this correct is `Failure.attempted`. Today's code notes in a
comment that a rejected button template has *already* consumed the comment's one allowed
private reply. So a claim is released only when the adapter classifies the failure as
`attempted: "no"`. `"unknown"` keeps the claim — over-holding costs one send; releasing
wrongly costs a permanently confusing failure the creator cannot fix.

**Four rate-limit shapes are four `Capacity` variants, and the workspace plan cap is a
fifth bucket on the same broker.** `fixed` (Instagram 750/hr), `derived` (Facebook's
`4800 × engaged users`, refreshed by cron, falling back to a floor while stale so the
failure mode is under-granting), `pooled` (YouTube's per-project 10,000 units/day with a
per-tenant fair share enforced in the same single-threaded object as the pool), and
TikTok's two-level shape as a plain two-element array. None is a special case. Folding the
workspace monthly allowance in removes the paired
`reserveWorkspaceDMSend`/`releaseWorkspaceDMReservation` calls scattered through the send
path: one `lease.settle()` in a `finally`. The refusal policy lives on the bucket
(`retryAfter` vs `skip`), so today's requeue-30-minutes-three-times behaviour is derived
from the bucket rather than hardcoded in the limiter.

The fair share is not decoration. YouTube's `comments.insert` costs 50 units, so the
product ceiling is ~200 replies/day *across every customer*, and Developer Policies §III.D
forbids sharding across projects. Without a per-tenant sub-ceiling, whichever campaign
fires first spends the day and everyone else silently gets nothing — a failure a
per-account limiter cannot even represent.

**Trigger discovery is one `SweepSpec` with a `priority`, scheduled by a pure function.**
`computeNextSweep(spec, pressure, now)` interpolates between `baseIntervalMs` and
`maxIntervalMs` from live budget pressure. A `safetyNet` sweep may stop at maximum
pressure; a `primary` sweep never stops, because stopping it would mean YouTube silently
ceases to work. Cron triggers are producers only — Cloudflare's scheduled Workers have no
SLA, no retry policy and no delivery guarantee, and run "on underutilized machines".

**Tenancy narrows rather than rewrites.** `TenantScope` is a two-variant union;
`requireWorkspace()` is what ~30 existing routes already effectively call, so they change
by one import. `requirePlatformAdmin()` returns a scope that has no `workspaceId` and
*cannot be passed* where a workspace is required, so an admin endpoint cannot
accidentally write to a creator's data. `PlatformRole` lives on `User`, orthogonal to
membership, because an admin must not appear in a creator's member list.

**The admin overview is the alerting system.** Cloudflare Notifications has no Workers
alert type at all — the sharpest regression versus Vercel. Since health-across-creators
had to be built anyway, `Incident` becomes both. `@@unique([connectedAccountId, openKey])`
where `openKey` holds the kind while open and NULL when resolved makes `raiseIncident` an
idempotent upsert, so 4,000 consecutive token failures are one row with `count = 4000`.
Every adapter must map its vendor errors into a cross-platform `IncidentKind`, which is
why one view answers for four platforms and why TikTok's shadow-hide and YouTube's
`heldForReview` show up as the same `POLICY_HOLD`.

**Interface depth.** `PlatformAdapter` has seven members plus two optional probes. Behind
them: OAuth dialects and four different token lifetimes, region discovery, webhook
signature schemes and payload shapes, poll cursors and their quirks, addressing, delivery
including Instagram's button-to-text fallback, and the vendor error taxonomy. Nothing on
the surface is a wire type — no `fetch`, no `Response`, no Graph JSON — so `comment_id`,
PSID and `parentId` never appear on the engine's types (`per boundary-discipline`, and
avoiding the information-leakage red flag). The `plan`/`deliver` split is pure-versus-
effectful, not a pipeline: both halves own the same knowledge and sit in one module, so
it is not temporal decomposition. `addressing: unknown` is deliberate — the engine hands
it straight back.

**What the system deliberately does not do.** It does not attempt a DM on YouTube or a
cold DM on TikTok, at any layer. It does not let a campaign outlive a capability change:
a shrunken capability set invalidates the plan, pauses the campaign and raises an
incident. It does not keep quota counters in Postgres. It does not put a `WebhookEvent`
insert on the acknowledgement path — Meta requires 200 within five seconds and
auto-unsubscribes after an hour of failures, so the audit write moves to the consumer.
And it deletes `proxy.ts` rather than renaming it: the Next 16 docs say the `middleware`
convention "is deprecated and has been renamed to `proxy`", `runtime` cannot be set in a
Proxy file at all, and `app/(dashboard)/layout.tsx` already does a real `await auth()`
gate — so deleting removes the OpenNext incompatibility, a duplicated check and a weaker
guard in one move.

### Where every existing Instagram behavior lives now

| Today | New home |
| --- | --- |
| one-private-reply-per-comment `SKIPPED_DEDUP` | `instagramAdapter.plan()` emits an `ig:private_reply` claim; `DeliveryClaim @@unique([scope, key])` enforces it |
| public-reply-first decoupling | compiler hoists claim-free, window-free steps ahead of claim-bearing ones; a non-gating step's failure never aborts the run |
| `publicReplySentAt` idempotency | `StepOutcome @@unique([runId, stepIndex])`; the run-level column becomes a write-only report projection |
| button-template → inline-text fallback | inside `instagramAdapter.deliver()`; never visible to the engine |
| `isTemplateRejection()` regex | `instagramAdapter.classify()` → `Failure.attempted` |
| follow gate fail-closed / fail-open | pure `resolveFollowGate(status, contact, canReprompt)`; `contact` comes from trigger provenance, not from the call site |
| `getUserFollowStatus` | `probeFollowStatus`, an optional adapter member present only on Instagram |
| read-receipt fallback | the opening-DM step's `awaits: { signals: ["postback","read"], timeoutMs: 5min, onTimeout: "continue" }` |
| 750/hr limiter + 3× requeue | one `BucketSpec`, `onRefusal: "retryAfter"`; DO replaces the Redis Lua |
| workspace monthly usage | another bucket on the same broker |
| polling reconciler | `instagramAdapter.sweep` with `priority: "safetyNet"` |
| `pendingNextReel` + cron | `TargetSpec.nextPost` + `adapter.resolveNextPost()` |
| `{username}` / `{link}` | `lib/tracking/message.ts` unchanged, called by `renderContent` |
| keyword matching | `lib/utils/keyword-matcher.ts` unchanged |
| `entry.id` account lookup | `ConnectedAccount.externalId` — the same physical column |

## Synthesis decision

Four candidates on four independent runs (one `fable`, three `opus`). No dropouts. This
document is candidate 3 as the base, with six grafts folded in and three shapes rejected.

**Base: candidate 3.** The orchestrator and an independent cross-judge (different model
family, read-only) scored it 30/30 and 30/30 — with totals agreeing exactly on the other
candidates too (C1 27/27, C2 28/28). It was the only candidate with no soft criterion. What
won it: `claims.ts` states Instagram's one-private-reply-per-comment rule platform-neutrally
("some deliveries consume a scarce, externally owned, one-shot resource identified by a
key") so the core owns the mechanism and each adapter declares which keys it consumes —
Facebook gets the rule free, YouTube returns `[]`, and there is no `if` in the engine. Its
migration is the safest over live data by a wide margin: `@@map` logical renames move zero
rows, the trigger-key format is frozen, and **the legacy worker stays runnable through
deploys 1–2**, which is the only rollback in the arena that works mid-migration.

**Verified rather than assumed.** `tsc --strict` was run over all four sketches by the
orchestrator, not taken from candidate summaries. It changed the outcome: candidate 4's
central idea — making the capability set the type parameter of the *adapter* — does not
compile, because `PlatformAdapter<IgCapability>` cannot live in a homogeneous registry.
Capability belongs on the step, not the provider. That is the single most useful thing the
arena produced, and it is invisible to reading.

**Grafted in:**

| From | What | Why the base needed it |
| --- | --- | --- |
| C1 | `capability-proofs.ts`, adapted to `StepsAvailableOn` / `StepBuilders` | The base *asserted* unconstructability. This makes it a build failure. Verified live by deleting a directive and watching CI break, twice. |
| C1 | `MessagingContact` | The base recorded Facebook's send-time PSID with nowhere to keep it, and had no home for TikTok's `unique_identifier`→`conversation_id` join or per-person window budgets. |
| C2 | Registry-≡-enum and no-platform-names-in-core tests | "Zero `platform ===` in the engine" was a promise. Now it fails the build. |
| C2 | `PlatformGrant` as an audited row | Replaces a bare `User.platformRole` column. For a system holding other people's accounts and reading their DMs, "who could read this creator's inbox last March" must be answerable. |
| C4 | Coarsest-scope broker placement | TikTok's two limit levels now reserve atomically in one Durable Object instead of two-phase across two. |
| C4 | One-writer-per-facet health | Four processes were writing one account row, each knowing a quarter of the truth. Per separate-before-serializing-shared-state, each owns its own facet and the merge happens at the read boundary. |

**Rejected:**

- **C4's adapter-as-type-parameter** — proven not to compose. Good idea, wrong placement.
- **C1's `AccountGate` dedup Durable Object** — three of four candidates put idempotency in
  Postgres instead, and the argument is decisive: the database must still be right after a
  DO is evicted. The base's run self-lease via conditional `UPDATE` is better still, because
  the row already has to be read.
- **C2's and C4's campaign-config migration to JSON** — C2 rewrites every live `commentId`
  value and remaps `DmStatus`; C4 moves 20 columns over five deploys. Against a live
  Instagram deployment and a 142-test contract, logical-renames-only wins on risk.
- **An overrule the orchestrator planned and then withdrew.** The intent was to reject the
  base's stored `compiledPlan` in favour of deriving on every execution, on the theory that a
  stored plan goes stale when a platform changes policy. Re-reading `parseStoredPlan` showed
  it re-validates against the **account's negotiated set** on every read, so the staleness
  cannot occur — the stored plan is validated input, not a cache. Recorded because a
  synthesis that only ratifies the orchestrator's priors is not a synthesis.

**Convergence, shipped as consensus.** All four independently reached: capability-typed
unconstructability; capabilities belonging to a *connection* rather than a platform;
two Workers with Durable Objects isolated so Preview URLs survive; Queues with
`[300, 900, 2700]` backoff; Hyperdrive with `--caching-disabled` because of NextAuth
database sessions; deleting `proxy.ts` rather than renaming it; per-platform webhook routes
with one bound secret each; and the Workers Rate Limiting binding disqualified by its own
documentation.

**Four gaps every candidate missed** — found by the cross-judge, resolved in
[`OPEN-GAPS.md`](./OPEN-GAPS.md): the DM inbox was silently dropped by all
four (now modelled as a `CONVERSATION_HISTORY` capability); no candidate kept `/api/webhook`
alive during the cutover, which over live data is a window of dropped comments on the only
platform currently earning money; TikTok signature verification was hand-waved by all four
on the ingestion path of a launch platform; and prisma#28193 was deferred four times with no
named plan B. A fifth, added by the orchestrator: nobody priced the Cloudflare bill.

## Tradeoffs accepted

- **We accept a TypeScript-only guarantee for unconstructability in exchange for it being
  free at every first-party call site.** Stored campaigns come from a browser, so the real
  gate is `parseStoredPlan`. The type-level gate protects templates, seeds and tests — the
  places where a wrong step would otherwise ship silently.
- **We accept a two-phase, non-atomic reservation across Durable Objects in exchange for
  TikTok's two-level limit not being a special case.** There is no cross-DO transaction.
  Reserving scarcest-first with compensating release means the failure mode under
  contention is a brief over-refusal, never an over-grant.
- **We accept that a crash between `deliver` and `recordOutcome` can duplicate a
  claim-free step (a public reply) in exchange for not running a two-phase commit against
  four vendor APIs.** Claim-bearing steps are protected: the platform refuses the second
  send and `classify` returns `INELIGIBLE`. A duplicate public reply is visible and
  harmless; the alternative is a distributed transaction with no distributed transaction
  manager.
- **We accept denormalized report columns on `ResponseRun` in exchange for `lib/reports/*`
  and the shareable report pages needing no change.** They are documented as write-only
  projections: the idempotency decision reads `StepOutcome` and never them, so there is
  still one source of truth per invariant.
- **We accept `addressing: unknown` on `DeliveryPlan` in exchange for no vendor identifier
  reaching the engine's types.** A generic parameter would let it be typed, at the cost of
  threading it through every engine signature for a value the engine only ever passes back.
- **We accept keeping quota state outside Postgres, with a stale mirror for display, in
  exchange for atomic reservation without a row lock per send.** The mirror is named
  `QuotaSnapshot` and nothing reads it to make a decision.
- **We accept three deploys for the migration in exchange for every step being reversible.**
  Deploy 1 is additive DDL only and the renames are logical (`@@map`), so old code runs
  against the new physical schema and rollback is a redeploy.
- **We accept that the compiler's canonical step ordering can override a creator's chosen
  order** (public reply always before the DM leg), in exchange for the public-reply-first
  decoupling being a structural property rather than a rule someone can break by dragging
  a step.

## Alternatives considered

**A `SendStrategy` interface with per-platform implementations and a `supports(step)`
predicate.** The obvious shape, and the one the current code would grow into. It loses on
interface depth: `supports()` returning false is a *stub*, so every unsupported
combination still needs a code path, a test and a decision about what to log — and the
engine grows an `if (!strategy.supports(step)) continue;` that is one `else` away from
becoming the per-platform branching the brief forbids. It also cannot express per-account
capability variation, which TikTok requires.

**Cloudflare Workflows for the run state machine instead of Queues plus a database row.**
Genuinely attractive: `step.sleep` reaches 365 days, backoff can be a function, and
durable execution would give the state machine for free. It loses on two counts. Per-step
billing since 2026-08-10 makes it roughly 30× the cost of Queues (~$36/mo versus ~$1.20/mo
at a million sends), and instance-id deduplication caps ids at 100 characters matching
`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` — **no colons** — while the frozen `triggerKey` format is
`reveal:<id>` and `dm:<id>`. Encoding around that would mean either breaking the live
idempotency contract or maintaining a second key space.

**A `RateLimiter` interface per platform.** Rejected because it hides the wrong thing:
each platform would own its own accounting, so YouTube's pool — which is shared across
*tenants*, not accounts — has no natural owner, and the fair-share logic would live
somewhere ad hoc. Making capacity a data variant instead means the pooled case is enforced
in the same single-threaded object as the pool itself, which is the only place it can be
correct.

**Keeping BullMQ in a Cloudflare Container.** A long-lived Node process genuinely runs
there for a few dollars a month. It fails the brief: BullMQ still needs Redis, Cloudflare
has none, so it would point at Redis Cloud and not be "entirely on Cloudflare" — and
running Redis inside the container loses the queue on restart, since instances get
replaced and the disk is ephemeral. Kept as a documented escape hatch, not a design.

**One `WebhookEvent`-style ingest for all platforms, branching on the payload's `object`
field.** This is what exists today, and one endpoint *can* receive both `instagram` and
`page`. Rejected because it forces the signature check to try every known secret against
every payload — a posture that gets measurably weaker with each platform added, and one
the research explicitly flags.

## Open questions and risks

- **Prisma 7 on Workers is the thinnest ice in the whole plan.** Nobody owns the
  integration doc — Cloudflare's Prisma page is written against Prisma 6 and Prisma's docs
  never mention Hyperdrive — and prisma/prisma#28193 ("Cloudflare Worker Hangs when
  Reusing Prisma Client with Hyperdrive") has been open and unanswered since 2025-09-30,
  with the reporter also hitting `memory access out of bounds` on a per-request client.
  Should the first PR be a bare Worker load-spike against Hyperdrive + per-request
  `PrismaPg`, before any migration code is written?
- **Does Cloudflare Email Sending actually reach arbitrary recipients after domain
  onboarding?** Three sources say yes, one stale doc says no, the daily quota is
  unpublished, and it is beta on the login path. Is keeping the Resend branch alive behind
  `EMAIL_SERVER` an acceptable permanent hedge, or should transactional mail cut over only
  after a measured week on staging?
- **Should the follow-gate copy default change per platform?** The current default prompt
  text is Instagram-flavoured and mentions starring a GitHub repo. On Facebook the gate is
  unconstructable so the question does not arise, but should the *product* keep a
  hard-coded default at all, or require creators to write it?
- **Is the ~200-replies/day product ceiling on YouTube acceptable for launch, and if not,
  who owns the quota-audit application?** It has no published SLA and YouTube may require
  a working account to exercise the automation themselves. The fair-share design makes the
  ceiling survivable, not larger.
- **Should a platform admin be able to edit a creator's campaign, or only view it?** The
  sketch supports `assumeWorkspace` with an audit log, but the safer default is read-only
  and I would rather the human choose than infer.
- **`Failure.attempted: "unknown"` keeps the claim, which permanently forfeits that
  comment's private reply if the vendor never actually acted.** Is that the right side to
  err on, or should an operator have a "release this claim" affordance in the admin view?
- **Facebook's reel-comment webhook payload is unverified** — `reels` is not in the
  documented `item` enum and no sample exists. The parser logs unknown `item` values, but
  the first Facebook reel campaign should be tested empirically before it is sold.

## Next implementation step

Build `QuotaBucket` as a standalone Durable Object with its four `Capacity` variants and
port `RESERVE_DM_SLOT_SCRIPT`'s semantics into it, with a concurrency test that proves the
fixed and pooled cases never over-grant — it is where correctness lives, Cloudflare gives
none of it for free, and every other piece of the engine depends on its contract.
