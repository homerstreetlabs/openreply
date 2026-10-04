import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Saving a campaign that replies under the comment and sends no DM.
 *
 * The route read "Instagram can send a DM" as "this campaign sends one", so the
 * same comment-only campaign that saves on YouTube was refused on Instagram,
 * and an edit that removed the DM failed the schema before reaching any rule.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    connectedAccount: { findFirst: vi.fn() },
    campaign: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    trackedLink: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => ({ workspaceId: "ws_1", role: "OWNER" }),
  canManageWorkspace: () => true,
}));
vi.mock("@/lib/tenancy/acting-workspace", () => ({
  actingWorkspace: async () => ({ kind: "own", workspaceId: "ws_1" }),
  PlatformAccessError: class PlatformAccessError extends Error {},
}));

import { PATCH, POST } from "../app/api/automations/route";

/** What the builder posts for an Instagram campaign that only replies publicly. */
const commentOnly = {
  name: "Comment only",
  accountId: "acct_1",
  postId: "media_1",
  postUrl: null,
  matchAnyPost: false,
  pendingNextReel: false,
  matchAnyWord: false,
  keywords: ["LINK"],
  dmTriggerEnabled: false,
  dmMessage: "",
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  publicReplyEnabled: true,
  publicReplyMessages: ["thanks for asking!"],
  trackedDestinationUrl: "",
  linkButtonLabel: "Open link",
  secondaryDestinationUrl: "",
  secondaryButtonLabel: "Open link",
  requireFollow: false,
  followPromptMessage: "",
  followPromptButtonLabel: "",
  followUpEnabled: false,
  followUpMessage: "",
  followUpDelayMinutes: 0,
  isActive: true,
};

/** A stored Instagram campaign that sends a DM. */
const stored = {
  id: "camp_1",
  workspaceId: "ws_1",
  isActive: true,
  dmMessage: "Here's the link",
  dmTriggerEnabled: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  requireFollow: false,
  followPromptMessage: null,
  followPromptButtonLabel: null,
  followUpEnabled: false,
  followUpMessage: null,
  followUpDelayMinutes: 0,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  connectedAccount: { platform: "INSTAGRAM" },
  trackedLinks: [],
};

function request(body: Partial<typeof commentOnly>, query = ""): NextRequest {
  return {
    nextUrl: new URL(`http://localhost/api/automations${query}`),
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_1" });
  mockPrisma.connectedAccount.findFirst.mockResolvedValue({
    id: "acct_1",
    workspaceId: "ws_1",
    platform: "INSTAGRAM",
  });
  mockPrisma.campaign.create.mockResolvedValue({ id: "camp_1" });
  mockPrisma.campaign.findFirst.mockResolvedValue(stored);
  mockPrisma.campaign.findUnique.mockResolvedValue(stored);
  mockPrisma.campaign.update.mockResolvedValue({ id: "camp_1" });
  mockPrisma.trackedLink.findFirst.mockResolvedValue(null);
  mockPrisma.trackedLink.findMany.mockResolvedValue([]);
});

describe("creating a campaign with no DM on Instagram", () => {
  it("saves one that replies under the comment", async () => {
    const res = await POST(request(commentOnly));

    expect(res.status).toBe(201);
    const { data } = mockPrisma.campaign.create.mock.calls[0][0];
    expect(data.dmMessage).toBe("");
    expect(data.compiledPlan).toEqual([
      { kind: "publicReply", spec: { variants: ["thanks for asking!"] } },
    ]);
  });

  it("refuses one that sends nothing at all", async () => {
    const res = await POST(
      request({ ...commentOnly, publicReplyEnabled: false, publicReplyMessages: [] })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/public reply/);
    expect(mockPrisma.campaign.create).not.toHaveBeenCalled();
  });

  it("refuses a follow requirement with no DM to gate", async () => {
    const res = await POST(
      request({ ...commentOnly, requireFollow: true, followPromptMessage: "follow first" })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/follow requirement/);
    expect(mockPrisma.campaign.create).not.toHaveBeenCalled();
  });
});

describe("editing a campaign to drop its DM", () => {
  it("saves the edit", async () => {
    const res = await PATCH(request(commentOnly, "?id=camp_1"));

    expect(res.status).toBe(200);
    expect(mockPrisma.campaign.update.mock.calls[0][0].data.dmMessage).toBe("");
  });

  it("refuses the edit while a setting still needs the DM", async () => {
    const res = await PATCH(
      request(
        { ...commentOnly, requireFollow: true, followPromptMessage: "follow first" },
        "?id=camp_1"
      )
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/follow requirement/);
    expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
  });

  /** A creator must always be able to stop a campaign, whatever it holds. */
  it("still lets a campaign that sends nothing be paused", async () => {
    mockPrisma.campaign.findFirst.mockResolvedValue({ ...stored, dmMessage: "" });

    const res = await PATCH(request({ isActive: false }, "?id=camp_1"));

    expect(res.status).toBe(200);
  });
});
