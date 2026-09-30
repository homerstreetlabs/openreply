import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { COMMENT_JOB_NAME, enqueue } from "@/lib/queue/client";
import { tiktokAdapter } from "@/lib/platforms/tiktok";
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
 * unset. Accepting unverified bodies would let anyone enqueue sends on any
 * connected account.
 */

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

  for (const event of events) {
    // TikTok cannot be sent a DM, so a comment here can only ever become a
    // public reply. The worker branches on the adapter's capability, not on the
    // platform name, so nothing needs to say that twice.
    if (event.kind !== "comment") continue;
    // Threaded replies include the account's own replies, and acting on those
    // lets an any-word campaign answer itself forever.
    if (event.parentCommentId !== undefined) continue;

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
