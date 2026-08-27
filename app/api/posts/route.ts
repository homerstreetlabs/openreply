import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { adapterFor } from "@/lib/platforms/registry";
import { decryptToken } from "@/lib/meta/oauth";
import { platformName } from "@/lib/campaigns/options";

/**
 * Posts for the campaign picker, on whichever network the account lives on.
 *
 * This replaces `/api/instagram/posts`, which called the Instagram Graph API
 * directly. Account lookup is not platform-filtered, so a Facebook Page id
 * resolved fine and then sent a Page token to `graph.instagram.com`. Going
 * through the adapter is what makes the picker work per platform rather than
 * per host.
 *
 * The response is `PostSummary`, not a Graph payload. The picker used to read
 * `media_type` and `thumbnail_url` straight off the wire, which made Instagram's
 * JSON the contract for every platform that followed it.
 */
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("accountId")
  );

  if (!account) {
    return NextResponse.json(
      { success: false, error: "No account connected. Connect one first." },
      { status: 400 }
    );
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const parsed = limitParam ? Number.parseInt(limitParam, 10) : 25;
  const limit = request.nextUrl.searchParams.get("all") === "true"
    ? 300
    : Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), 50)
      : 25;

  try {
    const accessToken = decryptToken(account.accessToken);
    const posts = await adapterFor(account.platform).listPosts(
      accessToken,
      account.instagramId,
      limit
    );
    return NextResponse.json({ success: true, data: posts });
  } catch (error) {
    console.error("[Posts] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: `Failed to fetch ${platformName(account.platform)} posts`,
      },
      { status: 500 }
    );
  }
}
