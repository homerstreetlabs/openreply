/**
 * The one place Cloudflare's runtime is allowed to leak in.
 *
 * Bindings are not environment variables. They are live objects handed to the
 * isolate per request, so they cannot be read at module scope and they do not
 * exist under plain `next dev`. Everything downstream takes a queue or a
 * limiter, never an `Env`.
 *
 * These interfaces are hand-written rather than generated. `wrangler types`
 * emits an env interface referencing `Queue`, `Hyperdrive`, and
 * `DurableObjectNamespace`, which only resolve if `@cloudflare/workers-types` is
 * in scope. Putting that package in scope globally replaces the DOM lib and
 * changes `Response.json()` to return `unknown` across the whole Next.js app.
 * Leaving it out is worse still: `skipLibCheck` hides the unresolved names, so
 * every binding silently becomes `any`. Declaring only the surface actually used
 * keeps the contract real without either cost.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Bindings supplied by a Worker that does not run through OpenNext.
 *
 * The web Worker gets its env from the adapter's context. The engine is a raw
 * wrangler Worker, so its env arrives as a handler argument and there is no
 * ambient context to read. Without this the engine can see no bindings at all,
 * which is how it ended up talking to Postgres directly instead of through
 * Hyperdrive.
 */
const explicitScope = new AsyncLocalStorage<OpenReplyEnv>();

/** Run `fn` with the env a raw Worker handler was given. */
export function withBindings<T>(env: OpenReplyEnv, fn: () => Promise<T>): Promise<T> {
  return explicitScope.run(env, fn);
}

export interface QueueSendOptions {
  /** Cloudflare caps this at 86,400 seconds, exactly 24 hours. */
  delaySeconds?: number;
}

export interface QueueMetrics {
  backlogCount: number;
  backlogBytes: number;
  oldestMessageTimestamp: number | null;
}

export interface QueueBinding<T> {
  send(body: T, options?: QueueSendOptions): Promise<void>;
  sendBatch(messages: Array<{ body: T; delaySeconds?: number }>): Promise<void>;
  metrics(): Promise<QueueMetrics>;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Opaque. The only way to obtain one is `idFromName`, and the only thing that
 * accepts one is `get`, so a caller cannot pass a string where an id belongs.
 */
export type DurableObjectId = { readonly __durableObjectId: unique symbol };

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/**
 * Only the bindings this application reads. Secrets and vars are reached through
 * `process.env`, which the Workers runtime populates.
 */
/**
 * Cloudflare Email Sending, bound with `send_email` in the wrangler config.
 *
 * A Worker cannot reach Cloudflare's SMTP relay: Cloudflare IPs are on the
 * Workers socket layer's disallowed list alongside localhost and private
 * addresses. The SMTP bridge exists for clients that are not Workers.
 */
export interface SendEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

export interface OpenReplyEnv {
  RESPONSE_QUEUE: QueueBinding<unknown>;
  RESPONSE_DLQ: QueueBinding<unknown>;
  RATE_LIMITER: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  HYPERDRIVE?: { connectionString: string };
  EMAIL?: SendEmailBinding;
}

/**
 * Returns null off Cloudflare (plain `next dev`, vitest, scripts) so callers
 * degrade instead of throwing. A missing binding is a real condition in
 * development, not an exception.
 */
export function tryBindings(): OpenReplyEnv | null {
  const explicit = explicitScope.getStore();
  if (explicit) return explicit;

  const context = getCloudflareContextOrNull();
  if (!context) return null;
  // SAFETY: the adapter types `env` as the ambient `CloudflareEnv`, which is
  // empty without generated types. The shape asserted here is the one declared
  // in wrangler.jsonc, and the "every declared cron trigger has a job" and
  // registry gates keep config and code from drifting apart.
  return (context.env ?? null) as OpenReplyEnv | null;
}

function getCloudflareContextOrNull(): { env?: unknown } | null {
  try {
    return getCloudflareContext() ?? null;
  } catch {
    return null;
  }
}

