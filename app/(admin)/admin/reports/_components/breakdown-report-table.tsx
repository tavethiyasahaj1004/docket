"use client";

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { categoricalChartColor } from "@/lib/chart-colors";

interface Row {
  count: number;
  label: string;
  share?: number;
}

interface Props {
  csvHref: string;
  description?: string;
  rows: Row[];
  title: string;
}

const ROW_HEIGHT = 32;
const CHART_PADDING = 24;
const SINGLE_HUE_THRESHOLD = 8;

/** Shared shape for the By Category / By Priority / By Tag reports — label,
 * count, and an optional share-of-total column (tags omit share since a
 * ticket can have multiple tags, so shares wouldn't sum to 100%). */
export function BreakdownReportTable({
  title,
  description,
  rows,
  csvHref,
}: Props) {
  const showShare = rows.some((r) => r.share !== undefined);
  const categorical = rows.length <= SINGLE_HUE_THRESHOLD;

  const chartConfig: ChartConfig = { count: { label: "Tickets" } };
  const chartData = rows.map((r, i) => ({
    label: r.label,
    count: r.count,
    share: r.share,
    fill: categorical ? categoricalChartColor(i) : "var(--chart-1)",
  }));

  return (
    <section className="bg-base-100 rounded-xl border border-base-300 shadow-soft">
      <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
        <div>
          <h2 className="text-base font-semibold text-base-content">{title}</h2>
          {description && (
            <p className="text-xs text-base-content-muted mt-0.5">
              {description}
            </p>
          )}
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
                  dataKey="label"
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  type="category"
                  width={120}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value, _name, item) => {
                        const count = Number(value);
                        const share = item.payload?.share as number | undefined;
                        return (
                          <span className="font-mono font-medium text-base-content tabular-nums">
                            {count.toLocaleString()} ticket
                            {count === 1 ? "" : "s"}
                            {share === undefined
                              ? ""
                              : ` · ${(share * 100).toFixed(1)}%`}
                          </span>
                        );
                      }}
                    />
                  }
                  cursor={{ fill: "var(--base-300)" }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {chartData.map((d) => (
                    <Cell fill={d.fill} key={d.label} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </div>

          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-base-300">
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Tickets
                  </th>
                  {showShare && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-base-content-muted uppercase tracking-wide">
                      Share
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300">
                {rows.map((r) => (
                  <tr
                    className="hover:bg-base-300/30 transition-colors"
                    key={r.label}
                  >
                    <td className="px-6 py-3 text-base-content font-medium">
                      {r.label}
                    </td>
                    <td className="px-6 py-3 text-base-content-muted">
                      {r.count}
                    </td>
                    {showShare && (
                      <td className="px-6 py-3 text-base-content-muted">
                        {r.share === undefined
                          ? "—"
                          : `${(r.share * 100).toFixed(1)}%`}
                      </td>
                    )}
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
