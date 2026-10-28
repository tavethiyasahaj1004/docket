import {
  revokeSessionAction,
  signOutOtherSessionsAction,
} from "@/app/actions/profile";
import { LocalDateTime } from "@/components/common/local-datetime";
import { Button } from "@/components/ui/button";

export interface SessionRow {
  createdAt: string;
  expiresAt: string;
  id: string;
  ipAddress: string | null;
  isCurrent: boolean;
  userAgent: string | null;
}

export function SessionsCard({ sessions }: { sessions: SessionRow[] }) {
  const otherSessionCount = sessions.filter(
    (session) => !session.isCurrent
  ).length;

  return (
    <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
      <div className="p-6 pb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-base-content">
            Active Sessions
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Review signed-in devices and revoke anything you don&apos;t
            recognize.
          </p>
        </div>
        {otherSessionCount > 0 && (
          <form action={signOutOtherSessionsAction}>
            <Button size="sm" type="submit" variant="outline">
              Sign out other sessions
            </Button>
          </form>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-t border-b border-base-300 bg-base-300/50">
              <th className="text-left px-6 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                Session
              </th>
              <th className="text-left px-6 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                IP
              </th>
              <th className="text-left px-6 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                Created
              </th>
              <th className="text-left px-6 py-3 text-xs font-medium text-base-content-muted uppercase tracking-wide">
                Expires
              </th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-base-300/50">
            {sessions.map((session) => (
              <tr
                className="hover:bg-base-300/30 transition-colors"
                key={session.id}
              >
                <td className="px-6 py-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-base-content">
                        {session.userAgent
                          ? describeUserAgent(session.userAgent)
                          : "Unknown device"}
                      </span>
                      {session.isCurrent && (
                        <span className="inline-flex items-center rounded border border-green-200 bg-green-50 px-1.5 py-0.5 text-2xs font-medium text-green-700">
                          Current
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-3 font-mono text-xs text-base-content-muted">
                  {session.ipAddress ?? "—"}
                </td>
                <td className="px-6 py-3 text-xs text-base-content-muted whitespace-nowrap">
                  <LocalDateTime date={session.createdAt} />
                </td>
                <td className="px-6 py-3 text-xs text-base-content-muted whitespace-nowrap">
                  <LocalDateTime date={session.expiresAt} />
                </td>
                <td className="px-6 py-3 text-right">
                  {session.isCurrent ? (
                    <span className="text-xs text-base-content-muted">
                      Protected
                    </span>
                  ) : (
                    <form action={revokeSessionAction}>
                      <input
                        name="sessionId"
                        type="hidden"
                        value={session.id}
                      />
                      <Button size="sm" type="submit" variant="outline">
                        Revoke
                      </Button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describeUserAgent(userAgent: string) {
  const browser = /Firefox/i.test(userAgent)
    ? "Firefox"
    : /Edg/i.test(userAgent)
      ? "Edge"
      : /Chrome/i.test(userAgent)
        ? "Chrome"
        : /Safari/i.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /Windows/i.test(userAgent)
    ? "Windows"
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? "macOS"
      : /iPhone|iPad/i.test(userAgent)
        ? "iOS"
        : /Android/i.test(userAgent)
          ? "Android"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : "";

  return os ? `${browser} on ${os}` : browser;
}
