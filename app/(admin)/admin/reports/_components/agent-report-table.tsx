"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { AgentReportRow } from "@/lib/reports";
import { formatDuration } from "@/lib/sla";

interface Props {
  csvHref: string;
  rows: AgentReportRow[];
}

const ROW_HEIGHT = 32;
const CHART_PADDING = 48;

const chartConfig: ChartConfig = {
  open: { label: "Open", color: "var(--chart-1)" },
  closed: { label: "Closed", color: "var(--chart-6)" },
};

export function AgentReportTable({ rows, csvHref }: Props) {
  const chartData = rows.map((r) => ({
    agent: r.agentId ? r.agentName : "Unassigned",
    open: r.openTickets,
    closed: r.totalTickets - r.openTickets,
  }));

  return (
    <section className="bg-base-100 rounded-xl border border-base-300 shadow-soft">
      <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
        <div>
          <h2 className="text-base font-semibold text-base-content">
            Tickets per Agent
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Counts by current assignee, plus average reply/resolution speed
          </p>
        </div>
        <a
          className="text-xs font-medium text-base-content hover:underline shrink-0"
          download
          href={csvHref}
        >
          Download CSV
        </a>
      </div>

      {rows.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-base-content-muted">
            No tickets in this range.
          </p>
        </div>
      ) : (
        <>
          <div className="px-6 pt-5">
            <ChartContainer
              className="aspect-auto w-full"
              config={chartConfig}
              style={{ height: rows.length * ROW_HEIGHT + CHART_PADDING }}
            >
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 0, right: 24, bottom: 0, left: 0 }}
              >
                <CartesianGrid horizontal={false} stroke="var(--base-300)" />
                <XAxis allowDecimals={false} type="number" />
                <YAxis
                  dataKey="agent"
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  type="category"
                  width={120}
                />
                <ChartTooltip
                  content={<ChartTooltipContent indicator="dot" />}
                  cursor={{ fill: "var(--base-300)" }}
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar
                  dataKey="open"
                  fill="var(--color-open)"
                  radius={[0, 0, 0, 0]}
                  stackId="tickets"
                />
                <Bar
                  dataKey="closed"
                  fill="var(--color-closed)"
                  radius={[0, 4, 4, 0]}
                  stackId="tickets"
                />
              </BarChart>
            </ChartContainer>
          </div>

          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-base-300">
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Agent
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Total
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Open
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Avg First Response
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Avg Resolution
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300">
                {rows.map((r) => (
                  <tr
                    className="hover:bg-base-300/30 transition-colors"
                    key={r.agentId ?? "unassigned"}
                  >
                    <td className="px-6 py-3 text-base-content font-medium">
                      {r.agentId ? (
                        r.agentName
                      ) : (
                        <span className="italic text-base-content-muted/70 font-normal">
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-base-content-muted">
                      {r.totalTickets}
                    </td>
                    <td className="px-6 py-3 text-base-content-muted">
                      {r.openTickets}
                    </td>
                    <td className="px-6 py-3 text-base-content-muted">
                      {r.avgFirstResponseSeconds == null
                        ? "—"
                        : formatDuration(r.avgFirstResponseSeconds)}
                    </td>
                    <td className="px-6 py-3 text-base-content-muted">
                      {r.avgResolutionSeconds == null
                        ? "—"
                        : formatDuration(r.avgResolutionSeconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
