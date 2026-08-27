import { describe, it, expect } from "vitest";
import { draftFromColumns } from "../lib/campaigns/from-columns";
import { compile } from "../lib/campaigns/compile";
import { platformCeiling } from "../lib/campaigns/steps";

const base = {
  dmMessage: "here is the link {link}",
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  requireFollow: false,
  followPromptMessage: null,
  followPromptButtonLabel: null,
  followUpEnabled: false,
  followUpMessage: null,
  followUpDelayMinutes: 0,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
};

const ig = platformCeiling("INSTAGRAM");

describe("reading a campaign's columns as a plan", () => {
  it("makes the simplest campaign one direct message", () => {
    expect(draftFromColumns(base).map((s) => s.kind)).toEqual(["directMessage"]);
  });

  it("sends link buttons when the campaign has tracked links", () => {
    expect(draftFromColumns(base, ["abc"]).map((s) => s.kind)).toEqual(["linkButtons"]);
  });

  it("orders the public reply and the follow gate ahead of the DM", () => {
    const draft = draftFromColumns({
      ...base,
      publicReplyEnabled: true,
      publicReplyMessages: ["one", "two"],
      requireFollow: true,
      followPromptMessage: "follow me first",
    });

    expect(draft.map((s) => s.kind)).toEqual(["publicReply", "followGate", "directMessage"]);
  });

  /**
   * With a conversation already open, the payload goes inside it rather than
   * spending the comment's one private reply.
   */
  it("turns an opening DM into a parked step plus a conversation message", () => {
    const draft = draftFromColumns({
      ...base,
      openingDmEnabled: true,
      openingDmMessage: "tap to get it",
      openingDmButtonLabel: "send it",
    });

    expect(draft.map((s) => s.kind)).toEqual(["openingDm", "conversationMessage"]);
    const parked = draft[0] as { awaits: { signals: string[]; onTimeout: string } };
    expect(parked.awaits.signals).toEqual(["postback", "read"]);
    expect(parked.awaits.onTimeout).toBe("continue");
  });

  it("appends the follow-up with its own delay", () => {
    const draft = draftFromColumns({
      ...base,
      followUpEnabled: true,
      followUpMessage: "how did you get on?",
      followUpDelayMinutes: 60,
    });

    expect(draft.map((s) => s.kind)).toEqual(["directMessage", "followUp"]);
    const followUp = draft[1] as { awaits: { timeoutMs: number } };
    expect(followUp.awaits.timeoutMs).toBe(3_600_000);
  });

  it("produces a plan the compiler accepts", () => {
    const draft = draftFromColumns({
      ...base,
      publicReplyEnabled: true,
      publicReplyMessages: ["one", "two"],
      requireFollow: true,
      followPromptMessage: "follow me first",
      openingDmEnabled: true,
      openingDmMessage: "tap to get it",
      openingDmButtonLabel: "send it",
      followUpEnabled: true,
      followUpMessage: "how did you get on?",
      followUpDelayMinutes: 60,
    });

    const result = compile("INSTAGRAM", ig, draft);

    expect(result.ok).toBe(true);
  });

  it("produces a plan YouTube refuses, because the DM leg cannot run there", () => {
    const result = compile("YOUTUBE", platformCeiling("YOUTUBE"), draftFromColumns(base));

    expect(result.ok).toBe(false);
  });
});
