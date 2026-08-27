# Research: Facebook Pages — verified against official Meta docs 2026-08-24

**Bottom line up front: this is the cheapest platform to add. The code is nearly identical
to the Instagram path — only the host, the ID field, and the webhook shape change.**

## 1. Private reply — confirmed, same shape as Instagram

```
POST https://graph.facebook.com/v26.0/{PAGE-ID}/messages?access_token={PAGE-ACCESS-TOKEN}
{ "recipient": { "comment_id": "{COMMENT-ID}" },
  "message":   { "text": "..." } }
```
Do **not** send `messaging_type` or a tag — private reply is its own entry point.
All Send API message types work (text, image, templates, quick replies).

**Response:** `{"recipient_id": "PAGE-SCOPED-ID", "message_id": "..."}` — `recipient_id`
is the commenter's **PSID**. This is the only place you get it.

Verbatim limits:
- **7-day window**: *"The message must be sent within 7 days from when the post or comment
  was created"* (Instagram's is 24h — **different constant, same rule shape**).
- **One per comment**: *"Only one message can be sent to the person who commented"* —
  identical to Instagram's one-private-reply-per-comment rule that already drives our
  `SKIPPED_DEDUP` logic.
- *"Only when a person responds to the private message can you continue the conversation
  within the 24-hour messaging window."*
- *"Cannot send private reply message to another facebook page."*

Requires a Page token from someone with the `MESSAGING` task + `pages_messaging`.
Scope: the Page's own posts, plus Groups the Page owns. Changelog: *"Private Reply is now
available for comments on Facebook Reels."*

> **Cheap pre-flight worth using:**
> `GET /{comment-id}?fields=can_reply_privately,private_reply_conversation`
> — *"Whether the page viewer can send a private reply to this comment"*. Avoids burning
> the single allowed reply on an ineligible comment.

⚠️ **Legacy trap:** do **not** use `POST /{object-id}/private_replies` — it needs
`read_page_mailboxes`, removed after Graph v3.2.

## 2. Webhooks — object `page`, field `feed`

Comments have no dedicated field; they arrive inside `feed`.

```json
[{ "object": "page", "entry": [{ "id": "{page-id}", "time": …,
   "changes": [{ "field": "feed", "value": { … } }] }] }]
```

| key | meaning |
| --- | --- |
| `item` | `"comment"` — enum `{album, comment, …, post, reaction, share, status, video}`. **`reels` is NOT in the enum.** |
| `verb` | `"add"` — enum `{add, block, edit, edited, delete, follow, hide, mute, remove, unblock, unhide, update}` |
| `comment_id` | the comment id |
| `post_id` | `{page-id}_{post-id}` |
| `parent_id` | equals `post_id` for top-level; parent comment id for replies |
| `from.id` / `from.name` | sender |
| `message` | comment text |
| `created_time` | timestamp |

⚠️ **Reels payload is UNVERIFIED.** No `reels` item value in the reference and no published
reel-comment sample. A Page reel is a Page post, so a reel comment *should* arrive as
`item: "comment"` with `post_id` = the reel's post id. **Test empirically; log unknown
`item` values.**

**One endpoint can receive both objects** — branch on top-level `object` (`"instagram"` vs
`"page"`). But: the `instagram` callback is configured under *Instagram → API setup with
Instagram login → Webhooks* while `page` is under the app-level *Webhooks* product, and an
Instagram-Login app has an **Instagram App Secret distinct from the Meta App Secret**.
⚠️ Docs only say *"your app's App Secret"* signs `X-Hub-Signature-256`.
**→ Use separate routes (`/api/webhook/instagram`, `/api/webhook/facebook`) with the right
secret bound per route.** This directly justifies splitting our current single
`/api/webhook` endpoint, whose `verifyWebhookSignature` currently tries both secrets.

**Subscription required:**
```
POST /v26.0/{PAGE-ID}/subscribed_apps?subscribed_fields=feed,messages,messaging_postbacks
```
Needs `pages_manage_metadata` + `pages_show_list`, and a Page token from someone with
`CREATE_CONTENT`, `MANAGE`, or `MODERATE`.

