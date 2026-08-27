# Research: Cloudflare hosting — verified against official docs 2026-08-24

**Verdict: achievable, but a re-platform, not a redeploy.** Redis has NO Cloudflare
equivalent and must be deleted rather than ported.

## 1. Next.js 16 → `@opennextjs/cloudflare` on Workers

- `@cloudflare/next-on-pages` is **deprecated, repo archived 2025-09-29**. Cloudflare
  Pages is soft-deprecated ("If you are starting a new project, use Workers").
- `@opennextjs/cloudflare@1.20.2` peer range: `next >=15.5.21 <16 || >=16.2.11`.

**BLOCKER 1: repo is on `next@16.2.6` — outside the peer range.** Bump to **16.2.12**
(our `^16.2.6` already permits it). Do **not** go to 16.3.x: the adapter's Turbopack WASM
patcher silently no-ops there (green build, broken deploy). 16.2.11 also carries the
July 2026 security release including a Turbopack+App-Router middleware bypass.

**BLOCKER 2: `proxy.ts` is Next 16 Node middleware; the adapter rejects it at build
time.** Fix is cheap — our `proxy.ts` only reads cookies and redirects, so rename to
`middleware.ts` and export `middleware()`. Behaviour-identical.

| Feature | Status |
| --- | --- |
| `runtime = 'edge'` | ❌ builds fine, **silent 500 at runtime**. We use `"nodejs"` — correct. |
| `maxDuration` | ⚪ **no-op**. Our `overview/route.ts:19` export is inert. |
| PPR / `cacheComponents` | 🔴 docs claim support, issue tracker disagrees. Don't enable. |
| ISR | 🟢 but needs R2 cache + DO queue. **Low risk — our routes are `force-dynamic`.** |
| React Compiler | 🟢 irrelevant — build-time Babel transform, adapter consumes output. |
| Turbopack builds | 🟢 since adapter 1.12.0 |

**`node:crypto` is fully supported.** For `compatibility_date >= 2026-08-04`,
`nodejs_compat` is on by default. `createHmac` ✅ `createCipheriv` (aes-256-gcm) ✅
`timingSafeEqual` ✅ `randomBytes` ✅ — **every call in `lib/meta/oauth.ts` and
`lib/meta/webhook.ts` works unchanged**, including the bare `from "crypto"` import.

**Limits (Paid):** CPU 30 s default / 5 min max; wall clock **unlimited** while client
connected; **subrequests 10,000 Paid vs 50 Free**; simultaneous open connections **6**.
- Our ~500-call fan-out route: fine on Paid, **impossible on Free**.
- The **6-connection cap** is the real throttle. Our route already uses bounded
  concurrency, so it degrades gracefully.
- Bundle: 10 MB gzip Paid / 3 MB Free.

**Adapter health, stated plainly:** 1 commit in 30 days vs 163 open issues. Cloudflare's
`create-cloudflare` now defaults to **vinext** (Vite-based), but vinext is
`1.0.0-beta.8` and its own README says *"If you need a mature, well-tested way to run
Next.js outside Vercel, OpenNext is the safer choice."* Stay on OpenNext.

## 2. Postgres + Prisma — keep Postgres, add Hyperdrive

**Hyperdrive is GA**, works with Neon. `env.HYPERDRIVE.connectionString` + existing
`@prisma/adapter-pg`. Prisma 7.9.1 is current; `@prisma/adapter-pg-worker` is frozen at
6.9.0 — dead.

**Nobody owns this integration doc.** Cloudflare's Prisma page is written against
Prisma 6 (`prisma-client-js`, `previewFeatures: ["driverAdapters"]`, `node_compat`) —
all four wrong for Prisma 7. Prisma's docs never mention Hyperdrive once.

**Two things that will bite:**

- **(a) Hyperdrive caches reads by default** (`max_age` 60 s) and **does not invalidate
  on write**. Cloudflare names *"authentication, sessions, billing state"* as needing
  caching off. We use **NextAuth database sessions** — stale reads after logout are a
  security problem. **Create the config with `--caching-disabled`.**
- **(b) `lib/db/client.ts` caches `PrismaClient` on `globalThis`; that fails on
  Workers** (`Cannot perform I/O on behalf of a different request`). Fix: per-request
  client. **Our existing `Proxy` wrapper means zero call sites change.**

**WASM query compiler size:** `query_compiler_fast_bg.postgresql.wasm` ≈ 3.6 MB raw,
`_small_` ≈ 1.85 MB, against a 10 MB gzip ceiling shared with all of Next.js. Set
`compilerBuild = "small"`, measure with `wrangler deploy --dry-run --outdir`.
**Workers Free is off the table.**

