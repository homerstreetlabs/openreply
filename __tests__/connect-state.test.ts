import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({ requireEnv: () => "test-signing-secret" }));

import { createState, readState } from "../lib/platforms/connect-state";

/**
 * The state carries which workspace asked. Forging it would attach someone
 * else's account to your workspace, so this is the part that must not be
 * guessable.
 */
describe("the OAuth state parameter", () => {
  const state = { workspaceId: "ws_1", platform: "INSTAGRAM" as const, slug: "main" };

  beforeEach(() => vi.useRealTimers());

  it("round-trips what it was given", async () => {
    expect(await readState(await createState(state))).toEqual(state);
  });

  it("refuses a tampered payload", async () => {
    const signed = await createState(state);
    const [, signature] = signed.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...state, workspaceId: "ws_victim", at: Date.now() })
    ).toString("base64url");

    expect(await readState(`${forged}.${signature}`)).toBeNull();
  });

  it("refuses a missing or malformed value", async () => {
    expect(await readState(null)).toBeNull();
    expect(await readState("")).toBeNull();
    expect(await readState("no-signature")).toBeNull();
    expect(await readState("a.b")).toBeNull();
  });

  it("expires, so a leaked link stops working", async () => {
    const signed = await createState(state);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60_000);

    expect(await readState(signed)).toBeNull();
  });

  it("refuses a payload signed by us but shaped by an older deploy", async () => {
    const stale = Buffer.from(JSON.stringify({ workspaceId: "ws_1" })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", "test-signing-secret").update(stale).digest("hex");

    expect(await readState(`${stale}.${signature}`)).toBeNull();
  });
});
