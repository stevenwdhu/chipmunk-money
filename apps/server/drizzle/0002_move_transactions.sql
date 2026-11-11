-- A transaction can move to another ledger that has its account (a shared account's home, or a
-- ledger it's shared with). Before, a transaction never changed ledger. And transactions.removed_at
-- says a sync deleted a row because the bank no longer has it, not a person.
-- The column and index are drizzle-kit's (src/db/schema.ts); the triggers after them are written by
-- hand.
ALTER TABLE `transactions` ADD `removed_at` text;--> statement-breakpoint
CREATE INDEX `tx_transfer_pair` ON `transactions` (`transfer_pair_id`) WHERE "transactions"."transfer_pair_id" IS NOT NULL;
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit doesn't make views or triggers.

-- A transaction moves only to a ledger that has its account, staying on that account, and only
-- once nothing is attached to it: no link on either side, tag, recurring due or not-payment, rejected pair on either side, bank
-- payload, or other transaction naming it as its transfer's other side. Each of those would cross
-- ledgers after the move (the move clears them first). Its own category, recurring item, import
-- batch and transfer pair are checked against the new ledger by guard_transactions_update, which
-- fires on the same UPDATE.
DROP TRIGGER `keep_ledger_transactions`;
--> statement-breakpoint
CREATE TRIGGER `tx_move_keeps_refs` BEFORE UPDATE OF `ledger_id` ON `transactions`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
  AND (
    NEW.`account_id` IS NOT OLD.`account_id`
    OR (NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` = NEW.`ledger_id`)
      AND NOT EXISTS (SELECT 1 FROM `account_ledgers` m WHERE m.`account_id` = NEW.`account_id` AND m.`ledger_id` = NEW.`ledger_id`))
    OR EXISTS (SELECT 1 FROM `transaction_links` l WHERE l.`money_in_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `transaction_links` l WHERE l.`money_out_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `transaction_tags` g WHERE g.`transaction_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `recurring_payment_dues` d WHERE d.`transaction_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `recurring_not_payments` n WHERE n.`transaction_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `transfer_rejections` r WHERE r.`in_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `transfer_rejections` r WHERE r.`out_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `bank_payloads` x WHERE x.`transaction_id` = OLD.`id`)
    OR EXISTS (SELECT 1 FROM `transactions` p WHERE p.`transfer_pair_id` = OLD.`id` AND p.`id` <> OLD.`id`)
  )
BEGIN
  SELECT RAISE(ABORT, 'a transaction moves only to a ledger that has its account, with nothing still attached');
END;
