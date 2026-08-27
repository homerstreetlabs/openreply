import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { getPlatformScope } from "@/lib/tenancy/platform-scope";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );
  const accounts = await prisma.connectedAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { username: true },
  });

  // Admin surfaces are hidden rather than shown and refused. A creator who sees
  // Fleet and clicks into a 403 learns nothing except that the product has a
  // room they are not allowed in.
  const scope = await getPlatformScope();

  return (
    <DashboardShell
      isPlatformAdmin={scope !== null}
      workspaceName={workspace.name}
      instagramUsername={accounts[0]?.username ?? null}
      instagramAccountCount={accounts.length}
    >
      {children}
    </DashboardShell>
  );
}
