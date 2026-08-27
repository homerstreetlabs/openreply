#!/usr/bin/env node
/**
 * Backfill DeliveryClaim from send history.
 *
 * The design calls this the one step where getting the order wrong is
 * user-visible. Meta allows exactly one private reply per comment. Every run
 * that already sent one spent that allowance, but the claims ledger only starts
 * recording from the moment it shipped. Without this, a second campaign
 * matching an already-answered comment finds no claim, believes the reply is
 * unspent, and burns a call Meta refuses.
 *
 * Safe to run repeatedly and safe to run before cutover: it only inserts rows
 * describing sends that already happened.
 *
 *   node scripts/backfill-delivery-claims.mjs [--dry-run]
 */

import "dotenv/config";
import pg from "pg";

const dryRun = process.argv.includes("--dry-run");

/**
 * `reveal:` and `dm:` keys are not comments. A reveal is a button tap on a
 * conversation we already had, and a `dm:` key is an inbound message. Neither
 * consumed a comment's one private reply, so claiming them would permanently
 * block a real comment that shares the id space.
 */
const SELECT_ELIGIBLE = `
  SELECT d.id, d."commentId", d."dmSentAt", a.platform
  FROM "DmLog" d
  JOIN "Automation" c ON c.id = d."automationId"
  JOIN "InstagramAccount" a ON a.id = d."instagramAccountId"
  WHERE d.status = 'SENT'
    AND d."commentId" NOT LIKE 'reveal:%'
    AND d."commentId" NOT LIKE 'dm:%'
`;

const SCOPES = { INSTAGRAM: "ig:private_reply", FACEBOOK: "fb:private_reply" };

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(SELECT_ELIGIBLE);
    console.log(`Eligible sends: ${rows.length}`);

    // YouTube and TikTok have no private reply, so they never emit a claim and
    // must not get a backfilled one.
    const claimable = rows.filter((row) => SCOPES[row.platform]);
    const skipped = rows.length - claimable.length;
    if (skipped > 0) console.log(`Skipped ${skipped} on platforms with no private reply`);

    if (dryRun) {
      console.log(`Dry run: would insert up to ${claimable.length} claims`);
      return;
    }

    let inserted = 0;
    for (const row of claimable) {
      // ON CONFLICT DO NOTHING is what makes this rerunnable, and it is also the
      // correct semantics: a claim that already exists is the newer authority.
      const result = await client.query(
        `INSERT INTO "DeliveryClaim" (id, scope, key, "automationId", "runKey", "createdAt")
         SELECT $1, $2, $3, d."automationId", $4, $5
         FROM "DmLog" d WHERE d.id = $6
         ON CONFLICT DO NOTHING`,
        [
          `bf_${row.id}`,
          SCOPES[row.platform],
          row.commentId,
          `backfill:${row.id}`,
          row.dmSentAt ?? new Date(),
          row.id,
        ]
      );
      inserted += result.rowCount ?? 0;
    }

    console.log(`Inserted ${inserted} claims, ${claimable.length - inserted} already present`);
  } finally {
    await client.end();
  }
}

await main();
