import { env } from "@/lib/env";

/** JSON response for the MCP layer. Always `Cache-Control: no-store`. */
export function mcpJson(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/** Tokens travel in a header on every request, so a production deploy must be
 * served over https. Anything outside production (dev, test) is exempt. */
export function isHttpsRequirementMet(
  inputs: { nodeEnv?: string; appUrl?: string } = {}
): boolean {
  const nodeEnv = inputs.nodeEnv ?? env.NODE_ENV;
  const appUrl = inputs.appUrl ?? env.NEXT_PUBLIC_APP_URL;
  return nodeEnv !== "production" || appUrl.startsWith("https://");
}

/** MCP answers only when an admin switched it on AND the https rule holds; a
 * non-https production config counts as disabled at request time too. */
export function isMcpServing(
  settings: { mcpEnabled: boolean },
  inputs: { nodeEnv?: string; appUrl?: string } = {}
): boolean {
  return settings.mcpEnabled && isHttpsRequirementMet(inputs);
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

/** Browsers always send `Origin` on cross-site requests; MCP clients usually
 * send none. A present Origin must be this app's or an explicitly allowed one. */
export function checkOrigin(
  request: Request,
  inputs: { appUrl?: string; allowedOrigins?: string } = {}
): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return null;
  }
  const appUrl = inputs.appUrl ?? env.NEXT_PUBLIC_APP_URL;
  const allowedOrigins = inputs.allowedOrigins ?? env.MCP_ALLOWED_ORIGINS ?? "";

  const allowed = new Set<string>();
  const appOrigin = normalizeOrigin(appUrl);
  if (appOrigin) {
    allowed.add(appOrigin);
  }
  for (const entry of allowedOrigins.split(",")) {
    const normalized = entry.trim() ? normalizeOrigin(entry) : null;
    if (normalized) {
      allowed.add(normalized);
    }
  }

  const presented = normalizeOrigin(origin);
  if (presented && allowed.has(presented)) {
    return null;
  }
  return mcpJson({ error: "Origin not allowed." }, 403);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** DNS-rebinding protection for a local install: when the app itself lives on a
 * loopback address, only loopback Host headers are served. Real deployments sit
 * behind proxies that may rewrite Host, so the check is skipped for them. */
export function checkHost(
  request: Request,
  inputs: { appUrl?: string } = {}
): Response | null {
  const appUrl = inputs.appUrl ?? env.NEXT_PUBLIC_APP_URL;
  let appHostname: string;
  try {
    appHostname = new URL(appUrl).hostname;
  } catch {
    return null;
  }
  if (!isLoopbackHostname(appHostname)) {
    return null;
  }

  // Falls back to the URL's own host when a client sent no Host header.
  const host = request.headers.get("host");
  let hostname: string | null = null;
  try {
    hostname = host
      ? new URL(`http://${host}`).hostname
      : new URL(request.url).hostname;
  } catch {
    hostname = null;
  }
  if (hostname && isLoopbackHostname(hostname)) {
    return null;
  }
  return mcpJson({ error: "Host not allowed." }, 403);
}

const TOO_LARGE = () => mcpJson({ error: "Request body too large." }, 413);

/** Reads the body as text, refusing more than `maxBytes` — by the declared
 * Content-Length first, then by counting streamed bytes (which also covers a
 * missing or lying header). */
export async function readBodyCapped(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return { ok: false, response: TOO_LARGE() };
  }
  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, response: TOO_LARGE() };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function jsonRpcError(code: number, message: string): Response {
  return mcpJson({ jsonrpc: "2.0", error: { code, message }, id: null }, 400);
}

/** One JSON-RPC message per POST: rejects malformed JSON and batch arrays. */
export function parseSingleJsonRpc(
  text: string
): { ok: true; message: unknown } | { ok: false; response: Response } {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonRpcError(-32_700, "Parse error") };
  }
  if (Array.isArray(message)) {
    return {
      ok: false,
      response: jsonRpcError(-32_600, "Batch requests are not supported."),
    };
  }
  return { ok: true, message };
}

/** Seconds until the current fixed one-minute rate-limit window ends. */
export function secondsUntilWindowEnds(windowMs = 60_000): number {
  const now = Date.now();
  const end = (Math.floor(now / windowMs) + 1) * windowMs;
  return Math.max(1, Math.ceil((end - now) / 1000));
}

/** The public URL of the MCP endpoint, as shown to users for client setup. */
export function getMcpUrl(appUrl: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${appUrl.replace(/\/+$/, "")}/api/mcp`;
}
