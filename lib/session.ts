/**
 * Who is asking, resolved as few times as the runtime allows.
 *
 * `auth()` is not memoized — next-auth exports it raw (`node_modules/next-auth/lib/index.js`
 * has no React `cache()` wrapper) — so every call is another session lookup
 * against Postgres. The dashboard layout alone used to make two, one directly
 * and one through `getPlatformScope`.
 *
 * Inside a render pass React's `cache()` fixes that: the memo is scoped to the
 * pass, which is exactly a request, and it is the idiom the framework documents
 * for non-`fetch` work (`01-app/02-guides/authentication.md`, the DAL pattern;
 * `01-app/04-glossary.md` § Memoization). `use cache` is not an option here — it
 * requires `cacheComponents` and forbids `cookies()`, which is where the session
 * comes from.
 *
 * Route Handlers get nothing from it. React's `cache` returns a plain
 * passthrough when no dispatcher is installed (`react` 19.2.4,
 * `cjs/react.react-server.development.js`: `if (!dispatcher) return fn.apply(null, arguments)`),
 * and a Route Handler is not part of the component tree
 * (`01-app/03-api-reference/04-functions/fetch.md`: "Memoization does not apply
 * in Route Handlers"). A route that needs both the user and their workspace
 * must therefore ask once, with `getSessionScope`, rather than lean on a memo
 * that is not there.
 */

import { cache } from "react";
import { auth } from "@/lib/auth";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";

export const getSession = cache(async () => auth());

export const getCurrentUserId = cache(async (): Promise<string | null> => {
  const session = await getSession();
  return session?.user?.id ?? null;
});

/** The two things nearly every authenticated caller wants, from one lookup. */
export interface SessionScope {
  userId: string;
  workspaceId: string;
}

/**
 * One session lookup, then the workspace.
 *
 * The email needed to name a first workspace comes off the session, so the
 * separate `user.findUnique` the old `getCurrentWorkspaceId` made on that path
 * is gone too.
 */
export const getSessionScope = cache(async (): Promise<SessionScope | null> => {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return { userId, workspaceId: workspace.id };

  const created = await ensureWorkspaceForUser(userId, session?.user?.email);
  return { userId, workspaceId: created.id };
});

export const getCurrentWorkspaceId = cache(async (): Promise<string | null> => {
  const scope = await getSessionScope();
  return scope?.workspaceId ?? null;
});
