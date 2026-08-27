# Cross-platform capability matrix — the central design constraint

Derived from verified research (Instagram from the running code; YouTube, TikTok, and
Facebook, and Cloudflare from official docs on 2026-08-24). All streams complete.

## The finding that inverts the product's premise

> **The DM is not the universal capability. The public comment reply is.**

OpenReply is built as a DM engine with an optional public reply bolted on. Across the
four target platforms the reverse is true: **every platform can post a public reply to a
comment; only the two Meta platforms can reliably DM a commenter.**

| Capability | Instagram | Facebook | YouTube | TikTok |
| --- | --- | --- | --- | --- |
| **Public reply to a comment** | ✅ | ✅ | ✅ `comments.insert` | ✅ `/business/comment/reply/create/` |
| **DM triggered by a comment** | ✅ private reply, **24h**, 1/comment | ✅ private reply, **7d**, 1/comment | ❌ **impossible** | ❌ except VN/ID/TH, and on TikTok's classifier not our keyword |
| **DM triggered by an inbound DM** | ✅ (already built) | ✅ 24h window | ❌ impossible | ✅ 48h window, 10 msgs |
| **Comment webhook** | ✅ (unreliable → reconciler) | ✅ `page`/`feed`, **5s ack budget** | ❌ **poll only** | ✅ `comment.update`, ≤5 min, includes `text` |
| **Button templates / postbacks** | ✅ | ✅ Send API templates | ❌ | ⚠️ `QA_*` cards, messaging-gated |
| **Follow gate** (`is_user_follow_business`) | ✅ | ❌ | ❌ | ❌ |
| **Token lifetime** | 60d, **needs refresh cron** | **never expires** | refresh token, 7d in Testing mode | access 1d / refresh 1y |
| **Rate-limit shape** | per-account, fixed 750/hr | **engagement-derived: 4800 × engaged users/24h** | **per-PROJECT, global across all tenants** | per-account 40 QPM + app-wide 600 QPM |
| **Blocked markets** | — | — | — | **EEA/CH/UK entirely; US for comment→DM** |

## What this means for the design

### 1. The core abstraction is `respond to a comment`, not `send a DM`

The campaign's primitive must be an ordered list of **response steps**, where each step
declares the capability it needs. A platform adapter advertises its capability set; the
campaign compiler rejects (at save time, in the UI) any step the target platform cannot
perform. `SendDirectMessage` becomes one capability among several, not the trunk.

This is the difference between a design where `if (platform === 'youtube') return;`
appears inside the send path, and one where YouTube simply never advertises
`DIRECT_MESSAGE` so the step is unconstructable.

### 2. Four genuinely different rate-limit shapes must coexist

- **Instagram**: per-account, fixed 750/hour. The existing Redis→DO counter covers it.
- **Facebook**: **engagement-derived** — *"Calls within 24 hours = 4800 × Number of Engaged
  Users"*. The budget is a function of live Page data, not a constant. A low-engagement
  Page has a genuinely small budget, which means enrichment `GET`s must be avoided in
  favour of webhook payload fields.
- **TikTok**: per-account 40 QPM *and* per-app 600 QPM. Two-level.
- **YouTube**: **per Google Cloud project, 10,000 units/day, shared across every tenant**,
  with per-call costs that differ by 50× (`commentThreads.list` = 1, `comments.insert` =
  50). Sharding across projects is explicitly forbidden by policy.

That is **four different shapes**: a constant, a derived value, a two-level tier, and a
global pool. A `RATE_LIMIT_MAX` constant cannot express them.

The design needs a **quota broker** that handles per-account, per-app, and per-tenant-pool
budgets as one concept with different scopes — otherwise YouTube gets bolted on as a
special case and the 200-replies/day ceiling silently starves whichever tenant polls first.

### 3. Trigger discovery is not one mechanism

- Instagram: webhook primary, poll as safety net (current design).
- TikTok: webhook primary (≤5 min, `text` included — no follow-up read needed).
- YouTube: **poll only**, and every poll costs metered quota.

"Reconciler as safety net" and "polling as the only path" are different enough that a
single `COMMENT_POLL_INTERVAL_MS` cannot serve both. The scheduler must be quota-aware
and per-platform, and must degrade by *lengthening intervals* rather than failing.

