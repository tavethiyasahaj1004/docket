# AI Assistant Access (MCP)

Docket can expose a read-only [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/api/mcp`, so an AI assistant such as Claude Code can look up tickets, threads, customers, canned responses and statistics on behalf of an agent or admin. The assistant acts **as the person who created the token**: it sees what that person can see and nothing more, and it cannot change anything.

This page is for admins and agents. For the settings screens see `docs/admin-portal.md` § 6 and `docs/agent-portal.md` § Settings.

---

## 1. Turning it on (admin)

- Open **Admin → AI assistant (MCP)** and switch **MCP access** on. It is **off by default**.
- While it is off, `/api/mcp` answers `404` to everyone and no one can create a token.
- In production the switch only turns on when `NEXT_PUBLIC_APP_URL` uses `https://`, because tokens travel in a request header.
- The same page lists every token from every user and lets an admin revoke any of them.

## 2. Tokens (agents and admins)

Once MCP is on, any agent or admin can create tokens for themselves under **Settings → AI assistant access**.

- A token has a name, a set of scopes and an expiry (7, 30, 60 or 90 days; default 30; never longer than 90).
- The token value (it starts with `dkm_`) is shown **once**, right after creation, with a ready-to-copy setup command. It is stored only as a hash and cannot be shown again. If you lose it, revoke it and create a new one.
- **Revoke** takes effect immediately and cannot be undone. A token also stops working when it expires.
- Tokens are revoked automatically when the owner is deactivated, signs out their other sessions, or stops being an agent or admin. Resetting a password does **not** revoke tokens, so review the list afterwards.
- Treat a token like a password. Anyone holding it can read what its owner can read until it is revoked or expires.

### Scopes

| Scope | Lets the assistant | Who can hold it |
|---|---|---|
| `tickets:read` | List and read tickets and threads, agents, canned responses, ticket configuration and statistics | agent, admin |
| `customers:read` | Read customer profiles and ticket history (`get_customer`) | agent, admin |
| `reports:read` | Read admin reports (`get_report`) | **admin only**, checked again on every call |
| `tickets:read_internal` | Read internal notes (together with `includeInternal: true` on the call) | agent, admin. **It exists but cannot currently be issued**, so no token can see internal notes |

New tokens default to `tickets:read` and `customers:read`. A scope never raises a role: if an admin is demoted to agent, their token immediately loses `reports:read`.

## 3. Connecting Claude Code

Create a token, then run the command shown after creation. In a shell it looks like this:

```bash
export DOCKET_MCP_TOKEN="<your token>"
claude mcp add --transport http docket https://your-docket.example.com/api/mcp --header "Authorization: Bearer ${DOCKET_MCP_TOKEN}"
```

Replace the URL with your own Docket address followed by `/api/mcp` (the admin MCP page shows it). Inside Claude Code, `/mcp` lists the server and its tools; Claude Code names them `mcp__docket__<tool>`.

---

## 4. Tools

Every tool is read-only, safe to repeat, and returns structured JSON plus the same JSON as text. A tool only appears in the list if the token's scopes and the owner's current role allow it: a default agent token sees nine tools, and an admin token with `tickets:read`, `customers:read` and `reports:read` sees all ten.

| Tool | Scope | What it returns |
|---|---|---|
| `whoami` | any valid token | The user the token acts as, its scopes, expiry and the tools available |
| `get_ticket_config` | `tickets:read` | Valid status, priority and category slugs, custom fields and the shared tag list |
| `list_tickets` | `tickets:read` | Ticket summaries, filtered and paginated like the agent ticket list |
| `get_ticket` | `tickets:read` | One ticket: details, customer, description, custom fields, links, attachment metadata, SLA timestamps, comment counts |
| `get_ticket_thread` | `tickets:read` | A ticket's messages (and optionally activity), paged with a cursor |
| `get_customer` | `customers:read` | A customer's profile and ticket history |
| `list_agents` | `tickets:read` | Active agents and admins |
| `search_canned_responses` | `tickets:read` | Saved reply templates, by title |
| `get_ticket_stats` | `tickets:read` | Ticket totals, average age of open tickets, daily volume |
| `get_report` | `reports:read` and the admin role | One admin report |

### Referring to a ticket

Wherever a tool takes `ticket`, pass the ticket number (`1042`, `"1042"` or `"#1042"`) or the ticket id. A **merged** ticket resolves to the ticket it was merged into, and the result carries `mergedFrom: { requested: "#1040" }`. An unknown ticket is reported as `not_found`.

### `list_tickets`

Filters: `query`, `status` (list of slugs), `view` (`open` or `awaiting`), `priority`, `category`, `assignee` (`me`, `unassigned` or an agent id; an id that names no user is an `invalid_input` error rather than an empty list), `tag`, `awaitingReply`, `createdAfter` / `createdBefore` (`YYYY-MM-DD`), `sort` (`number`, `updated`, `waiting_time`), `order`, `page` (1-1000) and `pageSize` (1-50, default 20). Results are `{ tickets, page, pageSize, total, hasMore }`. Summaries carry the customer's name and id but **no email and no message text**. Status, priority and category values are checked against your live configuration; use `get_ticket_config` for the valid slugs.

`query` matches the ticket subject, the customer's name or email, and an exact `#number`. It does **not** search descriptions or messages. `%` and `_` in the query act as wildcards.

### `get_ticket` and `get_ticket_thread`

- Text comes back as plain text. `maxBodyChars` (200-10,000, default 2,000) cuts long bodies and marks them `truncated`, with `fullLength` giving the real length.
- `get_ticket_thread` returns up to `limit` items (1-100, default 30), oldest first or newest first. Pass the returned `nextCursor` as `cursor` to get the next page; `null` means the end. Paging is by position, so a reply arriving mid-way never causes a repeat or a skip.
- `includeActivity: true` adds activity entries (status changes, assignments, tags, links). Only a fixed set of safe fields is shown for each: the old and new status, priority or category slug, the agent id of an assignment, a tag name, the custom field's label, a deleted attachment's filename (only with the internal opt-in, see § 5), and linked or merged ticket numbers. Contact details, message text and URLs are never included.
- Attachments appear as metadata only: `id`, `filename`, `mimeType`, `fileSize`, `createdAt`. File content and download links are never returned.
- `includeInternal: true` is described in the next section.

### `get_customer`

Give exactly one of `customerId`, `email` or `ticket`. Returns the name, email, open and closed tickets (newest first, at most `ticketLimit` of each, default 10, maximum 50), the real totals `openTotal` and `closedTotal`, and monthly ticket frequency. Looking up by email never creates a customer. The agent-written customer note is returned only with `includeNote: true`.

### `list_agents`, `search_canned_responses`, `get_ticket_stats`

- `list_agents` takes an optional `query` (name or email contains) and returns at most 200 agents (`truncated` says if there were more).
- `search_canned_responses` takes `query` (title), `limit` (1-20, default 10) and `maxBodyChars`.
- `get_ticket_stats` takes `volumeDays` (7-30, default 7) and returns `overview` (`total`, `open`, `inProgress`, `closed`, `avgOpenTicketAgeMs`) and `volume` (tickets created per day). `avgOpenTicketAgeMs` is the average age, in milliseconds, of tickets that are not closed.

### `get_report` (admin)

`kind` is `by_agent`, `by_category`, `by_priority` or `by_tag`; `range` is `30d` (default), `90d` or `all`. `avgResolutionSeconds` in the by-agent report is the **time a ticket spent waiting for an agent**, accumulated, averaged over closed tickets; it is not the time elapsed between creation and closing. Rows come busiest first; if a very large team pushes the by-agent report over the size limit, the least busy rows are dropped and the result says `truncatedForSize: true` with `omittedRows`.

### Result size

Results are kept small. Above about 30,000 characters, list, thread and report tools drop trailing items and set `truncatedForSize: true` together with `hasMore`, `nextCursor` or `omittedRows`; other tools shorten bodies. No result exceeds 40,000 characters. If you see `truncatedForSize`, ask for a smaller `pageSize`, `limit` or `maxBodyChars`.

### Errors

A failed call returns a tool error (`isError: true`) whose `structuredContent` is `{ "error": { "code", "message", "details"? } }`. The **text block is exactly that same JSON** (`JSON.stringify(structuredContent)`), for errors as for successes, because Claude Code (observed with version 2.1.148) passes only the text block to the model. For example:

```json
{"error":{"code":"not_found","message":"No such ticket."}}
```

- **Codes you will see now:** `invalid_input` (a bad value, an unknown slug or assignee, a bad cursor, `includeInternal` without the scope, "exactly one of" broken), `not_found` and `internal`.
- **`details`** is optional and limited to a fixed allowlist of small, non-sensitive keys: `mergedIntoTicketNumber`, `retryAfterSeconds`, `commentId`, `currentStatus`, `currentUpdatedAt`, `ticketNumber`, `field` and `allowed` (a list of slugs). Values must be numbers, booleans, `null`, or strings of at most 200 characters (lists of at most 50 strings or numbers). Anything else is dropped before the result is sent: unknown keys, nested objects, email addresses, and text containing a token, storage path or other forbidden pattern. Only the dropped key's name is logged, never its value. `details` is left out when nothing survives.
- **`internal`** (an unexpected failure) is always `{"error":{"code":"internal","message":"Internal error (ref: <id>)"}}`: a reference id to give to your admin, never the cause and never any details.
- **Schema-validation failures** (an argument of the wrong type or range, an unknown argument, a missing required one) are rejected by the MCP SDK before Docket's handler runs. They are still tool errors (`isError: true`, not a JSON-RPC error), but the text is the SDK's own plain text, for example `Input validation error: Invalid arguments for tool list_tickets: pageSize: Too small: expected number to be >=1`. They carry no `structuredContent`, no Docket error `code`, and leave no trace row. The text names the argument and the rule, never the value you sent.

Each user is also limited to 120 calls per minute; beyond that the endpoint answers HTTP `429`.

---

## 5. Internal notes

Internal notes are **off by default** and need two things together: the `tickets:read_internal` scope on the token **and** `includeInternal: true` on the call.

- With only one of them, or neither, no trace of internal content appears: not the notes themselves (including the system-written notes left by merges and splits), not attachments on internal notes, not the internal comment count, and not `internal_note_added` activity entries.
- The filename in an `attachment_deleted` activity entry is withheld the same way (`metadata: null`). Docket does not record whether a deleted file was on an internal note, so the filename of a deleted **public** attachment is withheld too unless both are present.
- `includeInternal: true` on a token without the scope is an `invalid_input` error, never a quiet downgrade.
- When both are present, internal items are labelled `visibility: "internal"`.
- At present `tickets:read_internal` cannot be issued to a new token, so internal notes are not reachable through MCP.

---

## 6. Data sharing

[PLACEHOLDER — data-sharing notice wording pending approval (G3)]

What a tool returns is sent to the AI provider behind the assistant. The facts:

**What the tools can return**

| Data | Tool | By default |
|---|---|---|
| Ticket subject, status, priority, category, tags, assignee name, timestamps | `list_tickets`, `get_ticket`, `get_ticket_thread` | Yes |
| Customer name and id | `list_tickets`, `get_ticket`, `get_customer` | Yes |
| Customer email | `get_ticket`, `get_customer` only (never in lists) | Yes |
| Ticket description and public message bodies | `get_ticket`, `get_ticket_thread` | Yes, cut to 2,000 characters unless `maxBodyChars` is raised (maximum 10,000) |
| Custom field values, linked ticket numbers and subjects | `get_ticket` | Yes |
| Internal notes and their attachments | `get_ticket`, `get_ticket_thread` | No: scope and per-call flag required (see § 5) |
| Customer note | `get_customer` | No: only with `includeNote: true` |
| Agent and admin names and emails | `list_agents`, `whoami` | Yes |
| Canned response text | `search_canned_responses` | Yes |
| Counts and averages | `get_ticket_stats`, `get_report` | Yes (reports: admin tokens only) |
| Attachments | `get_ticket`, `get_ticket_thread` | Metadata only: filename, type, size, date. Never the file content |

**What is never returned:** customer portal links or access tokens, file storage paths or download links, passwords, sessions, API keys, other users' tokens, or raw editor documents.

**What Docket keeps about calls:** one trace row per call (the tool, the user, the token, the outcome, the duration, and the ticket or customer it resolved to), pruned after 30 days. It holds no message text, no tool arguments (only a keyed hash of them) and no results. Server logs hold one line per call with the same kind of facts.

**Deletion:** deleting a ticket or customer in Docket removes it from future tool results. It cannot reach copies the AI provider has already received, and Docket cannot delete those. The provider's own retention terms apply.

Tell customers and colleagues, as your policies require, that ticket content can be processed by an AI provider when someone connects an assistant.

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `404` on `/api/mcp` | MCP is switched off in **Admin → AI assistant (MCP)**, or in production `NEXT_PUBLIC_APP_URL` is not `https://` |
| `401` with "token expired" or "token revoked" | Create a new token. **Claude Code may not show this reason**: see the note below. Check the token's status in Docket under Settings → AI assistant access |
| `403` | The request's `Origin` was rejected |
| `429` | More than 120 calls in a minute for this user, or too many failed sign-in attempts. Retry after the `Retry-After` header |
| A tool is missing | The token lacks the scope (`customers:read` for `get_customer`), the owner's role no longer allows it (`get_report` is admin-only), or the tool does not exist in this version. Run `whoami` to see the tools available |
| `invalid_input` on `includeInternal` | The token has no `tickets:read_internal` scope (see § 5) |
| Claude Code saved a result to a file | The result was very large. Lower `pageSize`, `limit` or `maxBodyChars` |
| claude.ai says it couldn't reach the server | claude.ai, Claude Desktop and mobile need an OAuth sign-in, which Docket does not offer yet (see § 8). Use Claude Code with a token |

**Why Claude Code says "failed" instead of "token expired".** After *any* `401`, Claude Code 2.1.148 assumes the server wants OAuth and probes five discovery paths: `/.well-known/oauth-protected-resource/api/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` and finally `POST /register`. Docket has no `/register` route, so Next.js answers with an HTML 404; Claude Code then reports the server as `failed` with an OAuth parse error (`Invalid OAuth error response: SyntaxError: JSON Parse error`), and the server's reason ("token expired" / "token revoked") never reaches you. When you see this, open **Settings → AI assistant access** in Docket and check whether the token is `expired` or `revoked`, then create a new one. If MCP access was switched off, the server answers `404` instead and no OAuth probing happens.

---

## 8. Known limitations

- **Read-only.** There are no tools to reply, close, assign, tag or edit anything. The assistant cannot change Docket.
- **Search is narrow.** `query` matches ticket subject, customer name or email, and ticket number only; it does not search descriptions or messages, and `%` / `_` are wildcards.
- **Personal access tokens only.** There is no OAuth sign-in, so claude.ai, Claude Desktop and mobile connectors cannot connect yet. Use a client that can send an `Authorization` header, such as Claude Code.
- **Internal notes are not reachable** (see § 5).
- **Results are trimmed**, never larger than 40,000 characters, and message bodies are plain text (no formatting).
- **A token cannot be extended.** Create a new one before it expires.
