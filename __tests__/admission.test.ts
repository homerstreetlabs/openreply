import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    invitation: { findFirst: vi.fn() },
    platformGrant: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { admit } from "../lib/access/admission";

const HOUR = 60 * 60 * 1000;
const later = () => new Date(Date.now() + 24 * HOUR);
const earlier = () => new Date(Date.now() - HOUR);

/**
 * One table serves both kinds now, so the mock routes on `kind` exactly as the
 * query does.
 */
function invitations(options: {
  creator?: unknown;
  member?: unknown;
} = {}) {
  mockPrisma.invitation.findFirst.mockImplementation(async ({ where }) =>
    where.kind === "CREATOR" ? (options.creator ?? null) : (options.member ?? null)
  );
}

function noRecords() {
  mockPrisma.user.findUnique.mockResolvedValue(null);
  invitations();
  mockPrisma.platformGrant.findFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  noRecords();
});

/**
 * The regression this closes. `lib/auth.ts` had no signIn callback, so any
 * address that submitted the login form received a working magic link and was
 * provisioned a workspace.
 */
describe("an address nobody invited", () => {
  it("is refused", async () => {
    await expect(admit("stranger@example.com")).resolves.toEqual({
      kind: "refused",
      reason: "not_invited",
    });
  });

  it("is refused when there is no address at all", async () => {
    await expect(admit(null)).resolves.toEqual({
      kind: "refused",
      reason: "not_invited",
    });
  });
});

/**
 * The two production admins hold PlatformGrant rows already, so this clause is
 * what carries them through the change with no data migration.
 */
describe("an existing platform admin", () => {
  it("is admitted on their grant", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_admin",
      status: "ACTIVE",
      platformGrants: [{ id: "grant_1" }],
    });

    await expect(admit("admin@openreply.test")).resolves.toEqual({
      kind: "admin",
      userId: "user_admin",
    });
  });

  it("is still refused once suspended", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_admin",
      status: "SUSPENDED",
      platformGrants: [{ id: "grant_1" }],
    });

    await expect(admit("admin@openreply.test")).resolves.toEqual({
      kind: "refused",
      reason: "suspended",
    });
  });
});

/**
 * Creators who signed up while the door was open have live workspaces,
 * connected accounts and running campaigns. Closing the door must not evict
 * them, which is what the ACTIVE backfill on User.status buys.
 */
describe("a creator who predates the gate", () => {
  it("is grandfathered in", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_creator",
      status: "ACTIVE",
      platformGrants: [],
    });

    await expect(admit("creator@example.com")).resolves.toEqual({
      kind: "existing",
      userId: "user_creator",
    });
  });

  it("is locked out by suspending them, which is the only verb that does it", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_creator",
      status: "SUSPENDED",
      platformGrants: [],
    });

    await expect(admit("creator@example.com")).resolves.toEqual({
      kind: "refused",
      reason: "suspended",
    });
  });
});

describe("invitations", () => {
  it("admits a pending creator invitation", async () => {
    invitations({ creator: { id: "invite_1", expiresAt: later() } });

    await expect(admit("new@example.com")).resolves.toEqual({
      kind: "creator",
      invitationId: "invite_1",
    });
  });

  it("admits a pending workspace invitation with its workspace", async () => {
    invitations({
      member: { id: "invite_2", workspaceId: "workspace_1", expiresAt: later() },
    });

    await expect(admit("teammate@example.com")).resolves.toEqual({
      kind: "member",
      invitationId: "invite_2",
      workspaceId: "workspace_1",
    });
  });

  it("refuses an expired invitation, and says why", async () => {
    invitations({ creator: { id: "invite_1", expiresAt: earlier() } });

    await expect(admit("stale@example.com")).resolves.toEqual({
      kind: "refused",
      reason: "invitation_expired",
    });
  });
});

/**
 * The allowlist has to be unreachable the moment a real admin exists, or an
 * environment variable left set becomes a standing backdoor.
 */
describe("the bootstrap allowlist", () => {
  it("admits a listed address while no grant exists anywhere", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAILS", "founder@example.com");

    await expect(admit("founder@example.com")).resolves.toEqual({
      kind: "bootstrap",
    });
  });

  it("disarms itself as soon as one grant exists", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAILS", "founder@example.com");
    mockPrisma.platformGrant.findFirst.mockResolvedValue({ id: "grant_1" });

    await expect(admit("founder@example.com")).resolves.toEqual({
      kind: "refused",
      reason: "not_invited",
    });
  });

  it("does not admit an address that is not on it", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAILS", "founder@example.com");

    await expect(admit("someone@example.com")).resolves.toEqual({
      kind: "refused",
      reason: "not_invited",
    });
  });
});

describe("address handling", () => {
  it("matches regardless of case or surrounding space", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_1",
      status: "ACTIVE",
      platformGrants: [],
    });

    await admit("  Creator@Example.COM  ");
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "creator@example.com" } })
    );
  });

  /**
   * Auth.js hands the callback a throwaway crypto.randomUUID() user for an
   * address it has never seen, so a gate keyed on user id would be checking a
   * value that means nothing.
   */
  it("looks the person up by email, never by id", async () => {
    await admit("stranger@example.com");
    const [call] = mockPrisma.user.findUnique.mock.calls;
    expect(call[0].where).toHaveProperty("email");
    expect(call[0].where).not.toHaveProperty("id");
  });
});
