import { Skeleton } from "@/components/ui/skeleton";

export default function McpLoading() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-3">
        <Skeleton className="h-5 w-24" />
        {["a", "b", "c"].map((key) => (
          <Skeleton className="h-10 w-full" key={key} />
        ))}
      </div>
    </div>
  );
}
