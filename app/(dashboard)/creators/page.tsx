"use client";

import { useEffect, useState } from "react";

/**
 * Creator invitations and where each one stopped.
 *
 * Delivery failure is shown as its own state rather than folded into "pending".
 * Cloudflare suppresses an address account-wide after a spam complaint, so an
 * invitation that was never delivered looks exactly like one the creator chose
 * to ignore unless the page says otherwise.
 */

type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

interface Invitation {
  id: string;
  email: string;
  creatorName: string | null;
  status: InvitationStatus;
  deliveredAt: string | null;
  deliveryError: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  workspace: { id: string; name: string } | null;
}

interface Stage {
  label: string;
  tone: string;
  detail: string | null;
}

/** Where the invitation actually is, which is not always its stored status. */
function stageOf(invite: Invitation): Stage {
  if (invite.status === "ACCEPTED") {
    return { label: "connected", tone: "text-emerald-600", detail: invite.workspace?.name ?? null };
  }
  if (invite.status === "REVOKED") {
    return { label: "revoked", tone: "text-muted", detail: null };
  }
  if (invite.deliveryError) {
    return { label: "not delivered", tone: "text-red-600", detail: invite.deliveryError };
  }
  if (invite.status === "EXPIRED" || Date.parse(invite.expiresAt) < Date.now()) {
    return { label: "expired", tone: "text-amber-600", detail: "invite is no longer valid" };
  }
  if (!invite.deliveredAt) {
    return { label: "sending", tone: "text-muted", detail: null };
  }
  return { label: "waiting on creator", tone: "text-muted", detail: "delivered, not yet accepted" };
}

type FetchResult =
  | { ok: true; invitations: Invitation[] }
  | { ok: false; error: string };

async function fetchInvitations(): Promise<FetchResult> {
  const response = await fetch("/api/admin/creators");
  const payload = await response.json();
  return payload.success
    ? { ok: true, invitations: payload.data.invitations }
    : { ok: false, error: payload.error ?? "Could not load creators." };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

export default function CreatorsPage() {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const result = await fetchInvitations();
      if (!active) return;
      if (result.ok) setInvitations(result.invitations);
      else setError(result.error);
      setLoading(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setInviteError(null);
    setInviting(true);

    const response = await fetch("/api/admin/creators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: email.trim(),
        creatorName: creatorName.trim() || undefined,
      }),
    });
    const payload = await response.json();

    setInviting(false);
    if (!payload.success) {
      setInviteError(payload.error ?? "Could not send the invitation.");
      return;
    }
    setEmail("");
    setCreatorName("");

    const result = await fetchInvitations();
    if (result.ok) setInvitations(result.invitations);
  }

  if (loading) return <div className="panel rounded p-8 h-64" />;

  if (error) {
    return (
      <div className="panel rounded p-6">
        <p className="text-sm text-muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Creators</h1>
        <p className="mt-1 text-sm text-muted">
          Invite a creator, then watch where the invitation gets to. They connect
          their own accounts, so you never hold their credentials.
        </p>
      </div>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">Invite a creator</h2>
        <form onSubmit={invite} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="creator@example.com"
            className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
          />
          <input
            value={creatorName}
            onChange={(e) => setCreatorName(e.target.value)}
            placeholder="Name (optional)"
            className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
          />
          <button
            type="submit"
            disabled={inviting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </form>
        {inviteError && <p className="mt-2 text-sm text-red-600">{inviteError}</p>}
      </section>

      <section className="panel rounded">
        {!invitations || invitations.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">
            No creators invited yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Creator</th>
                  <th className="px-4 py-3 font-medium">Stage</th>
                  <th className="px-4 py-3 font-medium">Invited</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invite) => {
                  const stage = stageOf(invite);
                  return (
                    <tr key={invite.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">
                          {invite.creatorName || invite.email}
                        </div>
                        {invite.creatorName && (
                          <div className="text-xs text-muted">{invite.email}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className={`font-medium ${stage.tone}`}>{stage.label}</div>
                        {stage.detail && (
                          <div className="text-xs text-muted">{stage.detail}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted">{formatDate(invite.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
