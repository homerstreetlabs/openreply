# Four gaps no candidate closed — resolved by the orchestrator

The cross-judge found four things **all four candidates** got wrong or silently dropped.
None was in the arena rubric, which is exactly why the judge pass exists. Each is decided
here rather than left as a TODO.

---

## 1. The DM inbox was silently dropped by all four candidates

**The gap.** Phase A's feature list includes a shipping feature — *"Inbox. Read your
Instagram DM conversations and reply from the dashboard, inside Meta's 24-hour messaging
window. Cached so it loads instantly on repeat visits."* It is real code:
`app/api/instagram/conversations/route.ts`, `app/api/instagram/conversations/[id]/route.ts`,
`app/(dashboard)/inbox/page.tsx`, and `getConversations` / `getConversationMessages` in
`lib/meta/client.ts`. **No candidate mentioned conversations at all** — not as kept, not as
deferred, not as a capability. A design that silently drops a shipped feature is a design
that will delete it in implementation.

**Decision: keep it, and model it as a capability like everything else.**

Add `CONVERSATION_HISTORY` to the `Capability` union. It is genuinely per-platform, and it
splits differently from `CONVERSATION_MESSAGE`:

| Platform | Reads conversation history? | API |
| --- | --- | --- |
| Instagram | ✅ | `/{ig-user-id}/conversations`, `/{conversation-id}?fields=messages{…}` |
| Facebook | ✅ | Conversations API — **2 calls/s per Page**, the tightest limit on the platform |
| TikTok | ✅ | `/business/message/conversation/list/`, `/business/message/content/list/` |
| YouTube | ❌ | nothing to read — no messaging surface exists |

Consequences that fall out of treating it as a capability rather than an exception:
- `/inbox` renders per connected account and simply **omits accounts whose platform lacks
  the capability**, using the same `availableSteps`-style negotiation the campaign builder
  uses. No `if (platform === 'youtube')` in the page.
- The Facebook 2 calls/s ceiling becomes an ordinary `BucketSpec`, not a special case.
- **TikTok's conversation list returns `conversation_id` but NOT `unique_identifier`.**
  That is precisely why graft G1 (`MessagingContact`) exists — the join has to be persisted
  from the webhook or the inbox cannot attribute a TikTok conversation to the commenter who
  started it.

---

## 2. No webhook-URL cutover plan — a live risk to the revenue platform

**The gap.** All four candidates move ingestion to per-platform routes
(`/api/webhook/[platform]`, `/api/ingest/[platform]/[slug]`, …). That is correct: an
Instagram-Login app signs with a **different secret** than the Meta app, so one route
trying both secrets is a weak posture that gets weaker per platform.

But **a Meta app's callback URL is a single app-global setting changed by hand in the
dashboard**, and deliveries keep arriving at the old URL until that change propagates.
Meta also **auto-unsubscribes the app after one hour of failures**. No candidate keeps the
legacy `/api/webhook` alive during the cut. Over live data that is a window of **dropped
comments on the one platform that currently earns money.**

**Decision: `/api/webhook` survives the migration as a permanent Instagram alias, and is
retired only after the dashboard change is observed working.**

It must be an **alias, not an HTTP proxy**. The HMAC is computed over the *raw request
body*; forwarding through another fetch risks body re-encoding, and it spends latency
against Meta's 5-second ack budget. So the legacy path calls the same handler in-process:

```ts
// app/api/webhook/route.ts — retained through the cut, deleted in a later deploy
// Legacy Instagram callback URL. Meta's callback URL is an app-global dashboard
// setting, so deliveries continue here until the change propagates. Alias, never
// proxy: the signature covers the raw body, and Meta's ack budget is 5 seconds.
export const POST = (req: NextRequest) => ingestHandler("instagram", "main")(req);
export const GET  = (req: NextRequest) => verifyHandler("instagram", "main")(req);
```

Retirement checklist, in order:
1. Deploy new routes **while the legacy route still works**.
2. Change the callback URL in the Meta dashboard.
3. Confirm deliveries are arriving at the new route (`IngestEvent` rows carry the route
   they arrived on — add the column, it is one string).
4. Watch for a full webhook interval with **zero** legacy-route hits.
5. Only then delete the legacy route.

The same discipline applies to the OAuth redirect URI. `docs/setup.md` already warns that
a non-primary domain 307-redirects the POST and *"Meta does not reliably follow redirects,
so webhooks silently stop"* — evidence that this class of mistake has already cost this
project once.

---

## 3. TikTok webhook signature verification is unverified across the board

**The gap.** All four candidates are exact about Meta's `X-Hub-Signature-256` HMAC over the
raw body, and vague to the point of "TikTok's own scheme" about TikTok. The research
established that `POST /business/webhook/update/` accepts a `secret` field — it did **not**
establish the verification algorithm, header name, or signing payload. That is an
unverified dependency sitting on the ingestion path of a launch platform.

**Decision: this is a named spike with a blocking gate, not a TODO.**

`verifySignature` is **required** by the `PlatformAdapter` interface — an adapter cannot
omit it, and the TikTok adapter's implementation must not ship as `return true`. Until the
spike resolves the scheme:

- The TikTok ingest route stays **disabled by configuration** (no `ProviderApp` row), so
  the code path is unreachable rather than unverified.
