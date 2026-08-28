import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    connectedAccount: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { canConnectAccount } from "../lib/accounts/directory";
import { invitationUrl } from "../lib/invitations";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agency workspace helpers", () => {
  it("allows reconnecting an account already owned by the workspace", async () => {
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_123",
    });

    await expect(
      canConnectAccount({
        workspaceId: "workspace_123",
        externalId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  it("blocks accounts already connected to another workspace", async () => {
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_other",
    });

    await expect(
      canConnectAccount({
        workspaceId: "workspace_123",
        externalId: "ig_123",
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "already_connected",
    });
  });

  it("allows connecting additional accounts with no plan limit", async () => {
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null);

    await expect(
      canConnectAccount({
        workspaceId: "workspace_123",
        externalId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  /** Each kind lands on the page that knows how to accept it. */
  it("routes each invitation kind to its own accept page", () => {
    expect(invitationUrl("MEMBER", "token_123")).toMatch(/\/invite\/token_123$/);
    expect(invitationUrl("CREATOR", "token_123")).toMatch(/\/join\/token_123$/);
  });
});

