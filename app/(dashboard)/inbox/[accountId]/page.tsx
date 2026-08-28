import { notFound, redirect } from "next/navigation";
import { getSessionScope } from "@/lib/session";
import { accountDirectory, accountInWorkspace } from "@/lib/accounts/directory";
import { adapterFor } from "@/lib/platforms/registry";
import InboxClient from "./inbox-client";

/**
 * Validates the account, then hands one account to the client.
 *
 * The picker only offers accounts whose adapter implements `conversations`.
 * Filtering on the capability table instead is what let a Facebook Page into
 * this list and then failed it against an Instagram-only client.
 */
export default async function InboxPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const scope = await getSessionScope();
  if (!scope) redirect("/login");

  const [directory, account] = await Promise.all([
    accountDirectory(scope.workspaceId),
    accountInWorkspace(scope.workspaceId, accountId),
  ]);
  if (!account) notFound();

  const adapter = adapterFor(account.platform);
  if (!adapter.conversations) notFound();

  return (
    <InboxClient
      // A different account is a different mailbox, so the client starts fresh
      // rather than carrying the previous account's threads through a render.
      key={account.id}
      account={account}
      groups={directory.platforms.filter((group) =>
        group.accounts.some((a) => adapterFor(a.platform).conversations !== null)
      )}
      canReply={adapter.conversations.reply !== null}
    />
  );
}
