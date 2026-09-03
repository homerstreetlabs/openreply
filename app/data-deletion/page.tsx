import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Data Deletion - OpenReply",
  description:
    "How to disconnect an Instagram professional account or Facebook Page from OpenReply, and how to request deletion of workspace, campaign, and log data.",
};

export default function DataDeletionPage() {
  return (
    <LegalShell
      title="Data Deletion"
      description="How to remove a connected Instagram professional account or Facebook Page from OpenReply, and how to have your workspace data deleted."
      updatedAt="August 28, 2026"
    >
      <section>
        <h2 className="text-xl font-bold">
          Disconnect An Account Or Page
        </h2>
        <p className="mt-3">
          Sign in, open Settings, find the connected Instagram professional
          account or Facebook Page, and select Disconnect. This takes effect
          immediately. It deletes the stored access token for that account,
          removes the connection, and stops every campaign that was sending
          through it.
        </p>
        <p className="mt-3">
          Each Facebook Page is a separate connection, so disconnecting one Page
          leaves your other Pages running.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">
          Remove OpenReply From Meta
        </h2>
        <p className="mt-3">
          You can also revoke access from Meta&apos;s own settings, which stops
          OpenReply from acting on your account whether or not you disconnect in
          the app. On Facebook, open Settings and privacy, then Settings,
          Business integrations, and remove OpenReply. On Instagram, open
          Settings, then Website permissions, Apps and websites, and remove
          OpenReply.
        </p>
        <p className="mt-3">
          Revoking there invalidates the token OpenReply holds, so campaigns
          stop. To have the data already stored deleted as well, use the request
          below.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Delete Your Data</h2>
        <p className="mt-3">
          To have your stored data deleted, email{" "}
          <a
            href="mailto:privacy@recite.fm"
            className="font-semibold text-accent underline"
          >
            privacy@recite.fm
          </a>{" "}
          from the address you use to sign in. Include the workspace name and
          the Instagram username or Facebook Page name connected to it.
        </p>
        <p className="mt-3">A deletion request covers:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            The workspace, its members, and the account email used to sign in.
          </li>
          <li>
            Every connected Instagram account and Facebook Page, including the
            encrypted access tokens.
          </li>
          <li>
            Campaigns, keywords, and message templates.
          </li>
          <li>
            Stored comment and messaging data, including comment and post IDs,
            comment text, and the platform-scoped IDs and display names of
            people who triggered a campaign.
          </li>
          <li>
            Delivery logs, webhook records, tracked links, and click data
            including hashed IP addresses, user agents, and referrers.
          </li>
          <li>Operational diagnostics tied to the workspace.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-bold">Verification And Timing</h2>
        <p className="mt-3">
          We may ask you to confirm control of the sign-in email address or the
          connected business account before deleting anything, because deletion
          cannot be undone. Requests are processed as quickly as practical and
          within 30 days, unless a record must be retained for legal, billing,
          fraud prevention, or security reasons. Where that applies, we will
          tell you what was retained and why.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Self-Hosted Instances</h2>
        <p className="mt-3">
          OpenReply is open source and can be run by anyone on their own
          infrastructure. If you are using an instance operated by someone other
          than us, your data lives in their database and they are the ones who
          can delete it. Contact whoever runs that instance. The address above
          covers the hosted service only.
        </p>
      </section>
    </LegalShell>
  );
}
