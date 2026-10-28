import {
  ArrowLeftIcon,
  DownloadSimpleIcon,
  FileCodeIcon,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { ScalarReference } from "@/components/common/scalar-reference";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/authz";
import { env } from "@/lib/env";
import { buildOpenApiSpec } from "@/lib/openapi-spec";

export const metadata = { title: "API Docs" };

// Interactive API reference rendered by Scalar from lib/openapi-spec.ts. Built
// server-side so it carries this instance's own base URL, letting the "Test
// Request" client work same-origin with a key from /admin/api-keys.
export default async function ApiDocsPage() {
  await requireAdmin();

  const spec = buildOpenApiSpec(env.NEXT_PUBLIC_APP_URL);

  return (
    <div className="flex flex-col min-h-screen">
      <div className="p-6 pb-4 space-y-4 border-b border-base-300">
        <Link
          className="flex w-fit items-center gap-1.5 text-sm text-base-content-muted hover:text-base-content transition-colors"
          href="/admin/api-keys"
        >
          <ArrowLeftIcon className="size-3.5" />
          API Keys
        </Link>

        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-base-content">
              API Documentation
            </h1>
            <p className="text-sm text-base-content-muted mt-1">
              Create tickets from your own website&apos;s backend. Use{" "}
              <span className="font-medium text-base-content">
                Test Request
              </span>{" "}
              below with a key from API Keys to try calls against this instance.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              asChild
              size="sm"
              title="The canonical machine-readable contract — importable into Postman and most API tooling"
              variant="outline"
            >
              <a download href="/api/admin/api-keys/openapi">
                <FileCodeIcon className="size-4" />
                OpenAPI Spec
              </a>
            </Button>
            <Button
              asChild
              size="sm"
              title="Ready-to-import Postman collection pre-filled with this instance's URL"
              variant="outline"
            >
              <a download href="/api/admin/api-keys/postman">
                <DownloadSimpleIcon className="size-4" />
                Postman Collection
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1">
        <ScalarReference preferredSecurityScheme="apiKey" spec={spec} />
      </div>
    </div>
  );
}
