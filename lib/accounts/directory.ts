/**
 * Which accounts a workspace has connected, and which one a page is looking at.
 *
 * Three places used to answer the first question separately —
 * `/api/instagram/accounts`, `/api/dashboard/stats`, and the overview route —
 * and they disagreed about the default. The one that mattered picked
 * `findFirst` ordered by `connectedAt desc` with no platform filter, so the
 * newest connection of any platform became "the Instagram account" and its
 * token went to `graph.instagram.com`.
 *
 * The answer to the second question is a route segment rather than a query
 * param, because a Next layout cannot read `searchParams` and so cannot
 * validate one. `/overview/[accountId]` is checked once, in the layout, for
 * every page beneath it.
 */

import { cache } from "react";
import { prisma } from "@/lib/db/client";
import { adapterFor } from "@/lib/platforms/registry";
import { accountLabel } from "@/lib/campaigns/options";
import type { Platform } from "@/app/generated/prisma/client";

/**
 * One connected account, as any surface refers to it.
 *
 * Never a bare id. A resolved account always carries its platform, so no caller
 * can dispatch on a string it has to look up again.
 */
export interface ConnectedAccountRef {
  readonly id: string;
  readonly platform: Platform;
  /** The platform's own id, and the key webhooks arrive under. */
  readonly externalId: string;
  /** Display name, already `@`-prefixed where the platform uses handles. */
  readonly label: string;
  /**
   * The raw handle or page name, unprefixed. Only for surfaces that imitate the
   * platform's own UI, like the campaign preview that shows a creator what
   * their DM looks like arriving. Everything that just names an account uses
   * `label`, so the prefixing rule lives in one place.
   */
  readonly username: string;
}

/** A read surface a platform either implements or does not. */
export type ReadFeature = "insights" | "conversations";

export interface PlatformGroup {
  readonly platform: Platform;
  readonly accounts: readonly ConnectedAccountRef[];
}

export interface AccountDirectory {
  readonly all: readonly ConnectedAccountRef[];
  /**
   * Only platforms with at least one connected account, so the pill row is
   * built from what exists rather than from the bare enum. A workspace with one
   * Instagram account sees one pill, not four with three dead.
   */
  readonly platforms: readonly PlatformGroup[];
  /**
   * Accounts whose adapter implements the feature.
   *
   * Asks the adapter, not the capability table. Facebook has claimed
   * `CONVERSATION_HISTORY` since the table was written with nothing behind it,
   * which is exactly why the inbox offered a Page and then failed.
   */
  supporting(feature: ReadFeature): readonly ConnectedAccountRef[];
  /** Where a bare `/overview` or `/inbox` redirects. Null when nothing qualifies. */
  defaultFor(feature: ReadFeature): ConnectedAccountRef | null;
  find(accountId: string): ConnectedAccountRef | null;
}

function toRef(row: {
  id: string;
  platform: Platform;
  instagramId: string;
  username: string;
}): ConnectedAccountRef {
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.instagramId,
    label: accountLabel(row.platform, row.username),
    username: row.username,
  };
}

function implementsFeature(platform: Platform, feature: ReadFeature): boolean {
  const adapter = adapterFor(platform);
  return feature === "insights"
    ? adapter.insights !== null
    : adapter.conversations !== null;
}

/**
 * One query per request.
 *
 * Memoized with React's `cache` so a layout and the page beneath it share the
 * lookup during a render pass. A Route Handler gets a passthrough, which is
 * correct: there is no render pass to scope a memo to.
 */
export const accountDirectory = cache(
  async (workspaceId: string): Promise<AccountDirectory> => {
    const rows = await prisma.connectedAccount.findMany({
      where: { workspaceId },
      orderBy: [{ platform: "asc" }, { connectedAt: "desc" }],
      select: { id: true, platform: true, instagramId: true, username: true },
    });

    const all = rows.map(toRef);

    const grouped = new Map<Platform, ConnectedAccountRef[]>();
    for (const account of all) {
      const existing = grouped.get(account.platform);
      if (existing) existing.push(account);
      else grouped.set(account.platform, [account]);
    }

    const platforms: PlatformGroup[] = [...grouped].map(([platform, accounts]) => ({
      platform,
      accounts,
    }));

    function supporting(feature: ReadFeature): ConnectedAccountRef[] {
      return all.filter((account) => implementsFeature(account.platform, feature));
    }

    return {
      all,
      platforms,
      supporting,
      defaultFor(feature) {
        return supporting(feature)[0] ?? null;
      },
      find(accountId) {
        return all.find((account) => account.id === accountId) ?? null;
      },
    };
  }
);

/**
 * One account, if it belongs to this workspace.
 *
 * The id comes off the URL, so it is untrusted. Returning null for an account
 * in someone else's workspace lets the caller answer 404 — an id that exists
 * but is not yours must be indistinguishable from one that does not exist, or
 * the response confirms it.
 */
export async function accountInWorkspace(
  workspaceId: string,
  accountId: string
): Promise<ConnectedAccountRef | null> {
  const directory = await accountDirectory(workspaceId);
  return directory.find(accountId);
}

/**
 * The account plus its decrypted token, for a surface that is about to call the
 * platform.
 *
 * Separate from `accountInWorkspace` so a page that only needs to name an
 * account never decrypts a credential it will not use.
 */
export async function accountWithToken(
  workspaceId: string,
  accountId: string
): Promise<{ account: ConnectedAccountRef; accessToken: string } | null> {
  const row = await prisma.connectedAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: {
      id: true,
      platform: true,
      instagramId: true,
      username: true,
      accessToken: true,
    },
  });
  if (!row) return null;

  const { decryptToken } = await import("@/lib/meta/oauth");
  return { account: toRef(row), accessToken: decryptToken(row.accessToken) };
}

/**
 * Whether a platform account may be connected to this workspace.
 *
 * An external id is unique across the install, so an account already connected
 * elsewhere cannot be claimed here. This is the one part of the old
 * `lib/instagram-accounts.ts` worth keeping: the rest of that file was a
 * `findFirst` with no platform filter, which is what sent a Page token to
 * `graph.instagram.com`.
 */
export async function canConnectAccount({
  workspaceId,
  externalId,
}: {
  workspaceId: string;
  externalId: string;
}): Promise<{ allowed: boolean; reason: "already_connected" | null }> {
  const existing = await prisma.connectedAccount.findUnique({
    where: { instagramId: externalId },
    select: { workspaceId: true },
  });

  if (existing && existing.workspaceId !== workspaceId) {
    return { allowed: false, reason: "already_connected" };
  }
  return { allowed: true, reason: null };
}
