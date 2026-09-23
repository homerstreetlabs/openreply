-- The engine stamped "dmSentAt" on every run that finished, so a reply-only
-- run read as a DM in Activity and was counted as one on the dashboard.
-- Re-derive both columns from the step outcomes for engine runs. Runs with no
-- outcome rows came from the legacy worker, which stamped each column itself.

UPDATE "DmLog" r
SET
  "dmSentAt" = (
    SELECT max(o."createdAt") FROM "StepOutcome" o
    WHERE o."runId" = r."id" AND o."status" = 'SENT'
      AND o."kind" IN ('directMessage', 'linkButtons', 'openingDm', 'conversationMessage', 'followUp')
  ),
  "publicReplySentAt" = COALESCE(r."publicReplySentAt", (
    SELECT max(o."createdAt") FROM "StepOutcome" o
    WHERE o."runId" = r."id" AND o."status" = 'SENT' AND o."kind" = 'publicReply'
  ))
WHERE EXISTS (SELECT 1 FROM "StepOutcome" o WHERE o."runId" = r."id");