### 4. Regional eligibility is per-connected-account state, not per-platform config

TikTok Business Messaging is unavailable for EEA/CH/UK accounts and comment→DM never
reaches US accounts. Whether a campaign can run is a function of **the creator's account
registration region**, discovered at connect time. This has no representation in the
current schema at all and cannot be an env var — two creators on the same platform in the
same workspace can have different capability sets.

### 5. Compliance copy is per-platform and load-bearing

YouTube Developer Policy §III.F prohibits *"incentives, rewards, or other compensation…
for… adding comments"* — the "comment LINK below" mechanic is **prohibited on YouTube**,
independent of delivery. TikTok requires varied reply copy to avoid spam classification.
Both need the campaign builder to constrain what a creator can write, per platform.

### 6. The already-built feature is the portable one

`dmTriggerEnabled` / `processMessage` (inbound DM matches keyword → autoreply) already
exists in the codebase and is **the compliant shape on TikTok** and the recommended
pattern industry-wide. The migration should treat it as a first-class trigger equal to
the comment trigger, not the afterthought it currently is.

## Revised honest scope

| Platform | What actually ships | Realistic timeline |
| --- | --- | --- |
| **Instagram** | Everything, unchanged | already working |
| **Facebook** | Everything Instagram does except the follow gate. 7-day window instead of 24h. | **under a day** to tester-working; 1–3 weeks for Advanced Access |
| **YouTube Shorts** | Keyword → **public reply**. Poll-only. ~200 replies/day product-wide until a compliance audit. No DM, ever. | weeks to build; OAuth verification 3–10 business days; quota audit unbounded |
| **TikTok** | Keyword → **public reply** (ships globally). DM only via an inverted "DM me the keyword" funnel, and not at all for EEA/CH/UK. | public reply 2–4 weeks; DM 6–12 weeks (DSPR review, no SLA); US 3–6 months |

**The user's stated end goal — "for any comments matching campaign settings, send a DM as
configured" — is achievable on Instagram and Facebook, and is impossible as stated on
YouTube and (for Western markets) TikTok.** The deliverable that is achievable
on all four is: *for any comment matching campaign settings, execute the campaign's
configured response — a DM where the platform allows it, a public reply everywhere else.*


## 7. Facebook-specific design inputs (added after research completed)

- **Split the webhook endpoint.** Instagram-Login apps carry an Instagram App Secret
  distinct from the Meta App Secret, and the two objects are configured in different
  dashboard products. Our current single `/api/webhook` with a `verifyWebhookSignature`
  that tries *both* secrets should become per-platform routes with one bound secret each.
  Trying every known secret against every payload is a weak verification posture that gets
  weaker with each platform added.
- **Meta requires a 200 within 5 seconds and auto-unsubscribes after 1 hour of failures.**
  Our webhook route currently does several sequential DB writes plus queue adds *before*
  responding. On Cloudflare this must become: verify → enqueue → respond, with the DB
  audit write moved into the consumer or `ctx.waitUntil`.
- **Token refresh is a per-platform capability, not a universal cron.** Facebook Page
  tokens never expire; Instagram's need 60-day refresh; TikTok's access token lives 1 day
  with a 1-year refresh token. `app/api/cron/refresh-tokens/route.ts` currently assumes
  every account is an `InstagramAccount` with a refreshable token.
- **`can_reply_privately` is a pre-flight capability probe.** Facebook exposes, per comment,
  whether a private reply is even possible. Instagram does not. This is the strongest
  argument that "can I respond this way?" belongs in the platform adapter as a real
  question rather than being inferred from a failed send and a regex over the error string
  (which is what `isTemplateRejection()` does today).
- **One app cannot hold both Instagram-Login and Facebook-Login Instagram setups**
  (*"You can only add one setup per app"*), and **use cases are irreversible**. The design
  must therefore support **multiple provider app credentials** — potentially one Meta app
  for Instagram and a second for Pages — rather than assuming a single
  `INSTAGRAM_APP_ID`/`FACEBOOK_APP_SECRET` pair. This is a schema and config concern, not
  just an env-var rename.