**Ops:** return `200` within **5 seconds**; Meta alerts at 15 min of failures and
**auto-unsubscribes after 1 hour**. (Our current webhook route does DB writes and queue
adds inline before responding — worth checking against the 5s budget.)

## 3. Auth + tokens

**Facebook Login for Business** (`config_id`-driven), not consumer FB Login.

Scopes, verbatim: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`,
`pages_read_engagement`, `business_management`.
Dependencies: `pages_messaging` → `pages_manage_metadata` + `pages_show_list`;
`business_management` → `pages_read_engagement` + `pages_show_list`.
`business_management` is mandatory in the Messenger use case and **must be called out in
the App Review submission**. Add `pages_manage_engagement` only if we also post *public*
comment replies (we do — so include it).

Token chain (**order matters**):
1. `GET /oauth/access_token?grant_type=fb_exchange_token&…&fb_exchange_token={short-lived-user-token}`
   → long-lived user token (~60 days)
2. `GET /{app-scoped-user-id}/accounts?access_token={long-lived-user-token}` → Page tokens

Verbatim: *"Long-lived Page access token do not have an expiration date and only expire or
are invalidated under certain conditions."*
⇒ **Facebook Page tokens don't expire**, unlike Instagram's 60-day tokens. Our
`refresh-tokens` cron must not assume every platform needs refreshing — it becomes a
per-platform capability. Still re-check `/me/accounts` periodically (tokens invalidate on
password change, permission revoke, role removal). Store `page_id`, token, and `tasks`.

## 4. App review

**Advanced Access required for all five scopes** once a non-role-holder is involved.
- Standard Access: *"can only be requested from app users who have a role on the requesting
  app"* — same trap as our documented Instagram tester dance.
- *"Business Verification is required to get Advanced Access."*
- Messenger overview: App Review *"not required if you only send and receive messages for
  your own Facebook Page."*
- `pages_messaging` review needs a **screencast showing a message actually sent through our
  app** and integrated with the Messenger inbox — screenshots of a received message are
  explicitly insufficient.
- No separate Messenger review track, but the Messenger App Review page adds: policy
  compliance, a live webhook returning 200, reviewer access to gated functionality.

> **Our Instagram approvals do NOT carry over** — `instagram_business_*` and `pages_*` are
> distinct strings reviewed individually. **What does carry over is the Business
> Verification and verified-business linkage — the slow part, already paid for.**

**Human Agent** (`human_agent` tag, 7 days from the user's message) is a separately
reviewed *feature*. **Not needed for private replies.**

**Fastest zero-review test:** stay in Standard Access — give the tester a
Administrator/Developer/Tester role on the app, make them a Page admin with the `MESSAGING`
task, grant scopes, subscribe, then have **that role-holding account** comment.
⚠️ Verbatim: *"Page tokens only allow your Page to interact with Facebook accounts that
have been granted the Administrator, Developer, or Tester role."* A comment from a random
account webhooks fine but the private reply **fails** — the single most common
"works for me, not in prod" trap.

## 5. Gotchas

- **PSID answer:** the commenter's PSID is **not** in the `feed` webhook, and we don't need
  one — **`comment_id` IS the addressing token.** Docs never state the ID scope of
  `feed.value.from.id`; treat it as opaque and **never** pass it as `recipient.id`. The
  real PSID comes back in the private-reply *response*; persist it for the 24h follow-up.
- **ID Matching API is a dead end for multi-tenant SaaS**, verbatim: *"service providers
  may not use the API to support multiple customers."*
- **Echo/self filtering:** drop when `from.id === entry.id`, `verb !== "add"`,
  `item !== "comment"`, or `is_hidden === true`. `from` can be **absent** — null-guard.
  `feed` is extremely chatty (reactions, shares, photo adds, status edits) — filter first.
- **Duplicates:** Meta community threads report repeated deliveries of the same comment id.
  Dedupe on `comment_id` — a duplicate private reply burns the one allowed message.
- **Rate limits:** Pages — *"Calls within 24 hours = 4800 × Number of Engaged Users"*.
  **This is an engagement-derived budget, a third rate-limit shape** (Instagram = fixed
  750/hr/account, YouTube = global project quota, TikTok = QPM tiers). A low-engagement
  Page has a genuinely small budget ⇒ prefer webhook payload fields over enrichment GETs.
  Send API: 300 calls/s per Page.
- **Dead message tags:** *"Effective April 27th, 2026, all API requests containing the
  Message Tags CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE, and POST_PURCHASE_UPDATE will
  receive error code 100."*
- **Policy:** bots must respond *"within 30 seconds"*; automated experiences must disclose
  they are automated where legally required (**explicitly California and Germany**).
- ⚠️ **Unverified:** vendor-blog claims of a 2025 Instagram automation ban wave and a
  "~200 automated DMs/hour/account" ceiling appear **only** in vendor blogs, not Meta docs.
  **Do not code against that number.**

## 6. One app for both platforms — the decisive constraint

**Multiple use cases in one app: supported**, verbatim: *"You can add multiple use cases to
a single app, provided they are compatible… but you can't add the **Authenticate and
request data from users with Facebook Login** use case since it is incompatible."*
⚠️ *"Use cases cannot be removed after you create your app."* — **irreversible.**

**Our setup doc's warning is real but narrower than it reads.** The documented
incompatibility is specifically the *consumer* "Authenticate and request data from users
with Facebook Login" use case. The Messenger use case ("Engage with customers on
Messenger") is built on **Facebook Login for Business** and is *not* named incompatible.

A second source of the folklore: the IG OAuth `enable_fb_login` parameter, **deprecated
2025-06-14** (replaced by `force_reauth`). ⚠️ **Doc conflict:** the deprecation is in the
Instagram changelog but `enable_fb_login` is still documented as current on the Business
Login for Instagram page. Verify live.

The two flows use **different client IDs** and coexist by design — Business Login for
Instagram uses the **Instagram App ID**; FB Login for Business uses the **Meta App ID**.
Our `www.instagram.com/oauth/authorize` flow keeps its own `client_id` regardless.

> **HARD BLOCKER on any thought of switching IG login type**, verbatim: *"You can only add
> one setup per app. If you want to implement both setups, create an app for each setup."*
> One app **cannot** hold both "Instagram API with Instagram Login" and "Instagram API with
> Facebook Login."

**Is "Instagram API with Facebook Login" the better unified choice? No.** Migration cost:
every user's IG account must be linked to a Facebook Page; an entirely different permission
set (`instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, …) **all
requiring fresh App Review**; different host, token type, and messaging path; **every
existing user must reconnect, with no token migration path**; and it needs a new app.

