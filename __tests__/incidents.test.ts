import { describe, it, expect, vi, beforeEach } from "vitest";

const upsert = vi.fn();
const updateMany = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: {
    incident: {
      upsert: (...a: unknown[]) => upsert(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));

const { classifyFailure, raiseIncident, resolveIncident } = await import(
  "../lib/ops/incidents"
);

beforeEach(() => {
  upsert.mockReset().mockResolvedValue({});
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("raising an incident", () => {
  /**
   * A token that expires on Friday fails every send until Monday. Four thousand
   * rows would bury the one fact an admin needs, so the same kind on the same
   * account must collapse into one row.
   */
  it("keys on account and kind, so repeats collapse into one row", async () => {
    await raiseIncident({
      kind: "TOKEN_EXPIRED",
      connectedAccountId: "acct_1",
      message: "token expired",
    });

    const call = upsert.mock.calls[0][0];
    expect(call.where.connectedAccountId_openKey).toEqual({
      connectedAccountId: "acct_1",
      openKey: "TOKEN_EXPIRED",
    });
  });

  it("counts repeats instead of inserting again", async () => {
    await raiseIncident({
      kind: "TOKEN_EXPIRED",
      connectedAccountId: "acct_1",
      message: "token expired",
    });

    expect(upsert.mock.calls[0][0].update.count).toEqual({ increment: 1 });
  });

  /** openKey is what the unique constraint keys on, so a new row must set it. */
  it("opens the slot on create", async () => {
    await raiseIncident({
      kind: "QUOTA_EXHAUSTED",
      connectedAccountId: "acct_1",
      message: "out of units",
    });

    const create = upsert.mock.calls[0][0].create;
    expect(create.openKey).toBe("QUOTA_EXHAUSTED");
    expect(create.kind).toBe("QUOTA_EXHAUSTED");
  });

  it("does not throw when the write fails, so a send is never lost to an alert", async () => {
    upsert.mockRejectedValue(new Error("db down"));

    await expect(
      raiseIncident({ kind: "TOKEN_EXPIRED", connectedAccountId: "a", message: "m" })
    ).resolves.toBeUndefined();
  });
});

describe("resolving an incident", () => {
  /**
   * Clearing openKey frees the unique slot. Without that, the next failure of
   * the same kind would resurrect the old row and its stale first-seen time.
   */
  it("frees the slot so the next failure opens a fresh incident", async () => {
    await resolveIncident("acct_1", "TOKEN_EXPIRED");

    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ connectedAccountId: "acct_1", openKey: "TOKEN_EXPIRED" });
    expect(call.data.openKey).toBeNull();
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
  });

  it("does not throw when the write fails", async () => {
    updateMany.mockRejectedValue(new Error("db down"));
    await expect(resolveIncident("a", "TOKEN_EXPIRED")).resolves.toBeUndefined();
  });
});

describe("classifying a provider failure", () => {
  it("recognises an invalidated Meta session", () => {
    expect(classifyFailure(new Error("Error validating access token: Session has been invalidated")))
      .toBe("TOKEN_EXPIRED");
  });

  it("recognises a revoked permission", () => {
    expect(classifyFailure(new Error("(#200) Requires pages_messaging permission")))
      .toBe("PERMISSION_REVOKED");
  });

  it("recognises a rate limit", () => {
    expect(classifyFailure(new Error("Application request limit reached: rate limit")))
      .toBe("QUOTA_EXHAUSTED");
  });

  it("recognises a region restriction", () => {
    expect(classifyFailure(new Error("Direct messaging is not available in this region")))
      .toBe("REGION_INELIGIBLE");
  });

  /** An unclassified outage is still an outage, so it must not be dropped. */
  it("falls back to a delivery failure rather than losing the signal", () => {
    expect(classifyFailure(new Error("something nobody has seen before")))
      .toBe("DELIVERY_FAILING");
  });

  it("handles a thrown non-Error", () => {
    expect(classifyFailure("plain string")).toBe("DELIVERY_FAILING");
  });
});
