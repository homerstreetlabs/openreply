import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { COMMENT_JOB_NAME, enqueue } from "@/lib/queue/client";
import { tiktokAdapter } from "@/lib/platforms/tiktok";
import { decryptToken } from "@/lib/meta/oauth";
import type { PlatformEvent } from "@/lib/platforms/types";
import type { Prisma } from "@/app/generated/prisma/client";

export const runtime = "nodejs";

/**
 * TikTok comment webhook.
 *
 * TikTok has no `hub.challenge` handshake. The portal checks the URL answers a
 * POST, so the GET here exists only for reachability and deliberately echoes
 * nothing back.
 *
 * The adapter's signature check fails closed while `TIKTOK_WEBHOOK_SECRET` is
 * unset, because TikTok does not document the signing scheme. That means this
 * route rejects everything until the secret is configured and the scheme is
 * confirmed against a real delivery. Accepting unverified bodies to make the
 * route look finished would let anyone enqueue sends on any connected account.
 */

/**
 * Keep only the events TikTok's own API still reports.
 *
 * An account we do not have cannot be re-read, and an event for one is dropped
 * rather than trusted: it is exactly what a forged payload would look like.
 */
async function confirmAgainstApi(
  events: readonly PlatformEvent[]
): Promise<PlatformEvent[]> {
  const confirmed: PlatformEvent[] = [];

  for (const event of events) {
    if (event.kind !== "comment") continue;

    const account = await prisma.connectedAccount.findUnique({
      where: {
        platform_instagramId: { platform: "TIKTOK", instagramId: event.accountExternalId },
      },
      select: { accessToken: true },
    });
    if (!account) continue;

    try {
      const token = decryptToken(account.accessToken);
      const live = await tiktokAdapter.listRecentComments(token, event.accountExternalId, {
        postIds: [event.postId],
        sinceMs: 0,
      });
      const match = live.find((c) => c.id === event.commentId);
      if (!match) continue;

      // Take the text TikTok reports, not the text the payload claimed. A
      // forged body could otherwise choose which keyword it matched.
      confirmed.push({ ...event, commentText: match.text, commenterId: match.authorId });
    } catch (error) {
      console.error("[TikTok webhook] Could not confirm comment:", error);
    }
  }

  return confirmed;
}

export async function GET() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(request: NextRequest) {
  const discovery = tiktokAdapter.discovery;
  if (discovery.kind !== "webhook") {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("tiktok-signature");

  if (!discovery.verifySignature(rawBody, signature)) {
    return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const events = discovery.parseEvents(payload);

  // Defence in depth, and not belt-and-braces. TikTok documents no signing
  // scheme, so the check above is an educated guess at an algorithm nobody has
  // confirmed. Re-reading the comment from TikTok's own API before acting means
  // a forged payload that somehow passed the signature still cannot make a
  // creator's account post anything: the comment either exists with that text
  // or the event is dropped.
  //
  // The webhook carries `text`, so this costs a call we would not otherwise
  // make. That is the price of acting on an unverified signature, and it comes
  // off once the scheme is confirmed against a real delivery.
  const confirmed = await confirmAgainstApi(events);

  for (const event of confirmed) {
    // TikTok cannot be sent a DM, so a comment here can only ever become a
    // public reply. The worker branches on the adapter's capability, not on the
    // platform name, so nothing needs to say that twice.
    if (event.kind !== "comment") continue;

    await enqueue(
      COMMENT_JOB_NAME,
      {
        platform: "TIKTOK",
        instagramAccountId: event.accountExternalId,
        commentId: event.commentId,
        commentText: event.commentText,
        commenterId: event.commenterId,
        commenterName: event.commenterName,
        mediaId: event.postId,
        source: "WEBHOOK",
      },
      `tt_comment_${event.accountExternalId}_${event.commentId}`
    );
  }

  // SAFETY: `payload` is the result of JSON.parse on a signature-verified body,
  // which is exactly what Prisma.InputJsonValue accepts.
  void prisma.webhookEvent
    .create({
      data: {
        route: "/api/webhook/tiktok",
        object: "tiktok",
        payload: payload as Prisma.InputJsonValue,
        status: events.length > 0 ? "PROCESSED" : "PENDING",
        processedAt: events.length > 0 ? new Date() : null,
      },
    })
    .catch(() => {});

  return NextResponse.json({ success: true }, { status: 200 });
}
