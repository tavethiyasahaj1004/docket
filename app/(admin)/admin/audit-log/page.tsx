import {
  CaretLeftIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
} from "@phosphor-icons/react/dist/ssr";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { GoToPage, PageSizeSelect } from "@/components/common/list-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { auditLogs } from "@/db/schema";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import { getPageNumbers } from "@/lib/pagination";
import { cn, skeletonKeys } from "@/lib/utils";
import { AuditLogFilters } from "./_components/audit-log-filters";
import { AuditLogTable } from "./_components/audit-log-table";

type SearchParams = {
  q?: string;
  action?: string;
  page?: string;
  pageSize?: string;
};

interface Props {
  searchParams: Promise<SearchParams>;
}

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default async function AuditLogPage({ searchParams }: Props) {
  await requireAdmin();
  const params = await searchParams;

  // Derived from the data itself, not a hand-maintained list, so the filter
  // never goes stale as new audit() call sites appear elsewhere.
  const availableActions = await db
    .selectDistinct({ action: auditLogs.action })
    .from(auditLogs)
    .orderBy(asc(auditLogs.action));

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto space-y-6">
      <AuditLogFilters actions={availableActions.map((a) => a.action)} />

      <Suspense
        fallback={<AuditLogTableSkeleton />}
        key={JSON.stringify(params)}
      >
        <AuditLogResults params={params} />
      </Suspense>
    </div>
  );
}

async function AuditLogResults({ params }: { params: SearchParams }) {
  const search = (params.q ?? "").trim();
  const action = (params.action ?? "").trim();
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const requestedPageSize = Number.parseInt(params.pageSize ?? "", 10);
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize)
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const conditions = [];
  if (search) {
    conditions.push(
      or(
        ilike(auditLogs.description, `%${search}%`),
        ilike(auditLogs.actorEmail, `%${search}%`)
      )
    );
  }
  if (action) {
    conditions.push(eq(auditLogs.action, action));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function buildPageUrl(p: number) {
    const qp = new URLSearchParams();
    if (search) {
      qp.set("q", search);
    }
    if (action) {
      qp.set("action", action);
    }
    if (pageSize !== DEFAULT_PAGE_SIZE) {
      qp.set("pageSize", String(pageSize));
    }
    if (p > 1) {
      qp.set("page", String(p));
    }
    const qs = qp.toString();
    return `/admin/audit-log${qs ? `?${qs}` : ""}`;
  }

  const tableRows = rows.map((r) => ({
    action: r.action,
    actorEmail: r.actorEmail,
    createdAt: r.createdAt.toISOString(),
    description: r.description,
    entityId: r.entityId,
    entityType: r.entityType,
    id: r.id,
    metadata: r.metadata ?? null,
  }));

  return (
    <>
      <p className="text-xs text-base-content-muted">
        {total} event{total === 1 ? "" : "s"}
      </p>

      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-clip">
        {tableRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ClockCounterClockwiseIcon className="size-8 text-base-content-muted mb-3" />
            <p className="text-sm font-medium text-base-content">
              No events found
            </p>
            {(search || action) && (
              <p className="text-xs text-base-content-muted mt-1">
                Try a different search term or filter
              </p>
            )}
          </div>
        ) : (
          <AuditLogTable rows={tableRows} />
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-base-content-muted shrink-0">
            Rows per page
          </span>
          <PageSizeSelect
            basePath="/admin/audit-log"
            options={PAGE_SIZE_OPTIONS}
            pageSize={pageSize}
          />
        </div>

        {totalPages > 1 && (
          <GoToPage basePath="/admin/audit-log" totalPages={totalPages} />
        )}

        {totalPages > 1 && (
          <nav aria-label="Pagination" className="flex items-center gap-1">
            <Link
              aria-disabled={page <= 1}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 h-8 text-sm font-medium transition-colors",
                page <= 1
                  ? "pointer-events-none text-base-content-muted/40"
                  : "text-base-content-muted hover:text-base-content hover:bg-base-300"
              )}
              href={buildPageUrl(Math.max(1, page - 1))}
            >
              <CaretLeftIcon className="size-4" />
              Previous
            </Link>

            {getPageNumbers(page, totalPages).map((p, i) =>
              p === "ellipsis" ? (
                <span
                  className="inline-flex size-8 items-center justify-center text-sm text-base-content-muted"
                  key={`ellipsis-${
                    // biome-ignore lint/suspicious/noArrayIndexKey: two ellipses can never be adjacent, so index is stable within this static list
                    i
                  }`}
                >
                  …
                </span>
              ) : (
                <Link
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-md text-sm font-medium transition-colors",
                    p === page
                      ? "border border-base-300 bg-base-100 text-base-content"
                      : "text-base-content-muted hover:text-base-content hover:bg-base-300"
                  )}
                  href={buildPageUrl(p)}
                  key={p}
                >
                  {p}
                </Link>
              )
            )}

            <Link
              aria-disabled={page >= totalPages}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 h-8 text-sm font-medium transition-colors",
                page >= totalPages
                  ? "pointer-events-none text-base-content-muted/40"
                  : "text-base-content-muted hover:text-base-content hover:bg-base-300"
              )}
              href={buildPageUrl(Math.min(totalPages, page + 1))}
            >
              Next
              <CaretRightIcon className="size-4" />
            </Link>
          </nav>
        )}
      </div>
    </>
  );
}

function AuditLogTableSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-24 mb-3" />
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
        <div className="border-b border-base-300 bg-base-300/50 px-4 py-3">
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="divide-y divide-base-300/50">
          {skeletonKeys(8).map((k) => (
            <div className="flex items-center gap-4 px-4 py-3.5" key={k}>
              <Skeleton className="h-3 w-24 shrink-0" />
              <Skeleton className="h-3 w-32 shrink-0 hidden sm:block" />
              <Skeleton className="h-5 w-24 rounded-md shrink-0" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
