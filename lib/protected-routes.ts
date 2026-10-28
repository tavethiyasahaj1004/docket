// Page routes requiring an agent/admin session. Keep in sync with the page
// entries of `config.matcher` in proxy.ts, which can't import this list because
// Next requires that matcher to be a statically analysable literal.
export const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/tickets",
  "/admin",
  "/canned-responses",
] as const;

export function isProtectedPagePath(pathname: string) {
  return PROTECTED_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
