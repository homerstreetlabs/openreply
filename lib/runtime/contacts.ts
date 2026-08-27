/**
 * Remembering who we can message.
 *
 * Facebook hands back the commenter's page-scoped id only in the private-reply
 * response. It is not in the webhook and there is no lookup that recovers it, so
 * a reply that discards it has spent the one chance to learn how to reach that
 * person again.
 */

import { prisma } from "@/lib/db/client";
import type { Platform, Prisma } from "@/app/generated/prisma/client";
import { PRIVATE_REPLY_WINDOW_HOURS } from "@/lib/platforms/types";
import type { SendResult } from "@/lib/platforms/types";

/**
 * Record what a send just taught us about reaching this person.
 *
 * Idempotent by `(account, platformUserId)`, so a redelivered job converges on
 * the same row rather than creating a second one. Best-effort by design: losing
 * a contact costs a later follow-up, while failing the send that already
 * succeeded would cost the reply itself.
 */
export async function rememberContact(params: {
  connectedAccountId: string;
  platform: Platform;
  platformUserId: string;
  displayName?: string | null;
  result: SendResult;
}): Promise<void> {
  const address = params.result.discoveredUserId ?? null;
  const windowHours = windowFor(params.platform);
  const windowExpiresAt = windowHours
    ? new Date(Date.now() + windowHours * 3_600_000)
    : null;

  // Never overwrite a known address with null. A later send that returns nothing
  // must not erase what an earlier one discovered.
  const update: Prisma.MessagingContactUpdateInput = {
    windowExpiresAt,
    lastOutboundAt: new Date(),
  };
  if (address) update.channelAddress = address;
  if (params.displayName) update.displayName = params.displayName;

  // Best effort on purpose. The reply has already been sent by the time this
  // runs, so a failure here must not take down the path that marks it sent.
  // Losing a contact costs a later follow-up; throwing would cost the record of
  // a message the platform has already delivered.
  try {
    await prisma.messagingContact.upsert({
      where: {
        connectedAccountId_platformUserId: {
          connectedAccountId: params.connectedAccountId,
          platformUserId: params.platformUserId,
        },
      },
      create: {
        connectedAccountId: params.connectedAccountId,
        platformUserId: params.platformUserId,
        channelAddress: address,
        displayName: params.displayName ?? null,
        windowExpiresAt,
        lastOutboundAt: new Date(),
      },
      update,
    });
  } catch {
    return;
  }
}

function windowFor(platform: Platform): number | null {
  const windows: Partial<Record<Platform, number>> = PRIVATE_REPLY_WINDOW_HOURS;
  return windows[platform] ?? null;
}
