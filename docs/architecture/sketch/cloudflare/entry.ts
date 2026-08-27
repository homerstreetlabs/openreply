/**
 * Cloudflare wiring. Two Workers, named primitives, and an honest list of what
 * Cloudflare does not have.
 *
 * ── Worker 1: `openreply-web` ────────────────────────────────────────────────
 * Next.js 16 via `@opennextjs/cloudflare@1.20.2`. `fetch` only.
 *   - `next` pinned to 16.2.12 — the adapter's peer range is
 *     `>=15.5.21 <16 || >=16.2.11`, and on 16.3.x its Turbopack WASM patcher
 *     silently no-ops (green build, broken deploy).
 *   - `proxy.ts` is DELETED, not renamed. It is Next 16 Node middleware and the
 *     adapter rejects it at build time. Renaming back to `middleware.ts` is
 *     backwards — the Next 16 docs say the middleware convention "is deprecated
 *     and has been renamed to proxy", and `runtime` cannot be set in a Proxy
 *     file at all (it throws). The 43 lines only check that a session COOKIE
 *     exists; `app/(dashboard)/layout.tsx` already does a real `await auth()`
 *     gate. Deleting removes the incompatibility, a duplicated check, and a
 *     weaker guard in one move.
 *   - Exports NO Durable Object classes. A Worker that exports DOs loses
 *     Preview URLs entirely, so the DOs live in Worker 2.
 *
 * ── Worker 2: `openreply-engine` ─────────────────────────────────────────────
 * Plain Worker. `queue()`, `scheduled()`, and the DO classes. Own bundle, own
 * CPU budget, deploys independently, no Preview URL to lose.
 *
 * ── What replaced what ───────────────────────────────────────────────────────
 *   BullMQ queue           -> Cloudflare Queues (`response-queue`)
 *   BullMQ backoff         -> `msg.retry({ delaySeconds })`, exact parity
 *   `removeOnComplete/Fail`-> ack deletes; failures -> `response-dlq`
 *   BullMQ `jobId` dedup   -> NOTHING EXISTS. Queues is at-least-once with no
 *                             deduplication. Replaced by the run's own lease
 *                             plus `StepOutcome`/`DeliveryClaim` constraints.
 *   Redis Lua rate limiter -> `QuotaBucket` Durable Object (SQLite)
 *   Redis heartbeat        -> `queue.metrics().oldestMessageTimestamp`
 *   Redis alerts list      -> `Incident` rows
 *   always-on worker loop  -> Cron Triggers, producer-only
 *   Resend                 -> Cloudflare Email Sending + authenticated SMTP
 *   Neon direct connection -> Neon behind Hyperdrive, CACHING DISABLED
 *
 * ── What Cloudflare does not have, stated plainly ────────────────────────────
 *   - No managed Redis, and none is coming. ioredis cannot create TCP sockets
 *     in global scope; BullMQ parks on `BRPOPLPUSH`, which no Worker may do;
 *     BullMQ imports `node:worker_threads`, a non-functional stub that fails at
 *     bundle time. This is deletion, not porting.
 *   - No queue-level deduplication. Built here.
 *   - No usable rate-limiting primitive. The Rate Limiting binding's `period`
 *     "must be either 10 or 60" seconds, it is "local to the Cloudflare
 *     location", and its own docs say it is "intentionally designed to not be
 *     used as an accurate accounting system". Built here, as a DO.
 *   - No Workers alert type in Cloudflare Notifications. AT ALL — no alerting
 *     on error rate, queue backlog or failed cron. Built here, as `Incident`
 *     plus a Tail Worker to Logpush.
 *   - No delivery guarantee, retry policy or SLA for Cron Triggers; scheduled
 *     Workers "run on underutilized machines". Crons are producers only.
 *   - `delaySeconds` caps at 86,400 — exactly 24h, exactly our maximum
 *     follow-up delay, with zero headroom. Chained hops in `schedule.ts`.
 *   - No published build IP ranges, so if Postgres is IP-allowlisted,
 *     `prisma migrate deploy` moves to GitHub Actions.
 *   - D1 is not an option: `@prisma/adapter-d1` silently drops ACID by its own
 *     source, SQLite does not enforce our 6 enums, and we have two `String[]`
 *     columns and a `@db.Date`.
 */

// ─── Bindings ────────────────────────────────────────────────────────────────

export interface Env {
  /** Neon via Hyperdrive. Created with `--caching-disabled`. */
  readonly HYPERDRIVE: { readonly connectionString: string };

  /** The send path. Consumer on `openreply-engine`. */
  readonly RESPONSE_QUEUE: QueueBinding;
  /** Poll sweeps, separate so a viral post's sends cannot starve discovery. */
  readonly DISCOVERY_QUEUE: QueueBinding;
  /** Creator invitations and notifications, rate-shaped by the consumer. */
  readonly EMAIL_QUEUE: QueueBinding;

  /** `QuotaBucket` namespace. Addressed by `idFromName(bucketName(spec))`. */
  readonly QUOTA: DurableObjectNamespaceLike;

  /** Cloudflare Email Sending (public beta, Paid only). */
  readonly EMAIL: { send(msg: unknown): Promise<{ messageId: string }> };

  // Secrets reach `process.env` unchanged thanks to
  // `nodejs_compat_populate_process_env`, which is what makes most of the
  // existing code move without edits. Only non-string bindings need `env`.
  readonly ENCRYPTION_KEY: string;
  readonly NEXTAUTH_SECRET: string;
}

