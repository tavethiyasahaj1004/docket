import { skeletonKeys } from "@/lib/utils";

export default function TicketConfigLoading() {
  return (
    <div className="p-6 space-y-8 max-w-4xl mx-auto">
      <div className="space-y-2">
        <div className="h-7 w-40 bg-base-300/40 rounded-md animate-pulse" />
        <div className="h-4 w-72 bg-base-300/30 rounded-md animate-pulse" />
      </div>

      {/* Statuses skeleton */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-28 bg-base-300/40 rounded-md animate-pulse" />
          <div className="h-9 w-28 bg-base-300/30 rounded-md animate-pulse" />
        </div>
        <div className="space-y-3">
          {skeletonKeys(3).map((k) => (
            <div className="flex items-center gap-3" key={k}>
              <div className="size-5 rounded-full bg-base-300/40 animate-pulse" />
              <div className="h-4 w-24 bg-base-300/30 rounded-md animate-pulse" />
              <div className="h-4 w-20 bg-base-300/20 rounded-md animate-pulse ml-2" />
              <div className="ml-auto flex gap-2">
                <div className="h-8 w-14 bg-base-300/30 rounded-md animate-pulse" />
                <div className="h-8 w-14 bg-base-300/30 rounded-md animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Categories skeleton */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-28 bg-base-300/40 rounded-md animate-pulse" />
          <div className="h-9 w-32 bg-base-300/30 rounded-md animate-pulse" />
        </div>
        <div className="space-y-3">
          {skeletonKeys(5).map((k) => (
            <div className="flex items-center gap-3" key={k}>
              <div className="size-5 rounded-full bg-base-300/40 animate-pulse" />
              <div className="h-4 w-28 bg-base-300/30 rounded-md animate-pulse" />
              <div className="ml-auto flex gap-2">
                <div className="h-8 w-14 bg-base-300/30 rounded-md animate-pulse" />
                <div className="h-8 w-14 bg-base-300/30 rounded-md animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Priorities skeleton */}
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-28 bg-base-300/40 rounded-md animate-pulse" />
          <div className="h-9 w-28 bg-base-300/30 rounded-md animate-pulse" />
        </div>
        <div className="space-y-3">
          {skeletonKeys(4).map((k) => (
            <div className="flex items-center gap-3" key={k}>
              <div className="size-5 rounded-full bg-base-300/40 animate-pulse" />
              <div className="h-4 w-24 bg-base-300/30 rounded-md animate-pulse" />
              <div className="ml-auto flex gap-2">
                <div className="h-8 w-14 bg-base-300/30 rounded-md animate-pulse" />
                <div className="h-8 w-14 bg-base-300/30 rounded-md animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
