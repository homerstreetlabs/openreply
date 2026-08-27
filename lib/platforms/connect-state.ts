/**
 * The OAuth `state` parameter.
 *
 * Signed rather than stored, because the callback arrives on a different
 * request with no session guarantee and a database round trip on the redirect
 * path buys nothing. What it has to carry is which workspace asked, so a
 * callback cannot attach an account to somebody else's workspace, and that is
 * exactly what must not be forgeable.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireEnv } from "@/lib/env";
import type { Platform } from "@/app/generated/prisma/client";

/** Long enough to finish a consent screen, short enough that a leaked one dies. */
const STATE_TTL_MS = 15 * 60_000;

/**
 * Parsed rather than asserted. The signature proves we wrote it; it does not
 * prove an old deploy wrote the same shape.
 */
const STATE = z.object({
  workspaceId: z.string().min(1),
  platform: z.enum(["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK"]),
  slug: z.string().min(1),
  at: z.number(),
});

export interface ConnectState {
  readonly workspaceId: string;
  readonly platform: Platform;
  readonly slug: string;
}

export async function createState(state: ConnectState): Promise<string> {
  const payload = JSON.stringify({ ...state, at: Date.now() });
  const body = Buffer.from(payload).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Null when the signature does not match or the state has aged out. */
export async function readState(value: string | null): Promise<ConnectState | null> {
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  try {
    const parsed = STATE.safeParse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    );
    if (!parsed.success) return null;
    if (Date.now() - parsed.data.at > STATE_TTL_MS) return null;
    return {
      workspaceId: parsed.data.workspaceId,
      platform: parsed.data.platform,
      slug: parsed.data.slug,
    };
  } catch {
    return null;
  }
}

function sign(body: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET")).update(body).digest("hex");
}
