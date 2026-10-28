import { Skeleton } from "@/components/ui/skeleton";
import { skeletonKeys } from "@/lib/utils";

export default function TicketsLoading() {
  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
        {/* Filter bar */}
        <div className="flex gap-2 flex-wrap">
          <Skeleton className="h-9 w-48 rounded-md" />
          <Skeleton className="h-9 w-32 rounded-md" />
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
      </div>

      {/* Table */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
        {/* Table header */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-base-300 bg-base-300/50">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
        {/* Rows */}
        <div className="divide-y divide-base-300/50">
          {skeletonKeys(10).map((k) => (
            <div className="flex items-center gap-4 px-4 py-3.5" key={k}>
              <Skeleton className="h-4 w-10 shrink-0 font-mono" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-5 w-20 rounded-md shrink-0" />
              <Skeleton className="h-5 w-24 rounded-md shrink-0" />
              <Skeleton className="h-4 w-24 shrink-0" />
              <Skeleton className="h-4 w-20 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
