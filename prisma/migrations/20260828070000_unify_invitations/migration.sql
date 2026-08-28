-- One invitation table instead of two.
--
-- CreatorInvitation and WorkspaceInvitation held the same seven fields with two
-- accept paths and two places the admission gate had to look. Every row is
-- copied into the new table before either old one is dropped, and Prisma runs
-- this migration in a transaction, so a failure anywhere leaves both originals
-- intact.

CREATE TYPE "InvitationKind" AS ENUM ('CREATOR', 'MEMBER');

ALTER TYPE "WorkspaceInvitationStatus" RENAME TO "InvitationStatus";

CREATE TABLE "Invitation" (
    "id"              TEXT NOT NULL,
    "email"           TEXT NOT NULL,
    "kind"            "InvitationKind" NOT NULL,
    "workspaceId"     TEXT,
    "role"            "WorkspaceRole",
    "invitedName"     TEXT,
    "token"           TEXT NOT NULL,
    "status"          "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByUserId" TEXT,
    "deliveredAt"     TIMESTAMP(3),
    "deliveryError"   TEXT,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "acceptedAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Invitation" (
    "id", "email", "kind", "workspaceId", "role", "invitedName", "token",
    "status", "invitedByUserId", "deliveredAt", "deliveryError", "expiresAt",
    "acceptedAt", "createdAt", "updatedAt"
)
SELECT
    c."id", c."email", 'CREATOR', c."workspaceId", NULL, c."creatorName", c."token",
    c."status", c."invitedByUserId", c."deliveredAt", c."deliveryError", c."expiresAt",
    c."acceptedAt", c."createdAt", c."updatedAt"
FROM "CreatorInvitation" c;

INSERT INTO "Invitation" (
    "id", "email", "kind", "workspaceId", "role", "invitedName", "token",
    "status", "invitedByUserId", "deliveredAt", "deliveryError", "expiresAt",
    "acceptedAt", "createdAt", "updatedAt"
)
SELECT
    w."id", w."email", 'MEMBER', w."workspaceId", w."role", NULL, w."token",
    w."status", w."invitedByUserId", NULL, NULL, w."expiresAt",
    w."acceptedAt", w."createdAt", w."updatedAt"
FROM "WorkspaceInvitation" w;

CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");
CREATE UNIQUE INDEX "Invitation_email_kind_workspaceId_key"
    ON "Invitation"("email", "kind", "workspaceId");
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");
CREATE INDEX "Invitation_status_idx" ON "Invitation"("status");
CREATE INDEX "Invitation_workspaceId_idx" ON "Invitation"("workspaceId");

-- Postgres treats NULLs as distinct, so the composite unique above does not
-- stop two CREATOR invitations for one address: both carry a null workspaceId.
-- CreatorInvitation enforced that with a plain unique on email, and this
-- partial index is what preserves it.
CREATE UNIQUE INDEX "Invitation_creator_email_key"
    ON "Invitation"("email") WHERE "kind" = 'CREATOR';

ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey"
    FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "CreatorInvitation";
DROP TABLE "WorkspaceInvitation";
