CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`job_id` text,
	`qa` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assets_owner_kind` ON `assets` (`owner_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_assets_owner_job` ON `assets` (`owner_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`title` text NOT NULL,
	`style_id` text NOT NULL,
	`count` integer NOT NULL,
	`status` text NOT NULL,
	`prompt` text NOT NULL,
	`references_json` text NOT NULL,
	`notes` text NOT NULL,
	`parent_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_owner_created` ON `jobs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_jobs_owner_idempotency` ON `jobs` (`owner_id`,`idempotency_key`);