import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { env } from "@/lib/env";
import { buildOpenApiSpec } from "@/lib/openapi-spec";

// GET /api/admin/api-keys/openapi — downloads the public API's OpenAPI 3.1 spec,
// pre-filled with this instance's base URL. The Scalar reference renders it and
// Postman imports it directly. No secrets in the file.
export async function GET(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  return NextResponse.json(buildOpenApiSpec(env.NEXT_PUBLIC_APP_URL), {
    headers: {
      "Content-Disposition": 'attachment; filename="docket-api.openapi.json"',
    },
  });
}
