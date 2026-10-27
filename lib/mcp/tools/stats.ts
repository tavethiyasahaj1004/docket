import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { MCP_RESULT_TARGET_CHARS } from "@/lib/mcp/limits";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { jsonLength, largestFittingCount } from "@/lib/mcp/size";
import { READ_ONLY_ANNOTATIONS } from "@/lib/mcp/tools/common";
import {
  getTicketsByAgentReport,
  getTicketsByCategoryReport,
  getTicketsByPriorityReport,
  getTicketsByTagReport,
  type ReportRange,
} from "@/lib/reports";
import { getOverviewStats, getVolumeStats } from "@/lib/stats";

/* -------------------------------------------------------- get_ticket_stats */

export const statsInput = z.strictObject({
  volumeDays: z
    .number()
    .int()
    .min(7)
    .max(30)
    .default(7)
    .describe("Days of daily ticket volume to return, 7-30. Defaults to 7."),
});

const statsOutput = z.object({
  overview: z.object({
    total: z.number(),
    open: z.number(),
    inProgress: z.number(),
    closed: z.number(),
    avgOpenTicketAgeMs: z.number().nullable(),
  }),
  volume: z.array(z.object({ date: z.string(), count: z.number() })),
});
type StatsResult = z.infer<typeof statsOutput>;

/* -------------------------------------------------------------- get_report */

const REPORT_KINDS = [
  "by_agent",
  "by_category",
  "by_priority",
  "by_tag",
] as const;

export const reportInput = z.strictObject({
  kind: z
    .enum(REPORT_KINDS)
    .describe(
      "by_agent: workload and response times per agent; by_category / by_priority: ticket counts and shares; by_tag: the 20 most used tags."
    ),
  range: z
    .enum(["30d", "90d", "all"])
    .default("30d")
    .describe(
      "Tickets created in the last 30 or 90 days, or all. Defaults to 30d."
    ),
});

const agentRow = z.object({
  agentId: z.string().nullable(),
  agentName: z.string(),
  totalTickets: z.number(),
  openTickets: z.number(),
  avgFirstResponseSeconds: z.number().nullable(),
  avgResolutionSeconds: z.number().nullable(),
});
const breakdownRow = z.object({
  slug: z.string(),
  label: z.string(),
  count: z.number(),
  share: z.number(),
});
const tagRow = z.object({ name: z.string(), count: z.number() });

const reportOutput = z.object({
  kind: z.enum(REPORT_KINDS),
  range: z.enum(["30d", "90d", "all"]),
  rows: z.array(z.union([agentRow, breakdownRow, tagRow])),
  truncatedForSize: z.boolean().optional(),
  omittedRows: z.number().optional(),
});
type ReportResult = z.infer<typeof reportOutput>;

/** Over the size cap (a by_agent report on a very large team): keep the longest
 * prefix of rows that fits the target. Rows come busiest first, so the dropped
 * tail is the least loaded; omittedRows says how many were left out. */
export function shrinkReport(result: ReportResult): ReportResult {
  const withRows = (n: number): ReportResult => ({
    ...result,
    rows: result.rows.slice(0, n),
    truncatedForSize: true,
    omittedRows: result.rows.length - n,
  });
  return withRows(
    largestFittingCount(
      result.rows.length,
      (n) => jsonLength(withRows(n)) <= MCP_RESULT_TARGET_CHARS
    )
  );
}

const finiteOrNull = (n: number | null) =>
  n === null || !Number.isFinite(n) ? null : n;

async function loadReportRows(
  kind: (typeof REPORT_KINDS)[number],
  range: ReportRange
): Promise<ReportResult["rows"]> {
  switch (kind) {
    case "by_agent":
      return (await getTicketsByAgentReport(range)).map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        totalTickets: r.totalTickets,
        openTickets: r.openTickets,
        avgFirstResponseSeconds: finiteOrNull(r.avgFirstResponseSeconds),
        avgResolutionSeconds: finiteOrNull(r.avgResolutionSeconds),
      }));
    case "by_category":
      return (await getTicketsByCategoryReport(range)).map((r) => ({
        slug: r.slug,
        label: r.label,
        count: r.count,
        share: r.share,
      }));
    case "by_priority":
      return (await getTicketsByPriorityReport(range)).map((r) => ({
        slug: r.slug,
        label: r.label,
        count: r.count,
        share: r.share,
      }));
    case "by_tag":
      return (await getTicketsByTagReport(range)).map((r) => ({
        name: r.name,
        count: r.count,
      }));
    default:
      return [];
  }
}

export function registerStatsTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (permitted.has("get_ticket_stats")) {
    server.registerTool(
      "get_ticket_stats",
      {
        title: "Get ticket statistics",
        description:
          "Returns dashboard numbers: ticket totals (total, open, inProgress, closed; merged tickets excluded), avgOpenTicketAgeMs (the average age in milliseconds of tickets that are not closed, null if none) and the number of tickets created per day for the last volumeDays days (7-30, default 7).",
        inputSchema: statsInput,
        outputSchema: statsOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<StatsResult>(
          { tool: "get_ticket_stats", principal, requestId, args },
          async () => {
            const [overview, volume] = await Promise.all([
              getOverviewStats(),
              getVolumeStats(args.volumeDays),
            ]);
            return {
              overview: {
                total: overview.total,
                open: overview.open,
                inProgress: overview.inProgress,
                closed: overview.closed,
                avgOpenTicketAgeMs: finiteOrNull(overview.avgWaitMs),
              },
              volume: volume.days.map((d) => ({
                date: d.date,
                count: d.count,
              })),
            };
          }
        )
    );
  }

  if (permitted.has("get_report")) {
    server.registerTool(
      "get_report",
      {
        title: "Get an admin report",
        description:
          "Admin only. Returns one report over tickets created in a range (30d, 90d or all; merged tickets excluded): by_agent (totals, open count, avgFirstResponseSeconds, avgResolutionSeconds), by_category and by_priority (count and share), or by_tag (the 20 most used tags). avgResolutionSeconds is the accumulated time a ticket spent waiting for an agent (not elapsed time since creation), averaged over closed tickets. If truncatedForSize is true, the last omittedRows rows (for by_agent, the agents with the fewest tickets) were left out to fit the size limit.",
        inputSchema: reportInput,
        outputSchema: reportOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<ReportResult>(
          {
            tool: "get_report",
            principal,
            requestId,
            args,
            shrink: shrinkReport,
          },
          async () => ({
            kind: args.kind,
            range: args.range,
            rows: await loadReportRows(args.kind, args.range),
          })
        )
    );
  }
}
