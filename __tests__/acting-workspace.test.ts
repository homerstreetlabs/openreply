import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A platform admin may edit a creator's campaign. What makes that safe is not
 * the permission, which is deliberate, but the record: the grant says who may,
 * and one row per action says who did.
 */

const { mockPrisma, mockGetCurrentWorkspaceId, mockGetCurrentUserId } = vi.hoisted(
  () => ({
    mockPrisma: {
      workspaceMember: { findUnique: vi.fn() },
      platformGrant: { findMany: vi.fn() },
      adminAccessLog: { create: vi.fn() },
    },
    mockGetCurrentWorkspaceId: vi.fn(),
    mockGetCurrentUserId: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: mockGetCurrentWorkspaceId,
  getCurrentUserId: mockGetCurrentUserId,
}));

import { actingWorkspace, PlatformAccessError } from "../lib/tenancy/acting-workspace";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentWorkspaceId.mockResolvedValue("ws_own");
  mockGetCurrentUserId.mockResolvedValue("user_1");
  mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
  mockPrisma.platformGrant.findMany.mockResolvedValue([]);
  mockPrisma.adminAccessLog.create.mockResolvedValue({});
});

describe("acting in your own workspace", () => {
  it("needs no grant and records nothing", async () => {
    const acting = await actingWorkspace(null, "read campaigns");

    expect(acting).toEqual({ kind: "own", workspaceId: "ws_own" });
    expect(mockPrisma.adminAccessLog.create).not.toHaveBeenCalled();
  });

  it("treats naming your own workspace the same as not naming one", async () => {
    const acting = await actingWorkspace("ws_own", "read campaigns");

    expect(acting?.kind).toBe("own");
    expect(mockPrisma.adminAccessLog.create).not.toHaveBeenCalled();
  });

  it("does not audit a member reaching a workspace they belong to", async () => {
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ workspaceId: "ws_other" });

    const acting = await actingWorkspace("ws_other", "read campaigns");

    expect(acting).toEqual({ kind: "own", workspaceId: "ws_other" });
    expect(mockPrisma.adminAccessLog.create).not.toHaveBeenCalled();
  });
});

describe("acting in a creator's workspace", () => {
  it("refuses someone with no grant", async () => {
    await expect(actingWorkspace("ws_other", "create campaign")).rejects.toBeInstanceOf(
      PlatformAccessError
    );
    expect(mockPrisma.adminAccessLog.create).not.toHaveBeenCalled();
  });

  it("refuses a support tier, because reading is not editing", async () => {
    mockPrisma.platformGrant.findMany.mockResolvedValue([
      { id: "grant_1", tier: "SUPPORT_FULL" },
    ]);

    await expect(actingWorkspace("ws_other", "create campaign")).rejects.toBeInstanceOf(
      PlatformAccessError
    );
  });

  it("allows an admin and records the workspace they reached into", async () => {
    mockPrisma.platformGrant.findMany.mockResolvedValue([
      { id: "grant_1", tier: "ADMIN" },
    ]);

    const acting = await actingWorkspace("ws_other", "create campaign");

    expect(acting).toEqual({ kind: "assumed", workspaceId: "ws_other", tier: "ADMIN" });
    const logged = mockPrisma.adminAccessLog.create.mock.calls[0][0];
    expect(logged.data).toMatchObject({
      adminUserId: "user_1",
      workspaceId: "ws_other",
      grantId: "grant_1",
      action: "create campaign",
      tier: "ADMIN",
    });
  });
});
