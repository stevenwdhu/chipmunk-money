-- The app-wide (meta.db) schema as of the squash: what every earlier migration added up to.
-- Databases that ran those migrations skip this one (it has the last one's timestamp).
CREATE TABLE `ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`icon` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`file` text NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`currency` text NOT NULL,
	`balance_minor` integer,
	`available_minor` integer,
	`balance_date` text,
	`ledger_id` text,
	`account_id` integer,
	`sync_from` text,
	`last_synced_at` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `remote_institution_id` text, `fetched_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bank_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`notice` text,
	`request_log` text DEFAULT '[]' NOT NULL,
	`last_attempt_at` text,
	`last_synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
, `remote_id` text, `cursor` text);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer,
	`name` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`exclude_from_totals` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE set null
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
CREATE TABLE `category_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `payee_tidy` (
	`original` text PRIMARY KEY NOT NULL,
	`tidied` text NOT NULL,
	`model` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
, `prompt` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledgers_slug` ON `ledgers` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash` ON `api_keys` (`hash`);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_remote` ON `bank_accounts` (`connection_id`,`remote_id`);
--> statement-breakpoint
CREATE INDEX `categories_group` ON `categories` (`group_id`);
--> statement-breakpoint
CREATE INDEX `category_labels_label` ON `category_labels` (`label_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name` ON `labels` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_link` ON `bank_accounts` (`ledger_id`,`account_id`) WHERE "bank_accounts"."account_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `bank_transactions_date` ON `bank_transactions` (`bank_account_id`,`date`);
