"use client";

/**
 * Who can get in, and with what authority.
 *
 * Admins and Creators are listed apart because they are different kinds of
 * access, not two levels of one. An admin holds install-wide authority through
 * a PlatformGrant and usually owns no workspace; a creator owns a workspace and
 * has no authority outside it. Calling both "admin" is the ambiguity this page
 * exists to remove.
 */

import { useCallback, useEffect, useState } from "react";

import type { PersonView, People } from "@/lib/access/people";
import type { PlatformGrantTier, UserStatus } from "@/app/generated/prisma/client";

const TIER_LABELS = {
  SUPPORT_READ: "Support (read only)",
  SUPPORT_FULL: "Support (full)",
  ADMIN: "Admin",
} satisfies Record<PlatformGrantTier, string>;

const TIERS: readonly PlatformGrantTier[] = ["SUPPORT_READ", "SUPPORT_FULL", "ADMIN"];

function displayName(person: PersonView): string {
  return person.name ?? person.email ?? person.userId;
}

export default function UsersPage() {
  const [people, setPeople] = useState<People | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/users");
    const payload = await response.json();
    if (payload.success) {
      setPeople(payload.data);
      setError(null);
    } else {
      setError(payload.error ?? "Could not load people.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /** The three writes this page can make, named so the caller cannot invent a fourth. */
  type Write =
    | { method: "POST"; body: { userId: string; tier: PlatformGrantTier; reason: string } }
    | { method: "DELETE"; body: { grantId: string } }
    | { method: "PATCH"; body: { userId: string; status: UserStatus } };

  async function send({ method, body }: Write, key: string) {
    setBusy(key);
    setError(null);
    const response = await fetch("/api/admin/users", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (payload.success) setPeople(payload.data);
    else setError(payload.error ?? "That did not work.");
    setBusy(null);
  }

  function grant(person: PersonView, tier: PlatformGrantTier) {
    const reason = prompt(
      `Why does ${displayName(person)} need ${TIER_LABELS[tier]} access?`
    );
    if (!reason?.trim()) return;
    void send(
      { method: "POST", body: { userId: person.userId, tier, reason: reason.trim() } },
      `grant:${person.userId}`
    );
  }

  function setStatus(person: PersonView, status: UserStatus) {
    if (
      status === "SUSPENDED" &&
      !confirm(
        `Suspend ${displayName(person)}? They will not be able to sign in. Their workspace, accounts and campaigns are left untouched.`
      )
    ) {
      return;
    }
    void send(
      { method: "PATCH", body: { userId: person.userId, status } },
      `status:${person.userId}`
    );
  }

  if (error && !people) {
    return (
      <div className="panel rounded p-6">
        <p className="text-sm text-muted">{error}</p>
      </div>
    );
  }

  if (!people) return <div className="panel h-64 rounded p-8" />;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Users</h1>
        <p className="mt-1 text-sm text-muted">
          Nobody can sign up on their own. Everyone here was either invited or
          granted access.
        </p>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">Admins</h2>
        <p className="mt-1 text-sm text-muted">
          Install-wide access to every creator&apos;s data. Each use is recorded
          separately from the grant itself.
        </p>

        <div className="mt-4 space-y-3">
          {people.admins.length === 0 && (
            <p className="py-6 text-sm text-muted">No admins yet.</p>
          )}
          {people.admins.map((person) => (
            <div
              key={person.userId}
              className="flex flex-col gap-3 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {displayName(person)}
                  {person.status === "SUSPENDED" && (
                    <span className="ml-2 text-xs font-normal text-error">
                      suspended
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {person.grant && TIER_LABELS[person.grant.tier]}
                  {person.grant?.expiresAt
                    ? ` · expires ${new Date(person.grant.expiresAt).toLocaleDateString()}`
                    : " · no expiry"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy === `status:${person.userId}`}
                  onClick={() =>
                    setStatus(person, person.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")
                  }
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-border-hover hover:text-foreground disabled:opacity-50"
                >
                  {person.status === "ACTIVE" ? "Suspend" : "Reinstate"}
                </button>
                <button
                  type="button"
                  disabled={busy === `revoke:${person.userId}`}
                  onClick={() =>
                    person.grant &&
                    void send(
                      { method: "DELETE", body: { grantId: person.grant.id } },
                      `revoke:${person.userId}`
                    )
                  }
                  className="rounded-lg border border-error/20 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
                >
                  Revoke access
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">Creators</h2>
        <p className="mt-1 text-sm text-muted">
          Each owns one workspace and connects their own accounts. Promoting one
          gives them access to everybody else&apos;s.
        </p>

        <div className="mt-4 space-y-3">
          {people.creators.length === 0 && (
            <p className="py-6 text-sm text-muted">No creators yet.</p>
          )}
          {people.creators.map((person) => (
            <div
              key={person.userId}
              className="flex flex-col gap-3 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {displayName(person)}
                  {person.status === "SUSPENDED" && (
                    <span className="ml-2 text-xs font-normal text-error">
                      suspended
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {person.workspace
                    ? `${person.workspace.name} · ${person.workspace.accounts} connected`
                    : "No workspace yet"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  defaultValue=""
                  disabled={busy === `grant:${person.userId}`}
                  onChange={(event) => {
                    const tier = TIERS.find((entry) => entry === event.target.value);
                    if (tier) grant(person, tier);
                    event.target.value = "";
                  }}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground"
                >
                  <option value="">Give access…</option>
                  {TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {TIER_LABELS[tier]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy === `status:${person.userId}`}
                  onClick={() =>
                    setStatus(person, person.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")
                  }
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-border-hover hover:text-foreground disabled:opacity-50"
                >
                  {person.status === "ACTIVE" ? "Suspend" : "Reinstate"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">
          Invited, not yet signed in
        </h2>
        <div className="mt-4 space-y-3">
          {people.pending.length === 0 && (
            <p className="py-6 text-sm text-muted">No invitations outstanding.</p>
          )}
          {people.pending.map((invite) => (
            <div
              key={`${invite.kind}:${invite.id}`}
              className="border-b border-border py-3 last:border-0"
            >
              <p className="text-sm font-medium text-foreground">{invite.email}</p>
              <p className="text-xs text-muted">
                {invite.kind === "creator" ? "Creator invitation" : "Workspace invitation"}
                {invite.invitedBy ? ` from ${invite.invitedBy}` : ""} · expires{" "}
                {new Date(invite.expiresAt).toLocaleDateString()}
              </p>
              {invite.deliveryError && (
                <p className="mt-1 text-xs text-error">{invite.deliveryError}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
