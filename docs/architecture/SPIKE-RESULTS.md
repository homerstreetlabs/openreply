# Deploy-0 spike results

Run 2026-08-24 against `workerd` via `wrangler dev --local` (wrangler 4.125.0,
`compatibility_date` 2026-08-04, `nodejs_compat`), Prisma 7.8.0 with
`@prisma/adapter-pg`, a Hyperdrive binding pointed at local Postgres 16, and a
SQLite-backed Durable Object.

This spike gated the entire migration. **All three questions are answered, and one of them
changes code we already have.**

---

## 1. prisma/prisma#28193 is real, and I reproduced it in under a minute

The open, unanswered bug ("Cloudflare Worker Hangs when Reusing Prisma Client with
Hyperdrive") reproduces immediately.

| Pattern | Result |
| --- | --- |
| `/per-request` — new `PrismaClient` per request | ✅ 69 ms |
| `/cached` — client cached at module scope, **1st request** | ✅ 11 ms |
| `/cached` — same client, **2nd request** | ❌ **HANGS** |

The second cached request dies with:

> `The Workers runtime canceled this request because it detected that your Worker's code
> had hung and would never generate a response.`

Not an exception — a hang. There is no error to catch, no stack pointing at Prisma, and
the first request succeeds, so a smoke test passes and the second real user hangs.

### This is not hypothetical for us

`lib/db/client.ts:5-11` caches the client on `globalThis`:

```ts
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createPrismaClient();
  return globalForPrisma.prisma;
}
```

That is exactly the failing pattern. **On Workers, the current file hangs every request
after the first.**

The fix is cheap and was already anticipated in the design: the file exports a `Proxy` that
routes every access through `getPrisma()`, so changing the caching strategy to per-request
touches **zero call sites** across the ~76 files that use `prisma`.

## 2. The per-request client is stable under load

| Test | Result |
| --- | --- |
| 300 sequential requests | **300 ok / 0 fail**, 6 s (~50 req/s locally) |
| 100 concurrent (20 parallel × 5 rounds) | **100 ok / 0 fail** |
| 60 requests **without** `$disconnect()` | 60 ok / 0 fail |
| `memory access out of bounds` (the second symptom in #28193) | **0 occurrences** |
| Runtime hangs | **0 occurrences** |

**Verdict: plan A holds.** Prisma 7 + `@prisma/adapter-pg` + Hyperdrive works on Workers,
provided the client is per-request. The fallback ladder in `OPEN-GAPS.md`
(`@prisma/adapter-neon` → thin driver in the engine Worker → Containers) is **not needed**,
and should stay documented but unbuilt.

Caveat, stated honestly: this ran against `wrangler dev --local`, i.e. real `workerd` with a
local Hyperdrive binding to a local Postgres — not against deployed Hyperdrive with its
connection pooling and 60 s query ceiling. The isolate behaviour that causes the hang is
faithfully reproduced locally (that is the part that matters), but **re-run the load test
against a deployed Worker before cutting production traffic.** Also note `$disconnect()`
appeared unnecessary locally; keep it anyway, since pool ownership against real Hyperdrive
is where it would matter.

## 3. The Durable Object reproduces the Redis Lua limiter exactly

Port of `RESERVE_DM_SLOT_SCRIPT` from `lib/utils/rate-limiter.ts`:

```
cap 5, 8 sequential attempts:
  1..5  {"allowed":true,  "count":n, "remaining":5-n}
  6..8  {"allowed":false, "count":5, "remaining":0, "retryAfterMs":~3599900}
```

Semantics match the current limiter, including the refusal carrying a retry hint.

**The atomicity claim, tested rather than asserted:**

```
cap 10, 40 requests fired in parallel
  → granted: exactly 10
```

Zero over-grants under 4× oversubscription. **The Durable Object's single-threaded
execution genuinely provides the atomicity that `EVAL` was buying**, which was the
load-bearing assumption behind deleting Redis. It holds.

## 4. Incidental confirmations

- **WASM query-compiler sizes match the research exactly**: `query_compiler_fast_bg.postgresql.wasm`
  = **3.5 MB**, `_small_` = **1.8 MB**. The generated client copies the `fast` build by
  default. Against a 10 MB gzip Worker ceiling shared with all of Next.js, set
  `compilerBuild = "small"` and measure with `wrangler deploy --dry-run --outdir`.
- **`nodejs_compat` + Hyperdrive + a SQLite-backed Durable Object coexist** in one Worker
  with no flag conflicts, on `compatibility_date` 2026-08-04.
- **Deprecation caught in passing**: `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`
  now warns and wants `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`. Use the
  new name in any dev script.

## What this changes

1. **`lib/db/client.ts` must become per-request before anything is deployed to Workers.**
   Thanks to the existing `Proxy`, this is a one-file change with no call-site churn — and
   it is worth doing early because it is invisible on Vercel and fatal on Workers.
2. **The Prisma fallback ladder is documented but not needed.** Plan A survives.
3. **Redis deletion is validated.** The DO limiter is not a hopeful equivalent; it is
   exact, including under contention.

## Reproducing

```bash
docker compose up -d
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/openreply" pnpm db:migrate
cd <spike dir>
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://postgres:postgres@localhost:5432/openreply" \
  wrangler dev --port 8799 --local
curl localhost:8799/per-request     # ok
curl localhost:8799/cached          # ok
curl localhost:8799/cached          # HANGS — the bug
curl 'localhost:8799/ratelimit?max=5'
```
