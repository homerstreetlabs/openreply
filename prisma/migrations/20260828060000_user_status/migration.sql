-- Closed registration.
--
-- Every existing row is backfilled to ACTIVE, which is the grandfather clause:
-- the two platform admins and every creator who signed up while the door was
-- open keep working, and the gate refuses only addresses that have never been
-- seen. Deploy this before the sign-in callback that reads it, so no row is
-- ever checked before it has a value.

CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
