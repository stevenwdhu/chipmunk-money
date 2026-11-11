-- The schema of chipmunk.db: every ledger's data and what the app shares between them.
-- The tables and indexes are drizzle-kit's (src/db/schema.ts); the views and triggers at the end are
-- written by hand.
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`opening_date` text,
	`institution_id` integer NOT NULL,
	`notes` text,
	`archived_at` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`external_id` text,
	`import_mapping` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_ledger` ON `accounts` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `accounts_institution` ON `accounts` (`institution_id`);--> statement-breakpoint
CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`actor` text NOT NULL,
	`api_key_id` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`summary` text NOT NULL,
	`before` text,
	`after` text,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_ledger_id` ON `activity` (`ledger_id`,`id`);--> statement-breakpoint
CREATE INDEX `activity_ledger_actor` ON `activity` (`ledger_id`,`actor`);--> statement-breakpoint
CREATE INDEX `activity_ledger_entity` ON `activity` (`ledger_id`,`entity`);--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text,
	`slot` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_calls_ledger_created` ON `ai_calls` (`ledger_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`ledgers` text,
	`expires_at` text,
	`last_used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
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
CREATE UNIQUE INDEX `balance_snapshots_account_date` ON `balance_snapshots` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`remote_institution_id` text,
	`currency` text NOT NULL,
	`balance_minor` integer,
	`available_minor` integer,
	`balance_date` text,
	`account_id` integer,
	`sync_from` text,
	`last_synced_at` text,
	`fetched_at` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_remote` ON `bank_accounts` (`connection_id`,`remote_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_link` ON `bank_accounts` (`account_id`) WHERE "bank_accounts"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `bank_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`remote_id` text,
	`cursor` text,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`notice` text,
	`request_log` text DEFAULT '[]' NOT NULL,
	`last_attempt_at` text,
	`last_synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
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
CREATE INDEX `bank_payloads_remote` ON `bank_payloads` (`account_id`,`remote_id`);--> statement-breakpoint
CREATE INDEX `bank_payloads_transaction` ON `bank_payloads` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `bank_transactions` (
	`bank_account_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`date` text NOT NULL,
	`pending` integer NOT NULL,
	`data` text NOT NULL,
	`removed_at` text,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`bank_account_id`, `remote_id`),
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bank_transactions_date` ON `bank_transactions` (`bank_account_id`,`date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text,
	`group_id` integer,
	`name` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`exclude_from_totals` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "categories_shared_not_archived" CHECK("categories"."ledger_id" IS NOT NULL OR "categories"."archived_at" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `categories_ledger` ON `categories` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `categories_group` ON `categories` (`group_id`);--> statement-breakpoint
CREATE TABLE `category_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `category_groups_ledger` ON `category_groups` (`ledger_id`);--> statement-breakpoint
CREATE TABLE `category_labels` (
	`category_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`category_id`, `label_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `category_labels_label` ON `category_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `custom_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_reports_name` ON `custom_reports` (`ledger_id`,lower("name"));--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text NOT NULL,
	`actor` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` integer,
	`body` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`key`, `actor`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`file_name` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_batches_ledger` ON `import_batches` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `import_batches_account` ON `import_batches` (`account_id`);--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `institutions_ledger` ON `institutions` (`ledger_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_shared_name` ON `labels` (`name`) WHERE "labels"."ledger_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `labels_ledger_name` ON `labels` (`ledger_id`,`name`) WHERE "labels"."ledger_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `ledger_category_off` (
	`ledger_id` text NOT NULL,
	`category_id` integer NOT NULL,
	`archived_at` text NOT NULL,
	PRIMARY KEY(`ledger_id`, `category_id`),
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ledger_category_off_category` ON `ledger_category_off` (`category_id`);--> statement-breakpoint
CREATE TABLE `ledger_settings` (
	`ledger_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`ledger_id`, `key`),
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`icon` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`category_list` text DEFAULT 'shared' NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "ledgers_category_list" CHECK("ledgers"."category_list" IN ('shared', 'own'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledgers_slug` ON `ledgers` (`slug`);--> statement-breakpoint
CREATE TABLE `payee_category_stats` (
	`ledger_id` text NOT NULL,
	`payee_key` text NOT NULL,
	`direction` text NOT NULL,
	`category_id` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`ledger_id`, `payee_key`, `direction`, `category_id`),
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payee_category_stats_category` ON `payee_category_stats` (`category_id`);--> statement-breakpoint
CREATE TABLE `payee_name_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`match` text,
	`patterns` text NOT NULL,
	`name` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payee_rules` (
	`ledger_id` text NOT NULL,
	`payee_key` text NOT NULL,
	`mode` text NOT NULL,
	`category_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`ledger_id`, `payee_key`),
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payee_rules_category` ON `payee_rules` (`category_id`);--> statement-breakpoint
CREATE TABLE `payee_tidy` (
	`original` text PRIMARY KEY NOT NULL,
	`tidied` text NOT NULL,
	`model` text,
	`prompt` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
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
	`second_day` integer,
	`total_payments` integer,
	`paid_before` integer DEFAULT 0 NOT NULL,
	`full_price_minor` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurring_ledger_status` ON `recurring_items` (`ledger_id`,`status`);--> statement-breakpoint
CREATE INDEX `recurring_ledger_payee` ON `recurring_items` (`ledger_id`,`payee_key`);--> statement-breakpoint
CREATE INDEX `recurring_account` ON `recurring_items` (`account_id`);--> statement-breakpoint
CREATE INDEX `recurring_category` ON `recurring_items` (`category_id`);--> statement-breakpoint
CREATE TABLE `recurring_not_payments` (
	`item_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	PRIMARY KEY(`item_id`, `transaction_id`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recurring_not_payments_transaction` ON `recurring_not_payments` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `recurring_payees` (
	`item_id` integer NOT NULL,
	`payee_key` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`item_id`, `payee_key`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recurring_payees_key` ON `recurring_payees` (`payee_key`);--> statement-breakpoint
CREATE TABLE `recurring_payment_dues` (
	`item_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`due_date` text NOT NULL,
	`one_off` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`item_id`, `transaction_id`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recurring_payment_dues_transaction` ON `recurring_payment_dues` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `recurring_price_changes` (
	`item_id` integer NOT NULL,
	`from_date` text NOT NULL,
	`previous_amount_minor` integer NOT NULL,
	PRIMARY KEY(`item_id`, `from_date`),
	FOREIGN KEY (`item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name` ON `tags` (`ledger_id`,`name`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `links_pair` ON `transaction_links` (`money_in_id`,`money_out_id`);--> statement-breakpoint
CREATE INDEX `links_out` ON `transaction_links` (`money_out_id`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`transaction_id`, `tag_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transaction_tags_tag` ON `transaction_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`datetime` text,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`payee` text NOT NULL,
	`payee_key` text NOT NULL,
	`name` text,
	`category_id` integer,
	`category_source` text,
	`category_confidence` real,
	`needs_review` integer DEFAULT false NOT NULL,
	`notes` text,
	`recurring_item_id` integer,
	`transfer_pair_id` integer,
	`linked_minor` integer DEFAULT 0 NOT NULL,
	`bank_category` text,
	`bank_category_confident` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'cleared' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`import_batch_id` integer,
	`external_id` text,
	`corrected_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurring_item_id`) REFERENCES `recurring_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tx_ledger_date` ON `transactions` (`ledger_id`,`date`);--> statement-breakpoint
CREATE INDEX `tx_ledger_category_date` ON `transactions` (`ledger_id`,`category_id`,`date`);--> statement-breakpoint
CREATE INDEX `tx_ledger_payee_key` ON `transactions` (`ledger_id`,`payee_key`);--> statement-breakpoint
CREATE INDEX `tx_ledger_needs_review` ON `transactions` (`ledger_id`) WHERE "transactions"."needs_review" = 1;--> statement-breakpoint
CREATE INDEX `tx_ledger_deleted` ON `transactions` (`ledger_id`,`deleted_at`) WHERE "transactions"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tx_account_date` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `tx_category` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `tx_recurring` ON `transactions` (`recurring_item_id`);--> statement-breakpoint
CREATE INDEX `tx_import_batch` ON `transactions` (`import_batch_id`) WHERE "transactions"."import_batch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tx_external_id` ON `transactions` (`account_id`,`external_id`) WHERE "transactions"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `transfer_rejections` (
	`in_id` integer NOT NULL,
	`out_id` integer NOT NULL,
	PRIMARY KEY(`in_id`, `out_id`),
	FOREIGN KEY (`in_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`out_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transfer_rejections_out` ON `transfer_rejections` (`out_id`);
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit doesn't make views or triggers.

-- Views ---------------------------------------------------------------------------------
-- Reads of a ledger's accounts, categories, groups and labels go through these, pinned by
-- ledger_id = @ledger (src/db/scope.ts). Writes go to the tables.

-- A ledger's accounts. For now every account is in one ledger (its own); this is the one place
-- that changes when an account can be in several.
CREATE VIEW `ledger_accounts` AS
SELECT a.`ledger_id`, a.`id`, a.`name`, a.`type`, a.`currency`, a.`opening_balance_minor`, a.`opening_date`,
  a.`institution_id`, a.`notes`, a.`archived_at`, a.`sort`, a.`external_id`, a.`import_mapping`,
  a.`created_at`, a.`updated_at`
FROM `accounts` a;
--> statement-breakpoint
-- The categories each ledger uses: its own, or the shared list (shared = 1) with what it turned off.
CREATE VIEW `ledger_categories` AS
SELECT c.`ledger_id`, c.`id`, c.`group_id`, c.`name`, c.`is_income`, c.`exclude_from_totals`, c.`archived_at`,
  c.`sort`, c.`created_at`, c.`updated_at`, 0 AS `shared`
FROM `categories` c WHERE c.`ledger_id` IS NOT NULL
UNION ALL
SELECT l.`id`, c.`id`, c.`group_id`, c.`name`, c.`is_income`, c.`exclude_from_totals`, o.`archived_at`,
  c.`sort`, c.`created_at`, c.`updated_at`, 1
FROM `categories` c JOIN `ledgers` l ON l.`category_list` = 'shared'
LEFT JOIN `ledger_category_off` o ON o.`ledger_id` = l.`id` AND o.`category_id` = c.`id`
WHERE c.`ledger_id` IS NULL;
--> statement-breakpoint
CREATE VIEW `ledger_category_groups` AS
SELECT g.`ledger_id`, g.`id`, g.`name`, g.`color`, g.`sort`, g.`created_at`, g.`updated_at`, 0 AS `shared`
FROM `category_groups` g WHERE g.`ledger_id` IS NOT NULL
UNION ALL
SELECT l.`id`, g.`id`, g.`name`, g.`color`, g.`sort`, g.`created_at`, g.`updated_at`, 1
FROM `category_groups` g JOIN `ledgers` l ON l.`category_list` = 'shared'
WHERE g.`ledger_id` IS NULL;
--> statement-breakpoint
CREATE VIEW `ledger_labels` AS
SELECT b.`ledger_id`, b.`id`, b.`name`, b.`color`, b.`sort`, b.`created_at`, b.`updated_at`, 0 AS `shared`
FROM `labels` b WHERE b.`ledger_id` IS NOT NULL
UNION ALL
SELECT l.`id`, b.`id`, b.`name`, b.`color`, b.`sort`, b.`created_at`, b.`updated_at`, 1
FROM `labels` b JOIN `ledgers` l ON l.`category_list` = 'shared'
WHERE b.`ledger_id` IS NULL;
--> statement-breakpoint
-- What reports add up: each transaction's own part, and each link in its bill's category (a
-- payback on the bill's date). A link's bill is always in the money in's ledger (guard triggers).
CREATE VIEW `transaction_lines` AS
SELECT t.`ledger_id`, t.`id`, t.`account_id`, t.`date`, t.`amount_minor` - t.`linked_minor` AS `amount_minor`, t.`category_id`,
  t.`payee_key`, t.`deleted_at`, t.`transfer_pair_id`, t.`id` AS `owner_id`, NULL AS `link_kind`
FROM `transactions` t WHERE t.`linked_minor` = 0 OR t.`amount_minor` != t.`linked_minor`
UNION ALL
SELECT t.`ledger_id`, t.`id`, t.`account_id`, CASE l.`kind` WHEN 'payback' THEN b.`date` ELSE t.`date` END, l.`amount_minor`, b.`category_id`,
  t.`payee_key`, t.`deleted_at`, t.`transfer_pair_id`, l.`money_out_id`, l.`kind`
FROM `transaction_links` l JOIN `transactions` t ON t.`id` = l.`money_in_id` JOIN `transactions` b ON b.`id` = l.`money_out_id`
WHERE b.`deleted_at` IS NULL;
--> statement-breakpoint
-- Content triggers ---------------------------------------------------------------------
-- They keep links' sums and refunds' names and categories, by row id.
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
--> statement-breakpoint
-- Guard triggers ------------------------------------------------------------------------
-- What a row refers to is in its own ledger. Each one raises only when the row referred to exists
-- and is in another ledger. One that doesn't exist yet (rows inserted out of order, under
-- defer_foreign_keys) is checked from the other side when it's inserted: the guard_*_referred
-- triggers further down. The foreign key only says the row exists, not which ledger it's in.
CREATE TRIGGER `guard_transactions_insert` BEFORE INSERT ON `transactions`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`id` = NEW.`recurring_item_id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`id` = NEW.`import_batch_id` AND b.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transactions` p WHERE p.`id` = NEW.`transfer_pair_id` AND p.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transactions_update` BEFORE UPDATE OF `ledger_id`, `account_id`, `category_id`, `recurring_item_id`, `import_batch_id`, `transfer_pair_id` ON `transactions`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`id` = NEW.`recurring_item_id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`id` = NEW.`import_batch_id` AND b.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transactions` p WHERE p.`id` = NEW.`transfer_pair_id` AND p.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_accounts_insert` BEFORE INSERT ON `accounts`
WHEN EXISTS (SELECT 1 FROM `institutions` i WHERE i.`id` = NEW.`institution_id` AND i.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_accounts_update` BEFORE UPDATE OF `ledger_id`, `institution_id` ON `accounts`
WHEN EXISTS (SELECT 1 FROM `institutions` i WHERE i.`id` = NEW.`institution_id` AND i.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_import_batches_insert` BEFORE INSERT ON `import_batches`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_import_batches_update` BEFORE UPDATE OF `ledger_id`, `account_id` ON `import_batches`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_items_insert` BEFORE INSERT ON `recurring_items`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_items_update` BEFORE UPDATE OF `ledger_id`, `account_id`, `category_id` ON `recurring_items`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`id` = NEW.`account_id` AND a.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_payee_rules_insert` BEFORE INSERT ON `payee_rules`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_payee_rules_update` BEFORE UPDATE OF `ledger_id`, `category_id` ON `payee_rules`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_payee_category_stats_insert` BEFORE INSERT ON `payee_category_stats`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_payee_category_stats_update` BEFORE UPDATE OF `ledger_id`, `category_id` ON `payee_category_stats`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NEW.`ledger_id`
    AND NOT (c.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = NEW.`ledger_id`) = 'shared'))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transaction_links_insert` BEFORE INSERT ON `transaction_links`
WHEN (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`money_in_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`money_out_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transaction_links_update` BEFORE UPDATE OF `money_in_id`, `money_out_id` ON `transaction_links`
WHEN (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`money_in_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`money_out_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transfer_rejections_insert` BEFORE INSERT ON `transfer_rejections`
WHEN (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`in_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`out_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transfer_rejections_update` BEFORE UPDATE OF `in_id`, `out_id` ON `transfer_rejections`
WHEN (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`in_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`out_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transaction_tags_insert` BEFORE INSERT ON `transaction_tags`
WHEN (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`) <> (SELECT `ledger_id` FROM `tags` WHERE `id` = NEW.`tag_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_transaction_tags_update` BEFORE UPDATE OF `transaction_id`, `tag_id` ON `transaction_tags`
WHEN (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`) <> (SELECT `ledger_id` FROM `tags` WHERE `id` = NEW.`tag_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_not_payments_insert` BEFORE INSERT ON `recurring_not_payments`
WHEN (SELECT `ledger_id` FROM `recurring_items` WHERE `id` = NEW.`item_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_not_payments_update` BEFORE UPDATE OF `item_id`, `transaction_id` ON `recurring_not_payments`
WHEN (SELECT `ledger_id` FROM `recurring_items` WHERE `id` = NEW.`item_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_payment_dues_insert` BEFORE INSERT ON `recurring_payment_dues`
WHEN (SELECT `ledger_id` FROM `recurring_items` WHERE `id` = NEW.`item_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_payment_dues_update` BEFORE UPDATE OF `item_id`, `transaction_id` ON `recurring_payment_dues`
WHEN (SELECT `ledger_id` FROM `recurring_items` WHERE `id` = NEW.`item_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_bank_payloads_insert` BEFORE INSERT ON `bank_payloads`
WHEN (SELECT `ledger_id` FROM `accounts` WHERE `id` = NEW.`account_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_bank_payloads_update` BEFORE UPDATE OF `account_id`, `transaction_id` ON `bank_payloads`
WHEN (SELECT `ledger_id` FROM `accounts` WHERE `id` = NEW.`account_id`) <> (SELECT `ledger_id` FROM `transactions` WHERE `id` = NEW.`transaction_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- A category is in a group of its own list, and labelled from its own list.
CREATE TRIGGER `guard_categories_insert` BEFORE INSERT ON `categories`
WHEN EXISTS (SELECT 1 FROM `category_groups` g WHERE g.`id` = NEW.`group_id` AND g.`ledger_id` IS NOT NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_categories_update` BEFORE UPDATE OF `ledger_id`, `group_id` ON `categories`
WHEN EXISTS (SELECT 1 FROM `category_groups` g WHERE g.`id` = NEW.`group_id` AND g.`ledger_id` IS NOT NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_category_labels_insert` BEFORE INSERT ON `category_labels`
WHEN EXISTS (SELECT 1 FROM `categories` c JOIN `labels` b ON b.`id` = NEW.`label_id` WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT b.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_category_labels_update` BEFORE UPDATE OF `category_id`, `label_id` ON `category_labels`
WHEN EXISTS (SELECT 1 FROM `categories` c JOIN `labels` b ON b.`id` = NEW.`label_id` WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT b.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- Only shared categories are turned off per ledger; a ledger's own have their archived_at.
CREATE TRIGGER `guard_ledger_category_off_insert` BEFORE INSERT ON `ledger_category_off`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_ledger_category_off_update` BEFORE UPDATE OF `category_id` ON `ledger_category_off`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`id` = NEW.`category_id` AND c.`ledger_id` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- The same rules from the other side: a row inserted after rows that already refer to its id
-- (out of order, under defer_foreign_keys, as a converter or importer may) must be in their ledger.
-- Each lookup is by an indexed foreign key column, so an insert pays a few index probes.
CREATE TRIGGER `guard_transactions_referred` BEFORE INSERT ON `transactions`
WHEN EXISTS (SELECT 1 FROM `transaction_links` l JOIN `transactions` o ON o.`id` = l.`money_out_id` WHERE l.`money_in_id` = NEW.`id` AND o.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transaction_links` l JOIN `transactions` o ON o.`id` = l.`money_in_id` WHERE l.`money_out_id` = NEW.`id` AND o.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transfer_rejections` r JOIN `transactions` o ON o.`id` = r.`out_id` WHERE r.`in_id` = NEW.`id` AND o.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transfer_rejections` r JOIN `transactions` o ON o.`id` = r.`in_id` WHERE r.`out_id` = NEW.`id` AND o.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `transaction_tags` x JOIN `tags` g ON g.`id` = x.`tag_id` WHERE x.`transaction_id` = NEW.`id` AND g.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `recurring_not_payments` x JOIN `recurring_items` r ON r.`id` = x.`item_id` WHERE x.`transaction_id` = NEW.`id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `recurring_payment_dues` x JOIN `recurring_items` r ON r.`id` = x.`item_id` WHERE x.`transaction_id` = NEW.`id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `bank_payloads` x JOIN `accounts` a ON a.`id` = x.`account_id` WHERE x.`transaction_id` = NEW.`id` AND a.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_accounts_referred` BEFORE INSERT ON `accounts`
WHEN EXISTS (SELECT 1 FROM `transactions` t WHERE t.`account_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`account_id` = NEW.`id` AND b.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`account_id` = NEW.`id` AND r.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `bank_payloads` x JOIN `transactions` t ON t.`id` = x.`transaction_id` WHERE x.`account_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_institutions_referred` BEFORE INSERT ON `institutions`
WHEN EXISTS (SELECT 1 FROM `accounts` a WHERE a.`institution_id` = NEW.`id` AND a.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_import_batches_referred` BEFORE INSERT ON `import_batches`
WHEN EXISTS (SELECT 1 FROM `transactions` t WHERE t.`import_batch_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_recurring_items_referred` BEFORE INSERT ON `recurring_items`
WHEN EXISTS (SELECT 1 FROM `transactions` t WHERE t.`recurring_item_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `recurring_not_payments` x JOIN `transactions` t ON t.`id` = x.`transaction_id` WHERE x.`item_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
  OR EXISTS (SELECT 1 FROM `recurring_payment_dues` x JOIN `transactions` t ON t.`id` = x.`transaction_id` WHERE x.`item_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_tags_referred` BEFORE INSERT ON `tags`
WHEN EXISTS (SELECT 1 FROM `transaction_tags` x JOIN `transactions` t ON t.`id` = x.`transaction_id` WHERE x.`tag_id` = NEW.`id` AND t.`ledger_id` <> NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_categories_referred` BEFORE INSERT ON `categories`
WHEN EXISTS (SELECT 1 FROM `transactions` t WHERE t.`category_id` = NEW.`id` AND t.`ledger_id` IS NOT NEW.`ledger_id` AND NOT (NEW.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = t.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `recurring_items` r WHERE r.`category_id` = NEW.`id` AND r.`ledger_id` IS NOT NEW.`ledger_id` AND NOT (NEW.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = r.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `payee_rules` r WHERE r.`category_id` = NEW.`id` AND r.`ledger_id` IS NOT NEW.`ledger_id` AND NOT (NEW.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = r.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `payee_category_stats` r WHERE r.`category_id` = NEW.`id` AND r.`ledger_id` IS NOT NEW.`ledger_id` AND NOT (NEW.`ledger_id` IS NULL AND (SELECT k.`category_list` FROM `ledgers` k WHERE k.`id` = r.`ledger_id`) = 'shared'))
  OR EXISTS (SELECT 1 FROM `category_labels` x JOIN `labels` b ON b.`id` = x.`label_id` WHERE x.`category_id` = NEW.`id` AND b.`ledger_id` IS NOT NEW.`ledger_id`)
  OR (NEW.`ledger_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `ledger_category_off` o WHERE o.`category_id` = NEW.`id`))
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_labels_referred` BEFORE INSERT ON `labels`
WHEN EXISTS (SELECT 1 FROM `category_labels` x JOIN `categories` c ON c.`id` = x.`category_id` WHERE x.`label_id` = NEW.`id` AND c.`ledger_id` IS NOT NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
CREATE TRIGGER `guard_category_groups_referred` BEFORE INSERT ON `category_groups`
WHEN EXISTS (SELECT 1 FROM `categories` c WHERE c.`group_id` = NEW.`id` AND c.`ledger_id` IS NOT NEW.`ledger_id`)
BEGIN
  SELECT RAISE(ABORT, 'cross-ledger reference');
END;
--> statement-breakpoint
-- Leaving the shared list: the ledger's rows must be on its own categories first, or they'd
-- point at categories it no longer has (and later writes to them would fail the guards). Joining
-- goes the other way round: set 'shared' first, then remap, then delete the own rows.
CREATE TRIGGER `guard_ledgers_category_list` BEFORE UPDATE OF `category_list` ON `ledgers`
WHEN NEW.`category_list` = 'own' AND OLD.`category_list` IS NOT 'own' AND (
  EXISTS (SELECT 1 FROM `categories` c JOIN `transactions` t ON t.`ledger_id` = NEW.`id` AND t.`category_id` = c.`id` WHERE c.`ledger_id` IS NULL)
  OR EXISTS (SELECT 1 FROM `recurring_items` r JOIN `categories` c ON c.`id` = r.`category_id` WHERE r.`ledger_id` = NEW.`id` AND c.`ledger_id` IS NULL)
  OR EXISTS (SELECT 1 FROM `payee_rules` r JOIN `categories` c ON c.`id` = r.`category_id` WHERE r.`ledger_id` = NEW.`id` AND c.`ledger_id` IS NULL)
  OR EXISTS (SELECT 1 FROM `payee_category_stats` r JOIN `categories` c ON c.`id` = r.`category_id` WHERE r.`ledger_id` = NEW.`id` AND c.`ledger_id` IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'the ledger still uses the shared category list');
END;
--> statement-breakpoint
-- Rows never move to another ledger: what refers to them would be left in the old one.
CREATE TRIGGER `keep_ledger_institutions` BEFORE UPDATE OF `ledger_id` ON `institutions`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_accounts` BEFORE UPDATE OF `ledger_id` ON `accounts`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_tags` BEFORE UPDATE OF `ledger_id` ON `tags`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_import_batches` BEFORE UPDATE OF `ledger_id` ON `import_batches`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_recurring_items` BEFORE UPDATE OF `ledger_id` ON `recurring_items`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_transactions` BEFORE UPDATE OF `ledger_id` ON `transactions`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_custom_reports` BEFORE UPDATE OF `ledger_id` ON `custom_reports`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_payee_rules` BEFORE UPDATE OF `ledger_id` ON `payee_rules`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_payee_category_stats` BEFORE UPDATE OF `ledger_id` ON `payee_category_stats`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_activity` BEFORE UPDATE OF `ledger_id` ON `activity`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_ai_calls` BEFORE UPDATE OF `ledger_id` ON `ai_calls`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_ledger_settings` BEFORE UPDATE OF `ledger_id` ON `ledger_settings`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_category_groups` BEFORE UPDATE OF `ledger_id` ON `category_groups`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_categories` BEFORE UPDATE OF `ledger_id` ON `categories`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_labels` BEFORE UPDATE OF `ledger_id` ON `labels`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `keep_ledger_ledger_category_off` BEFORE UPDATE OF `ledger_id` ON `ledger_category_off`
WHEN NEW.`ledger_id` IS NOT OLD.`ledger_id`
BEGIN
  SELECT RAISE(ABORT, 'rows stay in their ledger');
END;
