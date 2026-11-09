-- The ledger schema as of the squash: what every earlier migration added up to.
-- Databases that ran those migrations skip this one (it has the last one's timestamp).
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`opening_date` text,
	`notes` text,
	`archived_at` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`external_id` text,
	`import_mapping` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
, `institution_id` integer REFERENCES institutions(id));
--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slot` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`balance_minor` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer,
	`name` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`exclude_from_totals` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `category_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
, `color` text DEFAULT '#64748b' NOT NULL);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`file_name` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurring_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`payee_key` text NOT NULL,
	`category_id` integer,
	`account_id` integer,
	`expected_amount_minor` integer NOT NULL,
	`amount_tolerance_pct` real DEFAULT 10 NOT NULL,
	`cadence` text NOT NULL,
	`anchor_date` text NOT NULL,
	`next_due_date` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`detection_score` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `total_payments` integer, `paid_before` integer DEFAULT 0 NOT NULL, `title` text, `second_day` integer,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`transaction_id`, `tag_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`payee` text NOT NULL,
	`payee_key` text NOT NULL,
	`category_id` integer,
	`category_source` text,
	`category_confidence` real,
	`needs_review` integer DEFAULT false NOT NULL,
	`notes` text,
	`recurring_item_id` integer,
	`transfer_pair_id` integer,
	`status` text DEFAULT 'cleared' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`import_batch_id` integer,
	`external_id` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `bank_category` text, `bank_category_confident` integer DEFAULT false NOT NULL, `corrected_at` text, `name` text, `datetime` text, `linked_minor` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurring_item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`actor` text NOT NULL,
	`api_key_id` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`summary` text NOT NULL,
	`before` text,
	`after` text
);
--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `category_labels` (
	`category_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`category_id`, `label_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payee_rules` (
	`payee_key` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`category_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "payee_category_stats" (
	`payee_key` text NOT NULL,
	`direction` text NOT NULL,
	`category_id` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`payee_key`, `direction`, `category_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bank_payloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`provider` text NOT NULL,
	`remote_id` text NOT NULL,
	`transaction_id` integer,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `recurring_not_payments` (
	`item_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	PRIMARY KEY(`item_id`, `transaction_id`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurring_payees` (
	`item_id` integer NOT NULL,
	`payee_key` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`item_id`, `payee_key`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurring_price_changes` (
	`item_id` integer NOT NULL,
	`from_date` text NOT NULL,
	`previous_amount_minor` integer NOT NULL,
	PRIMARY KEY(`item_id`, `from_date`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurring_payment_dues` (
	`item_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`due_date` text NOT NULL,
	PRIMARY KEY(`item_id`, `transaction_id`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transfer_rejections` (
	`in_id` integer NOT NULL,
	`out_id` integer NOT NULL,
	PRIMARY KEY(`in_id`, `out_id`),
	FOREIGN KEY (`in_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`out_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transaction_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`money_in_id` integer NOT NULL,
	`money_out_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`money_in_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`money_out_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `custom_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
, `sort` integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_snapshots_account_date` ON `balance_snapshots` (`account_id`,`date`);
--> statement-breakpoint
CREATE INDEX `categories_group` ON `categories` (`group_id`);
--> statement-breakpoint
CREATE INDEX `recurring_payee` ON `recurring_items` (`payee_key`);
--> statement-breakpoint
CREATE INDEX `recurring_status` ON `recurring_items` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name` ON `tags` (`name`);
--> statement-breakpoint
CREATE INDEX `transaction_tags_tag` ON `transaction_tags` (`tag_id`);
--> statement-breakpoint
CREATE INDEX `tx_date` ON `transactions` (`date`);
--> statement-breakpoint
CREATE INDEX `tx_account_date` ON `transactions` (`account_id`,`date`);
--> statement-breakpoint
CREATE INDEX `tx_category_date` ON `transactions` (`category_id`,`date`);
--> statement-breakpoint
CREATE INDEX `tx_payee_key` ON `transactions` (`payee_key`);
--> statement-breakpoint
CREATE INDEX `tx_recurring` ON `transactions` (`recurring_item_id`);
--> statement-breakpoint
CREATE INDEX `tx_needs_review` ON `transactions` (`needs_review`) WHERE "transactions"."needs_review" = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `tx_external_id` ON `transactions` (`account_id`,`external_id`) WHERE "transactions"."external_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `activity_actor` ON `activity` (`actor`);
--> statement-breakpoint
CREATE INDEX `activity_entity` ON `activity` (`entity`);
--> statement-breakpoint
CREATE INDEX `accounts_institution` ON `accounts` (`institution_id`);
--> statement-breakpoint
CREATE INDEX `category_labels_label` ON `category_labels` (`label_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name` ON `labels` (`name`);
--> statement-breakpoint
CREATE INDEX `bank_payloads_remote` ON `bank_payloads` (`account_id`,`remote_id`);
--> statement-breakpoint
CREATE INDEX `bank_payloads_transaction` ON `bank_payloads` (`transaction_id`);
--> statement-breakpoint
CREATE INDEX `recurring_payees_key` ON `recurring_payees` (`payee_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_pair` ON `transaction_links` (`money_in_id`,`money_out_id`);
--> statement-breakpoint
CREATE INDEX `links_out` ON `transaction_links` (`money_out_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_reports_name` ON `custom_reports` (lower("name"));
--> statement-breakpoint
CREATE VIEW `transaction_lines` AS
SELECT t.`id`, t.`account_id`, t.`date`, t.`amount_minor` - t.`linked_minor` AS `amount_minor`, t.`category_id`,
  t.`payee_key`, t.`deleted_at`, t.`transfer_pair_id`, t.`id` AS `owner_id`, NULL AS `link_kind`
FROM `transactions` t WHERE t.`linked_minor` = 0 OR t.`amount_minor` != t.`linked_minor`
UNION ALL
SELECT t.`id`, t.`account_id`, CASE l.`kind` WHEN 'payback' THEN b.`date` ELSE t.`date` END, l.`amount_minor`, b.`category_id`,
  t.`payee_key`, t.`deleted_at`, t.`transfer_pair_id`, l.`money_out_id`, l.`kind`
FROM `transaction_links` l JOIN `transactions` t ON t.`id` = l.`money_in_id` JOIN `transactions` b ON b.`id` = l.`money_out_id`
WHERE b.`deleted_at` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `links_follow_bill` AFTER UPDATE OF `category_id` ON `transactions`
WHEN NEW.`category_id` IS NOT OLD.`category_id`
BEGIN
  UPDATE `transactions` SET `category_id` = NEW.`category_id`, `category_confidence` = NULL,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `category_source` = 'linked'
    AND `id` IN (SELECT `money_in_id` FROM `transaction_links` WHERE `money_out_id` = NEW.`id`)
    AND (SELECT count(*) FROM `transaction_links` l WHERE l.`money_in_id` = `transactions`.`id`) = 1
    AND `category_id` IS NOT NEW.`category_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `links_sum_insert` AFTER INSERT ON `transaction_links`
BEGIN
  UPDATE `transactions` SET `linked_minor` = (
    SELECT coalesce(sum(l.`amount_minor`), 0) FROM `transaction_links` l JOIN `transactions` b ON b.`id` = l.`money_out_id`
    WHERE l.`money_in_id` = NEW.`money_in_id` AND b.`deleted_at` IS NULL
  ) WHERE `id` = NEW.`money_in_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `links_sum_delete` AFTER DELETE ON `transaction_links`
BEGIN
  UPDATE `transactions` SET `linked_minor` = (
    SELECT coalesce(sum(l.`amount_minor`), 0) FROM `transaction_links` l JOIN `transactions` b ON b.`id` = l.`money_out_id`
    WHERE l.`money_in_id` = OLD.`money_in_id` AND b.`deleted_at` IS NULL
  ) WHERE `id` = OLD.`money_in_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `links_sum_update` AFTER UPDATE ON `transaction_links`
BEGIN
  UPDATE `transactions` SET `linked_minor` = (
    SELECT coalesce(sum(l.`amount_minor`), 0) FROM `transaction_links` l JOIN `transactions` b ON b.`id` = l.`money_out_id`
    WHERE l.`money_in_id` = `transactions`.`id` AND b.`deleted_at` IS NULL
  ) WHERE `id` IN (NEW.`money_in_id`, OLD.`money_in_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `links_sum_bill` AFTER UPDATE OF `deleted_at` ON `transactions`
WHEN NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  UPDATE `transactions` SET `linked_minor` = (
    SELECT coalesce(sum(l.`amount_minor`), 0) FROM `transaction_links` l JOIN `transactions` b ON b.`id` = l.`money_out_id`
    WHERE l.`money_in_id` = `transactions`.`id` AND b.`deleted_at` IS NULL
  ) WHERE `id` IN (SELECT `money_in_id` FROM `transaction_links` WHERE `money_out_id` = NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `refunds_follow_name` AFTER UPDATE OF `name` ON `transactions`
WHEN NEW.`name` IS NOT OLD.`name`
BEGIN
  UPDATE `transactions` SET `name` = NEW.`name`, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `id` IN (SELECT `money_in_id` FROM `transaction_links` WHERE `money_out_id` = NEW.`id` AND `kind` = 'refund')
    AND (SELECT count(*) FROM `transaction_links` l WHERE l.`money_in_id` = `transactions`.`id`) = 1
    AND `name` IS NOT NEW.`name`;
END;
--> statement-breakpoint
CREATE TRIGGER `refunds_take_name` AFTER INSERT ON `transaction_links`
WHEN NEW.`kind` = 'refund'
BEGIN
  UPDATE `transactions` SET `name` = (SELECT p.`name` FROM `transactions` p WHERE p.`id` = NEW.`money_out_id`),
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `id` = NEW.`money_in_id`
    AND (SELECT count(*) FROM `transaction_links` l WHERE l.`money_in_id` = NEW.`money_in_id`) = 1
    AND `name` IS NOT (SELECT p.`name` FROM `transactions` p WHERE p.`id` = NEW.`money_out_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `refunds_keep_name` AFTER DELETE ON `transaction_links`
BEGIN
  UPDATE `transactions` SET `name` = (
    SELECT p.`name` FROM `transaction_links` l JOIN `transactions` p ON p.`id` = l.`money_out_id` WHERE l.`money_in_id` = OLD.`money_in_id`
  ), `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `id` = OLD.`money_in_id`
    AND (SELECT count(*) FROM `transaction_links` l WHERE l.`money_in_id` = OLD.`money_in_id`) = 1
    AND (SELECT l.`kind` FROM `transaction_links` l WHERE l.`money_in_id` = OLD.`money_in_id`) = 'refund'
    AND `name` IS NOT (
      SELECT p.`name` FROM `transaction_links` l JOIN `transactions` p ON p.`id` = l.`money_out_id` WHERE l.`money_in_id` = OLD.`money_in_id`
    );
END;
