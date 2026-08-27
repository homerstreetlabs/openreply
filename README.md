<div align="center">

# OpenReply

Open-sourced ManyChat for comment-to-DM automation across Instagram, Facebook, YouTube, and TikTok.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/diwenne/openreply?style=flat&color=black)](https://github.com/diwenne/openreply/stargazers)
[![Built with Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org)

</div>

Someone comments `LINK` on your reel, and they get a DM with your link a second later. That is the whole idea. OpenReply watches the comments on your posts, and when one matches a keyword you set, it responds through the platform's official API. On Instagram and Facebook that is a private reply to the commenter, with an optional public reply under the comment. On YouTube and TikTok it is a public reply, because neither platform permits messaging a commenter at all.

ManyChat does this and charges a monthly fee. OpenReply is the same core feature, free, running on your own infrastructure, with no seat limits and no plan caps.

> If this saves you a subscription or a weekend of building, a star on the repo genuinely helps other people find it.

## Why this exists

Comment-to-DM is one feature, but every tool that offers it wants a recurring subscription for it. The actual work is a webhook, a keyword match, and one API call. That does not need to cost anything to run for a single account.

OpenReply is built on each platform's official API. It does not scrape, it does not automate a browser, and it never asks for a password. That keeps your accounts inside the rules, which matters if you care about not getting flagged.

## Platforms

The DM is not the universal capability. The public comment reply is.

| | Instagram | Facebook | YouTube | TikTok |
| --- | --- | --- | --- | --- |
| Public reply under the comment | yes | yes | yes | yes |
| DM the commenter | yes, 24h | yes, 7 days | impossible, no messaging API | prohibited outside VN/ID/TH |
| Connect from the dashboard today | yes | yes | not yet | not yet |

YouTube and TikTok have shipped adapters, capability gating, and quota accounting, and
TikTok has a signed webhook endpoint. Neither has an OAuth connect flow yet. Their
developer applications take weeks, so [docs/setup.md](docs/setup.md) covers them now.

## Features

- Keyword to DM. Match one or many keywords per post, whole-word or partial.
- Public comment reply. Optional on Instagram and Facebook, on top of the DM. The only response YouTube and TikTok allow.
- Tracked links. Swap a link for a tracked redirect and see clicks and CTR per campaign.
- Two link buttons. Send up to two tappable link buttons in one DM, each a separate tracked link with its own click stats.
- Follow gate. Optionally require a follow before you hand over the link. The DM asks the commenter to follow and tap a button; on tap, OpenReply checks Meta's `is_user_follow_business` flag and only sends the link once they follow, re-prompting until then. It fails open (sends the link anyway) when Instagram does not return follow status, so a real follower is never trapped.
- Personalization. Use `{username}` in your message to greet the commenter by name.
- Per-account rate limiting. Stays under each platform's documented cap, including Instagram's 750 private replies per hour and YouTube's shared 10,000 quota units a day, and queues the overflow instead of dropping it.
- Multiple accounts. Connect several professional accounts under one workspace, each with its own limits.
- Creator invitations. Invite a UGC creator by email and they get their own workspace to connect their own accounts to.
- Fleet view. One cross-creator page answering what is broken and why, worst first, with open problems grouped by cause.
- Workspaces and roles. Owner, admin, and member roles with invite links, useful if you run this for clients.
- Campaign templates. Start from a preset instead of a blank form.
- Inbox. Read your Instagram DM conversations and reply from the dashboard, inside Meta's 24-hour messaging window. Cached so it loads instantly on repeat visits.
- DM logs. Every send, skip, and failure is logged with a reason.
- Self-comment filtering. Your own comments never trigger a reply, since Meta rejects DMing yourself anyway.

## How it works

1. Someone comments on your post or reel.
2. The platform sends a webhook to your OpenReply instance, or the sweep finds the comment on a platform that has no webhook.
3. OpenReply checks the comment against your active campaigns.
4. On a keyword match, it queues a job and claims the comment, so one comment produces exactly one response.
5. The engine Worker sends whatever the platform supports: the private reply, the public reply, or both.

The web Worker receives the webhook and serves the dashboard. A separate engine Worker does the sending, because the send has to survive rate limits and retries. Both talk to the same Postgres.

## Quick start

You need a few accounts before anything works: a developer app on each platform you want, a Cloudflare account on the Workers Paid plan ($5/month), and a PostgreSQL database (Neon's free tier works). The Instagram account you connect has to be a Business or Creator account, not a personal one.

The honest version: the code deploys in minutes, but the platform apps are the part that takes real time. Read [docs/setup.md](docs/setup.md) before you start. It is the single setup guide, covering hosting, the environment, and the developer app for each platform, including every wrong turn so you do not have to find them yourself. [docs/](docs/) indexes the rest.

### Deploy it

[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) is the step-by-step guide: two Workers, a Hyperdrive config, two queues, and the secrets, in order.

### Run it locally

```bash
git clone https://github.com/diwenne/openreply.git
cd openreply
pnpm install
cp .env.example .env      # then fill in the values, see docs/setup.md
docker-compose up -d      # starts Postgres
pnpm db:migrate
pnpm dev                  # web app on http://localhost:3000
```

Sending is the engine Worker's job, and under plain `next dev` the Cloudflare bindings do not exist, so locally nothing sends. `pnpm preview` runs the real Worker build in workerd when you need that path. If comments come in on a deployed instance and no DM ever arrives, the engine is the first thing to check (`/api/health`, then `wrangler tail openreply-engine`).

Full environment variables and the production layout are in [docs/setup.md](docs/setup.md).

## Set it up with your AI assistant

If you use Claude Code, Cursor, or a similar tool, the platform setup is a lot faster with an assistant driving it. There is a ready-made prompt in the [Set it up with an AI assistant](docs/setup.md#set-it-up-with-an-ai-assistant) section of the setup guide. Paste it into your assistant inside a clone of this repo, hand over your keys as it asks, and it will walk you through connecting Instagram and going live.

## Tech stack

- Next.js 16 and React 19 for the web app and API routes, on Cloudflare Workers via `@opennextjs/cloudflare`
- Prisma 7 with PostgreSQL, reached through Hyperdrive
- Cloudflare Queues for the response queue, with Durable Objects for the per-account rate limiter and the shared platform quotas
- Auth.js (NextAuth) with email magic links over SMTP (Cloudflare Email Sending in the reference setup)
- Tailwind CSS for the interface
- The official APIs: Instagram with Instagram Login, Facebook Pages, YouTube Data API v3, TikTok Business API

For the complete stack, the two Workers, and the Cloudflare services between them, see [docs/stack.md](docs/stack.md).

## Contributing

Issues and pull requests are welcome. If you hit a platform quirk that is not in the setup guide, a PR that documents it is worth as much as a code fix, because that is where everyone loses time.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## Credits

Built and maintained by Diwen Huang.

- GitHub: [@diwenne](https://github.com/diwenne)
- Website: [diwenhuang.ca](https://diwenhuang.ca)
- X: [@diwenne](https://x.com/diwennee)
- Instagram: [@devdiwen](https://instagram.com/devdiwen)

OpenReply is a fork of [instagram-comment-to-dm](https://github.com/im-anishraj/instagram-comment-to-dm) by [Anish Raj](https://github.com/im-anishraj), also MIT licensed. The billing layer and plan caps were removed, the setup was documented from scratch, and it was rebuilt on Cloudflare Workers across four platforms.

## Star the repo

If OpenReply is useful to you, star it. It is the simplest way to help the project reach the next person looking for a free way to do this.

## License

MIT. See [LICENSE](LICENSE).
