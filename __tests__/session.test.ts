import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * How many session lookups one request pays for.
 *
 * `auth()` is not memoized by next-auth, so each call is another query. React's
 * `cache()` covers a render pass but is a passthrough in a Route Handler, which
 * is where most of these callers live — so the guarantee that matters has to be
 * structural: one function that returns both the user and their workspace.
 */

const { authMock, getPrimaryWorkspaceMock, ensureWorkspaceForUserMock } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    getPrimaryWorkspaceMock: vi.fn(),
    ensureWorkspaceForUserMock: vi.fn(),
  })
);

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/workspace", () => ({
  getPrimaryWorkspace: getPrimaryWorkspaceMock,
  ensureWorkspaceForUser: ensureWorkspaceForUserMock,
}));

import {
  getCurrentUserId,
  getCurrentWorkspaceId,
  getSession,
  getSessionScope,
} from "../lib/session";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({
    user: { id: "user_1", email: "creator@example.com" },
  });
  getPrimaryWorkspaceMock.mockResolvedValue({ id: "ws_1", name: "Creator" });
  ensureWorkspaceForUserMock.mockResolvedValue({ id: "ws_new", name: "Creator" });
});

describe("one session lookup per request", () => {
  it("returns the user and the workspace from a single auth() call", async () => {
    const scope = await getSessionScope();

    expect(scope).toEqual({ userId: "user_1", workspaceId: "ws_1" });
    expect(authMock).toHaveBeenCalledTimes(1);
  });

  it("names a first workspace from the session's own email, with no user query", async () => {
    getPrimaryWorkspaceMock.mockResolvedValue(null);

    const scope = await getSessionScope();

    expect(ensureWorkspaceForUserMock).toHaveBeenCalledWith(
      "user_1",
      "creator@example.com"
    );
    expect(scope).toEqual({ userId: "user_1", workspaceId: "ws_new" });
    expect(authMock).toHaveBeenCalledTimes(1);
  });

  it("reports no scope when nobody is signed in", async () => {
    authMock.mockResolvedValue(null);

    expect(await getSessionScope()).toBeNull();
    expect(getPrimaryWorkspaceMock).not.toHaveBeenCalled();
  });

  it("keeps the single-value helpers reading off the same resolution", async () => {
    expect(await getCurrentUserId()).toBe("user_1");
    expect(await getCurrentWorkspaceId()).toBe("ws_1");
  });

  it("exposes the raw session for callers that need more than ids", async () => {
    const session = await getSession();

    expect(session?.user?.email).toBe("creator@example.com");
  });
});
