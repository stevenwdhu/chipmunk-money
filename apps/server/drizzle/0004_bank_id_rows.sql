-- A row can be kept only so its account keeps knowing a bank id (transactions.bank_id_only): what's
-- left of a transaction that was the account's and went with an account split off from it, or with
-- a ledger, that's gone. It's a deleted row with a bank id, which the purge leaves, so the account's
-- sync, a bank switch or a CSV import never adds that transaction again.
-- The column is drizzle-kit's (src/db/schema.ts); the triggers after it are written by hand.
ALTER TABLE `transactions` ADD `bank_id_only` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit doesn't make views or triggers.

-- Such a row is a deleted one with a bank id.
CREATE TRIGGER `guard_transactions_bank_id_only` BEFORE INSERT ON `transactions`
WHEN NEW.`bank_id_only` AND (NEW.`deleted_at` IS NULL OR NEW.`external_id` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a row kept only for its bank id is a deleted row with one');
END;
--> statement-breakpoint
-- And it stays one: it isn't restored, it keeps a bank id (a bank switch gives it the new one), and
-- it never becomes an ordinary row again. A deleted row with a bank id can become one.
CREATE TRIGGER `keep_bank_id_only` BEFORE UPDATE OF `bank_id_only`, `deleted_at`, `external_id` ON `transactions`
WHEN (NEW.`bank_id_only` AND (NEW.`deleted_at` IS NULL OR NEW.`external_id` IS NULL))
  OR (OLD.`bank_id_only` AND NOT NEW.`bank_id_only`)
BEGIN
  SELECT RAISE(ABORT, 'a row kept only for its bank id stays a deleted row with one');
END;
