ALTER TABLE `generation_attempts` ADD `recovery_token` text;--> statement-breakpoint
ALTER TABLE `generation_attempts` ADD `budget_currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_cost_reservations` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_workers` ADD `metadata_json` text;