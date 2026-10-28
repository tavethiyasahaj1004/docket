import { verifyApiKey } from "@/lib/api-keys";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Auth guard for the public API. Same throw-a-Response pattern as
 * requireAdminFromRequest — call inside try/catch, `return e as Response`. */
export async function requireApiKey(
  request: Request
): Promise<{ id: string; name: string }> {
  const header = request.headers.get("authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!raw) {
    throw jsonError(401, "Missing API key.");
  }
  const key = await verifyApiKey(raw);
  if (!key) {
    throw jsonError(401, "Invalid or revoked API key.");
  }
  return key;
}
