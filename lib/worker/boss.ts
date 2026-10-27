import { type Job, PgBoss } from "pg-boss";
import { env } from "@/lib/env";
import { normalizePgConnectionString } from "@/lib/pg-connection";
import { sleep } from "@/lib/utils";
import { ensureJobQueues } from "@/lib/worker/ensure-queues";
import { JOB_NAMES } from "@/lib/worker/job-types";

const boss = new PgBoss({
  connectionString: normalizePgConnectionString(env.DATABASE_URL),
});

export { boss };

function work<T>(name: string, handler: (jobs: Job<T>[]) => Promise<void>) {
  return boss.work<T>(name, { includeMetadata: true }, handler);
}

async function startBossWithRetry(maxRetries = 10) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await boss.start();
      console.log("[worker] pg-boss started");
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      console.error(
        `[worker] pg-boss start failed (${attempt}/${maxRetries}); retrying in ${
          delay / 1000
        }s`,
        error
      );
      await sleep(delay);
    }
  }
}

export async function startWorker() {
  boss.on("error", (error) => {
    console.error("[worker] pg-boss error", error);
  });

  await startBossWithRetry();
  await ensureJobQueues(boss);

  const { handleEmailSend } = await import("@/lib/worker/handlers/email-send");
  const { handleEmailOutboxReap } = await import(
    "@/lib/worker/handlers/email-outbox-reap"
  );
  const { handleEmailEventsPrune } = await import(
    "@/lib/worker/handlers/email-events-prune"
  );
  const { handleRateLimitHitsPrune } = await import(
    "@/lib/worker/handlers/rate-limit-hits-prune"
  );
  const { handleMcpToolCallsPrune } = await import(
    "@/lib/worker/handlers/mcp-tool-calls-prune"
  );
  const { handleScaffoldHealthcheck } = await import(
    "@/lib/worker/handlers/scaffold-healthcheck"
  );
  const { handleWebhookSend } = await import(
    "@/lib/worker/handlers/webhook-send"
  );
  const { handleWebhookDeliveriesReap } = await import(
    "@/lib/worker/handlers/webhook-deliveries-reap"
  );

  await Promise.all([
    work(JOB_NAMES.EMAIL_SEND, handleEmailSend),
    work(JOB_NAMES.EMAIL_OUTBOX_REAP, handleEmailOutboxReap),
    work(JOB_NAMES.EMAIL_EVENTS_PRUNE, handleEmailEventsPrune),
    work(JOB_NAMES.MCP_TOOL_CALLS_PRUNE, handleMcpToolCallsPrune),
    work(JOB_NAMES.RATE_LIMIT_HITS_PRUNE, handleRateLimitHitsPrune),
    work(JOB_NAMES.SCAFFOLD_HEALTHCHECK, handleScaffoldHealthcheck),
    work(JOB_NAMES.WEBHOOK_SEND, handleWebhookSend),
    work(JOB_NAMES.WEBHOOK_DELIVERIES_REAP, handleWebhookDeliveriesReap),
  ]);

  await boss.schedule(JOB_NAMES.EMAIL_OUTBOX_REAP, "*/15 * * * *", {});
  await boss.schedule(JOB_NAMES.EMAIL_EVENTS_PRUNE, "17 3 * * *", {});
  await boss.schedule(JOB_NAMES.MCP_TOOL_CALLS_PRUNE, "29 3 * * *", {});
  await boss.schedule(JOB_NAMES.RATE_LIMIT_HITS_PRUNE, "23 3 * * *", {});
  await boss.schedule(JOB_NAMES.SCAFFOLD_HEALTHCHECK, "*/10 * * * *", {});
  await boss.schedule(JOB_NAMES.WEBHOOK_DELIVERIES_REAP, "*/15 * * * *", {});

  console.log("[worker] handlers registered");
}

export async function stopWorker() {
  await boss.stop({ graceful: true });
}
