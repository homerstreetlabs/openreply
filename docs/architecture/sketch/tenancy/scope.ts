/**
 * Tenancy: creator, workspace, platform admin.
 *
 * Today every API route calls `getCurrentWorkspaceId()`, which returns the
 * FIRST workspace the user belongs to, ordered by `createdAt`. "Admins should
 * see an overview across all creator accounts" has nowhere to live in that
 * model — and rewriting ~30 routes to take a workspace argument would be a
 * large, risky diff across the part of the system that currently works.
 *
 * So the change is a NARROWING, not a rewrite. `TenantScope` is a discriminated
 * union with two shapes, and `requireWorkspace(scope)` is the exact function
 * today's routes already effectively call. An existing route changes by one
 * import. A new admin route calls `requirePlatformAdmin()` instead and gets a
 * scope that CANNOT be passed where a workspace is required — the type forbids
 * it, so an admin endpoint cannot accidentally write to a creator's data.
 */

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER";

/**
 * Cross-creator access, orthogonal to workspace membership. A platform admin is
 * not a member of every workspace and must never become one, because membership
 * is what a creator sees in their own member list.
 *
 * GRAFTED from arena candidate 2: this is resolved from `PlatformGrant` ROWS,
 * not a column on `User`. The tier below is the standing permission; each USE of
 * it writes an `AdminAccessLog` row. A column could answer "is this person an
 * admin?" and nothing else — not who granted it, when it expires, or who could
 * read a given creator's inbox last March.
 */
export type PlatformGrantTier =
  /**
   * Fleet health only: account status, incident kinds and counts, quota
   * headroom, send/failure counts. **Excludes message and comment bodies.**
   *
   * This tier is deliberately the useful one. Almost every support question —
   * "why did this automation stop firing?" — is answerable from statuses, error
   * taxonomies and timestamps. Making the restricted tier sufficient is what
   * stops people reaching for the unrestricted one out of habit.
   */
  | "SUPPORT_READ"
  /** Adds message and comment content. Every read is logged. */
  | "SUPPORT_FULL"
  /**
   * Adds acting inside a workspace via `assumeWorkspace` (writes stamped with
   * `onBehalfOfAdminId`), creator enrollment, provider-app config, and issuing
   * or revoking grants.
   */
  | "ADMIN";

/** An active grant, resolved once per request. */
export interface ActivePlatformGrant {
  readonly tier: PlatformGrantTier;
  readonly grantId: string;
  /** Null means indefinite. Support grants should carry one. */
  readonly expiresAt: Date | null;
}

export type TenantScope =
  | {
      readonly kind: "workspace";
      readonly userId: string;
      readonly workspaceId: string;
      readonly role: WorkspaceRole;
      /**
       * Set when a platform admin is acting inside a creator's workspace for
       * support. Every write made under it is stamped with this id, so
       * "who changed my campaign?" has an answer. Nulled for a creator's own
       * session — the ordinary path is unaffected.
       */
      readonly onBehalfOfAdminId: string | null;
    }
  | {
      readonly kind: "platform";
      readonly userId: string;
      /**
       * The highest active tier, resolved from `PlatformGrant` at request time.
       * There is no `"NONE"`: a user with no active grant cannot obtain a
       * `PlatformScope` at all, so "not an admin" is the absence of this value
       * rather than a value meaning nothing.
       */
      readonly tier: PlatformGrantTier;
      readonly grant: ActivePlatformGrant;
    };

export type WorkspaceScope = Extract<TenantScope, { kind: "workspace" }>;
export type PlatformScope = Extract<TenantScope, { kind: "platform" }>;

/**
 * The drop-in replacement for `getCurrentWorkspaceContext()`. Same behaviour
 * for a creator with one workspace; throws `Unauthorized` rather than
 * returning null, so a forgotten null-check cannot leak data.
 */
export async function requireWorkspace(minimumRole?: WorkspaceRole): Promise<WorkspaceScope> {
  throw new Error("not implemented");
}

/** Admin-only routes. Returns a scope with no `workspaceId` — by construction. */
export async function requirePlatformAdmin(
  minimum: PlatformGrantTier
): Promise<PlatformScope> {
  // TODO: resolve active grants for the session user:
  //   revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now())
  // Take the highest tier; throw Unauthorized when the set is empty or below
  // `minimum`. An expired grant is indistinguishable from never having had one,
  // which is the point of putting an expiry on it.
  throw new Error("not implemented");
}

/**
 * Enter a creator's workspace as an admin, for support. The returned scope
 * carries `onBehalfOfAdminId`, and the entry itself is recorded as an
 * `AdminAccessLog` row — impersonation without an audit trail is how a support
 * feature becomes a compliance problem.
 */
export async function assumeWorkspace(
  admin: PlatformScope,
  workspaceId: string,
  reason: string
): Promise<WorkspaceScope> {
  throw new Error("not implemented");
}

export function canManageWorkspace(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Every cross-workspace query goes through here so "which workspaces may this
 * scope read?" has exactly one implementation. A `workspace` scope returns its
 * single id; a `platform` scope returns `"all"`, which the query layer turns
 * into an unfiltered read. Making this a function rather than a convention is
 * what stops a future admin route from forgetting the filter.
 */
export function readableWorkspaces(scope: TenantScope): readonly string[] | "all" {
  throw new Error("not implemented");
}