**Open unresolved bug: prisma/prisma#28193 "Cloudflare Worker Hangs when Reusing Prisma
Client with Hyperdrive"** — filed 2025-09-30, still unanswered; reporter also hit
`memory access out of bounds` with a per-request client. Unconfirmed on 7.x.
**Spike this before anything else.**

**Transactions:** Hyperdrive pools in transaction mode. Interactive
`$transaction(async tx => …)` works but Cloudflare advises against it. We have **two**
(`lib/billing/usage.ts:35` and `:51`) plus three array-form. Prefer array form.

**D1 is not an option.** `@prisma/adapter-d1` **silently drops ACID** (its own source:
*"implicit & explicit transactions will be ignored… which breaks the guarantees of the
ACID properties"*). Our schema has 6 enums (unenforced TEXT on SQLite), **2 `String[]`
fields** (Postgres-only), and a `@db.Date`. 10 GB hard cap.

**`prisma migrate deploy` in Workers Builds: yes** — the build image is Ubuntu 24.04 with
normal TCP. Put it in the *Build command* with a direct `postgres://` URL (never the
Hyperdrive string), guarded on `WORKERS_CI_BRANCH` (the `VERCEL_ENV` analogue).
⚠️ Cloudflare publishes **no build IP ranges** — if Postgres is IP-allowlisted, run
migrations from GitHub Actions instead.

## 3. Replacing BullMQ/Redis — deletion, not porting

**There is no managed Redis on Cloudflare.** Hyperdrive is Postgres/MySQL only.

**ioredis and BullMQ cannot run on Workers — structural, not a gap that closes:**
1. *"TCP sockets cannot be created in global scope and shared across requests."*
2. BullMQ's worker parks on `BRPOPLPUSH`; no Worker can block indefinitely (15 min cap).
3. BullMQ imports `node:worker_threads` — a non-functional stub. Fails at bundle time.

| BullMQ capability | Cloudflare replacement | Verdict |
| --- | --- | --- |
| Send queue, concurrency 5 | **Queues** (GA), `max_concurrency` to 250 | ✅ direct |
| Backoff 5/15/45 min | `msg.retry({ delaySeconds: [300,900,2700][attempts-1] })`, `max_retries` to 100, `dead_letter_queue` | ✅ exact |
| **Delay up to 24 h** | **`delaySeconds` max 86,400 = exactly 24 h** | ✅ **fits with ZERO headroom** (our `followUpDelayMinutes` maxes at 1440 = 24 h) |
| `removeOnComplete/Fail` | Queues deletes on ack; failures → DLQ | ✅ obviated |
| **Deterministic job-id dedup** | **Queues has NONE.** At-least-once delivery | ❌ **must build (DO)** |
| Per-account 750/hr limiter | **Durable Object + SQLite** | ⚠️ must build |
| `getJobCounts` health | `env.QUEUE.metrics()` → `{backlogCount, backlogBytes, oldestMessageTimestamp}` | ⚠️ partial — backlog depth, not per-state counts. Map "failed" → DLQ `metrics()` |
| Always-on worker + 5-min poll | Cron Trigger `*/5 * * * *` | ✅ |
| Worker heartbeat | `oldestMessageTimestamp` is a better signal | ✅ |

**Queues limits:** 128 KB/message, 100/batch, 5,000 msg/s, consumer wall 15 min.
Pricing $0.40/M ops (~$1.20 per million jobs).

**Dedup replacement — Durable Object addressed by name.** `env.DEDUP.idFromName(jobId)`;
DO is single-threaded and strongly consistent, so concurrent enqueues for the same id
serialize. **KV is wrong** — writes take *"up to 60 seconds"* to propagate, last-write-
wins, no CAS; a duplicate enqueue from another colo slips straight through.
(Workflows instance-id dedup also works but ids are ≤100 chars, `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`
— **no colons**, and our payloads use `reveal:<id>`.)

**Rate limiter — only Durable Objects are correct.** The Workers Rate Limiting binding
is **disqualified by its own docs**: `period` *"Must be either 10 or 60"* seconds (cannot
express 750/hour), *"local to the Cloudflare location"* (750 × 300 PoPs), and
*"intentionally designed to not be used as an accurate accounting system."*
Our `RESERVE_DM_SLOT_SCRIPT` Lua ports near line-for-line — **the DO's single-threaded
execution IS the atomicity `EVAL` was buying.**

**Cron Triggers:** `*/5 * * * *` fine (1 min is the floor). 5 crons Free / 250 Paid.
CPU 30 s for intervals < 1 h, 15 min for ≥ 1 h. ⚠️ **No SLA, no retry policy, no delivery
guarantee**; scheduled Workers *"run on underutilized machines."* Make `scheduled()` a
thin producer that enqueues, never a worker that does the job inline.

**Containers are GA (Paid only)** and a long-lived Node process *can* run there
(~$2–5/mo for `lite` + `renewActivityTimeout()`). **But it fails the brief** — BullMQ
still needs Redis, which Cloudflare doesn't have, so you'd point at Redis Cloud and not
be "entirely on Cloudflare." Running Redis *inside* the container loses the queue on
restart (ephemeral disk, instances get replaced). Keep as an escape hatch only.

**Workflows:** `step.sleep` to 365 days, function-valued backoff — genuinely nice, but
per-step billing since 2026-08-10 makes it **~30× Queues' per-job cost** ($36/mo vs
$1.20/mo at 1M DMs). Use Queues for the send path.

