# Research: TikTok — verified against official docs 2026-08-24

## The structural fact everything hinges on

TikTok runs **two entirely separate developer platforms** — separate registration, OAuth,
scopes, and review. Conflating them is why this question usually gets answered wrongly.

| | `developers.tiktok.com` | `business-api.tiktok.com` |
| --- | --- | --- |
| Read comments on own videos | **No** | **Yes** |
| Reply to comments | **No** | **Yes** |
| Send DMs | **No** | **Yes**, heavily gated |
| Comment webhook | **No** | **Yes** |
| Individual developers | Allowed | **Barred** |

Everything we want is on **business-api.tiktok.com**.

`developers.tiktok.com` is dead for this: **exactly 17 scopes** exist and *"Every TikTok
for Developer API requires a scope"* — none is `comment.*` / `message.*` / `dm.*`. Of
**288** doc slugs, only two mention comments, both research-gated (and the Research API
FAQ excludes commercial users by name: *"Am I eligible? **No.**"*). Display API exposes
`comment_count` — an int, nothing else.
⚠️ **Trap:** `/doc/direct-message-sharing` is the **Mini Games SDK** contact picker, not
a DM API.

## DM: initiating is PROHIBITED

From "Manage direct messages for a Business Account"
(https://business-api.tiktok.com/portal/docs?id=1832184236919810), **verbatim**:

> **"You are prohibited from initiating a conversation or messaging any TikTok user who
> has not started a conversation with you."**

That sentence kills the naive Instagram port. There is exactly one carve-out.

### Comment-to-Message — the only comment→DM path, and it is three countries

`POST /open_api/v1.3/business/message/direct_reply/update/` with
`direct_reply_type: "COMMENT_TO_MESSAGE"`. **Verbatim:**

> "The Comment-to-Message feature is only available for Business Accounts registered in
> **Vietnam, Indonesia, and Thailand**."
> "the Business Account can only reply to comments published by TikTok accounts that are
> registered in the **APAC, LATAM, and METAP** regions."

**We do not choose which comments trigger it — TikTok's classifier does.** The
`im_receive_high_intent_comment` webhook fires only for comments TikTok deems high-intent
(*"a strong intention to purchase or seek further information"*). **Keyword matching
cannot force a DM.**

Further send conditions (verbatim): first-level comment only; within **48 hours**; the
comment must not have been replied to by DM in any way; no DM contact in the past 24h;
commenter must be **18+**.

### Regional walls on Business Messaging overall

> "The Business Messaging API is **not yet available in the European Economic Area,
> Switzerland or the UK market**… developers cannot call the Business Messaging API on
> behalf of these accounts."
> "For Business Accounts signed up in the **US**, only developers who have passed the Data
> security & privacy review, the US data security review, and **agreed to the USDS
> Addendum**, are permitted to call the Business Messaging API."

Also: *"The Business Messaging API only supports Business Accounts. Personal accounts are
not eligible."*

**Messaging window:** initial 48h after user's first message = up to **10 messages**;
each user reply reopens 48h of unlimited; after 48h silence, **max 3** more.

**TikTok Shop is not a workaround** — *"You can only send messages to buyers who have
placed at least one order with the shop in the past 365 days"*, recipients addressed by
anonymized email, and access needs **1,000+ authorized sellers** or 1M calls/day.

**How Manychat does it:** official TikTok Marketing Partner, Messaging Partner specialty
— but **the partner badge is go-to-market, not the API gate.** The gate is the Data
Security & Privacy Review, open to any company by self-serve form. Manychat's own docs
confirm the same walls (TikTok automations unavailable in EU/UK/US; comment-to-DM limited
to select regional markets) and recommend the same inverted funnel.

## Comments — works globally, this is the shippable part

Base `https://business-api.tiktok.com/open_api/v1.3/`. Auth header is literally
**`Access-Token: {token}`** — *not* `Authorization: Bearer`.

| Endpoint | Method | Scope |
| --- | --- | --- |
| `/business/comment/list/` | **GET** | `comment.list` |
| `/business/comment/reply/list/` | GET | `comment.list` |
| `/business/comment/create/` | POST | `comment.list.manage` |
| **`/business/comment/reply/create/`** | **POST** | `comment.list.manage` |
| `/business/comment/{like,hide,delete}/` | POST | `comment.list.manage` |
| `/business/comment/image/upload/` | POST | `comment.list.manage` |

**`/business/comment/list/`** (query params): `business_id` (required — the `open_id`
from the token response), `video_id` (required), `comment_ids[]` (max 30),
`include_replies` (returns max 3 replies each), `status` (`PUBLIC`|`ALL`, default `ALL`),
`sort_field` (`likes`|`replies`|`create_time`), `sort_order` (`asc`|`desc`|`smart`),
`cursor` (default 0), `max_count` (**min 1, max 30, default 20**).
Response: `comment_id`, `video_id`, `unique_identifier`, `display_name`,
`parent_comment_id` (**present only on replies** — how you tell comment from reply),
`reply_list[]`, `image_url`, plus `has_more` / `cursor`.

> ⚠️ Two pagination caveats, verbatim:
> *"If the number of comments … exceeds 500 … **the comments beyond the first 500 and the
> first 500 comments themselves are not deduplicated and may contain duplicates**."*
> *"it is possible that the endpoint returns **less than the `max_count` number of
> comments even if `has_more` is `true`**."*
> ⇒ Dedupe by `comment_id` locally; never treat a short page as end-of-list.

**`/business/comment/reply/create/`** (JSON body): `business_id`, `video_id`,
`comment_id`, `text` (**limit 1,200 UTF-8 chars**) or `image_uri`+width/height.
Works on our own videos **and others'**.

> **TikTok's own anti-spam warning, verbatim:** *"To prevent comments from being flagged
> as spam and subsequently hidden by the system, **avoid posting a high volume of comments
> with largely similar content within a short timeframe**. If a comment is flagged as
> spam, you will not receive the `comment.update` webhook event with `comment_action` set
> to `set_to_public`."*
> ⇒ That missing `set_to_public` **is our shadow-hide detector.** Vary reply copy.

## Webhooks — a real comment event exists

`POST /business/webhook/update/` with `event_type: "COMMENT"`, `callback_url`, `secret`.
Optional `item_list` to scope to specific posts. Config endpoints need **no permission**.

**`comment.update`** — *"Fired **within five minutes** of a comment or reply being
created, deleted, or … visibility settings … modified"*, for posts published via API
**and** manually in the app. Requires the account to have granted `comment.list`.

```json
{ "event": "comment.update", "user_openid": "...",
  "content": "{\"comment_id\":…,\"video_id\":…,\"parent_comment_id\":…,\"comment_type\":\"reply\",\"comment_action\":\"delete\",\"unique_identifier\":\"…\",\"timestamp\":…,\"text\":\"text\"}" }
```
⚠️ `content` is a **JSON-encoded string**, not a nested object — must be parsed.
`comment_action`: `insert` | `delete` | `set_to_hidden` | `set_to_friends_only` | `set_to_public`.
**`text` is in the payload** ⇒ keyword-match straight off the webhook, no follow-up read.

Other event types: `VIDEO`, `DIRECT_MESSAGE` (`im_receive_msg`, `im_receive_msg_eu` for
EEA/CH/UK senders, `im_receive_high_intent_comment`, …), `BRAND_MENTION`.

> **The cross-API join that makes the funnel buildable:** `unique_identifier` is *"consistent
> across different APIs"* — the same value in `/business/comment/list/`, `comment.update`,
> and the messaging webhooks. Capture `unique_identifier`→`conversation_id` when a user
> first DMs; afterwards any `comment.update` from that person can be answered by DM
> legitimately. Note `/business/message/conversation/list/` returns `conversation_id` but
> **not** `unique_identifier` — persist the mapping from the webhook.

## Auth

OAuth 2.0 auth-code. `auth_code` **10 min, single use**. `access_token` **1 day**
(86,400s). `refresh_token` **1 year** — on expiry the user must re-authorize.
Token response returns `open_id` → **pass as `business_id` on every call.**
Redirect URLs: `https://` only, **must end with `/`**, no query params, no anchors, no
ports, 10–512 chars, up to 10 per app. Append `&disable_auto_auth=1` or returning users
are silently redirected **without** an `auth_code`.

Scopes needed for the shippable product: `user.info.basic`, `video.list`, `comment.list`,
`comment.list.manage`. Add `message.list.read` + `message.list.send` if Messaging is ever
approved.

⚠️ Operational gotcha, verbatim: *"remind businesses to **set TikTok Business Accounts to
accept direct messages from everyone** in the TikTok app before authorizing"* — otherwise
the owner must manually accept each message request before webhooks fire.

## Rate limits

**40 QPM per authorized account per Accounts API endpoint.** App-wide across all Accounts
endpoints: **600 QPM at Basic (default)**, 1,000 at higher tiers. Global app limits at
Basic: 10 QPS / 600 QPM / 864,000 QPD. Throttle code **`40100`**; QPM breach → wait 5 min,
QPD breach → wait until 00:00 UTC. Level increases granted **one step at a time**.

⇒ Webhook-driven replies are comfortable. Polling is not: ~15 accounts polling once a
minute exhausts the Basic app-wide ceiling. **Use webhooks; poll only to reconcile.**

## Onboarding

**Self-serve, not a partner program** — but **individual developers are barred**:
*"we are **unable to onboard personal accounts or individual developers**."* Requires a
**company-domain email** (*"You will be rejected if you are using a personal email"*) and
a company website that is publicly accessible without login, on a company-owned domain.

| Step | Documented timeline |
| --- | --- |
| Developer registration | **3 business days** |
| **Accounts API Access Application Form** (mandatory since **2026-03-20** for any "TikTok Accounts" scope) | **No published SLA — unverified** |
| App review | **2–3 business days** |
| Business Messaging (DSPR intake → DDQ) | **10 working days to *initiate*; no completion SLA, no status tracking** |
| US accounts (+ USDS VAQ + signed addendum) | ~1 week after DDQ; no SLA |

TikTok's own advice: *"we recommend excluding the US from this application to help speed
up the approval process."* Evidence that speeds review: ISO 27001, SOC 2, or a recent pen
test.

⚠️ **No documented sandbox for the business-api Accounts API** (developers.tiktok.com's
sandbox does not apply). Assume testing against a real Business Account we own.

## Policy — more permissive than Meta, and explicit

**Automation is LICENSED.** Developer ToS **§II.1(b)**, verbatim: *"You may … **use
automated means in your Application to collect information from or otherwise interact
with the TikTok Developer Services**."* A flat "no automation" reading is wrong.

**The actual bar, §III.3(c)**, verbatim: *"use the TikTok Developer Services … **without
TikTok's express written consent, for any commercial or unauthorized purpose, including
… communicating or facilitating any commercial advertisement or solicitation or
spamming**."* Note it is conditional, not absolute.

**Automated replies are explicitly blessed.** Community Guidelines, verbatim: *"**Some
businesses also use automated tools to reply to messages.**"* The only acknowledgment of
automated DM tooling in TikTok's corpus — and it says **reply**: inbound-triggered,
conversation-bound.

**Spam prohibition:** *"Using automation to run many accounts or send repetitive
content"*, *"Using bots or scripts to write **fake** reviews or comments"*. Our replies are
authentically attributed to the brand's own account, so the binding risk is **repetitive
content**, not fakeness. Vary copy.

⚠️ **Unverified:** I could not locate a consolidated *"TikTok API for Business Terms of
Service"*. The ToS quoted governs developers.tiktok.com. **Confirm the governing agreement
for a business-api app before legal sign-off.**

## Bottom line

**Ships everywhere, no security review:** automated **public comment reply** via
`comment.update` webhook → keyword match → `/business/comment/reply/create/`.
Needs registration + app review + the Accounts API form. **2–4 weeks.**

**The honest DM story is inverted** (and is what Manychat recommends): public reply says
"DM me X" → drive to a **TikTok.me short link**
(`tiktok.me/{username}?ref=…&message=…` pre-fills the user's chat input; ⚠️ *"only
function on the mobile TikTok app and does not work on TikTok Web"*) → `im_receive_msg`
fires → auto-respond within the 48h window. **6–12 weeks**, dominated by the DSPR review.

**Impossible:** cold-DMing a commenter anywhere outside VN/ID/TH; keyword-triggered
comment→DM as built on Instagram (the only path uses TikTok's classifier, not our
keyword); *any* Business Messaging for EEA/CH/UK accounts; comment→DM for US accounts even
with full approval; serving personal accounts; registering as an individual.

> **Blunt version: if the customer base is US/UK/EU, the comment→DM feature cannot be
> ported to TikTok at all.** What ships is public comment replies plus a "DM me the
> keyword" funnel.
