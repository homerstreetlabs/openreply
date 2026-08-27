import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  COMMENT_JOB_NAME,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
  enqueue,
} from "@/lib/queue/client";
import { facebookAdapter } from "@/lib/platforms/facebook";
import type { Prisma } from "@/app/generated/prisma/client";

export const runtime = "nodejs";

/**
 * Facebook Pages webhook.
 *
 * Separate from the Instagram route because the two objects are configured in
 * different products in the Meta dashboard and an Instagram-Login app signs with
 * a different secret than the Meta app. One route trying every known secret gets
 * weaker with each platform added, so each route binds exactly one.
 *
 * Meta expects a 200 within 5 seconds and unsubscribes the app after an hour of
 * failures, so this verifies, enqueues, and answers. The audit write happens
 * after the response.
 */

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ success: false, error: "Verification failed" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const discovery = facebookAdapter.discovery;
  if (discovery.kind !== "webhook") {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

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
    switch (event.kind) {
      case "comment":
        await enqueue(
          COMMENT_JOB_NAME,
          {
            platform: "FACEBOOK",
            instagramAccountId: event.accountExternalId,
            commentId: event.commentId,
            commentText: event.commentText,
            commenterId: event.commenterId,
            commenterName: event.commenterName,
            mediaId: event.postId,
            source: "WEBHOOK",
          },
          `fb_comment_${event.accountExternalId}_${event.commentId}`
        );
        break;

      case "message":
        await enqueue(
          MESSAGE_JOB_NAME,
          {
            platform: "FACEBOOK",
            instagramAccountId: event.accountExternalId,
            messageId: event.messageId,
            messageText: event.messageText,
            senderId: event.senderId,
          },
          `fb_message_${event.accountExternalId}_${Buffer.from(event.messageId).toString("base64url")}`
        );
        break;

      case "postback":
        await enqueue(
          POSTBACK_JOB_NAME,
          {
            platform: "FACEBOOK",
            instagramAccountId: event.accountExternalId,
            userId: event.userId,
            payload: event.payload,
            mid: event.mid,
          },
          `fb_postback_${event.accountExternalId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`
        );
        break;

      case "read":
        break;
    }
  }

  // SAFETY: `payload` is the result of JSON.parse on a signature-verified body,
  // which is exactly what Prisma.InputJsonValue accepts.
  void prisma.webhookEvent
    .create({
      data: {
        route: "/api/webhook/facebook",
        object: "page",
        payload: payload as Prisma.InputJsonValue,
        status: events.length > 0 ? "PROCESSED" : "PENDING",
        processedAt: events.length > 0 ? new Date() : null,
      },
    })
    .catch(() => {});

  return NextResponse.json({ success: true }, { status: 200 });
}
