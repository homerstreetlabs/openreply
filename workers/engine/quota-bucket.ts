/**
 * QuotaBucket, one instance per bucket owner.
 *
 * A Durable Object's single-threaded execution is what makes read-check-increment
 * indivisible here, which is the same guarantee the Redis Lua `EVAL` this
 * replaces was bought for.
 *
 * The pooled case is why the pool and every participant are counted in this one
 * object rather than two. A per-tenant fair share held somewhere else would be a
 * second ledger that can disagree with the pool it divides.
 */

interface Counter {
  windowStart: number;
  used: number;
}

interface Ctx {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  };
}

type Window =
  | { kind: "rolling"; ms: number }
  | { kind: "calendarDay"; resetHourUtc: number };

type Capacity =
  | { kind: "fixed"; units: number }
  | { kind: "derived"; units: number | null; floor: number; staleAfterMs: number; refreshedAt: string | null }
  | { kind: "pooled"; units: number; share: { participantKey: string; floor: number; reserve: number } };

interface BucketSpec {
  scope: { kind: string; id: string };
  meter: string;
  window: Window;
  capacity: Capacity;
  participantId?: string;
}

interface Request_ {
  buckets: BucketSpec[];
  spend: { units: number };
  op: "reserve" | "peek" | "release";
}

const PARTICIPANT_PREFIX = "p:";

export class QuotaBucket {
  constructor(private readonly state: Ctx) {}

  async fetch(request: Request): Promise<Response> {
    // SAFETY: the only caller is `lib/runtime/quota`, which constructs this body
    // from typed specs. This object is not reachable from the public internet;
    // it is addressed by name through a Durable Object binding.
    const body = (await request.json()) as Request_;
    const now = Date.now();

    let allowed = true;
    let used = 0;
    let remaining = Number.POSITIVE_INFINITY;
    let retryAfterMs: number | null = null;

    for (const spec of body.buckets) {
      const key = `${spec.scope.kind}:${spec.scope.id}:${spec.meter}`;
      const counter = await this.read(key, spec.window, now);
      const ceiling = capacityUnits(spec.capacity);

      const participantCeiling =
        spec.capacity.kind === "pooled" && spec.participantId
          ? await this.participantCeiling(spec, now)
          : null;

      const participant =
        spec.capacity.kind === "pooled" && spec.participantId
          ? await this.read(`${PARTICIPANT_PREFIX}${key}:${spec.participantId}`, spec.window, now)
          : null;

      const headroom = ceiling - counter.used;
      const participantHeadroom =
        participantCeiling === null || participant === null
          ? Number.POSITIVE_INFINITY
          : participantCeiling - participant.used;

      used = Math.max(used, counter.used);
      remaining = Math.min(remaining, Math.max(0, Math.min(headroom, participantHeadroom)));

      if (body.op === "peek") continue;

      if (body.op === "release") {
        await this.write(key, { ...counter, used: Math.max(0, counter.used - body.spend.units) });
        if (participant) {
          await this.write(`${PARTICIPANT_PREFIX}${key}:${spec.participantId}`, {
            ...participant,
            used: Math.max(0, participant.used - body.spend.units),
          });
        }
        continue;
      }

      if (headroom < body.spend.units || participantHeadroom < body.spend.units) {
        allowed = false;
        retryAfterMs = windowResetMs(spec.window, counter.windowStart, now);
        break;
      }
    }

    if (body.op === "reserve" && allowed) {
      for (const spec of body.buckets) {
        const key = `${spec.scope.kind}:${spec.scope.id}:${spec.meter}`;
        const counter = await this.read(key, spec.window, now);
        await this.write(key, { ...counter, used: counter.used + body.spend.units });

        if (spec.capacity.kind === "pooled" && spec.participantId) {
          const pkey = `${PARTICIPANT_PREFIX}${key}:${spec.participantId}`;
          const participant = await this.read(pkey, spec.window, now);
          await this.write(pkey, { ...participant, used: participant.used + body.spend.units });
        }
      }
    }

    return Response.json({
      allowed,
      used,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      retryAfterMs,
    });
  }

  private async read(key: string, window: Window, now: number): Promise<Counter> {
    const stored = await this.state.storage.get<Counter>(key);
    if (stored && !windowExpired(window, stored.windowStart, now)) return stored;
    return { windowStart: windowStartFor(window, now), used: 0 };
  }

  private async write(key: string, counter: Counter): Promise<void> {
    await this.state.storage.put(key, counter);
  }

  /**
   * Each participant's slice of a shared pool.
   *
   * The reserve is withheld from the division first, so a participant that only
   * polls keeps a floor of cheap calls even when another has spent most of the
   * pool on replies costing fifty times as much.
   */
  private async participantCeiling(spec: BucketSpec, now: number): Promise<number> {
    if (spec.capacity.kind !== "pooled") return Number.POSITIVE_INFINITY;

    const { units, share } = spec.capacity;
    const key = `${spec.scope.kind}:${spec.scope.id}:${spec.meter}`;
    const all = await this.state.storage.list<Counter>({
      prefix: `${PARTICIPANT_PREFIX}${key}:`,
    });

    const active = [...all.values()].filter(
      (c) => !windowExpired(spec.window, c.windowStart, now)
    ).length;

    const divisible = units * (1 - share.reserve);
    return Math.max(share.floor, Math.floor(divisible / Math.max(1, active)));
  }
}

function capacityUnits(capacity: Capacity): number {
  switch (capacity.kind) {
    case "fixed":
      return capacity.units;
    case "pooled":
      return capacity.units;
    case "derived": {
      // Stale or unmeasured falls back to the floor, so an unmeasured Page is
      // under-granted rather than handed a ceiling we cannot justify.
      if (capacity.units === null || capacity.refreshedAt === null) return capacity.floor;
      const age = Date.now() - Date.parse(capacity.refreshedAt);
      return age > capacity.staleAfterMs ? capacity.floor : capacity.units;
    }
  }
}

function windowStartFor(window: Window, now: number): number {
  if (window.kind === "rolling") return now;
  const date = new Date(now);
  const reset = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    window.resetHourUtc
  );
  return reset <= now ? reset : reset - 86_400_000;
}

function windowExpired(window: Window, windowStart: number, now: number): boolean {
  if (window.kind === "rolling") return now - windowStart >= window.ms;
  return windowStartFor(window, now) !== windowStart;
}

function windowResetMs(window: Window, windowStart: number, now: number): number {
  if (window.kind === "rolling") return Math.max(0, windowStart + window.ms - now);
  return Math.max(0, windowStart + 86_400_000 - now);
}
