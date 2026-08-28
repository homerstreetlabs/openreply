import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Meta App Review Support - OpenReply",
  description:
    "Meta App Review notes for OpenReply's private reply workflow on Instagram professional accounts and Facebook Pages.",
};

export default function MetaReviewPage() {
  return (
    <LegalShell
      title="Meta App Review Support"
      description="OpenReply is used by businesses that want to send a private reply when someone comments a keyword on their own Instagram post or reel, or on their own Facebook Page post or Reel."
      updatedAt="August 28, 2026"
    >
      <section>
        <h2 className="text-xl font-bold">What The App Does</h2>
        <p className="mt-3">
          A business owner signs in by email and connects the accounts they
          already own. They create a campaign that names one or more keywords
          for a specific post. When someone comments a matching keyword, Meta
          delivers a webhook, OpenReply deduplicates the event, checks the
          per-account rate limit, and sends that commenter one private reply
          through the official Meta API. Every send, skip, and failure is
          logged with a reason.
        </p>
        <p className="mt-3">
          The app never posts on its own initiative. Every message is a response
          to a comment a person left on media the connected business owns.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Instagram User Flow</h2>
        <p className="mt-3">
          The business connects an Instagram professional account through
          Instagram Business Login. OpenReply subscribes to comment and message
          webhooks for that account, and replies privately using the comment ID
          inside Instagram&apos;s 24-hour messaging window. An optional public
          reply can be posted under the comment. Access tokens last 60 days and
          are refreshed by a scheduled job.
        </p>
        <p className="mt-3">
          Permissions requested, and what each one is for:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <span className="font-semibold">instagram_business_basic</span>{" "}
            identifies the connected account and lists the posts and reels a
            campaign can target.
          </li>
          <li>
            <span className="font-semibold">
              instagram_business_manage_messages
            </span>{" "}
            sends the private reply to the commenter, and powers the dashboard
            inbox where the business reads and answers those conversations.
          </li>
          <li>
            <span className="font-semibold">
              instagram_business_manage_comments
            </span>{" "}
            reads the comment that triggered the campaign and posts the optional
            public reply under it.
          </li>
          <li>
            <span className="font-semibold">
              instagram_business_manage_insights
            </span>{" "}
            reads follower counts for the campaign reporting the business sees,
            and backs the optional follow gate.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-bold">Facebook Page User Flow</h2>
        <p className="mt-3">
          The business connects through Facebook Login for Business. One
          authorization returns every Page the person administers, and OpenReply
          stores each Page the person can actually operate as its own connected
          account. A Page the person only has analytics access to is not offered,
          because it would connect and then never work.
        </p>
        <p className="mt-3">
          Each connected Page is subscribed to the <code>feed</code>,{" "}
          <code>messages</code>, and <code>messaging_postbacks</code> webhook
          fields. A comment on a Page post or Reel arrives on <code>feed</code>.
          When it matches a campaign keyword, OpenReply sends the commenter one
          private reply inside Facebook&apos;s 7-day messaging window. Page
          access tokens are derived from a long-lived user token and do not
          expire.
        </p>
        <p className="mt-3">
          Permissions requested, and what each one is for:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <span className="font-semibold">pages_show_list</span>{" "}
            lists the Pages the person administers so they can choose which ones
            to connect.
          </li>
          <li>
            <span className="font-semibold">pages_manage_metadata</span>{" "}
            subscribes the chosen Page to the comment webhook. Without it no
            comment ever reaches the app.
          </li>
          <li>
            <span className="font-semibold">pages_messaging</span>{" "}
            sends the private reply to the commenter, and powers the dashboard
            inbox for those conversations.
          </li>
          <li>
            <span className="font-semibold">pages_read_engagement</span>{" "}
            reads the comment and the post or Reel it sits under, so the keyword
            can be matched and so the app can check that a reply is still
            eligible before attempting one.
          </li>
        </ul>
        <p className="mt-3">
          Public comment replies on Facebook require{" "}
          <code>pages_manage_engagement</code>, which this app does not request.
          On Facebook the app therefore sends the private reply only.
        </p>
        <p className="mt-3">
          The Messenger use case also grants <code>business_management</code> as
          a required, non-removable permission, so it appears on the app. The
          connect flow does not ask for it and no part of the app calls a
          Business Manager endpoint. Pages are read from{" "}
          <code>/me/accounts</code> under <code>pages_show_list</code>.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Data Handled</h2>
        <p className="mt-3">
          For a connected account OpenReply stores the account or Page ID, its
          name, and its access token, encrypted at rest with AES-256-GCM. For a
          triggering comment it stores the comment and post IDs, the comment
          text, the commenter&apos;s platform-scoped ID and display name, and the
          outcome of the reply. Where a campaign uses a tracked link, a click
          records a hashed IP address, the user agent, and the referrer.
        </p>
        <p className="mt-3">
          The full policy is on the Privacy Policy page, and removal paths are on
          the Data Deletion page. Both are linked in the footer.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Compliance Position</h2>
        <p className="mt-3">
          OpenReply uses the official Instagram and Facebook APIs only. It does
          not ask for passwords, scrape either platform, or drive a browser.
          Incoming webhooks are verified against the app secret using the{" "}
          <code>X-Hub-Signature-256</code> header, and a delivery that fails
          verification is rejected. Sends are rate limited per account and stay
          under each platform&apos;s documented cap, queueing the overflow rather
          than dropping it. At most one private reply is sent for a given
          campaign and comment pair, so a commenter is never messaged twice for
          the same comment. The business&apos;s own comments never trigger a
          reply.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Review Test Notes</h2>
        <p className="mt-3">
          <span className="font-semibold">Instagram.</span> Sign in
          with the test credentials provided in the submission, open Settings and
          connect an Instagram professional account, create a campaign with the
          keyword LINK against one of that account&apos;s posts, then comment
          LINK on that post from a second account. The private reply arrives
          within seconds and the Logs page shows one entry for it.
        </p>
        <p className="mt-3">
          <span className="font-semibold">Facebook.</span> The same
          path, choosing Connect Facebook in Settings and selecting a Page you
          administer. Create a campaign against one of that Page&apos;s posts or
          Reels, comment the keyword from a second account, and the Page sends
          the commenter a private reply. The Logs page records it once.
        </p>
        <p className="mt-3">
          Disconnecting an account from Settings deletes its stored token
          immediately and stops all campaigns for it, which is the same control
          described on the Data Deletion page.
        </p>
      </section>
    </LegalShell>
  );
}
