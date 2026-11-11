-- An account can be shared with other ledgers. Its home stays in accounts.ledger_id, and each other
-- ledger it's shared with (a member) has a row in account_ledgers. Additive only: on a database
-- from before, account_ledgers is empty and both new columns are null, so the view gives what it
-- gave and every guard made again here refuses what it refused.
-- The tables, columns and indexes are drizzle-kit's (src/db/schema.ts); the view and triggers after
-- them are written by hand.
CREATE TABLE `account_ledgers` (
	`ledger_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`institution_id` integer NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`ledger_id`, `account_id`),
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_ledgers_account` ON `account_ledgers` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_ledgers_institution` ON `account_ledgers` (`institution_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `opening_ledger_id` text REFERENCES ledgers(id);--> statement-breakpoint
ALTER TABLE `accounts` ADD `split_from_id` integer;--> statement-breakpoint
CREATE INDEX `accounts_opening_ledger` ON `accounts` (`opening_ledger_id`);
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit doesn't make views or triggers.

-- A ledger's accounts: the ones it's the home of, and the ones shared with it. A shared account has
-- its own facts in every ledger, with that ledger's institution, sort order and archive.
-- home_ledger_id is the home, and opening_ledger_id the ledger whose part carries the opening
-- balance and the recorded balances (the home unless the home was changed).
DROP VIEW `ledger_accounts`;
--> statement-breakpoint
CREATE VIEW `ledger_accounts` AS
SELECT a.`ledger_id`, a.`id`, a.`name`, a.`type`, a.`currency`, a.`opening_balance_minor`, a.`opening_date`,
  a.`institution_id`, a.`notes`, a.`archived_at`, a.`sort`, a.`external_id`, a.`import_mapping`,
  a.`created_at`, a.`updated_at`,
  a.`ledger_id` AS `home_ledger_id`, coalesce(a.`opening_ledger_id`, a.`ledger_id`) AS `opening_ledger_id`, a.`split_from_id`
FROM `accounts` a
UNION ALL
SELECT m.`ledger_id`, a.`id`, a.`name`, a.`type`, a.`currency`, a.`opening_balance_minor`, a.`opening_date`,
  m.`institution_id`, a.`notes`, m.`archived_at`, m.`sort`, a.`external_id`, a.`import_mapping`,
  a.`created_at`, a.`updated_at`,
  a.`ledger_id`, coalesce(a.`opening_ledger_id`, a.`ledger_id`), a.`split_from_id`
FROM `account_ledgers` m JOIN `accounts` a ON a.`id` = m.`account_id`;
--> statement-breakpoint
-- A transaction or recurring item is on an account of its ledger: the home, or a ledger the account
-- is shared with. The other rules are as before.
DROP TRIGGER `guard_transactions_insert`;
--> statement-breakpoint
CREATE TRIGGER `guard_transactions_insert` BEFORE INSERT ON `transactions`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = a.`id` AND m.`ledger_id` = NEW.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`id` = NEW.`recurring_item_id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`id` = NEW.`import_batch_id` AND b.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transactions` p WHERE p.`id` = NEW.`transfer_pair_id` AND p.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
DROP TRIGGER `guard_transactions_update`;
--> statement-breakpoint
CREATE TRIGGER `guard_transactions_update` BEFORE UPDATE OF `ledger_id`, `account_id`, `category_id`, `recurring_item_id`, `import_batch_id`, `transfer_pair_id` ON `transactions`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = a.`id` AND m.`ledger_id` = NEW.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`id` = NEW.`recurring_item_id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`id` = NEW.`import_batch_id` AND b.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transactions` p WHERE p.`id` = NEW.`transfer_pair_id` AND p.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
DROP TRIGGER `guard_recurring_items_insert`;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_items_insert` BEFORE INSERT ON `recurring_items`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = a.`id` AND m.`ledger_id` = NEW.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
DROP TRIGGER `guard_recurring_items_update`;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_items_update` BEFORE UPDATE OF `ledger_id`, `account_id`, `category_id` ON `recurring_items`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = a.`id` AND m.`ledger_id` = NEW.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- The home changes only to a ledger the account is shared with, which then gives up its member row
-- and the old home takes one: the rows each ledger holds stay where they are.
DROP TRIGGER `keep_ledger_accounts`;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_accounts` BEFORE UPDATE OF `ledger_id` ON `accounts`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
  AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'an account''s home moves only to a ledger it is shared with');
END;
--> statement-breakpoint
-- The opening ledger is the home (null, or the home's id), or a ledger the account is shared with.
CREATE TRIGGER `guard_accounts_opening_ledger_insert` BEFORE INSERT ON `accounts`
WHEN NEW.`opening_ledger_id` IS NOT NULL AND NEW.`opening_ledger_id` <> NEW.`ledger_id`
  AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = NEW.`opening_ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_accounts_opening_ledger` BEFORE UPDATE OF `opening_ledger_id`, `ledger_id` ON `accounts`
WHEN NEW.`opening_ledger_id` IS NOT NULL AND NEW.`opening_ledger_id` <> NEW.`ledger_id`
  AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = NEW.`opening_ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- A member row is never the home's, and its institution is in its own ledger.
CREATE TRIGGER `guard_account_ledgers_insert` BEFORE INSERT ON `account_ledgers`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` = NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `institutions` i WHERE i.`id` = NEW.`institution_id` AND i.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_account_ledgers_update` BEFORE UPDATE OF `institution_id` ON `account_ledgers`
WHEN EXISTS (SELECT 1 FROM `institutions` i WHERE i.`id` = NEW.`institution_id` AND i.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- A member row never changes ledger or account: it's deleted and another one made.
CREATE TRIGGER `keep_ledger_account_ledgers` BEFORE UPDATE OF `ledger_id`, `account_id` ON `account_ledgers`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id` OR NEW.`account_id` IS NOT OLD.`account_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
-- A member row goes only when its ledger no longer uses the account: it holds no transaction on it
-- (deleted ones count), no recurring item and no import batch, and isn't its opening ledger. Not checked when the
-- row's ledger is the home by then (a home change deletes the new home's member row after the
-- account moved to it), or when the account itself is being deleted (it's gone, so the first test
-- is null).
CREATE TRIGGER `guard_account_ledgers_delete` BEFORE DELETE ON `account_ledgers`
WHEN OLD.`ledger_id` <> (SELECT a.`ledger_id` FROM `accounts` a WHERE a.`id` = OLD.`account_id`)
  AND (EXISTS (SELECT 1 FROM `transactions` t WHERE t.`account_id` = OLD.`account_id` AND t.`ledger_id` = OLD.`ledger_id`)
    OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`account_id` = OLD.`account_id` AND r.`ledger_id` = OLD.`ledger_id`)
    OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`account_id` = OLD.`account_id` AND b.`ledger_id` = OLD.`ledger_id`)
    OR (SELECT a.`opening_ledger_id` FROM `accounts` a WHERE a.`id` = OLD.`account_id`) = OLD.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'the ledger still uses the account');
END;
--> statement-breakpoint
-- The same rules from the other side, for rows inserted out of order (the baseline's
-- guard_*_referred): an account inserted after rows that name it lets those rows be in a ledger it
-- is shared with, and is never the home of a ledger that already has a member row for it. An
-- institution inserted after a member row that names it is in that row's ledger.
DROP TRIGGER `guard_accounts_referred`;
--> statement-breakpoint
CREATE TRIGGER `guard_accounts_referred` BEFORE INSERT ON `accounts`
WHEN EXISTS (SELECT 1 FROM `transactions` t WHERE t.`account_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = t.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`account_id` = NEW.`id` AND b.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = b.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`account_id` = NEW.`id` AND r.`ledger_id` <> NEW.`ledger_id`
    AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = r.`ledger_id`))
  OR EXISTS (SELECT 1 FROM `bank_payloads` x JOIN `transactions` t ON t.`id` = x.`transaction_id` WHERE x.`account_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`id` AND m.`ledger_id` = NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
DROP TRIGGER `guard_institutions_referred`;
--> statement-breakpoint
CREATE TRIGGER `guard_institutions_referred` BEFORE INSERT ON `institutions`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`institution_id` = NEW.`id` AND a.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`institution_id` = NEW.`id` AND m.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
