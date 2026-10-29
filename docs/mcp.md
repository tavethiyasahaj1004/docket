# AI Assistant Access (MCP)

Docket can expose a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/api/mcp`, so an AI assistant such as Claude Code can look up tickets, threads, customers, canned responses and statistics on behalf of an agent or admin. The assistant acts **as the person who created the token**: it sees what that person can see and nothing more. Tokens are read-only unless more scopes are selected. With `tickets:write` the assistant can also save reply drafts, add internal notes and change tags, priority and category, and nothing it does is visible to a customer (§ 4, "Write tools"). With `tickets:manage` it can assign, change status and reopen tickets, and **ask** to close one; with `tickets:reply` (and an admin setting) it can **ask** to send a reply. A close or a reply is only ever a request that the token owner approves in Docket (§ 4, "Approval requests").

This page is for admins and agents. For the settings screens see `docs/admin-portal.md` § 6 and `docs/agent-portal.md` § Settings.

---

## 1. Turning it on (admin)

- Open **Admin → AI assistant (MCP)** and switch **MCP access** on. It is **off by default**.
- While it is off, `/api/mcp` answers `404` to everyone and no one can create a token.
- In production the switch only turns on when `NEXT_PUBLIC_APP_URL` uses `https://`, because tokens travel in a request header.
- The same page lists every token from every user and lets an admin revoke any of them.
- A second switch, **Allow customer replies via MCP**, is **off by default**. While it is off the `reply_to_customer` tool does not exist for anyone, whatever scopes a token has. Turning it on does not let an assistant send anything by itself: each reply is still a request that its token owner approves in Docket. Turning it **off** cancels every reply request that is still waiting. Close requests are not affected.

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
| `tickets:write` | Save reply drafts, add internal notes, change tags, priority and category. **Nothing a customer sees**: no replies, no closing, no assignment | agent, admin |
| `tickets:manage` | Assign tickets, change their status, reopen them, and **request** a close. A close needs the owner's approval in Docket | agent, admin |
| `tickets:reply` | **Request** a reply to a customer. Needs the owner's approval in Docket **and** the admin setting that allows customer replies (§ 1) | agent, admin |
| `reports:read` | Read admin reports (`get_report`) | **admin only**, checked again on every call |
| `tickets:read_internal` | Read internal notes (together with `includeInternal: true` on the call) | agent, admin. **It exists but cannot currently be issued**, so no token can see internal notes |

New tokens default to `tickets:read` and `customers:read`. **`tickets:write`, `tickets:manage` and `tickets:reply` are never pre-selected and never a default**: tick them explicitly when you create a token that should be able to change things. A token created without a scope list gets only the two read scopes. A scope never raises a role: if an admin is demoted to agent, their token immediately loses `reports:read`.

## 3. Connecting Claude Code

Create a token, then run the command shown after creation. It is one line with the token already in it, and runs the same in bash, zsh, PowerShell and cmd:

```bash
claude mcp add --transport http docket https://your-docket.example.com/api/mcp --header "Authorization: Bearer <your token>"
```

Claude Code saves the token in its own configuration. Revoking the token in Docket is what stops it working. Removing the server with `claude mcp remove docket` only clears it from Claude Code.

Replace the URL with your own Docket address followed by `/api/mcp` (the admin MCP page shows it). Inside Claude Code, `/mcp` lists the server and its tools; Claude Code names them `mcp__docket__<tool>`.

---

## 4. Tools

