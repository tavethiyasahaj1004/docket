import { Skeleton } from "@/components/ui/skeleton";
import { skeletonKeys } from "@/lib/utils";

export default function AppearanceLoading() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <Skeleton className="h-5 w-5 rounded" />
        <div className="space-y-1">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>

      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-8">
        {/* Appearance mode */}
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="grid grid-cols-3 gap-3">
            {skeletonKeys(3).map((k) => (
              <Skeleton className="h-16 rounded-xl" key={k} />
            ))}
          </div>
        </div>

        {/* Color theme */}
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {skeletonKeys(6).map((k) => (
              <Skeleton className="h-20 rounded-xl" key={k} />
            ))}
          </div>
        </div>

        {/* Action bar */}
        <div className="flex justify-end gap-2 border-t border-base-300 pt-4">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      </div>

      {/* Sign-in methods */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4 mt-6">
        <div className="space-y-1">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-72" />
        </div>
        <div className="divide-y divide-base-300 rounded-lg border border-base-300">
          {skeletonKeys(3).map((k) => (
            <div
              className="flex items-center justify-between gap-4 p-4"
              key={k}
            >
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
