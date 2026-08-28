import { redirect } from "next/navigation";
import { getSessionScope } from "@/lib/session";
import { accountDirectory } from "@/lib/accounts/directory";
import EmptyOverview from "./empty";

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

  return <EmptyOverview hasAccounts={directory.all.length > 0} />;
}