## 4. Transactional email — Cloudflare Email Sending

**Status: PUBLIC BETA, Workers Paid only.** No GA as of today. Wrangler prints
`[open beta]`.

**Can it send to arbitrary external recipients? Yes — conditionally.**
From the Limits page: *"Before you onboard a sending domain, you can send emails only to
verified destination addresses… **After you onboard a sending domain, you can send to any
recipient immediately.**"* It's account/domain state, not binding config.
⚠️ **Doc contradiction flagged:** the send-bindings page still carries stale
Email-Routing wording contradicting this. Three sources to one. **Verify empirically.**

```ts
const { messageId } = await env.EMAIL.send({ to, from: { email, name }, subject, html, text, replyTo });
```
REST field-name drift: `from.address` (not `email`), `reply_to` (not `replyTo`).

**DNS: Cloudflare DNS is mandatory.** `wrangler email sending enable <domain>` creates
records on a `cf-bounce` subdomain plus `_dmarc` **at the root**.
✅ No conflict with an existing inbound provider — no root MX changes needed.
⚠️ Cloudflare writes `_dmarc = v=DMARC1; p=reject;`. Review an existing `p=none` first.

**Pricing:** Free = **not available**. Paid = 3,000/mo included, then $0.35/1,000.
⚠️ **Daily quota and rate limit are unpublished** — *"New accounts start with a
conservative daily quota."* Cannot capacity-plan from docs.

**Auth.js: there is no Cloudflare provider** (verified against `@auth/core@0.41.2`).

> ⭐ **Option A — one env var, zero code change.** Cloudflare added authenticated SMTP in
> June 2026, and `lib/auth.ts` **already branches to Nodemailer when `EMAIL_SERVER` is
> set**:
> ```
> EMAIL_SERVER="smtps://api_token:<CF_API_TOKEN>@smtp.mx.cloudflare.net:465"
> ```
> Port 465 implicit TLS only; username is the literal string `api_token`. **Works from
> Vercel today** — decouples the email decision from the platform migration entirely, and
> Resend stays one env var away as rollback.

Option B: custom `sendVerificationRequest` over REST. Option C: the `EMAIL` binding via
`getCloudflareContext()` once on Workers.

**Risks:** beta on the **login path**; shared IP pool with no dedicated IPs (worst case
for Gmail/Outlook first-contact on a new domain); bounce events go to a **Queue, not an
HTTP webhook**. One spam complaint auto-suppresses that address account-wide —
**handle `E_RECIPIENT_SUPPRESSED` at sign-in or you have a silent permanent lockout.**

## 5. Secrets, cron, observability

**Use Worker secrets, not Secrets Store** (which is open beta, async `.get()`, and does
*not* land on `process.env`). Limits: 128 vars Paid, 5 KB each — our 13 vars are fine.

**`process.env.FOO` works for secrets** (`nodejs_compat_populate_process_env`, default
since 2025-04-01). **This is what makes the migration cheap** — most `process.env.*`
reads stand unchanged. Only non-string bindings (Hyperdrive, Queue, DO, Email) need
`getCloudflareContext().env`.
⚠️ Deploy with `--keep-vars` or dashboard-set runtime vars get wiped.
⚠️ **Build-time vs runtime split**: anything needed in both (e.g. `DATABASE_URL` for
`prisma generate` *and* for requests) must be set **twice**.

