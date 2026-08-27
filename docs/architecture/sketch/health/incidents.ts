/**
 * Incidents and the platform-admin overview.
 *
 * Two requirements meet here, and it is worth naming the coincidence because
 * it decides the shape:
 *
 *   1. "Admins see health across all creators — what's working, which
 *      automations are failing, and why."
 *   2. Cloudflare Notifications has NO Workers alert type at all. There is no
 *      alerting on Worker error rate, queue backlog or failed cron. The
 *      research calls this the sharpest regression versus Vercel.
 *
 * So the admin overview is not a dashboard bolted on top of the send path — it
 * IS the alerting system, and every adapter is required to classify its
 * failures into a cross-platform vocabulary so that one view answers for four
 * platforms. `Failure.incident` on the adapter interface exists for this.
 *
 * ── Why not query the ledger ─────────────────────────────────────────────────
 *
 * The dominant access pattern is "every connected account across every
 * workspace, worst first". Answering that from `ResponseRun` is a scan over
 * the largest table in the system, growing with volume, to compute something
 * that changes rarely. So health is an INCIDENT LOG, written on the path that
 * already knows, and read directly.
 */

export type IncidentKind =
  // — connection —
  | "TOKEN_EXPIRED"
  | "TOKEN_REFRESH_FAILED"
  | "REAUTH_REQUIRED"
  | "PERMISSION_REVOKED"
  | "WEBHOOK_UNSUBSCRIBED"
  // — capability —
  | "REGION_INELIGIBLE"
  /** A capability shrank and a campaign's compiled plan no longer validates. */
  | "PLAN_INVALIDATED"
  // — throughput —
  | "QUOTA_EXHAUSTED"
  | "DELIVERY_FAILING"
  | "QUEUE_BACKLOG"
  // — platform moderation —
  /** TikTok shadow-hide, YouTube heldForReview. One concept, two platforms. */
  | "POLICY_HOLD"
  // — product —
  | "EMAIL_SUPPRESSED"
  | "NO_ACTIVE_CAMPAIGNS";

export type Severity = "INFO" | "WARNING" | "ERROR";

/**
 * One row per (account, kind) while OPEN. `Incident.openKey` holds `kind`
 * while the incident is open and NULL once resolved, under
 * `@@unique([connectedAccountId, openKey])`.
 *
 * That constraint is the whole deduplication strategy: `raise()` is an upsert
 * that increments `count` and bumps `lastSeenAt`, so 4,000 consecutive token
 * failures are ONE row with `count = 4000`, not 4,000 rows and not 4,000
 * alerts. The idempotency lives in the schema rather than in the caller, per
 * make-operations-idempotent, which means every future caller gets it for
 * free.
 */
export interface Incident {
  readonly id: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string | null;
  readonly campaignId: string | null;
  readonly kind: IncidentKind;
  readonly severity: Severity;
  readonly message: string;
  readonly detail: unknown;
  readonly count: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date | null;
  /** `kind` while open, null when resolved. Do not read; it exists for the constraint. */
  readonly openKey: IncidentKind | null;
}

/** Idempotent. Safe to call on every failed send. */
export async function raiseIncident(input: {
  readonly workspaceId: string;
  readonly connectedAccountId: string | null;
  readonly campaignId: string | null;
  readonly kind: IncidentKind;
  readonly severity: Severity;
  readonly message: string;
  readonly detail?: unknown;
}): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Called on the SUCCESS path: a successful send resolves `DELIVERY_FAILING`, a
 * successful refresh resolves `TOKEN_EXPIRED`. Auto-resolution is what keeps
 * the overview honest — an incident list that only grows is one nobody reads.
 */
export async function resolveIncident(
  connectedAccountId: string,
  kind: IncidentKind
): Promise<void> {
  throw new Error("not implemented");
}

// ─── The overview ────────────────────────────────────────────────────────────

/**
 * One row per connected account, across every workspace. This is the whole
 * admin landing page, and it is one indexed query plus one aggregate — no scan
 * of the run ledger.
 */
// ─── Facet observations: who is allowed to write what ────────────────────────

/**
 * GRAFTED from arena candidate 4.
 *
 * `ConnectedAccount.sent24h` / `failed24h` are rolling counters on the account
 * row, and four different processes want to touch that row: the executor after
 * a send, the token cron after a refresh, the sweep pacer after a discovery
 * pass, and the connect/eligibility path after capabilities change. Four
 * writers on one row is write contention on the hot path, and worse, it is
 * last-writer-wins on a row where each writer only knows a QUARTER of the truth
 * — the executor overwrites what the token cron just learned.
 *
 * Splitting health into facets with EXACTLY ONE WRITER each removes both
 * problems. Per separate-before-serializing-shared-state: each writer owns its
 * own state and the merge happens at the read boundary, in `accountHealth()`.
 *
 *   send        the executor          did the last response go out?
 *   auth        the token cron        is the token alive and correctly scoped?
 *   discovery   the sweep pacer       are we still finding triggers, and how fast?
 *   capability  connect + negotiate   what can this account no longer do?
 *
 * The `Incident` log stays the alerting spine and is unchanged: an incident is
 * a NAMED, DEDUPLICATED problem with a resolution lifecycle. A facet is the
 * latest observation of one dimension, always present, usually "OK". Incidents
 * answer "what is broken and since when"; facets answer "what is the current
 * state of each moving part". Rolling counters are derived from the `send`
 * facet rather than being a fifth writer to the account row.
 */
