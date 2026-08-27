import { NextResponse } from "next/server";
import { getFleetOverview } from "@/lib/ops/fleet";
import {
  PlatformAccessError,
  recordAdminAccess,
  requirePlatformScope,
} from "@/lib/tenancy/platform-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requirePlatformScope("SUPPORT_READ");
    const data = await getFleetOverview(scope);
    await recordAdminAccess({ scope, action: "read fleet overview" });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof PlatformAccessError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    throw error;
  }
}
