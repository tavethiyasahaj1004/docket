/** Sidebar open-vs-collapsed state, in a cookie rather than localStorage so the
 * server layout can render the right width in the initial HTML — no flash, no
 * hydration mismatch. Free of `next/headers` so the client can import it too. */
export const SIDEBAR_COOKIE = "docket_sidebar";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function isSidebarCollapsed(value: string | undefined): boolean {
  return value === "collapsed";
}
