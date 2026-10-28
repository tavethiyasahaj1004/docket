import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { auth } from "@/lib/auth";

// You cannot special-case RSC requests here: Next strips the whole
// FLIGHT_HEADERS set and the `_rsc` param before invoking middleware, so a
// client navigation and a document request are byte-identical from inside this
// function. A redirect is the only tool; see session-guard.tsx for the rest.
function redirectTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  // The search string belongs to the page we're leaving (ticket list filters,
  // pagination) — it means nothing at the target and only confuses it.
  url.search = "";
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (!session?.user) {
    if (isApi) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return redirectTo(request, "/login");
  }

  const { id, name, email, role, banned } = session.user;

  if (banned) {
    if (isApi) {
      return NextResponse.json({ error: "Account banned" }, { status: 403 });
    }
    return redirectTo(request, "/login");
  }

  const userRole = (role as string) ?? "";
  const isAgent = userRole === AGENT_ROLE || userRole === ADMIN_ROLE;
  const isAdmin = userRole === ADMIN_ROLE;

  // Admin-only routes
  if (
    (request.nextUrl.pathname.startsWith("/admin") ||
      request.nextUrl.pathname.startsWith("/api/admin")) &&
    !isAdmin
  ) {
    if (isApi) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return redirectTo(request, "/tickets");
  }

  // Agent+admin routes
  if (!isAgent) {
    if (isApi) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return redirectTo(request, "/login");
  }

  // Inject user info and pathname into request headers for layouts and API routes
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-id", id);
  requestHeaders.set("x-user-name", name ?? "");
  requestHeaders.set("x-user-email", email);
  requestHeaders.set("x-user-role", userRole);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/settings/:path*",
    "/tickets/:path*",
    "/admin/:path*",
    "/canned-responses/:path*",
    "/api/admin/:path*",
    "/api/stats/:path*",
    "/api/agents/:path*",
    "/api/users/:path*",
    "/api/account/:path*",
    "/api/notifications/:path*",
    "/api/canned-responses/:path*",
    "/api/customers/:path*",
    // NOTE: /api/pusher/* is NOT here — it must allow anonymous customer
    // requests (token-based, no session) alongside agent/admin requests, so
    // it does its own auth check directly (see app/api/pusher/auth/route.ts).
  ],
};
