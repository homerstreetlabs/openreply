import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/session";
import { loadDiagnostics } from "@/lib/ops/diagnostics";

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  return NextResponse.json({ success: true, data: await loadDiagnostics(workspaceId) });
}
