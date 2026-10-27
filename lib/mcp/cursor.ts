// Opaque thread cursor: base64url of `<createdAt ISO>|<item id>`. Paging is by
// position in a stable (createdAt, id) order, not by offset, so a reply added
// mid-pagination never shifts a later page.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ThreadCursor = { createdAt: Date; id: string };

export function encodeThreadCursor(createdAtIso: string, id: string): string {
  return Buffer.from(`${createdAtIso}|${id}`, "utf8").toString("base64url");
}

/** The decoded cursor, or null for anything that is not one we issued. */
export function decodeThreadCursor(raw: string): ThreadCursor | null {
  if (raw.length === 0 || raw.length > 200) {
    return null;
  }
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const separator = text.indexOf("|");
  if (separator <= 0) {
    return null;
  }
  const iso = text.slice(0, separator);
  const id = text.slice(separator + 1);
  const createdAt = new Date(iso);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== iso ||
    !ID_PATTERN.test(id)
  ) {
    return null;
  }
  // Re-encoding must reproduce the input, so lenient base64 variants are out.
  if (encodeThreadCursor(iso, id) !== raw) {
    return null;
  }
  return { createdAt, id };
}

/** Total order used by the thread: time first, then id as the tie-break. */
export function compareThreadPosition(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string }
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  if (a.id < b.id) {
    return -1;
  }
  return a.id > b.id ? 1 : 0;
}
