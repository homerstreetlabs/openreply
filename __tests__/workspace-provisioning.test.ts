import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Which of these three writes, and when.
 *
 * The dashboard layout used to call `ensureWorkspaceForUser` on every render,
 * which swept pending invitations every time — a query that almost always
 * matches nothing — and could create a workspace as a side effect of a GET.
 * Reading and provisioning are now separate functions, and the sweep belongs to
 * signing in.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    workspaceMember: { findFirst: vi.fn(), upsert: vi.fn() },
    workspaceInvitation: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    creatorInvitation: { findFirst: vi.fn() },
    platformGrant: { findFirst: vi.fn() },
    workspace: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { ensureWorkspaceForUser, getWorkspaceForUser } from "../lib/workspace";
import { settleAdmission } from "../lib/access/admission";

const membership = {
  workspace: { id: "ws_1", name: "Creator" },
  role: "OWNER",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspaceMember.findFirst.mockResolvedValue(membership);
  mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
  mockPrisma.workspace.create.mockResolvedValue({ id: "ws_new", name: "New" });
  mockPrisma.workspaceInvitation.findFirst.mockResolvedValue(null);
  mockPrisma.creatorInvitation.findFirst.mockResolvedValue(null);
  mockPrisma.platformGrant.findFirst.mockResolvedValue(null);
  mockPrisma.$transaction.mockResolvedValue([]);
  // An established creator, which is the case that reaches the provisioning
  // half of settleAdmission at all.
  mockPrisma.user.findUnique.mockResolvedValue({
    id: "user_1",
    status: "ACTIVE",
    platformGrants: [],
  });
});

describe("reading a workspace", () => {
  it("writes nothing, which is what makes it safe in a page render", async () => {
    const workspace = await getWorkspaceForUser("user_1");

    expect(workspace).toEqual(membership.workspace);
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
    expect(mockPrisma.workspaceInvitation.findMany).not.toHaveBeenCalled();
  });

  it("reports no workspace rather than creating one", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);

    expect(await getWorkspaceForUser("user_1")).toBeNull();
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });
});

describe("ensuring a workspace", () => {
  it("no longer sweeps invitations, so a render cannot pay for that query", async () => {
    await ensureWorkspaceForUser("user_1", "creator@example.com");

    expect(mockPrisma.workspaceInvitation.findMany).not.toHaveBeenCalled();
  });

  it("still creates one for a user who has none", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);

    const workspace = await ensureWorkspaceForUser("user_1", "creator@example.com");

    expect(workspace).toEqual({ id: "ws_new", name: "New" });
    expect(mockPrisma.workspace.create).toHaveBeenCalledTimes(1);
  });
});

describe("provisioning at sign-in", () => {
  it("sweeps pending invitations, which is where that cost now lives", async () => {
    await settleAdmission("user_1", "creator@example.com");

    expect(mockPrisma.workspaceInvitation.findMany).toHaveBeenCalledTimes(1);
  });

  /**
   * An invited user provisioned first would end up owning a personal workspace
   * as well, and `getWorkspaceMembership` sorts oldest first, so the personal
   * one would win and the invitation would look like it did nothing.
   */
  it("accepts invitations before deciding the user needs a workspace", async () => {
    const order: string[] = [];
    mockPrisma.workspaceInvitation.findMany.mockImplementation(async () => {
      order.push("sweep");
      return [];
    });
    mockPrisma.workspaceMember.findFirst.mockImplementation(async () => {
      order.push("read membership");
      return membership;
    });

    await settleAdmission("user_1", "creator@example.com");

    expect(order).toEqual(["sweep", "read membership"]);
  });

  /**
   * A person invited to two workspaces used to join one and then resolve as an
   * existing user on their next sign-in, so the second invitation could never
   * be accepted.
   */
  it("accepts every pending invitation, not just the first", async () => {
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([
      { id: "inv_1", workspaceId: "ws_a", role: "MEMBER" },
      { id: "inv_2", workspaceId: "ws_b", role: "ADMIN" },
    ]);

    await settleAdmission("user_1", "creator@example.com");

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("skips the sweep entirely when there is no address to match", async () => {
    await settleAdmission("user_1", null);

    expect(mockPrisma.workspaceInvitation.findMany).not.toHaveBeenCalled();
  });

  /**
   * An operator with a personal workspace shows up in fleet counts and account
   * lists as a creator who does not exist.
   */
  it("gives a platform admin no workspace at all", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_admin",
      status: "ACTIVE",
      platformGrants: [{ id: "grant_1" }],
    });
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);

    await settleAdmission("user_admin", "admin@openreply.test");

    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
    expect(mockPrisma.workspaceInvitation.findMany).not.toHaveBeenCalled();
  });
});
