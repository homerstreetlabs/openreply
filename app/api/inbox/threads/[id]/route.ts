import { NextRequest, NextResponse } from "next/server";
import { getSessionScope } from "@/lib/session";
import { accountWithToken } from "@/lib/accounts/directory";
import { adapterFor } from "@/lib/platforms/registry";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const scope = await getSessionScope();
  if (!scope) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
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

  const conversations = adapterFor(resolved.account.platform).conversations;
  if (!conversations) {
    return NextResponse.json(
      { success: false, error: "This platform has no readable inbox" },
      { status: 400 }
    );
  }

  try {
    const messages = await conversations.readThread(
      resolved.accessToken,
      resolved.account.externalId,
      id
    );
    return NextResponse.json({ success: true, data: { messages } });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Could not load the conversation",
      },
      { status: 502 }
    );
  }
}
