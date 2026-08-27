/**
 * The entry point that replaces four job handlers.
 *
 * A trigger opens runs; a signal or a deadline advances them. Which one it was
 * is the `Cause`, and past this function nothing else knows the difference.
 *
 * Campaigns with no `compiledPlan` fall back to the legacy send path. That is
 * the expand phase of the migration, not a compatibility layer kept for its own
 * sake: the column is nullable so old campaigns keep running unchanged, and a
 * campaign joins the engine the first time it is saved through the compiler.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { parseStoredPlan } from "@/lib/campaigns/compile";
import { storedCapabilities } from "@/lib/platforms/negotiate";
import { executeStep } from "@/lib/runtime/execute-step";
import type { RunTarget } from "@/lib/runtime/execute-step";
import { advanceRun, startRuns, type Cause, type Trigger } from "@/lib/runtime/engine";

/** A campaign row with everything a run needs, and nothing it does not. */
const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  workspaceId: true,
  connectedAccountId: true,
  compiledPlan: true,
  connectedAccount: {
    select: {
      id: true,
      platform: true,
      instagramId: true,
      accessToken: true,
      providerAppId: true,
      derivedCapacityUnits: true,
      derivedCapacityAt: true,
      grantedCapabilities: true,
    },
  },
  trackedLinks: {
    select: { slug: true, label: true, destinationUrl: true },
    orderBy: { createdAt: "asc" },
  },
} as const;

export interface DispatchStat {
  campaignId: string;
  ran: boolean;
  reason: string;
}

/**
 * Run every campaign that matched a trigger, through the engine.
 *
 * Returns the campaigns it could not take, so the caller can hand them to the
 * legacy path rather than dropping them.
 */
export async function dispatchTrigger(
  trigger: Trigger,
  campaignIds: readonly string[],
  cause: Cause = { kind: "trigger" }
): Promise<{ handled: DispatchStat[]; unplanned: string[] }> {
  if (campaignIds.length === 0) return { handled: [], unplanned: [] };

  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: [...campaignIds] } },
    select: CAMPAIGN_SELECT,
  });

  // Nullish, not `!== null`. A row selected without the column reads as
  // undefined, and treating that as "has a plan" would run the engine on an
  // empty one and silently send nothing.
  const planned = campaigns.filter((c) => c.compiledPlan != null);
  const unplanned = campaigns.filter((c) => c.compiledPlan == null).map((c) => c.id);
  if (planned.length === 0) return { handled: [], unplanned };

  const runs = await startRuns(
    trigger,
    planned.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      connectedAccountId: c.connectedAccountId,
    }))
  );

  const handled: DispatchStat[] = [];

  for (const run of runs) {
    const campaign = planned.find((c) => c.id === run.campaignId);
    if (!campaign) continue;

    const account = campaign.connectedAccount;
    // The account's negotiated set, not the platform's ceiling. A campaign that
    // compiled when the account had a capability must stop running when it
    // does not, and this is the load-time check that notices.
    const plan = parseStoredPlan(
      account.platform,
      storedCapabilities(account),
      campaign.compiledPlan
    );

    // A plan that no longer compiles means a capability moved under the
    // campaign. Refusing is the point: the alternative is attempting something
    // the account can no longer do and reporting the platform's error as ours.
    if (!plan.ok) {
      await prisma.responseRun.update({
        where: { id: run.runId },
        data: {
          status: "FAILED",
          errorMessage: `This campaign is no longer runnable on this account: ${plan.errors[0]?.message ?? "unknown"}`,
        },
      });
      handled.push({ campaignId: campaign.id, ran: false, reason: "plan no longer valid" });
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(account.accessToken);
    } catch {
      await prisma.responseRun.update({
        where: { id: run.runId },
        data: { status: "FAILED", errorMessage: "Failed to decrypt the stored access token" },
      });
      handled.push({ campaignId: campaign.id, ran: false, reason: "token unreadable" });
      continue;
    }

    const target: RunTarget = {
      platform: account.platform,
      accessToken,
      accountExternalId: account.instagramId,
      connectedAccountId: account.id,
      campaignId: campaign.id,
      triggerKey: trigger.triggerKey,
      postId: trigger.postId,
      counterpartyId: trigger.counterpartyId,
      counterpartyName: trigger.counterpartyName,
      trackedLinks: campaign.trackedLinks,
      budget: {
        accountExternalId: account.instagramId,
        providerAppId: account.providerAppId ?? "default",
        derivedCapacityUnits: account.derivedCapacityUnits,
        derivedCapacityAt: account.derivedCapacityAt,
      },
    };

    const outcome = await advanceRun(
      run.runId,
      cause,
      plan.steps,
      (step, context) => executeStep(step, context, target),
      account.platform
    );

    handled.push({ campaignId: campaign.id, ran: outcome.advanced, reason: outcome.reason });
  }

  return { handled, unplanned };
}

/**
 * Advance every run whose deadline has passed.
 *
 * The read-receipt grace period and the delayed follow-up were two mechanisms
 * with two job types. Here they are one query on one cron, because a run that
 * parked with a deadline has to be come back for either way, and a queue delay
 * caps out at 24 hours.
 */
export async function advanceDueRuns(limit = 50): Promise<number> {
  const due = await prisma.responseRun.findMany({
    where: { awaitUntil: { not: null, lte: new Date() }, status: "PENDING" },
    orderBy: { awaitUntil: "asc" },
    take: limit,
    select: {
      id: true,
      triggerKey: true,
      triggerText: true,
      counterpartyId: true,
      counterpartyName: true,
      campaignId: true,
      matchedKeyword: true,
      campaign: { select: CAMPAIGN_SELECT },
    },
  });

  let advanced = 0;

  for (const run of due) {
    const account = run.campaign.connectedAccount;
    const { handled } = await dispatchTrigger(
      {
        platform: account.platform,
        accountExternalId: account.instagramId,
        triggerKey: run.triggerKey,
        text: run.triggerText ?? "",
        counterpartyId: run.counterpartyId,
        counterpartyName: run.counterpartyName,
        postId: null,
        matchedKeyword: run.matchedKeyword,
      },
      [run.campaignId],
      { kind: "timeout" }
    );
    if (handled.some((h) => h.ran)) advanced += 1;
  }

  return advanced;
}
