import { Skeleton } from "@/components/ui/skeleton";
import { skeletonKeys } from "@/lib/utils";

export default function AuditLogLoading() {
  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex gap-3">
        <Skeleton className="h-10 flex-1 rounded-md" />
        <Skeleton className="h-10 w-56 rounded-md" />
      </div>

      <div>
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
      </div>
    </div>
  );
}
