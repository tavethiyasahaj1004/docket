"use client";

import { useEffect } from "react";

// How often to re-check while the tab is in the foreground. Long enough to be
// invisible in the request log, short enough that an idle tab doesn't sit on a
// dead session for minutes.
const POLL_MS = 60_000;

/** Sends the agent portal to /login once its session expires. Left alone, expiry
 * surfaces on the next RSC request, which the proxy can only answer with a
 * redirect — and the router, handed a payload for a route it never asked for,
 * renders "404" at /tickets. So detect it first and leave via a full page load. */
export function SessionGuard() {
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      let res: Response;
      try {
        res = await fetch("/api/account/session", { cache: "no-store" });
      } catch {
        // Offline or a dropped connection — not an auth failure. Signing
        // someone out because their wifi blipped would be worse than waiting.
        return;
      }
      if (cancelled || (res.status !== 401 && res.status !== 403)) {
        return;
      }
      cancelled = true;
      window.location.href = "/login";
    };

    const interval = setInterval(check, POLL_MS);
    // A tab that's been in the background is the likeliest one to be holding a
    // session that expired while nobody was looking.
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  return null;
}
