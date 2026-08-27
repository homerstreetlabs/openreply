/**
 * Deploy-0 spike. Answers three questions that gate the whole migration:
 *
 *   1. Does Prisma 7 + @prisma/adapter-pg work on workerd, per-request, under
 *      concurrency? (prisma/prisma#28193 says maybe not.)
 *   2. Does the globally-cached client actually fail, and how?
 *   3. Does a Durable Object reproduce the Redis Lua rate limiter's semantics?
 *
 * Run: wrangler dev, then hit /health, /per-request, /cached, /ratelimit.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export interface Env {
  HYPERDRIVE: { connectionString: string };
  RATE_LIMITER: DurableObjectNamespace;
}

/** The pattern the current repo uses: one client cached on module scope. */
let cachedClient: PrismaClient | null = null;

function makeClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

async function query(prisma: PrismaClient): Promise<number> {
  // A realistic read: the same shape the webhook path runs on every event.
  const rows = await prisma.connectedAccount.findMany({
    select: { id: true, workspaceId: true, instagramId: true },
    take: 5,
  });
  return rows.length;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();

    try {
      switch (url.pathname) {
        // ── 1. Per-request client — the documented fix ──────────────────────
        case "/per-request": {
          const prisma = makeClient(env.HYPERDRIVE.connectionString);
          const n = await query(prisma);
          // Prisma 7 driver adapters own the pool; close it or the isolate
          // leaks connections across requests.
          await prisma.$disconnect();
          return json({ ok: true, mode: "per-request", rows: n, ms: Date.now() - started });
        }

        // ── 2. Globally-cached client — today's pattern ─────────────────────
        case "/cached": {
          if (!cachedClient) cachedClient = makeClient(env.HYPERDRIVE.connectionString);
          const n = await query(cachedClient);
          return json({ ok: true, mode: "cached", rows: n, ms: Date.now() - started });
        }

        // ── 3. Per-request WITHOUT disconnect — the leak case ───────────────
        case "/per-request-noclose": {
          const prisma = makeClient(env.HYPERDRIVE.connectionString);
          const n = await query(prisma);
          return json({ ok: true, mode: "per-request-noclose", rows: n, ms: Date.now() - started });
        }

        // ── 4. Durable Object rate limiter ──────────────────────────────────
        case "/ratelimit": {
          const account = url.searchParams.get("account") ?? "acct_spike";
          const id = env.RATE_LIMITER.idFromName(account);
          const stub = env.RATE_LIMITER.get(id);
          const res = await stub.fetch(
            new Request(`https://do/reserve?max=${url.searchParams.get("max") ?? "750"}`)
          );
          return new Response(await res.text(), {
            status: res.status,
            headers: { "content-type": "application/json" },
          });
        }

        case "/health":
          return json({ ok: true, runtime: "workerd" });

        default:
          return json({ ok: false, error: "unknown path" }, 404);
      }
    } catch (err) {
      return json(
        {
          ok: false,
          path: url.pathname,
          ms: Date.now() - started,
          name: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
        },
        500
      );
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Port of lib/utils/rate-limiter.ts's RESERVE_DM_SLOT_SCRIPT.
 *
 * The Redis Lua was atomic because EVAL is atomic. Here the Durable Object's
 * single-threaded execution provides the same guarantee, which is the whole
 * argument for this replacement. Storage is DO SQLite via the KV-ish API.
 */
export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const max = Number(url.searchParams.get("max") ?? "750");
    const windowMs = 3600_000;
    const now = Date.now();

    // blockConcurrencyWhile is not needed: the DO already serializes fetch().
    const stored = await this.state.storage.get<{ windowStart: number; count: number }>("w");
    let w = stored ?? { windowStart: now, count: 0 };
    if (now - w.windowStart >= windowMs) w = { windowStart: now, count: 0 };

    if (w.count >= max) {
      const retryAfterMs = w.windowStart + windowMs - now;
      return new Response(
        JSON.stringify({ allowed: false, count: w.count, remaining: 0, retryAfterMs }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    w.count += 1;
    await this.state.storage.put("w", w);
    return new Response(
      JSON.stringify({ allowed: true, count: w.count, remaining: max - w.count }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
}
