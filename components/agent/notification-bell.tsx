"use client";

import { BellIcon, TicketIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getPusherClient } from "@/lib/pusher-browser";
import { cn } from "@/lib/utils";

type NotifTab = "all" | "unread" | "read";
const TABS: NotifTab[] = ["all", "unread", "read"];

interface Notification {
  body: string | null;
  createdAt: string;
  id: string;
  isRead: boolean;
  ticketId: string | null;
  ticketNumber: number | null;
  title: string;
  type: string;
}

const POLL_INTERVAL_MS = 30_000;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) {
    return "just now";
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function NotificationBell({ userId }: { userId: string }) {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotifTab>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        // The session died while this tab sat open. This poll is usually the
        // first thing to notice, so send them to /login now rather than leaving
        // a signed-out shell on screen until they click something. A full load
        // (not router.push) so the whole tree is rebuilt without a session.
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as {
        items: Notification[];
        unreadCount: number;
      };
      setItems(data.items);
      setUnread(data.unreadCount);
    } catch {
      // ignore transient errors
    }
  }, []);

  // Initial load, then either instant updates via Pusher Channels or —
  // only when Channels isn't configured — polling as a fallback. Avoids
  // hitting the DB every 30s per open tab once real-time is available.
  useEffect(() => {
    load();

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const channelName = `private-user-${userId}`;

    (async () => {
      const pusher = await getPusherClient();
      if (cancelled) {
        return;
      }
      if (pusher) {
        const channel = pusher.subscribe(channelName);
        channel.bind("notification.created", load);
        unsubscribe = () => {
          channel.unbind_all();
          pusher.unsubscribe(channelName);
        };
      } else {
        pollTimer = setInterval(load, POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }, [load, userId]);

  // Refresh when the panel is opened.
  useEffect(() => {
    if (open) {
      load();
    }
  }, [open, load]);

  async function markAllRead() {
    const count = unread;
    if (count === 0) {
      return;
    }
    const previousItems = items;
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
    try {
      const res = await fetch("/api/notifications/read", { method: "POST" });
      if (!res.ok) {
        throw new Error("Failed to mark notifications as read.");
      }
      toast.success(
        `${count} notification${count === 1 ? "" : "s"} marked as read.`
      );
    } catch {
      setItems(previousItems);
      setUnread(count);
      toast.error("Failed to mark notifications as read.");
    }
  }

  async function openNotification(n: Notification) {
    setOpen(false);
    if (!n.isRead) {
      setItems((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
      );
      setUnread((u) => Math.max(0, u - 1));
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }
    if (n.ticketNumber) {
      router.push(`/tickets/${n.ticketNumber}`);
    }
  }

  const filtered =
    tab === "unread"
      ? items.filter((n) => !n.isRead)
      : tab === "read"
        ? items.filter((n) => n.isRead)
        : items;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Notifications"
          className="relative flex size-9 items-center justify-center rounded-md text-base-content-muted hover:text-base-content hover:bg-base-300 transition-colors"
          type="button"
        >
          <BellIcon
            className="size-5"
            weight={unread > 0 ? "fill" : "regular"}
          />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-2xs font-semibold flex items-center justify-center">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-base-300">
          <span className="text-sm font-semibold text-base-content">
            Notifications
          </span>
          {unread > 0 && (
            <button
              className="text-xs text-base-content-muted hover:text-base-content transition-colors cursor-pointer"
              onClick={markAllRead}
              type="button"
            >
              Mark all read
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-base-300 p-1.5">
          {TABS.map((t) => (
            <button
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-colors cursor-pointer",
                tab === t
                  ? "bg-base-300 text-base-content"
                  : "text-base-content-muted hover:text-base-content hover:bg-base-300/50"
              )}
              key={t}
              onClick={() => setTab(t)}
              type="button"
            >
              {t}
              {t === "unread" && unread > 0 ? ` (${unread})` : ""}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <BellIcon className="size-7 text-base-content-muted mx-auto mb-2" />
            <p className="text-sm text-base-content-muted">
              {tab === "unread"
                ? "No unread notifications."
                : tab === "read"
                  ? "No read notifications."
                  : "No notifications yet."}
            </p>
          </div>
        ) : (
          <ul className="max-h-96 overflow-y-auto divide-y divide-base-300/60">
            {filtered.map((n) => (
              <li key={n.id}>
                <button
                  className={`w-full text-left px-4 py-3 flex gap-3 cursor-pointer hover:bg-base-300/50 transition-colors ${
                    n.isRead ? "" : "bg-base-300/30"
                  }`}
                  onClick={() => openNotification(n)}
                  type="button"
                >
                  <div className="mt-0.5 shrink-0">
                    <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center">
                      <TicketIcon
                        className="size-3.5 text-base-content"
                        weight="fill"
                      />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-base-content leading-snug wrap-break-word">
                      {n.title}
                    </p>
                    {n.body && (
                      <p className="text-xs text-base-content-muted mt-0.5 line-clamp-2 wrap-break-word">
                        {n.body}
                      </p>
                    )}
                    <p className="text-2xs text-base-content-muted/70 mt-1">
                      {relativeTime(n.createdAt)}
                    </p>
                  </div>
                  {!n.isRead && (
                    <span className="mt-1 size-2 rounded-full bg-red-500 shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
