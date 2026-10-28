"use client";

import { useEffect, useRef } from "react";
import { CHAT_BOTTOM_MARKER_ID } from "@/lib/scroll-chat";

/** Invisible marker that scrolls itself into view once on mount. Place last in a
 * long thread so the page opens at the newest message, whichever ancestor is the
 * real scroll container. Its fixed id lets `scrollChatToBottom()` re-target it. */
export function ScrollToBottomOnMount() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroll = () => ref.current?.scrollIntoView({ block: "end" });
    scroll();
    // Reply bodies use Tiptap's `immediatelyRender: false`, so they mount a tick
    // later and grow taller replacing their plain-text fallback. Re-scroll once
    // settled, or we land wherever the page was mid-mount.
    const timeout = setTimeout(scroll, 200);
    return () => clearTimeout(timeout);
  }, []);

  return <div id={CHAT_BOTTOM_MARKER_ID} ref={ref} />;
}
