/**
 * Connecting a Facebook Page.
 *
 * Uses Facebook Login for Business, which is a different flow from the
 * Instagram Business Login the Instagram accounts use. The two coexist by
 * design and use different client ids, so adding this does not touch the
 * Instagram path. See docs/setup.md#facebook-setup.
 *
 * One user authorisation yields many Pages. Each Page is stored as its own
 * connected account, because a Page is what receives webhooks and what a
 * campaign targets.
 */

import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";

const FACEBOOK_OAUTH_URL = "https://www.facebook.com/v25.0/dialog/oauth";

function graphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

/**
 * The permissions this flow actually uses, which is a subset of what the
 * "Engage with customers on Messenger from Meta" use case grants.
 *
 * `pages_manage_metadata` and `pages_show_list` are what the `feed` comment
 * webhook needs, and `pages_messaging` is the only permission the private reply
 * itself needs. `pages_read_engagement` is an optional on the same use case,
 * and reads `can_reply_privately` before the one allowed reply is spent.
 * Adding `pages_manage_engagement` for public comment replies requires the
 * separate "Manage everything on your Page" use case.
 *
 * `business_management` is deliberately absent. The use case grants it as
 * required and non-removable, so it still belongs in the App Review submission
 * (see docs/app-review.md), but nothing here calls a Business Manager
 * endpoint: Pages come from `/me/accounts` under `pages_show_list`, and the
 * webhook subscribe uses the Page token. Asking for it at the consent screen
 * would request authority the app never exercises.
 */
export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
] as const;

export function getFacebookAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("FACEBOOK_APP_ID"),
    redirect_uri: redirectUri,
    scope: FACEBOOK_SCOPES.join(","),
    response_type: "code",
    state,
  });
  return `${FACEBOOK_OAUTH_URL}?${params.toString()}`;
}

export interface FacebookPage {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
}

/**
 * Exchange the code for a Page token, in the order that matters.
 *
 * The short-lived user token must become long-lived BEFORE Page tokens are
 * derived from it. Page tokens derived from a long-lived user token do not
 * expire; derive them from the short-lived one and they inherit its lifetime.
 */
export async function exchangeCodeForPages(
  code: string,
  redirectUri: string
): Promise<FacebookPage[]> {
  const shortLived = await exchangeCode(code, redirectUri);
  const longLived = await exchangeForLongLivedUserToken(shortLived);
  return listPages(longLived);
}

async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const url = new URL(`${graphBase()}/oauth/access_token`);
  url.searchParams.set("client_id", requireEnv("FACEBOOK_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("FACEBOOK_APP_SECRET"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString());
  // SAFETY: every field is optional, and the guard below rejects the response
  // unless `access_token` is actually present.
  const data = (await response.json()) as { access_token?: string; error?: { message?: string } };
  if (!response.ok || !data.access_token) {
    throw new Error(`Facebook code exchange failed: ${data.error?.message ?? response.status}`);
  }
  return data.access_token;
}

async function exchangeForLongLivedUserToken(shortLivedToken: string): Promise<string> {
  const url = new URL(`${graphBase()}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", requireEnv("FACEBOOK_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("FACEBOOK_APP_SECRET"));
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const response = await fetch(url.toString());
  // SAFETY: as above, all fields optional and the guard proves the one we use.
  const data = (await response.json()) as { access_token?: string; error?: { message?: string } };
  if (!response.ok || !data.access_token) {
    throw new Error(`Facebook long-lived exchange failed: ${data.error?.message ?? response.status}`);
  }
  return data.access_token;
}

async function listPages(userToken: string): Promise<FacebookPage[]> {
  const url = new URL(`${graphBase()}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,tasks");
  url.searchParams.set("access_token", userToken);

  const response = await fetch(url.toString());
  // SAFETY: `data` is optional and defaulted to [] below, so a shape mismatch
  // yields no pages rather than a crash.
  const data = (await response.json()) as {
    data?: Array<{ id: string; name: string; access_token: string; tasks?: string[] }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(`Facebook page list failed: ${data.error?.message ?? response.status}`);
  }

  return (data.data ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    tasks: page.tasks ?? [],
  }));
}

/**
 * Subscribe a Page to the fields this product reads. `feed` carries comments,
 * including comments on Reels. Meta unsubscribes an app after an hour of
 * webhook failures, so a Page that stops delivering needs re-subscribing rather
 * than debugging in the dashboard.
 */
export async function subscribePageToWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<boolean> {
  const url = new URL(`${graphBase()}/${pageId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "feed,messages,messaging_postbacks");
  url.searchParams.set("access_token", pageAccessToken);

  const response = await fetch(url.toString(), { method: "POST" });
  // SAFETY: both fields optional; `success` is coerced with Boolean() below.
  const data = (await response.json()) as { success?: boolean; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(`Page subscribe failed: ${data.error?.message ?? response.status}`);
  }
  return Boolean(data.success);
}

/**
 * Whether the connecting user can actually operate this Page. `MESSAGING` is
 * required to send a private reply and `MODERATE` to receive `feed` webhooks.
 * A Page the user merely has analytics access to would connect and then
 * silently never work.
 */
export function canOperatePage(page: FacebookPage): boolean {
  return page.tasks.includes("MESSAGING") || page.tasks.includes("MODERATE");
}
