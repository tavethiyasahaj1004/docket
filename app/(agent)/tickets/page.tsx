import {
  CaretLeftIcon,
  CaretRightIcon,
  TicketIcon,
} from "@phosphor-icons/react/dist/ssr";
import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { TicketsListRealtime } from "@/components/agent/tickets-list-realtime";
import { GoToPage, PageSizeSelect } from "@/components/common/list-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { user } from "@/db/schema/auth";
import { customers } from "@/db/schema/customers";
import { ticketActivity, tickets } from "@/db/schema/tickets";
import { requireAgent } from "@/lib/authz";
import { db } from "@/lib/db";
import { getPageNumbers } from "@/lib/pagination";
import { getPlatformSettings, getTicketActionSettings } from "@/lib/settings";
import { computeSlaSnapshot } from "@/lib/sla";
// import {
//   getSlaPolicies,
//   resolveSlaPolicy,
//   type SlaPolicy,
// } from "@/lib/sla-policies";
import { getTicketTagsForTickets, searchTags } from "@/lib/tags";
import {
  getTicketCategories,
  getTicketPriorities,
  getTicketStatuses,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/ticket-config";
import { getLinkedTicketNumbers } from "@/lib/tickets/links";
import {
  DEFAULT_PAGE_SIZE,
  listTicketsForAgent,
  PAGE_SIZE_OPTIONS,
} from "@/lib/tickets/queries";
import { getDraftTicketIds } from "@/lib/tickets/reply-drafts";
import {
  buildTicketsWhereClause,
  type TicketListSearchParams,
} from "@/lib/tickets-list-query";
import type { ColumnPref } from "@/lib/tickets-table-columns";
import {
  // getShowSlaAndOverduePref,
  getTicketTableColumnPrefs,
} from "@/lib/user-preferences";
import { cn, skeletonKeys } from "@/lib/utils";
import { ColumnSettingsDialog } from "./_components/column-settings-dialog";
import { TicketFilters } from "./_components/ticket-filters";
import { TicketViewTabs } from "./_components/ticket-view-tabs";
import { TicketsTable } from "./_components/tickets-table";

export const metadata = { title: "All Tickets" };

type SearchParams = TicketListSearchParams;

interface Props {
  searchParams: Promise<SearchParams>;
}

export default async function TicketsPage({ searchParams }: Props) {
  const params = await searchParams;

  const session = await requireAgent();
  // SLA is hidden for now (see docs/tickets.md § SLA) — the preference fetch
  // and policy fetch below are commented out, not deleted, so the feature
  // can be restored by uncommenting.
  const showSlaAndOverdue = false;
  const [
    statuses,
    categories,
    priorities,
    columnPrefs,
    // showSlaAndOverdue,
    // slaPolicies,
    agents,
    allTags,
  ] = await Promise.all([
    getTicketStatuses(),
    getTicketCategories(),
    getTicketPriorities(),
    getTicketTableColumnPrefs(session.id),
    // getShowSlaAndOverduePref(session.id),
    // getSlaPolicies(),
    db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(
        and(
          eq(user.banned, false),
          or(eq(user.role, AGENT_ROLE), eq(user.role, ADMIN_ROLE))
        )
      ),
    searchTags("", 500),
  ]);

  return (
    <div className="p-6 space-y-5">
      <TicketsListRealtime />

      {/* Its own Suspense boundary (separate from the table below) so the tab
          bar can stream in above the search/filter row, which needs no async
          ticket data and renders immediately. */}
      <Suspense
        fallback={<TicketViewTabsSkeleton />}
        key={`tabs-${JSON.stringify(params)}`}
      >
        <TicketViewTabsResults
          agentId={session.id}
          params={params}
          statuses={statuses}
        />
      </Suspense>

      <TicketFilters
        agents={agents}
        categories={categories}
        priorities={priorities}
        statuses={statuses}
        tags={allTags.map((t) => t.name)}
      />

      {/* Re-suspends on every search/filter change (key = params), so the table
          skeleton shows while the new results load. */}
      <Suspense
        fallback={<TicketsTableSkeleton />}
        key={JSON.stringify(params)}
      >
        <TicketsResults
          agentId={session.id}
          agents={agents}
          categories={categories}
          columnPrefs={columnPrefs}
          isAdmin={session.role === ADMIN_ROLE}
          params={params}
          priorities={priorities}
          showSlaAndOverdue={showSlaAndOverdue}
          // slaPolicies={slaPolicies}
          statuses={statuses}
        />
      </Suspense>
    </div>
  );
}

/** Powers just the tab bar's counts — split out from TicketsResults so the
 * tab bar can render (and stream) above the search/filter row, which needs
 * no async data of its own. See buildTicketsWhereClause's `view` handling in
 * lib/tickets-list-query.ts for what each tab counts. */
async function TicketViewTabsResults({
  params,
  agentId,
  statuses,
}: {
  params: SearchParams;
  agentId: string;
  statuses: TicketStatus[];
}) {
  const openStatusSlugs = statuses
    .filter((s) => !s.isClosedState)
    .map((s) => s.slug);

  const awaitingWhereClause = buildTicketsWhereClause(
    { ...params, view: "awaiting" },
    agentId,
    openStatusSlugs
  );
  const openWhereClause = buildTicketsWhereClause(
    { ...params, view: "open" },
    agentId,
    openStatusSlugs
  );
  const allWhereClause = buildTicketsWhereClause(
    { ...params, view: undefined },
    agentId,
    openStatusSlugs
  );

  const countQuery = (where: typeof awaitingWhereClause) =>
    db
      .select({ total: count() })
      .from(tickets)
      .innerJoin(customers, eq(tickets.customerId, customers.id))
      .where(where);

  const [
    [{ total: awaitingCount }],
    [{ total: openCount }],
    [{ total: allCount }],
  ] = await Promise.all([
    countQuery(awaitingWhereClause),
    countQuery(openWhereClause),
    countQuery(allWhereClause),
  ]);

  return (
    <TicketViewTabs
      allCount={allCount}
      awaitingCount={awaitingCount}
      openCount={openCount}
    />
  );
}

function TicketViewTabsSkeleton() {
  return (
    <div className="flex gap-6 border-b border-base-300 pb-2.5">
      {skeletonKeys(3).map((k) => (
        <Skeleton className="h-4 w-32" key={k} />
      ))}
    </div>
  );
}

async function TicketsResults({
  params,
  agentId,
  agents,
  isAdmin,
  statuses,
  categories,
  priorities,
  // slaPolicies,
  columnPrefs,
  showSlaAndOverdue,
}: {
  params: SearchParams;
  agentId: string;
  agents: Array<{ id: string; name: string | null; email: string }>;
  isAdmin: boolean;
  statuses: TicketStatus[];
  categories: TicketCategory[];
  priorities: TicketPriority[];
  // slaPolicies: SlaPolicy[];
  columnPrefs: ColumnPref[];
  showSlaAndOverdue: boolean;
}) {
  const statusMap = Object.fromEntries(statuses.map((s) => [s.slug, s]));
  const categoryMap = Object.fromEntries(categories.map((c) => [c.slug, c]));
  const priorityMap = Object.fromEntries(priorities.map((p) => [p.slug, p]));

  const search = params.q?.trim() ?? "";
  const statusFilter =
    params.status && params.status !== "all" ? params.status : null;
  const categoryFilter =
    params.category && params.category !== "all" ? params.category : null;
  const priorityFilter =
    params.priority && params.priority !== "all" ? params.priority : null;
  const assigneeFilter =
    params.assignee && params.assignee !== "all" ? params.assignee : null;
  const rangeFilter =
    params.range && params.range !== "all" ? params.range : null;
  const tagFilter = params.tag && params.tag !== "all" ? params.tag : null;
  const awaitingFilter = params.awaiting === "1";
  const mineFilter = params.mine === "1";
  const viewFilter =
    params.view === "awaiting" || params.view === "open" ? params.view : null;

  const openStatusSlugs = statuses
    .filter((s) => !s.isClosedState)
    .map((s) => s.slug);
  const { total, rows, page, pageSize, sortKey, sortOrder } =
    await listTicketsForAgent({ params, agentId, openStatusSlugs });

  const visibleColumnIds = new Set(
    columnPrefs.filter((c) => c.visible).map((c) => c.id)
  );
  const ticketIds = rows.map((r) => r.id);

  const [
    tagsByTicket,
    updatedByRows,
    draftTicketIds,
    linkedByTicket,
    ticketActions,
    platformSettings,
  ] = await Promise.all([
    visibleColumnIds.has("tags")
      ? getTicketTagsForTickets(ticketIds)
      : Promise.resolve({} as Record<string, string[]>),
    visibleColumnIds.has("updatedBy") && ticketIds.length > 0
      ? db
          .selectDistinctOn([ticketActivity.ticketId], {
            ticketId: ticketActivity.ticketId,
            actorName: ticketActivity.actorName,
          })
          .from(ticketActivity)
          .where(
            and(
              inArray(ticketActivity.ticketId, ticketIds),
              inArray(ticketActivity.actorRole, [AGENT_ROLE, ADMIN_ROLE])
            )
          )
          .orderBy(ticketActivity.ticketId, desc(ticketActivity.createdAt))
      : Promise.resolve([]),
    getDraftTicketIds(ticketIds, agentId),
    getLinkedTicketNumbers(ticketIds),
    getTicketActionSettings(),
    getPlatformSettings(),
  ]);
  const updatedByTicket = Object.fromEntries(
    updatedByRows.map((r) => [r.ticketId, r.actorName])
  );

  const slaNow = new Date();
  // Waiting Time still needs the base snapshot (waitState/waitingSince/"Open
  // for"); SLA is hidden, so `null` is passed instead of a resolved policy.
  const rowsWithExtras = rows.map((r) => ({
    ...r,
    tags: tagsByTicket[r.id] ?? [],
    hasDraft: draftTicketIds.has(r.id),
    linkedTicketNumbers: linkedByTicket[r.id] ?? [],
    updatedByName: updatedByTicket[r.id] ?? null,
    slaSnapshot: computeSlaSnapshot(
      r,
      // resolveSlaPolicy(slaPolicies, r.category, r.priority),
      null,
      slaNow
    ),
  }));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function buildPageUrl(p: number) {
    const qp = new URLSearchParams();
    if (search) {
      qp.set("q", search);
    }
    if (statusFilter) {
      qp.set("status", statusFilter);
    }
    if (categoryFilter) {
      qp.set("category", categoryFilter);
    }
    if (priorityFilter) {
      qp.set("priority", priorityFilter);
    }
    if (assigneeFilter) {
      qp.set("assignee", assigneeFilter);
    }
    if (tagFilter) {
      qp.set("tag", tagFilter);
    }
    if (rangeFilter) {
      qp.set("range", rangeFilter);
    }
    if (awaitingFilter) {
      qp.set("awaiting", "1");
    }
    if (mineFilter) {
      qp.set("mine", "1");
    }
    if (viewFilter) {
      qp.set("view", viewFilter);
    }
    if (sortKey !== "updatedAt") {
      qp.set("sort", sortKey);
    }
    if (sortOrder !== "desc") {
      qp.set("order", sortOrder);
    }
    if (pageSize !== DEFAULT_PAGE_SIZE) {
      qp.set("pageSize", String(pageSize));
    }
    if (p > 1) {
      qp.set("page", String(p));
    }
    const qs = qp.toString();
    return `/tickets${qs ? `?${qs}` : ""}`;
  }

  // Carries the current filter/sort/page state onto each ticket's detail
  // link, so the ticket detail page's Previous/Next buttons can traverse
  // this same filtered result set (see lib/tickets-list-query.ts).
  const listQuery = buildPageUrl(page).slice("/tickets".length);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-base-content-muted">
          {total} ticket{total === 1 ? "" : "s"}
          {search || statusFilter || categoryFilter
            ? " matching your filters"
            : ""}
        </p>
        <ColumnSettingsDialog columns={columnPrefs} />
      </div>

      {rows.length === 0 ? (
        <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft flex flex-col items-center justify-center py-20 text-center">
          <TicketIcon className="size-10 text-base-content-muted mb-3" />
          <p className="text-base font-medium text-base-content">
            No tickets found
          </p>
          <p className="text-sm text-base-content-muted mt-1">
            {search || statusFilter || categoryFilter || viewFilter
              ? "Try adjusting your filters."
              : "Customers can submit tickets at your support portal."}
          </p>
        </div>
      ) : (
        <>
          <TicketsTable
            agents={agents}
            canMerge={ticketActions.ticketMergeEnabled}
            categoryMap={categoryMap}
            columnPrefs={columnPrefs}
            isAdmin={isAdmin}
            listQuery={listQuery}
            mergeEmailsCustomer={
              ticketActions.ticketMergeCustomerEmailEnabled &&
              platformSettings.ticketEmailNotificationsEnabled
            }
            priorities={priorities}
            priorityMap={priorityMap}
            rows={rowsWithExtras}
            showSlaAndOverdue={showSlaAndOverdue}
            statuses={statuses}
            statusMap={statusMap}
          />

          {/* Pagination */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-base-content-muted shrink-0">
                Rows per page
              </span>
              <PageSizeSelect
                basePath="/tickets"
                options={PAGE_SIZE_OPTIONS}
                pageSize={pageSize}
              />
            </div>

            {totalPages > 1 && (
              <GoToPage basePath="/tickets" totalPages={totalPages} />
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
      )}
    </div>
  );
}

function TicketsTableSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-4 w-28" />
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
        {/* Header */}
        <div className="border-b border-base-300 bg-base-300/50 px-4 py-3">
          <Skeleton className="h-3 w-24" />
        </div>
        {/* Rows */}
        <div className="divide-y divide-base-300/60">
          {skeletonKeys(8).map((k) => (
            <div className="flex items-center gap-4 px-4 py-3.5" key={k}>
              <Skeleton className="h-3 w-10 shrink-0" />
              <Skeleton className="h-4 flex-1 max-w-xs" />
              <Skeleton className="h-5 w-16 rounded-md shrink-0 hidden sm:block" />
              <Skeleton className="h-5 w-20 rounded-md shrink-0 hidden md:block" />
              <Skeleton className="size-7 rounded-full shrink-0 hidden lg:block" />
              <Skeleton className="h-3 w-16 shrink-0 hidden xl:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
