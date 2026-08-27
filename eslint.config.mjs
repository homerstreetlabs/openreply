import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
// anti-slop: vendored rules at tools/eslint/anti-slop. Edit them; they are yours.
import antiSlop from "./tools/eslint/anti-slop/index.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare build output and local Wrangler state.
    ".open-next/**",
    ".wrangler/**",
    // Design sketch, not shipped code: bodies are `not implemented` on purpose
    // and the capability proofs use deliberate @ts-expect-error directives.
    // Still typechecked (see tsconfig), just not linted as app source.
    "docs/architecture/**",
  ]),
  { ignores: [".agent/**", ".agents/**", ".claude/**", ".codex/**", ".continue/**", ".cursor/**", ".gemini/**", ".opencode/**", ".roo/**", ".windsurf/**", "tools/eslint/anti-slop/**"] },
  { files: ["**/*.ts", "**/*.tsx"], ...antiSlop.configs.recommended },

  // Two anti-slop rules assume a parser exists somewhere else. In this codebase
  // the functions they flag ARE the parser, or they are handling a value
  // TypeScript itself types as unknown.
  //
  // `catch (e)` binds `unknown` under strict mode, so a helper that formats a
  // caught error must accept it and must use `typeof`/`instanceof` to narrow.
  // `PlatformAdapter.parseEvents` takes a raw webhook body by design; that is
  // the I/O boundary the rule wants the parse to happen at.
  //
  // Where a real parse was possible it was written instead. `lib/queue/consumer`
  // and `lib/ops/worker-health` use zod schemas rather than hand-rolled guards.
  {
    files: [
      "lib/platforms/*.ts",
      "lib/queue/dm-worker.ts",
      "lib/polling/comment-reconciler.ts",
      "workers/engine/*.ts",
      "app/api/webhook/**/*.ts",
      "lib/jobs/*.ts",
      "lib/queue/consumer.ts",
      "lib/runtime/claims.ts",
      "lib/ops/incidents.ts",
      // The campaign compiler IS the parse boundary the rule wants. Draft steps
      // arrive from a browser and stored plans from a JSONB column, and both are
      // run through zod schemas here before anything downstream sees a step.
      "lib/campaigns/compile.ts",
    ],
    rules: {
      "anti-slop/no-unknown-parameters": "off",
      "anti-slop/no-runtime-typeof": "off",
    },
  },

  // `/api/connect/<platform>` is an API route that answers with a 302 to the
  // platform's consent screen, not a page. The dynamic `[platform]` segment
  // makes Next's rule read it as one, and `<Link>` would client-navigate and
  // prefetch an endpoint whose whole job is to redirect off-site.
  {
    files: [
      "app/(dashboard)/settings/page.tsx",
      "app/(dashboard)/overview/page.tsx",
      "components/top-bar.tsx",
    ],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },

  // The explicit return type on `builders` is the contract, not a widening.
  // `StepBuilders<P>` narrows the full builder map to the kinds P supports, and
  // that narrowing is the entire compile-time gate: without the annotation a
  // caller gets every kind back and a YouTube follow gate becomes writable
  // again. `lib/campaigns/capability-proofs.ts` fails the build if it does.
  {
    files: ["lib/campaigns/steps.ts"],
    rules: {
      "anti-slop/no-known-value-widening": "off",
    },
  },

  // A Proxy `get` trap has no other form.
  { files: ["lib/db/client.ts"], rules: { "anti-slop/no-reflect-get": "off" } },

  // The suite is built on `vi.mock`, and its fixtures are open dictionaries on
  // purpose. Converting 190 tests to dependency injection is a test-architecture
  // change, not a cleanup, and local convention beats a general rule.
  {
    files: ["__tests__/**/*.ts"],
    rules: {
      "anti-slop/no-module-mocking": "off",
      "anti-slop/no-unsafe-dictionary-type": "off",
      "anti-slop/no-chained-type-assertions": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      "anti-slop/no-unknown-returns": "off",
    },
  },

  // The annotation is what gives the field a type at all; `satisfies {}` on an
  // empty literal would infer it away.
  { files: ["lib/db/client.ts"], rules: { "anti-slop/no-known-value-widening": "off" } },

  // Auth.js types its adapter against its own vendored Prisma types, which are
  // structurally unrelated to the generated client. There is no narrowing that
  // bridges them, so the chain is the only expression available. The SAFETY
  // comment at the call site states what the adapter actually reads.
  { files: ["lib/auth.ts"], rules: { "anti-slop/no-chained-type-assertions": "off" } },

  // Pre-existing anti-slop findings, downgraded so they stay visible without
  // blocking CI. This branch did not touch these files, and a cleanup pass that
  // rewrites untouched code is a refactor wearing a cleanup's clothes. Remove a
  // path from this list when you next work in that file and fix what it reports.
  {
    files: [
    "app/(dashboard)/campaigns/\\[id\\]/page.tsx",
    "app/(dashboard)/campaigns/page.tsx",
    "app/(dashboard)/inbox/page.tsx",
    "app/api/automations/import/route.ts",
    "app/api/automations/route.ts",
    "app/api/instagram/disconnect/route.ts",
    "app/api/instagram/overview/route.ts",
    "app/api/logs/route.ts",
    "app/api/workspace/invitations/accept/route.ts",
    "app/api/workspace/members/route.ts",
    "app/page.tsx",
    "components/campaign-builder.tsx",
    "components/instagram-connect-notice.tsx",
    "components/status-badge.tsx",
    "components/top-bar.tsx",
    "lib/client-cache.ts",
    "lib/meta/client.ts",
    "lib/meta/oauth.ts",
    "lib/reports/follower-history.ts",
    "lib/reports/share.ts",
    "lib/tracking/analytics.ts",
    "lib/tracking/message.ts",
    "lib/workspace-access.ts",
    "lib/workspace-invitations.ts",
    ],
    rules: Object.fromEntries(
      Object.keys(antiSlop.configs.recommended.rules).map((rule) => [rule, "warn"])
    ),
  },
]);

export default eslintConfig;
