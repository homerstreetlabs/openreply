import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    connectedAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "tt_secret");

import { accountDirectory } from "../lib/accounts/directory";

const ROWS = [
  { id: "fb_1", platform: "FACEBOOK" as const, instagramId: "page_1", username: "Acme Bakery" },
  { id: "ig_1", platform: "INSTAGRAM" as const, instagramId: "17841_1", username: "acme" },
  { id: "ig_2", platform: "INSTAGRAM" as const, instagramId: "17841_2", username: "acme_uk" },
  { id: "yt_1", platform: "YOUTUBE" as const, instagramId: "UC_1", username: "Acme Channel" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.connectedAccount.findMany.mockResolvedValue(ROWS);
});

describe("account directory", () => {
  it("labels each account the way its own platform does", async () => {
    const directory = await accountDirectory("workspace_1");
    const byId = new Map(directory.all.map((a) => [a.id, a.label]));

    // A handle gets an @; a Page name does not. Prefixing all four prints
    // "@Acme Bakery", which reads as a bug in the product.
    expect(byId.get("ig_1")).toBe("@acme");
    expect(byId.get("fb_1")).toBe("Acme Bakery");
    expect(byId.get("yt_1")).toBe("Acme Channel");
  });

  it("groups by platform and keeps both accounts of a doubled platform", async () => {
    const directory = await accountDirectory("workspace_1");
    const instagram = directory.platforms.find((g) => g.platform === "INSTAGRAM");

    expect(instagram?.accounts.map((a) => a.id)).toEqual(["ig_1", "ig_2"]);
    // Only platforms that have an account, so the pill row has no dead entries.
    expect(directory.platforms.map((g) => g.platform).sort()).toEqual([
      "FACEBOOK",
      "INSTAGRAM",
      "YOUTUBE",
    ]);
  });

  /**
   * The regression this module exists to prevent. The old lookup was
   * `findFirst` by workspace with no platform filter, so the newest connection
   * of any platform became "the Instagram account".
   */
  it("only offers the inbox to accounts whose adapter can read conversations", async () => {
    const directory = await accountDirectory("workspace_1");
    const ids = directory.supporting("conversations").map((a) => a.id);

    expect(ids).toContain("ig_1");
    expect(ids).toContain("fb_1");
    expect(ids).not.toContain("yt_1");
  });

  it("defaults to an account that can actually serve the surface", async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([
      { id: "yt_1", platform: "YOUTUBE" as const, instagramId: "UC_1", username: "Acme" },
      { id: "ig_1", platform: "INSTAGRAM" as const, instagramId: "17841_1", username: "acme" },
    ]);

    const directory = await accountDirectory("workspace_1");
    // YouTube sorts first and would win a naive "first account" default, but it
    // has no inbox to open.
    expect(directory.defaultFor("conversations")?.id).toBe("ig_1");
    expect(directory.defaultFor("insights")?.id).toBe("yt_1");
  });

  it("does not find an account outside the workspace it was asked about", async () => {
    const directory = await accountDirectory("workspace_1");
    expect(directory.find("someone_elses_account")).toBeNull();
  });
});
