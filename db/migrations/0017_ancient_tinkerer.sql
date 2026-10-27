CREATE TYPE "public"."mcp_tool_call_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "mcp_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_access_tokens_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"user_id" text,
	"auth_method" text NOT NULL,
	"credential_id" text,
	"tool" text NOT NULL,
	"client_request_id" text,
	"status" "mcp_tool_call_status" NOT NULL,
	"error_code" text,
	"args_hmac" text,
	"planned_entity_id" text,
	"lock_group" text,
	"target_ticket_id" text,
	"target_customer_id" text,
	"body_hmac" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"result_json" jsonb,
	"side_effects_uncertain" boolean DEFAULT false NOT NULL,
	"notification_errors" text[],
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "mcp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_access_tokens_user_idx" ON "mcp_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_calls_idempotency_idx" ON "mcp_tool_calls" USING btree ("user_id","tool","client_request_id") WHERE "mcp_tool_calls"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_calls_ticket_lock_idx" ON "mcp_tool_calls" USING btree ("lock_group","target_ticket_id") WHERE "mcp_tool_calls"."status" = 'pending' AND "mcp_tool_calls"."lock_group" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_created_at_idx" ON "mcp_tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_user_idx" ON "mcp_tool_calls" USING btree ("user_id");
--> statement-breakpoint
-- R6 (option C): permanently revoke a user's MCP tokens whenever an update
-- leaves the user banned or with a role other than exactly agent/admin, on
-- every path (Docket, Better Auth admin endpoints, direct SQL). Already-revoked
-- tokens keep their original revoked_at/revoked_reason; nothing clears them.
-- Trigger-driven revocations write no actor audit event.
CREATE OR REPLACE FUNCTION mcp_revoke_tokens_for_ineligible_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mcp_access_tokens
     SET revoked_at = now(),
         revoked_reason = CASE WHEN NEW.banned IS TRUE THEN 'user_banned' ELSE 'role_changed' END,
         updated_at = now()
   WHERE user_id = NEW.id
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mcp_access_tokens_revoke_on_user_update
  AFTER UPDATE ON "user"
  FOR EACH ROW
  WHEN (NEW.banned IS TRUE OR NEW.role IS NULL OR NEW.role NOT IN ('agent', 'admin'))
  EXECUTE FUNCTION mcp_revoke_tokens_for_ineligible_user();