Every tool returns structured JSON plus the same JSON as text. The nine read tools and `get_report` are read-only and safe to repeat; the four write tools are described under "Write tools" below, and the six ticket-management and approval tools under "Ticket management and approval tools". A tool only appears in the list if the token's scopes and the owner's current role allow it: a default agent token sees nine tools, adding `tickets:write` adds four more, and an admin token with `tickets:read`, `customers:read` and `reports:read` sees ten (fourteen with `tickets:write`). `tickets:manage` adds `assign_ticket`, `set_ticket_status`, `close_ticket`, `reopen_ticket` and `get_action_status`; `tickets:reply` adds `get_action_status` and, only while an admin allows customer replies, `reply_to_customer`. Tools are listed in a fixed order.

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
| `save_reply_draft` | `tickets:write` | Puts a proposed reply in your own composer for you to review and send |
| `add_internal_note` | `tickets:write` | Adds an internal note to a ticket |
| `update_ticket_tags` | `tickets:write` | Adds and removes tags on a ticket |
| `update_ticket_fields` | `tickets:write` | Changes a ticket's priority and/or category |
| `assign_ticket` | `tickets:manage` | Assigns a ticket to you, to another agent, or to nobody |
| `set_ticket_status` | `tickets:manage` | Moves an open ticket to another open status |
| `close_ticket` | `tickets:manage` | **Requests** a close; the owner approves it in Docket |
| `reopen_ticket` | `tickets:manage` | Reopens a closed ticket (no email to the customer) |
| `reply_to_customer` | `tickets:reply`, and the admin setting | **Requests** a reply to the customer; the owner approves it in Docket |
| `get_action_status` | `tickets:manage` or `tickets:reply` | Where one of your close or reply requests stands |

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

### Write tools (Release 2)

Four tools need the `tickets:write` scope. They do what the same action does in the Docket UI, **as the person who owns the token**, and nothing they do is visible to a customer: no email is sent, and these four tools cannot reply, close or assign (the tools in the next section can, under the rules given there).

| Tool | Does | `clientRequestId` |
|---|---|---|
| `save_reply_draft` | Saves a proposed reply or internal note into your own composer. A person reviews and sends it from the UI | optional |
| `add_internal_note` | Adds an internal note (agents only) | **required** |
| `update_ticket_tags` | Adds and removes tags (up to 10 names in each list, 50 characters each, lower-cased) | optional |
| `update_ticket_fields` | Sets `priority` and/or `category` by slug (see `get_ticket_config`) | optional |

**`clientRequestId`.** A string of 16-100 characters from `A-Z a-z 0-9 _ -` that identifies one request.

- **Reuse the same key when retrying the same request** (after a timeout, say). A repeat returns the stored result with `replayed: true` and changes nothing. Use a **new** key for a new request: two notes with two different keys are two notes.
- The same key with different arguments is `idempotency_key_reused`. The same key while the first call is still running is `in_progress` (with `retryAfterSeconds`); try again shortly.
- A call that failed for a lasting reason (for example `ticket_closed`) returns the same error when repeated with its key. One that failed with `internal` can be retried with the same key.
- If a call was interrupted part-way, a retry with the same key finishes it without creating a duplicate; the result then carries `sideEffectsUncertain: true`.
- Results are rebuilt from a small stored record of ids, so a replay shows the ticket's current state, not a copy of the original text.

**`save_reply_draft`.** `{ ticket, body (1-20,000 characters), format: "text" | "html", visibility: "public" | "internal" }`. The draft lands in the composer on that ticket for the token's owner; nothing is sent.

- It **never overwrites** a draft you already have. An identical draft (same text and visibility) succeeds with `unchanged: true`. A different one returns `draft_exists`, with `currentUpdatedAt` in `details`, and your own draft is left exactly as it was.
- A body with no visible text (blank, or HTML such as `<p></p>`) is `invalid_input` and **never deletes** your existing draft.
- Drafts on a closed ticket are allowed. A merged ticket returns `merged`.
- Output: `{ ticket: { number, agentUrl }, draft: { visibility, updatedAt }, unchanged }`.

**`add_internal_note`.** `{ ticket, body, format, clientRequestId }`. Writes the same internal note the UI writes: no customer email, no webhook, no change to the ticket's awaiting-reply flags or SLA clock.

- It **does not delete your reply draft** (sending from the composer does; a note an assistant writes is not the reply you are drafting).
- A merged ticket forwards to the ticket it was merged into (`mergedFrom` says so). A closed ticket returns `ticket_closed`.
- Output: `{ commentId, ticket, visibility: "internal", createdAt }`. It never returns other notes. Reading internal notes still needs `tickets:read_internal` (§ 5), which cannot be issued.

