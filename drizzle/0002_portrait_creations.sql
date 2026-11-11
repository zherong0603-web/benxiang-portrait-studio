CREATE TABLE `generation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`dispatched_at` text,
	`finished_at` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reserved_micro` integer DEFAULT 0 NOT NULL,
	`metadata_json` text,
	`output_hash` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `generation_slots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "generation_reserved_nonnegative" CHECK("generation_attempts"."reserved_micro">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attempt_ordinal` ON `generation_attempts` (`slot_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attempt_active` ON `generation_attempts` (`slot_id`) WHERE "generation_attempts"."status" IN ('queued','leased','dispatched','needs_reconciliation');--> statement-breakpoint
CREATE INDEX `idx_attempt_queue` ON `generation_attempts` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `generation_cost_reservations` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`reserved_micro` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "generation_cost_positive" CHECK("generation_cost_reservations"."reserved_micro">0)
);
--> statement-breakpoint
CREATE TABLE `generation_evidence` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`review_note` text,
	`reviewed_at` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slot_id`) REFERENCES `generation_slots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_attempt` ON `generation_evidence` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `generation_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`job_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`style_id` text NOT NULL,
	`prompt` text NOT NULL,
	`prompt_version` text NOT NULL,
	`template_json` text NOT NULL,
	`references_json` text NOT NULL,
	`candidate_asset_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `portrait_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_slot_job_index` ON `generation_slots` (`job_id`,`slot_index`);--> statement-breakpoint
CREATE TABLE `generation_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`ready_until` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portrait_quality_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`decision` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portrait_result_choices` (
	`session_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`revealed` integer DEFAULT 0 NOT NULL,
	`favorite` integer DEFAULT 0 NOT NULL,
	`selected` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `portrait_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_choice_session_asset` ON `portrait_result_choices` (`session_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `portrait_session_jobs` (
	`session_id` text NOT NULL,
	`job_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `portrait_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_job` ON `portrait_session_jobs` (`session_id`,`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_job_unique` ON `portrait_session_jobs` (`job_id`);--> statement-breakpoint
CREATE TABLE `portrait_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`variant` text NOT NULL,
	`style_ids_json` text NOT NULL,
	`references_json` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "portrait_variant" CHECK("portrait_sessions"."variant" IN ('A','B','C','D'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portrait_sessions_idempotency` ON `portrait_sessions` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_portrait_sessions_owner` ON `portrait_sessions` (`owner_id`,`created_at`);
--> statement-breakpoint
-- Deleting an original child job invalidates its session snapshot. Other original jobs remain usable.
CREATE TRIGGER portrait_job_delete BEFORE DELETE ON jobs BEGIN
 DELETE FROM portrait_sessions WHERE id IN (SELECT session_id FROM portrait_session_jobs WHERE job_id=OLD.id);
END;
-- Research sessions cannot be converted to commercial orders behind the generation authorization boundary.
CREATE TRIGGER portrait_no_commercial_order BEFORE INSERT ON orders WHEN EXISTS(SELECT 1 FROM portrait_session_jobs WHERE job_id=NEW.job_id) BEGIN
 SELECT RAISE(ABORT,'Research creation cannot become a commercial order');
END;
