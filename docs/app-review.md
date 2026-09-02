# App review and verification

You need this only when someone who is not a tester on your app connects their own account. Running OpenReply for accounts you own never needs any of it. See [Running it for other creators](setup.md#running-it-for-other-creators) for what changes when strangers connect.

Every platform gates this differently, and the gates are not comparable in cost.

| Platform | Gate | Cost |
| --- | --- | --- |
| Instagram | Meta App Review, plus Business Verification | A screencast, written justifications, and a company document. Expect a resubmit. |
| Facebook | The same App Review and Business Verification, plus a `pages_messaging` screencast | Same, and messaging reviews bounce more often. |
| YouTube | Google OAuth verification | Up to 10 business days. No third-party security assessment. |
| TikTok | Developer registration, app review, and the Accounts API Access Application Form | 2 to 4 weeks, and a company. Individual developers are barred outright. |

---

## Meta: Instagram

OpenReply uses the official Instagram API to send a private reply to someone who comments on a connected professional account's post or reel.

### Permissions to request

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`
- `instagram_business_manage_insights`

### Permission justifications

Paste these into the App Review request, adjusted to your wording.

**`instagram_business_basic`.** We use this to identify the connected Instagram professional account after the user authorizes through Instagram business login, so we can associate the account with their workspace and show which account each campaign belongs to.

**`instagram_business_manage_comments`.** When a follower comments a keyword the account owner configured on the owner's own post or reel, we receive the comment through the comments webhook and, if the owner enabled it, post a public reply under that comment. We only act on comments on the connecting account's own media.

**`instagram_business_manage_messages`.** After a follower comments a configured keyword, we send that follower a one-time private reply with content the account owner set up, typically a link or answer the follower asked for by commenting. This is the standard Instagram comment-to-DM flow. We send one reply per matching comment and respect Meta's rate limits.

**`instagram_business_manage_insights`.** We read account-level metrics for the connected account so the owner can see reach and follower history for the campaigns they run. We do not read metrics for any account other than the one that authorized us.

### Screencast script

Record on your published app, with real accounts, in one take, about two to three minutes. Narrate each step.

1. Sign in with an email magic link.
2. Go to Settings and click Connect Instagram. Show the consent screen with the permissions being granted.
3. Create a campaign on a recent post with keyword `LINK`, a DM message, and save.
4. On a second phone or account, comment `LINK` on that post.
5. Show the second account receiving the DM, and the public reply appearing under the comment.
6. Back in the app, show the logs page with the SENT row.

Reviewers want to see the permission produce a real result for a real user. This flow does that directly.

---

## Meta: Facebook Pages

Same app, same review submission, one more set of permissions. Facebook is where messaging reviews usually bounce, for one specific reason.

### Permissions to request

- `pages_messaging`, which authorises the private reply
- `pages_manage_metadata` and `pages_show_list`, which the `feed` comment webhook needs
- `pages_read_engagement`, to read `can_reply_privately` before spending the single allowed reply
- `business_management`, granted by the Messenger use case as required and non-removable, so it appears in the submission even though the connect flow does not request it and no code calls a Business Manager endpoint
- `pages_manage_engagement`, only if you post public comment replies on Facebook

### The screencast requirement that fails submissions

`pages_messaging` review requires a video, not screenshots. Meta's reference says explicitly it must be *"a recording of the message being sent from the app to the user, instead of sharing screenshots."*

Record the message actually being sent from your app and landing in a Messenger inbox, in one take. A screenshot of the sent message is the most common reason a `pages_messaging` submission is rejected.

`business_management` is required by the use case rather than chosen, so say that in the justification. Reviewers ask why a comment-reply tool wants business management, and "the Messenger use case grants it as required and non-removable, and the app neither requests it at the consent screen nor calls a Business Manager endpoint" is the honest and sufficient answer.

---

## Giving a reviewer a way in

Sign-in is a magic link and registration is invitation-only, so an invitation alone strands a reviewer at the login form: the link goes to a mailbox they do not hold. Meta asks for working credentials, and "check the email we sent you" is not one.

Invite the reviewer address from Admins like any other creator, then set `REVIEWER_ACCESS_KEY` and `REVIEWER_EMAIL` (see [setup](setup.md#reviewer-access-only-while-an-app-review-is-open)) and give Meta the URL:

```
https://your-domain/api/reviewer-access?key=<REVIEWER_ACCESS_KEY>
```

Connect a real Instagram professional account and a real Page to that workspace before you submit. A reviewer who signs in to an empty workspace sees a product that does nothing, which reads as a broken integration rather than an unconfigured demo.

Unset `REVIEWER_ACCESS_KEY` when the review closes. It is a standing credential while it exists, and nothing expires it for you.

Separately, `pages_messaging` review needs a real Facebook account holding the **Tester** role in App Roles. Meta's own note in the submission form is explicit that a test user created in App Roles will not do, because those cannot receive bot messages.

## Meta: Business Verification

Meta usually requires business verification before granting Advanced Access on either platform. It asks for a document proving a legal entity: a business registration or license, articles of incorporation, a business tax document, or a business bank statement.

If you do not have a registered business, you cannot complete this step. The practical path is to run OpenReply for your own accounts instead, which never needs review.

Meta scrutinizes automated-DM apps and often rejects the first submission, so budget for a resubmit.

### Compliance positioning

These hold across both Meta platforms and are worth stating in the submission.

- The app never scrapes and never asks for a password. Every action is an official API call.
- It only sends a reply when someone comments on the connected account's own content.
- Tokens are encrypted at rest with AES-256-GCM.
- Users can disconnect an account from Settings.
- Per-account rate limiting and an exclusive claims ledger prevent duplicate and spammy behaviour. One comment can produce exactly one reply, enforced by a unique constraint rather than by a read-then-write check.

---

## Google: YouTube OAuth verification

The only write scope available is `youtube.force-ssl`, presented on the consent screen as *"See, edit, and permanently delete your YouTube videos, ratings, comments and captions."* There is no narrower scope for posting a comment reply.

That scope is **sensitive**, not restricted. Verification is required, and a third-party security assessment is not. Published timelines conflict between three to five and ten business days. Plan for ten.

Two caps are unrecoverable if you burn them.

**Testing publishing status is unusable in production.** It is capped at 100 test users, and *"Authorizations by a test user will expire seven days from the time of consent… refresh token will also expire."*

**An unverified app in Production is capped at 100 new users for the project's entire lifetime**, and Google states the cap *"cannot be reset or changed."* Verify before onboarding anyone real.

### Two policy clauses to design around, not argue with

**Section III.E.** *"API Clients must clearly identify any actions that they take to insert, share, update, or delete data or content on the authorizing user's behalf. In addition, the user must expressly consent to those actions prior to their actual execution."* The creator must approve the rule and the exact reply text in your UI before it fires. A one-time OAuth grant is not sufficient consent.

**Section III.F.** *"API Clients must not offer or provide incentives, rewards, or other compensation to users for engaging with YouTube Applications … by performing actions like … adding comments."* "Comment LINK below and I'll send you the guide" is prohibited on YouTube. The comment-triggered reply is defensible. Incentivising the comment is not.

Going past the default 10,000 units a day needs a compliance audit through YouTube's API services form. There is no published SLA, and YouTube may require you to hand over a working account so they can exercise the automation themselves.

---

## TikTok: registration and app review

There is no path here for an individual. TikTok states it is *"unable to onboard personal accounts or individual developers."* You need a company, a company-domain email (*"You will be rejected if you are using a personal email"*), and a publicly accessible company website on a company-owned domain.

| Step | Documented timeline |
| --- | --- |
| Developer registration | 3 business days |
| Accounts API Access Application Form, mandatory since 2026-03-20 for any TikTok Accounts scope | no published SLA |
| App review | 2 to 3 business days |
| Business Messaging, via the Data Security and Privacy Review | 10 working days to initiate, no completion SLA and no status tracking |
| US accounts, adding the USDS VAQ and signed addendum | about a week after the DDQ, no SLA |

Request `user.info.basic`, `video.list`, `comment.list`, and `comment.list.manage`. Public comment replies ship globally on those scopes with no security review, which is the whole shippable product on TikTok.

TikTok's own advice is to exclude the US from the application to speed approval. Evidence that helps includes ISO 27001, SOC 2, or a recent penetration test.

**Do not pursue Business Messaging expecting comment-to-DM.** It is unavailable in the EEA, Switzerland, and the UK entirely, and comment-to-DM does not exist for US accounts even with full approval. The one carve-out reaches only Business Accounts registered in Vietnam, Indonesia, and Thailand, and fires on TikTok's classifier rather than your keyword. Details in [TikTok setup](setup.md#tiktok-setup).

One documented uncertainty worth resolving before legal sign-off: the Developer Terms of Service that is easy to find governs `developers.tiktok.com`. A consolidated "TikTok API for Business Terms of Service" could not be located. Confirm the governing agreement for a business-api app.
