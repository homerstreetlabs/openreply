# Arena synthesis note

Four candidates, four models, one task. Base picked, grafts folded, result verified.

## Dropouts

None. All four produced a complete package (`rationale.md`, `schema.prisma`, `sketch/`).

## Verification I ran myself (not taken from candidate summaries)

`tsc --noEmit --strict` over each candidate's sketch:

| Candidate | Exit | Errors | Nature |
| --- | --- | --- | --- |
| C1 (fable) | **0** | 0 | clean |
| C2 (opus) | 1 | 12 | **one cause**: a cron string `*/5 * * * *` inside a JSDoc block comment closes it early. One-character fix. |
| C3 (opus) | **0** | 0 | clean |
| C4 (opus) | 1 | 4 | **real design flaw** — see below |

C4's four errors all sit in its central mechanism. Making the capability set the type
parameter of the *adapter* (`PlatformAdapter<IgCapability>`) destroys the common supertype a
registry needs: `{[P in Platform]: PlatformAdapter}` cannot hold them because
`Grants<Subset>` lacks `Grants<All>`'s properties, and `execute.ts` erases it back to
`(platform: string) => PlatformAdapter` at the one place it mattered. C1, C2 and C3 all
parameterize the *steps/plan/builders* instead and keep the adapter interface uniform —
which composes. The fix converges on what the other three already did. **This is the single
most useful thing the arena produced**: a plausible, well-argued design that only reveals
itself as wrong when a compiler looks at it.

## Scores — orchestrator vs. independent cross-judge

Judge ran on a different model family (fable) from the orchestrator (opus), read-only.

| Criterion | C1 | C2 | **C3** | C4 |
| --- | --- | --- | --- | --- |
| R1 capability honesty | 5 / 5 | 5 / 4 | **5 / 5** | 4 / 3 |
| R2 Instagram survives | 5 / 5 | 5 / 4 | **5 / 5** | 4 / 4 |
| R3 quota + scheduling | 4 / 5 | 5 / 5 | **5 / 5** | 5 / 3 |
| R4 Cloudflare honesty | 5 / 5 | 4 / 5 | **5 / 5** | 4 / 4 |
| R5 tenancy | 4 / 3 | 4 / 5 | **5 / 5** | 4 / 4 |
| R6 depth + blast radius | 4 / 4 | 5 / 5 | **5 / 5** | 3 / 3 |
| **Total (mine / judge)** | 27 / 27 | 28 / 28 | **30 / 30** | 24 / 21 |

*(cells are `orchestrator / judge`)*

Totals agree exactly on C1, C2 and C3, and on the base. Only C4 differs (24 vs 21), and in
the same direction. Independent agreement on a graft-heavy call is the strongest signal
available here, so the pick is confirmed rather than merely asserted.

I revised C3 from 27 → 30 mid-read, **before** seeing the judge. My first pass scored it off
its rationale; reading `sketch/runtime/claims.ts` and `sketch/runtime/quota.ts` directly
changed the verdict. Recording that because the correction, not the conclusion, is the
useful part: scoring a design off its own summary is how you pick the best *writer*.

## Base: candidate 3

The only candidate with no soft criterion. Decisive properties:

- **`claims.ts`** states Instagram's one-private-reply-per-comment rule platform-neutrally —
  *"some deliveries consume a scarce, externally owned, one-shot resource identified by a
  key"* — so the core owns the mechanism and the adapter owns which keys a step consumes.
  Facebook gets the rule free; YouTube returns `[]` and never touches the ledger. Enforcement
  is `DeliveryClaim @@unique([scope, key])`: *"the database constraint IS the mutual
  exclusion — no lock, no DO, no race window, and it survives a Worker eviction mid-send."*
- **The `attempted` trichotomy.** A claim is released only when the platform *provably did
  not act*; `"unknown"` keeps it, because a rejected button template has already burned
  Meta's one reply. C3 cites the comment in today's `dm-worker.ts` as evidence. C4 converged
  on the same rule independently.
- **Safest migration by a wide margin.** `@@map` logical renames move zero rows, the trigger
  key format is frozen, legacy postback payloads are accepted for a reasoned 48-hour window,
  the `DeliveryClaim` backfill is written as SQL and marked as the one step that must not be
  skipped, and **the legacy worker stays runnable through deploys 1–2**. No other candidate
  keeps a rollback that works mid-migration.
- **Fair share lives in the same single-threaded DO as the pool** — the only placement where
  the two ledgers cannot disagree. `FairShare.reserve` holds back a fraction because
  *"polling is cheap and constant, sends are 50x"*, a read of YouTube's 1-vs-50 cost
  asymmetry no other candidate noticed.
- **`Incident @@unique([connectedAccountId, openKey])`** makes `raiseIncident` an idempotent
  upsert, which is the answer to Cloudflare having **no Workers alerting at all**: the admin
  overview *is* the alerting system. That also satisfies the user's actual request.
- **`bucketName` deliberately excludes policy from DO identity**, so changing a cap does not
  orphan the counter. Nobody else caught it.

