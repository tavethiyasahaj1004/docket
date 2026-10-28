import { type NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { auth } from "@/lib/auth";
import { parseFileKey, verifyFileSignature } from "@/lib/file-access";
import { storage } from "@/lib/storage";

// Branding files are public. A ticket file needs a valid signed link (the
// customer portal mints them) or an agent/admin session; this route is outside
// proxy.ts's matcher, so it checks the session itself. Every refusal is the
// same 404 as a missing file. See lib/file-access.ts.
function notFound() {
  return NextResponse.json({ error: "File not found" }, { status: 404 });
}

async function hasStaffSession(request: NextRequest): Promise<boolean> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const user = session?.user;
    if (!user || user.banned) {
      return false;
    }
    return user.role === AGENT_ROLE || user.role === ADMIN_ROLE;
  } catch {
    return false;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const { key } = await params;
  const file = parseFileKey(key);
  if (!file) {
    return notFound();
  }

  // A signed (portal) link may be cached privately for its hour. A file served
  // on a session must not outlive the sign-out in a shared browser's cache.
  let cacheControl = "private, max-age=3600";
  if (file.scope === "tickets") {
    const { searchParams } = request.nextUrl;
    const signed = verifyFileSignature(
      file.key,
      searchParams.get("exp"),
      searchParams.get("sig")
    );
    if (!signed) {
      if (!(await hasStaffSession(request))) {
        return notFound();
      }
      cacheControl = "no-store";
    }
  }
  const storageKey = file.key;

  try {
    const buffer = await storage.download(storageKey);

    // Derive content-type from extension
    const ext = storageKey.split(".").pop()?.toLowerCase() ?? "";
    const contentTypeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
      ico: "image/x-icon",
      pdf: "application/pdf",
      zip: "application/zip",
      txt: "text/plain",
    };
    const contentType = contentTypeMap[ext] ?? "application/octet-stream";

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
      },
    });
  } catch {
    return notFound();
  }
}
