/**
 * A sign-in link for an app reviewer who cannot read the mailbox.
 *
 * Meta and Google reviewers have to sign in to see the product, and this app
 * authenticates with a magic link only. A reviewer can be invited like anyone
 * else, but the link lands in a mailbox they do not hold, so the invitation
 * alone leaves them at the login form. This mints the same magic link the
 * mailbox would have carried and hands it back instead of sending it.
 *
 * It is a credential, so it is built to be turned off rather than trusted:
 *
 *   - No `REVIEWER_ACCESS_KEY` means the route does not exist. Unsetting the
 *     secret is the revocation, and there is nothing to disable separately.
 *   - The address must already resolve to a user. This mints a token for an
 *     account an operator created deliberately; it cannot conjure one, which is
 *     what closing registration was for.
 *   - `admit()` still runs, because the link goes through Auth.js's own
 *     callback rather than around it. Suspending the reviewer locks the link
 *     out even while the secret still exists.
 *   - The minted token lives for `TOKEN_TTL_MS`, so a callback URL captured
 *     from a log or a referrer dies quickly. The secret is the durable half.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";

/**
 * Short, because the reviewer redeems it in the same redirect that mints it.
 * The lifetime that matters to an operator is the secret's, not this.
 */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Copied rather than imported from `lib/auth.ts`, which exports the same value
 * as `EMAIL_PROVIDER_ID`. Importing it drags NextAuth's runtime in, and this
 * module is unit tested without it. Change one and change the other, or the
 * minted link 404s at a callback path that no longer exists.
 */
const EMAIL_PROVIDER_ID = "nodemailer";

export type ReviewerLinkRefusal = "not_configured" | "bad_key" | "no_such_user";

export type ReviewerLink =
  | { readonly kind: "ok"; readonly url: string }
  | { readonly kind: "refused"; readonly reason: ReviewerLinkRefusal };

/**
 * Constant-time comparison that does not leak the secret's length.
 *
 * `timingSafeEqual` throws on a length mismatch, which is itself a signal, so
 * both sides are hashed to a fixed width first.
 */
function keyMatches(supplied: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest()
  );
}

/** Returns the URL rather than redirecting, so the caller chooses the refusal. */
export async function mintReviewerLink(suppliedKey: string | null): Promise<ReviewerLink> {
  const expectedKey = process.env.REVIEWER_ACCESS_KEY;
  const address = process.env.REVIEWER_EMAIL?.trim().toLowerCase();
  const secret = process.env.NEXTAUTH_SECRET;

  if (!expectedKey || !address || !secret) {
    return { kind: "refused", reason: "not_configured" };
  }
  if (!suppliedKey || !keyMatches(suppliedKey, expectedKey)) {
    return { kind: "refused", reason: "bad_key" };
  }

  const user = await prisma.user.findUnique({
    where: { email: address },
    select: { id: true },
  });
  if (!user) {
    return { kind: "refused", reason: "no_such_user" };
  }

  const token = randomBytes(32).toString("hex");
  await prisma.verificationToken.create({
    data: {
      identifier: address,
      // Auth.js stores the SHA-256 of `token + secret` and puts the raw token
      // in the URL, so a database leak does not yield a usable link. Mirrored
      // from `@auth/core/lib/actions/signin/send-token.js`, which is what
      // validates this row. The two must agree or every link is rejected.
      token: createHash("sha256").update(`${token}${secret}`).digest("hex"),
      expires: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });

  const params = new URLSearchParams({ callbackUrl: "/dashboard", token, email: address });
  return {
    kind: "ok",
    url: `${getBaseUrl()}/api/auth/callback/${EMAIL_PROVIDER_ID}?${params}`,
  };
}
