# Research: YouTube Shorts — verified against official docs 2026-08-24

## Verdict: a DM is impossible. The substitute is a PUBLIC comment reply.

### Impossible, confirmed — do not design around these

1. **Private message to a commenter via any API.** Data API v3 has no messaging
   resource at all (full resource list checked). YouTube Partner/Content ID API is
   rights-management only and gated. Google Chat requires a Workspace account and
   cannot add members outside the org. Decisively: the `comment` resource only exposes
   `authorDisplayName`, `authorProfileImageUrl`, `authorChannelUrl`,
   `authorChannelId.value` — **there is no identifier you could route a message to.**
2. **The 2025/26 YouTube DM revival does not help.** Mobile app only, no API, mutual
   opt-in via a 7-day invite link, 18+, ~40 regions, Brand Account owners only. There is
   no "message this commenter" affordance.
3. **Hearting or pinning a comment** — no API field or method. Studio UI only.
4. **Community posts** — no API resource; `activities.insert` is obsolete.
5. **A webhook for comments.** WebSub (`pubsubhubbub.appspot.com/subscribe`, topic
   `https://www.youtube.com/feeds/videos.xml?channel_id=…`) fires on exactly three
   events: video uploaded, title updated, description updated. Comments are not among
   them. **Polling is the only path.**
6. **A Shorts flag in the Data API.** Does not exist. Duration ≤3min is a false-positive
   heuristic. The authoritative answer is in a *different* API: YouTube Analytics
   `creatorContentType` dimension = `SHORTS` (scope `yt-analytics.readonly`, max 200
   results/report, own channel only).

### What works

| Action | Endpoint | Quota | Scope |
| --- | --- | --- | --- |
| Read comments (all videos of a channel in one call) | `commentThreads.list?allThreadsRelatedToChannelId=…&order=time&maxResults=100` | **1 unit** | none (API key) |
| Read replies | `comments.list?parentId=…` | 1 unit | none |
| **Post a public reply** | `comments.insert`, `snippet.parentId=<top-level comment id>` | **50 units** | `youtube.force-ssl` |
| Enumerate uploads | `channels.list` → `contentDetails.relatedPlaylists.uploads`, then `playlistItems.list` | 1 unit each | `youtube.readonly` |

**Never use `search.list`** — it has its own bucket of **100 calls/day project-wide**.

A public reply does reach the commenter: YouTube's notification settings include
"Replies to my comments", so it lands in their notifications and email. It is public
and permanent.

### Quota is the binding constraint

Default allocation: **10,000 units/day, per Google Cloud project**, reset midnight PT.
Separate 100-calls/day buckets for `search.list` and `videos.insert`.

**You may not shard across projects.** Developer Policies §III.D: *"you must create
exactly one (1) API Project for that API Client… you must not use that one (1) API
Project for multiple API Clients."* ToS §15 forbids circumventing quota.

`comments.insert` = 50 units ⇒ **hard ceiling of 200 automated replies/day for the
entire product, across all customers**, before spending anything on polling.

| Replies/day | Polling budget | 10 channels | 25 | 50 | 100 |
| --- | --- | --- | --- | --- | --- |
| 0 | 10,000 | every 86 s | 3.6 min | 7.2 min | 14.4 min |
| 100 | 5,000 | 2.9 min | 7.2 min | 14.4 min | 28.8 min |
| 200 | 0 | **exhausted** | — | — | — |

Realistic at default quota: **~10–25 channels, 2–7 min latency, ~100 replies/day.**
More requires a **compliance audit** (form: support.google.com/youtube/contact/yt_api_form).
No published SLA. YouTube may require you to hand over a working account so they can
exercise the automation themselves (Developer Policies §III.H).

### OAuth burden

- Only write scope available is `youtube.force-ssl` — *"See, edit, and permanently
  delete your YouTube videos, ratings, comments and captions."* There is no narrower
  scope for posting a reply. It reads badly on the consent screen; that is unavoidable.
- **Sensitive**, not restricted ⇒ OAuth verification required, but **no third-party
  security assessment / CASA**. Published timelines conflict: 3–5 business days on one
  Google page, 10 business days on another. Plan for the longer.
- **Testing publishing status is unusable in production**: capped at 100 test users and
  *"Authorizations by a test user will expire seven days from the time of consent…
  refresh token will also expire."*
- **Unverified apps in Production are capped at 100 new users for the project's entire
  lifetime, and it "cannot be reset or changed."** Burning this cap in testing is
  unrecoverable. Verify before onboarding anyone real.

### Policy — two clauses that reshape the product

**§III.E, Authorized Data Usage:** *"API Clients must clearly identify any actions that
they take to insert, share, update, or delete data or content on the authorizing user's
behalf. In addition, the user must expressly consent to those actions prior to their
actual execution."*
⇒ The creator must approve the rule **and the exact reply text** in our UI before it
fires. A one-time OAuth grant is not sufficient consent. A black-box bot composing
arbitrary text is non-compliant.

**§III.F, User Experience:** *"API Clients must not offer or provide incentives, rewards,
or other compensation to users for engaging with YouTube Applications (directly or
indirectly) by performing actions like viewing content, liking content, sharing content,
subscribing to channels, adding comments."*
⇒ **"Comment LINK below and I'll send you the guide" is prohibited on YouTube.** The
comment-triggered reply is defensible; incentivizing the comment to trigger it is not.
This kills the Instagram growth mechanic on this platform, independent of delivery.

**§III.I:** *"you must not automate or trigger views, uploads, comments, likes,
dislikes, or other actions without the user's prior specific and express consent"* —
automated commenting is not banned outright, it is banned without that consent.

**YouTube's own spam policy** (applies to the *customer's channel*, they eat the strike):
*"Comment spam: Using high-volume, repetitive, or deceptive comments… to drive traffic
to or engagement with content."* High-volume identical templated replies carrying an
outbound link is a textbook match. Reply text must vary and per-video volume must be
capped. Expect silent moderation holds — detect them by re-reading our own reply with
`moderationStatus=heldForReview`.

## Design implications for OpenReply

- YouTube's `SendCapability` set is **public reply only**. No DM, no buttons, no
  postbacks, no follow gate, no messaging window, no read receipts. The platform
  abstraction must let a platform decline every one of those rather than stub them.
- YouTube's trigger discovery is **poll-only, quota-metered, per-project**. The
  "polling reconciler as safety net" model inverts: here polling is primary, and the
  scheduler must budget quota globally across all tenants, not per account. This is a
  genuinely different rate-limit shape from Instagram's per-account 750/hour.
- Campaign settings need a per-platform capability gate in the UI, or creators will
  configure DM/follow-gate/button options that silently cannot fire on YouTube.
- Product/legal: the keyword-bait CTA copy must be suppressed for YouTube campaigns.
