// What a write call may leave in mcp_tool_calls.result_json (MCP_SECURITY.md
// 7.2: "ids, numbers, booleans, timestamps"). The row is a trace that outlives
// the ticket text, so the sanitizer is an allowlist: anything that could be
// prose, a name, an address or a message body is dropped, never truncated.

const RESULT_STRING_MAX_CHARS = 64;
const RESULT_ARRAY_MAX_ITEMS = 50;
const RESULT_MAX_DEPTH = 4;
// Ids (cuid2, uuid), slugs and ISO-8601 timestamps: no whitespace, no "@".
const SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type SafeValue = string | number | boolean | null | SafeValue[] | SafeObject;
type SafeObject = { [key: string]: SafeValue };

const DROPPED = Symbol("dropped");

function sanitizeValue(value: unknown, depth: number): SafeValue | symbol {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : DROPPED;
  }
  if (typeof value === "string") {
    return value.length <= RESULT_STRING_MAX_CHARS && SAFE_STRING.test(value)
      ? value
      : DROPPED;
  }
  if (depth >= RESULT_MAX_DEPTH) {
    return DROPPED;
  }
  if (Array.isArray(value)) {
    const items: SafeValue[] = [];
    for (const item of value.slice(0, RESULT_ARRAY_MAX_ITEMS)) {
      const kept = sanitizeValue(item, depth + 1);
      if (kept !== DROPPED) {
        items.push(kept as SafeValue);
      }
    }
    return items;
  }
  if (typeof value === "object") {
    const out: SafeObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (!SAFE_KEY.test(key)) {
        continue;
      }
      const kept = sanitizeValue(item, depth + 1);
      if (kept !== DROPPED) {
        out[key] = kept as SafeValue;
      }
    }
    return out;
  }
  return DROPPED;
}

/** Keeps only ids, slugs, numbers, booleans and ISO timestamps (strings of at
 * most 64 characters without whitespace or "@"), nested up to four levels.
 * Everything else is dropped. A non-object input yields `{}`. */
export function sanitizeResultJson(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return sanitizeValue(value, 0) as SafeObject;
}
