import { redirect } from "next/navigation";
import { getSessionScope } from "@/lib/session";
import { accountDirectory } from "@/lib/accounts/directory";

/**
 * Overview has no accountless state, so this only picks a default and forwards.
 * Everything real lives under `[accountId]`, where a layout can validate the id
 * once for every page beneath it.
 */
export default async function OverviewIndex() {
  const scope = await getSessionScope();
  if (!scope) redirect("/login");

  const directory = await accountDirectory(scope.workspaceId);
  const target = directory.defaultFor("insights");
  if (target) redirect(`/overview/${target.id}`);

  // Two different absences. No accounts at all is an onboarding step; accounts
  // that exist but report nothing is a platform limitation, and telling someone
  // to connect an account when they already have four reads as a bug.
  const hasAccounts = directory.all.length > 0;

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
