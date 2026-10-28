import { Skeleton } from "@/components/ui/skeleton";
import { skeletonKeys } from "@/lib/utils";

export default function AdminUsersLoading() {
  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-5 rounded" />
          <div className="space-y-1">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-48 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>

      {/* Table */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-5 gap-4 px-4 py-3 border-b border-base-300 bg-base-300/50">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-6 ml-auto" />
        </div>
        {/* Rows */}
        <div className="divide-y divide-base-300/50">
          {skeletonKeys(10).map((k) => (
            <div
              className="grid grid-cols-5 gap-4 items-center px-4 py-3"
              key={k}
            >
              {/* User cell */}
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full shrink-0" />
                <div className="space-y-1 min-w-0">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <Skeleton className="h-5 w-16 rounded" />
              <Skeleton className="h-5 w-14 rounded" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-8 rounded-md ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
