import {
  enqueue,
  COMMENT_JOB_NAME,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
  FOLLOWUP_JOB_NAME,
  type DmQueueJob,
  type ProcessCommentJob,
  type ProcessMessageJob,
  type ProcessPostbackJob,
  type ProcessFollowUpJob,
} from "./client";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import { adapterFor } from "@/lib/platforms/registry";
import { supports, type MessagingCapability } from "@/lib/platforms/types";
import { platformName } from "@/lib/campaigns/options";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import { reserve } from "@/lib/runtime/quota";
import { responseBuckets } from "@/lib/runtime/send-quota";
import { dispatchTrigger } from "@/lib/runtime/dispatch";
import {
  acquireClaims,
  classifyAttempt,
  releaseIfUnattempted,
  settleClaims,
} from "@/lib/runtime/claims";
import { rememberContact } from "@/lib/runtime/contacts";
import { classifyFailure, raiseIncident, resolveIncident } from "@/lib/ops/incidents";
import type { SendResult } from "@/lib/platforms/types";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import {
  buildTrackedUrl,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";

/**
 * What BullMQ's `Job` gave us, reduced to the three fields this file actually
 * read. Keeping the shape means the send logic below is unchanged by the move
 * off BullMQ; only its supplier changed.
 */
export interface JobLike<T> {
  name: string;
  data: T;
  attemptsMade: number;
  id?: string;
}

function formatError(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `Meta API Error ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

// Meta rejections that a plain-text retry cannot fix: the send was refused for
// the conversation, not for the button template. Retrying as text just burns
// the attempt and — worse — overwrites the real error with a misleading one
// ("invalid for a private reply", because the first attempt already used up the
// comment's single allowed private reply).
const NON_TEMPLATE_REJECTIONS = [
  /outside of allowed window/i,
  /invalid for a private reply/i,
  /requested user cannot be found/i,
];

function isTemplateRejection(error: unknown): boolean {
  if (error instanceof TokenExpiredError || error instanceof RateLimitError) {
    return false;
  }
  const message = error instanceof Error ? error.message : "";
  return !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(message));
}

type WorkerTrackedLink = {
  slug: string;
  label: string | null;
  destinationUrl: string;
};

/**
 * Build the tappable link buttons for a DM. The first link uses the campaign's
 * `linkButtonLabel`; each additional link uses its own stored `label`. Capped at
 * Meta's 3-button limit for a button template.
 */
function buildLinkButtons(
  trackedLinks: WorkerTrackedLink[],
  primaryLabel: string | null
): { title: string; url: string }[] {
  return trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug),
    title: (index === 0 ? primaryLabel : link.label) || link.label || "Open link",
  }));
}

/**
 * Fallback text when Meta rejects the button template: render the primary link
 * inline, then append any extra tracked URLs on their own lines so no link is
 * lost.
 */
function buildInlineLinkFallback(
  message: string,
  commenterName: string | null | undefined,
  trackedLinks: WorkerTrackedLink[],
  bodyText: string
): string {
  const base =
    renderMessageWithTracking({ message, commenterName, trackedLinks }) ||
    bodyText;
  const extraUrls = trackedLinks.slice(1).map((link) => buildTrackedUrl(link.slug));
  return extraUrls.length > 0 ? `${base}\n${extraUrls.join("\n")}` : base;
}

type RevealAutomation = {
  dmMessage: string;
  linkButtonLabel: string | null;
  trackedLinks: WorkerTrackedLink[];
  connectedAccount: { instagramId: string };
};

/**
 * Deliver a campaign's reveal message as a direct message. Shared by the
 * button-tap (postback) path and the DM keyword-trigger path — both already
 * have an open conversation with the user, so neither uses a private reply.
 */
async function sendRevealDirectMessage(
  messaging: MessagingCapability,
  accessToken: string,
  automation: RevealAutomation,
  userId: string,
  commenterName: string | null,
  context: string
): Promise<void> {
  if (automation.trackedLinks.length === 0) {
    await messaging.sendDirectMessage(
      accessToken,
      automation.connectedAccount.instagramId,
      userId,
      renderMessageWithTracking({
        message: automation.dmMessage,
        commenterName,
        trackedLinks: automation.trackedLinks,
      })
    );
    return;
  }

  // Try button template first; if Meta rejects it, fall back to inline links.
  const bodyText =
    renderMessageWithoutLink({
      message: automation.dmMessage,
      commenterName,
    }) || "Here's your link:";
  const buttons = buildLinkButtons(
    automation.trackedLinks,
    automation.linkButtonLabel
  );

  try {
    await messaging.sendDirectMessageWithButtons(
      accessToken,
      automation.connectedAccount.instagramId,
      userId,
      bodyText,
      buttons
    );
  } catch (buttonError) {
    // A closed messaging window rejects the text retry too, so don't let it
    // overwrite the original error with a misleading one.
    if (!isTemplateRejection(buttonError)) throw buttonError;

    console.log(
      `[DM Worker] Button template rejected in ${context}, falling back to inline link:`,
      formatError(buttonError)
    );
    try {
      await messaging.sendDirectMessage(
        accessToken,
        automation.connectedAccount.instagramId,
        userId,
        buildInlineLinkFallback(
          automation.dmMessage,
          commenterName,
          automation.trackedLinks,
          bodyText
        )
      );
    } catch {
      throw buttonError;
    }
  }
}

async function processComment(job: JobLike<ProcessCommentJob>): Promise<void> {
  const {
    instagramAccountId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;
  // Jobs enqueued before Facebook support existed carry no platform.
  const platform = job.data.platform ?? "INSTAGRAM";
  const adapter = adapterFor(platform);
  // Null on YouTube and TikTok. Not a reason to drop the job: the public reply
  // is the entire response there, so only the DM leg below is gated on it.
  const messaging = adapter.messaging;

  const automations = await prisma.campaign.findMany({
    where: {
      // Match campaigns bound to this specific post, plus any-post campaigns.
      OR: [{ postId: mediaId }, { matchAnyPost: true }],
      isActive: true,
      connectedAccount: {
        platform,
        instagramId: instagramAccountId,
      },
    },
    include: {
      connectedAccount: true,
      workspace: true,
      trackedLinks: {
        select: {
          slug: true,
          label: true,
          destinationUrl: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Campaigns compiled into a step plan run on the engine, where four job types
  // are one operation. The rest fall through to the path below until they are
  // next saved, which is what `compiledPlan` being nullable is for.
  const matched = automations.filter((automation) =>
    automation.matchAnyWord
      ? true
      : matchKeywords(commentText, automation.keywords, automation.wholeWordMatch).matched
  );
  const { unplanned } = await dispatchTrigger(
    {
      platform,
      accountExternalId: instagramAccountId,
      triggerKey: commentId,
      text: commentText,
      counterpartyId: commenterId,
      counterpartyName: commenterName ?? null,
      postId: mediaId,
      matchedKeyword: null,
    },
    matched.map((a) => a.id)
  );
  const legacy = new Set(unplanned);

  for (const automation of automations) {
    if (!legacy.has(automation.id) && matched.some((m) => m.id === automation.id)) continue;

    // "Any word" campaigns fire on every comment; otherwise require a keyword hit.
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) {
      continue;
    }

    const existingLog = await prisma.responseRun.findUnique({
      where: {
        campaignId_triggerKey: {
          campaignId: automation.id,
          triggerKey: commentId,
        },
      },
    });

    const alreadyDmd = existingLog?.status === "SENT";
    const alreadyPublicReplied = Boolean(existingLog?.publicReplySentAt);
    const needsDm = !alreadyDmd;

    // Skip only when there is genuinely nothing left to do. A comment whose DM
    // already sent but whose public reply never posted (e.g. it hit a rate
    // limit) must still come back so the public reply can be retried.
    if (existingLog?.status === "SKIPPED_PLAN_LIMIT") continue;
    if (alreadyDmd && (alreadyPublicReplied || !automation.publicReplyEnabled)) {
      continue;
    }

    if (!automation.connectedAccount.accessToken) {
      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          campaignId: automation.id,
          connectedAccountId: automation.connectedAccountId,
          counterpartyId: commenterId,
          counterpartyName: commenterName,
          triggerText: commentText,
          triggerKey: commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "No access token available for this account",
        },
        update: {
          status: "FAILED",
          errorMessage: "No access token available for this account",
        },
      });
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(automation.connectedAccount.accessToken);
    } catch {
      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          campaignId: automation.id,
          connectedAccountId: automation.connectedAccountId,
          counterpartyId: commenterId,
          counterpartyName: commenterName,
          triggerText: commentText,
          triggerKey: commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "Failed to decrypt the stored access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt the stored access token",
        },
      });
      continue;
    }

    // Ensure a log row exists before the public reply leg (which updates it).
    // Only (re)set PENDING when the DM will actually be attempted, so a prior
    // SENT is never clobbered while we come back just to retry the public reply.
    if (!existingLog) {
      await prisma.responseRun.create({
        data: {
          workspaceId: automation.workspaceId,
          campaignId: automation.id,
          connectedAccountId: automation.connectedAccountId,
          counterpartyId: commenterId,
          counterpartyName: commenterName,
          triggerText: commentText,
          triggerKey: commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "PENDING",
          attempts: job.attemptsMade + 1,
        },
      });
    } else if (needsDm) {
      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: { campaignId: automation.id, triggerKey: commentId },
        },
        data: {
          status: "PENDING",
          attempts: job.attemptsMade + 1,
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: null,
        },
      });
    }

    // Public reply leg — decoupled from the DM and posted first so a DM failure
    // (e.g. a non-follower whose messaging is restricted) never suppresses it.
    // Idempotent across retries via publicReplySentAt.
    const replyPool =
      automation.publicReplyMessages.length > 0
        ? automation.publicReplyMessages
        : automation.publicReplyMessage
          ? [automation.publicReplyMessage]
          : [];
    let publicReplyLanded = Boolean(existingLog?.publicReplySentAt);
    let publicReplyFailure: string | null = null;
    if (
      automation.publicReplyEnabled &&
      replyPool.length > 0 &&
      !existingLog?.publicReplySentAt
    ) {
      try {
        const chosen = replyPool[Math.floor(Math.random() * replyPool.length)];
        const publicReply = renderMessageWithTracking({
          message: chosen,
          commenterName,
          trackedLinks: automation.trackedLinks,
        });

        // The public reply used to spend nothing. On YouTube it costs 50 units
        // against a pool of 10,000 a day shared by every creator, so an
        // unmetered reply path can drain the whole product's budget while the
        // scheduler still believes it has room to poll.
        const { buckets, cost } = responseBuckets(platform, "publicReply", {
          accountExternalId: instagramAccountId,
          providerAppId: automation.connectedAccount.providerAppId ?? "default",
          derivedCapacityUnits: automation.connectedAccount.derivedCapacityUnits,
          derivedCapacityAt: automation.connectedAccount.derivedCapacityAt,
        });
        const budget = await reserve(buckets, cost);
        if (!budget.ok) {
          throw new Error(
            `Out of ${budget.refusal.bucket} budget for a public reply, ${budget.refusal.remaining} left`
          );
        }

        try {
          await adapter.postPublicReply(
            accessToken,
            instagramAccountId,
            commentId,
            publicReply
          );
        } catch (error) {
          await budget.lease.settle("release");
          throw error;
        }
        await budget.lease.settle("commit");
        await prisma.responseRun.update({
          where: {
            campaignId_triggerKey: { campaignId: automation.id, triggerKey: commentId },
          },
          data: { publicReplySentAt: new Date(), publicReplyError: null },
        });
        publicReplyLanded = true;
      } catch (error) {
        publicReplyFailure = formatError(error);
        console.error(
          "[DM Worker] Public comment reply failed:",
          formatError(error)
        );
        await prisma.responseRun
          .update({
            where: {
              campaignId_triggerKey: { campaignId: automation.id, triggerKey: commentId },
            },
            data: { publicReplyError: formatError(error) },
          })
          .catch(() => {});
      }
    }

    // On a platform with no messaging API the public reply is the entire
    // response, so the run settles here. Falling through would strand it at
    // PENDING forever, and the fleet view reads status to decide what is broken.
    if (!messaging) {
      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: { campaignId: automation.id, triggerKey: commentId },
        },
        data: publicReplyLanded
          ? { status: "SENT", errorMessage: null }
          : {
              status: "FAILED",
              errorMessage:
                publicReplyFailure ??
                `${platformName(platform)} can only reply publicly, and this campaign has no public reply configured`,
            },
      });
      continue;
    }

    // DM already sent on an earlier pass; the public reply retry above was all
    // this run needed. Don't re-send the DM.
    if (!needsDm) continue;

    // Meta allows exactly ONE private reply per comment, ever — across every
    // campaign. When several campaigns match the same comment (duplicated
    // campaigns, or an any-post campaign overlapping a post-specific one), only
    // the first can deliver; the rest would fail with "The comment is invalid
    // for a private reply". Skip them explicitly instead of burning an API call
    // and logging a failure the user can do nothing about. The public reply
    // above still goes out per campaign — only the DM leg is deduped.
    // Instagram allows exactly one private reply per comment, ever, across every
    // campaign. The claim is taken BEFORE the send, so a redelivered webhook and
    // a polling sweep racing for the same comment cannot both get through.
    const claims = messaging.claimsForPrivateReply(commentId);
    const runKey = `${automation.id}:${commentId}`;
    const claim = await acquireClaims(claims, automation.id, runKey);

    if (!claim.held) {
      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: { campaignId: automation.id, triggerKey: commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: claim.holderCampaignName
            ? `Campaign "${claim.holderCampaignName}" already sent the one private reply this comment allows`
            : "Another campaign already sent the one private reply this comment allows",
        },
      });
      continue;
    }

    // The send burns the comment's one allowed private reply whether or not it
    // was ever going to land, so ask first where the platform can answer.
    const eligibility = await messaging.checkReplyEligibility?.(
      accessToken,
      commentId
    );
    if (eligibility === "ineligible") {
      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: { campaignId: automation.id, triggerKey: commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: "This comment can no longer accept a private reply",
        },
      });
      continue;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: commentId,
          },
        },
        data: {
          status: "SKIPPED_PLAN_LIMIT",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    let rateLimit;
    try {
      rateLimit = await reserveDMSlot(
        platform,
        {
          accountExternalId: instagramAccountId,
          providerAppId: automation.connectedAccount.providerAppId ?? "default",
          derivedCapacityUnits: automation.connectedAccount.derivedCapacityUnits,
          derivedCapacityAt: automation.connectedAccount.derivedCapacityAt,
        },
        requeueAttempt
      );
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      // Deduplicated by (account, kind), so a token that expired on Friday is
      // one row an admin can act on rather than a weekend of identical rows.
      await raiseIncident({
        kind: classifyFailure(error),
        connectedAccountId: automation.connectedAccountId,
        workspaceId: automation.workspaceId,
        campaignId: automation.id,
        severity: "ERROR",
        message: formatError(error),
      });

      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: commentId,
          },
        },
        data: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
      });
      throw error;
    }

    if (!rateLimit.allowed) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      if (rateLimit.shouldSkip) {
        await prisma.responseRun.update({
          where: {
            campaignId_triggerKey: {
              campaignId: automation.id,
              triggerKey: commentId,
            },
          },
          data: {
            status: "SKIPPED_RATE_LIMIT",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly DM rate limit reached for this account",
          },
        });
        continue;
      }

      if (rateLimit.shouldRequeue) {
        await prisma.responseRun.update({
          where: {
            campaignId_triggerKey: {
              campaignId: automation.id,
              triggerKey: commentId,
            },
          },
          data: {
            status: "PENDING",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly rate limit hit; retry scheduled",
          },
        });

        await enqueue(
          COMMENT_JOB_NAME,
          { ...job.data, requeueAttempt: requeueAttempt + 1 },
          `comment_${instagramAccountId}_${commentId}_retry_${requeueAttempt + 1}`,
          { delaySeconds: rateLimit.requeueDelayMs / 1000 }
        );
        continue;
      }
    }

    // With an opening DM, the private reply is a button message; tapping it
    // fires a postback that delivers the reveal (see processPostback). Without
    // one, we send the reveal text directly as today.
    const useOpeningDm =
      automation.openingDmEnabled &&
      Boolean(automation.openingDmMessage) &&
      Boolean(automation.openingDmButtonLabel);

    // Follow-gating: the link is revealed only after a follow. When an opening
    // DM is enabled it comes FIRST, and its button routes into the follow check
    // (opening DM → follow gate → link). Without an opening DM, we check follow
    // status at comment time: confirmed followers get the link now, everyone
    // else gets the "follow me first" prompt (re-verified on tap).
    //
    // A platform with no follow-status API cannot run the gate at all, so the
    // campaign delivers the link rather than prompting for something it could
    // never verify.
    const followGate =
      automation.requireFollow && supports(platform, "FOLLOW_GATE");
    let sendFollowPrompt = false;
    if (followGate && !useOpeningDm) {
      const alreadyFollows = await (messaging.checkFollowStatus?.(
        accessToken,
        automation.connectedAccount.instagramId,
        commenterId
      ) ?? null);
      sendFollowPrompt = alreadyFollows !== true;
    }

    let sendResult: SendResult | null = null;

    try {
      if (useOpeningDm) {
        const openingText = renderMessageWithTracking({
          // SAFETY: `useOpeningDm` above is false unless both openingDmMessage
          // and openingDmButtonLabel are non-empty, and this branch runs only
          // when it is true.
          message: automation.openingDmMessage as string,
          commenterName,
          trackedLinks: [],
        });
        sendResult = await messaging.sendPrivateReplyWithPostback(
          accessToken,
          automation.connectedAccount.instagramId,
          commentId,
          openingText,
          // SAFETY: guarded by `useOpeningDm`, as above.
          automation.openingDmButtonLabel as string,
          followGate
            ? `followcheck:${automation.id}`
            : `reveal:${automation.id}`
        );
      } else if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
          commenterName,
        });
        sendResult = await messaging.sendPrivateReplyWithPostback(
          accessToken,
          automation.connectedAccount.instagramId,
          commentId,
          promptText,
          automation.followPromptButtonLabel || "i'm following",
          `followcheck:${automation.id}`
        );
      } else if (automation.trackedLinks.length > 0) {
        // Try button template first; if Meta rejects it, fall back to inline links.
        const bodyText =
          renderMessageWithoutLink({
            message: automation.dmMessage,
            commenterName,
          }) || "Here's your link:";
        const buttons = buildLinkButtons(
          automation.trackedLinks,
          automation.linkButtonLabel
        );

        try {
          sendResult = await messaging.sendPrivateReplyWithButtons(
            accessToken,
            automation.connectedAccount.instagramId,
            commentId,
            bodyText,
            buttons
          );
        } catch (buttonError) {
          // Only a template rejection is worth retrying as text. Anything else
          // (closed window, comment already replied to) fails the same way and
          // would replace the real error with a misleading one.
          if (!isTemplateRejection(buttonError)) throw buttonError;

          console.log(
            "[DM Worker] Button template rejected, falling back to inline link:",
            formatError(buttonError)
          );
          const fallbackMessage = buildInlineLinkFallback(
            automation.dmMessage,
            commenterName,
            automation.trackedLinks,
            bodyText
          );
          try {
            sendResult = await messaging.sendPrivateReply(
              accessToken,
              automation.connectedAccount.instagramId,
              commentId,
              fallbackMessage
            );
          } catch {
            // The first attempt consumed the comment's single private reply, so
            // this one reports "invalid for a private reply" no matter what the
            // underlying problem was. Surface the original rejection instead.
            throw buttonError;
          }
        }
      } else {
        const dmMessage = renderMessageWithTracking({
          message: automation.dmMessage,
          commenterName,
          trackedLinks: automation.trackedLinks,
        });
        sendResult = await messaging.sendPrivateReply(
          accessToken,
          automation.connectedAccount.instagramId,
          commentId,
          dmMessage
        );
      }

      // The platform has now provably acted, so the comment's one-shot is spent
      // and the claim stops being a lease. Until this runs it lapses on its own,
      // which is what keeps a crash mid-send from forfeiting the reply forever.
      await settleClaims(claims, runKey);

      // A working send clears any standing alert for this account, so the fleet
      // view stops showing a problem that has already fixed itself.
      await resolveIncident(automation.connectedAccountId, "DELIVERY_FAILING");

      // Facebook hands back the commenter's page-scoped id only here. It is not
      // in the webhook and nothing recovers it later, so a follow-up has no way
      // to reach this person unless it is kept now.
      if (sendResult) {
        await rememberContact({
          connectedAccountId: automation.connectedAccountId,
          platform,
          platformUserId: commenterId,
          displayName: commenterName,
          result: sendResult,
        });
      }

      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: commentId,
          },
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      // Released only when the platform provably did not act. A rejected button
      // template already reached Meta, which spent the comment's one reply, so
      // an unrecognised failure keeps the claim rather than letting the next
      // campaign burn a call on a comment that can never accept one.
      await releaseIfUnattempted(claims, runKey, classifyAttempt(error));

      await prisma.responseRun.update({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: commentId,
          },
        },
        data: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
      });
      throw error;
    }
  }
}

/**
 * Deliver the reveal message after a user taps an opening DM's button.
 * The postback payload is `reveal:<automationId>`; the sender arrives under the
 * same id their comment did, which we DM directly.
 */
async function processPostback(job: JobLike<ProcessPostbackJob>): Promise<void> {
  const { instagramAccountId, userId, payload, fallback } = job.data;
  const platform = job.data.platform ?? "INSTAGRAM";
  const adapter = adapterFor(platform);
  const messaging = adapter.messaging;
  if (!messaging) return;

  const isFollowCheck = payload.startsWith("followcheck:");
  if (!isFollowCheck && !payload.startsWith("reveal:")) return;
  const automationId = payload.slice(
    isFollowCheck ? "followcheck:".length : "reveal:".length
  );

  const automation = await prisma.campaign.findFirst({
    where: { id: automationId, isActive: true },
    include: {
      connectedAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (
    !automation ||
    automation.connectedAccount.instagramId !== instagramAccountId ||
    !automation.connectedAccount.accessToken
  ) {
    return;
  }

  // Duplicate sends are enabled: every button tap re-sends the reveal
  // instead of only firing once per person.
  const dedupeId = `reveal:${userId}`;

  if (fallback) {
    const existingReveal = await prisma.responseRun.findUnique({
      where: {
        campaignId_triggerKey: {
          campaignId: automation.id,
          triggerKey: dedupeId,
        },
      },
    });
    if (existingReveal?.status === "SENT") return;
  }

  // Personalize {username} from the opening DM log for this user, if present.
  const openingLog = await prisma.responseRun.findFirst({
    where: { campaignId: automation.id, counterpartyId: userId },
    select: { counterpartyName: true },
  });
  const commenterName = openingLog?.counterpartyName ?? null;

  let accessToken: string;
  try {
    accessToken = decryptToken(automation.connectedAccount.accessToken);
  } catch {
    return;
  }

  // Follow-gate: before revealing the link, verify the user follows. On a
  // `followcheck:` tap a non-follower gets the prompt again (no quota spent);
  // on a read fallback a non-follower is silently skipped — the gate must not
  // be bypassable by just reading the DM and waiting. Following, or
  // unverifiable (null), falls through and delivers the link — fail-open so a
  // real follower is never trapped.
  if (
    (isFollowCheck || fallback) &&
    automation.requireFollow &&
    supports(platform, "FOLLOW_GATE")
  ) {
    const follows = await (messaging.checkFollowStatus?.(
      accessToken,
      automation.connectedAccount.instagramId,
      userId
    ) ?? null);
    if (follows === false) {
      if (fallback) return;
      const promptText = renderMessageWithoutLink({
        message:
          automation.followPromptMessage ||
          "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
        commenterName,
      });
      try {
        await messaging.sendDirectMessageWithPostback(
          accessToken,
          automation.connectedAccount.instagramId,
          userId,
          promptText,
          automation.followPromptButtonLabel || "i'm following",
          `followcheck:${automation.id}`
        );
      } catch (error) {
        console.log(
          "[DM Worker] Failed to re-send follow prompt:",
          formatError(error)
        );
      }
      return;
    }
  }

  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.responseRun.upsert({
      where: {
        campaignId_triggerKey: { campaignId: automation.id, triggerKey: dedupeId },
      },
      create: {
        workspaceId: automation.workspaceId,
        campaignId: automation.id,
        connectedAccountId: automation.connectedAccountId,
        counterpartyId: userId,
        counterpartyName: commenterName,
        triggerText: "(button tap)",
        triggerKey: dedupeId,
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
      update: { status: "SKIPPED_PLAN_LIMIT" },
    });
    return;
  }

  try {
    await sendRevealDirectMessage(
      messaging,
      accessToken,
      automation,
      userId,
      commenterName,
      "postback"
    );
    // Optional appreciation follow-up: once the link has been delivered, send a
    // short thank-you. It is scheduled as its own delayed job so it can go out
    // some minutes later (followUpDelayMinutes) rather than immediately. The
    // deterministic job id dedupes repeat button taps to one follow-up per user.
    if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
      const delayMs =
        Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000;
      await enqueue(
        FOLLOWUP_JOB_NAME,
        {
          platform,
          instagramAccountId: automation.connectedAccount.instagramId,
          userId,
          automationId: automation.id,
          commenterName,
        },
        `followup_${automation.id}_${userId}`,
        { delaySeconds: delayMs / 1000 }
      );
    }
    await prisma.responseRun.upsert({
      where: {
        campaignId_triggerKey: { campaignId: automation.id, triggerKey: dedupeId },
      },
      create: {
        workspaceId: automation.workspaceId,
        campaignId: automation.id,
        connectedAccountId: automation.connectedAccountId,
        counterpartyId: userId,
        counterpartyName: commenterName,
        triggerText: "(button tap)",
        triggerKey: dedupeId,
        status: "SENT",
        dmSentAt: new Date(),
      },
      update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });
  } catch (error) {
    await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);

    // The read fallback is speculative: it only runs when the user read the
    // opening DM and never tapped the button, which means they never messaged
    // us, which means the reply window is closed and Meta rejects the send
    // ("outside of allowed window"). That is the expected outcome here, not a
    // failure the user can act on — so don't log it as FAILED and don't retry
    // it against a window that cannot reopen on its own. It still delivers in
    // the case that does work: the user replied by typing instead of tapping.
    if (fallback) {
      console.log(
        "[DM Worker] Read fallback not delivered (messaging window closed):",
        formatError(error)
      );
      return;
    }

    await prisma.responseRun.upsert({
      where: {
        campaignId_triggerKey: { campaignId: automation.id, triggerKey: dedupeId },
      },
      create: {
        workspaceId: automation.workspaceId,
        campaignId: automation.id,
        connectedAccountId: automation.connectedAccountId,
        counterpartyId: userId,
        counterpartyName: commenterName,
        triggerText: "(button tap)",
        triggerKey: dedupeId,
        status: "FAILED",
        errorMessage: formatError(error),
      },
      update: { status: "FAILED", errorMessage: formatError(error) },
    });
    throw error;
  }
}

/**
 * Send the scheduled appreciation follow-up. Runs after its delay elapses.
 * Best-effort: if the message can't be delivered (e.g. the messaging window
 * closed because the delay was long), it is logged, not retried forever.
 */
async function processFollowUp(job: JobLike<ProcessFollowUpJob>): Promise<void> {
  const { instagramAccountId, userId, automationId, commenterName } = job.data;
  const platform = job.data.platform ?? "INSTAGRAM";
  const adapter = adapterFor(platform);
  const messaging = adapter.messaging;
  if (!messaging) return;

  const automation = await prisma.campaign.findFirst({
    where: { id: automationId, isActive: true },
    include: { connectedAccount: true },
  });

  if (
    !automation ||
    !automation.followUpEnabled ||
    !automation.followUpMessage?.trim() ||
    automation.connectedAccount.instagramId !== instagramAccountId ||
    !automation.connectedAccount.accessToken
  ) {
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(automation.connectedAccount.accessToken);
  } catch {
    return;
  }

  try {
    await messaging.sendDirectMessage(
      accessToken,
      automation.connectedAccount.instagramId,
      userId,
      renderMessageWithoutLink({
        message: automation.followUpMessage,
        commenterName: commenterName ?? null,
      })
    );
  } catch (error) {
    console.log(
      "[DM Worker] Failed to send follow-up message:",
      formatError(error)
    );
  }
}

/**
 * Reply to an inbound DM whose text matches a campaign's keywords.
 *
 * The user has messaged us, so the conversation is already open: this path
 * skips the opening DM (which exists to work around private-reply limits from
 * comments) and delivers the reveal directly, honouring the follow gate.
 * Dedup is per inbound message id, so each message triggers at most one reply.
 */
async function processMessage(job: JobLike<ProcessMessageJob>): Promise<void> {
  const { instagramAccountId, messageId, messageText, senderId } = job.data;
  const platform = job.data.platform ?? "INSTAGRAM";
  const adapter = adapterFor(platform);
  const messaging = adapter.messaging;
  if (!messaging) return;

  const automations = await prisma.campaign.findMany({
    where: {
      dmTriggerEnabled: true,
      isActive: true,
      connectedAccount: { platform, instagramId: instagramAccountId },
    },
    include: {
      connectedAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const dedupeId = `dm:${messageId}`;

  for (const automation of automations) {
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          messageText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) continue;

    const existingLog = await prisma.responseRun.findUnique({
      where: {
        campaignId_triggerKey: {
          campaignId: automation.id,
          triggerKey: dedupeId,
        },
      },
    });

    // Already replied to this message (or deliberately skipped it) — a retry
    // of the job must not send a second DM.
    if (
      existingLog?.status === "SENT" ||
      existingLog?.status === "SKIPPED_PLAN_LIMIT"
    ) {
      continue;
    }

    const logBase = {
      workspaceId: automation.workspaceId,
      campaignId: automation.id,
      connectedAccountId: automation.connectedAccountId,
      counterpartyId: senderId,
      triggerText: messageText,
      triggerKey: dedupeId,
      matchedKeyword: matchResult.matchedKeyword,
    };

    if (!automation.connectedAccount.accessToken) {
      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "No access token available for this account",
        },
        update: {
          status: "FAILED",
          errorMessage: "No access token available for this account",
        },
      });
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(automation.connectedAccount.accessToken);
    } catch {
      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "Failed to decrypt the stored access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt the stored access token",
        },
      });
      continue;
    }

    // Reuse a name captured on an earlier interaction so {username} still
    // renders. The messages webhook carries only the sender's id.
    const priorLog = await prisma.responseRun.findFirst({
      where: { campaignId: automation.id, counterpartyId: senderId },
      select: { counterpartyName: true },
    });
    const commenterName = priorLog?.counterpartyName ?? null;

    // Follow gate: anyone not confirmed as a follower gets the prompt instead of
    // the link, with the same `followcheck:` button that re-verifies on tap.
    // `null` (unverifiable) prompts too — this is first contact, exactly like a
    // comment, so it follows processComment's fail-closed rule rather than the
    // postback path's fail-open one. Fail-open is only safe after a tap, where
    // the user has already claimed to follow; here it would hand the link to
    // anyone whose status the API happens not to resolve. A platform with no
    // follow-status API has no gate to run, so the link goes out.
    let sendFollowPrompt = false;
    if (automation.requireFollow && supports(platform, "FOLLOW_GATE")) {
      const follows = await (messaging.checkFollowStatus?.(
        accessToken,
        automation.connectedAccount.instagramId,
        senderId
      ) ?? null);
      sendFollowPrompt = follows !== true;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
        update: {
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    try {
      if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "Almost there! Follow me and tap the button below to grab your link 💛",
          commenterName,
        });
        await messaging.sendDirectMessageWithPostback(
          accessToken,
          automation.connectedAccount.instagramId,
          senderId,
          promptText,
          automation.followPromptButtonLabel || "I'm following ✅",
          `followcheck:${automation.id}`
        );
      } else {
        await sendRevealDirectMessage(
          messaging,
          accessToken,
          automation,
          senderId,
          commenterName,
          "message trigger"
        );

        // The link has been delivered, so the appreciation follow-up applies
        // here exactly as it does after a button tap. Not scheduled behind the
        // follow prompt — no link went out yet in that branch.
        if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
          await enqueue(
            FOLLOWUP_JOB_NAME,
            {
              platform,
              instagramAccountId: automation.connectedAccount.instagramId,
              userId: senderId,
              automationId: automation.id,
              commenterName,
            },
            `followup_${automation.id}_${senderId}`,
            { delaySeconds: Math.max(0, automation.followUpDelayMinutes ?? 0) * 60 }
          );
        }
      }

      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: dedupeId,
          },
        },
        create: {
          ...logBase,
          counterpartyName: commenterName,
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.responseRun.upsert({
        where: {
          campaignId_triggerKey: {
            campaignId: automation.id,
            triggerKey: dedupeId,
          },
        },
        create: {
          ...logBase,
          counterpartyName: commenterName,
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
        update: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
      });
      throw error;
    }
  }
}

export async function processJob(job: JobLike<DmQueueJob>): Promise<void> {
  // `name` is the discriminant, and the enqueue sites are the only producers,
  // so each branch narrows to the payload its own name was enqueued with.
  if (job.name === POSTBACK_JOB_NAME) {
    // SAFETY: name checked on the line above.
    return processPostback(job as JobLike<ProcessPostbackJob>);
  }
  if (job.name === FOLLOWUP_JOB_NAME) {
    // SAFETY: name checked on the line above.
    return processFollowUp(job as JobLike<ProcessFollowUpJob>);
  }
  if (job.name === MESSAGE_JOB_NAME) {
    // SAFETY: name checked on the line above.
    return processMessage(job as JobLike<ProcessMessageJob>);
  }
  // SAFETY: the three named jobs are excluded above, leaving only a comment job.
  return processComment(job as JobLike<ProcessCommentJob>);
}

export async function recordWorkerFailure(
  job: JobLike<DmQueueJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
    const commentId =
      job && "commentId" in job.data ? job.data.commentId : null;
    const account = instagramAccountId
      ? await prisma.connectedAccount.findUnique({
          where: {
            platform_instagramId: {
              platform: job?.data.platform ?? "INSTAGRAM",
              instagramId: instagramAccountId,
            },
          },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId: instagramAccountId ?? null,
          commentId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId,
      commentId: commentId ?? undefined,
    });
  } catch (recordError) {
    console.error(
      "[DM Worker] Failed to record worker failure:",
      formatError(recordError)
    );
  }
}


