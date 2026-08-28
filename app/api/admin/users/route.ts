import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { listPeople } from "@/lib/access/people";
import {
  PlatformAccessError,
  recordAdminAccess,
  requirePlatformScope,
  type PlatformScope,
} from "@/lib/tenancy/platform-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Granting, revoking and suspending, which used to be a SQL statement in
 * docs/setup.md.
 *
 * Every write here is audited through `recordAdminAccess`, because the whole
 * reason PlatformGrant is a table rather than a column on User is that the
 * standing permission and each use of it are separate records.
 */

const grantSchema = z.object({
  userId: z.string().min(1),
  tier: z.enum(["SUPPORT_READ", "SUPPORT_FULL", "ADMIN"]),
  /** Support access should expire. An open-ended grant is the exception. */
  expiresAt: z.string().datetime().optional(),
  reason: z.string().min(1).max(500),
});

const revokeSchema = z.object({ grantId: z.string().min(1) });

const statusSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

/**
 * Every handler here needs the same grant check and the same 403. Wrapping is
 * what keeps that one decision in one place rather than four catch blocks that
 * can drift.
 */
function guarded(
  minimum: "SUPPORT_READ" | "ADMIN",
  handler: (scope: PlatformScope, request: NextRequest) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      const scope = await requirePlatformScope(minimum);
      return await handler(scope, request);
    } catch (failure) {
      if (failure instanceof PlatformAccessError) {
        return NextResponse.json(
          { success: false, error: failure.message },
          { status: 403 }
        );
      }
      throw failure;
    }
  };
}

export const GET = guarded("SUPPORT_READ", async (scope) => {
  const people = await listPeople();
  await recordAdminAccess({ scope, action: "read people list" });
  return NextResponse.json({ success: true, data: people });
});

export const POST = guarded("ADMIN", async (scope, request) => {
  const parsed = grantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid grant" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  // Superseding rather than stacking. Two live grants for one person would
  // make "what can they do" a question about which row you happened to read.
  await prisma.platformGrant.updateMany({
    where: { userId: target.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await prisma.platformGrant.create({
    data: {
      userId: target.id,
      tier: parsed.data.tier,
      grantedByUserId: scope.userId,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      reason: parsed.data.reason,
    },
  });

  await recordAdminAccess({
    scope,
    action: `granted ${parsed.data.tier} to ${target.email ?? target.id}`,
  });

  return NextResponse.json({ success: true, data: await listPeople() });
});

export const DELETE = guarded("ADMIN", async (scope, request) => {
  const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid revoke" }, { status: 400 });
  }

  const grant = await prisma.platformGrant.findUnique({
    where: { id: parsed.data.grantId },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!grant || grant.revokedAt) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  // An install with no admin cannot grant one back through this route, and
  // the bootstrap allowlist only applies when no grant has ever existed.
  const others = await prisma.platformGrant.count({
    where: {
      tier: "ADMIN",
      revokedAt: null,
      id: { not: grant.id },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (others === 0) {
    return NextResponse.json(
      { success: false, error: "This is the last admin. Grant another one first." },
      { status: 409 }
    );
  }

  // Revoked, never deleted. The row is what records that the authority once
  // existed, and AdminAccessLog points at it.
  await prisma.platformGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date() },
  });

  await recordAdminAccess({ scope, action: `revoked grant ${grant.id}` });
  return NextResponse.json({ success: true, data: await listPeople() });
});

export const PATCH = guarded("ADMIN", async (scope, request) => {
  const parsed = statusSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid status" }, { status: 400 });
  }

  if (parsed.data.userId === scope.userId && parsed.data.status === "SUSPENDED") {
    return NextResponse.json(
      { success: false, error: "You cannot suspend yourself." },
      { status: 409 }
    );
  }

  await prisma.user.update({
    where: { id: parsed.data.userId },
    data: { status: parsed.data.status },
  });

  await recordAdminAccess({
    scope,
    action: `set ${parsed.data.userId} to ${parsed.data.status}`,
  });

  return NextResponse.json({ success: true, data: await listPeople() });
});
