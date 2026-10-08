-- A comment the sweep finds runs its DM before its public reply. The order is
-- fixed when the run is created, because the cursor indexes into it.
ALTER TABLE "DmLog" ADD COLUMN "dmFirst" BOOLEAN NOT NULL DEFAULT false;
