import type { Metadata } from "next";
import Link from "next/link";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy - OpenReply",
  description:
    "How OpenReply handles Instagram and Facebook Page account data, webhook payloads, comment and messaging data, and customer campaign information.",
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      description="OpenReply helps businesses send a private reply when someone comments on their own Instagram posts and reels or their own Facebook Page posts and Reels."
      updatedAt="August 28, 2026"
    >
      <section>
        <h2 className="text-xl font-bold">Data We Collect</h2>
        <p className="mt-3">From the business using OpenReply:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            The email address used to sign in, and workspace, team member, and
            billing metadata.
          </li>
          <li>
            Connected account identifiers, meaning the Instagram professional
            account ID and username or the Facebook Page ID and name, together
            with the access token for that account, encrypted at rest.
          </li>
          <li>
            Campaign settings: keywords, targeted posts, message templates, and
            tracked link destinations.
          </li>
        </ul>
        <p className="mt-3">
          From people who interact with the connected accounts:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            The webhook payloads Meta delivers, and the comment that triggered a
            campaign, including the comment and post IDs and the comment text.
          </li>
          <li>
            The commenter&apos;s platform-scoped ID and display name, which are
            what the platform requires to address a private reply, plus the
            messaging conversations the business reads and answers in the
            dashboard.
          </li>
          <li>
            Delivery logs recording each send, skip, and failure with its reason,
            and, where a campaign uses a tracked link, click records containing a
            hashed IP address, the user agent, and the referrer.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-bold">How We Use Data</h2>
        <p className="mt-3">
          We use this data to authenticate users, connect Instagram and Facebook
          integrations, match comment keywords, send private replies and optional
          public replies through the official Meta APIs, prevent duplicate sends,
          report campaign results to the business, troubleshoot failures, and
          protect the service. We do not sell this data, use it for advertising,
          or use it to build profiles of the people who comment.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Instagram And Meta Data</h2>
        <p className="mt-3">
          OpenReply does not ask for Instagram or Facebook passwords, scrape
          either platform, or use browser automation. It acts only through the
          official APIs, and only within the permissions the business granted at
          authorization. Access tokens for Instagram professional accounts and
          Facebook Pages are encrypted at rest with AES-256-GCM and are used only
          to perform actions the connected business account authorized. Incoming
          webhooks are signature-verified before they are processed.
        </p>
        <p className="mt-3">
          Data obtained from Meta is used to deliver the feature the business
          asked for and is not shared with third parties beyond the
          infrastructure providers named below.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Subprocessors</h2>
        <p className="mt-3">
          The hosted service runs on Cloudflare Workers with a PostgreSQL
          database, and uses an email provider to send sign-in links and
          invitations. These providers process data only as needed to run the
          service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Retention And Deletion</h2>
        <p className="mt-3">
          A business can disconnect an Instagram account or a Facebook Page from
          Settings at any time. That deletes the stored token for it immediately
          and stops its campaigns. For deletion of workspace, campaign, comment,
          messaging, and log data, follow the{" "}
          <Link href="/data-deletion" className="font-semibold text-accent underline">
            Data Deletion
          </Link>{" "}
          page, which lists exactly what a deletion request covers.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Self-Hosted Instances</h2>
        <p className="mt-3">
          OpenReply is open source and can be deployed by anyone on their own
          infrastructure. This policy describes the hosted service we operate. On
          an instance run by someone else, that operator controls the database
          and is the party responsible for the data in it.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Contact</h2>
        <p className="mt-3">
          For privacy questions or deletion requests, email{" "}
          <a
            href="mailto:privacy@recite.fm"
            className="font-semibold text-accent underline"
          >
            privacy@recite.fm
          </a>
          .
        </p>
      </section>
    </LegalShell>
  );
}
