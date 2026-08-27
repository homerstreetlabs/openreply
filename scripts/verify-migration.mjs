#!/usr/bin/env node
/**
 * The falsifiable predicate for the Cloudflare migration.
 *
 * Run it before the work and it goes red. Run it after and it goes green.
 * A reviewer re-runs it instead of taking anyone's word.
 *
 *   node scripts/verify-migration.mjs          # all gates
 *   node scripts/verify-migration.mjs --quick  # skip build gates
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const quick = process.argv.includes("--quick");
const results = [];

function gate(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true || r?.ok === true;
    detail = typeof r === "object" && r?.detail ? r.detail : "";
  } catch (err) {
    ok = false;
    detail = err.message.split("\n")[0].slice(0, 200);
  }
  results.push({ name, ok, detail });
}

/** Source and config only. `docs/architecture/` is a historical research record. */
const SOURCE_GLOB =
  "--include='*.ts' --include='*.tsx' --include='*.json' --include='*.mjs' --include='*.yml' --include='*.jsonc'";
const EXCLUDES =
  "--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=architecture " +
  "--exclude-dir=.open-next --exclude-dir=.wrangler --exclude=verify-migration.mjs";

function grepFiles(pattern, extra = "") {
  const cmd = `grep -rliE "${pattern}" ${SOURCE_GLOB} ${extra} . ${EXCLUDES} || true`;
  return execSync(cmd, { encoding: "utf8", shell: "/bin/bash" }).trim().split("\n").filter(Boolean);
}

// ── Subtraction gates ────────────────────────────────────────────────────────

/**
 * The adapter files, found by what they export rather than by filename.
 *
 * A name-based filter meant every new module under `lib/platforms/` had to be
 * added to an exclusion list or be mistaken for an adapter, and an adapter that
 * dodged the pattern would be skipped silently. This cannot be dodged: the
 * registry only accepts a `PlatformAdapter`.
 */
function adapterFiles() {
  return execSync("ls lib/platforms/*.ts", { encoding: "utf8", shell: "/bin/bash" })
    .trim()
    .split("\n")
    .filter((file) => /:\s*PlatformAdapter\s*=/.test(readFileSync(file, "utf8")));
}

gate("no vercel references in source or config", () => {
  const files = grepFiles("vercel");
  return { ok: files.length === 0, detail: files.join(", ") };
});

gate("no railway references in source or config", () => {
  const files = grepFiles("railway");
  return { ok: files.length === 0, detail: files.join(", ") };
});

gate("no resend references in source or config", () => {
  // The SERVICE, not the English verb. "Ask the owner to resend it" is fine.
  const files = grepFiles("RESEND_API_KEY|providers/resend|resend\\.com|[^a-z]Resend\\(");
  return { ok: files.length === 0, detail: files.join(", ") };
});

gate("vercel.json deleted", () => !existsSync("vercel.json"));

gate("no bullmq or ioredis dependency", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const found = ["bullmq", "ioredis", "@vercel/analytics"].filter((d) => d in all);
  return { ok: found.length === 0, detail: found.join(", ") };
});

gate("no REDIS_URL in source or config", () => {
  const files = grepFiles("REDIS_URL");
  return { ok: files.length === 0, detail: files.join(", ") };
});

gate("proxy.ts deleted (adapter rejects Node middleware)", () => !existsSync("proxy.ts"));

// ── Cloudflare readiness gates ───────────────────────────────────────────────

gate("wrangler.jsonc present", () => existsSync("wrangler.jsonc"));

gate("@opennextjs/cloudflare + wrangler installed", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const missing = ["@opennextjs/cloudflare", "wrangler"].filter((d) => !(d in all));
  return { ok: missing.length === 0, detail: `missing: ${missing.join(", ")}` };
});

gate("next satisfies the adapter peer floor (>=16.2.11, <16.3)", () => {
  const v = JSON.parse(
    readFileSync("node_modules/next/package.json", "utf8")
  ).version;
  const [maj, min, patch] = v.split(".").map(Number);
  const ok = maj === 16 && min === 2 && patch >= 11;
  return { ok, detail: `next@${v}` };
});

gate("prisma client is per-request, not cached on globalThis", () => {
  const src = readFileSync("lib/db/client.ts", "utf8");
  const cached = /globalForPrisma|globalThis[\s\S]{0,80}prisma/.test(src);
  return {
    ok: !cached,
    detail: cached ? "still caches on globalThis; hangs on 2nd request (prisma#28193)" : "",
  };
});

// ── Platform abstraction gates ───────────────────────────────────────────────

gate("every Platform enum value has an adapter", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const block = schema.match(/enum Platform \{([^}]*)\}/);
  if (!block) return { ok: false, detail: "Platform enum missing from schema" };
  const values = block[1].trim().split(/\s+/).filter(Boolean);
  const registry = readFileSync("lib/platforms/registry.ts", "utf8");
  const missing = values.filter((v) => !new RegExp(`\\b${v}\\b\\s*:`).test(registry));
  return { ok: missing.length === 0, detail: missing.length ? `no adapter: ${missing.join(", ")}` : "" };
});

/**
 * The send path chooses behaviour from capabilities, never from a platform
 * name. Selecting an adapter and scoping a database query are the two legitimate
 * uses of the value, so those files are exempt by path rather than by comment.
 */
gate("send path branches on capability, not platform name", () => {
  const files = execSync(
    "grep -rlE '\"(INSTAGRAM|FACEBOOK)\"' --include='*.ts' lib/queue lib/polling 2>/dev/null || true",
    { encoding: "utf8", shell: "/bin/bash" }
  ).trim().split("\n").filter(Boolean);
  const offenders = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /(===|!==)\s*"(INSTAGRAM|FACEBOOK)"|"(INSTAGRAM|FACEBOOK)"\s*(===|!==)/.test(src);
  });
  return {
    ok: offenders.length === 0,
    detail: offenders.length ? `compares platform names: ${offenders.join(", ")}` : "",
  };
});