**Adding `scheduled`/`queue` handlers** requires a custom entrypoint, since the generated
Worker exports only `fetch`:
```ts
import { default as handler } from "./.open-next/worker.js";
export default {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx) { /* … */ },
  async queue(batch, env, ctx) { /* … */ },
} satisfies ExportedHandler<CloudflareEnv>;
```
Neat trick: have `scheduled` call `handler.fetch(new Request("https://internal/api/cron/…"))`
so our three existing cron route handlers stay ordinary Next.js code.
⚠️ **If the Worker exports Durable Objects, Preview URLs stop working entirely.**
→ strong argument for putting DOs in a **separate Worker**.

**Observability:** Workers Logs GA (7-day retention Paid). Traces open beta — note
`observability.enabled` does **not** enable traces; set `observability.traces.enabled`.
Logpush is Paid (not Enterprise-only); `workers_trace_events` carries `Outcome`.
⚠️ **Cloudflare Notifications has NO Workers alert type at all** — no alerting on Worker
error rate, queue backlog, or failed cron. Must be built (Sentry / Logpush / Tail Worker).
This is the sharpest regression vs Vercel.

**Workers Builds:** 20-minute hard build ceiling (vs Vercel's 45). **No previews at all
for Workers with Durable Objects or Containers.**

## 6. Recommended shape: TWO Workers

1. **`openreply-web`** — Next.js via `@opennextjs/cloudflare`. Fetch handler only.
   **No DOs exported** (preserves Preview URLs). Bindings: Hyperdrive (caching disabled),
   `DM_QUEUE` producer, DO namespaces, `EMAIL`.
2. **`openreply-worker`** — plain Worker with `queue()` consumer, `scheduled()`
   (`*/5 * * * *` reconciler + 3 daily crons), and the **DO classes**
   (`AccountRateLimiter` keyed by account id, `JobDedup` keyed by the existing
   deterministic job id). Own bundle, own CPU budget, deploys independently.

### Top 3 risks
1. **Prisma 7 on Workers is the thinnest ice.** No owned integration doc; WASM compiler
   size against a shared ceiling; **open unanswered bug #28193**. *Spike a bare Worker
   with per-request `PrismaPg` + Hyperdrive under load before writing any migration code.*
2. **Rate limiter and dedup are where correctness lives, and Cloudflare gives neither for
   free.** Both become DOs we write. Queues is at-least-once, so the DO must be the
   arbiter, not the queue. *Port `reserveDMSlot` to a DO first, test under concurrency.*
3. **Silent failures in beta components on paths we won't notice.** Email beta on the
   login path; adapter at 1 commit/30 days vs 163 open issues with bugs CI provably cannot
   catch; **no Workers alerting at all**. *Keep the Resend branch alive; pin next to
   16.2.x; stand up Sentry/Logpush in the same PR as the first Workers deploy.*

**Workers Paid ($5/mo min) is non-negotiable** — Free's 50-subrequest cap kills the
fan-out route, Containers and Email Sending are Paid-only, and 3 MB won't hold Next.js
plus Prisma's WASM.

---

## CORRECTION to §1, Blocker 2 — verified against the bundled Next 16 docs

The research recommended *"rename `proxy.ts` back to `middleware.ts` and export
`middleware()`"*, citing the Next upgrade guide. **That advice is backwards.**
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
states the opposite, verbatim:

> **Note**: The `middleware` file convention is **deprecated and has been renamed to
> `proxy`**.

Next 16 ships a codemod that goes `middleware.ts` → `proxy.ts`
(`npx @next/codemod@canary middleware-to-proxy .`). There is no `middleware.md` in the
Next 16 docs at all. The migration direction is the reverse of what was suggested.

Worse, the escape hatch the advice depended on does not exist (proxy.md:219):

> Proxy defaults to using the **Node.js runtime**. The `runtime` config option is **not
> available in Proxy files. Setting the `runtime` config option in Proxy will throw an
> error.**

So in Next 16 you **cannot** ask for an edge-runtime proxy. Reverting to the deprecated
`middleware.ts` to obtain the edge runtime is, at best, relying on a deprecated
convention the framework is actively removing.

### The actual fix: delete `proxy.ts` entirely.

`proxy.ts` is 43 lines that check for the *presence* of a session cookie and redirect.
It is already redundant — `app/(dashboard)/layout.tsx:12` does the real gate:

```ts
const session = await auth();
if (!session?.user?.id) redirect("/login");
```

That is a genuine session validation; the proxy only checks that a cookie *exists*,
which is weaker. The single behaviour the layout does not cover is the reverse redirect
(`/login` → `/dashboard` when already authenticated), which belongs in the login page
anyway.

**Deleting `proxy.ts` removes the adapter incompatibility outright** instead of trading
it for a deprecated convention, removes a duplicated auth check, and slightly tightens
security. This is the recommended resolution and it should be reflected in the design.
