import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { parseActivityWindow } from "../lib/ops/fleet";

describe("fleet activity window, read from the query string", () => {
  it("accepts every window the page offers", () => {
    expect(parseActivityWindow("24h")).toBe("24h");
    expect(parseActivityWindow("7d")).toBe("7d");
    expect(parseActivityWindow("30d")).toBe("30d");
  });

  it("falls back to the last day when the parameter is missing", () => {
    expect(parseActivityWindow(null)).toBe("24h");
    expect(parseActivityWindow("")).toBe("24h");
  });

  it("falls back to the last day for a window it does not know", () => {
    expect(parseActivityWindow("90d")).toBe("24h");
    expect(parseActivityWindow("7D")).toBe("24h");
  });

  it("does not mistake an inherited object key for a window", () => {
    expect(parseActivityWindow("toString")).toBe("24h");
    expect(parseActivityWindow("__proto__")).toBe("24h");
  });
});
