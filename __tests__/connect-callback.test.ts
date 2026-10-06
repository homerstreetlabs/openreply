import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A creator connected a YouTube channel that was already connected to another
 * workspace. Google consented, the callback answered `connect=ok`, and the
 * upsert refreshed the other workspace's row, so Settings showed nothing and
 * no error. The callback has to refuse the claim and say why.
 */

const { mockPrisma, exchange } = vi.hoisted(() => ({
  mockPrisma: {
    connectedAccount: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  exchange: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/platforms/connect-state", () => ({
  readState: vi.fn(async () => ({ workspaceId: "ws_mine", platform: "YOUTUBE", slug: "main" })),
}));
vi.mock("@/lib/platforms/provider-apps", () => ({
  lookupProviderApp: vi.fn(async () => ({ id: "env:youtube", slug: "main", appId: "a", appSecret: "s" })),
}));
vi.mock("@/lib/platforms/registry", () => ({
  adapterFor: () => ({ oauth: { exchange } }),
}));
vi.mock("@/lib/meta/oauth", () => ({ encryptToken: (value: string) => `enc:${value}` }));

import { GET } from "../app/api/connect/[platform]/callback/route";

function identity(externalId: string) {
  return {
    externalId,
    username: externalId,
    displayName: null,
    accessToken: "token",
    refreshToken: null,
    expiresInSeconds: 3600,
    region: null,
    grantedScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
  };
}

async function callback(): Promise<URL> {
  const request = new NextRequest(
    "https://openreply.test/api/connect/youtube/callback?code=c&state=s"
  );
  const response = await GET(request, { params: Promise.resolve({ platform: "youtube" }) });
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connect callback", () => {
  it("refuses an account another workspace already owns", async () => {
    exchange.mockResolvedValue([identity("UC_taken")]);
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({ workspaceId: "ws_other" });

    const location = await callback();

    expect(location.searchParams.get("connect")).toBe("already_connected");
    expect(location.searchParams.get("platform")).toBe("YOUTUBE");
    expect(mockPrisma.connectedAccount.upsert).not.toHaveBeenCalled();
  });

  it("reconnects an account this workspace already owns", async () => {
    exchange.mockResolvedValue([identity("UC_mine")]);
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({ workspaceId: "ws_mine" });

    const location = await callback();

    expect(location.searchParams.get("connect")).toBe("ok");
    expect(mockPrisma.connectedAccount.upsert).toHaveBeenCalledTimes(1);
  });

  it("stores the free accounts of a grant and reports the taken ones", async () => {
    exchange.mockResolvedValue([identity("page_free"), identity("page_taken")]);
    mockPrisma.connectedAccount.findUnique.mockImplementation(
      async ({ where }: { where: { instagramId: string } }) =>
        where.instagramId === "page_taken" ? { workspaceId: "ws_other" } : null
    );

    const location = await callback();

    expect(location.searchParams.get("connect")).toBe("already_connected");
    expect(location.searchParams.get("count")).toBe("1");
    expect(mockPrisma.connectedAccount.upsert).toHaveBeenCalledTimes(1);
  });
});
