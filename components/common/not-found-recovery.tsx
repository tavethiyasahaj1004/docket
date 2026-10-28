"use client";

import { useEffect } from "react";
import { isProtectedPagePath } from "@/lib/protected-routes";

const RETRIED_KEY = "docket_not_found_retried";
// Enough to cover a browsing session's worth of dead links without growing
// unbounded; oldest entries fall off the front.
const RETRIED_LIMIT = 20;

/** Last line of defence against not-found rendering at a URL that does exist —
 * the expired-session RSC trap SessionGuard usually catches first. On a path
 * needing a session, reload as a document request. The retry is recorded *before*
 * reloading and only a successful write permits it, so a real 404 can't loop. */
export function NotFoundRecovery() {
  useEffect(() => {
    const { pathname } = window.location;
    if (!isProtectedPagePath(pathname)) {
      return;
    }

    try {
      const raw = sessionStorage.getItem(RETRIED_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      const retried = Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === "string")
        : [];
      if (retried.includes(pathname)) {
        return;
      }
      sessionStorage.setItem(
        RETRIED_KEY,
        JSON.stringify([...retried, pathname].slice(-RETRIED_LIMIT))
      );
    } catch {
      // sessionStorage is unreadable or unwritable, so we can't tell a first
      // attempt from a repeat. Reloading blind would loop on a real 404.
      return;
    }

    window.location.reload();
  }, []);

  return null;
}
