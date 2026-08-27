# Stack

What OpenReply runs on: the application libraries, the two Cloudflare Workers, and the
services between them. For the deploy steps see
[deploy-cloudflare.md](deploy-cloudflare.md). For the full setup including every platform
app, see [setup.md](setup.md).

## Application

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript 5 |
| ORM / DB | Prisma 7 with the `@prisma/adapter-pg` driver, PostgreSQL |
| Cloudflare adapter | `@opennextjs/cloudflare` 1.20.2 |
| Queue | Cloudflare Queues |
| Rate limiting and quota | `AccountRateLimiter` and `QuotaBucket` Durable Objects |
| Auth | Auth.js / NextAuth 5 (email magic links) |
| Email | The Workers `EMAIL` binding, Cloudflare Email Sending. SMTP via Nodemailer only outside a Worker. |
| Validation | Zod 4 |
| Charts | Recharts 3 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 4 |
| Package manager | pnpm 10 (pinned via `packageManager` in `package.json`) |
| Platforms | Instagram and Facebook via the Meta Graph API, YouTube via the Data API v3, TikTok via the Business API |

## Runtime: two Workers, one database

- **Web Worker** (`openreply-web`, config `wrangler.jsonc`). The Next.js app, built with
  `@opennextjs/cloudflare`. Serves the dashboard, the OAuth callbacks, and the incoming
  webhooks, and enqueues a response job for every matched comment. 4.15 MB gzip against
  the 10 MB Workers Paid ceiling, measured with `pnpm exec wrangler deploy --dry-run`.
- **Engine Worker** (`openreply-engine`, config `wrangler.engine.jsonc`, entry
  `workers/engine/index.ts`). Consumes the response queue, runs the cron triggers, and
  exports both Durable Objects. 1.97 MB gzip.
- **PostgreSQL**, reached through Hyperdrive: campaigns, response runs, accounts,
  sessions, tracked links, click events.

The engine is a separate Worker for two reasons. A Worker that exports Durable Objects
gets no Preview URLs. And Prisma's WASM query compiler is about 1.8 MB before any
application code, which the web Worker cannot spare next to all of Next.js.

**Deploy the engine first.** The web Worker's Durable Object bindings reference
`openreply-engine` by `script_name`, so the engine must exist before the web Worker can
deploy.

Both Workers must share the same `DATABASE_URL` and the same `ENCRYPTION_KEY`. The web
Worker stores the encrypted platform token; the engine decrypts it to send. Different
keys mean every send fails to decrypt.

## The platform abstraction

An adapter declares what its platform can do rather than what it is called. The send path
branches on capability, and a platform that lacks one never advertises it, so the step is
unconstructable in the campaign builder rather than a runtime failure.

`lib/platforms/registry.ts` is typed so a value in the Prisma `Platform` enum with no
adapter is a compile error, not a lookup that returns undefined on a live webhook. The set
of poll-only platforms is derived from the registry rather than listed, so adding a fifth
platform cannot leave a stale copy behind in a caller.

Discovery is a union rather than a flag. A webhook platform carries `verifySignature` and
`parseEvents`. A poll-only platform carries neither, and `pollOnlyPlatforms()` is what the
sweep iterates. Messaging is nullable, because YouTube and TikTok genuinely have no
messaging surface and stub methods that throw would be a lie in the type.

## Queue and rate limiting

The queue is `openreply-responses`, with `openreply-responses-dlq` as its dead-letter
queue. A failed send retries after 300, 900, and 2700 seconds, then dead-letters.
Messages can be delayed up to 86,400 seconds, exactly 24 hours, which is exactly what the
longest follow-up needs.

Delivery is at-least-once, so every handler is idempotent. `DeliveryClaim` is an exclusive
ledger with a unique constraint on `(scope, key)`, so one comment produces exactly one
reply because the database refuses the second, not because a read-then-write check
happened to run first. `StepOutcome` records each step of a run for the same reason.

Four rate-limit shapes coexist, which is why there is a quota broker rather than a
constant.

- **Instagram**: per account, a fixed 750 private replies an hour. One
  `AccountRateLimiter` Durable Object per connected account.
- **Facebook**: engagement-derived, at 4800 times the number of engaged users per 24
  hours. The budget is a function of live Page data, so the broker models it as `derived`
  with a floor to fall back to.
- **TikTok**: two-level, 40 QPM per authorised account per endpoint and 600 QPM app-wide
  at the default tier.
