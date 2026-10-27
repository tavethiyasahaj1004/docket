export const JOB_NAMES = {
  EMAIL_EVENTS_PRUNE: "email.events-prune",
  EMAIL_OUTBOX_REAP: "email.outbox-reap",
  EMAIL_SEND: "email.send",
  MCP_TOOL_CALLS_PRUNE: "mcp.tool-calls-prune",
  RATE_LIMIT_HITS_PRUNE: "rate-limit.hits-prune",
  SCAFFOLD_HEALTHCHECK: "scaffold.healthcheck",
  WEBHOOK_DELIVERIES_REAP: "webhook.deliveries-reap",
  WEBHOOK_SEND: "webhook.send",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export interface EmailSendPayload {
  outboxId: string;
}

export interface WebhookSendPayload {
  deliveryId: string;
}

export type JobPayloads = {
  [JOB_NAMES.EMAIL_EVENTS_PRUNE]: Record<string, never>;
  [JOB_NAMES.EMAIL_OUTBOX_REAP]: Record<string, never>;
  [JOB_NAMES.EMAIL_SEND]: EmailSendPayload;
  [JOB_NAMES.MCP_TOOL_CALLS_PRUNE]: Record<string, never>;
  [JOB_NAMES.RATE_LIMIT_HITS_PRUNE]: Record<string, never>;
  [JOB_NAMES.SCAFFOLD_HEALTHCHECK]: Record<string, never>;
  [JOB_NAMES.WEBHOOK_DELIVERIES_REAP]: Record<string, never>;
  [JOB_NAMES.WEBHOOK_SEND]: WebhookSendPayload;
};
