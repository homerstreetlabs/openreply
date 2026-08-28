import { describe, expect, it, vi, afterEach } from "vitest";

vi.stubEnv("INSTAGRAM_APP_ID", "app_1");
vi.stubEnv("INSTAGRAM_APP_SECRET", "secret_1");
vi.stubEnv("ENCRYPTION_KEY", "0".repeat(64));

import { instagramAdapter } from "../lib/platforms/instagram";

/**
 * A connected account went dead overnight in production. Meta reported
 * "Session has expired" on a token the database believed had 60 days left, and
 * the refresh cron only touches accounts inside 10 days of expiry, so nothing
 * would have repaired it for another 50.
 *
 * The authorization-code grant returns a SHORT-lived token. Turning it into the
 * 60-day one is a second call, `ig_exchange_token`, and the expiry has to come
 * from what that call reports rather than being asserted.
 */
describe("instagram connect", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFlow(longLived: { token: string; expiresIn: number } | null) {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/oauth/access_token")) {
        return json({ access_token: "SHORT_LIVED", user_id: 17841400000000000 });
      }
      if (url.includes("ig_exchange_token")) {
        if (!longLived) return json({ error: { message: "refused" } }, false);
        return json({ access_token: longLived.token, expires_in: longLived.expiresIn });
      }
      return json({ id: "app_scoped", user_id: "17841400000000000", username: "posera_app" });
    }) as typeof fetch;
    return calls;
  }

  function json(body: unknown, ok = true) {
    return Promise.resolve({
      ok,
      status: ok ? 200 : 400,
      url: "https://graph.instagram.com/x",
      json: () => Promise.resolve(body),
    } as Response);
  }

  it("stores the long-lived token, not the one the code grant returned", async () => {
    mockFlow({ token: "LONG_LIVED", expiresIn: 5_184_000 });

    const [identity] = await instagramAdapter.oauth.exchange(
      { appId: "app_1", appSecret: "secret_1" },
      "code_1",
      "https://example.test/api/connect/instagram/callback"
    );

    expect(identity.accessToken).toBe("LONG_LIVED");
  });

  it("reports the expiry Meta gave rather than assuming 60 days", async () => {
    // Meta returns whatever is left, which is not always the full window.
    mockFlow({ token: "LONG_LIVED", expiresIn: 4_000_000 });

    const [identity] = await instagramAdapter.oauth.exchange(
      { appId: "app_1", appSecret: "secret_1" },
      "code_1",
      "https://example.test/api/connect/instagram/callback"
    );

    expect(identity.expiresInSeconds).toBe(4_000_000);
  });

  it("performs the exchange that upgrades the token", async () => {
    const calls = mockFlow({ token: "LONG_LIVED", expiresIn: 5_184_000 });

    await instagramAdapter.oauth.exchange(
      { appId: "app_1", appSecret: "secret_1" },
      "code_1",
      "https://example.test/api/connect/instagram/callback"
    );

    expect(calls.some((url) => url.includes("ig_exchange_token"))).toBe(true);
  });

  /**
   * Failing the connect is better than storing a token that dies in an hour
   * while the database records it as good for two months.
   */
  it("fails the connect rather than storing a token it could not upgrade", async () => {
    mockFlow(null);

    await expect(
      instagramAdapter.oauth.exchange(
        { appId: "app_1", appSecret: "secret_1" },
        "code_1",
        "https://example.test/api/connect/instagram/callback"
      )
    ).rejects.toThrow();
  });
});
