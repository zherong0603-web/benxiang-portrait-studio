CREATE TABLE `order_payment_events` (
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`order_id` text NOT NULL,
	`event_type` text NOT NULL,
	`mode` text NOT NULL,
	`checkout_id` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_order_payment_events_provider_id` ON `order_payment_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_order_payment_events_order` ON `order_payment_events` (`order_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`job_id` text,
	`idempotency_key` text NOT NULL,
	`package_id` text NOT NULL,
	`package_snapshot` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`mode` text NOT NULL,
	`payment_status` text NOT NULL,
	`fulfillment_status` text NOT NULL,
	`terms_version` text NOT NULL,
	`checkout_attempt` integer DEFAULT 0 NOT NULL,
	`provider` text,
	`provider_checkout_id` text,
	`checkout_url` text,
	`checkout_expires_at` text,
	`provider_payment_id` text,
	`paid_at` text,
	`delivered_at` text,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "orders_amount_positive" CHECK("orders"."amount_minor">0 AND "orders"."amount_minor"<=100000000),
	CONSTRAINT "orders_mode_valid" CHECK("orders"."mode" IN ('test','live')),
	CONSTRAINT "orders_payment_valid" CHECK("orders"."payment_status" IN ('unpaid','checkout_pending','paid','cancelled')),
	CONSTRAINT "orders_fulfillment_valid" CHECK("orders"."fulfillment_status" IN ('awaiting_payment','queued','in_progress','delivered'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_owner_idempotency` ON `orders` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_job` ON `orders` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_provider_checkout` ON `orders` (`provider`,`provider_checkout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_provider_payment` ON `orders` (`provider`,`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_owner_created` ON `orders` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_fulfillment` ON `orders` (`payment_status`,`fulfillment_status`,`created_at`);--> statement-breakpoint
CREATE TABLE `pending_uploads` (
	`object_key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`job_id` text,
	`created_at` text NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pending_uploads_owner` ON `pending_uploads` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_pending_uploads_created` ON `pending_uploads` (`created_at`);--> statement-breakpoint
CREATE TABLE `privacy_locks` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_deletions` (
	`object_key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_storage_deletions_owner` ON `storage_deletions` (`owner_id`);--> statement-breakpoint
ALTER TABLE `assets` ADD `consent_version` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `consented_at` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `consented_by` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `source_note` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `consent_version` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `consented_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `deletion_token` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `deletion_started_at` text;