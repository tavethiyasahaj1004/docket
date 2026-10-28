import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

// Who may read a file through /api/files/[...key]:
// - `branding/*` (logo, favicon): anyone. Emails embed the logo by URL.
// - `tickets/*`: a signed link minted while rendering the customer portal, or an
//   agent/admin session (the route checks it). Everything else is the same 404
//   as a missing file.

const HOUR_MS = 60 * 60 * 1000;

// HKDF label for the link-signing key. The key is used for nothing else, and
// APP_SECRET itself never signs a link.
const SIGNING_KEY_INFO = "docket:file-url-signature:v1";

const SCOPES = ["tickets", "branding"] as const;
export type FileScope = (typeof SCOPES)[number];

const EXPIRES_PATTERN = /^\d{1,15}$/;
// base64url of a SHA-256 HMAC, unpadded: always 43 characters.
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function signingKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.APP_SECRET, "", SIGNING_KEY_INFO, 32)
  );
}

function signature(key: string, expiresSeconds: string): string {
  return createHmac("sha256", signingKey())
    .update(`${expiresSeconds}:${key}`)
    .digest("base64url");
}

/** When a link minted at `nowMs` expires (epoch ms): the end of the clock hour
 * after the minting hour, so a link lives more than one hour and at most two.
 * Whole UTC hours of epoch time, so no time zone moves the boundary, and every
 * link for one key minted within an hour is byte-identical (browser caching
 * keeps working across portal re-renders). */
export function fileUrlExpiresAt(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS + 2 * HOUR_MS;
}

/** A signed, expiring `/api/files/...` link for a ticket file, for the customer
 * portal. Synchronous, so callers can build it inline while rendering. Only
 * mint one for a file the page is already showing. */
export function signFileUrl(key: string, nowMs: number = Date.now()): string {
  const expires = String(fileUrlExpiresAt(nowMs) / 1000);
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `/api/files/${path}?exp=${expires}&sig=${signature(key, expires)}`;
}

/** Whether `exp`/`sig` from a request are a valid, unexpired signature for
 * `key`. Malformed or missing values are simply invalid. */
export function verifyFileSignature(
  key: string,
  expires: string | null,
  sig: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!(expires && sig)) {
    return false;
  }
  if (!(EXPIRES_PATTERN.test(expires) && SIGNATURE_PATTERN.test(sig))) {
    return false;
  }
  const expected = Buffer.from(signature(key, expires));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return false;
  }
  return nowMs < Number(expires) * 1000;
}

/** Validates the route's decoded path segments as a storage key: a known
 * scope, then plain segments only (no empty, `.`, `..`, slash, backslash or
 * NUL), so a key can never step outside its scope on any driver. */
export function parseFileKey(
  segments: string[]
): { key: string; scope: FileScope } | null {
  if (segments.length < 2) {
    return null;
  }
  const scope = SCOPES.find((s) => s === segments[0]);
  if (!scope) {
    return null;
  }
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      /[/\\\0]/.test(segment)
    ) {
      return null;
    }
  }
  return { key: segments.join("/"), scope };
}
