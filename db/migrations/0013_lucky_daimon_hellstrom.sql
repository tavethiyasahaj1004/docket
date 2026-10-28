ALTER TABLE "platform_settings" ADD COLUMN "ticket_merge_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ticket_merge_notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ticket_split_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ticket_split_notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ticket_link_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ticket_link_notifications_enabled" boolean DEFAULT true NOT NULL;