import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { env } from "@/lib/env";
import { buildWebhooksOpenApiSpec } from "@/lib/webhooks-openapi-spec";

// GET /api/admin/webhooks/openapi — downloads the OUTBOUND webhooks OpenAPI 3.1
// spec, pre-filled with this instance's base URL. Rendered by Scalar at
// /admin/webhooks/docs. Signing secrets are never included.
export async function GET(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  return NextResponse.json(buildWebhooksOpenApiSpec(env.NEXT_PUBLIC_APP_URL), {
    headers: {
      "Content-Disposition":
        'attachment; filename="docket-webhooks.openapi.json"',
    },
  });
}
