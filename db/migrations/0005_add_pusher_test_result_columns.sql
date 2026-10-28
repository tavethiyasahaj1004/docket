ALTER TABLE "integration_settings" ADD COLUMN "pusher_beams_last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "pusher_beams_last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "pusher_beams_last_test_error" text;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "pusher_channels_last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "pusher_channels_last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD COLUMN "pusher_channels_last_test_error" text;