CREATE TYPE "public"."mcp_pending_action_kind" AS ENUM('close', 'reply');--> statement-breakpoint
CREATE TYPE "public"."mcp_pending_action_status" AS ENUM('pending', 'approved', 'dismissed', 'expired', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "mcp_pending_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "mcp_pending_action_kind" NOT NULL,
	"ticket_id" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"credential_id" text,
	"tool_call_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "mcp_pending_action_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"planned_entity_id" text,
	"result" jsonb,
	"side_effects_uncertain" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_requested_by_id_user_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_credential_id_mcp_access_tokens_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."mcp_access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_pending_actions_pending_idx" ON "mcp_pending_actions" USING btree ("ticket_id","kind","requested_by_id") WHERE "mcp_pending_actions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_credential_idx" ON "mcp_pending_actions" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_status_idx" ON "mcp_pending_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_requested_by_idx" ON "mcp_pending_actions" USING btree ("requested_by_id");
--> statement-breakpoint
-- Cancel a token's pending MCP actions the moment the token is revoked, on
-- every path: the app's own revoke paths, the "user" trigger from 0017 (ban or
-- role change), the verify-time backstop, and direct SQL. Trigger-driven
-- cancellations write no audit row (same as the token revocations of 0017); the
-- app's revoke paths cancel and audit explicitly first, so the trigger finds
-- nothing left for them.
CREATE OR REPLACE FUNCTION mcp_cancel_pending_actions_on_token_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mcp_pending_actions
     SET status = 'cancelled',
         status_reason = 'token_revoked',
         updated_at = now()
   WHERE credential_id = NEW.id
     AND status = 'pending';
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mcp_pending_actions_cancel_on_token_revoke
  AFTER UPDATE OF revoked_at ON mcp_access_tokens
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION mcp_cancel_pending_actions_on_token_revoke();
