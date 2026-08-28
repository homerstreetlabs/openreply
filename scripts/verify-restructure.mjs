#!/usr/bin/env node
/**
 * Gates the multi-platform restructure, one unit per section.
 *
 * Structural rather than behavioural on purpose. `pnpm test` proves the code
 * runs; this proves the *shape* the design committed to is the shape that
 * landed, which is the part a passing test suite cannot see. A unit that was
 * half-applied — the new module written but the old caller still reaching past
 * it — leaves every test green and fails here.
 *
 * Run: node scripts/verify-restructure.mjs [--unit N]
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
let checks = 0;
let currentUnit = null;

const only = (() => {
  const i = process.argv.indexOf("--unit");
  return i === -1 ? null : Number.parseInt(process.argv[i + 1], 10);
})();

function unit(n, title, body) {
  if (only !== null && only !== n) return;
  currentUnit = n;
  process.stdout.write(`\n[1mUnit ${n} — ${title}[0m\n`);
  body();
}

function check(label, predicate) {
  checks += 1;
  let ok = false;
  let detail = "";
  try {
    const result = predicate();
    ok = result === true;
    if (typeof result === "string") {
      ok = false;
      detail = result;
    }
  } catch (error) {
    detail = error.message;
  }
  if (ok) {
    process.stdout.write(`  [32m✓[0m ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  [31m✗[0m ${label}${detail ? `\n      ${detail}` : ""}\n`);
  }
}

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function has(path) {
  return existsSync(join(ROOT, path));
}

/** Every source file under a directory, excluding generated Prisma output. */
function sources(dir, acc = []) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return acc;
  for (const entry of readdirSync(full)) {
    const path = join(full, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      sources(relative(ROOT, path), acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(relative(ROOT, path));
    }
  }
  return acc;
}

/** Files matching a pattern, so a failure names the offender rather than a count. */
function grep(pattern, dirs) {
  const hits = [];
  for (const dir of dirs) {
    for (const file of sources(dir)) {
      if (pattern.test(read(file))) hits.push(file);
    }
  }
  return hits;
}

function noneMatch(pattern, dirs, allow = []) {
  const hits = grep(pattern, dirs).filter((f) => !allow.includes(f));
  return hits.length === 0 ? true : `found in: ${hits.join(", ")}`;
}

const PLATFORMS = ["instagram", "facebook", "youtube", "tiktok"];

// ─── Unit 1 ──────────────────────────────────────────────────────────────────

