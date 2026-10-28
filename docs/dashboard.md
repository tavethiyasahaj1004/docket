# Dashboard

## Overview

The dashboard gives agents and admins a quick snapshot of the support queue's health. It lives at `/dashboard` and is the landing page after sign-in.

Customers do not have access to the dashboard.

For cross-agent comparisons (tickets/response-time per agent, category/priority/tag breakdowns, CSV export), see the admin-only **Reports** page at `/admin/reports` (`docs/admin-portal.md` § 4) — deliberately kept separate from this shared dashboard rather than added here, since it's the only place in the app that compares individual agents against each other.

---

## Stats Cards

Four primary stat cards at the top:

### 1. Total Tickets
- Count of all tickets ever created (all statuses).
- Subtitle: "All time"

### 2. Open Tickets
- Count of tickets with `status = 'open'`.
- Subtitle: shows the **average waiting time** — the average time since `createdAt` for all currently open tickets.
- Format: "Avg. wait: 2h 14m" or "Avg. wait: 3 days".
- If no open tickets: subtitle shows "No open tickets".

### 3. In Progress Tickets
- Count of tickets with `status = 'in_progress'`.
- Subtitle: "Currently being worked on"

### 4. Closed Tickets
- Count of tickets with `status = 'closed'`.
- Subtitle: "All time"

---

## Ticket Volume Chart

A bar chart showing ticket volume over time.

- X-axis: dates
- Y-axis: number of tickets created
- Toggle: **Last 7 days** / **Last 30 days**
- Default: Last 7 days

Chart is rendered with a simple charting library (e.g. recharts or a minimal SVG chart) via `components/ui/chart.tsx`. Keep it lightweight — no heavy charting dependencies.

---

## Recent Open Tickets

A table of the 10 most recently updated open tickets, for quick access:

| Column | Description |
|--------|-------------|
| # | Ticket number |
| Subject | Truncated to ~60 chars |
| Category | Badge |
| Assigned To | Agent name or "Unassigned" |
| Waiting | Time since `createdAt` (e.g. "2h", "3 days") |

Each row is clickable → `/tickets/{ticketNumber}`.

---

## My Open Tickets (Agents)

Below the main stats, agents see a section: **"My Tickets"** — open and in-progress tickets assigned to them specifically.

- Same table format as Recent Open Tickets.
- Filtered to `assignedAgentId = session.user.id`.
- Shows "No tickets assigned to you" empty state if none.
- Admins see this section too.

---

## UI Notes

- Stats cards use the standard card component (`rounded-xl`, `p-6`).
- Each stat card has: a large number, a label, and a subtitle/trend.
- Use Phosphor icons on each card: `TicketIcon`, `HourglassIcon`, `SpinnerIcon`, `CheckCircleIcon`.
- The volume chart section has a tab toggle for 7d / 30d — implemented with Headless UI's `Tabs`.
- Dashboard is responsive — cards stack to 2-column on tablet, 1-column on mobile.

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats/overview` | Returns total, open, in_progress, closed counts + avg wait time |
| `GET /api/stats/volume?days=7` | Returns daily ticket counts for the last N days |
| `GET /api/tickets?status=open&limit=10&sort=updatedAt` | Used for recent tickets table |
| `GET /api/tickets?assignedTo=me&status=open,in_progress` | Used for "My Tickets" section |

---

## Business Rules

1. All stats include tickets across all customers — no customer isolation at the dashboard level.
2. Average wait time is calculated server-side: `AVG(NOW() - createdAt)` for all open tickets.
3. The "My Tickets" section is the same for agents and admins.
4. Dashboard data is not cached — fetched fresh on each page load (SWR with default revalidation).
