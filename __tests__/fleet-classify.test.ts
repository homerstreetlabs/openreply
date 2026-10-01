import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { classify } from "../lib/ops/fleet";

const now = Date.parse("2026-10-01T00:00:00Z");
const inMs = (ms: number) => new Date(now + ms);
const HOUR = 3_600_000;
const base = { failed24h: 0, sent24h: 5, now };

describe("fleet health, judged per platform", () => {
  it("does not call a TikTok account deaf, since its webhook is registered for the whole app", () => {
    const row = classify({ ...base, platform: "TIKTOK", webhookSubscribed: false, tokenExpiresAt: inMs(20 * HOUR) });
    expect(row).toEqual({ status: "HEALTHY", note: null });
  });

  it("does not call a polled YouTube channel deaf, or its hour-long token a problem", () => {
    const row = classify({ ...base, platform: "YOUTUBE", webhookSubscribed: false, tokenExpiresAt: inMs(40 * 60_000) });
    expect(row).toEqual({ status: "HEALTHY", note: null });
  });

  it("still breaks an Instagram account that lost its webhook subscription", () => {
    const row = classify({ ...base, platform: "INSTAGRAM", webhookSubscribed: false, tokenExpiresAt: inMs(50 * 24 * HOUR) });
    expect(row).toEqual({ status: "BROKEN", note: "not receiving webhooks" });
  });

  it("degrades an account whose token the refresh cron should already have renewed", () => {
    const row = classify({ ...base, platform: "TIKTOK", webhookSubscribed: false, tokenExpiresAt: inMs(2 * HOUR) });
    expect(row.status).toBe("DEGRADED");
    expect(row.note).toBe("token refresh overdue, expires in 2h");
  });

  it("breaks an account whose token has expired", () => {
    const row = classify({ ...base, platform: "YOUTUBE", webhookSubscribed: false, tokenExpiresAt: inMs(-60_000) });
    expect(row).toEqual({ status: "BROKEN", note: "token expired" });
  });
});