**`update_ticket_tags`.** `{ ticket, add?, remove? }`, at least one non-empty list. Names are trimmed, lower-cased and de-duplicated; an empty name, one over 50 characters, or a name in both lists is `invalid_input`. Adding a tag already on the ticket, or removing one that is not, is a no-op, so repeating a call is safe. Merged tickets forward. Output: `{ ticket, tags, added, removed }`, where `tags` is the ticket's tags afterwards and `added` / `removed` are what this call actually changed.

**`update_ticket_fields`.** `{ ticket, priority?, category?, expectedUpdatedAt? }`, at least one of `priority` and `category`. An unknown slug is `invalid_input` with `details.field` and the allowed slugs, and nothing is written. A value the ticket already has is a no-op. Changes fire the same outbound webhooks as the UI; if a webhook could not be queued the result carries `notificationErrors: ["webhook_dispatch_failed"]` but the change stands. Merged tickets return `merged` (no forwarding). Output: `{ ticket: { id, number, agentUrl, priority, category, updatedAt }, changed }`.

- **`expectedUpdatedAt`** (ISO 8601, optional) protects against overwriting a change made in the meantime. Pass the ticket's `updatedAt` as you read it (`get_ticket`). If the ticket changed since, nothing is written and the call returns `conflict` with `details.currentUpdatedAt`. Comparison is to the millisecond.
- **Two fields, one concurrent change.** Category is applied first, then priority. If someone else changes the ticket between the two, the second returns `conflict` with `details.field` naming the field that was **not** applied, and the message says which one **was** applied (the first change stands and is written to the history and audit log). Re-read the ticket and send the remaining field again.
- Without `expectedUpdatedAt`, the fields are applied one after the other, exactly like the UI.

**Merged and closed tickets**

| Tool | Merged ticket | Closed ticket |
|---|---|---|
| `save_reply_draft` | `merged`, naming the ticket to use (`details.mergedIntoTicketNumber`) | allowed |
| `add_internal_note` | forwards to the target, `mergedFrom` reported | `ticket_closed` |
| `update_ticket_tags` | forwards, `mergedFrom` reported | allowed |
| `update_ticket_fields` | `merged`, naming the ticket to use | allowed |

**Who did it.** Every change appears in the ticket's history under the token owner's name, exactly as if they had made it, with `via: "mcp"` and the token id in the entry's metadata (the action names are the usual ones: `internal_note_added`, `tag_added`, `tag_removed`, `priority_changed`, `category_changed`). Every call that changes something also writes one entry to **Admin → Audit log** (`mcp.save_reply_draft`, `mcp.add_internal_note`, `mcp.update_ticket_tags`, `mcp.update_ticket_fields`). A call that changes nothing (an unchanged draft, tags already in place, values already set, or a replay) writes neither.

### Ticket management and approval tools

Six tools need `tickets:manage` or `tickets:reply`. Like the write tools they act **as the token owner**, accept an `expectedUpdatedAt` guard (a mismatch writes or requests nothing and returns `conflict` with `details.currentUpdatedAt`), and answer `merged` (naming `details.mergedIntoTicketNumber`) for a merged ticket, except `reply_to_customer`, which forwards to the surviving ticket and reports `mergedFrom`. Ask the user before assigning, reopening or closing a ticket: `assign_ticket`, `close_ticket` and `reply_to_customer` carry the client hint `_meta["anthropic/requiresUserInteraction"]`, which a client may use to confirm with the user (it is a hint, not a control).

| Tool | Input | `clientRequestId` |
|---|---|---|
| `assign_ticket` | `ticket`, `assignee` (`"me"`, `"unassigned"` or an agent/admin id from `list_agents`), `expectedUpdatedAt?` | optional |
| `set_ticket_status` | `ticket`, `status` (an **open** status slug), `expectedUpdatedAt?` | optional |
| `reopen_ticket` | `ticket`, `expectedUpdatedAt?` | optional |
| `close_ticket` | `ticket`, `expectedUpdatedAt?` | **required** |
| `reply_to_customer` | `ticket`, `body` (1-20,000 characters), `format` (`"text"` or `"html"`), `expectedUpdatedAt?` | **required** |
| `get_action_status` | `requestId` | none (read-only) |

