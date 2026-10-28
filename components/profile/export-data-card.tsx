import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/ssr";
import { Button } from "@/components/ui/button";

// No client interactivity needed — the browser handles the download itself
// via the route's Content-Disposition header, same pattern as the OpenAPI/
// Postman download buttons on /admin/api-keys/docs.
export function ExportDataCard() {
  return (
    <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-base-content">
          Export Your Data
        </h2>
        <p className="text-xs text-base-content-muted mt-0.5">
          Download a copy of your profile, active sessions, linked sign-in
          methods, and account activity as a JSON file.
        </p>
      </div>
      <Button asChild size="sm" variant="outline">
        <a download href="/api/account/export">
          <DownloadSimpleIcon className="size-4" />
          Download my data
        </a>
      </Button>
    </div>
  );
}
