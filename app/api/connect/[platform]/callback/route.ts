import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken } from "@/lib/meta/oauth";
import { adapterFor } from "@/lib/platforms/registry";
import { lookupProviderApp } from "@/lib/platforms/provider-apps";
import { readState } from "@/lib/platforms/connect-state";
import { negotiate } from "@/lib/platforms/negotiate";
import type { ConnectedIdentity, Platform } from "@/lib/platforms/types";

export const runtime = "nodejs";

/**
 * The other half of the unified connect flow.
 *
 * One authorization can produce several accounts: a Facebook grant brings every
 * Page the person administers. So this stores a list, and the adapter decides
 * what that list is.
 *
 * Capabilities are negotiated here rather than assumed, because this is the only
 * moment the platform tells us what it actually granted and where the account is
 * registered. Both narrow what the account can do, and both are per-account.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
) {
  const baseUrl = getBaseUrl().replace(/\/$/, "");
  const { platform: raw } = await context.params;

  const params = request.nextUrl.searchParams;
  const error = params.get("error");
  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?connect=denied`);
  }

  const state = await readState(params.get("state"));
  const code = params.get("code");
  if (!state || !code) {
    return NextResponse.redirect(`${baseUrl}/settings?connect=invalid_state`);
  }

  const adapter = adapterFor(state.platform);

  try {
    const app = await lookupProviderApp(state.platform, state.slug);
    const identities = await adapter.oauth.exchange(
      app,
      code,
      `${baseUrl}/api/connect/${raw}/callback`
    );

    if (identities.length === 0) {
      return NextResponse.redirect(`${baseUrl}/settings?connect=nothing_to_connect`);
    }

    for (const identity of identities) {
      await store(state.platform, state.workspaceId, app.id, identity);
    }

    return NextResponse.redirect(`${baseUrl}/settings?connect=ok&count=${identities.length}`);
  } catch (err) {
    console.error("[Connect] Exchange failed:", err);
    return NextResponse.redirect(`${baseUrl}/settings?connect=failed`);
  }
}

async function store(
  platform: Platform,
  workspaceId: string,
  providerAppId: string,
  identity: ConnectedIdentity
): Promise<void> {
  const capabilities = negotiate({
    platform,
    region: identity.region,
    grantedScopes: identity.grantedScopes,
  });

  // Built field by field rather than passed through, because `DeclineReason` is
  // an interface and Prisma's JSON input needs a shape with an index signature.
  const declined: { [capability: string]: { code: string; message: string } } = {};
  for (const [capability, reason] of capabilities.declined) {
    declined[capability] = { code: reason.code, message: reason.message };
  }

  const shared = {
    username: identity.username,
    name: identity.displayName,
    accessToken: encryptToken(identity.accessToken),
    refreshToken: identity.refreshToken ? encryptToken(identity.refreshToken) : null,
    tokenExpiresAt: identity.expiresInSeconds
      ? new Date(Date.now() + identity.expiresInSeconds * 1000)
      : null,
    grantedCapabilities: [...capabilities.granted],
    region: capabilities.region,
    declinedCapabilities: declined,
    capabilitiesAt: new Date(),
    providerAppId: providerAppId.startsWith("env:") ? null : providerAppId,
  };

  await prisma.connectedAccount.upsert({
    where: { platform_instagramId: { platform, instagramId: identity.externalId } },
    create: { workspaceId, platform, instagramId: identity.externalId, ...shared },
    update: shared,
  });
}
