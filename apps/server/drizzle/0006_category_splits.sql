-- A transaction can be split into categories: its parts are rows of transaction_parts, in order
-- (sort), each with a category or none, an amount and a note. They add up to the transaction's
-- amount, and reports count each part in its own category. The transaction stays one row. Not to be
-- confused with a card payment split between ledgers (transactions.split_of, migration 0003).
-- The table and index are drizzle-kit's (src/db/schema.ts); the view and triggers after them are
-- written by hand.
CREATE TABLE `transaction_parts` (
	`transaction_id` integer NOT NULL,
	`sort` integer NOT NULL,
	`category_id` integer,
	`amount_minor` integer NOT NULL,
	`note` text,
	PRIMARY KEY(`transaction_id`, `sort`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `transaction_parts_category` ON `transaction_parts` (`category_id`);
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit doesn't make views or triggers.

-- What reports add up, as before for a transaction with no parts: its own line, and a line for
-- each link in its bill's category. A transaction with parts has a line for each part in place of
-- its own, in the part's category, and a link to a bill with parts has a line for each of the
-- bill's parts. What's linked is shared between the parts by their amounts, to the cent: a part's
-- share is what the parts up to it (by sort) take, rounded, less what the parts before it take,
-- rounded. So the shares add up to the linked amount, each within a cent of its exact share and
-- none of the other sign.
DROP VIEW `transaction_lines`;
--> statement-breakpoint
CREATE VIEW `transaction_lines` AS
SELECT t.`ledger_id`, t.`id`, t.`account_id`, t.`date`,
  CASE WHEN p.`transaction_id` IS NULL THEN t.`amount_minor` - t.`linked_minor`
    ELSE p.`amount_minor` - (CAST(round(t.`linked_minor` * 1.0 * (SELECT sum(o.`amount_minor`) FROM `transaction_parts` o WHERE o.`transaction_id` = p.`transaction_id` AND o.`sort` <= p.`sort`) / t.`amount_minor`) AS INTEGER)
      - CAST(round(t.`linked_minor` * 1.0 * (SELECT coalesce(sum(o.`amount_minor`), 0) FROM `transaction_parts` o WHERE o.`transaction_id` = p.`transaction_id` AND o.`sort` < p.`sort`) / t.`amount_minor`) AS INTEGER)) END AS `amount_minor`,
  CASE WHEN p.`transaction_id` IS NULL THEN t.`category_id` ELSE p.`category_id` END AS `category_id`,
  t.`payee_key`, t.`deleted_at`, t.`transfer_pair_id`, t.`id` AS `owner_id`, NULL AS `link_kind`
FROM `transactions` t LEFT JOIN `transaction_parts` p ON p.`transaction_id` = t.`id`
WHERE t.`linked_minor` = 0 OR t.`amount_minor` != t.`linked_minor`
UNION ALL
SELECT t.`ledger_id`, t.`id`, t.`account_id`, CASE l.`kind` WHEN 'payback' THEN b.`date` ELSE t.`date` END,
  CASE WHEN p.`transaction_id` IS NULL THEN l.`amount_minor`
    ELSE (CAST(round(l.`amount_minor` * 1.0 * (SELECT sum(o.`amount_minor`) FROM `transaction_parts` o WHERE o.`transaction_id` = p.`transaction_id` AND o.`sort` <= p.`sort`) / b.`amount_minor`) AS INTEGER)
      - CAST(round(l.`amount_minor` * 1.0 * (SELECT coalesce(sum(o.`amount_minor`), 0) FROM `transaction_parts` o WHERE o.`transaction_id` = p.`transaction_id` AND o.`sort` < p.`sort`) / b.`amount_minor`) AS INTEGER)) END,
  CASE WHEN p.`transaction_id` IS NULL THEN b.`category_id` ELSE p.`category_id` END,
  t.`payee_key`, t.`deleted_at`, t.`transfer_pair_id`, l.`money_out_id`, l.`kind`
FROM `transaction_links` l JOIN `transactions` t ON t.`id` = l.`money_in_id` JOIN `transactions` b ON b.`id` = l.`money_out_id`
  LEFT JOIN `transaction_parts` p ON p.`transaction_id` = b.`id`
WHERE b.`deleted_at` IS NULL;
--> statement-breakpoint
-- When a transaction's amount changes (a sync posts a pending charge with its tip, a bank switch,
-- an edit), its largest part takes the difference (the first of them on a tie). If that leaves a
-- part at zero or of the other sign, the split is undone: the transaction keeps its own category,
-- which is its largest part's and is kept so here.
CREATE TRIGGER `parts_follow_amount` AFTER UPDATE OF `amount_minor` ON `transactions`
WHEN NEW.`amount_minor` IS NOT OLD.`amount_minor` AND EXISTS (SELECT 1 FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id`)
BEGIN
  UPDATE `transaction_parts` SET `amount_minor` = `amount_minor` + NEW.`amount_minor` - OLD.`amount_minor`
  WHERE `transaction_id` = NEW.`id` AND `sort` = (SELECT p.`sort` FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id` ORDER BY abs(p.`amount_minor`) DESC, p.`sort` LIMIT 1);
  DELETE FROM `transaction_parts` WHERE `transaction_id` = NEW.`id`
    AND EXISTS (SELECT 1 FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id`
      AND (p.`amount_minor` = 0 OR (p.`amount_minor` > 0) <> (NEW.`amount_minor` > 0)));
  UPDATE `transactions` SET `category_id` = (SELECT p.`category_id` FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id` ORDER BY abs(p.`amount_minor`) DESC, p.`sort` LIMIT 1),
    `category_source` = CASE WHEN (SELECT p.`category_id` FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id` ORDER BY abs(p.`amount_minor`) DESC, p.`sort` LIMIT 1) IS NULL THEN NULL ELSE 'user' END,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `id` = NEW.`id` AND EXISTS (SELECT 1 FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id`)
    AND `category_id` IS NOT (SELECT p.`category_id` FROM `transaction_parts` p WHERE p.`transaction_id` = NEW.`id` ORDER BY abs(p.`amount_minor`) DESC, p.`sort` LIMIT 1);
END;
--> statement-breakpoint
-- A part's category is one its transaction's ledger uses, as a transaction's is
-- (guard_transactions_insert).
CREATE TRIGGER `guard_transaction_parts_insert` BEFORE INSERT ON `transaction_parts`
WHEN EXISTS (SELECT 1 FROM `categories` c JOIN `transactions` t ON t.`id` = NEW.`transaction_id` WHERE c.`id` = NEW.`category_id`
  AND c.`ledger_id` IS NOT t.`ledger_id` AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = t.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transaction_parts_update` BEFORE UPDATE OF `transaction_id`, `category_id` ON `transaction_parts`
WHEN EXISTS (SELECT 1 FROM `categories` c JOIN `transactions` t ON t.`id` = NEW.`transaction_id` WHERE c.`id` = NEW.`category_id`
  AND c.`ledger_id` IS NOT t.`ledger_id` AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = t.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- The same from the other side, for rows inserted after the parts that refer to them
-- (guard_transactions_referred, guard_categories_referred).
CREATE TRIGGER `guard_transactions_referred_parts` BEFORE INSERT ON `transactions`
WHEN EXISTS (SELECT 1 FROM `transaction_parts` x JOIN `categories` c ON c.`id` = x.`category_id` WHERE x.`transaction_id` = NEW.`id`
  AND c.`ledger_id` IS NOT NEW.`ledger_id` AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_categories_referred_parts` BEFORE INSERT ON `categories`
WHEN EXISTS (SELECT 1 FROM `transaction_parts` x JOIN `transactions` t ON t.`id` = x.`transaction_id` WHERE x.`category_id` = NEW.`id`
  AND t.`ledger_id` IS NOT NEW.`ledger_id` AND NOT (NEW.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = t.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- A ledger leaving the shared list has its parts on its own categories first, as its transactions
-- are (guard_ledgers_category_list).
CREATE TRIGGER `guard_ledgers_category_list_parts` BEFORE UPDATE OF `category_list` ON `ledgers`
WHEN NEW.`category_list` = 'own' AND OLD.`category_list` IS NOT 'own'
  AND EXISTS (SELECT 1 FROM `transaction_parts` x JOIN `transactions` t ON t.`id` = x.`transaction_id` JOIN `categories` c ON c.`id` = x.`category_id`
    WHERE t.`ledger_id` = NEW.`id` AND c.`ledger_id` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'the ledger still uses the shared category list');
END;
--> statement-breakpoint
-- A transaction moves to another ledger with no parts: their categories are the old ledger's. The
-- move takes them off first and puts them back in the new ledger's categories (tx_move_keeps_refs
-- has the rest).
CREATE TRIGGER `tx_move_keeps_parts` BEFORE UPDATE OF `ledger_id` ON `transactions`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id` AND EXISTS (SELECT 1 FROM `transaction_parts` x WHERE x.`transaction_id` = OLD.`id`)
BEGIN
  SELECT RAISE(ABORT, 'a transaction moves only to a ledger that has its account, with nothing still attached');
END;
