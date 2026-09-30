import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany, update } = vi.hoisted(() => ({ findMany: vi.fn(), update: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: { responseRun: { findMany, update } } }));
vi.mock("@/lib/queue/client", () => ({ enqueue: vi.fn(), COMMENT_JOB_NAME: "process-comment" }));

import { backfillCommenterNames } from "../lib/polling/comment-reconciler";

const comment = (id: string, authorName: string | null) => ({
  id,
  postId: "v1",
  text: "TTTEST",
  authorId: "opaque",
  authorName,
  createdAtMs: null,
  ownerHasReplied: false,
});

beforeEach(() => {
  findMany.mockReset();
  update.mockReset();
});

describe("naming runs the webhook started unnamed", () => {
  it("writes the listed display name onto the unnamed run for that comment", async () => {
    findMany.mockResolvedValue([{ id: "run_1", triggerKey: "c1" }]);

    await backfillCommenterNames("camp_1", [comment("c1", "recitefm"), comment("c2", "someone")]);

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      campaignId: "camp_1",
      counterpartyName: null,
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "run_1" }, data: { counterpartyName: "recitefm" } });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("skips the database entirely when the listing names nobody", async () => {
    await backfillCommenterNames("camp_1", [comment("c1", null)]);

    expect(findMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
