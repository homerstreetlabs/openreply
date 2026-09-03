# Setup

Everything needed to get OpenReply running end to end: hosting, the database, the environment, and the developer app for each platform you want to connect. Read the shared sections in order, then jump to the platform you care about.

The code deploys in minutes. The platform apps are the slow part. Instagram and Facebook cost an afternoon each. YouTube and TikTok cost weeks of waiting on review, so start those applications early even though the rest is not ready for them yet.

If you would rather have an AI assistant drive most of this, skip to [Set it up with an AI assistant](#set-it-up-with-an-ai-assistant) and come back when it asks for specifics.

## Contents

- [What OpenReply does on each platform](#what-openreply-does-on-each-platform)
- [How it is built](#how-it-is-built)
- [What you need first](#what-you-need-first)
- [Step 1: Deploy](#step-1-deploy)
- [Environment variables](#environment-variables)
- [Instagram setup](#instagram-setup)
- [Facebook setup](#facebook-setup)
- [YouTube setup](#youtube-setup)
- [TikTok setup](#tiktok-setup)
- [Running it for other creators](#running-it-for-other-creators)
- [When something is wrong](#when-something-is-wrong)
- [Test it end to end](#test-it-end-to-end)
- [Local development](#local-development)
- [Set it up with an AI assistant](#set-it-up-with-an-ai-assistant)
- [Going live](#going-live)
- [Security notes](#security-notes)

## What OpenReply does on each platform

The DM is not the universal capability. The public comment reply is. Every platform can reply publicly under a comment. Only the two Meta platforms can privately message the person who left it.

| | Instagram | Facebook | YouTube | TikTok |
| --- | --- | --- | --- | --- |
| Public reply under the comment | yes | yes | yes | yes |
| DM the commenter | yes, 24h, one per comment | yes, 7 days, one per comment | impossible, no messaging API exists | prohibited outside VN/ID/TH |
| Comment webhook | yes, plus a reconciler | yes, `feed` on the Page | none, polling only | yes, `comment.update` |
| Button templates and postbacks | yes | yes | no | no |
| Follow gate | yes | no | no | no |
| Token lifetime | 60 days, refreshed by cron | does not expire | refresh token | access 1 day, refresh 1 year |

A campaign step declares the capability it needs, and the campaign builder hides steps the target platform cannot perform. That is why a YouTube campaign offers no DM option rather than offering one that silently fails.

### What you can connect today

| Platform | Adapter | Webhook or sweep | Connect flow | Verified end to end |
| --- | --- | --- | --- | --- |
| Instagram | shipped | `/api/webhook` plus the reconciler | shipped | yes |
| Facebook | shipped | `/api/webhook/facebook` | shipped | yes |
| YouTube | shipped | quota-budgeted sweep | shipped | **no developer app yet** |
| TikTok | shipped | `/api/webhook/tiktok` | shipped | **no developer app yet** |

All four are built, including OAuth. What YouTube and TikTok are missing is an approved developer app, which is a review queue rather than code. Connecting is one route for every platform, `/api/connect/<platform>`, and the Settings page offers a platform once this instance holds credentials for it. Set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`, or the TikTok pair, and the button stops saying "coming soon" on the next load with no deploy.

Their code paths have not been exercised against a live app. Treat the first connection on each as a test, not a launch.

## How it is built

OpenReply is two Cloudflare Workers and one database.

- The web Worker (`openreply-web`) is the Next.js app. It serves the dashboard, the OAuth callbacks, and the incoming webhooks, and it queues a response job for every matched comment.
- The engine Worker (`openreply-engine`) consumes that queue, sends the replies, and runs five cron triggers: the comment reconciler and poll sweep every five minutes, a quota snapshot every fifteen, and daily token refresh, reel attach, and follower snapshot jobs. It exports two Durable Objects, `AccountRateLimiter` for the per-account send cap and `QuotaBucket` for the shared platform quotas.
- PostgreSQL holds campaigns, response runs, accounts, and sessions. Both Workers reach it through Hyperdrive.

Both Workers must share the same `DATABASE_URL` and the same `ENCRYPTION_KEY`. The web Worker writes an encrypted platform token; the engine decrypts it to send. Different keys mean every send fails to decrypt.

## What you need first

- A Cloudflare account on the Workers Paid plan, $5/month. Paid is mandatory, not a recommendation. The Free plan caps subrequests at 50 per invocation, and one webhook delivery fans out to roughly 500. Free's 3 MB bundle ceiling is also below the web Worker's size.
- A PostgreSQL database reachable from the internet. Neon's free tier is enough for a single account, and any other hosted Postgres works.
- A way to send email. Login is email magic links only, and creator invitations are email too, so without working mail nobody can sign in and no creator can be invited. The reference setup uses Cloudflare Email Sending through the Workers `EMAIL` binding, which needs the sending domain onboarded to Email Service. It is in public beta, on Workers Paid only.

  **A Worker cannot reach Cloudflare's SMTP relay.** Cloudflare IPs are on the Workers socket layer's disallowed list, alongside `localhost` and private addresses, so `smtps://smtp.mx.cloudflare.net:465` fails from inside a Worker with "cannot connect to the specified address". The SMTP bridge is for clients that are not Workers. That is why `EMAIL_SERVER` is a local-only fallback here and the binding is the production path.
- A developer account on each platform you want to connect. Every platform section below opens with what that costs.

## Step 1: Deploy

You do not need to buy a domain. Deploying the web Worker gives you a free public URL like `https://openreply-web.your-subdomain.workers.dev`, and that URL is what everything else points at. `NEXTAUTH_URL`, every OAuth redirect, and every webhook callback all use it. If you want a custom domain later, attach one to `openreply-web` in the Cloudflare dashboard.

Follow [deploy-cloudflare.md](deploy-cloudflare.md). It covers the Hyperdrive config, the queues, the database migration, login email, the secrets, and deploying the engine Worker before the web Worker. That order is required, because the web Worker's Durable Object bindings reference the engine by name.

Come back here with your public URL once `/api/health` responds. You will paste that URL into each platform's console a few times.

If your domain ever changes, update `NEXTAUTH_URL` on both Workers and every OAuth redirect and webhook URL you registered, or tracked links in DMs will point at the old domain and webhooks will silently stop.

## Environment variables

Copy `.env.example` to `.env` for local work. In production every value is a Worker secret set with `wrangler secret put`, on both Workers. [deploy-cloudflare.md](deploy-cloudflare.md#step-7-set-the-secrets) has the commands.

### Core

| Variable | What it is |
| --- | --- |
| `NEXTAUTH_URL` | Your public URL. The `workers.dev` URL or your custom domain in production, your tunnel URL locally. |
| `NEXTAUTH_SECRET` | Random secret. `openssl rand -base64 32` |
| `CRON_SECRET` | Random secret protecting the maintenance endpoints under `/api/cron`. |
| `ENCRYPTION_KEY` | 32-byte hex. `openssl rand -hex 32`. Encrypts platform tokens. Must be identical on both Workers, and exactly 64 hex characters or the app throws on boot. |
| `DATABASE_URL` | PostgreSQL connection string. Needed at build time for `prisma generate`, and by migrations and scripts. At runtime the Hyperdrive binding is used instead, and this is only a fallback. Never set it to a `localhost` or private address on a Worker. |
| `EMAIL_SERVER` | SMTP URL, used **only outside a Worker**: scripts, tests and `pnpm dev`. In production the Workers `EMAIL` binding sends instead, and this is never read. For Cloudflare Email Sending the URL is `smtps://api_token:<CF_API_TOKEN>@smtp.mx.cloudflare.net:465`, where the username is the literal string `api_token` and the password is an API token with the `Email Sending: Edit` permission. Any other SMTP server works too. URL-encode special characters, so `@` becomes `%40`. |
| `EMAIL_FROM` | The sender address, and required rather than defaulted. It must be on the domain you onboarded to Email Sending, because Cloudflare rejects any other sender. |

### Reviewer access, only while an app review is open

Set these two only when a platform reviewer needs to sign in, and unset them the day the review closes. Together they are a working credential.

| Variable | What it is |
| --- | --- |
| `REVIEWER_ACCESS_KEY` | Random secret. `openssl rand -hex 32`. `GET /api/reviewer-access?key=<value>` signs the reviewer straight in. Absent, the route is a 404 and there is no reviewer access at all. Unsetting it is how you revoke. |
| `REVIEWER_EMAIL` | The address the link signs in as. It must already belong to a user you invited, because the route mints a link for an existing account and will not create one. |

Give the reviewer the URL, not the key on its own. The link still passes through `admit()`, so suspending that user from Admins locks it out even before you unset the secret. See [App review](app-review.md).

### Meta, for Instagram and Facebook

| Variable | What it is |
| --- | --- |
| `META_GRAPH_API_VERSION` | Graph API version, for example `v25.0`. A plain var in both wrangler configs, not a secret. |
| `INSTAGRAM_APP_ID` | Instagram product, API setup with Instagram login. Not the same number as the Facebook App ID. |
| `INSTAGRAM_APP_SECRET` | Same page, click Show. |
| `FACEBOOK_APP_ID` | App settings, Basic, App ID. Required by the Facebook Page connect flow. |
| `FACEBOOK_APP_SECRET` | App settings, Basic, App secret, click Show. |
| `WEBHOOK_VERIFY_TOKEN` | Any random string. You paste the same value into Meta's webhook config for both Instagram and Facebook. |

Webhook signatures are verified against both `FACEBOOK_APP_SECRET` and `INSTAGRAM_APP_SECRET`, so you do not have to guess which one Meta signs with. Set both.

### TikTok

| Variable | What it is |
| --- | --- |
| `TIKTOK_WEBHOOK_SECRET` | The secret you registered with TikTok's webhook config. Until this is set the TikTok webhook rejects every delivery, deliberately. See [TikTok setup](#tiktok-setup). |
| `TIKTOK_CLIENT_KEY` | From the TikTok Business API app. |
| `TIKTOK_CLIENT_SECRET` | From the same app. |

### YouTube

| Variable | What it is |
| --- | --- |
| `YOUTUBE_CLIENT_ID` | The OAuth 2.0 Web application client id from your Google Cloud project. |
| `YOUTUBE_CLIENT_SECRET` | From the same client. |

### Polling

Defaults are fine to start.

| Variable | Default | What it does |
| --- | --- | --- |
| `COMMENT_POLL_MAX_PER_SWEEP` | `30` | Max new comments each campaign acts on per sweep. Higher gets closer to the platform's rate limits. |
| `COMMENT_POLL_LOOKBACK_HOURS` | `72` | How far back a sweep considers comments. |

The sweeps run on the engine Worker's five-minute cron trigger, set in `wrangler.engine.jsonc`.

---

## Instagram setup

**What it costs.** An afternoon. No company required, no review needed to run it for your own accounts.

**What you need.** A Facebook account, because Meta developer registration is built on it and there is no Instagram-only path. An Instagram Business or Creator account, because a personal account cannot be connected. Switch it in the Instagram app under Settings, Account type.

Have your public URL from Step 1 ready. You will paste it in a few times.

### Step 2: Create the Meta app

Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and create an app.

- App type: Business.
- Contact email: one you actually check.

When it asks you to add a use case, filter to All, then choose **Manage messaging and content on Instagram**. Do not pick "Create and manage ads with Marketing API", and do not pick "Authenticate with Facebook Login". OpenReply uses Instagram Login, and picking the Facebook Login variant makes the OAuth flow fail later with a mismatched client error.

If you accidentally added the Marketing API use case, remove it. It has its own heavy review requirements and can block publishing.

The same app carries Facebook later. Adding a second use case for Pages does not disturb this one. See [Facebook setup](#facebook-setup).

### Step 3: Collect the secrets

There are two app secrets and two app IDs, which is confusing. Here is what maps to what.

| Environment variable | Where it lives |
| --- | --- |
| `INSTAGRAM_APP_ID` | Instagram, API setup with Instagram login. A number like `2036...` |
| `INSTAGRAM_APP_SECRET` | Same page, click Show |
| `FACEBOOK_APP_ID` | App settings, Basic, App ID |
| `FACEBOOK_APP_SECRET` | App settings, Basic, App secret, click Show |

The Instagram app ID is not the same number as the Facebook App ID on the Basic settings page. Use the one under the Instagram product.

### Step 4: Add your Instagram account as a tester, and accept the invite

This is the step people miss, and it produces the error "Insufficient Developer Role" on the Instagram login screen. In development, only accounts that have a role on your app can connect. Even your own account has to be added and accept.

There are two halves. Both are required.

Half one, on the Meta side. In the app dashboard open App roles, then Roles. In the newer console this is also reachable from the Instagram product under "Generate access tokens". Find the section for Instagram testers, click add, and enter the exact Instagram username of the account you want to connect. Send the invite.

Half two, on the Instagram side. This is the part that gets skipped. Open Instagram as that account, where the phone app is easiest.

1. Go to your profile, then the menu, then Settings and activity.
2. Open Apps and websites. Older versions call it Website permissions, then Apps and websites.
3. Open Tester invites.
4. Accept the invite from your app.

Until you accept here, the account is not really a tester and the login will keep failing. If you do not see the invite, double-check you sent it to the exact username and that the account is a Business or Creator account.

### Step 5: Register the OAuth redirect

In the Instagram product open Set up Instagram business login, then Business login settings. In the OAuth redirect URIs field add exactly, using your public URL:

```
https://openreply-web.your-subdomain.workers.dev/api/connect/instagram/callback
```

No trailing slash. This is the only callback the app uses; the older `/api/instagram/callback` has been removed, because it was a second connect path that skipped capability negotiation, so accounts that came through it had an empty granted-capability set. Remove it from the app dashboard once you have confirmed the URL above works. If this is missing or wrong, connecting an account fails with a redirect_uri mismatch after the creator has already granted consent. You can register more than one, which is useful if you change domains later.

You do not need the "Embed URL" that Meta shows here. OpenReply builds its own login URL, and users connect by opening Settings and clicking Connect Instagram.

The scopes requested are `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, and `instagram_business_manage_insights`.

### Step 6: Configure the webhook

Still in the Instagram product, find the Configure webhooks step.

- Callback URL: `https://openreply-web.your-subdomain.workers.dev/api/webhook`
- Verify token: the value of `WEBHOOK_VERIFY_TOKEN` from your environment.
- Click Verify and save. It should succeed immediately, because the app answers Meta's verification challenge. If the button is greyed out, click into the verify-token field and paste the token again, because editing the callback URL often clears it.
- Subscribe to the `comments` field.

To test delivery without a real comment, click Test next to `comments`, then click Send to My Server. This is a two-step control. Clicking Test only previews the sample payload, and the second button is what actually POSTs it. After sending, a row should appear in your `WebhookEvent` table.

If your primary domain ever changes, update this callback URL. A non-primary domain will 307-redirect the POST, and Meta does not reliably follow redirects, so webhooks silently stop.

### Step 7: Publish the app

Real comment webhooks are only delivered when the app is in Live state. In Development mode only the console Test button delivers events. This is the single most common reason for "I set everything up and nothing happens."

Go to the Publish item in the left sidebar. Set the privacy policy, terms of service, and data deletion URLs first, or it will not let you publish. OpenReply ships these pages on your domain:

```
https://openreply-web.your-subdomain.workers.dev/privacy
https://openreply-web.your-subdomain.workers.dev/terms
https://openreply-web.your-subdomain.workers.dev/data-deletion
```

Then publish. Depending on your access level Meta may let you go live for your own tester accounts immediately, or it may require App Review first. See [app-review.md](app-review.md).

### Publishing is not Advanced Access

This one costs an afternoon because the symptom points nowhere near the cause.

A published app still holds **Standard Access** to `instagram_business_basic`, `instagram_business_manage_comments`, and `instagram_business_manage_messages`. Standard Access only covers Instagram accounts that have a role on your app: admins, developers, and Instagram testers. Publishing makes the app live, and it does not widen who the permissions apply to. Advanced Access, which covers everyone else, comes only from App Review.

So connecting a second account fails even though the first one works, on the same app, with the same code.

The symptom: Instagram's consent screen appears and the login succeeds, and the code exchange at `api.instagram.com/oauth/access_token` returns a normal `IGAA…` token with all the requested permissions. Then every single call against `graph.instagram.com` is refused.

```
Unsupported request - method type: get  [code=100, type=IGApiException]
```

`/access_token`, `/refresh_access_token`, and `/me`, all of them, identically. Nothing about the message suggests a missing role, and the token itself looks fine.

The fix for your own accounts is the same two-part dance as Step 4, once per account. Invite the Instagram username under App roles, Roles, Instagram testers, then accept the invite inside Instagram under Settings and activity, Apps and websites, Tester invites. For accounts you do not control you need App Review.

### The account ID trap

You do not have to do anything here, because OpenReply handles it. It is worth understanding because it is invisible when it goes wrong.

Meta's `/me` returns two IDs. The `id` field is app-scoped. The `user_id` field is the Instagram professional account ID. Webhooks put `user_id` in `entry.id`, and the messaging API keys off `user_id` too. OpenReply stores `user_id`, so a fresh connection matches correctly. If you upgraded from a very old build and an account was stored with the wrong ID, disconnect and reconnect it once.

---

## Facebook setup

**What it costs.** An hour on top of the Instagram app, because it is one more use case on the same app. No review needed for a Page you own.

**What you need.** A Facebook Page you administer, and the Meta app from [Instagram setup](#instagram-setup). Facebook Reels are supported, which is the point for UGC creators.

Verified against official Meta documentation on 2026-08-24. This area is full of pages that contradict each other, so every claim below carries the reason it is here.

### The short version

Add one use case to the app you already have: **Engage with customers on Messenger from Meta**. That is enough to DM someone who comments on your Reel. You need a second use case only if you also want to post public comment replies or read comments through the Graph API rather than only from webhooks.

### Why the dashboard blurb is misleading

Meta's catalog describes the use case as *"Respond to messages sent to your business' Facebook Page. You can set up automatic replies or use a human agent to respond."*

That reads like it only covers replying to inbound messages. It undersells what the use case grants.

Private Replies is a first-class Messenger Platform feature, listed alongside m.me Links and the Checkbox Plugin in Meta's own feature index. It is defined as sending *"a single message to a person who published a post on your business' Facebook Page or who commented on a post or comment on the business' Facebook Page or Group."*

The permission that authorises it is `pages_messaging`, which the Messenger use case grants as required and non-removable. Meta's Private Replies doc lists the complete set of prerequisites, and `pages_messaging` is the only permission among them. There is nothing else to add.

### Step 1: Add the use case

In the app dashboard add **Engage with customers on Messenger from Meta**. These permissions come with it and cannot be removed once added.

| Permission | Why it matters here |
| --- | --- |
| `pages_messaging` | Authorises the private reply. The only permission the send needs. |
| `pages_manage_metadata` | Required for the `feed` webhook that delivers comment events. |
| `pages_show_list` | Required alongside it for the same webhook. |
| `business_management` | Granted by the use case as required and non-removable. Declare it in App Review. OpenReply does not request it at the consent screen and calls no Business Manager endpoint. |
| `public_profile` | Shared with your Instagram use case. See the warning below. |

Tick **`pages_read_engagement`** as an optional on the same use case, so you can read a comment's `can_reply_privately` flag before spending the one reply you get. OpenReply requests it.

The useful accident here is that the Messenger use case is the one that gives you comment webhooks. It requires both `pages_manage_metadata` and `pages_show_list`, which is exactly the pair the `feed` webhook needs. "Manage everything on your Page" does not, because it makes `pages_manage_metadata` optional.

Add **Manage everything on your Page** as well only if you want `pages_manage_engagement`, to post a public reply under the comment, or `pages_read_user_content`, to read comments and posts through the Graph API rather than taking them from the webhook payload. Both exist in that use case and nowhere else, as optional adds.

**Use cases cannot be removed once added.** Check that "Manage everything on your Page" is not greyed out before you add the Messenger use case, if you think you will want public comment replies later. Meta greys out incompatible use cases in the dashboard and publishes no compatibility matrix, so the dashboard is the only place to find out.

`public_profile` is shared between the Messenger use case and your Instagram use case. Meta warns that changing its access level *"will affect the use cases listed below."* Leave it alone.

The one documented incompatibility is the consumer **Authenticate and request data from users with Facebook Login** use case. Do not add that one. It is not what OpenReply's Page connect flow uses.

### Step 2: Register the OAuth redirect

The Facebook connect flow uses Facebook Login for Business with the Meta App ID, which is a different host and a different client ID from the Instagram flow. Both coexist on one app. In Facebook Login for Business settings, add:

```
https://openreply-web.your-subdomain.workers.dev/api/connect/facebook/callback
```

The older `/api/facebook/callback` still works. Keep both listed through the cutover.

Set `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` in your environment. The connect flow requests `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, and `pages_read_engagement` — the four it actually uses. It does not request `business_management`, even though the use case grants it, because nothing here calls a Business Manager endpoint. That does not remove it from the App Review submission; see [app-review.md](app-review.md).

Connecting brings across every Page you can message, so one authorisation enrols all of them.

### Step 3: Configure the Page webhook

Subscribe the `page` object to the `feed` field, with:

- Callback URL: `https://openreply-web.your-subdomain.workers.dev/api/webhook/facebook`
- Verify token: the same `WEBHOOK_VERIFY_TOKEN`.

This is a separate route from Instagram's on purpose. The two objects are configured in different products, and an Instagram-Login app signs with a different secret than the Meta app, so each route binds exactly one secret rather than trying every known one.

Meta expects a 200 within five seconds and unsubscribes the app after an hour of failures, so the route verifies, enqueues, and answers, and writes its audit record after the response.

### Reels are supported

Messenger Platform changelog, 12 October 2023: *"Private Reply is now available for comments on Facebook Reels."*

That changelog entry is the only official statement on the subject. The Private Replies doc itself never mentions Reels. Treat it as authoritative, and expect no Reels-specific guidance anywhere else.

### The limits you are working inside

From Meta's Private Replies limitations, verbatim.

- *"Only one message can be sent to the person who commented"*
- *"The message must be sent within 7 days from when the post or comment was created"*
- *"Only when a person responds to the private message can you continue the conversation within the 24-hour messaging window."*
- *"Standard Access apps can only access data for people who have a role on the app"*
- *"Cannot send private reply message to another facebook page"*

The one-reply rule is the same shape as Instagram's, with a 7-day window instead of 24 hours. The engine models this as an exclusive claim, so Facebook inherits the behaviour without new logic.

Two fields on the Comment node make the send safe, and Instagram has no equivalent. `can_reply_privately` tells you whether a private reply is possible at all, so it works as a pre-flight gate that stops you burning the single allowed reply on an ineligible comment. `private_reply_conversation` returns the conversation if a reply was already sent, which gives idempotency without tracking sent state yourself.

### Three things that will bite you

**Listing a Page's Reels has no fully documented path.** `GET /{page-id}/video_reels` is documented in the Reels publishing guide. The Graph API reference for the same edge says *"You can't perform this operation on this endpoint."* and the edge is absent from the Page node's edge list. Meanwhile the feed reference points you at that edge, because `/feed` and `/posts` explicitly exclude Reels: *"This endpoint does not return Reels."* Spike this endpoint before relying on a post picker built on it.

**The reel comment webhook shape is undocumented.** The `page` object's `feed` field has an `item` enum with no `reels` value, there is no separate reels webhook field, and Meta publishes no sample payload for a `feed` comment at all. The only `item: "comment"` sample anywhere is for `group_feed`. A reel comment almost certainly arrives as `field: "feed"`, `item: "comment"`, `verb: "add"`, but that is inference, not a contract. The adapter parses defensively, keys on `comment_id`, treats every other field as optional, and logs any `item` value it does not recognise, so the real shape can be learned from production.

**App Review needs a video, not screenshots.** `pages_messaging` review requires a screencast showing the message actually being sent from your app and landing in a Messenger inbox. Meta's reference says explicitly it must be *"a recording of the message being sent from the app to the user, instead of sharing screenshots."* This is where messaging reviews usually bounce.

You do not need App Review to run this against your own Page. You need it, plus Business Verification, the moment a Page you do not own connects.

### What this does not change

Your Instagram flow is untouched. "Instagram API with Instagram Login" is a setup mode inside the Instagram use case, not a use case of its own. The rule that trips people up, *"You can only add one setup per app"*, is about Instagram Login setup versus Facebook Login setup. It says nothing about adding other use cases.

---

## YouTube setup

**What it costs.** A Google Cloud project is free and takes minutes. OAuth verification takes up to ten business days. Plan for the longer of the conflicting published timelines.

**What you get.** Public comment replies on videos and Shorts. Nothing else.

Verified against Google's documentation on 2026-08-24.

### A DM is impossible, and that is not a limitation of this app

The YouTube Data API v3 has no messaging resource. The `comment` resource exposes only `authorDisplayName`, `authorProfileImageUrl`, `authorChannelUrl`, and `authorChannelId.value`, so there is no identifier a message could be routed to. The 2025 DM revival is mobile-app only, mutual opt-in, with no API. The adapter therefore declares one capability, `PUBLIC_REPLY`, and the campaign builder offers no DM step for a YouTube account.

A public reply does reach the commenter. YouTube's notification settings include "Replies to my comments", so it lands in their notifications and email. It is public and permanent.

There is also no comment webhook. WebSub fires on video uploaded, title updated, and description updated, and nothing else. Discovery is polling only, which is why YouTube accounts go through the quota-budgeted sweep rather than a webhook route.

### Step 1: Create the Google Cloud project

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **YouTube Data API v3** for it.
3. Create an OAuth 2.0 Client ID of type Web application.
4. Add `https://openreply-web.your-subdomain.workers.dev/api/connect/youtube/callback` as an authorised redirect URI.
5. Set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` on both Workers. The Connect button appears once they are set.

The connect flow requests `access_type=offline` and `prompt=consent`. Both matter: without them Google returns no refresh token on a re-authorization, and the account becomes unrefreshable an hour later with nothing to say why.

**Create exactly one project.** Developer Policies section III.D: *"you must create exactly one (1) API Project for that API Client… you must not use that one (1) API Project for multiple API Clients."* Terms of Service section 15 forbids circumventing quota. Sharding across projects to get more quota is explicitly prohibited, not merely discouraged.

### Step 2: Understand the quota before you design around it

Quota is the binding constraint, and it belongs to the project rather than to a creator.

The default allocation is **10,000 units a day per Google Cloud project**, reset at midnight Pacific.

| Call | Cost |
| --- | --- |
| `commentThreads.list`, all threads on a channel in one call | 1 unit |
| `comments.list` | 1 unit |
| `comments.insert`, the public reply | **50 units** |
| `channels.list`, `playlistItems.list`, `videos.list` | 1 unit each |

`comments.insert` at 50 units means a hard ceiling of roughly **200 automated replies a day for the entire instance, across every creator**, before spending anything on polling. Realistic at default quota is 10 to 25 channels at 2 to 7 minute latency and about 100 replies a day. More requires a compliance audit through YouTube's API services form, which has no published SLA, and YouTube may require you to hand over a working account so they can exercise the automation themselves.

Never use `search.list`. It has its own bucket of 100 calls a day project-wide.

The sweep budgets this pool before it looks, and a fair share inside the pool is what stops one channel spending it all.

### Step 3: OAuth consent and verification

The only write scope available is `youtube.force-ssl`, described on the consent screen as *"See, edit, and permanently delete your YouTube videos, ratings, comments and captions."* There is no narrower scope for posting a reply. It reads badly, and that is unavoidable.

That scope is **sensitive**, not restricted, so OAuth verification is required but a third-party security assessment is not. Published timelines conflict between three to five and ten business days. Plan for ten.

Two traps that are unrecoverable if you hit them.

**Testing publishing status is unusable in production.** It is capped at 100 test users, and *"Authorizations by a test user will expire seven days from the time of consent… refresh token will also expire."*

**An unverified app in Production is capped at 100 new users for the project's entire lifetime, and Google states the cap "cannot be reset or changed."** Burning it during testing cannot be undone. Verify before onboarding anyone real.

### Step 4: Know the two policy clauses that reshape the product

**Section III.E, Authorized Data Usage:** *"API Clients must clearly identify any actions that they take to insert, share, update, or delete data or content on the authorizing user's behalf. In addition, the user must expressly consent to those actions prior to their actual execution."*

The creator must approve the rule and the exact reply text in your UI before it fires. A one-time OAuth grant is not sufficient consent.

**Section III.F, User Experience:** *"API Clients must not offer or provide incentives, rewards, or other compensation to users for engaging with YouTube Applications (directly or indirectly) by performing actions like viewing content, liking content, sharing content, subscribing to channels, adding comments."*

"Comment LINK below and I'll send you the guide" is prohibited on YouTube. The comment-triggered reply is defensible, and incentivising the comment to trigger it is not. This kills the Instagram growth mechanic on this platform independently of anything technical.

YouTube's spam policy applies to the creator's channel, and they take the strike, not you. *"Comment spam: Using high-volume, repetitive, or deceptive comments… to drive traffic to or engagement with content."* High-volume identical templated replies carrying an outbound link is a textbook match. Reply text must vary and per-video volume must be capped.

---

## TikTok setup

**What it costs.** Two to four weeks, and a company. Individual developers are barred.

**What you get.** Public comment replies, globally, with no security review. Not DMs.

Verified against TikTok's documentation on 2026-08-24.

### Use the right developer platform

TikTok runs two entirely separate developer platforms, with separate registration, OAuth, scopes, and review. Conflating them is why this question usually gets answered wrongly.

| | `developers.tiktok.com` | `business-api.tiktok.com` |
| --- | --- | --- |
| Read comments on own videos | no | yes |
| Reply to comments | no | yes |
| Comment webhook | no | yes |
| Individual developers | allowed | **barred** |

Everything OpenReply needs is on **business-api.tiktok.com**. `developers.tiktok.com` has exactly 17 scopes and none of them is `comment.*` or `message.*`.

One trap worth naming: `/doc/direct-message-sharing` is the Mini Games SDK contact picker, not a DM API.

### Initiating a DM is prohibited

From "Manage direct messages for a Business Account", verbatim: *"You are prohibited from initiating a conversation or messaging any TikTok user who has not started a conversation with you."*

There is one carve-out, Comment-to-Message, and it does not help. It reaches only Business Accounts registered in Vietnam, Indonesia, and Thailand, only commenters registered in APAC, LATAM, and METAP, and it fires on TikTok's own high-intent classifier rather than a keyword you choose. Keyword matching cannot force a DM.

On top of that, the Business Messaging API is *"not yet available in the European Economic Area, Switzerland or the UK market"*, and US Business Accounts additionally require passing the Data Security and Privacy Review, the US data security review, and signing the USDS Addendum.

If your creators are in the US, UK, or EU, comment-to-DM cannot be ported to TikTok at all. What ships is public comment replies, plus a "DM me the keyword" funnel that inverts the direction. The adapter declares `messaging: null` for exactly this reason, rather than exposing methods that would throw.

### Step 1: Register as a developer

Self-serve, but with hard requirements.

- **A company.** *"we are unable to onboard personal accounts or individual developers."*
- **A company-domain email.** *"You will be rejected if you are using a personal email."*
- **A company website** that is publicly accessible without login, on a company-owned domain.

| Step | Documented timeline |
| --- | --- |
| Developer registration | 3 business days |
| Accounts API Access Application Form, mandatory since 2026-03-20 for any TikTok Accounts scope | no published SLA |
| App review | 2 to 3 business days |
| Business Messaging, if you ever pursue it | 10 working days to initiate, no completion SLA |

TikTok's own advice is to exclude the US from the application to speed approval. Evidence that speeds review includes ISO 27001, SOC 2, or a recent penetration test.

There is no documented sandbox for the Business API Accounts endpoints. The sandbox on `developers.tiktok.com` does not apply, so assume testing against a real Business Account you own.

### Step 2: Configure OAuth

Request `user.info.basic`, `video.list`, `comment.list`, and `comment.list.manage`.

Redirect URL rules are unusually strict. HTTPS only, **must end with a trailing slash**, no query parameters, no anchors, no ports, 10 to 512 characters, up to 10 per app. Register `https://openreply-web.your-subdomain.workers.dev/api/connect/tiktok/callback/`, with the trailing slash. The adapter normalises the URI it sends, so the two cannot disagree.

Token lifetimes: the `auth_code` lasts 10 minutes and is single use, the `access_token` lasts one day, and the `refresh_token` lasts one year, after which the user must re-authorise.

Append `&disable_auto_auth=1` to the authorize URL or returning users are silently redirected without an `auth_code`.

The token response returns `open_id`. That value is what every Business API call passes as `business_id`, and it is stored on the connected account rather than in the environment, because one instance serves many creators and they do not share one. Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` on both Workers; the Connect button appears once they are set.

Tell creators to set their TikTok Business Account to accept direct messages from everyone in the TikTok app before authorising. Otherwise the owner must manually accept each message request before webhooks fire.

### Step 3: Configure the webhook, and set the secret

Register the callback with `POST /business/webhook/update/`, `event_type: "COMMENT"`, your `callback_url`, and a `secret`. The config endpoints need no permission.

- Callback URL: `https://openreply-web.your-subdomain.workers.dev/api/webhook/tiktok`
- Set the same secret as `TIKTOK_WEBHOOK_SECRET` in both Workers.

**The route rejects every delivery until that secret is set, and this is deliberate.** TikTok's webhook config accepts a secret, but the signing algorithm, header name, and signed byte range are not documented anywhere. The adapter fails closed rather than accepting unverified bodies, because an ingestion endpoint that triggers outbound activity on a creator's account is the highest-severity thing in this system to leave unauthenticated. Confirm the scheme against a real delivery before trusting it.

`comment.update` fires *"within five minutes of a comment or reply being created, deleted, or … visibility settings … modified"*, for posts published through the API and manually in the app. It requires the account to have granted `comment.list`.

Two payload details matter. The `content` field is a **JSON-encoded string, not a nested object**, so it has to be parsed. And `text` is in the payload, which means a keyword match needs no follow-up read.

### Step 4: Vary your reply copy

TikTok's own anti-spam warning, verbatim: *"To prevent comments from being flagged as spam and subsequently hidden by the system, avoid posting a high volume of comments with largely similar content within a short timeframe. If a comment is flagged as spam, you will not receive the `comment.update` webhook event with `comment_action` set to `set_to_public`."*

That missing `set_to_public` event is the only shadow-hide detector available. Use the campaign's variant pool rather than one fixed reply.

Rate limits are two-level: 40 QPM per authorised account per endpoint, and 600 QPM app-wide at the default Basic tier. Webhook-driven replies sit comfortably inside that. Polling does not, since roughly 15 accounts polling once a minute exhausts the app-wide ceiling. Throttle code `40100` means wait five minutes for a QPM breach, or until 00:00 UTC for a daily one.

---

## Running it for other creators

Everything above runs OpenReply for accounts you own. This section is for hosting it for UGC creators who enrol their own accounts.

### Give yourself a platform grant

Cross-creator access is deliberately not workspace membership. A platform admin is not a member of every workspace, because membership is what a creator sees in their own member list, and an operator appearing there would be alarming and wrong. Access comes from a `PlatformGrant` row instead, so both the standing permission and each use of it are recorded.

Registration is invitation-only, so a fresh install has nobody who can send the first invitation. Set `BOOTSTRAP_ADMIN_EMAILS` to your address, sign in, then open **Users** and grant yourself `ADMIN`. The variable only applies while `PlatformGrant` is completely empty, so it disarms itself the moment that first grant exists and leaving it set cannot become a standing backdoor.

After that, every grant, revoke and suspend happens on the Users page, and each one is recorded in `AdminAccessLog`. The SQL below is the escape hatch for an install where you cannot sign in at all:

```sql
INSERT INTO "PlatformGrant" (id, "userId", tier, "grantedByUserId", reason)
SELECT
  gen_random_uuid()::text,
  u.id,
  'ADMIN',
  u.id,
  'bootstrap'
FROM "User" u
WHERE u.email = 'you@example.com';
```

Three tiers exist, ordered least to most.

| Tier | What it can do |
| --- | --- |
| `SUPPORT_READ` | Fleet health and failure classifications, but not message or comment bodies. |
| `SUPPORT_FULL` | Adds the content a failure quotes back. |
| `ADMIN` | Adds inviting creators. |

`SUPPORT_READ` deliberately excludes content, because almost every support question is answerable from statuses and error taxonomies. Give support access an `expiresAt`, since an expired grant is indistinguishable from never having had one, which is the point. Every use of a grant writes an `AdminAccessLog` row naming the admin, the grant, the action, and the workspace, or null when the read genuinely spanned every creator.

Once the grant exists, Fleet and Creators appear in the sidebar.

### Invite a creator

Open **Creators**, enter an email and an optional name, and send. The invitation creates the creator's own workspace, so they land in a space that is theirs and connect their own accounts to it. This is distinct from a workspace invitation, which adds a person to a workspace that already exists.

The email goes out through the same transport as sign-in, the Workers `EMAIL` binding. Delivery failure does not fail the invitation, and the row records the bounce so you can see the address failed rather than assuming the creator ignored it. Links expire after 14 days, and re-inviting the same address replaces the token, which invalidates any link already sent.

The creator clicks the link, signs in with the address it was sent to, and lands in Settings ready to connect an account.

### Watch the fleet

**Fleet** answers "what is broken and why" for every connected account across every creator, worst first. Each account is `HEALTHY`, `DEGRADED`, or `BROKEN`, read straight from the response-run ledger rather than a scan.

Open problems are grouped by kind, which answers the other question an admin has: whether forty accounts are broken for forty reasons or for one.

This is the alerting system, not a dashboard on top of one. Cloudflare Notifications has no Workers alert type at all, so there is no alerting on Worker error rate, queue backlog, or a failed cron. Check it, or nothing will tell you.

---

## When something is wrong

| Symptom | Cause |
| --- | --- |
| `permission denied for schema public` on migrate | The app user lacks `CREATE` on `public`. See [deploy step 3](deploy-cloudflare.md#step-3-migrate-the-database). |
| `The "path" argument must be of type string` on engine deploy | `runtime = "workerd"` missing from the Prisma generator. Set it, then `pnpm db:generate`. |
| `checks.database` says `cannot connect to the specified address` | The Hyperdrive binding is not attached. Re-deploy the Worker; secrets alone do not attach bindings. |
| `[auth][error] ... cannot connect to the specified address` | Email is going over SMTP instead of the `EMAIL` binding. Re-deploy after adding `send_email`. |
| Sign-in fails after a domain change | `NEXTAUTH_URL` must be the exact host, on both Workers, with no trailing slash. |
| Webhooks stop arriving after a domain change | Meta's callback URL is app-global and does not follow redirects. Update it and re-paste the verify token. |

## Test it end to end

Instagram is the fastest path to a working demo.

1. Make sure the account is a tester and has accepted the invite, and the app is published.
2. Connect it in the app under Settings, Connect Instagram. You should reach Instagram's consent screen, not the "Insufficient Developer Role" error.
3. Create a campaign on one of your posts with a keyword like `TEST`.
4. From a different account, comment `TEST` on that post. It must be a different account, because OpenReply ignores your own comments on purpose.
5. Watch for the DM. If nothing arrives, check the logs page and `/api/health`.

Hit `/api/health` any time. It reports `database`, `queue`, and `engine`, and returns `status: ok` with HTTP 200 when all three pass, or `degraded` with 503 otherwise. If `checks.engine.healthy` is false, queued jobs are not being consumed and no reply will send even though webhooks are arriving. Watch the consumer with `pnpm exec wrangler tail openreply-engine` while it happens.

To inspect where a comment stopped, the Postgres tables tell you. `WebhookEvent` records delivery. `DmLog` carries response-run status and errors, and the Prisma model is named `ResponseRun` over that table. `StepOutcome` records each step of a run, and is the idempotency primitive. `DeliveryClaim` is the exclusive ledger that enforces one reply per comment. `Incident` holds open problems per account. `OperationalEvent` holds engine errors and sweep logs.

## Local development

You need Postgres. The included `docker-compose.yml` starts it with `docker-compose up -d`. The Redis container in that file is a leftover from the old stack and nothing reads it. Or install Postgres natively on macOS:

```bash
brew install postgresql@16
brew services start postgresql@16
createdb openreply
```

Set `DATABASE_URL` in `.env` to match, for example `postgresql://YOUR_USER@localhost:5432/openreply`, then prepare the schema:

```bash
pnpm db:generate
pnpm db:migrate
```

Run the app:

```bash
pnpm dev
```

Under plain `next dev` the Cloudflare bindings do not exist, so enqueuing a send logs a warning and nothing sends. That is fine for dashboard work. To exercise the real Worker build locally, run it in workerd with the bindings from `wrangler.jsonc`:

```bash
pnpm preview
```

The engine Worker runs locally the same way, with `pnpm exec wrangler dev --config wrangler.engine.jsonc`. After changing bindings in either wrangler config, regenerate the types with `pnpm cf-typegen`.

For a platform to reach your local webhook, run a tunnel and point `NEXTAUTH_URL` and the registered redirect and webhook URLs at the tunnel:

```bash
ngrok http 3000
```

## Set it up with an AI assistant

If you run an AI coding assistant like Claude Code or Cursor, it can drive most of this for you. Open a clone of this repo inside your assistant and paste the prompt below. Give it your keys as it asks for them.

A word of caution. The assistant will need real secrets to finish, including platform app secrets, a Cloudflare API token, and database URLs. Only paste those into a tool and environment you trust, and rotate them afterward if you are unsure.

```
You are helping me self-host OpenReply, an open source comment-to-DM automation
tool, in this repository. Read README.md, docs/setup.md, and
docs/deploy-cloudflare.md first, then help me get it running end to end.

My goal: <describe it. For example: run it for my own Instagram account only,
or host it for UGC creators who connect their own accounts.>

Which platforms I want: <Instagram, Facebook, YouTube, TikTok. Note that only
Instagram and Facebook have a connect flow today.>

Work through this in order and stop to ask me whenever you need a value or an
action only I can do:

1. Local or hosted. Ask me which I want. If hosted, we deploy two Cloudflare
   Workers per docs/deploy-cloudflare.md, which needs my Workers Paid account
   and a hosted Postgres. If local, we use docker-compose and a tunnel.

2. Database. Help me get a Postgres running, create the Hyperdrive config
   with --caching-disabled, and run the Prisma migration against it.

3. Environment. Generate NEXTAUTH_SECRET, CRON_SECRET, ENCRYPTION_KEY, and
   WEBHOOK_VERIFY_TOKEN for me. Help me build EMAIL_SERVER, either for
   Cloudflare Email Sending or my own SMTP server, and ask me for the platform
   secrets once I create each app. Make sure ENCRYPTION_KEY and DATABASE_URL
   are identical on both Workers.

4. Deploy the engine Worker first, then the web Worker, set the secrets on
   both, and confirm /api/health returns ok.

5. Platform apps. Walk me through the section of docs/setup.md for each
   platform I named, one step at a time. This is the slow part. Tell me
   exactly what to click and what to paste, using my Workers URL for the OAuth
   redirects and webhooks. For Meta, remember the account ID trap (store
   user_id, not id) and that the app must be published for real webhooks to
   arrive.

6. Test. Have me create a campaign and comment a keyword from a second
   account, then confirm the reply sent by checking the DmLog table and the
   logs page.

Rules for you:
- Never invent dashboard steps for any platform. If a screen does not match the
  guide, ask me to screenshot it.
- Diagnose failures by querying the Postgres tables directly: WebhookEvent for
  delivery, DmLog for run status, StepOutcome for which step stopped,
  DeliveryClaim for whether a reply was already claimed, Incident for open
  problems, OperationalEvent for engine errors. This is faster than logs.
- Remind me to rotate any secret I paste to you before real use.

Start by reading the docs, then ask me question 1.
```

By the end, `/api/health` returns `status: ok` with every check passing, and a comment with your keyword from a second account produces a `SENT` row in the logs. If you get there, you are done.

## Going live

Everything above is enough to run OpenReply for your own accounts, or a handful of accounts you add as testers. No review needed on Meta.

For a stranger to connect their own account to your hosted instance, each platform has its own gate. They are collected in [app-review.md](app-review.md): Meta App Review plus Business Verification, Google OAuth verification, and TikTok's registration and Accounts API form.

## Security notes

- `.env` is gitignored. Keep it that way.
- Rotate any secret that has been pasted anywhere it could be logged, including a chat with an AI assistant.
- Platform tokens are encrypted at rest with `ENCRYPTION_KEY`. Losing or changing it means every connected account has to reconnect.
- The TikTok webhook fails closed without `TIKTOK_WEBHOOK_SECRET`. Do not work around that by accepting unverified bodies. It is the one endpoint where an unauthenticated POST triggers outbound activity on a creator's account.
- Give support staff `SUPPORT_READ` with an expiry rather than `ADMIN`. Every cross-creator read is logged either way.
