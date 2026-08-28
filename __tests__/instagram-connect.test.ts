import { describe, expect, it, vi, afterEach } from "vitest";

vi.stubEnv("INSTAGRAM_APP_ID", "app_1");
vi.stubEnv("INSTAGRAM_APP_SECRET", "secret_1");
vi.stubEnv("ENCRYPTION_KEY", "0".repeat(64));

import { instagramAdapter } from "../lib/platforms/instagram";
import { ADAPTERS } from "../lib/platforms/registry";
import type { Platform } from "../lib/platforms/types";

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

  /** The three envelopes this flow returns, in the order the calls happen. */
  type GraphBody =
    | { access_token: string; user_id?: number | string; expires_in?: number }
    | { id: string; user_id: string; username: string }
    | { error: { message: string } };

  function json(body: GraphBody, ok = true) {
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

/**
 * The second half of the same outage. Fleet reported "not receiving webhooks"
 * because nothing ever asked Meta to deliver them: the subscribe call existed
 * but had no callers, so the column kept its `false` default.
 */
describe("event subscription", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("subscribes the Instagram account to comments and messages", async () => {
    const seen: { url: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: init?.body });
      return {
        ok: true,
        status: 200,
        url: String(input),
        json: () => Promise.resolve({ success: true }),
      } as Response;
    }) as typeof fetch;

    const subscribed = await instagramAdapter.subscribeToEvents!(
      "TOKEN",
      "17841400000000000"
    );

    expect(subscribed).toBe(true);
    expect(seen[0].url).toContain("/17841400000000000/subscribed_apps");
    expect(String(seen[0].body)).toContain("comments");
    expect(String(seen[0].body)).toContain("messages");
  });

  /**
   * YouTube is poll-only and TikTok registers one app-level webhook, so neither
   * has an account to subscribe. Absent rather than a method returning false,
   * so the callback skips them instead of recording a failure.
   */
  it.each(["YOUTUBE", "TIKTOK"] as Platform[])(
    "%s has nothing to subscribe",
    (platform) => {
      expect(ADAPTERS[platform].subscribeToEvents).toBeUndefined();
    }
  );

  it.each(["INSTAGRAM", "FACEBOOK"] as Platform[])(
    "%s can be subscribed",
    (platform) => {
      expect(ADAPTERS[platform].subscribeToEvents).toBeTypeOf("function");
    }
  );
});