gate("every declared cron trigger has a job", () => {
  const cfg = readFileSync("wrangler.engine.jsonc", "utf8");
  const src = readFileSync("workers/engine/index.ts", "utf8");
  const cronPattern = /"((?:[*/\d]+ ){4}[*/\d]+)"/g;
  const declared = [...cfg.matchAll(cronPattern)].map((m) => m[1]);
  const handled = [...src.matchAll(/"((?:[*/\d]+ ){4}[*/\d]+)"\s*:/g)].map((m) => m[1]);
  const orphaned = declared.filter((c) => !handled.includes(c));
  return {
    ok: declared.length > 0 && orphaned.length === 0,
    detail: orphaned.length ? `no job for: ${orphaned.join(", ")}` : `${declared.length} triggers`,
  };
});

/**
 * Every maintenance job reaches a platform-specific API, so a query that sweeps
 * accounts without naming a platform hands one vendor's URL to another vendor's
 * token. That shipped three times before it was caught, so it is a gate rather
 * than a habit. A genuinely cross-platform job still passes by saying so, with
 * `platform: { in: [...] }`.
 */
gate("account sweeps in lib/jobs name a platform", () => {
  const files = execSync("ls lib/jobs/*.ts 2>/dev/null || true", {
    encoding: "utf8",
    shell: "/bin/bash",
  }).trim().split("\n").filter(Boolean);

  const offenders = files.filter((file) => {
    const src = readFileSync(file, "utf8");
    if (!/prisma\.(instagramAccount|automation)\.find/.test(src)) return false;
    return !/platform:/.test(src);
  });

  return {
    ok: offenders.length === 0,
    detail: offenders.length ? `unscoped account sweep: ${offenders.join(", ")}` : `${files.length} jobs`,
  };
});

// ── Delivery claims ──────────────────────────────────────────────────────────

gate("DeliveryClaim ledger exists with a unique scope+key", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  if (!/model DeliveryClaim \{/.test(schema)) return { ok: false, detail: "model missing" };
  const hasUnique = /@@unique\(\[scope, key\]\)/.test(schema);
  return { ok: hasUnique, detail: hasUnique ? "" : "no @@unique([scope, key])" };
});

/**
 * The rule is one private reply per comment, ever, across every campaign. It was
 * a findFirst-then-update, which two concurrent consumers both pass. The database
 * constraint is the mutual exclusion now, so the query must be gone rather than
 * merely unused.
 */
gate("send path has no read-then-write reply dedup", () => {
  const src = readFileSync("lib/queue/dm-worker.ts", "utf8");
  const racy = /privateReplyUsedBy/.test(src);
  return { ok: !racy, detail: racy ? "privateReplyUsedBy query still present" : "" };
});

/**
 * A platform that cannot DM must not carry a DM method at all. Stubbing one is
 * the failure mode the capability model exists to prevent.
 */
gate("adapters implement exactly the capabilities they declare", () => {
  const types = readFileSync("lib/platforms/types.ts", "utf8");
  const files = adapterFiles();

  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const platform = /platform:\s*"([A-Z]+)"/.exec(src)?.[1];
    if (!platform) {
      offenders.push(`${file} declares no platform`);
      continue;
    }

    const block = new RegExp(`${platform}:\\s*\\[([^\\]]*)\\]`).exec(types)?.[1] ?? "";
    const declaresDm = /PRIVATE_REPLY/.test(block);
    const hasMessaging = !/messaging:\s*null/.test(src);

    if (declaresDm !== hasMessaging) {
      offenders.push(
        `${file} declares PRIVATE_REPLY=${declaresDm} but messaging=${hasMessaging ? "present" : "null"}`
      );
    }

    // A platform that cannot message must not carry a send method anywhere, even
    // an unreachable one. Stubbing is the failure mode the model exists to stop.
    if (!declaresDm && /\bsendPrivateReply\s*[(:]/.test(src)) {
      offenders.push(`${file} has a send method despite declining PRIVATE_REPLY`);
    }
  }
  return { ok: offenders.length === 0, detail: offenders.join("; ") };
});

/**
 * Discovery is a union so a poll-only platform has no signature to verify. A
 * webhook route that reaches for one without narrowing would be asserting the
 * variant rather than handling it.
 */
