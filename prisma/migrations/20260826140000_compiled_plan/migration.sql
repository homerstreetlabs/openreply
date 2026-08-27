-- Additive only. Nullable, so every existing campaign keeps running off the
-- flat columns until it is next saved through the compiler.
ALTER TABLE "Automation" ADD COLUMN "compiledPlan" JSONB;
