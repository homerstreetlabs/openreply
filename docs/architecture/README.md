# Design record

The design work behind the multi-platform rewrite, kept because the research is still the
only place several platform facts are written down with their sources. It is a historical
record, not current documentation. For how to run the system, read
[../setup.md](../setup.md).

Every platform claim here was verified against official documentation on 2026-08-24. That
date matters. Meta, Google, and TikTok all move, so re-verify before acting on a detail
that a deploy depends on.

## Still worth reading

| File | Why |
| --- | --- |
| [capability-matrix.md](capability-matrix.md) | The finding the whole design turns on: the DM is not the universal capability, the public comment reply is. |
| [research/research-youtube.md](research/research-youtube.md) | Quota arithmetic, the two policy clauses, and why a DM is impossible rather than merely hard. |
| [research/research-tiktok.md](research/research-tiktok.md) | The two developer platforms, the regional walls, and the exact prohibition on initiating a conversation. |
| [research/research-facebook.md](research/research-facebook.md) | Private Replies, the 7-day window, and the undocumented reel webhook shape. |
| [research/research-cloudflare.md](research/research-cloudflare.md) | Queue delays, Durable Object limits, and why the Rate Limiting binding cannot do the job. |
| [research/current-system.md](research/current-system.md) | What the Instagram-only system did before the rewrite. |
| [OPEN-GAPS.md](OPEN-GAPS.md) | Four things every design candidate got wrong, and what was decided instead. |
| [SPIKE-RESULTS.md](SPIKE-RESULTS.md) | The deploy-0 spike, including the Prisma-on-Workers hang and its fix. |
| [SYNTHESIS-NOTE.md](SYNTHESIS-NOTE.md) | How the competing designs were judged and merged. |

## Superseded by shipped code

Read the code instead. These are kept for the reasoning in their comments.

| Artifact | Superseded by |
| --- | --- |
| [DESIGN.md](DESIGN.md) | The implementation. Sections on models, capabilities, and the quota broker are all shipped and may have drifted. |
| [schema.proposed.prisma](schema.proposed.prisma) | `prisma/schema.prisma` |
| [sketch/campaign/compile.ts](sketch/campaign/compile.ts) | `lib/campaigns/options.ts`, `components/campaign-builder.tsx` |
| [sketch/platform/](sketch/platform/) | `lib/platforms/` |
| [sketch/runtime/](sketch/runtime/) | `lib/runtime/` |
| [sketch/tenancy/](sketch/tenancy/) | `lib/tenancy/`, `lib/creators/` |
| [sketch/cloudflare/entry.ts](sketch/cloudflare/entry.ts) | `workers/engine/index.ts` |
| [sketch/health/incidents.ts](sketch/health/incidents.ts) | `lib/ops/incidents.ts`, `lib/ops/fleet.ts` |
| [spike/](spike/) | `wrangler.jsonc`, `wrangler.engine.jsonc` |

The capability proofs graduated. They now live at `lib/campaigns/capability-proofs.ts`
against shipped types, and `pnpm verify:migration` checks that file. The sketch copy is
kept only for its commentary.
