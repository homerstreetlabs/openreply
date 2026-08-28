/**
 * Two different absences. No accounts at all is an onboarding step; accounts
 * that exist but report nothing is a platform limitation, and telling a creator
 * to "connect an account" when they already have four would read as a bug.
 */
export default function EmptyOverview({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <div className="panel rounded p-8 text-center">
      <p className="text-sm text-foreground">
        {hasAccounts
          ? "None of your connected accounts report post analytics."
          : "Connect an account to see how your posts are performing."}
      </p>
      {!hasAccounts && (
        <a href="/settings" className="mt-4 inline-block text-sm text-accent hover:underline">
          Connect an account
        </a>
      )}
    </div>
  );
}
