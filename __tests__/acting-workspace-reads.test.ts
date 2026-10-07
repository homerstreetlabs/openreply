import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * A platform admin opening a creator's campaign from the fleet view. The
 * campaign itself came from the creator's workspace, but its post thumbnail and
 * account avatar were looked up in the admin's own, where neither exists.
 *
 * Naming a workspace is only honoured for someone allowed into it, so a creator
 * cannot read another creator's posts by editing the query string.
 */

const { mockPrisma, mockGetSessionScope, listPosts, fetchProfileImage } = vi.hoisted(
  () => ({
    mockPrisma: {
      workspaceMember: { findUnique: vi.fn() },
      platformGrant: { findMany: vi.fn() },
      adminAccessLog: { create: vi.fn() },
      connectedAccount: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    mockGetSessionScope: vi.fn(),
    listPosts: vi.fn(),
    fetchProfileImage: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session", () => ({
  getSessionScope: mockGetSessionScope,
  getCurrentUserId: async () => "user_1",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => value }));
vi.mock("@/lib/platforms/registry", () => ({
  adapterFor: () => ({ listPosts, fetchProfileImage }),
}));

import { GET as getPosts } from "../app/api/posts/route";
import { GET as getProfile } from "../app/api/instagram/profile/route";

const account = {
  id: "acct_1",
  platform: "INSTAGRAM",
  instagramId: "ig_1",
  username: "creator",
  accessToken: "token",
};

function request(path: string): NextRequest {
  return new NextRequest(`https://openreply.test${path}`);
}

/** The workspace each account lookup was confined to. */
function workspacesQueried(): string[] {
  return mockPrisma.connectedAccount.findFirst.mock.calls.map(
    ([args]) => args.where.workspaceId
  );
}

function grantAdmin() {
  mockPrisma.platformGrant.findMany.mockResolvedValue([{ id: "grant_1", tier: "ADMIN" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionScope.mockResolvedValue({ userId: "user_1", workspaceId: "ws_own" });
  mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
  mockPrisma.platformGrant.findMany.mockResolvedValue([]);
  mockPrisma.adminAccessLog.create.mockResolvedValue({});
  mockPrisma.connectedAccount.findFirst.mockResolvedValue(account);
  mockPrisma.connectedAccount.findMany.mockResolvedValue([account]);
  listPosts.mockResolvedValue([{ id: "media_1", thumbnailUrl: "https://cdn/1.jpg" }]);
  fetchProfileImage.mockResolvedValue("https://cdn/avatar.jpg");
});

describe("reading posts", () => {
  it("reads the caller's own workspace when none is named", async () => {
    const res = await getPosts(request("/api/posts?accountId=acct_1&limit=50"));

    expect(res.status).toBe(200);
    expect(workspacesQueried()).toEqual(["ws_own"]);
  });

  it("refuses someone with no grant who names another workspace", async () => {
    const res = await getPosts(
      request("/api/posts?accountId=acct_1&workspaceId=ws_creator")
    );

    expect(res.status).toBe(403);
    expect(mockPrisma.connectedAccount.findFirst).not.toHaveBeenCalled();
    expect(listPosts).not.toHaveBeenCalled();
  });

  it("reads the named workspace for an admin", async () => {
    grantAdmin();

    const res = await getPosts(
      request("/api/posts?accountId=acct_1&limit=50&workspaceId=ws_creator")
    );

    expect(res.status).toBe(200);
    expect(workspacesQueried()).toEqual(["ws_creator"]);
    expect((await res.json()).data).toEqual([
      { id: "media_1", thumbnailUrl: "https://cdn/1.jpg" },
    ]);
  });

  it("picks the named workspace's default account for an admin", async () => {
    grantAdmin();

    const res = await getPosts(request("/api/posts?workspaceId=ws_creator"));

    expect(res.status).toBe(200);
    expect(mockPrisma.connectedAccount.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_creator",
    });
    expect(workspacesQueried()).toEqual(["ws_creator"]);
  });

  it("answers 401 with no session", async () => {
    mockGetSessionScope.mockResolvedValue(null);

    const res = await getPosts(request("/api/posts?accountId=acct_1"));

    expect(res.status).toBe(401);
  });
});

describe("reading an account's profile", () => {
  it("reads the caller's own workspace when none is named", async () => {
    const res = await getProfile(request("/api/instagram/profile?accountId=acct_1"));

    expect(res.status).toBe(200);
    expect(workspacesQueried()).toEqual(["ws_own"]);
  });

  it("refuses someone with no grant who names another workspace", async () => {
    const res = await getProfile(
      request("/api/instagram/profile?accountId=acct_1&workspaceId=ws_creator")
    );

    expect(res.status).toBe(403);
    expect(mockPrisma.connectedAccount.findFirst).not.toHaveBeenCalled();
    expect(fetchProfileImage).not.toHaveBeenCalled();
  });

  it("reads the named workspace for an admin", async () => {
    grantAdmin();

    const res = await getProfile(
      request("/api/instagram/profile?accountId=acct_1&workspaceId=ws_creator")
    );

    expect(res.status).toBe(200);
    expect(workspacesQueried()).toEqual(["ws_creator"]);
    expect((await res.json()).data).toEqual({
      label: "@creator",
      platform: "INSTAGRAM",
      profilePictureUrl: "https://cdn/avatar.jpg",
    });
  });

  it("answers 401 with no session", async () => {
    mockGetSessionScope.mockResolvedValue(null);

    const res = await getProfile(request("/api/instagram/profile?accountId=acct_1"));

    expect(res.status).toBe(401);
  });
});
