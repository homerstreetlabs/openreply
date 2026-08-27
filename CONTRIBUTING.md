# Contributing

Thanks for wanting to help. OpenReply is public so the comment-to-DM engine is something you can read, run yourself, and improve.

## Ways to help

- Fix a bug. The send engine (`workers/engine/`, `lib/queue/`) and the webhook parser are the parts that matter most.
- Improve the docs. If you hit a platform setup quirk that is not written down, adding it to `docs/setup.md` is as valuable as a code fix. That guide is where people lose the most time.
- Add campaign templates in `lib/templates/`.
- Add tests. The suite runs with `pnpm test`.

## Development setup

This repo uses pnpm, pinned by the `packageManager` field in `package.json`. If you do not have it, `corepack enable pnpm` is enough. Do not install with npm or yarn. The lockfile is `pnpm-lock.yaml`.

```bash
pnpm install
docker-compose up -d      # starts Postgres
cp .env.example .env      # fill in the values, see docs/setup.md
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Sends run in the engine Worker on Cloudflare. Under plain `next dev` the queue bindings are absent, so nothing sends; that is fine for most development. Use `pnpm preview` to run the real Worker build in workerd, and `pnpm cf-typegen` to regenerate the binding types after editing either wrangler config.

## Before you open a pull request

Branch from `main`, keep the change focused on one thing, and make sure these pass:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

If a check cannot run in your environment, say why in the pull request body. A small, clear pull request is easier to merge than a large one that touches many things at once.

## A note on the codebase

This is Next.js 16, and some conventions differ from older versions. There are dev notes in `AGENTS.md`. When you are unsure about an API, read the relevant guide in `node_modules/next/dist/docs/` before writing against it.

## Campaign templates

A template contribution should include a name, the target niche, a suggested post or reel, the keywords, the DM copy, and a short example. Do not include real tokens, private data, or scraped content.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened. For anything involving a webhook or a failed send, the Postgres tables describe it best: `WebhookEvent` for delivery, `DmLog` for send status, `OperationalEvent` for engine errors.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
