import { notFound, redirect } from "next/navigation";
import { getSessionScope } from "@/lib/session";
import { accountInWorkspace } from "@/lib/accounts/directory";

/**
 * The single validation point for every Overview page.
 *
 * This is why the account is a path segment rather than `?accountId=`: a layout
 * cannot read `searchParams` (they would be stale, since layouts do not
 * re-render on navigation), so a query param has to be re-validated by every
 * page that reads it, and a page that forgets is unguarded.
 *
 * An account in someone else's workspace answers 404 rather than 403. An id
 * that exists but is not yours has to be indistinguishable from one that does
 * not exist, or the response confirms it exists.
 */
export default async function OverviewAccountLayout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  const { accountId } = await params;
  const scope = await getSessionScope();
  if (!scope) redirect("/login");

  const account = await accountInWorkspace(scope.workspaceId, accountId);
  if (!account) notFound();

  return <>{children}</>;
}
