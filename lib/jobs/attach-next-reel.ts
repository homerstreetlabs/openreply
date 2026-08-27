import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

function isReel(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS";
}

/**
 * Binds "next reel" campaigns to a real post.
 *
 * Instagram sends no webhook when a new media is published, so we poll: for
 * every campaign awaiting the creator's next reel, find the earliest reel that
 * was posted after the campaign was created and attach the campaign to it.
 * Runs on a schedule (see wrangler.engine.jsonc triggers) — the campaign goes
 * live within one cron interval of the reel being posted.
 */
export async function attachNextReel() {
  const pending = await prisma.campaign.findMany({
    where: {
      pendingNextReel: true,
      // getUserMedia reads graph.instagram.com/me/media. Facebook Reels are
      // listed from a different edge entirely, so a Page row does not belong
      // in this sweep.
      connectedAccount: { platform: "INSTAGRAM" },
    },
    include: { connectedAccount: true },
  });

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    { account: (typeof pending)[number]["connectedAccount"]; automations: typeof pending }
  >();
  for (const automation of pending) {
    const key = automation.connectedAccountId;
    const entry = byAccount.get(key);
    if (entry) entry.automations.push(automation);
    else byAccount.set(key, { account: automation.connectedAccount, automations: [automation] });
  }

  let bound = 0;
  let checked = 0;
  const failures: string[] = [];

  for (const { account, automations } of byAccount.values()) {
    checked += automations.length;
    if (!account?.accessToken) continue;

    let reels: InstagramMedia[];
    try {
      const token = decryptToken(account.accessToken);
      const media = await getUserMedia(token, 25);
      reels = media
        .filter(isReel)
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    } catch (err) {
      failures.push(account.id);
      console.error("[attach-next-reel] media fetch failed", account.id, err);
      continue;
    }

    for (const automation of automations) {
      // The "next" reel = the earliest one posted after the campaign was created.
      const nextReel = reels.find(
        (reel) => new Date(reel.timestamp) > automation.createdAt
      );
      if (!nextReel) continue;

      await prisma.campaign.update({
        where: { id: automation.id },
        data: {
          postId: nextReel.id,
          postUrl: nextReel.permalink ?? null,
          pendingNextReel: false,
        },
      });
      bound += 1;
    }
  }

  return { checked, bound, failedAccounts: failures.length };
}
