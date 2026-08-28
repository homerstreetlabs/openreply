import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * How many Prisma clients one request builds.
 *
 * `prisma` is a Proxy that resolves a client on every property access, and in
 * the web Worker nothing calls `withPrismaScope`, so the answer used to be "one
 * per access": `/api/dashboard/stats` opened ~23 clients, pools and sockets for
 * a single request, against a Hyperdrive origin connection limit of 20.
 *
 * The boundary that does exist there is the adapter's per-invocation context,
 * so these tests count constructions per context rather than per access.
 */

const { constructions, context } = vi.hoisted(() => ({
  constructions: { count: 0 },
  context: { current: null as { ctx?: object } | null },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {},
}));

vi.mock("@/app/generated/prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      constructions.count++;
    }
    async $disconnect() {}
  },
}));

vi.mock("@/lib/cloudflare/bindings", () => ({
  tryBindings: () => null,
  getCloudflareContextOrNull: () => context.current,
}));

import { getPrisma, prisma, withPrismaScope } from "../lib/db/client";

/** Stands in for the `ExecutionContext` the runtime allocates per invocation. */
function newRequestContext() {
  return { ctx: {} };
}

beforeEach(() => {
  constructions.count = 0;
  context.current = null;
  process.env.DATABASE_URL = "postgresql://user:pw@example.com:5432/openreply";
});

describe("one client per request", () => {
  it("builds a single client across many accesses in one request", () => {
    context.current = newRequestContext();

    for (let i = 0; i < 23; i++) getPrisma();

    expect(constructions.count).toBe(1);
  });

  it("counts Proxy property reads as accesses, since that is how callers use it", () => {
    context.current = newRequestContext();

    void prisma.workspace;
    void prisma.campaign;
    void prisma.responseRun;
    void prisma.linkClick;

    expect(constructions.count).toBe(1);
  });

  it("does not share a client between two requests", () => {
    context.current = newRequestContext();
    getPrisma();

    context.current = newRequestContext();
    getPrisma();

    expect(constructions.count).toBe(2);
  });

  it("keeps the engine Worker's explicit scope authoritative", async () => {
    // The engine has no adapter context at all, only `withPrismaScope`.
    await withPrismaScope(async () => {
      getPrisma();
      getPrisma();
      getPrisma();
    });

    expect(constructions.count).toBe(1);
  });

  it("prefers the explicit scope when a request context is also present", async () => {
    context.current = newRequestContext();

    await withPrismaScope(async () => {
      getPrisma();
      getPrisma();
    });

    expect(constructions.count).toBe(1);
  });

  /**
   * Scripts, vitest and plain `next dev` have no boundary to key on, so the
   * caller keeps ownership of each client it asks for.
   */
  it("falls back to a client per call with no context", () => {
    getPrisma();
    getPrisma();

    expect(constructions.count).toBe(2);
  });
});
