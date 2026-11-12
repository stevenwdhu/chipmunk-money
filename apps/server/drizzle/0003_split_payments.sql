-- A card payment on a shared account can be split between the ledgers that have the account. The
-- payment stays as the bank sent it, and split rows beside it, on the same account, name it in
-- transactions.split_of: a share in each other ledger, and one row in the ledger that holds the
-- payment for everything it gave. One split row per ledger per payment (tx_split).
-- The column and index are drizzle-kit's (src/db/schema.ts); the triggers after them are written by
-- hand.
ALTER TABLE `transactions` ADD `split_of` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `tx_split` ON `transactions` (`split_of`,`ledger_id`) WHERE "transactions"."split_of" IS NOT NULL;
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit doesn't make views or triggers.

-- A split row is a piece of a live payment on its own account, and that payment isn't a split row
-- itself. Which ledgers may hold rows on the account is guard_transactions_insert's.
CREATE TRIGGER `guard_transactions_split` BEFORE INSERT ON `transactions`
WHEN NEW.`split_of` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `transactions` s WHERE s.`id` = NEW.`split_of` AND s.`account_id` = NEW.`account_id` AND s.`split_of` IS NULL AND s.`deleted_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a split row is a piece of a live payment on its account that isn''t a split row');
END;
--> statement-breakpoint
-- While a payment is split, neither it nor its split rows leave their account or ledger, or are
-- deleted (soft), and a row doesn't become a piece of another payment. Clearing split_of is how a
-- split row is detached: from then on it's an ordinary row, and this lets it go in the same UPDATE.
CREATE TRIGGER `keep_split_rows` BEFORE UPDATE OF `split_of`, `account_id`, `ledger_id`, `deleted_at` ON `transactions`
WHEN (NEW.`split_of` IS NOT NULL AND NEW.`split_of` IS NOT OLD.`split_of`)
  OR (
    ((OLD.`split_of` IS NOT NULL AND NEW.`split_of` IS NOT NULL) OR EXISTS (SELECT 1 FROM `transactions` s WHERE s.`split_of` = OLD.`id`))
    AND (NEW.`account_id` IS NOT OLD.`account_id` OR NEW.`ledger_id` IS NOT OLD.`ledger_id` OR (OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL))
  )
BEGIN
  SELECT RAISE(ABORT, 'change or undo the split first');
END;
--> statement-breakpoint
-- A payment that still has split rows isn't deleted for good either: they'd name a row that's gone.
-- That includes deleting its account or its ledger, which delete their rows in no set order.
CREATE TRIGGER `keep_split_payment` BEFORE DELETE ON `transactions`
WHEN EXISTS (SELECT 1 FROM `transactions` s WHERE s.`split_of` = OLD.`id`)
BEGIN
  SELECT RAISE(ABORT, 'change or undo the split first');
END;
