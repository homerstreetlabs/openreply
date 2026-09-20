import { describe, expect, it, beforeEach, vi } from "vitest";
import { getFacebookAuthorizationUrl } from "../lib/platforms/facebook-oauth";

const REDIRECT = "https://openreply.recite.fm/api/connect/facebook/callback";

beforeEach(() => {
  vi.stubEnv("FACEBOOK_APP_ID", "2060639351201779");
  vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "1559767028701367");
});

describe("Facebook Login for Business authorization URL", () => {
  it("carries the configuration id", () => {
    const url = new URL(getFacebookAuthorizationUrl(REDIRECT, "state-abc"));
    expect(url.searchParams.get("config_id")).toBe("1559767028701367");
    expect(url.searchParams.get("client_id")).toBe("2060639351201779");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  // A `scope` here is the consumer Facebook Login flow. This app has only
  // Facebook Login for Business, which answers that request with "Facebook
  // Login is currently unavailable for this app" and names no cause.
  it("sends no scope", () => {
    const url = new URL(getFacebookAuthorizationUrl(REDIRECT, "state-abc"));
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("refuses to build a URL with no configuration id", () => {
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "");
    expect(() => getFacebookAuthorizationUrl(REDIRECT, "state-abc")).toThrow();
  });
});
