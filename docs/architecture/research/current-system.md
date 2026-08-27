# Phase A grounding — OpenReply as it exists today

Traced from source on 2026-08-24. Every claim below is a fact about the current
repo, not an aspiration. Line references are `path:line` where useful.

## 1. What the product does

OpenReply is a self-hostable "ManyChat for Instagram": someone comments a keyword
on a connected Instagram professional account's post or reel, and OpenReply sends
that commenter a private DM through Meta's official Instagram API. It optionally
posts a public reply under the comment at the same time.

Feature list as implemented (not as marketed):

| Feature | Where it lives |
| --- | --- |
| Keyword → private reply DM, whole-word or partial, Unicode-aware | `lib/utils/keyword-matcher.ts`, `lib/queue/dm-worker.ts:processComment` |
| "Any word" mode (fire on every comment) | `Automation.matchAnyWord` |
| Public comment reply, with a pool of variations picked at random | `Automation.publicReplyMessages`, worker public-reply leg |
| Tracked links + click/CTR analytics | `TrackedLink`, `LinkClick`, `app/r/[slug]/route.ts` |
| Up to 3 tappable link buttons in one DM (Meta button template) | `sendPrivateReplyWithLinkButton`, `buildLinkButtons` |
| Opening DM + postback button → "reveal" message | `openingDmEnabled`, `processPostback` |
| Follow gate (`is_user_follow_business`), re-prompt until following | `getUserFollowStatus`, `followcheck:` postback payload |
| Read-receipt fallback (read but never tapped → deliver after 5 min) | `app/api/webhook/route.ts` read events, `POSTBACK_JOB_NAME` with delay |
| Delayed appreciation follow-up (0–1440 min) | `FOLLOWUP_JOB_NAME`, `followUpDelayMinutes` |
| Inbound-DM keyword trigger (user DMs you a keyword → autoreply) | `dmTriggerEnabled`, `processMessage` |
| `{username}` / `{link}` personalization | `lib/tracking/message.ts` |
| "Next reel" targeting (bind campaign to the next reel posted) | `pendingNextReel`, `app/api/cron/attach-next-reel/route.ts` |
| Per-account rate limiting, 750 private replies/hour, with requeue | `lib/utils/rate-limiter.ts` (Redis Lua EVAL) |
| Polling reconciler (safety net for webhooks Meta never sends) | `lib/polling/comment-reconciler.ts` |
| DM inbox (read/reply inside Meta's 24h window) | `app/api/instagram/conversations/*` |
| Follower history beyond Instagram's 30-day insights window | `FollowerSnapshot`, `lib/reports/follower-history.ts` |
| Shareable per-campaign report pages | `Automation.reportShareSlug`, `app/reports/[shareSlug]` |
| Campaign templates | `lib/templates/campaign-templates.ts` |
| Workspaces + OWNER/ADMIN/MEMBER roles + email invitations | `Workspace*` models, `app/api/workspace/members` |
| Diagnostics (queue depth, worker heartbeat, failures) | `app/api/admin/diagnostics`, `lib/ops/worker-health.ts` |

## 2. Runtime shape

Two processes, two datastores. This is load-bearing.

```
Meta ──webhook──▶ Next.js route (app/api/webhook/route.ts)
                     │ verify HMAC over raw body (FACEBOOK_APP_SECRET or INSTAGRAM_APP_SECRET)
                     │ persist WebhookEvent row (audit)
                     │ parse → comment / postback / message / read events
                     ▼
                  BullMQ "dm-processing" queue on Redis
                     ▲                      │
    reconcileComments│ (5-min sweep)        ▼
                     │            worker/dm-worker.ts (long-running tsx process)
                     │              concurrency 5, custom backoff [5m, 15m, 45m]
                     │              processComment / processPostback
                     │              processMessage / processFollowUp
                     └──────────────────────┤
                                            ▼
                                   graph.instagram.com  (send private reply / DM / comment reply)
                                            │
                                            ▼
                                   Postgres: DmLog, Automation, InstagramAccount, ...
```

- **Web app** (Next.js 16 App Router, `next dev` / `next start`): dashboard, OAuth
  callback, webhook receiver, tracked-link redirect, cron routes. Serverless-friendly.
- **Worker** (`tsx worker/dm-worker.ts`): the only thing that actually sends. Must be
  always-on — it is a BullMQ consumer *plus* a `setInterval` polling loop *plus* a 30s
  Redis heartbeat. Explicitly cannot run on Vercel (`docs/setup.md:12`).
- **Postgres** via Prisma 7 + `@prisma/adapter-pg`, client generated to `app/generated/prisma`.
- **Redis** does four distinct jobs: BullMQ queue, per-account rate limiter (Lua
  `INCR`+`EXPIRE`), worker heartbeat (`SET` with TTL 120s), capped alerts list
  (`LPUSH`/`LTRIM`). It must speak native RESP over TCP — HTTP-only Redis will not work.

Web app and worker **must share** `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY`.
The web app writes an AES-256-GCM-encrypted token; the worker decrypts it to send.

## 3. The data model, and where Instagram is welded in

`InstagramAccount` is the hub of the schema. Five models carry a
`instagramAccountId` FK: `Automation`, `DmLog`, `LinkClick`, `FollowerSnapshot`,
`ProcessedComment`. `Workspace` has `instagramAccounts InstagramAccount[]`.

```prisma
model InstagramAccount {
  id, workspaceId, instagramId @unique, username, name,
  accessToken (encrypted), tokenExpiresAt, webhookSubscribed, connectedAt
}
```

`instagramId` is the Instagram **professional account id** (`user_id` from `/me`,
*not* the app-scoped `id`) — it is what arrives as `entry.id` in webhooks and what
the messaging API keys off. Lookups from the webhook path are
`prisma.instagramAccount.findUnique({ where: { instagramId } })`.

`DmLog` is the outcome ledger, uniquely keyed `@@unique([automationId, commentId])`.
The `commentId` column is overloaded as a general dedup key — it holds a real comment
id for comment-triggered sends, `reveal:<userId>` for button taps, and `dm:<messageId>`
for inbound-DM triggers. `DmStatus` is
`PENDING | SENT | FAILED | SKIPPED_DEDUP | SKIPPED_RATE_LIMIT | SKIPPED_PLAN_LIMIT | SKIPPED_NO_MATCH`.

**Coupling measurement:** 795 occurrences of "instagram" across 76 non-generated
source files. Not just the API client — route paths (`/api/instagram/*`), component
names (`instagram-connect-notice.tsx`), env var names, the sidebar, the SEO pages,
and the entire test suite.

## 4. The send path, in detail (this is the part that must generalize)

`processComment` (`lib/queue/dm-worker.ts:180`) is ~230 lines and encodes a lot of
hard-won Meta-specific policy. Any multi-platform design has to decide, per rule,
whether it is universal or Instagram-specific:

1. **Campaign match**: `OR: [{ postId: mediaId }, { matchAnyPost: true }]`, active, on
   this account. Then `matchAnyWord` or `matchKeywords(text, keywords, wholeWordMatch)`.
2. **Idempotency**: read the existing `DmLog`. `alreadyDmd = status === "SENT"`.
   A comment whose DM sent but whose *public reply* failed must come back so the
   reply can retry — that is why the skip condition is
   `alreadyDmd && (alreadyPublicReplied || !publicReplyEnabled)`.
3. **Public reply leg runs first**, decoupled, idempotent via `publicReplySentAt`, so
   a DM failure never suppresses it.
4. **One-private-reply-per-comment dedup** (`SKIPPED_DEDUP`): Meta allows exactly one
   private reply per comment *ever, across every campaign*. When two campaigns match
   the same comment, the second is skipped explicitly rather than burning an API call.
   **This is an Instagram platform rule, not a product rule.**
5. **Workspace monthly usage reservation** (`reserveWorkspaceDMSend`), released on failure.
6. **Per-account hourly rate limit** (`reserveDMSlot`) → allow / requeue with 30-min
   delay (max 3 requeues) / skip.
7. **Send strategy selection**, in priority order: opening DM w/ postback button →
   follow prompt → link-button template → plain text. Each with a **button-template
   fallback to inline text**, gated by `isTemplateRejection()` which pattern-matches
   Meta error strings (`/outside of allowed window/i`, `/invalid for a private reply/i`,
   `/requested user cannot be found/i`). **Deeply Meta-specific.**
8. **Log the outcome**, release the reservation on throw, rethrow so BullMQ retries.

Meta error taxonomy is mapped in `lib/meta/client.ts:handleResponse`: code 190 →
`TokenExpiredError`, 368/4/17 → `RateLimitError`, 10/100/200 → `PermissionError`,
else `MetaApiError`. Error messages are enriched with the URL path (query string
stripped, because it carries the access token).

## 5. Auth, connect, and token lifecycle

- **User auth**: Auth.js v5, database sessions, email magic links via Resend (or SMTP
  if `EMAIL_SERVER` is set). `EMAIL_PROVIDER_ID` is derived, not hardcoded.
  `events.createUser` → `ensureWorkspaceForUser`, which also auto-accepts any pending
  invitations matching the email.
- **Account connect**: `GET /api/instagram/connect` → HMAC-signed state carrying
  `workspaceId` (10-min TTL) → `www.instagram.com/oauth/authorize` → callback exchanges
  code → short-lived token → `getLongLivedToken` (60d) → `getUserInfo` → store
  `user_id` → `subscribeInstagramAccountToWebhooks(["comments","messages"])` → upsert.
  Guarded by `canManageWorkspace(role)` (ADMIN+) at **both** ends.
- **Token refresh**: daily cron `refresh-tokens` refreshes any token expiring within
  10 days, logging failures as `OperationalEvent(source: TOKEN_REFRESH)`.
- **Ownership rule**: `canConnectInstagramAccount` refuses to move an account that is
  already connected to a *different* workspace.

## 6. Invitations as they exist today

`WorkspaceInvitation` has token/status/expiry/role and a `@@unique([workspaceId, email])`.
`POST /api/workspace/members` creates one — but **it never sends an email**. It returns
an `inviteUrl` built by `buildInvitationUrl()` for the admin to copy-paste manually.
`buildInvitationUrl` reads `NEXTAUTH_URL`. Acceptance is
`POST /api/workspace/invitations/accept`, which requires the session email to match
the invitation email exactly.

**Gap for the new requirement:** invitations are *workspace-member* invitations
(collaborators on one workspace), not *creator* invitations (an external UGC creator
who gets their own space and self-enrolls their own social accounts). There is no
transactional email delivery at all, and no notion of a creator vs. an agency admin.

## 7. Admin / overview as it exists today

Everything is scoped to `getCurrentWorkspaceId()` — the first workspace the user is a
member of, ordered by `createdAt`. There is **no cross-workspace view and no
platform-level admin role**. `/overview` is Instagram post analytics for one workspace.
`/diagnostics` reads queue counts + worker heartbeat + this workspace's failures.
`WorkspaceRole` tops out at `OWNER` (per workspace).

**Gap for the new requirement:** "as admins we should see an overview across all other
creator accounts" has no home in the current model. `getCurrentWorkspaceId()` returning
a single workspace is assumed by ~every API route.

## 8. Hosting as it exists today

Vercel (web) + Railway/Oracle VM (worker) + Neon (Postgres) + Redis Cloud + Resend.
`vercel.json` holds 3 daily crons. `@vercel/analytics` is a dependency. `proxy.ts` is
the Next.js 16 middleware equivalent, gating `/dashboard|/automations|/logs|/settings`
on the presence of a session cookie.

**Gap for the new requirement:** the target is entirely Cloudflare, with Cloudflare's
email service for transactional mail. Every load-bearing runtime assumption is in
question: an always-on Node process, BullMQ, native-TCP Redis, `node:crypto`,
`maxDuration = 60` on the overview route, and `prisma migrate deploy` in the build.

## 9. Constraints any design must honor

1. **Instagram works today and must keep working.** Regression here is the worst
   possible outcome; it is the only revenue-shaped part of the system.
2. **`DmLog.@@unique([automationId, commentId])` and the overloaded `commentId`** are
   the existing idempotency contract. Changing the key means a migration over live data.
3. **The one-private-reply-per-comment rule is Instagram's, not the product's.** A
   platform abstraction that hoists it to the core will be wrong for Facebook/YouTube.
4. **Send capabilities differ per platform.** Instagram has private replies, button
   templates, postbacks, follow-status, and a 24h window. It is not safe to assume any
   other platform has any of these. The design must let a platform *decline* a
   capability rather than stub it.
5. **The token is encrypted at rest with a shared `ENCRYPTION_KEY`** and decrypted in
   the worker. Any new runtime must support AES-256-GCM and HMAC-SHA256.
6. **The polling reconciler exists because webhooks are unreliable.** For platforms
   with no comment webhook at all (likely YouTube and TikTok), polling is not a safety
   net — it is the primary path, and quota becomes the binding constraint.
7. **142 tests pass** (`__tests__/`, 14 files) and cover the worker, webhook parsing,
   keyword matching, rate limiting, and OAuth state. They are the regression net.

## 10. Open unknowns at the end of Phase A

Being resolved by parallel research; the design must be shaped so the answers slot in
rather than force a rewrite:

- Facebook Pages: private-reply endpoint, webhook fields, scopes, whether one Meta app
  can serve both Instagram-Login and Pages/Messenger use cases.
- YouTube: whether a private message to a commenter is possible at all (strong prior:
  **no**), quota math for polling, and scope-verification burden.
- TikTok: whether comment read and DM send exist outside a partner allow-list.
- Cloudflare: what replaces an always-on BullMQ worker, native-TCP Redis, and Resend.
