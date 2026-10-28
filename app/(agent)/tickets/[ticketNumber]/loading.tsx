import { Skeleton } from "@/components/ui/skeleton";
import { skeletonKeys } from "@/lib/utils";

export default function TicketDetailLoading() {
  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-base-300 shrink-0">
        <Skeleton className="h-8 w-8 rounded-md" />
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Skeleton className="h-4 w-12 shrink-0" />
          <Skeleton className="h-5 w-px bg-base-300" />
          <Skeleton className="h-5 w-64" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>

      {/* Body — two columns */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Main column */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Description card */}
          <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>

          {/* Comments */}
          {skeletonKeys(3).map((k) => (
            <div
              className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-5 space-y-3"
              key={k}
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}

          {/* Reply form */}
          <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-5 space-y-3">
            <Skeleton className="h-24 w-full rounded-md" />
            <div className="flex justify-end">
              <Skeleton className="h-9 w-24 rounded-md" />
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-72 shrink-0 border-l border-base-300 overflow-y-auto p-5 space-y-6">
          <div className="space-y-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-36" />
          </div>
        </div>
      </div>
    </div>
  );
}
