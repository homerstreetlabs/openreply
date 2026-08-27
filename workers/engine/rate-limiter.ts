/**
 * AccountRateLimiter — one instance per connected account.
 *
 * A direct port of the Redis Lua `RESERVE_DM_SLOT_SCRIPT` this replaces. The
 * Lua was atomic because `EVAL` is atomic; here the Durable Object's
 * single-threaded execution is what makes read-check-increment indivisible, so
 * the logic is the same shape with the locking removed rather than reproduced.
 *
 * Verified under contention: 40 concurrent reservations against a cap of 10
 * granted exactly 10. See docs/architecture/SPIKE-RESULTS.md.
 */

interface Window {
  windowStart: number;
  count: number;
}

interface Ctx {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
}

const KEY = "window";

export class AccountRateLimiter {
  constructor(private readonly state: Ctx) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname.replace(/^\//, "");
    const max = Number(url.searchParams.get("max") ?? "750");
    const windowSeconds = Number(url.searchParams.get("window") ?? "3600");

    if (op === "reset") {
      await this.state.storage.delete(KEY);
      return json({ allowed: true, count: 0, remaining: max });
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const stored = await this.state.storage.get<Window>(KEY);

    // A window that has rolled over is indistinguishable from no window at all.
    const w: Window =
      stored && now - stored.windowStart < windowMs
        ? stored
        : { windowStart: now, count: 0 };

    if (op === "peek") {
      return json({ allowed: w.count < max, count: w.count, remaining: Math.max(0, max - w.count) });
    }

    if (w.count >= max) {
      return json({ allowed: false, count: w.count, remaining: 0 });
    }

    w.count += 1;
    await this.state.storage.put(KEY, w);
    return json({ allowed: true, count: w.count, remaining: max - w.count });
  }
}

interface LimiterReply {
  allowed: boolean;
  count: number;
  remaining: number;
}

function json(body: LimiterReply): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
