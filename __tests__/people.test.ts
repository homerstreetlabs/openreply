import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findMany: vi.fn() },
    creatorInvitation: { findMany: vi.fn() },
    workspaceInvitation: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { listPeople } from "../lib/access/people";

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user_1",
    email: "creator@example.com",
    name: null,
    status: "ACTIVE",
    createdAt: new Date("2026-01-01"),
    platformGrants: [],
    workspaceMembers: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.creatorInvitation.findMany.mockResolvedValue([]);
  mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
});

/**
 * The two role systems stay separate on purpose. An operator must be able to
 * act inside a creator's workspace without appearing in that creator's member
 * list, which one merged enum would make impossible.
 */
describe("listPeople", () => {
  it("splits people by whether they hold a grant, not by workspace", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      user({
        id: "user_admin",
        email: "admin@openreply.test",
        platformGrants: [
          {
            id: "grant_1",
            tier: "ADMIN",
            grantedAt: new Date("2026-01-02"),
            expiresAt: null,
          },
        ],
      }),
      user({
        id: "user_creator",
        workspaceMembers: [
          {
            workspace: {
              id: "ws_1",
              name: "Acme",
              _count: { connectedAccounts: 3 },
            },
          },
        ],
      }),
    ]);

    const people = await listPeople();

    expect(people.admins.map((person) => person.userId)).toEqual(["user_admin"]);
    expect(people.creators.map((person) => person.userId)).toEqual(["user_creator"]);
    expect(people.creators[0].workspace).toEqual({
      id: "ws_1",
      name: "Acme",
      accounts: 3,
    });
  });

  /**
   * An admin with no workspace is the designed state, not missing data. The
   * page has to render it without implying something went wrong.
   */
  it("reports an admin with no workspace as having none", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      user({
        id: "user_admin",
        platformGrants: [
          { id: "grant_1", tier: "ADMIN", grantedAt: new Date(), expiresAt: null },
        ],
      }),
    ]);

    const people = await listPeople();
    expect(people.admins[0].workspace).toBeNull();
  });

  it("only counts a grant that is still live", async () => {
    mockPrisma.user.findMany.mockResolvedValue([user()]);
    await listPeople();

    const [call] = mockPrisma.user.findMany.mock.calls;
    const grantFilter = call[0].select.platformGrants.where;
    expect(grantFilter.revokedAt).toBeNull();
    expect(grantFilter.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
  });

  it("shows why an invitation never arrived, rather than calling it pending", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.creatorInvitation.findMany.mockResolvedValue([
      {
        id: "invite_1",
        email: "new@example.com",
        expiresAt: new Date("2026-09-01"),
        deliveredAt: null,
        deliveryError: "suppressed by the mail provider",
        invitedBy: { email: "admin@openreply.test", name: null },
      },
    ]);

    const people = await listPeople();
    expect(people.pending[0]).toMatchObject({
      kind: "creator",
      deliveryError: "suppressed by the mail provider",
      invitedBy: "admin@openreply.test",
    });
  });
});
