import {
  CaretLeftIcon,
  CaretRightIcon,
  UsersIcon,
} from "@phosphor-icons/react/dist/ssr";
import { count, desc, ilike, or } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { LocalDateTime } from "@/components/common/local-datetime";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ADMIN_ROLE } from "@/config/platform";
import { user } from "@/db/schema";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import { getPlatformSettings } from "@/lib/settings";
import { skeletonKeys } from "@/lib/utils";
import { AddUserDialog } from "./_components/add-user-dialog";
import { UserActions } from "./_components/user-actions";
import { UserSearch } from "./_components/user-search";

type SearchParams = { q?: string; page?: string };

interface Props {
  searchParams: Promise<SearchParams>;
}

const PAGE_SIZE = 25;

export default async function AdminUsersPage({ searchParams }: Props) {
  const session = await requireAdmin();
  const params = await searchParams;
  const settings = await getPlatformSettings();

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto">
      {/* Header actions */}
      <div className="flex items-center justify-end gap-2 mb-6 flex-wrap">
        <UserSearch />
        <AddUserDialog passwordLoginEnabled={settings.passwordLoginEnabled} />
      </div>

      {/* Re-suspends on search/pagination change (key = params) → skeleton shows. */}
      <Suspense fallback={<UsersTableSkeleton />} key={JSON.stringify(params)}>
        <UsersResults currentUserId={session.id} params={params} />
      </Suspense>
    </div>
  );
}

async function UsersResults({
  params,
  currentUserId,
}: {
  params: SearchParams;
  currentUserId: string;
}) {
  const search = (params.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const settings = await getPlatformSettings();

  const where = search
    ? or(ilike(user.name, `%${search}%`), ilike(user.email, `%${search}%`))
    : undefined;

  const [users, [{ total }]] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        banned: user.banned,
        banReason: user.banReason,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(where)
      // Newest first — a just-added user must land at the top of page 1.
      // Ascending would append them to the last page, where they are
      // invisible on any install with more than PAGE_SIZE users.
      .orderBy(desc(user.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(user).where(where),
  ]);

  const pageCount = Math.ceil(total / PAGE_SIZE);

  function buildPageUrl(p: number) {
    const qp = new URLSearchParams();
    if (search) {
      qp.set("q", search);
    }
    if (p > 1) {
      qp.set("page", String(p));
    }
    const qs = qp.toString();
    return `/admin/users${qs ? `?${qs}` : ""}`;
  }

  return (
    <>
      <p className="text-xs text-base-content-muted mb-3">
        {total} registered user{total === 1 ? "" : "s"}
      </p>

      {/* Table */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-clip">
        {users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <UsersIcon className="size-8 text-base-content-muted mb-3" />
            <p className="text-sm font-medium text-base-content">
              No users found
            </p>
            {search && (
              <p className="text-xs text-base-content-muted mt-1">
                Try a different search term
              </p>
            )}
          </div>
        ) : (
          // overflow-y-clip, not "auto" — a plain scroll container here
          // would intercept the sticky header's positioning before it
          // reaches the page's real scrolling ancestor.
          <div className="overflow-x-auto overflow-y-clip">
            <table className="w-full text-sm">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-base-300 bg-base-300">
                  <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    User
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Role
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                    Joined
                  </th>
                  <th className="w-px px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300/50">
                {users.map((u) => (
                  <tr
                    className="hover:bg-base-300/30 transition-colors"
                    key={u.id}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="size-8 rounded-full bg-primary/10 border border-base-300 flex items-center justify-center text-xs font-semibold text-base-content shrink-0">
                          {(u.name ?? u.email).slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-base-content truncate">
                            {u.name}
                          </p>
                          <p className="text-xs text-base-content-muted truncate">
                            {u.email}
                          </p>
                          {u.banReason && (
                            <p className="text-xs text-base-content-muted truncate mt-0.5">
                              Reason: {u.banReason}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${
                          u.role === ADMIN_ROLE
                            ? "bg-primary/10 border-primary/20 text-base-content"
                            : "bg-base-300/20 border-base-300 text-base-content-muted"
                        }`}
                      >
                        {u.role === ADMIN_ROLE ? "Admin" : "Agent"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${
                          u.banned
                            ? "bg-base-300/20 border-base-300 text-base-content-muted"
                            : "bg-green-50 border-green-200 text-green-700"
                        }`}
                      >
                        {u.banned ? "Deactivated" : "Active"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-base-content-muted whitespace-nowrap">
                      <LocalDateTime date={u.createdAt} mode="date" />
                    </td>
                    <td className="w-px px-4 py-3 text-right">
                      <UserActions
                        isCurrentUser={u.id === currentUserId}
                        passwordResetEnabled={settings.passwordLoginEnabled}
                        userDeactivated={u.banned}
                        userEmail={u.email}
                        userId={u.id}
                        userName={u.name}
                        userRole={u.role}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between mt-4 text-xs text-base-content-muted">
          <span>
            Page {page} of {pageCount} · {total} users
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={buildPageUrl(page - 1)}>
                <Button
                  className="h-8 gap-1 border-base-300 text-base-content hover:bg-base-300"
                  size="sm"
                  variant="outline"
                >
                  <CaretLeftIcon className="size-3" />
                  Previous
                </Button>
              </Link>
            )}
            {page < pageCount && (
              <Link href={buildPageUrl(page + 1)}>
                <Button
                  className="h-8 gap-1 border-base-300 text-base-content hover:bg-base-300"
                  size="sm"
                  variant="outline"
                >
                  Next
                  <CaretRightIcon className="size-3" />
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function UsersTableSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-32 mb-3" />
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
        <div className="border-b border-base-300 bg-base-300/50 px-4 py-3">
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="divide-y divide-base-300/50">
          {skeletonKeys(6).map((k) => (
            <div className="flex items-center gap-4 px-4 py-3.5" key={k}>
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Skeleton className="size-8 rounded-full shrink-0" />
                <div className="space-y-1.5 min-w-0">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-44" />
                </div>
              </div>
              <Skeleton className="h-5 w-14 rounded-md shrink-0" />
              <Skeleton className="h-5 w-16 rounded-md shrink-0 hidden sm:block" />
              <Skeleton className="h-3 w-20 shrink-0 hidden md:block" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
