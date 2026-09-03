/**
 * The reviewer entry point: one URL that ends in a signed-in session.
 *
 * Handed to an app reviewer who cannot read the mailbox the magic link would
 * go to. See `lib/access/reviewer-link.ts` for why this exists and how it is
 * revoked.
 *
 * Deliberately not under `/api/auth`, where Auth.js owns a catch-all route.
 * Sitting beside it would make this depend on how Next orders a static segment
 * against a catch-all, which is a silent breakage if that ordering ever moves.
 */

import { NextResponse } from "next/server";
import { mintReviewerLink } from "@/lib/access/reviewer-link";

export const runtime = "nodejs";
// Mints a single-use token per request. A cached response would hand out a
// spent one.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  const link = await mintReviewerLink(key);

  // A wrong key and an unconfigured deployment look identical from outside, so
  // probing tells nobody whether reviewer access is switched on.
  if (link.kind === "refused") {
    return new NextResponse("Not found", { status: 404 });
  }

  // The token behind this URL is spent on redemption, so it must not be stored.
  return NextResponse.redirect(link.url, { headers: { "Cache-Control": "no-store" } });
}
