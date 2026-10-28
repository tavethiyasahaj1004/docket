ALTER TABLE "platform_settings" ADD COLUMN "attachment_max_per_message" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "attachment_max_per_ticket" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "attachment_max_file_size_mb" integer DEFAULT 10 NOT NULL;