**`assign_ticket`.** The assignee must be an active agent or admin (not banned); anything else is `invalid_input` with `details.field: "assignee"` and nothing is written. Assigning to the current assignee changes nothing (`changed: false`). It writes the same history entry and `ticket.assigned` / `ticket.unassigned` webhook as the UI. The new assignee is **not** notified. Output: `{ ticket, assignee, previousAssignee, changed }` (each assignee is `{ id, name }` or `null`).

**`set_ticket_status`.** Moves a ticket between open statuses, with the same history entry and `ticket.status_changed` webhook as the UI and no customer email. A closed target status is a `conflict` (closing goes through `close_ticket`), and so is a ticket that is already closed (reopening goes through `reopen_ticket`). An unknown slug is `invalid_input` listing the allowed ones; the status the ticket already has changes nothing. Output: `{ ticket, status, previousStatus, changed }`.

**`reopen_ticket`.** Does what an agent reopening a ticket does in the UI: the ticket returns to the default status, the SLA clock restarts, the history gets a `ticket_reopened` entry and `ticket.reopened` fires. **No email is sent.** A ticket that is not closed changes nothing (`alreadyOpen: true`). Output: `{ ticket, status, alreadyOpen }`.

`set_ticket_status` and `reopen_ticket` take a per-ticket lock: while one is running on a ticket, another returns `in_progress` with `retryAfterSeconds`. `assign_ticket` takes no lock.

**`close_ticket`.** Only **requests** a close; it never closes the ticket. It creates an approval request (see "Approval requests" below) that the token owner approves or dismisses on the ticket page; approving runs the normal close, which emails the customer. Output: `{ status: "awaiting_approval", requestId, expiresAt, ticket, approvalNote }`. While a close request for the ticket is still pending, another call (with a new key) returns that same request with `existingRequest: true`. A ticket that is already closed creates no request (`status: "already_closed"`). Reuse the same `clientRequestId` when retrying: a repeat returns the same request.

**`reply_to_customer`.** Only **requests** a reply; it never sends one. Show the user the exact text and get their approval before calling it, and prefer `save_reply_draft`, which a person reviews and sends. Available only while an admin allows customer replies (§ 1); when it is off the tool is not listed and calling it is an unknown tool. The request holds the reply text for the owner to read and approve; the result never echoes the text and never contains a customer link. The owner's own reply draft is never touched. Output: `{ status: "awaiting_approval", requestId, expiresAt, ticket, mergedFrom?, approvalNote }`.

- One reply request per ticket can be pending: a call while one is pending returns it with `existingRequest: true` and the note says the new text did **not** replace the earlier one.
- A closed ticket is `ticket_closed`. A body with no visible text is `invalid_input`.
- The same text sent again under a new key within 10 minutes is `duplicate_suspected` (`details.requestId` names the earlier request). Reusing the same key is a replay, not a duplicate.
- Each user is limited to 10 reply calls a minute and 100 a day (`rate_limited`, with `details.retryAfterSeconds`).

**`get_action_status`.** `{ requestId }`. Reports `pending`, `approved`, `dismissed`, `expired`, `cancelled` or `failed` for one of **your own** requests (a request someone else made, or an unknown id, is the same `not_found`). A pending request past its 24 hours reads as `expired`. For an approved request `outcome` is `closed`, `already_closed` or `replied` (with `commentId`); `reason` explains a cancellation or failure (for example `token_revoked`, `ticket_merged`, `replies_disabled`); `sideEffectsUncertain: true` means a restart interrupted the action and Docket could not tell whether every notification went out. It never returns the reply text.

**Who did it.** As for the write tools, history entries carry `via: "mcp"` and the token id, and every call that changes something writes one **Admin → Audit log** entry (`mcp.assign_ticket`, `mcp.set_ticket_status`, `mcp.reopen_ticket`). Creating a close or reply request writes `mcp.action_requested` instead; turning the admin setting on or off writes `mcp.customer_replies_changed`.

### Approval requests (closing and replying)

