# How to deploy on Cloudflare

Take a clone of this repo to a running instance on Cloudflare Workers. Work through the
steps in order. At the end, `/api/health` on your new domain returns `status: ok` and your
platform apps point at it.

Every environment variable named here is described in the
[environment variables](setup.md#environment-variables) table in setup.md.

## What you need

- A Cloudflare account on **Workers Paid**, $5/month. This is mandatory, not a
  recommendation. The Free plan caps subrequests at 50 per invocation, and one webhook
  delivery fans out to roughly 500. Free's 3 MB bundle ceiling is also below the web
  Worker's size.
- A PostgreSQL database reachable from the internet. Neon's free tier works, and so does
  any other hosted Postgres.
- For login and invitation email through Cloudflare Email Sending: a domain whose DNS is
  on Cloudflare. Email Sending is in public beta and Workers Paid only. Any other SMTP
  server works instead.
- The repo cloned, dependencies installed with `pnpm install`, and wrangler signed in:

  ```bash
  pnpm exec wrangler login
  ```

## Step 1: Create the Hyperdrive config

Both Workers reach Postgres through Hyperdrive. Create the config with caching disabled:

```bash
pnpm exec wrangler hyperdrive create openreply \
  --connection-string="postgresql://user:password@host:5432/dbname" \
  --caching-disabled
```

`--caching-disabled` is not optional. Hyperdrive caches reads for 60 seconds by default
and does not invalidate on write. Auth.js keeps sessions in the database, so with caching
on, a session you just signed out of keeps resolving for up to a minute.

The command prints an id. Paste it into the `hyperdrive` block of both `wrangler.jsonc`
and `wrangler.engine.jsonc`, replacing `REPLACE_WITH_HYPERDRIVE_ID`.

### If the database is not reachable from the public internet

Azure Private Link, an AWS VPC, or any private network. Do not try to allowlist
Cloudflare's IP ranges. Connect through a Workers VPC service instead.

1. Install `cloudflared` on a machine inside the private network. In the dashboard go to
   Workers VPC, Tunnels, Create, then run the install command it gives you. Outbound only,
   no inbound ports, no changes to routing or DNS on that host.

   ```bash
   sudo systemctl status cloudflared
   ```

2. Add a route so the tunnel may forward to the database. Networking, Routes, Create
   route, Tunnel CIDR. Enter the database's private address as a /32, for example
   `10.0.0.6/32`.

3. Create the VPC service. Use `--hostname`, not `--ipv4`, so TLS verification works
   against the certificate the database presents.

   ```bash
   pnpm exec wrangler vpc service create openreply-db-vpc \
     --type tcp \
     --tcp-port 5432 \
     --app-protocol postgresql \
     --tunnel-id <YOUR_TUNNEL_ID> \
     --hostname <db>.postgres.database.azure.com \
     --resolver-ips 168.63.129.16
   ```

   `--resolver-ips` must be the resolver that knows the private DNS zone. On Azure that is
   `168.63.129.16`. Without it the hostname resolves publicly and the connection fails.

4. Create the Hyperdrive config against the service rather than a connection string.

   ```bash
   pnpm exec wrangler hyperdrive create openreply \
     --service-id <YOUR_VPC_SERVICE_ID> \
     --database openreply \
     --user <user> \
     --password <password> \
     --scheme postgresql
   ```

   Confirm caching is disabled afterwards with `wrangler hyperdrive get <id>`.

Verify from the tunnel host before moving on. Both must succeed:

```bash
getent hosts <db>.postgres.database.azure.com   # a private address
nc -zv <db>.postgres.database.azure.com 5432
```

## Step 2: Create the queues

```bash
pnpm exec wrangler queues create openreply-responses
pnpm exec wrangler queues create openreply-responses-dlq
```

`openreply-responses` carries the response jobs. A failed job retries after 300, 900, and
2700 seconds, then lands in `openreply-responses-dlq`. Those consumer settings live in
`wrangler.engine.jsonc` and deploy with the engine, so creating the two queues is all
this step does.

## Step 3: Migrate the database

Run once from your machine, against the database directly, not through Hyperdrive. Your
machine needs network access to the database for this step, through a firewall rule, a
VPN, or the tunnel host.

```bash
DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require" pnpm db:migrate
```

URL-encode special characters in the password. `@` becomes `%40`.

### If it fails with `permission denied for schema public`

PostgreSQL 15 and later do not grant `CREATE` on `public` by default, and managed
providers rarely make your application user the schema owner. Connect as an admin **to
the application database**, not to `postgres`, and grant it:

```bash
psql "postgresql://<admin>:<pass>@host:5432/openreply?sslmode=require" \
  -c 'GRANT USAGE, CREATE ON SCHEMA public TO "<app_user>";'
```

Verify from a separate connection, using the same `DATABASE_URL` the migration uses:

```bash
psql "$DATABASE_URL" -c \
  "SELECT current_database(), current_user, has_schema_privilege(current_user,'public','CREATE');"
```

Use `psql` rather than a GUI client for the grant. Clients that default to manual commit
report success in their own session while every other connection still sees the old
permissions.

## Step 4: Set up login email

Login is email magic links only, and creator invitations go out the same way, so without a
working `EMAIL_SERVER` nobody can sign in and no creator can be invited. If you already run
an SMTP server, point `EMAIL_SERVER` at it and skip the rest of this step.

For Cloudflare Email Sending:

1. Onboard the sending domain in the dashboard, under Compute, Email Service, Email
   Sending. Cloudflare adds the SPF, DKIM and DMARC records. Email Sending is in public
   beta and Workers Paid only.
2. Set `EMAIL_FROM` to an address on that domain. Cloudflare rejects any other sender,
   and this value is required rather than defaulted.

That is all production needs. Both wrangler configs already declare the binding:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

**Do not point `EMAIL_SERVER` at Cloudflare's SMTP relay and expect it to work in
production.** Cloudflare IPs are on the Workers socket layer's disallowed list, along
with `localhost` and private addresses, so a Worker dialling
`smtps://smtp.mx.cloudflare.net:465` fails with "cannot connect to the specified
address". The relay is for clients that are not Workers. Set `EMAIL_SERVER` only if you
want scripts, tests and `pnpm dev` to send real mail, where it works fine.

Because this is a binding rather than a secret, it attaches on upload. `wrangler secret
put` will not add it, so a Worker that has not been re-deployed since the binding was
added has no `EMAIL` and falls back to SMTP, which then fails.

## Step 5: Deploy the engine Worker

`prisma/schema.prisma` must set `runtime = "workerd"` on the client generator. Without it
the generated client pulls Prisma's Node runtime, and the engine fails on upload with
`The "path" argument must be of type string or an instance of URL`. Run `pnpm db:generate`
after changing it.


```bash
pnpm deploy:engine
```

The order matters. The web Worker binds two Durable Objects, `AccountRateLimiter` and
`QuotaBucket`, by `script_name` on `openreply-engine`, so the engine must exist before the
web Worker can deploy.

This deploy also registers five cron triggers: the comment reconciler and poll sweep every
five minutes, a quota snapshot every fifteen, and daily token refresh, reel attach, and
follower snapshot jobs. Every expression in `wrangler.engine.jsonc` must have a matching
entry in the engine's job table, and `pnpm verify:migration` gates on exactly that.

## Step 6: Deploy the web Worker

```bash
pnpm run deploy
```

The `run` is required. Bare `pnpm deploy` invokes pnpm's own deploy command instead of
the package script and fails with `ERR_PNPM_CANNOT_DEPLOY`.

This builds with `@opennextjs/cloudflare` and deploys `openreply-web`. The build runs
`prisma generate`, which needs `DATABASE_URL` in your shell environment or `.env`.

The deploy prints your public URL, `https://openreply-web.your-subdomain.workers.dev`.
Note it down. It is your `NEXTAUTH_URL` and the domain every platform app points at. If you
prefer a custom domain, attach one to `openreply-web` in the Cloudflare dashboard and use
that instead, everywhere.

If you later build on Cloudflare with Workers Builds instead of your machine, set
`DATABASE_URL` as a build variable there too. Build variables and Worker secrets are
separate stores, so a Worker secret does not reach the build.

## Step 7: Set the secrets

Secrets take effect immediately, with no redeploy. **Bindings do not.** `hyperdrive`,
`send_email`, `queues` and `durable_objects` attach only when the script is uploaded, so
after editing either wrangler file you must run the deploy again. A Worker that has not
been re-deployed since a binding was added behaves as if that binding does not exist and
silently falls back.

Check what a Worker last did:

```bash
pnpm exec wrangler deployments list | grep -E "Created|Source"
```

Nothing but `Secret Change` means no upload since the last config edit.

`DATABASE_URL` on a Worker is only a fallback for when the Hyperdrive binding is missing.
Set it to the real connection string anyway. Leaving the `.env.example` docker default
there produces `cannot connect to the specified address`, because the Workers socket layer
refuses `localhost` and private addresses.

Secrets are per Worker, so both Workers need them. Set the full list on the web Worker,
pasting each value when prompted:

```bash
for s in NEXTAUTH_URL NEXTAUTH_SECRET CRON_SECRET ENCRYPTION_KEY DATABASE_URL \
         EMAIL_SERVER EMAIL_FROM INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET \
         FACEBOOK_APP_ID FACEBOOK_APP_SECRET WEBHOOK_VERIFY_TOKEN; do
  pnpm exec wrangler secret put "$s"
done
```

Then the engine. It needs `DATABASE_URL`, `ENCRYPTION_KEY`, and `NEXTAUTH_URL` at
minimum, with values identical to the web Worker's. Setting the same full list keeps the
two Workers in step:

```bash
for s in NEXTAUTH_URL NEXTAUTH_SECRET CRON_SECRET ENCRYPTION_KEY DATABASE_URL \
         EMAIL_SERVER EMAIL_FROM INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET \
         FACEBOOK_APP_ID FACEBOOK_APP_SECRET WEBHOOK_VERIFY_TOKEN; do
  pnpm exec wrangler secret put "$s" --config wrangler.engine.jsonc
done
```

Add `TIKTOK_WEBHOOK_SECRET`, `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` to both loops
once you have a TikTok app, and `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` once
Google verifies yours. Each account's own `business_id` is stored on the account, not
here, because one instance serves many creators. Until `TIKTOK_WEBHOOK_SECRET` is set the TikTok webhook rejects every delivery, which
is deliberate. See [TikTok setup](setup.md#tiktok-setup).

`ENCRYPTION_KEY` is the one that bites. The web Worker stores the encrypted platform
token and the engine decrypts it to send, so different keys mean every send fails to
decrypt. `META_GRAPH_API_VERSION` is not in the list because it is a plain var in both
wrangler configs.

Secrets apply to the running Worker as soon as `wrangler secret put` finishes. No
redeploy needed.

## Step 8: Point your platform apps at the new domain

If this is a fresh install, follow the platform section of
[setup.md](setup.md#instagram-setup) for each platform you want, using your new URL.

If you are moving an existing instance, three URLs change per Meta platform:

1. Add `https://openreply-web.your-subdomain.workers.dev/api/connect/instagram/callback` to the
   OAuth redirect URIs in the Instagram product's Business login settings, and
   `/api/facebook/callback` in Facebook Login for Business settings. Keep the old URIs
   listed until the cutover is done.
2. Change the webhook callback URLs to `/api/webhook` for Instagram and
   `/api/webhook/facebook` for the Page, and paste the verify token again. Meta does not
   reliably follow redirects, so an old callback URL means webhooks silently stop.
3. Update the `NEXTAUTH_URL` secret on both Workers.

## Step 9: Bootstrap your admin access

Only needed if you will host this for other creators. Sign in once so your `User` row
exists, then insert a platform grant. There is no UI for the first one.

```sql
INSERT INTO "PlatformGrant" (id, "userId", tier, "grantedByUserId", reason)
SELECT gen_random_uuid()::text, u.id, 'ADMIN', u.id, 'bootstrap'
FROM "User" u WHERE u.email = 'you@example.com';
```

Fleet and Creators then appear in the sidebar. Details, including the lower support tiers,
are in [Running it for other creators](setup.md#running-it-for-other-creators).

## Step 10: Verify

1. Open `https://openreply-web.your-subdomain.workers.dev/api/health`. It reports the
   database, the queue, and the engine, and returns `status: ok` when all three pass.
2. Sign in with a magic link, to prove email sending and the database session both work.
3. Run the end-to-end comment test in
   [Test it end to end](setup.md#test-it-end-to-end).

To watch either Worker's logs while testing:

```bash
pnpm exec wrangler tail openreply-web
pnpm exec wrangler tail openreply-engine
```

Tail with no `--status` filter. That flag matches the Worker's outcome, not the HTTP
status, so a route that catches its own error and returns a 500 is hidden by
`--status error`.

If `checks.database` reports `cannot connect to the specified address`, the Worker is
dialling the database directly instead of through Hyperdrive. Confirm the binding is
attached by checking the bindings table the deploy prints, which must list
`env.HYPERDRIVE`.

If `checks.engine.healthy` is false, queued jobs are not being consumed. Nothing will send
even though webhooks are arriving, and the engine tail is where the reason will be.

## Step 11: Deploy from GitHub Actions

Once a deploy from your machine has worked at least once, `.github/workflows/ci.yml`
can do the rest. Its `deploy` job runs on every push to `main`, after the checks
pass, and repeats steps 5 and 6 in that order: `pnpm deploy:engine`, then
`pnpm run deploy`.

Do step 7 first. CI uploads scripts, it does not set secrets, so a Worker that has
never had `wrangler secret put` run against it will deploy cleanly and then fail on
its first request.

### The two secrets

Add both under Settings, Secrets and variables, Actions:

| Secret                  | Value                                             |
| ----------------------- | ------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | The token from the next section                   |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id, from `pnpm exec wrangler whoami` |

wrangler reads both from the environment by itself, which is why the job sets them
as plain `env` and pulls in no deploy action. Set the account id even though
wrangler can sometimes work it out: doing so means listing the accounts the token
can see, which needs permissions the list below deliberately leaves off, and it
fails outright if the token sees more than one account.

The job declares `environment: production`, so you can scope the two to that
environment rather than the whole repository, and add required reviewers to it
later without touching the workflow.

### What the API token needs

Create it at My Profile, API Tokens, Create Custom Token. Two permissions are
load-bearing:

- **Account, Workers Scripts, Edit.** Uploads both Workers. This also covers the
  static assets, which is not obvious: OpenNext uploads them through
  `/workers/scripts/:name/assets-upload-session`, a Workers Scripts endpoint, so
  Workers Static Assets needs no permission of its own.
- **Account, Queues, Edit.** `wrangler.engine.jsonc` declares a queue consumer, and
  `wrangler deploy` registers that against the Queues API in a separate call
  *after* the script upload. A token without it does not fail early: it uploads the
  new engine, then fails on "Queue consumers", leaving new code live against an
  unchanged consumer config. Read is not enough, because registering writes.

Cloudflare's own Workers CI template is wider than that, and the extra permissions
are worth understanding rather than pasting. It adds Account Settings (read),
Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit) on all
zones, and User Details and Memberships (read). None of those are needed here:
`open-next.config.ts` configures no incremental cache, so nothing touches KV or R2;
neither wrangler config declares a `route`, so wrangler creates none; and the
account and membership reads are for the account discovery that setting
`CLOUDFLARE_ACCOUNT_ID` skips. Granting them does no harm if you would rather use
the template, it just widens the token.

Hyperdrive is not on the list on purpose. The binding is passed as an id in the
upload metadata and wrangler never reads the config back, so the token does not
need Hyperdrive access to deploy against it.

If a deploy ever fails with an authorization error naming a specific binding, that
binding's own product needs Edit on the token. Cloudflare documents this for
Secrets Store, and the shape is general: attaching a resource to a Worker counts as
a write against that resource, not a read.

### Migrations stay manual, and CI enforces it

The workflow never runs `prisma migrate deploy`. The database accepts connections
only from whitelisted public IPs or from inside its VNet, and GitHub-hosted runners
are neither, so a migrate step would not fail fast, it would hang until the job
timed out. Do not solve this with a tunnel, a proxy or a self-hosted runner: each
one ends with CI holding a route into the production database, which is a larger
problem than running one command by hand.

That leaves a real gap. A merge that adds a migration would otherwise deploy code
expecting columns the database does not have. So the job refuses to deploy it.

What it compares against is the commit that last reached production, not the range
the push happens to cover. That distinction is the whole point. A push range would
let the problem through by the side door: block a migration, merge something
unrelated, and that second push adds no migration of its own, passes, and deploys
the blocked one's code against the un-migrated database anyway. The deployment
records that `environment: production` writes are the only thing in CI that knows
what is actually live, so the guard reads them, which is what the job's
`deployments: read` permission is for. It takes the most recent deployment whose
latest status is `success`; this run's own record is `in_progress` by then, so it
is skipped without any special case.

The log always names the base commit it compared against and where that base came
from. If it does not say, do not trust the result.

- **Nothing added under `prisma/migrations/` since that commit** deploys.
- **Anything added** fails before installing anything, naming each migration. Run
  `pnpm db:migrate` as in step 3, from a machine the database allows, then go to
  the Actions tab, run the CI workflow manually against `main`, and tick
  **migrations_already_applied**, which skips the guard.
- **No successful deployment on record yet** falls back to the pushed range and says
  so. This is the first run on a fresh repository, and failing there would mean the
  workflow could never make the deployment record it wants to read.
- **A deployment on record whose commit is no longer in the repository**, after
  history was rewritten under it, falls back the same way and says so. So does a
  deployment history the API refuses to return.
- **Neither a base nor a usable range** fails. That is a manual run or a force push
  on a repository with no successful deployment yet. There is nothing to compare and
  guessing is worse than stopping; the ticked box clears it.

Because the base is what is live rather than what moved, a manual run no longer
needs the box ticked just to have something to compare against. It still needs it to
get past a migration the guard can see is undeployed, which is the case the box is
for.

Migrations in this schema have been additive, so applying one before its code
deploys is safe. Keep it that way: a migration that drops or renames a column has to
be split across two deploys whatever CI does.

`DATABASE_URL` is set in the job, but to a placeholder rather than the real
connection string. The OpenNext build runs `prisma generate`, which wants a
datasource url present in `prisma.config.ts` and reads nothing but
`prisma/schema.prisma`. The build value cannot reach production either way:
`connectionString()` in `lib/db/client.ts` compiles to a live
`process.env.DATABASE_URL` read in the emitted bundle, so it is resolved on the
Worker, from the Hyperdrive binding first and that secret second. A real
connection string in the workflow would buy nothing and give it one more place to
leak from.

### What the job deliberately does not run

`pnpm verify:migration` is not wired in as a pre-deploy gate, which is a judgement
call worth recording. Two of its assertions do bear on a deploy, the one matching
every cron expression in `wrangler.engine.jsonc` to a job in the engine's table and
the one checking both wrangler configs declare `send_email`. But most of the script
asserts that a migration which has already happened stayed done, and it re-runs
typecheck, lint, the suite and a second full OpenNext build that the `test` job this
job depends on has already done.

It also does not currently pass. Both failures are stale assertions rather than
defects: the peer-floor gate still demands `next` 16.2.x, which the installed
`@opennextjs/cloudflare` no longer supports, and the cross-creator audit gate
matches `requirePlatformScope("ADMIN")` literally, which stopped matching when that
call gained a second argument. A gate on the path that ships production, which goes
red for reasons unrelated to what it guards, teaches people to bypass it. Fix those
two and its home is the `test` job, where drift surfaces on the pull request and
this job inherits it through `needs: test`.