Runner-up C2 is the better writer and would win on prose. It lost on migration risk — a
value-rewriting `UPDATE` of the busiest table's key column plus a status-enum remap, against
a 142-test contract — and on a capability story that is value-level with three throw-stub
`evaluateGate` members where C3's is type-level with none.

## Grafts folded in

| # | From | What | Why |
| --- | --- | --- | --- |
| G0 | C1 | `capability-proofs.ts`, adapted to C3's `StepsAvailableOn` / `StepBuilders` | C3 *asserts* unconstructability; C1 *proves* it with CI-failing negative tests |
| G1 | C1 | `MessagingContact` model | C3 captures FB's send-time PSID but has no entity for it: no window bookkeeping, no TikTok 10-msg budget, no home for the `unique_identifier`→`conversation_id` join |
| G2 | C2 | Two enforcement tests: registry ≡ Prisma enum, and a no-platform-identifier lint over `runtime/`, `campaign/`, `tenancy/` | C3's "zero `platform ===` in the engine" was a promise; now it is a build failure |
| G3 | C2 | `PlatformGrant` as an audited row (issuer, expiry, revocation, support tier excluding message bodies) | replaces C3's bare `User.platformRole` column; composes with C3's existing `AdminAccessLog` |
| G4 | C4 | Coarsest-scope broker placement | TikTok's two levels checked in ONE DO atomically instead of two with compensating release |
| G5 | C4 | One-writer-per-facet health observations | cleaner substrate for C3's rolling counters; removes writer contention on the account row |

**G0 is verified live, not just compiling.** I deleted one `@ts-expect-error` and confirmed
the build breaks with `TS2339: Property 'followGate' does not exist on type
'StepBuilders<"youtube">'`, then restored it. A negative-test suite that passes vacuously is
worse than none.

## Rejected, and why

- **C4's adapter-as-type-parameter** — proven not to compose (above). The idea is good; the
  placement is wrong. Capability belongs on the step, not the provider.
- **C1's `AccountGate` dedup Durable Object** — three of four candidates put idempotency in
  Postgres instead, and C2's argument is decisive: *the database must still be right after a
  DO is evicted*. C3's run self-lease via conditional `UPDATE` is better still — *"the row
  already has to be read, so the lease is free."*
- **C2's and C4's campaign-config migration to JSON** — C2 rewrites every live `commentId`
  value and remaps `DmStatus`; C4 moves 20 columns to `draft Json` over five deploys. Against
  a live Instagram deployment and a 142-test contract, C3's logical-rename-only path wins on
  risk, not elegance.
- **My own planned overrule, withdrawn.** I intended to reject C3's stored `compiledPlan` in
  favour of deriving on every execution, worrying that a stored plan goes stale when a
  platform changes policy. Re-reading `parseStoredPlan` shows it re-checks against the
  **account's negotiated set** on every read, so the staleness I feared cannot occur — the
  stored plan is validated input, not a cache. **The arena corrected me; I dropped the
  overrule.** Recorded because a synthesis that only ratifies the orchestrator's priors is
  not a synthesis.

## Convergence worth noting

All four independently reached: capability-typed unconstructability; capabilities belonging
to a *connection* rather than a platform (TikTok's regional walls force it); two Workers with
DOs isolated so Preview URLs survive; Queues with `[300, 900, 2700]` backoff; Hyperdrive with
`--caching-disabled` because of NextAuth database sessions; **deleting `proxy.ts` rather than
renaming it** (my Next-16-docs correction propagated to every runner); per-platform webhook
routes with one bound secret each; the Workers Rate Limiting binding disqualified by its own
documentation; and zero `platform ===` in the engine.

Per the arena's own guidance, convergence that strong is shipped as consensus rather than
re-litigated.

## What the judge caught that I missed

Four things **all four candidates** got wrong. All are resolved in
`synthesis/OPEN-GAPS-RESOLVED.md`:

1. **The DM inbox silently vanished** from every candidate — a shipping feature with real
   routes and a page. Now modelled as a `CONVERSATION_HISTORY` capability (IG/FB/TikTok yes,
   YouTube no).
2. **No webhook-URL cutover plan.** A Meta callback URL is a single app-global dashboard
   setting; deliveries continue to the old URL until it propagates, and Meta auto-unsubscribes
   after an hour of failures. All four delete `/api/webhook` with no forwarding — a window of
   dropped comments **on the only platform currently earning money.**
3. **TikTok signature verification hand-waved** by all four, on the ingestion path of a launch
   platform. Now a blocking spike with the route disabled by configuration until it resolves.
4. **prisma#28193 deferred four times** with no named plan B. Now a deploy-0 gate with a
   three-option fallback ladder.

I would add a fifth: **nobody priced the Cloudflare bill.**

## Phase F verification

- `tsc --noEmit --strict` over the synthesized sketch: **exit 0**.
- Negative tests proven live by deliberate breakage, then restored.
- `prisma validate` on the synthesized schema: see the graft agent's report.
- Remaining: the design is a sketch. Bodies are `not implemented`. The first implementation
  step is the deploy-0 spike, which gates everything else.
