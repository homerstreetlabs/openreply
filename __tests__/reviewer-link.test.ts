import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    verificationToken: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { mintReviewerLink } from "../lib/access/reviewer-link";

const KEY = "reviewer-key-value";
const SECRET = "nextauth-secret-value";
const EMAIL = "review@getrecite.app";

function configured() {
  vi.stubEnv("REVIEWER_ACCESS_KEY", KEY);
  vi.stubEnv("REVIEWER_EMAIL", EMAIL);
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.getrecite.app");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user_1" });
  mockPrisma.verificationToken.create.mockResolvedValue({});
});

/**
 * The property that makes this safe to ship: with no secret set there is no
 * door, so a deployment that never configured reviewer access cannot be talked
 * into opening one.
 */
describe("with no REVIEWER_ACCESS_KEY", () => {
  it("refuses even when the key argument is empty, which is what an absent env var equals", async () => {
    vi.stubEnv("REVIEWER_EMAIL", EMAIL);
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);

    await expect(mintReviewerLink("")).resolves.toEqual({
      kind: "refused",
      reason: "not_configured",
    });
    await expect(mintReviewerLink(null)).resolves.toEqual({
      kind: "refused",
      reason: "not_configured",
    });
  });

  it("mints nothing", async () => {
    await mintReviewerLink(KEY);
    expect(mockPrisma.verificationToken.create).not.toHaveBeenCalled();
  });
});

describe("with a wrong key", () => {
  it("refuses", async () => {
    configured();
    await expect(mintReviewerLink("not-the-key")).resolves.toEqual({
      kind: "refused",
      reason: "bad_key",
    });
  });

  it("refuses a prefix of the real key, which a length-only comparison would accept", async () => {
    configured();
    await expect(mintReviewerLink(KEY.slice(0, 5))).resolves.toEqual({
      kind: "refused",
      reason: "bad_key",
    });
  });
});

/**
 * Closing registration meant an address nobody invited gets no session. A link
 * minter that provisions its own user would reopen that door under another
 * name.
 */
describe("when the reviewer address has no user", () => {
  it("refuses instead of creating one", async () => {
    configured();
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(mintReviewerLink(KEY)).resolves.toEqual({
      kind: "refused",
      reason: "no_such_user",
    });
    expect(mockPrisma.verificationToken.create).not.toHaveBeenCalled();
  });
});

describe("with the right key and an existing user", () => {
  it("returns a callback URL Auth.js will accept", async () => {
    configured();
    const link = await mintReviewerLink(KEY);

    expect(link.kind).toBe("ok");
    if (link.kind !== "ok") return;

    const url = new URL(link.url);
    expect(url.origin + url.pathname).toBe(
      "https://openreply.getrecite.app/api/auth/callback/nodemailer"
    );
    expect(url.searchParams.get("email")).toBe(EMAIL);
    expect(url.searchParams.get("callbackUrl")).toBe("/dashboard");
    expect(url.searchParams.get("token")).toMatch(/^[a-f0-9]{64}$/);
  });

  /**
   * The one that breaks silently if it drifts. Auth.js validates the callback
   * against `sha256(token + secret)`, so storing anything else yields a link
   * that looks right and is rejected on click.
   */
  it("stores the hash Auth.js checks, not the raw token", async () => {
    configured();
    const link = await mintReviewerLink(KEY);
    if (link.kind !== "ok") throw new Error("expected a link");

    const raw = new URL(link.url).searchParams.get("token");
    const stored = mockPrisma.verificationToken.create.mock.calls[0][0].data;

    expect(stored.token).not.toBe(raw);
    expect(stored.token).toBe(
      createHash("sha256").update(`${raw}${SECRET}`).digest("hex")
    );
    expect(stored.identifier).toBe(EMAIL);
  });

  it("expires the token well inside the day Auth.js would allow a mailed link", async () => {
    configured();
    await mintReviewerLink(KEY);

    const { expires } = mockPrisma.verificationToken.create.mock.calls[0][0].data;
    const ms = expires.getTime() - Date.now();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("mints a fresh token per request, so a captured URL is not reusable as a generator", async () => {
    configured();
    const first = await mintReviewerLink(KEY);
    const second = await mintReviewerLink(KEY);
    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("expected links");

    expect(first.url).not.toBe(second.url);
  });

  it("normalizes the configured address the way admission does", async () => {
    configured();
    vi.stubEnv("REVIEWER_EMAIL", `  ${EMAIL.toUpperCase()}  `);

    const link = await mintReviewerLink(KEY);
    if (link.kind !== "ok") throw new Error("expected a link");

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: EMAIL } })
    );
    expect(new URL(link.url).searchParams.get("email")).toBe(EMAIL);
  });
});