export type HealthFacet = "send" | "auth" | "discovery" | "capability";

export interface FacetObservation {
  readonly connectedAccountId: string;
  readonly facet: HealthFacet;
  readonly severity: Severity | "OK";
  /** One line a human reads without opening anything else. */
  readonly headline: string;
  readonly detail: Record<string, unknown> | null;
  readonly observedAt: Date;
}

/**
 * Split by facet at the INTERFACE, not by a `facet` argument, so the executor
 * physically cannot write the auth facet. A parameter would be a convention;
 * this is a type error.
 */
export interface HealthWriter {
  /** Executor only. Also advances the rolling send/failure counters. */
  send(o: Omit<FacetObservation, "facet">): Promise<void>;
  /** Token-refresh cron only. */
  auth(o: Omit<FacetObservation, "facet">): Promise<void>;
  /** Sweep pacer only. Carries quota pressure so a slowed sweep reads as
   *  "throttled, working as intended" rather than "broken". */
  discovery(
    o: Omit<FacetObservation, "facet"> & { readonly pressure: number }
  ): Promise<void>;
  /** Connect and re-negotiation only. */
  capability(
    o: Omit<FacetObservation, "facet"> & {
      readonly lost: readonly string[];
      readonly gained: readonly string[];
    }
  ): Promise<void>;
}

/**
 * Merge at the read boundary. An account is as unhealthy as its worst facet,
 * except that a `discovery` facet throttled by quota is NOT unhealthy — it is
 * the design working. Encoding that here keeps "we are rate-limited on purpose"
 * out of the incident log, where it would train operators to ignore it.
 */
export function rollUpFacets(
  facets: readonly FacetObservation[]
): { readonly status: "HEALTHY" | "DEGRADED" | "BROKEN"; readonly worst: FacetObservation | null } {
  throw new Error("not implemented");
}

export interface AccountHealthRow {
  readonly connectedAccountId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly creatorEmail: string;
  readonly platform: string;
  readonly handle: string;
  /** Worst open incident severity, or null when healthy. */
  readonly status: "HEALTHY" | "DEGRADED" | "BROKEN";
  readonly openIncidents: readonly Pick<
    Incident,
    "kind" | "severity" | "message" | "count" | "lastSeenAt"
  >[];
  readonly activeCampaigns: number;
  /** Rolling 24h, from counters on the account, not from a ledger scan. */
  readonly sent24h: number;
  readonly failed24h: number;
  /** Mirrored from the quota Durable Objects by a cron. Display only. */
  readonly budgets: readonly {
    readonly label: string;
    readonly used: number;
    readonly capacity: number;
    readonly resetsAt: Date;
  }[];
  readonly lastDeliveryAt: Date | null;
  readonly nextSweepAt: Date | null;
}

/**
 * `scope` decides visibility, and it is the ONLY thing that does — a
 * `WorkspaceScope` sees its own accounts, a `PlatformScope` sees all of them.
 * Same function, same query, one filter derived from `readableWorkspaces`.
 * The creator's own health page and the admin overview are therefore the same
 * code, which is the only way they stay consistent.
 */
export async function accountHealth(
  scope: import("../tenancy/scope").TenantScope,
  opts: { readonly worstFirst?: boolean; readonly platform?: string }
): Promise<readonly AccountHealthRow[]> {
  throw new Error("not implemented");
}

/**
 * The "what's working" half. Deliberately a separate call from
 * `accountHealth`: the overview page loads health first and paints, then loads
 * throughput — because health is small and instant and throughput is an
 * aggregate.
 */
export async function throughputSummary(
  scope: import("../tenancy/scope").TenantScope,
  window: { readonly from: Date; readonly to: Date }
): Promise<{
  readonly byPlatform: readonly {
    readonly platform: string;
    readonly sent: number;
    readonly failed: number;
    readonly skippedDedup: number;
    readonly skippedQuota: number;
  }[];
  readonly queueBacklog: number;
  readonly deadLetterCount: number;
}> {
  throw new Error("not implemented");
}

/**
 * Cloudflare Queues exposes `metrics()` -> `{ backlogCount, backlogBytes,
 * oldestMessageTimestamp }`. That is less than BullMQ's per-state
 * `getJobCounts`, but `oldestMessageTimestamp` is a BETTER liveness signal than
 * today's 30-second worker heartbeat: a heartbeat proves a process is running,
 * whereas an old oldest-message proves work is not being done, which is the
 * question the diagnostics page is actually asking.
 *
 * Raises `QUEUE_BACKLOG` past a threshold, which is how a stalled consumer
 * becomes visible with no Cloudflare alerting available.
 */
export async function pollQueueHealth(): Promise<void> {
  throw new Error("not implemented");
}
