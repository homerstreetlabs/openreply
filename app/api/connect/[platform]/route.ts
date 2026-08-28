import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/session";
import { getBaseUrl } from "@/lib/env";
import { adapterFor } from "@/lib/platforms/registry";
import { lookupProviderApp, ProviderAppUnavailable } from "@/lib/platforms/provider-apps";
import { createState } from "@/lib/platforms/connect-state";
import { Platform } from "@/app/generated/prisma/client";

export const runtime = "nodejs";

/**
 * One connect route for every platform.
 *
 * Instagram and Facebook each had their own, which was fine for two and stops
 * being fine at four: the differences between them are the authorize URL and
 * the token exchange, and both of those already belong to the adapter.
 *
 * A platform whose developer app is not approved yet answers with what is being
 * waited on, rather than redirecting into an OAuth error the creator cannot act
 * on.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }

  const { platform: raw } = await context.params;
  const platform = parsePlatform(raw);
  if (!platform) {
    return NextResponse.json({ success: false, error: "Unknown platform" }, { status: 404 });
  }

  const adapter = adapterFor(platform);

  let app;
  try {
    app = await lookupProviderApp(platform);
  } catch (error) {
    if (error instanceof ProviderAppUnavailable) {
      return NextResponse.json(
        { success: false, error: error.message, code: "PLATFORM_UNCONFIGURED" },
        { status: 409 }
      );
    }
    throw error;
  }

  const redirectUri = `${getBaseUrl().replace(/\/$/, "")}/api/connect/${raw}/callback`;
  const state = await createState({ workspaceId, platform, slug: app.slug });

  return NextResponse.redirect(adapter.oauth.authorizeUrl(app, redirectUri, state));
}

/**
 * The path segment is untrusted, so it is checked against the enum's own values
 * rather than upper-cased and hoped for.
 */
function parsePlatform(value: string): Platform | null {
  const upper = value.toUpperCase();
  return Object.values(Platform).find((p) => p === upper) ?? null;
}