export interface QueueBinding {
  send(body: unknown, opts?: { readonly delaySeconds?: number }): Promise<void>;
  sendBatch(msgs: readonly { readonly body: unknown; readonly delaySeconds?: number }[]): Promise<void>;
  metrics(): Promise<{
    readonly backlogCount: number;
    readonly backlogBytes: number;
    readonly oldestMessageTimestamp: number | null;
  }>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

// ─── Ingest route (lives in the WEB worker) ──────────────────────────────────

/**
 * `app/api/ingest/[platform]/[slug]/route.ts` — ONE file, all platforms.
 *
 * Meta requires a 200 within FIVE SECONDS and auto-unsubscribes the app after
 * one hour of failures. Today's route does a `WebhookEvent` insert, an account
 * lookup per event and a queue add, all before responding. Here the path is
 * exactly: verify -> parse -> enqueue -> 200. No database read at all.
 *
 * The audit row moves into the consumer, where it belongs — it is a
 * troubleshooting artefact, not something the acknowledgement depends on.
 */
export async function POST(
  request: Request,
  ctx: { readonly params: Promise<{ platform: string; slug: string }> }
): Promise<Response> {
  // TODO:
  //   const { platform, slug } = await ctx.params
  //   const app = await lookupProviderApp(platform, slug)      // ONE app
  //   if (!app) return 404
  //   const raw = { rawBody: await request.text(), headers, query }
  //   const adapter = adapterFor(app.platform)
  //   if (!adapter.ingest) return 404                          // YouTube
  //   if (!adapter.ingest.verifySignature(raw, app)) return 401
  //   const events = adapter.ingest.parse(raw.rawBody, app)    // pure
  //   await env.RESPONSE_QUEUE.sendBatch(events.map(body => ({ body })))
  //   return new Response(null, { status: 200 })
  throw new Error("not implemented");
}

/** `hub.challenge` handshake. Same one file. */
export async function GET(): Promise<Response> {
  throw new Error("not implemented");
}

// ─── Engine worker entrypoint ────────────────────────────────────────────────

/**
 * `openreply-engine/src/index.ts`.
 *
 * Crons, all producers:
 *   `* * * * *`     planSweeps           enqueue due accounts
 *   every 5 min     reapExpiredAwaits    safety net for lost delayed messages
 *   `0 3 * * *`     refreshCredentials   per-platform; Facebook returns notNeeded
 *   `0 3 * * *`     refreshDerivedQuota  Facebook's 4800 x engaged users
 *   `0 4 * * *`     snapshotFollowers    unchanged
 *   `0 5 * * *`     resolveNextPost      today's attach-next-reel, generalised
 *   every 5 min     pollQueueHealth      the alerting Cloudflare does not have
 */
export interface EngineWorker {
  queue(batch: MessageBatchLike, env: Env, ctx: ExecutionContextLike): Promise<void>;
  scheduled(controller: { readonly cron: string }, env: Env, ctx: ExecutionContextLike): Promise<void>;
}

export interface MessageBatchLike {
  readonly queue: string;
  readonly messages: readonly {
    readonly body: unknown;
    readonly attempts: number;
    ack(): void;
    retry(opts?: { readonly delaySeconds?: number }): void;
  }[];
}

export interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

/**
 * The consumer. `msg.retry({ delaySeconds: BACKOFF_SECONDS[msg.attempts - 1] })`
 * reproduces BullMQ's `[5m, 15m, 45m]` exactly; `max_retries` and
 * `dead_letter_queue: response-dlq` are wrangler config, not code.
 *
 * Messages are acked individually, not per batch, so one poisoned message
 * cannot re-run the other 99.
 */
export async function handleQueue(
  batch: MessageBatchLike,
  env: Env,
  ctx: ExecutionContextLike
): Promise<void> {
  throw new Error("not implemented");
}

// ─── Prisma on Workers ───────────────────────────────────────────────────────

/**
 * The current `lib/db/client.ts` caches `PrismaClient` on `globalThis`, which
 * on Workers throws "Cannot perform I/O on behalf of a different request".
 *
 * The fix is a per-request client — and because the existing module already
 * exports a `Proxy` wrapper rather than the client itself, ZERO call sites
 * change. That is the single cheapest part of this migration and it is worth
 * not squandering: keep the Proxy.
 *
 * `@prisma/adapter-pg` (not `adapter-pg-worker`, which is frozen at 6.9.0 and
 * dead) over `env.HYPERDRIVE.connectionString`. Set
 * `compilerBuild = "small"` — the WASM query compiler is ~3.6 MB raw against a
 * 10 MB gzip ceiling SHARED with all of Next.js.
 *
 * RISK, flagged: prisma/prisma#28193, "Cloudflare Worker Hangs when Reusing
 * Prisma Client with Hyperdrive", filed 2025-09-30 and still unanswered, with
 * the reporter also hitting `memory access out of bounds` on a per-request
 * client. Unconfirmed on 7.x. Spike this before anything else is built.
 *
 * Transactions: Hyperdrive pools in transaction mode and Cloudflare advises
 * against interactive `$transaction(async tx => ...)`. The two interactive ones
 * in `lib/billing/usage.ts` disappear anyway — the workspace allowance becomes
 * a quota bucket in a Durable Object, which is a better fit than a Postgres
 * transaction was.
 */
export function prismaForRequest(env: Env): unknown {
  throw new Error("not implemented");
}
