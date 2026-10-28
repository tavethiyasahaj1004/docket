"use client";

import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Fragment, useState } from "react";
import { LocalDateTime } from "@/components/common/local-datetime";
import { cn } from "@/lib/utils";
import { getAuditActionLabel } from "./audit-log-actions";

export interface AuditLogRow {
  action: string;
  actorEmail: string | null;
  createdAt: string; // ISO — rendered in the viewer's timezone
  description: string;
  entityId: string | null;
  entityType: string;
  id: string;
  metadata: Record<string, unknown> | null;
}

function actionBadgeClass(action: string) {
  if (action.startsWith("auth.")) {
    return "bg-blue-50 border-blue-200 text-blue-700";
  }
  if (action.startsWith("profile.")) {
    return "bg-base-300/20 border-base-300 text-base-content-muted";
  }
  if (action.startsWith("orbit.")) {
    return "bg-primary/10 border-primary/20 text-base-content";
  }
  if (action.startsWith("user.")) {
    return "bg-green-50 border-green-200 text-green-700";
  }
  if (action.startsWith("ticket.")) {
    return "bg-amber-50 border-amber-200 text-amber-700";
  }
  if (action.startsWith("canned_response.")) {
    return "bg-purple-50 border-purple-200 text-purple-700";
  }
  if (
    action.startsWith("ticket_config.") ||
    action.startsWith("sla_policy.") ||
    action.startsWith("custom_field.") ||
    action.startsWith("email_template.") ||
    action.startsWith("settings.")
  ) {
    return "bg-orange-50 border-orange-200 text-orange-700";
  }
  if (action.startsWith("api_key.")) {
    return "bg-red-50 border-red-200 text-red-700";
  }
  return "bg-base-300/20 border-base-300 text-base-content-muted";
}

export function AuditLogTable({ rows }: { rows: AuditLogRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="sticky top-0 z-10 border-b border-base-300 bg-base-300">
            <th className="w-8 px-2 py-3" />
            <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
              When
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
              Actor
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
              Action
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
              Description
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
              Entity
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-300/50">
          {rows.map((row) => {
            const isOpen = expanded.has(row.id);
            const hasMetadata =
              !!row.metadata && Object.keys(row.metadata).length > 0;
            return (
              <Fragment key={row.id}>
                <tr
                  className={cn(
                    "transition-colors",
                    hasMetadata && "cursor-pointer hover:bg-base-300/30"
                  )}
                  onClick={hasMetadata ? () => toggle(row.id) : undefined}
                >
                  <td className="px-2 py-3 text-base-content-muted">
                    {hasMetadata &&
                      (isOpen ? (
                        <CaretDownIcon className="size-3.5" />
                      ) : (
                        <CaretRightIcon className="size-3.5" />
                      ))}
                  </td>
                  <td className="px-4 py-3 text-xs text-base-content-muted whitespace-nowrap">
                    <LocalDateTime date={row.createdAt} />
                  </td>
                  <td className="px-4 py-3 text-xs text-base-content truncate max-w-48">
                    {row.actorEmail ?? "System"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                        actionBadgeClass(row.action)
                      )}
                      title={row.action}
                    >
                      {getAuditActionLabel(row.action)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-base-content max-w-96">
                    {row.description}
                  </td>
                  <td className="px-4 py-3 text-xs text-base-content-muted whitespace-nowrap">
                    {row.entityType}
                    {row.entityId ? ` · ${row.entityId}` : ""}
                  </td>
                </tr>
                {isOpen && hasMetadata && (
                  <tr className="bg-base-300/20">
                    <td className="px-2 py-3" />
                    <td className="px-4 py-3" colSpan={5}>
                      <pre className="rounded-md border border-base-300 bg-base-100 p-3 text-xs text-base-content-muted overflow-x-auto">
                        {JSON.stringify(row.metadata, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
