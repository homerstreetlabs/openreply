import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { getSession } from "@/lib/session";
import { ensureWorkspaceForUser, getWorkspaceForUser } from "@/lib/workspace";
import { getPlatformScope } from "@/lib/tenancy/platform-scope";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user?.id) {
    redirect("/login");
  }
  const userId = session.user.id;

  // Two round trips, not six. Both depend only on the user, so neither has to
  // wait for the other.
  const [existingWorkspace, scope] = await Promise.all([
    getWorkspaceForUser(userId),
    getPlatformScope(userId),
  ]);

  // Both sign-in events provision a workspace, so by the time a session exists
  // there is one. This is the repair for a session that predates that, and it
  // is why the read above is the normal path rather than the write.
  const workspace =
    existingWorkspace ??
    (await ensureWorkspaceForUser(userId, session.user.email));

  return (
    <DashboardShell
      // Admin surfaces are hidden rather than shown and refused. A creator who
      // sees Fleet and clicks into a 403 learns nothing except that the product
      // has a room they are not allowed in.
      isPlatformAdmin={scope !== null}
      workspaceName={workspace.name}
    >
      {children}
    </DashboardShell>
  );
}
