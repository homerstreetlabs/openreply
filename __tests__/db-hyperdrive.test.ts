import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Which address the Worker dials.
 *
 * Hyperdrive hands back a local address the Workers socket layer permits. A
 * Worker dialling the origin itself is refused outright when that origin is a
 * private IP, which is what a database behind Azure Private Link is. The client
 * read `DATABASE_URL` directly and never touched the binding, so Hyperdrive was
 * never in the query path. A public database works either way, which is why it
 * went unnoticed until a private one did not.
 */

const { adapterCalls, bindings } = vi.hoisted(() => ({
  adapterCalls: [] as { connectionString: string }[],
  bindings: { current: null as { HYPERDRIVE?: { connectionString: string } } | null },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: { connectionString: string }) {
      adapterCalls.push(config);
    }
  },
}));

vi.mock("@/app/generated/prisma/client", () => ({
  PrismaClient: class {
    async $disconnect() {}
  },
}));

vi.mock("@/lib/cloudflare/bindings", () => ({
  tryBindings: () => bindings.current,
  // No adapter context, so every call builds its own client. Per-request
  // memoization is covered in db-request-scope.test.ts.
  getCloudflareContextOrNull: () => null,
}));

import { getPrisma } from "../lib/db/client";

beforeEach(() => {
  adapterCalls.length = 0;
  bindings.current = null;
  process.env.DATABASE_URL = "postgresql://user:pw@historiandb.postgres.database.azure.com:5432/openreply";
});

describe("choosing the connection", () => {
  it("uses the Hyperdrive binding when one is bound", () => {
    bindings.current = { HYPERDRIVE: { connectionString: "postgresql://local/hyperdrive" } };

    getPrisma();

    expect(adapterCalls[0].connectionString).toBe("postgresql://local/hyperdrive");
  });

  it("never dials the origin when Hyperdrive is available", () => {
    bindings.current = { HYPERDRIVE: { connectionString: "postgresql://local/hyperdrive" } };

    getPrisma();

    expect(adapterCalls[0].connectionString).not.toContain("azure.com");
  });

  /**
   * Migrations, scripts, tests and plain `next dev` have no binding, and they
   * reach a publicly routable address, so the secret is right for them.
   */
  it("falls back to the secret where there is no binding", () => {
    getPrisma();

    expect(adapterCalls[0].connectionString).toContain("azure.com");
  });

  it("fails loudly when there is neither", () => {
    delete process.env.DATABASE_URL;

    expect(() => getPrisma()).toThrow(/DATABASE_URL/);
  });
});
