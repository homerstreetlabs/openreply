import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * How mail leaves a Worker.
 *
 * A Worker cannot SMTP to Cloudflare's own relay. Cloudflare IPs sit on the
 * Workers socket layer's disallowed list alongside localhost and private
 * addresses, so `smtps://smtp.mx.cloudflare.net:465` fails from inside a Worker
 * with "cannot connect to the specified address". The bridge is for clients
 * that are not Workers, which is why the documented recipe worked from a laptop
 * and took down sign-in in production.
 */

const { bindings, send, sendMail } = vi.hoisted(() => ({
  bindings: { current: null as { EMAIL?: { send: unknown } } | null },
  send: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("@/lib/cloudflare/bindings", () => ({ tryBindings: () => bindings.current }));
vi.mock("nodemailer", () => ({ createTransport: () => ({ sendMail }) }));

import { sendEmail, RecipientSuppressedError } from "../lib/email/send";

const email = { to: "creator@example.com", subject: "Hi", text: "t", html: "<p>t</p>" };

beforeEach(() => {
  vi.clearAllMocks();
  bindings.current = null;
  process.env.EMAIL_FROM = "OpenReply <login@recite.fm>";
  process.env.EMAIL_SERVER = "smtps://api_token:tok@smtp.mx.cloudflare.net:465";
  send.mockResolvedValue({ messageId: "m1" });
  sendMail.mockResolvedValue({ rejected: [], pending: [] });
});

describe("choosing a transport", () => {
  it("uses the binding inside a Worker, never SMTP", async () => {
    bindings.current = { EMAIL: { send } };

    await sendEmail(email);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "creator@example.com", from: process.env.EMAIL_FROM })
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  /** Scripts, tests and `next dev` are not Workers and can reach the bridge. */
  it("falls back to SMTP where there is no binding", async () => {
    await sendEmail(email);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails on a sender it was never given, rather than a placeholder domain", async () => {
    delete process.env.EMAIL_FROM;
    bindings.current = { EMAIL: { send } };

    await expect(sendEmail(email)).rejects.toThrow(/EMAIL_FROM/);
  });
});

/**
 * One spam complaint suppresses an address account-wide and removal is
 * rate-limited, so an unhandled suppression is a silent permanent lockout.
 */
describe("suppression", () => {
  it("is recognised through the binding", async () => {
    bindings.current = { EMAIL: { send } };
    send.mockRejectedValue(new Error("E_RECIPIENT_SUPPRESSED"));

    await expect(sendEmail(email)).rejects.toBeInstanceOf(RecipientSuppressedError);
  });

  it("is recognised through SMTP too", async () => {
    sendMail.mockRejectedValue(new Error("recipient is suppressed"));

    await expect(sendEmail(email)).rejects.toBeInstanceOf(RecipientSuppressedError);
  });
});
