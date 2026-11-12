-- ai_calls becomes a record of what AI was asked to do, one row per thing asked (a payee to
-- categorize, a set of payees to name, a connection test), where it was one row per call to a
-- provider. A row that failed stays open until the same thing is asked again and answered, which
-- corrects that row: ai_calls_open lets a ledger have one open row per thing. The rows from before
-- keep what they say: they have no kind, and each is one call. A failed "Ask AI again" keeps which
-- transactions it asked about (asked), so a retry asks about the same ones.
-- All of it is drizzle-kit's (src/db/schema.ts).
ALTER TABLE `ai_calls` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `subject_key` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `tries` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `first_failed_at` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `primary_error` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `tried_at` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `asked` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_calls_open` ON `ai_calls` (`ledger_id`,`kind`,`subject_key`) WHERE "ai_calls"."ok" = 0 AND "ai_calls"."subject_key" IS NOT NULL;
