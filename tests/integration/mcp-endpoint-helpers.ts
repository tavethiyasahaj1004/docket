import { NextRequest } from "next/server";
import { POST as mcpPostHandler } from "@/app/api/mcp/route";

export const MCP_URL = "http://localhost:3000/api/mcp";

export const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "endpoint-test", version: "0.0.0" },
  },
};

export type McpRequestOptions = {
  /** Bearer token (the raw value). */
  token?: string;
  /** Full Authorization header, overriding `token`. */
  authorization?: string;
  /** A JSON-serializable body, or a raw string sent as is. */
  body?: unknown;
  headers?: Record<string, string>;
};

export function buildMcpRequest(options: McpRequestOptions = {}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  } else if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const body = options.body === undefined ? INITIALIZE_BODY : options.body;
  return new NextRequest(MCP_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function callMcp(options: McpRequestOptions = {}) {
  return mcpPostHandler(buildMcpRequest(options));
}

/** Seconds of a Retry-After header, or NaN. */
export function retryAfter(res: Response): number {
  return Number(res.headers.get("retry-after"));
}
