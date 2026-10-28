import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Destroys the caller's session cookies and drops them at /login. Exists because
// Server Components can't set cookies, so a page finding a broken session can
// only `redirect()` and leave the bad cookies behind. Unauthenticated and GET-able
// on purpose — it runs when there's no usable session left to authenticate with.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // signOut never throws on an unknown/invalid session — it best-effort deletes
  // the row and always emits the cookie-clearing Set-Cookie headers.
  const signOutResponse = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });

  const response = NextResponse.redirect(
    new URL("/login", request.nextUrl.origin)
  );
  for (const cookie of signOutResponse.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
