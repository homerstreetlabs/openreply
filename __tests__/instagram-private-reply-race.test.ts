import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { linkButton } = vi.hoisted(() => ({ linkButton: vi.fn() }));

vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendPrivateReplyWithLinkButton: linkButton,
}));

import { MetaApiError } from "../lib/meta/client";
import { instagramAdapter } from "../lib/platforms/instagram";

const alreadyHasAReply = () =>
  new MetaApiError(
    -1,
    2534023,
    "trace",
    "The comment that you are trying to reply to already has a reply. [code=-1 sub=2534023]"
  );

const send = () =>
  instagramAdapter.messaging!.sendPrivateReplyWithButtons(
    "token",
    "ig_account",
    "comment_1",
    "Here is the link",
    [{ title: "Open", url: "https://example.com" }]
  );

beforeEach(() => {
  vi.useFakeTimers();
  linkButton.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Production, 2026-10-08, one creator account: every private reply sent within 1.5s
 * of the campaign's own public reply on that comment was refused with
 * 2534023 (64 of 65), and every one sent later landed (26 of 26).
 */
describe("a private reply right after our public reply", () => {
  it("lands once the public reply has settled", async () => {
    linkButton
      .mockRejectedValueOnce(alreadyHasAReply())
      .mockResolvedValueOnce({ message_id: "mid_1", recipient_id: "igsid_1" });

    const result = send();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ messageId: "mid_1", discoveredUserId: "igsid_1" });
    expect(linkButton).toHaveBeenCalledTimes(2);
  });

  it("gives up when the comment really has been replied to", async () => {
    linkButton.mockRejectedValue(alreadyHasAReply());

    const result = send();
    const settled = expect(result).rejects.toThrow(/already has a reply/);
    await vi.runAllTimersAsync();

    await settled;
    expect(linkButton).toHaveBeenCalledTimes(3);
  });

  it("does not retry any other refusal", async () => {
    linkButton.mockRejectedValue(new MetaApiError(-1, 2534025, "trace", "invalid for a private reply"));

    const result = send();
    const settled = expect(result).rejects.toThrow(/invalid for a private reply/);
    await vi.runAllTimersAsync();

    await settled;
    expect(linkButton).toHaveBeenCalledTimes(1);
  });
});
