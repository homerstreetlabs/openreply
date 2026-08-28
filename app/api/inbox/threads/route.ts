import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionScope } from "@/lib/session";
import { accountWithToken } from "@/lib/accounts/directory";
import { adapterFor } from "@/lib/platforms/registry";

export const runtime = "nodejs";

const THREAD_LIMIT = 50;

const replySchema = z.object({
  accountId: z.string().min(1),
  recipientId: z.string().min(1),
  text: z.string().min(1).max(1000),
});

/**
 * Conversations for one account, on whichever network it lives on.
 *
 * Replaces `/api/instagram/conversations`, which resolved its account with a
 * lookup that had no platform filter and then called the Instagram Graph API
 * with whatever token came back.
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

  const conversations = adapterFor(resolved.account.platform).conversations;
  if (!conversations) {
    return NextResponse.json(
      { success: false, error: "This platform has no readable inbox" },
      { status: 400 }
    );
  }

  try {
    const threads = await conversations.listThreads(
      resolved.accessToken,
      resolved.account.externalId,
      THREAD_LIMIT
    );
    return NextResponse.json({ success: true, data: { threads } });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Could not load conversations",
      },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const scope = await getSessionScope();
  if (!scope) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid reply" }, { status: 400 });
  }

  const resolved = await accountWithToken(scope.workspaceId, parsed.data.accountId);
  if (!resolved) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const conversations = adapterFor(resolved.account.platform).conversations;
  if (!conversations?.reply) {
    return NextResponse.json(
      { success: false, error: "This platform does not allow replying from here" },
      { status: 400 }
    );
  }

  try {
    await conversations.reply(
      resolved.accessToken,
      resolved.account.externalId,
      parsed.data.recipientId,
      parsed.data.text
    );
    return NextResponse.json({ success: true, data: { sent: true } });
  } catch (error) {
    // The platform's own words. A reply outside the messaging window fails for
    // a reason the sender needs to read verbatim.
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Could not send the message",
      },
      { status: 502 }
    );
  }
}
