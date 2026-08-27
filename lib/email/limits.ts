/**
 * How much sending headroom this account has left.
 *
 * Cloudflare does not publish Email Sending's daily quota. Its own words: "New
 * accounts start with a conservative daily quota and scale up over time." That
 * ceiling sits on the login path, so an instance can be one busy day away from
 * nobody being able to sign in, with no warning anywhere.
 *
 * Best effort by contract. A quota reading is a nice-to-have and the account
 * that cannot read it still sends fine, so a failure here returns null rather
 * than taking down whatever asked.
 */

import { z } from "zod";

const RESPONSE = z.object({
  success: z.boolean(),
  result: z.object({
    daily_limit: z.number().positive(),
    daily_used: z.number().nonnegative().default(0),
  }),
});

export interface SendingLimits {
  readonly dailyLimit: number;
  readonly used: number;
  /** 0 to 1. Above 0.8 is worth acting on before it becomes a lockout. */
  readonly pressure: number;
}

export async function readSendingLimits(): Promise<SendingLimits | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) return null;

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/limits`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const parsed = RESPONSE.safeParse(await response.json());
    if (!response.ok || !parsed.success || !parsed.data.success) return null;

    const { daily_limit: dailyLimit, daily_used: used } = parsed.data.result;
    return { dailyLimit, used, pressure: Math.min(1, used / dailyLimit) };
  } catch {
    return null;
  }
}
