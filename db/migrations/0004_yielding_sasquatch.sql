ALTER TABLE "integration_settings" ADD COLUMN "smtp_last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "smtp_last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "smtp_last_test_error" text;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "google_last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "google_last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "google_last_test_error" text;