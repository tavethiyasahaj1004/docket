"use client";

import { useEffect, useState } from "react";
import {
  formatDuration,
  getLiveElapsedSeconds,
  getMetricStatus,
  getSlaOutcome,
  type MetricStatus,
  type SlaMetricSnapshot,
  type SlaOutcome,
  type SlaSnapshot,
} from "@/lib/sla";
import { cn } from "@/lib/utils";

const STATUS_CLASSES: Record<MetricStatus, string> = {
  // "met" only ever applies to a finished target, so it's history, not a
  // signal — muted, so a list of closed tickets doesn't read as a wall of
  // urgent green and the still-running/breached SLAs are the ones that pop.
  met: "bg-base-300 text-base-content-muted border-base-300",
  on_track: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-100 text-amber-700 border-amber-200",
  breached: "bg-red-50 text-red-700 border-red-200",
};

const OUTCOME_CLASSES: Record<SlaOutcome, string> = {
  met: "bg-base-300 text-base-content-muted border-base-300",
  // A breach stays red after closing — it's the permanent record the team
  // reports on, not a transient alert.
  breached: "bg-red-50 text-red-700 border-red-200",
};

const TICK_MS = 30_000;

/** Hydration-safe live clock: null (→ falls back to the snapshot's own
 * `asOf`) until mounted, matching the server-rendered output exactly, then
 * ticks forward every 30s — same pattern as components/common/local-datetime.tsx. */
function useNowMs(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

function secondsSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
}

interface SlaWaitBadgeProps {
  className?: string;
  /** Compact = single line for table cells; full = stacked for the detail sidebar. */
  compact?: boolean;
  snapshot: SlaSnapshot;
}

export function SlaWaitBadge({
  snapshot,
  className,
  compact = false,
}: SlaWaitBadgeProps) {
  const nowMs = useNowMs() ?? new Date(snapshot.createdAt).getTime();
  const openForSeconds = secondsSince(snapshot.createdAt, nowMs);

  // Once resolved there is nothing left to count — report the total time the
  // ticket was alive instead of an "open for" figure that climbs forever.
  if (snapshot.waitState === "resolved") {
    return (
      <div className={cn("text-xs text-base-content-muted", className)}>
        {snapshot.resolvedInSeconds === null
          ? "Resolved"
          : `Resolved in ${formatDuration(snapshot.resolvedInSeconds)}`}
      </div>
    );
  }

  const waitLabel =
    snapshot.waitState === "waiting_for_agent"
      ? "Waiting for agent"
      : "Waiting for customer";
  const waitDuration = snapshot.waitingSince
    ? formatDuration(secondsSince(snapshot.waitingSince, nowMs))
    : null;

  return (
    <div
      className={cn(
        "text-xs text-base-content-muted",
        compact ? "space-y-0" : "space-y-0.5",
        className
      )}
    >
      <div>Open for {formatDuration(openForSeconds)}</div>
      <div
        className={cn(
          snapshot.waitState === "waiting_for_agent" &&
            "text-base-content font-medium"
        )}
      >
        {waitLabel}
        {waitDuration ? ` · ${waitDuration}` : ""}
      </div>
    </div>
  );
}

interface SlaMetricBadgeProps {
  className?: string;
  metric: SlaMetricSnapshot;
}

export function SlaMetricBadge({ metric, className }: SlaMetricBadgeProps) {
  const nowMs = useNowMs() ?? new Date(metric.asOf).getTime();
  const elapsedSeconds = getLiveElapsedSeconds(metric, nowMs);
  const status = getMetricStatus(metric, nowMs);
  const remainingSeconds = metric.targetSeconds - elapsedSeconds;

  const finished = !(metric.live || metric.paused);

  let statusText: string;
  if (status === "met") {
    statusText = `met in ${formatDuration(elapsedSeconds)}`;
  } else if (status === "breached" && finished) {
    statusText = `breached (took ${formatDuration(elapsedSeconds)})`;
  } else if (remainingSeconds >= 0) {
    statusText = `${formatDuration(remainingSeconds)} left`;
  } else {
    statusText = `overdue by ${formatDuration(-remainingSeconds)}`;
  }
  if (metric.paused) {
    statusText = `paused · ${statusText}`;
  }

  return (
    <span
      className={cn(
        "inline-block max-w-full rounded border px-2 py-0.5 text-xs font-medium",
        STATUS_CLASSES[status],
        className
      )}
    >
      {metric.label}: {statusText}
    </span>
  );
}

interface SlaOutcomeBadgeProps {
  className?: string;
  snapshot: SlaSnapshot;
}

/** The final verdict pill for a closed ticket, shown where a countdown with
 * nothing left to count would be. Hovering gives the per-target breakdown.
 * Renders nothing while the ticket is open or no policy applies. */
export function SlaOutcomeBadge({ snapshot, className }: SlaOutcomeBadgeProps) {
  const outcome = getSlaOutcome(snapshot);
  if (!outcome) {
    return null;
  }

  const detail = [snapshot.firstResponse, snapshot.resolution]
    .filter((m): m is SlaMetricSnapshot => m !== null)
    .map(
      (m) =>
        `${m.label}: ${
          m.frozen === "breached"
            ? `breached (took ${formatDuration(m.elapsedSeconds)})`
            : `met in ${formatDuration(m.elapsedSeconds)}`
        }`
    )
    .join(" · ");

  return (
    <span
      className={cn(
        "inline-block max-w-full rounded border px-2 py-0.5 text-xs font-medium",
        OUTCOME_CLASSES[outcome],
        className
      )}
      title={detail}
    >
      {outcome === "breached" ? "SLA breached" : "SLA met"}
    </span>
  );
}

/** The single most urgent metric among First/Next response and Resolution —
 * used where space only allows one badge (the ticket list's SLA column). */
export function pickMostUrgentMetric(
  snapshot: SlaSnapshot,
  nowMs: number
): SlaMetricSnapshot | null {
  const candidates = [
    snapshot.nextResponse ?? snapshot.firstResponse,
    snapshot.resolution,
  ].filter((m): m is SlaMetricSnapshot => m !== null);
  if (candidates.length === 0) {
    return null;
  }
  const rank: Record<MetricStatus, number> = {
    breached: 0,
    warning: 1,
    on_track: 2,
    met: 3,
  };
  return candidates.reduce((worst, m) =>
    rank[getMetricStatus(m, nowMs)] < rank[getMetricStatus(worst, nowMs)]
      ? m
      : worst
  );
}
