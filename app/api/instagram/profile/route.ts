import { NextRequest, NextResponse } from "next/server";
import { getSessionScope } from "@/lib/session";
import { accountWithToken } from "@/lib/accounts/directory";
import { adapterFor } from "@/lib/platforms/registry";

export const dynamic = "force-dynamic";

/**
 * Who a connected account is, for the campaign preview.
 *
 * The label comes from the directory, so a Facebook Page renders as its name
 * rather than "@My Business Page". The avatar comes from the adapter, and a
 * platform that exposes none simply returns null instead of this route sending
 * one platform's token to another platform's host.
 */
export async function GET(request: NextRequest) {
  const scope = await getSessionScope();
  if (!scope) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json(
      { success: false, error: "An account is required" },
      { status: 400 }
    );
  }

  const resolved = await accountWithToken(scope.workspaceId, accountId);
  if (!resolved) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const adapter = adapterFor(resolved.account.platform);
  let profilePictureUrl: string | null = null;
  try {
    profilePictureUrl =
      (await adapter.fetchProfileImage?.(
        resolved.accessToken,
        resolved.account.externalId
      )) ?? null;
  } catch {
    // The preview renders without an avatar rather than failing.
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        label: resolved.account.label,
        platform: resolved.account.platform,
        profilePictureUrl,
      },
    },
    { headers: { "Cache-Control": "private, max-age=300" } }
  );
}