Closing a ticket and replying to a customer both reach the customer (a close email, a reply email, outbound webhooks), so an assistant is never allowed to do either by itself. It can only **ask**; the person who owns the token decides, in Docket. This is how it works from your side.

- **The request.** When your assistant asks to close a ticket or send a reply, Docket records a pending request. Nothing is closed, sent or emailed, and your own reply draft is not touched. You get an in-app notification (`mcp_action_pending`) and an OS push if push is set up, both linking to the ticket.
- **The banner.** Open the ticket: a banner above the conversation says "Your AI assistant asks to close this ticket" or "…to send this reply" (a reply is shown in full, read-only), with **Approve** and **Dismiss**. Approving a reply first asks you to confirm, because it emails the customer.
- **Approving** does exactly what the same action does in the UI, **as you**: the close or reply is attributed to you in the ticket history (with `via: "mcp"`, the request id and the token id in the entry's metadata), the customer gets the usual email, and the usual webhooks fire. A reply is refused if the ticket has since been closed or merged. A close on a ticket that is already closed does nothing and sends nothing.
- **Dismissing** discards the request and changes nothing.
- **Only you can decide.** No other agent and no admin (not even one impersonating you) can approve or dismiss your assistant's request, and they cannot see it on the ticket; they get the same "not found" as for an unknown request. Admins see a read-only list of what is waiting, without reply text, under **Admin → AI assistant (MCP)**.
- **One at a time.** There is one pending close and one pending reply per ticket per person; asking again while one is pending returns the existing request.
- **Expiry.** A request expires 24 hours after it was made and can no longer be approved. A request does not depend on the token still being valid, but it does depend on it not being revoked.
- **Cancellation.** A pending request is cancelled automatically when its token is revoked, when its owner is deactivated or stops being an agent or admin, when the owner signs out their other sessions, when its ticket is merged into another (requests on the surviving ticket stay), and, for a reply, when an admin turns off customer replies. A reply request also cannot be approved or dismissed while that setting is off. Cancellations made through Docket are written to **Admin → Audit log** as `mcp.action_cancelled`; so are `mcp.action_requested`, `mcp.action_approved` and `mcp.action_dismissed`. None of these entries contains the reply text.
- **If something goes wrong** while a request is being carried out (for example the server restarts), Docket checks what actually happened and records it; it never carries the action out a second time.

The tools that create these requests are `close_ticket` (`tickets:manage`) and `reply_to_customer` (`tickets:reply`, plus the admin setting); `get_action_status` lets the assistant see how a request ended. A token can create a request, never decide one: there is no tool that approves or dismisses.

### Result size

Results are kept small. Above about 30,000 characters, list, thread and report tools drop trailing items and set `truncatedForSize: true` together with `hasMore`, `nextCursor` or `omittedRows`; other tools shorten bodies. No result exceeds 40,000 characters. If you see `truncatedForSize`, ask for a smaller `pageSize`, `limit` or `maxBodyChars`.

### Errors

A failed call returns a tool error (`isError: true`) whose `structuredContent` is `{ "error": { "code", "message", "details"? } }`. The **text block is exactly that same JSON** (`JSON.stringify(structuredContent)`), for errors as for successes, because Claude Code (observed with version 2.1.148) passes only the text block to the model. For example:

```json
{"error":{"code":"not_found","message":"No such ticket."}}
```

- **Codes you will see:** `invalid_input` (a bad value, an unknown slug or assignee, a bad cursor, `includeInternal` without the scope, "exactly one of" broken, an empty note or draft), `not_found` and `internal`; and from the write tools `merged`, `ticket_closed`, `conflict`, `draft_exists`, `in_progress` and `idempotency_key_reused` (see "Write tools"), plus `duplicate_suspected`, `rate_limited` and `disabled` from `reply_to_customer`.
- **`details`** is optional and limited to a fixed allowlist of small, non-sensitive keys: `mergedIntoTicketNumber`, `retryAfterSeconds`, `commentId`, `requestId`, `currentStatus`, `currentUpdatedAt`, `ticketNumber`, `field` and `allowed` (a list of slugs). Values must be numbers, booleans, `null`, or strings of at most 200 characters (lists of at most 50 strings or numbers). Anything else is dropped before the result is sent: unknown keys, nested objects, email addresses, and text containing a token, storage path or other forbidden pattern. Only the dropped key's name is logged, never its value. `details` is left out when nothing survives.
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

**What Docket keeps about calls:** one trace row per call (the tool, the user, the token, the outcome, the duration, and the ticket or customer it resolved to), pruned after 30 days. It holds no message text, no tool arguments (only a keyed hash of them) and no results. For a write call the row is also its idempotency record: it additionally holds the `clientRequestId` you chose and a small result made only of ids, numbers, slugs and timestamps, never a note, draft or tag name. The notes, drafts and tags themselves are ordinary Docket data, kept like the ones you write in the UI. A reply request keeps its text in the request itself, shown only to the token owner; the call record holds only a keyed hash of it, and the text is not copied into notifications, push messages or audit entries. Server logs hold one line per call with the same kind of facts.

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
| A tool is missing | The token lacks the scope (`customers:read` for `get_customer`, `tickets:write` for the four write tools, `tickets:manage` / `tickets:reply` for the management and approval tools), an admin has not allowed customer replies (`reply_to_customer`), the owner's role no longer allows it (`get_report` is admin-only), or the tool does not exist in this version. Run `whoami` to see the tools available |
| The write tools are not offered | `tickets:write` is never pre-selected. Create a new token and tick it (a token's scopes cannot be changed afterwards) |
| `draft_exists` | You already have a different draft on that ticket. Send or discard it in Docket, or ask for a draft on another ticket |
| `conflict` on `update_ticket_fields` | The ticket changed since `expectedUpdatedAt`. Read it again and retry; with two fields, check `details.field` |
| `in_progress` | The same `clientRequestId` is still running. Retry after `retryAfterSeconds` with the **same** key |
| `invalid_input` on `includeInternal` | The token has no `tickets:read_internal` scope (see § 5) |
| Claude Code saved a result to a file | The result was very large. Lower `pageSize`, `limit` or `maxBodyChars` |
| claude.ai says it couldn't reach the server | claude.ai, Claude Desktop and mobile need an OAuth sign-in, which Docket does not offer yet (see § 8). Use Claude Code with a token |

**Why Claude Code says "failed" instead of "token expired".** After *any* `401`, Claude Code 2.1.148 assumes the server wants OAuth and probes five discovery paths: `/.well-known/oauth-protected-resource/api/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` and finally `POST /register`. Docket has no `/register` route, so Next.js answers with an HTML 404; Claude Code then reports the server as `failed` with an OAuth parse error (`Invalid OAuth error response: SyntaxError: JSON Parse error`), and the server's reason ("token expired" / "token revoked") never reaches you. When you see this, open **Settings → AI assistant access** in Docket and check whether the token is `expired` or `revoked`, then create a new one. If MCP access was switched off, the server answers `404` instead and no OAuth probing happens.

---

## 8. Known limitations

- **Limited writes.** With `tickets:write` the assistant can save drafts, add internal notes and change tags, priority and category; with `tickets:manage` it can assign, change status and reopen. It can only **ask** to close a ticket or send a reply, and a person approves in Docket. There are no tools to edit anything else (customers, custom fields, attachments, merges).
- **Requests wait for you.** A close or reply request expires after 24 hours, and an assistant has to check `get_action_status` to learn the outcome.
- **Drafts are never overwritten**, and an assistant cannot clear one. It can only add a draft where you have none.
- **Search is narrow.** `query` matches ticket subject, customer name or email, and ticket number only; it does not search descriptions or messages, and `%` / `_` are wildcards.
- **Personal access tokens only.** There is no OAuth sign-in, so claude.ai, Claude Desktop and mobile connectors cannot connect yet. Use a client that can send an `Authorization` header, such as Claude Code.
- **Internal notes are not reachable** (see § 5).
- **Results are trimmed**, never larger than 40,000 characters, and message bodies are plain text (no formatting).
- **A token cannot be extended.** Create a new one before it expires.
