import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { auth } from "@/lib/auth";

// Direct session lookup — only use on non-middleware-protected routes (login, post-auth, landing page).
// Middleware-protected routes should use getSessionUser() instead (reads from injected headers).
export async function getCurrentSession() {
  return auth.api.getSession({ headers: await headers() });
}

// getCurrentSession(), but bypassing Better Auth's cookieCache to re-read from
// the DB. That cache stands in for a row for 60s — including after the row is
// gone, e.g. a fresh database behind old cookies — which makes the sign-in
// guards and /post-auth disagree and bounce the browser between them forever.
export async function getVerifiedSession() {
  return auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
}

export async function requireSession() {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

// Reads user info from request headers injected by middleware.
// Never calls auth.api.getSession() — middleware already validated the session.
export async function getSessionUser(): Promise<SessionUser | null> {
  const h = await headers();
  const id = h.get("x-user-id");
  if (!id) {
    return null;
  }
  return {
    id,
    name: h.get("x-user-name") ?? "",
    email: h.get("x-user-email") ?? "",
    role: h.get("x-user-role") ?? "",
  };
}

export async function requireAgent(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }
  if (user.role !== AGENT_ROLE && user.role !== ADMIN_ROLE) {
    redirect("/login");
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }
  if (user.role !== ADMIN_ROLE) {
    redirect("/tickets");
  }
  return user;
}

// For use inside API route handlers — reads from the request object directly.
export function getSessionUserFromRequest(
  request: Request
): SessionUser | null {
  const id = request.headers.get("x-user-id");
  if (!id) {
    return null;
  }
  return {
    id,
    name: request.headers.get("x-user-name") ?? "",
    email: request.headers.get("x-user-email") ?? "",
    role: request.headers.get("x-user-role") ?? "",
  };
}

export function requireAdminFromRequest(request: Request): SessionUser {
  const user = getSessionUserFromRequest(request);
  if (!user || user.role !== ADMIN_ROLE) {
    throw new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  return user;
}

export function requireAgentFromRequest(request: Request): SessionUser {
  const user = getSessionUserFromRequest(request);
  if (!user || (user.role !== AGENT_ROLE && user.role !== ADMIN_ROLE)) {
    throw new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  return user;
}
