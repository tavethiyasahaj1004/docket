export default function ApiKeysLoading() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-5 w-24 bg-base-300/40 rounded-md animate-pulse" />
          <div className="h-4 w-64 bg-base-300/30 rounded-md animate-pulse" />
        </div>
        <div className="h-9 w-36 bg-base-300/30 rounded-md animate-pulse" />
      </div>
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
        <div className="border-b border-base-300 bg-base-300/50 px-4 py-3">
          <div className="h-3 w-16 bg-base-300/40 rounded-md animate-pulse" />
        </div>
        <div className="divide-y divide-base-300/50">
          {["a", "b", "c"].map((key) => (
            <div className="flex items-center gap-4 px-4 py-3.5" key={key}>
              <div className="h-4 w-32 bg-base-300/30 rounded-md animate-pulse" />
              <div className="h-4 w-40 bg-base-300/20 rounded-md animate-pulse" />
              <div className="h-5 w-16 bg-base-300/30 rounded-md animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
