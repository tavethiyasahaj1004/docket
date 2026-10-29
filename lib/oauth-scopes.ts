// Client-safe constants for the OAuth consent and login screens: no server
// imports, so "use client" components can use them.

/** Granted so a client can keep a refresh token. Not a Docket permission. */
export const OAUTH_OFFLINE_SCOPE = "offline_access";

/** Scopes that can be shown and chosen on the consent screen, in display order.
 * Keep in step with OAUTH_MCP_SCOPES in lib/oauth.ts. */
export const OAUTH_CHOOSABLE_SCOPES = [
  "tickets:read",
  "customers:read",
  "tickets:write",
  "reports:read",
] as const;
export type OAuthChoosableScope = (typeof OAUTH_CHOOSABLE_SCOPES)[number];

/** Checked by default on the consent screen. tickets:write and reports:read are
 * always an explicit choice. */
export const OAUTH_DEFAULT_CHECKED: readonly OAuthChoosableScope[] = [
  "tickets:read",
  "customers:read",
];

export const OAUTH_SCOPE_LABELS: Record<
  OAuthChoosableScope,
  { label: string; description: string }
> = {
  "tickets:read": {
    label: "Read tickets",
    description: "See ticket subjects, messages, status and assignments.",
  },
  "customers:read": {
    label: "Read customers",
    description: "See customer names, emails and their ticket history.",
  },
  "tickets:write": {
    label: "Make changes to tickets",
    description:
      "Save drafts, add internal notes, tags, priority and category. Nothing a customer sees.",
  },
  "reports:read": {
    label: "Read reports",
    description: "See aggregate reports and statistics (admins only).",
  },
};

/** The provider appends a signature and the client id when it sends a browser to
 * the login or consent page; their presence marks an OAuth continuation. */
export function isOAuthContinuationQuery(
  search: string | URLSearchParams
): boolean {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  return params.has("sig") && params.has("client_id");
}

/** Where to send the browser after a magic-link sign-in so the interrupted
 * authorization resumes. Magic links cannot carry the signed query (the click
 * is a different request), so the callback is the authorize URL itself with the
 * original parameters, minus the signature and the provider's bookkeeping and
 * minus a forced `login` prompt (the sign-in just happened). */
export function oauthResumeAuthorizeUrl(
  search: string | URLSearchParams
): string {
  const source =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const params = new URLSearchParams();
  for (const [key, value] of source.entries()) {
    if (key === "sig" || key === "exp" || key.startsWith("ba_")) {
      continue;
    }
    if (key === "prompt") {
      const kept = value
        .split(" ")
        .filter((p) => p && p !== "login" && p !== "create");
      if (kept.length > 0) {
        params.append(key, kept.join(" "));
      }
      continue;
    }
    params.append(key, value);
  }
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}