**Recommendation: keep the Instagram app exactly as it is.** Try adding "Engage with
customers on Messenger" to it; if the dashboard greys it out, create a **second Facebook
app** for Pages/Messenger and route `page` webhooks to a separate endpoint with that app's
secret. Two apps costs one extra App Review and one extra OAuth connect step per
customer — far cheaper than a migration. **Use cases are irreversible, so adding Messenger
to the IG app is permanent.**

## Is `pages_messaging` still open to new apps? **Yes.**

Current permission in the live reference, mandatory and non-removable in the current
"Engage with customers on Messenger" use case, **no deprecation notice**. What Meta
actually restricted in 2025–26: Recurring Notifications ended 2026-02-10; three message
tags dead 2026-04-27; IG Handover Protocol → Conversation Routing; IG `share` attachment
removed 2026-02-01. **None touches comment→DM.** Private replies were *expanded* over the
same period (Groups, Facebook Reels, Instagram Reels).

⚠️ Meta restructured docs from `/docs/messenger-platform/*` to
`/documentation/business-messaging/messenger-platform/*`; several old URLs returned HTTP
500 during research and the Messenger changelog page was unreachable on every attempt.
**Re-read the changelog directly before finalizing anything version-sensitive.**

## Timeline

- **Working end-to-end against tester accounts: under a day.** The code is nearly identical
  to our IG path.
- **Public launch** gates on `pages_messaging` Advanced Access. Meta advertises ~24h; budget
  **1–3 weeks** including at least one rejection-and-resubmit on the screencast, which is
  where messaging reviews almost always stall.