unit(1, "read capabilities on the adapter", () => {
  const types = () => read("lib/platforms/types.ts");

  check("Metric is a closed union", () =>
    /export type Metric =/.test(types())
  );

  check("PLATFORM_METRICS is proved total over Platform", () =>
    /PLATFORM_METRICS[\s\S]{0,600}satisfies Record<Platform, readonly Metric\[\]>/.test(types())
  );

  check("PlatformAdapter declares insights and conversations", () => {
    const src = types();
    return (
      /readonly insights: InsightsCapability \| null/.test(src) &&
      /readonly conversations: ConversationsCapability \| null/.test(src)
    );
  });

  check("AccountReport carries tiles, columns, rows and notices", () => {
    const src = types();
    return ["tiles", "columns", "rows", "notices"].every((field) =>
      new RegExp(`readonly ${field}:`).test(src)
    );
  });

  // Split out of AccountReport deliberately: the cross-platform total asks
  // every account, and building a full report per account to reach one number
  // would cost hundreds of requests for a single line of UI.
  check("audience is its own cheap call", () => {
    const src = types();
    return /fetchAudience\(/.test(src) && /export interface Audience \{/.test(src);
  });

  for (const platform of PLATFORMS) {
    check(`${platform} adapter answers both read capabilities`, () => {
      const src = read(`lib/platforms/${platform}.ts`);
      return /insights:/.test(src) && /conversations:/.test(src);
    });
  }

});

// ─── Unit 2 ──────────────────────────────────────────────────────────────────

unit(2, "account scope lives in the route", () => {
  check("Overview is scoped by a path segment", () =>
    has("app/(dashboard)/overview/[accountId]/page.tsx")
  );

  check("Overview validates once in a layout", () =>
    has("app/(dashboard)/overview/[accountId]/layout.tsx")
  );

  check("Inbox is scoped by a path segment", () =>
    has("app/(dashboard)/inbox/[accountId]/page.tsx")
  );

  check("AccountDirectory exists", () => has("lib/accounts/directory.ts"));

  check("the unfiltered account lookup is gone", () =>
    !has("lib/instagram-accounts.ts") ||
    "lib/instagram-accounts.ts still exists; getWorkspaceInstagramAccount was its whole purpose"
  );

  // The quoted form only, which is how a query param or a body field is read.
  // The bare identifier survives in `app/api/webhook/*` as a queue-message
  // field: that is the engine Worker's wire format, and renaming it here would
  // strand messages already in flight.
  check("no caller reads the legacy instagramAccountId param", () =>
    noneMatch(/"instagramAccountId"|instagramAccountId=/, ["app", "components"])
  );

  check("nothing under app/ imports the Meta client directly", () =>
    noneMatch(/from "@\/lib\/meta\/client"/, ["app"])
  );

  // Code, not prose. `app/api/posts/route.ts` names the host in a doc comment
  // describing the bug it fixed, and that comment should outlive this gate.
  check("no route hardcodes the Instagram Graph host", () =>
    noneMatch(/["'`]https?:\/\/graph\.instagram\.com/, ["app"])
  );

  check("Overview no longer fetches from a client effect", () => {
    const src = read("app/(dashboard)/overview/[accountId]/page.tsx");
    return !/"use client"/.test(src) || "Overview should render on the server";
  });
});

// ─── Unit 3 ──────────────────────────────────────────────────────────────────

unit(3, "honest activity and dashboard numbers", () => {
  check("runAction derives what a run did", () => {
    const src = read("lib/tracking/activity.ts");
    return /export function runAction/.test(src) && /PUBLIC_REPLY/.test(src);
  });

  check("the dashboard summary route replaces the stats route", () =>
    has("app/api/dashboard/summary/route.ts") &&
    !has("app/api/dashboard/stats/route.ts")
  );

  check("Settings has its own lightweight route", () =>
    has("app/api/workspace/summary/route.ts")
  );

  check("the fields nothing read are gone", () =>
    noneMatch(/dmsSentToday|dmsSentWeek|totalDMs|totalClicks|totalAutomations/, [
      "app",
      "lib",
      "components",
    ])
  );

  check("contacts are counted, not listed", () =>
    noneMatch(/distinct: \["counterpartyId"\]/, ["app", "lib"])
  );

  check("Activity replaces DM Logs in the nav", () => {
    const src = read("components/sidebar.tsx");
    return /Activity/.test(src) && !/DM Logs/.test(src);
  });
});

// ─── Unit 4 ──────────────────────────────────────────────────────────────────

unit(4, "closed registration", () => {
  check("admit() exists", () => {
    const src = read("lib/access/admission.ts");
    return /export async function admit/.test(src);
  });

  check("admission is a discriminated union with a refusal reason", () => {
    const src = read("lib/access/admission.ts");
    return /kind: "refused"/.test(src) && /not_invited/.test(src);
  });

  check("the signIn callback gates sign-in", () => {
    const src = read("lib/auth.ts");
    return /callbacks:[\s\S]*?async signIn/.test(src) && /admit\(/.test(src);
  });

  check("sign-in no longer provisions a workspace unconditionally", () =>
    !/provisionWorkspaceForSignIn/.test(read("lib/auth.ts")) ||
    "lib/auth.ts still calls provisionWorkspaceForSignIn"
  );

  check("User.status exists in the schema", () => {
    const src = read("prisma/schema.prisma");
    return /status\s+UserStatus/.test(src) && /enum UserStatus/.test(src);
  });

  check("a migration backfills existing users to ACTIVE", () => {
    const dir = join(ROOT, "prisma/migrations");
    const found = readdirSync(dir).some((name) => {
      const file = join(dir, name, "migration.sql");
      return existsSync(file) && /UserStatus/.test(readFileSync(file, "utf8"));
    });
    return found || "no migration mentions UserStatus";
  });

  // The write must sit inside a server action, not the render path. A prefetch
  // or a mail scanner following the link used to consume the invitation.
  check("accepting an invitation is not a GET render", () => {
    const src = read("app/join/[token]/page.tsx");
    const action = src.indexOf('"use server"');
    const accept = src.indexOf("acceptCreatorInvitation({");
    if (action === -1) return "no server action on the page";
    return accept > action || "the invitation is accepted during render";
  });
});

// ─── Unit 5 ──────────────────────────────────────────────────────────────────

unit(5, "admins and users", () => {
  check("the admin users route exists", () => has("app/api/admin/users/route.ts"));

  check("it can grant, revoke and suspend", () => {
    const src = read("app/api/admin/users/route.ts");
    return ["GET", "POST", "DELETE", "PATCH"].every((verb) =>
      new RegExp(`export async function ${verb}`).test(src)
    );
  });

  check("revoking a grant never deletes the row", () => {
    const src = read("app/api/admin/users/route.ts");
    return /revokedAt/.test(src) && !/platformGrant\.delete/.test(src);
  });

  check("the Users page exists", () => has("app/(dashboard)/users/page.tsx"));

  check("the nav names Admins rather than a bare role word", () =>
    /Users|Admins/.test(read("components/sidebar.tsx"))
  );
});

// ─── Unit 6 ──────────────────────────────────────────────────────────────────

unit(6, "one invitation model", () => {
  check("a unified Invitation model exists", () => {
    const src = read("prisma/schema.prisma");
    return /model Invitation \{/.test(src) && /enum InvitationKind/.test(src);
  });

  check("the two old invitation models are gone", () => {
    const src = read("prisma/schema.prisma");
    return (
      !/model CreatorInvitation \{/.test(src) &&
      !/model WorkspaceInvitation \{/.test(src)
    );
  });

  check("no code references the retired models", () =>
    noneMatch(/creatorInvitation\.|workspaceInvitation\./, ["app", "lib"])
  );

  check("a migration moves the existing rows", () => {
    const dir = join(ROOT, "prisma/migrations");
    return (
      readdirSync(dir).some((name) => {
        const file = join(dir, name, "migration.sql");
        return existsSync(file) && /INSERT INTO "Invitation"/.test(readFileSync(file, "utf8"));
      }) || "no migration copies the old invitation rows across"
    );
  });
});

process.stdout.write(
  `\n${failures === 0 ? "[32m" : "[31m"}${checks - failures}/${checks} checks passed[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
