import { redirect } from "next/navigation";
import { getSessionScope } from "@/lib/session";
import { accountDirectory } from "@/lib/accounts/directory";

/**
 * An inbox is a mailbox, so it belongs to one account. This picks which one and
 * forwards; there is no accountless inbox to render.
 */
export default async function InboxIndex() {
  const scope = await getSessionScope();
  if (!scope) redirect("/login");

  const directory = await accountDirectory(scope.workspaceId);
  const target = directory.defaultFor("conversations");
  if (target) redirect(`/inbox/${target.id}`);

  return (
    <div className="panel rounded p-8 text-center">
      <p className="text-sm text-foreground">
        {directory.all.length > 0
          ? "None of your connected accounts have a readable inbox."
          : "Connect an account to read and reply to your messages."}
      </p>
      <p className="mt-2 text-xs text-muted">
        YouTube and TikTok reply publicly under the comment instead, because
        neither platform lets a business message a commenter first.
      </p>
    </div>
  );
}