gate("poll-only platforms carry no webhook methods", () => {
  const files = adapterFiles();

  const offenders = files.filter((file) => {
    const src = readFileSync(file, "utf8");
    if (!/kind:\s*"poll"/.test(src)) return false;
    return /verifySignature\s*[(:]/.test(src) || /parseEvents\s*[(:]/.test(src);
  });
  return { ok: offenders.length === 0, detail: offenders.join(", ") };
});

/**
 * A webhook route must reach its platform through the adapter. Calling a
 * platform's parser directly is how the abstraction acquires an exception, and
 * the exception is always on the oldest and busiest platform.
 */
gate("webhook routes go through an adapter", () => {
  const routes = execSync(
    "find app/api/webhook -name 'route.ts'",
    { encoding: "utf8", shell: "/bin/bash" }
  ).trim().split("\n").filter(Boolean);

  const offenders = routes.filter((route) => {
    const src = readFileSync(route, "utf8");
    const bypasses = /from "@\/lib\/meta\/webhook"/.test(src);
    return bypasses;
  });
  return { ok: offenders.length === 0, detail: offenders.join(", ") };
});

/**
 * Every platform that can only be polled must actually be polled by something.
 * An adapter reachable from the registry and from nowhere else is dead code
 * wearing a feature's clothes.
 */
gate("poll-only platforms are reachable from the scheduler", () => {
  const scheduler = existsSync("lib/runtime/discovery.ts")
    ? readFileSync("lib/runtime/discovery.ts", "utf8")
    : "";
  if (!scheduler) return { ok: false, detail: "lib/runtime/discovery.ts missing" };

  const files = adapterFiles();

  const pollOnly = files
    .filter((f) => /kind:\s*"poll"/.test(readFileSync(f, "utf8")))
    .map((f) => /platform:\s*"([A-Z]+)"/.exec(readFileSync(f, "utf8"))?.[1])
    .filter(Boolean);

  // A scheduler that merely mentions discovery proves nothing. The sweep has to
  // be reachable from a cron entry, or the adapter is dead code with tests.
  const sweep = existsSync("lib/polling/poll-sweep.ts")
    ? readFileSync("lib/polling/poll-sweep.ts", "utf8")
    : "";
  const engine = readFileSync("workers/engine/index.ts", "utf8");

  const problems = [];
  if (!/discovery\.kind/.test(scheduler)) problems.push("scheduler ignores discovery kind");
  if (!/discovery\.kind\s*!==\s*"poll"/.test(sweep)) problems.push("sweep does not filter to poll platforms");
  // Matches the call, not the import. An unused import passes a laxer check
  // while the sweep never runs.
  const cronBlock = /const CRON_JOBS = \{[\s\S]*?\n\}/.exec(engine)?.[0] ?? "";
  if (!/sweepPollOnlyAccounts\s*\(/.test(cronBlock)) {
    problems.push("no cron entry calls the sweep");
  }
  if (pollOnly.length === 0) problems.push("no poll-only platform found");

  return { ok: problems.length === 0, detail: problems.join("; ") || `${pollOnly.length} poll-only platforms` };
});

/**
 * The reconciler sweeps accounts and calls a platform API. Sweeping without
 * naming a platform hands one vendor's endpoint another vendor's token, which
 * has now shipped three times in this codebase.
 */
gate("comment sweeps name a platform", () => {
  const src = readFileSync("lib/polling/comment-reconciler.ts", "utf8");
  const named = /platform:/.test(src);
  return { ok: named, detail: named ? "" : "reconciler sweeps every platform's accounts" };
});

/** One counter mechanism, not a general broker plus a bespoke limiter beside it. */
gate("quota runs through one broker", () => {
  if (!existsSync("lib/runtime/quota.ts")) return { ok: false, detail: "lib/runtime/quota.ts missing" };
  const limiter = readFileSync("lib/utils/rate-limiter.ts", "utf8");
  const viaBroker = /from "@\/lib\/runtime\/quota"/.test(limiter);
  return { ok: viaBroker, detail: viaBroker ? "" : "rate-limiter keeps its own counter" };
});

/**
 * Facebook returns the commenter's page-scoped id only in the private-reply
 * response. It is the only way to address them again, so discarding it means no
 * follow-up can ever reach that person.
 */
gate("discovered messaging ids are persisted", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  if (!/model MessagingContact \{/.test(schema)) return { ok: false, detail: "model missing" };
  const worker = readFileSync("lib/queue/dm-worker.ts", "utf8");
  // Follow the call rather than demanding the write be inlined: the worker must
  // hand the send result to something, and that something must actually store
  // the discovered address. A worker that captures the result and drops it, or a
  // recorder that never reads discoveredUserId, both fail here.
  if (!/rememberContact\(/.test(worker)) {
    return { ok: false, detail: "send path never records the contact" };
  }
  if (!/result:\s*sendResult/.test(worker)) {
    return { ok: false, detail: "send result is captured but not passed on" };
  }
  const recorder = readFileSync("lib/runtime/contacts.ts", "utf8");
  const stores = /discoveredUserId/.test(recorder) && /messagingContact/.test(recorder);
  return { ok: stores, detail: stores ? "" : "recorder never stores discoveredUserId" };
});

/** Every platform that pushes comments needs a route, or the webhook has nowhere to land. */
gate("webhook platforms have an ingest route", () => {
  const files = adapterFiles();

  const missing = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!/kind:\s*"webhook"/.test(src)) continue;
    const platform = /platform:\s*"([A-Z]+)"/.exec(src)?.[1]?.toLowerCase();
    if (!platform) continue;
    const legacy = platform === "instagram" && existsSync("app/api/webhook/route.ts");
    if (!legacy && !existsSync(`app/api/webhook/${platform}/route.ts`)) missing.push(platform);
  }
  return { ok: missing.length === 0, detail: missing.join(", ") };
});

/**
 * The builder must offer only what the connected account can do. Otherwise a
 * creator configures a follow gate on a platform that has none and the worker
 * silently skips it, which reads as the product being broken.
 */
gate("campaign builder gates on capability", () => {
  const src = readFileSync("components/campaign-builder.tsx", "utf8");
  if (!/campaignOptions\(platform\)/.test(src)) {
    return { ok: false, detail: "builder offers every option on every platform" };
  }
  // A mention is not a gate. Every DM-only section must sit behind the flag, so
  // check the guard actually precedes each one.
  const dmSections = ["They will get", "And then, they will get"];
  const ungated = dmSections.filter((title) => {
    const at = src.indexOf(`<Section title="${title}">`);
    return at === -1 || !/\{canSendDm && \($/.test(src.slice(0, at).trimEnd());
  });
  return {
    ok: ungated.length === 0,
    detail: ungated.length ? `ungated DM section: ${ungated.join(", ")}` : "",
  };
});

/** Admin surfaces exist as pages, not only as routes nothing links to. */
gate("admin surfaces are reachable from the app", () => {
  const missing = [];
  if (!existsSync("app/(dashboard)/fleet/page.tsx")) missing.push("fleet page");
  if (!existsSync("app/(dashboard)/creators/page.tsx")) missing.push("creators page");
  const sidebar = readFileSync("components/sidebar.tsx", "utf8");
  if (!/\/fleet/.test(sidebar)) missing.push("sidebar link");
  return { ok: missing.length === 0, detail: missing.join(", ") };
});

// ── Correctness gates ────────────────────────────────────────────────────────

gate("typecheck", () => {
  execSync("pnpm typecheck", { stdio: "pipe" });
  return true;
});

/**
 * Cross-creator access must be answerable historically, not just currently.
 * Burying it in OperationalEvent's JSON payload means no query can answer "who
 * read this creator's data", which is the only question the log exists for.
 */
gate("admin access is auditable", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  if (!/model AdminAccessLog \{/.test(schema)) return { ok: false, detail: "model missing" };

  const src = readFileSync("lib/tenancy/platform-scope.ts", "utf8");
  const writes = /prisma\.adminAccessLog\s*\n?\s*\.?create/.test(src);
  return { ok: writes, detail: writes ? "" : "recordAdminAccess still writes to OperationalEvent" };
});

/** The per-step idempotency primitive the design calls the generalisation of publicReplySentAt. */
gate("step outcomes are the idempotency primitive", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  if (!/model StepOutcome \{/.test(schema)) return { ok: false, detail: "model missing" };

  const block = /model StepOutcome \{[^}]*\}/.exec(schema)?.[0] ?? "";
  const unique = /@@unique\(\[runId, stepIndex\]\)/.test(block);
  return { ok: unique, detail: unique ? "" : "missing @@unique([runId, stepIndex])" };
});

/**
 * The renames are logical only. Every one must carry an @@map onto the physical
 * table, or the migration moves rows it promised to leave alone.
 */
gate("model renames are logical only", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const renames = [
    ["Campaign", "Automation"],
    ["ConnectedAccount", "InstagramAccount"],
    ["SeenTrigger", "ProcessedComment"],
    ["ResponseRun", "DmLog"],
  ];

  const wrong = [];
  for (const [model, table] of renames) {
    const block = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(schema)?.[0];
    if (!block) {
      wrong.push(`${model} missing`);
      continue;
    }
    if (!new RegExp(`@@map\\("${table}"\\)`).test(block)) wrong.push(`${model} lacks @@map("${table}")`);
  }
  return { ok: wrong.length === 0, detail: wrong.join(", ") };
});

/** No caller may still address a renamed model by its old name. */
gate("no caller uses a pre-rename model name", () => {
  const old = ["prisma.automation", "prisma.instagramAccount", "prisma.dmLog", "prisma.processedComment"];
  const found = [];
  for (const name of old) {
    const hits = execSync(
      `grep -rl --include='*.ts' --include='*.tsx' -F '${name}.' . ` +
        `--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=generated || true`,
      { encoding: "utf8", shell: "/bin/bash" }
    ).trim();
    if (hits) found.push(`${name} in ${hits.split("\n").length} files`);
  }
  return { ok: found.length === 0, detail: found.join(", ") };
});

/**
 * The backfill the design calls the one that matters. Without it, cutover lets a
 * second campaign believe an already-spent private reply is unspent and burn a
 * call Meta refuses.
 */
gate("historical private replies are claimed", () => {
  if (!existsSync("scripts/backfill-delivery-claims.mjs")) {
    return { ok: false, detail: "backfill script missing" };
  }
  const src = readFileSync("scripts/backfill-delivery-claims.mjs", "utf8");
  const guards = [
    [/ON CONFLICT DO NOTHING/i, "not idempotent"],
    [/NOT LIKE 'reveal:%'/, "does not exclude reveal keys"],
    [/NOT LIKE 'dm:%'/, "does not exclude inbound-DM keys"],
  ];
  const missing = guards.filter(([re]) => !re.test(src)).map(([, why]) => why);
  return { ok: missing.length === 0, detail: missing.join(", ") };
});

/**
 * The one capability YouTube and TikTok have.
 *
 * `processComment` used to bail on a null `adapter.messaging`, which discarded
 * every job the poll sweep and the TikTok webhook enqueue. Every adapter unit
 * test still passed, so the gate follows the order of the two statements rather
 * than trusting the suite.
 */
gate("platforms that cannot message still reply publicly", () => {
  const src = readFileSync("lib/queue/dm-worker.ts", "utf8");
  const start = src.indexOf("async function processComment");
  if (start < 0) return { ok: false, detail: "processComment missing" };
  const end = src.indexOf("\nasync function ", start + 1);
  const body = src.slice(start, end < 0 ? undefined : end);

  const reply = body.indexOf("postPublicReply(");
  if (reply < 0) return { ok: false, detail: "comment handler never replies publicly" };

  const bail = body.indexOf("if (!messaging) return;");
  if (bail >= 0 && bail < reply) {
    return { ok: false, detail: "returns on null messaging before the public reply" };
  }
  const settles = /if \(!messaging\) \{/.test(body);
  return { ok: settles, detail: settles ? "" : "never settles the run for a messaging-less platform" };
});

/**
 * The post picker used to call the Instagram Graph API for every platform, and
 * account lookup is not platform-filtered, so a Facebook Page id resolved and
 * then sent a Page token to graph.instagram.com.
 */
gate("the post picker goes through the adapter", () => {
  if (existsSync("app/api/instagram/posts/route.ts")) {
    return { ok: false, detail: "the Instagram-only posts route is still reachable" };
  }
  if (!existsSync("app/api/posts/route.ts")) return { ok: false, detail: "no posts route" };
  const src = readFileSync("app/api/posts/route.ts", "utf8");
  const viaAdapter = /adapterFor\([^)]*\)\.listPosts\(/.test(src);
  return { ok: viaAdapter, detail: viaAdapter ? "" : "does not call adapter.listPosts" };
});

/**
 * Neither sweep may name a platform. The reconciler hardcoded INSTAGRAM, which
 * left Facebook with no safety net under a webhook Meta unsubscribes after an
 * hour of failures, and the poll sweep imported the YouTube module directly.
 */
gate("comment discovery names no platform", () => {
  const names = /\b(INSTAGRAM|FACEBOOK|YOUTUBE|TIKTOK)\b|platforms\/(instagram|facebook|youtube|tiktok)/;
  const offenders = [];
  for (const file of ["lib/polling/comment-reconciler.ts", "lib/polling/poll-sweep.ts"]) {
    const src = readFileSync(file, "utf8");
    if (names.test(src)) offenders.push(file);
    if (!/listRecentComments\(/.test(src)) offenders.push(`${file} does not discover through the adapter`);
  }
  return { ok: offenders.length === 0, detail: offenders.join(", ") };
});

/**
 * An unknown send outcome must not forfeit the comment's only reply forever.
 *
 * The claim is a lease: taken with a deadline, made permanent only once the
 * platform provably acted. That also covers the case with no error to classify
 * at all, where the process dies between the send and the record of it.
 */
gate("an unsettled claim lapses instead of forfeiting", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const block = /model DeliveryClaim \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  if (!/reclaimableAt DateTime\? @map\("expiresAt"\)/.test(block)) {
    return { ok: false, detail: "claim carries no lease, or the rename moved the column" };
  }

  const claims = readFileSync("lib/runtime/claims.ts", "utf8");
  if (!/reclaimableAt: \{ not: null, lte: now \}/.test(claims)) {
    return { ok: false, detail: "acquire never sweeps a lapsed lease" };
  }
  if (!/export async function settleClaims/.test(claims)) {
    return { ok: false, detail: "no way to make a claim permanent" };
  }

  const worker = readFileSync("lib/queue/dm-worker.ts", "utf8");
  const settle = worker.indexOf("settleClaims(claims, runKey)");
  if (settle < 0) return { ok: false, detail: "send path never settles the claim" };

  const marksSent = worker.indexOf('status: "SENT"', settle);
  return {
    ok: marksSent > settle,
    detail: marksSent > settle ? "" : "settles after marking sent, so a crash between them frees a spent claim",
  };
});

/**
 * A platform admin may edit a creator's campaign. The permission is deliberate,
 * so what has to hold is the record: writing in someone else's workspace must
 * go through the audited path, never through a workspace role the admin does
 * not hold.
 */
gate("cross-creator writes are audited", () => {
  const scope = readFileSync("lib/tenancy/platform-scope.ts", "utf8");
  const fn = /export async function assumeWorkspace[\s\S]*?\n\}/.exec(scope)?.[0];
  if (!fn) return { ok: false, detail: "no assumeWorkspace" };
  if (!/requirePlatformScope\("ADMIN"\)/.test(fn)) {
    return { ok: false, detail: "assuming a workspace does not require ADMIN" };
  }
  if (!/recordAdminAccess\(/.test(fn)) {
    return { ok: false, detail: "assuming a workspace writes no audit row" };
  }

  const resolver = readFileSync("lib/tenancy/acting-workspace.ts", "utf8");
  if (!/assumeWorkspace\(/.test(resolver)) {
    return { ok: false, detail: "resolver reaches other workspaces unaudited" };
  }

  const route = readFileSync("app/api/automations/route.ts", "utf8");
  const post = route.slice(route.indexOf("export async function POST"));
  const viaResolver = /actingWorkspace\(/.test(post);
  return { ok: viaResolver, detail: viaResolver ? "" : "campaign writes bypass the resolver" };
});

/**
 * Every platform's send must be charged its own shape. The send path used to
 * charge all four Instagram's fixed 750 an hour, which under-counts Facebook's
 * measured Page ceiling and is meaningless for a pooled YouTube project.
 */
gate("send quota is per platform", () => {
  const src = readFileSync("lib/runtime/send-quota.ts", "utf8");
  const wrong = [];
  const meters = new Set();

  for (const platform of ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK"]) {
    const block = new RegExp(`case "${platform}":[\\s\\S]*?(?=\\n    case |\\n  \\}\\n\\})`).exec(src)?.[0];
    if (!block) {
      wrong.push(`${platform} has no case`);
      continue;
    }
    const found = [...block.matchAll(/meter: "([^"]+)"/g)].map((m) => m[1]);
    if (found.length === 0) wrong.push(`${platform} charges nothing`);
    for (const m of found) meters.add(m);

    // TikTok is the two-level case: an account cap and an app cap at once.
    if (platform === "TIKTOK" && (block.match(/scope: (account|app)/g) ?? []).length < 2) {
      wrong.push("TIKTOK does not reserve both levels");
    }
  }

  // Four platforms sharing one meter is the bug this replaced, where every
  // platform was charged Instagram's fixed hourly cap.
  if (meters.size < 3) wrong.push(`only ${meters.size} distinct meters across four platforms`);

  const limiter = readFileSync("lib/utils/rate-limiter.ts", "utf8");
  if (!/responseBuckets\(/.test(limiter)) wrong.push("the limiter still owns its own bucket");
  return { ok: wrong.length === 0, detail: wrong.join(", ") };
});

/**
 * The public reply was free. On YouTube it costs 50 units against a pool of
 * 10,000 a day shared by every creator, so an unmetered reply path drains the
 * product's whole budget while the scheduler still thinks it can poll.
 */
gate("the public reply is metered", () => {
  const worker = readFileSync("lib/queue/dm-worker.ts", "utf8");
  const reply = worker.indexOf("postPublicReply(");
  if (reply < 0) return { ok: false, detail: "no public reply to meter" };

  const before = worker.slice(Math.max(0, reply - 1200), reply);
  if (!/responseBuckets\([^)]*"publicReply"/.test(before)) {
    return { ok: false, detail: "no budget reserved before the reply" };
  }
  const after = worker.slice(reply, reply + 600);
  const refunds = /settle\("release"\)/.test(after);
  return { ok: refunds, detail: refunds ? "" : "a failed reply keeps the units it never spent" };
});

/**
 * A derived ceiling that is never refreshed is a floor with extra steps.
 */
gate("derived capacity is actually measured", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  if (!/derivedCapacityUnits Int\?/.test(schema)) {
    return { ok: false, detail: "nowhere to store a measured ceiling" };
  }
  if (!existsSync("lib/jobs/refresh-capacity.ts")) {
    return { ok: false, detail: "no job measures it" };
  }
  const job = readFileSync("lib/jobs/refresh-capacity.ts", "utf8");
  const writes = /derivedCapacityUnits: units/.test(job) && /derivedCapacityAt: new Date\(\)/.test(job);
  return { ok: writes, detail: writes ? "" : "the job never records what it measured" };
});

/**
 * The campaign primitive is an ordered list of steps, each naming the
 * capability it consumes, and a stored plan is re-checked on load rather than
 * trusted. A campaign outlives the capability it was written against.
 */
gate("a stored plan is re-checked against live capabilities", () => {
  if (!existsSync("lib/campaigns/compile.ts")) return { ok: false, detail: "no compiler" };
  const src = readFileSync("lib/campaigns/compile.ts", "utf8");

  if (!/export function parseStoredPlan/.test(src)) {
    return { ok: false, detail: "stored plans are never re-checked" };
  }
  // Parsing must run the same check as compiling, not a weaker one.
  const parse = /export function parseStoredPlan[\s\S]*$/.exec(src)?.[0] ?? "";
  if (!/return compile\(/.test(parse)) {
    return { ok: false, detail: "load-time checking has drifted from save-time" };
  }

  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const stored = /compiledPlan Json\?/.test(schema);
  return { ok: stored, detail: stored ? "" : "nowhere to store a compiled plan" };
});

/**
 * Platform copy policy is enforced where the creator writes it, not where the
 * send happens. YouTube's III.F strike lands on the creator's channel.
 */
gate("platform copy policy is enforced at authoring time", () => {
  const src = readFileSync("lib/campaigns/compile.ts", "utf8");
  const missing = [];
  if (!/III\.F/.test(src)) missing.push("no YouTube incentive rule");
  if (!/COPY_POLICY_VIOLATION/.test(src)) missing.push("no violation code");
  if (!/TIKTOK_COPY_RULES/.test(src)) missing.push("no TikTok copy rule");
  return { ok: missing.length === 0, detail: missing.join(", ") };
});

/**
 * The run is a resumable state machine, not a log. Four job types collapse into
 * one operation, and every column the schema declares for it has a reader.
 */
gate("the run state machine is wired, not just declared", () => {
  if (!existsSync("lib/runtime/engine.ts")) return { ok: false, detail: "no engine" };
  const src = readFileSync("lib/runtime/engine.ts", "utf8");

  const unread = ["cursor", "awaitingSignals", "awaitUntil", "onTimeout", "leaseToken", "leaseExpiresAt"]
    .filter((column) => !new RegExp(`\\b${column}\\b`).test(src));
  if (unread.length > 0) {
    return { ok: false, detail: `state columns with no reader: ${unread.join(", ")}` };
  }

  if (!/prisma\.stepOutcome\.create/.test(src)) {
    return { ok: false, detail: "StepOutcome is declared but never written" };
  }
  // Losing the unique-constraint race must mean "someone else did it", never a
  // crash and never a silent repeat.
  const catches = /catch \{[\s\S]{0,300}?return false;/.test(src);
  return { ok: catches, detail: catches ? "" : "a lost outcome race is not handled" };
});

/**
 * The follow gate's decision table is the subtlest behaviour here, and it used
 * to be spread across three call sites in three shapes.
 */
gate("the follow gate is one pure table", () => {
  if (!existsSync("lib/runtime/follow-gate.ts")) return { ok: false, detail: "no follow gate" };
  const src = readFileSync("lib/runtime/follow-gate.ts", "utf8");
  if (/prisma|fetch\(/.test(src)) return { ok: false, detail: "the table does I/O" };

  const failsOpen = /status === null && contact === "USER_CONFIRMED"/.test(src);
  return { ok: failsOpen, detail: failsOpen ? "" : "does not fail open after the person confirmed" };
});

/**
 * A plan that is compiled but never executed is a second universe. The engine
 * only earns its place when a trigger reaches it and a parked run comes back.
 */
gate("the engine is reachable from a trigger and from a deadline", () => {
  if (!existsSync("lib/runtime/dispatch.ts")) return { ok: false, detail: "no dispatcher" };
  const dispatch = readFileSync("lib/runtime/dispatch.ts", "utf8");

  const missing = [];
  if (!/startRuns\(/.test(dispatch)) missing.push("a trigger opens no run");
  if (!/advanceRun\(/.test(dispatch)) missing.push("nothing advances a run");
  if (!/parseStoredPlan\(/.test(dispatch)) missing.push("the stored plan is trusted unchecked");

  const worker = readFileSync("lib/queue/dm-worker.ts", "utf8");
  if (!/dispatchTrigger\(/.test(worker)) missing.push("the send path never reaches the engine");

  const engineWorker = readFileSync("workers/engine/index.ts", "utf8");
  if (!/advanceDueRuns\(/.test(engineWorker)) missing.push("parked runs are never resumed");

  return { ok: missing.length === 0, detail: missing.join(", ") };
});

/**
 * A campaign only joins the engine if saving it writes a plan. Without this the
 * column stays null forever and the state machine never runs.
 */
gate("saving a campaign compiles its plan", () => {
  const route = readFileSync("app/api/automations/route.ts", "utf8");
  const missing = [];
  if (!/compiledPlan: plan/.test(route)) missing.push("create stores no plan");
  if (!/recompilePlan\(/.test(route)) missing.push("update never recompiles");
  // A campaign the account cannot run must be refused, not stored broken.
  if (!/status: 422/.test(route)) missing.push("an uncompilable campaign is still saved");
  return { ok: missing.length === 0, detail: missing.join(", ") };
});

/**
 * A Meta callback URL is one app-global dashboard setting, so deliveries keep
 * arriving at the old route until the change propagates. Retiring the legacy
 * alias safely means watching for a full interval with zero hits on it.
 */
gate("every ingest records the route it arrived on", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const block = /model WebhookEvent \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  if (!/route\s+String\?/.test(block)) {
    return { ok: false, detail: "no column to record it in" };
  }

  const routes = execSync("ls app/api/webhook/route.ts app/api/webhook/*/route.ts", {
    encoding: "utf8",
    shell: "/bin/bash",
  }).trim().split("\n");

  const silent = routes.filter((file) => {
    const src = readFileSync(file, "utf8");
    return /webhookEvent/.test(src) && !/route: "/.test(src);
  });
  return { ok: silent.length === 0, detail: silent.join(", ") };
});

/**
 * Token lifetimes differ by platform in kind, not degree. Facebook Page tokens
 * never expire, Instagram refreshes by presenting itself, and YouTube and
 * TikTok need a stored refresh token. A cron that assumes one shape gets three
 * platforms wrong.
 */
gate("token refresh is the adapter's answer, not the cron's", () => {
  const types = readFileSync("lib/platforms/types.ts", "utf8");
  if (!/export type TokenLifetime/.test(types)) {
    return { ok: false, detail: "no token lifetime on the adapter" };
  }

  const silent = adapterFiles().filter((f) => !/\n  tokens: /.test(readFileSync(f, "utf8")));
  if (silent.length > 0) {
    return { ok: false, detail: `adapters with no token lifetime: ${silent.join(", ")}` };
  }

  const job = readFileSync("lib/jobs/refresh-tokens.ts", "utf8");
  if (/platform: "[A-Z]+"/.test(job)) {
    return { ok: false, detail: "the refresh job still names a platform" };
  }
  const viaAdapter = /adapterFor\([^)]*\)\.tokens/.test(job);
  return { ok: viaAdapter, detail: viaAdapter ? "" : "the job does not ask the adapter" };
});

/**
 * Capability is a fact about the account, not the network. A UK TikTok account
 * and a Vietnamese one differ, and a per-platform constant cannot say so.
 */
gate("capabilities are negotiated per account", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const block = /model ConnectedAccount \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  const missing = [];
  for (const column of ["grantedCapabilities", "region", "declinedCapabilities"]) {
    if (!new RegExp(`\\b${column}\\b`).test(block)) missing.push(column);
  }
  if (missing.length > 0) return { ok: false, detail: `no column for ${missing.join(", ")}` };

  if (!existsSync("lib/platforms/negotiate.ts")) {
    return { ok: false, detail: "nothing negotiates" };
  }

  // The connect callback is the only moment the platform says what it granted
  // and where the account is registered. Not negotiating there means never.
  const callback = readFileSync("app/api/connect/[platform]/callback/route.ts", "utf8");
  if (!/negotiate\(/.test(callback)) {
    return { ok: false, detail: "connect stores an account without negotiating" };
  }

  // And the send path must read the account's set, not the platform ceiling.
  const dispatch = readFileSync("lib/runtime/dispatch.ts", "utf8");
  const perAccount = /storedCapabilities\(/.test(dispatch);
  return { ok: perAccount, detail: perAccount ? "" : "the engine still checks the ceiling" };
});

/**
 * Connecting is one route for every platform, and a platform whose developer
 * app is not approved says so rather than failing at the vendor's redirect.
 */
gate("one connect flow, and every platform has one", () => {
  const missing = [];
  if (!existsSync("app/api/connect/[platform]/route.ts")) missing.push("no unified connect route");
  if (!existsSync("app/api/connect/[platform]/callback/route.ts")) missing.push("no callback");

  // Every adapter, including the two whose developer apps are still in review.
  // Whether a platform is usable is whether credentials exist, which changes
  // without a deploy; a hardcoded "not yet" would outlive the approval.
  for (const file of adapterFiles()) {
    const src = readFileSync(file, "utf8");
    if (!/\n  oauth: \{/.test(src)) missing.push(`${file} declares no oauth flow`);
    // The bodies, not the names. An empty `exchange()` satisfies a name check
    // and returns no accounts, which looks like a creator who authorized nothing.
    const authorize = /authorizeUrl\([\s\S]*?\n    \},/.exec(src)?.[0] ?? "";
    if (!/redirectUri/.test(authorize) || !/state/.test(authorize)) {
      missing.push(`${file} builds no authorize URL`);
    }
    const exchange = /async exchange\([\s\S]*?\n    \},/.exec(src)?.[0] ?? "";
    if (!/(fetch\(|call<|await )/.test(exchange) || exchange.length < 200) {
      missing.push(`${file} cannot finish a flow`);
    }
  }

  if (!existsSync("app/api/platforms/route.ts")) {
    missing.push("the UI cannot tell which platforms are configured");
  }

  // The state carries which workspace asked, so forging it would attach an
  // account to someone else's workspace.
  const state = existsSync("lib/platforms/connect-state.ts")
    ? readFileSync("lib/platforms/connect-state.ts", "utf8")
    : "";
  if (!/timingSafeEqual/.test(state)) missing.push("connect state is not verified constant-time");

  return { ok: missing.length === 0, detail: missing.join(", ") };
});

/**
 * TikTok requires the account's own business_id on every call. It came from one
 * global environment variable, which is wrong the moment a second creator
 * connects and silently posts under the first one's account.
 */
gate("no platform identity comes from a global env var", () => {
  const offenders = execSync(
    "grep -rl --include='*.ts' -F 'TIKTOK_BUSINESS_ID' . " +
      "--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=generated || true",
    { encoding: "utf8", shell: "/bin/bash" }
  ).trim();
  return { ok: offenders === "", detail: offenders.split("\n").join(", ") };
});

/**
 * TikTok documents no signing scheme, so the signature check is an educated
 * guess. Acting on an unverified signature without re-reading the comment means
 * a forged payload can make a creator's account post.
 */
gate("tiktok confirms a comment before acting on it", () => {
  const src = readFileSync("app/api/webhook/tiktok/route.ts", "utf8");
  if (!/listRecentComments\(/.test(src)) {
    return { ok: false, detail: "acts on the payload without re-reading" };
  }
  // And it must use the text the API reports, not the text the payload claimed,
  // or a forgery still chooses which keyword it matched.
  const usesApiText = /commentText: match\.text/.test(src);
  return { ok: usesApiText, detail: usesApiText ? "" : "trusts the payload's own text" };
});

/**
 * YouTube's spam policy is qualitative and the strike lands on the creator's
 * channel, so one video must not be able to absorb the whole daily budget.
 */
gate("public replies are capped per post where policy is qualitative", () => {
  const src = readFileSync("lib/runtime/send-quota.ts", "utf8");
  const missing = ["youtube", "tiktok"].filter(
    (p) => !new RegExp(`${p}:replies_per_video`).test(src)
  );
  return {
    ok: missing.length === 0,
    detail: missing.length ? `${missing.join(", ")} has no per-post cap` : "",
  };
});

/**
 * Cloudflare does not publish Email Sending's daily quota, and that ceiling is
 * on the login path.
 */
gate("the unpublished email quota is readable at runtime", () => {
  if (!existsSync("lib/email/limits.ts")) return { ok: false, detail: "nothing reads it" };
  const src = readFileSync("lib/email/limits.ts", "utf8");
  const reads = /email\/sending\/limits/.test(src);
  if (!reads) return { ok: false, detail: "does not call the limits endpoint" };

  // Reading it and showing nobody is the same as not reading it. The ceiling is
  // on the login path, so the warning has to reach an operator before it bites.
  const fleet = readFileSync("lib/ops/fleet.ts", "utf8");
  if (!/readSendingLimits\(/.test(fleet)) {
    return { ok: false, detail: "nothing surfaces the reading" };
  }

  const stack = readFileSync("docs/stack.md", "utf8");
  const priced = /## What it costs/.test(stack);
  return { ok: priced, detail: priced ? "" : "the bill is still unpriced" };
});

/**
 * A Worker may not open a socket to a private address. Hyperdrive exists to
 * hand back a local one, and reading the secret instead means the origin is
 * dialled directly. That works against a public database and fails outright
 * behind a private endpoint, which is the worst way for it to be wrong.
 */
gate("the database goes through Hyperdrive", () => {
  const client = readFileSync("lib/db/client.ts", "utf8");
  const fn = /function connectionString[\s\S]*?\n\}/.exec(client)?.[0] ?? "";
  if (!/HYPERDRIVE\?\.connectionString/.test(fn)) {
    return { ok: false, detail: "the client never reads the binding" };
  }
  // The binding has to win. A fallback that is checked first is not a fallback.
  const binding = fn.indexOf("HYPERDRIVE");
  const secret = fn.indexOf("process.env.DATABASE_URL");
  if (secret >= 0 && secret < binding) {
    return { ok: false, detail: "the secret is preferred over the binding" };
  }

  // And a raw Worker has to pass its env in, or the binding is invisible to it.
  const engine = readFileSync("workers/engine/index.ts", "utf8");
  const threads = /withBindings\(env,/.test(engine);
  return { ok: threads, detail: threads ? "" : "the engine discards its bindings" };
});

/**
 * A Worker cannot SMTP to Cloudflare's own relay. Cloudflare IPs are on the
 * socket layer's disallowed list alongside localhost and private addresses, so
 * the documented `smtp.mx.cloudflare.net` recipe works from a laptop and takes
 * down sign-in in production.
 */
gate("email leaves through the binding, not SMTP", () => {
  const transport = readFileSync("lib/email/send.ts", "utf8");
  const fn = /export async function sendEmail[\s\S]*?\n\}/.exec(transport)?.[0] ?? "";
  if (!/tryBindings\(\)\?\.EMAIL/.test(fn)) {
    return { ok: false, detail: "the transport never reads the binding" };
  }
  // The binding has to win. A fallback checked first is not a fallback.
  const binding = fn.indexOf("EMAIL");
  const smtp = fn.indexOf("sendOverSmtp");
  if (smtp >= 0 && smtp < binding) {
    return { ok: false, detail: "SMTP is preferred over the binding" };
  }

  // Both Workers send. The engine sends creator invitations.
  const missing = ["wrangler.jsonc", "wrangler.engine.jsonc"].filter(
    (f) => !/"send_email"/.test(readFileSync(f, "utf8"))
  );
  if (missing.length > 0) {
    return { ok: false, detail: `no send_email binding in ${missing.join(", ")}` };
  }

  // And magic links must use the same transport, or one path can work while
  // the other silently cannot.
  const auth = readFileSync("lib/auth.ts", "utf8");
  const shared = /sendEmail\(/.test(auth) && !/createTransport\(/.test(auth);
  return { ok: shared, detail: shared ? "" : "sign-in has its own transport" };
});

gate("tests", () => {
  const out = execSync("pnpm test", { encoding: "utf8", stdio: "pipe" });
  const m = out.match(/Tests\s+(\d+) passed/);
  return { ok: /passed/.test(out) && !/failed/.test(out), detail: m ? `${m[1]} passing` : "" };
});

/**
 * The proofs moved out of the design record and onto shipped types, so a
 * YouTube follow gate is a build failure in `lib/` rather than in a sketch.
 * Counting the directives is what stops the file being gutted into one that
 * passes by asserting nothing.
 */
gate("capability proofs still hold", () => {
  const p = "lib/campaigns/capability-proofs.ts";
  if (!existsSync(p)) return { ok: false, detail: "proof file missing" };

  const src = readFileSync(p, "utf8");
  const negatives = (src.match(/@ts-expect-error/g) ?? []).length;
  if (negatives < 4) {
    return { ok: false, detail: `only ${negatives} negative proofs, expected at least 4` };
  }

  // An unused directive is itself an error, so this fails both when the illegal
  // thing stops being illegal and when it starts being constructible.
  execSync("pnpm typecheck", { stdio: "pipe" });
  return { ok: true, detail: `${negatives} negative proofs` };
});

if (!quick) {
  gate("lint", () => {
    execSync("pnpm lint", { stdio: "pipe" });
    return true;
  });

  gate("opennext cloudflare build", () => {
    execSync("pnpm exec opennextjs-cloudflare build", { stdio: "pipe" });
    return true;
  });
}

// ── Report ───────────────────────────────────────────────────────────────────

const pass = results.filter((r) => r.ok).length;
const width = Math.max(...results.map((r) => r.name.length));
console.log("");
for (const r of results) {
  console.log(
    `  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}${r.detail ? `  ${r.detail}` : ""}`
  );
}
console.log(`\n  ${pass}/${results.length} gates passing\n`);
process.exit(pass === results.length ? 0 : 1);
