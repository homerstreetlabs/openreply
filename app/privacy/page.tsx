import type { Metadata } from "next";
import Link from "next/link";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy - OpenReply",
  description:
    "How OpenReply collects, uses, and protects Instagram, Facebook Page, YouTube, and TikTok account data, comment and messaging data, and customer campaign information.",
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      description="OpenReply helps businesses and creators reply automatically when someone comments on their own Instagram, Facebook Page, YouTube, or TikTok content."
      updatedAt="September 25, 2026"
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
            account ID and username, the Facebook Page ID and name, the YouTube
            channel ID and title, or the TikTok account ID and handle, together
            with the OAuth access token and, where the platform issues one, the
            refresh token for that account, both encrypted at rest.
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
            The webhook payloads Meta delivers, the comments OpenReply reads from
            the connected account&apos;s own posts and videos, and the comment
            that triggered a campaign, including the comment, post, or video IDs
            and the comment text.
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
          We use this data to authenticate users, connect Instagram, Facebook,
          YouTube, and TikTok integrations, match comment keywords, send private
          replies and public replies through each platform&apos;s official API,
          prevent duplicate sends,
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
        <h2 className="text-xl font-bold">YouTube And Google Data</h2>
        <p className="mt-3">
          When a creator connects a YouTube channel, OpenReply requests the{" "}
          <code>youtube.force-ssl</code> scope through Google OAuth. It uses that
          access only to read the channel&apos;s own videos and the comments on
          them, and to post the replies the creator configured. OpenReply does
          not upload, edit, or delete videos, and does not read data from
          channels other than the one connected.
        </p>
        <p className="mt-3">
          OpenReply&apos;s use and transfer of information received from Google
          APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="font-semibold text-accent underline"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. Google user data is not
          sold, not used for advertising, not used to train AI or machine
          learning models, and not transferred to anyone except as needed to
          provide the feature, to comply with law, or as part of a merger or
          acquisition with notice to users. No person at OpenReply reads Google
          user data unless the creator asks us to for support, it is needed for
          security or legal compliance, or it has been aggregated and
          anonymized.
        </p>
        <p className="mt-3">
          A creator can disconnect the channel in Settings, which deletes the
          stored tokens immediately, and can also revoke OpenReply&apos;s access
          at any time from{" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="font-semibold text-accent underline"
          >
            Google Account permissions
          </a>
          .
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">How We Protect Data</h2>
        <p className="mt-3">
          We protect personal and sensitive data, including OAuth tokens and
          the comment and messaging data obtained from connected platforms,
          with these measures:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong>Encryption in transit.</strong> Traffic between browsers and
            OpenReply, and between OpenReply and platform APIs, is encrypted
            with TLS over HTTPS.
          </li>
          <li>
            <strong>Encryption at rest.</strong> Access and refresh tokens for
            every connected account are encrypted at the application layer with
            AES-256-GCM before they are stored, using a key held as a secret in
            the hosting environment and never stored in the database or source
            code.
          </li>
          <li>
            <strong>Access control.</strong> Every dashboard and API request
            requires an authenticated session, and data is scoped to the
            requester&apos;s workspace, so one customer cannot read another
            customer&apos;s accounts, comments, or messages. Production access is
            limited to the staff who operate the service, and every
            administrative access to customer data is recorded in an audit log.
          </li>
          <li>
            <strong>Verified inputs.</strong> Incoming webhooks are
            signature-verified before processing, and OAuth connection requests
            carry a signed state value to prevent forged connections.
          </li>
          <li>
            <strong>Data minimization.</strong> We request only the platform
            scopes each feature needs, store IP addresses from tracked link
            clicks only as one-way hashes, and delete tokens as soon as an
            account is disconnected.
          </li>
          <li>
            <strong>Incident response.</strong> If we learn of a breach
            affecting personal data, we will notify affected customers and the
            relevant authorities as required by applicable law.
          </li>
        </ul>
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
