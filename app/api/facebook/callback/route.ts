/**
 * Retained alias for the Facebook OAuth callback.
 *
 * Connecting now starts at `/api/connect/<platform>` and returns to
 * `/api/connect/<platform>/callback`. This URL survives because it is
 * registered in the Meta app dashboard, which is a setting a human edits: every
 * existing install would break the moment this file went away, and it would
 * break at the redirect, after the creator had already granted consent.
 *
 * Retire it only once the dashboard lists the new URL and this one has seen no
 * traffic for a full connect cycle.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";
import {
  canOperatePage,
  exchangeCodeForPages,
  subscribePageToWebhooks,
} from "@/lib/platforms/facebook-oauth";

export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));

  if (error) return NextResponse.redirect(`${baseUrl}/settings?facebook=denied`);
  if (!code || !state) return NextResponse.redirect(`${baseUrl}/settings?facebook=invalid`);

  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=forbidden`);
  }

  try {
    const pages = await exchangeCodeForPages(code, `${baseUrl}/api/facebook/callback`);
    const operable = pages.filter(canOperatePage);

    if (operable.length === 0) {
      return NextResponse.redirect(`${baseUrl}/settings?facebook=no_pages`);
    }

    let connected = 0;
    for (const page of operable) {
      const taken = await prisma.connectedAccount.findUnique({
        where: { platform_instagramId: { platform: "FACEBOOK", instagramId: page.id } },
        select: { workspaceId: true },
      });
      if (taken && taken.workspaceId !== state.workspaceId) continue;

      let webhookSubscribed = false;
      try {
        webhookSubscribed = await subscribePageToWebhooks(page.id, page.accessToken);
      } catch (subscribeError) {
        console.warn("[Facebook Callback] Page subscribe failed:", subscribeError);
      }

      await prisma.connectedAccount.upsert({
        where: { platform_instagramId: { platform: "FACEBOOK", instagramId: page.id } },
        create: {
          workspaceId: state.workspaceId,
          platform: "FACEBOOK",
          instagramId: page.id,
          username: page.name,
          name: page.name,
          accessToken: encryptToken(page.accessToken),
          tokenExpiresAt: null,
          webhookSubscribed,
        },
        update: {
          workspaceId: state.workspaceId,
          username: page.name,
          name: page.name,
          accessToken: encryptToken(page.accessToken),
          tokenExpiresAt: null,
          webhookSubscribed,
        },
      });
      connected += 1;
    }

    if (connected === 0) {
      return NextResponse.redirect(`${baseUrl}/settings?facebook=already_connected`);
    }
    return NextResponse.redirect(`${baseUrl}/dashboard?connected=facebook&pages=${connected}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Facebook connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});
    return NextResponse.redirect(
      `${baseUrl}/settings?facebook=failed&reason=${encodeURIComponent(message.slice(0, 200))}`
    );
  }
}