- **YouTube**: a single pool of 10,000 units a day per Google Cloud project, shared
  across every creator, with per-call costs that differ by 50 times. Modelled as `pooled`
  with a fair share, so one channel cannot spend the whole product's budget.

The Workers Rate Limiting binding cannot do this job. Its `period` must be 10 or 60
seconds, and it counts per Cloudflare location rather than globally.

## Cron triggers

Five, all on the engine, all thin producers. Cloudflare publishes no SLA for cron and
states scheduled Workers run on underutilized machines, so a missed tick has to self-heal
on the next one rather than lose work it would have done inline.

| Expression | Job |
| --- | --- |
| `*/5 * * * *` | Comment reconciler, then the poll-only sweep |
| `*/15 * * * *` | Quota snapshot, mirroring the Durable Object state for reading |
| `0 5 * * *` | Refresh tokens |
| `0 6 * * *` | Attach the next reel |
| `0 7 * * *` | Snapshot followers |

Every expression in `wrangler.engine.jsonc` must have a matching entry in the engine's
job table. `pnpm verify:migration` gates on it, so a schedule added in one file and not
the other fails the check rather than silently doing nothing.

## Hyperdrive, with caching disabled

Create the Hyperdrive config with `--caching-disabled`. Hyperdrive caches reads for 60
seconds by default and does not invalidate on write. Auth.js keeps sessions in the
database, so with caching on, a session you just signed out of keeps resolving for up to
a minute.

## Plan

Workers Paid, $5/month, is mandatory, not a recommendation. The Free plan caps
subrequests at 50 per invocation, and one webhook delivery fans out to roughly 500.
Free's 3 MB bundle ceiling is also below the web Worker's measured size.

Cloudflare Email Sending, which delivers login and invitation email in the reference
deployment, is in public beta and available on Workers Paid only.

## What it costs

Small, but not zero, and two lines are demand-driven in a way that matters for a
creator platform.

| Item | Price | Notes |
| --- | --- | --- |
| Workers Paid | $5/month | The floor, and mandatory. Free's 50-subrequest cap kills the fleet view's fan-out, and Email Sending and Containers are Paid only. |
| Queues | $0.40 per million operations | Roughly three operations per message, so about $1.20 per million responses sent. |
| Email | 3,000/month included, then $0.35 per 1,000 | Creator invitations are low volume. Magic links scale with logins, not sends. |
| Durable Objects | Billed on duration | The rate limiter and quota objects are short-lived. A long-running container would eat most of the 400,000 GB-s allowance. |
| Hyperdrive | Included on Paid | The database itself is billed by whoever hosts it. |

At a million responses a month the Cloudflare bill is under $10. The database and
the platform APIs are the costs that scale with creators, not this.

**Cloudflare does not publish Email Sending's daily quota.** Its own words: "New
accounts start with a conservative daily quota and scale up over time." A new
account can therefore be closer to the ceiling than it looks, and the ceiling is
on the login path. `pnpm exec wrangler email sending limits` reports the current
figure, and `lib/email/limits.ts` reads the same thing at runtime so the fleet
view can warn before invitations start bouncing.

## Bindings

Bindings are not environment variables, and the difference caused two outages during the
first deploy. A secret applies to a running Worker the moment `wrangler secret put`
finishes. A binding attaches only when the script is uploaded.

| Binding | What it is |
| --- | --- |
| `HYPERDRIVE` | The database. A Worker may not open a socket to a private address, so it dials Hyperdrive and Hyperdrive dials the origin. |
| `EMAIL` | Cloudflare Email Sending. A Worker cannot reach the SMTP relay, because Cloudflare IPs are on the socket layer's disallowed list. |
| `RESPONSE_QUEUE`, `RESPONSE_DLQ` | The response queue and its dead-letter queue. |
| `RATE_LIMITER`, `QUOTA` | The two Durable Objects, defined in the engine and bound across scripts. |

## Environment variables

Names only. Values live in `.env` (gitignored) locally and in Worker secrets in
production, never in the repo. Full descriptions are in
[setup.md](setup.md#environment-variables).

Core: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`EMAIL_SERVER`, `EMAIL_FROM`.

Meta: `META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`.

TikTok: `TIKTOK_WEBHOOK_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.

YouTube: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`.

Polling: `COMMENT_POLL_MAX_PER_SWEEP`, `COMMENT_POLL_LOOKBACK_HOURS`.