- When it does ship, TikTok ingestion runs **defence in depth**: verify the signature *and*
  re-read the comment from `/business/comment/list/` before acting on it. The webhook
  carries `text`, which is the efficient path, but until the signature scheme is proven the
  re-read is what makes a forged payload harmless.
- The spike's deliverable is one sentence with a doc URL: header name, algorithm, and
  exactly what bytes are signed.

Rationale: an unauthenticated ingestion endpoint that triggers outbound messages from a
creator's account is the highest-severity failure mode in this system. It is worth being
slow about.

---

## 4. Prisma 7 + Hyperdrive is a shared bet with no named fallback

**The gap.** All four candidates correctly flag prisma/prisma#28193 (*"Cloudflare Worker
Hangs when Reusing Prisma Client with Hyperdrive"*, open and unanswered since 2025-09-30,
where the reporter also hit `memory access out of bounds` with the per-request-client
workaround). All four then defer the same spike. Four copies of one worry is not a plan.

**Decision: the spike is deploy 0 and gates everything, and plan B is named now.**

The spike, in order of cost:
1. A bare Worker instantiating `PrismaPg` + `PrismaClient` **per request** against
   Hyperdrive, hammered for a few thousand requests. Watch for hangs and for
   `memory access out of bounds`.
2. Measure the bundle: `query_compiler_fast_bg.postgresql.wasm` is ~3.6 MB raw
   (~1.85 MB with `compilerBuild = "small"`) against a **10 MB gzip ceiling shared with all
   of Next.js**. Verify with `wrangler deploy --dry-run --outdir` before committing.

**Plan B, in preference order, if the spike fails:**
1. **`@prisma/adapter-neon` over WebSocket** — supports transactions (the HTTP mode does
   not: `PrismaNeonHttp` rejects with *"Transactions are not supported in HTTP mode"*), with
   the same per-request-client rule. Costs us Hyperdrive's provider independence and pins us
   to Neon.
2. **Drop Prisma in the engine Worker only.** The engine's query surface is small and
   known; the dashboard's is large. Running the engine on a thin Postgres driver while the
   web Worker keeps Prisma confines the blast radius to the code we are rewriting anyway.
3. **Keep the engine off Workers** — Cloudflare Containers, Paid-only, ~$2–5/month for a
   `lite` instance. Still "entirely on Cloudflare", and it is the only option that keeps a
   long-lived Node process. Explicitly the escape hatch, not the plan.

What we do **not** do: fall back to D1. `@prisma/adapter-d1` **silently drops ACID** by its
own source (*"implicit & explicit transactions will be ignored… which breaks the guarantees
of the ACID properties"*), and the schema uses `String[]`, enums, and `@db.Date`, none of
which survive SQLite.

---

## A fifth item the judge did not raise: nobody priced this

No candidate costed the Cloudflare bill. It is small but not zero, and two line items are
demand-driven in a way that matters for a creator platform:

- **Workers Paid is mandatory, not optional** — $5/month floor. Free's 50-subrequest cap
  kills the overview route's ~500-call fan-out, and Email Sending and Containers are
  Paid-only.
- **Queues**: $0.40 per million operations, ~3 ops per message ⇒ ~$1.20 per million sends.
- **Email**: 3,000/month included, then **$0.35 per 1,000**. Creator invitations are
  low-volume; magic links scale with logins, not sends.
- **Durable Objects**: billed on duration. The rate-limiter DOs are short-lived; a
  long-lived Container (plan B option 3) would consume most of the 400,000 GB-s allowance.
- ⚠️ **Cloudflare does not publish Email Sending's daily quota** — *"New accounts start with
  a conservative daily quota and scale up over time."* Check it at runtime via
  `GET /accounts/{id}/email/sending/limits` rather than assuming headroom.

---

# Decisions taken (2026-08-24)

| Question | Decision | Consequence |
| --- | --- | --- |
| Facebook via which Meta app? | **Try adding "Engage with customers on Messenger" to the existing Instagram app**; fall back to a second app if the dashboard greys it out. | The addition is **irreversible**. Code supports both shapes via multiple `ProviderApp` rows, so the fallback costs one extra App Review and one extra connect step per creator, not a rewrite. |
| TikTok scope for v1 | **Public comment reply only.** Start the DSPR security review on day one in parallel. | Ships globally in ~2–4 weeks with no security review. Messaging stays gated behind the per-account capability set and lights up if/when DSPR approval lands. Nothing to rewrite when it does. |
| Transactional email | **All Cloudflare, via the authenticated SMTP bridge.** | `EMAIL_SERVER=smtps://api_token:<token>@smtp.mx.cloudflare.net:465` — `lib/auth.ts` already branches to Nodemailer when that variable is set, so this is config, not code. Accepts a public-beta product on the login path. **Mitigation required, not optional:** handle `E_RECIPIENT_SUPPRESSED` explicitly at sign-in. One spam complaint auto-suppresses an address account-wide and complaint-suppression removal is rate-limited, so the untreated failure mode is a silent permanent lockout. Resend stays one env var away as rollback. |
| First thing built | **The deploy-0 spike.** | Prisma 7 + Hyperdrive per-request under load, the rate-limiter Durable Object against the ported tests, one Queues round-trip with `delaySeconds`. Everything downstream is gated on it. |
