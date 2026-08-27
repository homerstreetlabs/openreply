import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";

/**
 * One Prisma client per request.
 *
 * The obvious implementation caches the client on `globalThis`, and that is
 * what this file used to do. On Cloudflare Workers it hangs: the first request
 * succeeds and every request after it never returns, with no exception to
 * catch and no stack pointing anywhere near Prisma. Reproduced against
 * workerd on 2026-08-24; see docs/architecture/SPIKE-RESULTS.md and
 * prisma/prisma#28193.
 *
 * A Worker isolate serves many requests, so "module scope" is not "per
 * request" the way it is under `next dev`. `AsyncLocalStorage` gives us the
 * real request boundary, so callers keep one client for the life of a request
 * and never share one across requests.
 *
 * Outside a request scope (scripts, tests, the reconciler loop) there is no
 * boundary to hang state on, so a client is created on demand and the caller
 * owns closing it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { tryBindings } from "@/lib/cloudflare/bindings";

const requestScope = new AsyncLocalStorage<{ client?: PrismaClient }>();

/**
 * Where to connect, and it matters which one wins.
 *
 * Hyperdrive hands back a local address the Workers socket layer permits. A
 * Worker dialling the origin itself is blocked outright when that origin is a
 * private IP, which is what happens behind Azure Private Link: the socket layer
 * refuses with "cannot connect to the specified address" and no amount of
 * tunnel or route configuration changes it.
 *
 * This read the secret directly and never touched the binding, so Hyperdrive
 * was never in the query path at all. That went unnoticed because a publicly
 * reachable database works fine either way, and it only surfaced against a
 * private one.
 *
 * `DATABASE_URL` remains the fallback for everywhere there is no binding:
 * migrations, scripts, tests and plain `next dev`.
 */
function connectionString(): string {
  const hyperdrive = tryBindings()?.HYPERDRIVE?.connectionString;
  if (hyperdrive) return hyperdrive;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is required");
  return url;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });
}

export function getPrisma(): PrismaClient {
  const store = requestScope.getStore();
  if (!store) return createPrismaClient();
  return (store.client ??= createPrismaClient());
}

/**
 * Wrap a request so every `prisma` access inside it shares one client, and the
 * client is disconnected when the request ends. The Worker entrypoint calls
 * this; nothing else needs to know it exists.
 */
export async function withPrismaScope<T>(fn: () => Promise<T>): Promise<T> {
  const store: { client?: PrismaClient } = {};
  try {
    return await requestScope.run(store, fn);
  } finally {
    await store.client?.$disconnect().catch(() => {});
  }
}

export const prisma = new Proxy(
  // SAFETY: the target is never read. Every property access is intercepted by
  // the `get` trap below and served from the per-request client.
  {} as PrismaClient,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getPrisma(), prop, receiver);
    },
  }
);
