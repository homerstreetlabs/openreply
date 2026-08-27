import { NextResponse } from "next/server";
import { Platform } from "@/app/generated/prisma/client";
import { platformIsConfigured } from "@/lib/platforms/provider-apps";
import { platformName } from "@/lib/campaigns/options";
import { supports } from "@/lib/platforms/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which platforms this instance can connect, and what each one does.
 *
 * Connectability is whether credentials exist, not a flag someone has to
 * remember to flip. An operator who sets `YOUTUBE_CLIENT_ID` and
 * `YOUTUBE_CLIENT_SECRET` sees the button light up on the next load, with no
 * deploy and nothing here to change.
 */
export async function GET() {
  const platforms = await Promise.all(
    Object.values(Platform).map(async (platform) => ({
      platform,
      name: platformName(platform),
      connectable: await platformIsConfigured(platform),
      canMessage: supports(platform, "PRIVATE_REPLY"),
    }))
  );

  return NextResponse.json({ success: true, data: { platforms } });
}
