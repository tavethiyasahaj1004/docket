import { createId } from "@paralleldrive/cuid2";
import {
  // slaPolicies,
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
} from "@/db/schema";
import { db } from "@/lib/db";

// SLA is currently hidden from the UI (see docs/tickets.md § SLA) — the
// default policy seed below is disabled to match, so a fresh install doesn't
// get an orphaned sla_policies row.
// Fixed id so onConflictDoNothing() sees the same seed row across runs. The
// seeds below dedup on their unique `slug` instead; sla_policies has none, so
// the row's own id is the natural key here.
// const DEFAULT_SLA_POLICY_ID = "seed-default-sla-policy";

/** Seeds the default ticket statuses, categories and priorities every install
 * needs. Idempotent — `onConflictDoNothing()` skips existing slugs — so
 * `pnpm db:seed`, `pnpm setup` and the `/setup` wizard can all run it. */
export async function seedDefaults() {
  const statuses = [
    {
      id: createId(),
      slug: "open",
      label: "Open",
      color: "blue",
      sortOrder: 0,
      isDefault: true,
      isClosedState: false,
    },
    {
      id: createId(),
      slug: "in_progress",
      label: "In Progress",
      color: "amber",
      sortOrder: 1,
      isDefault: false,
      isClosedState: false,
    },
    {
      id: createId(),
      slug: "closed",
      label: "Closed",
      color: "slate",
      sortOrder: 2,
      isDefault: false,
      isClosedState: true,
    },
  ];

  const categories = [
    { id: createId(), slug: "bug", label: "Bug", color: "red", sortOrder: 0 },
    {
      id: createId(),
      slug: "issue",
      label: "Issue",
      color: "orange",
      sortOrder: 1,
    },
    {
      id: createId(),
      slug: "feature_request",
      label: "Feature Request",
      color: "purple",
      sortOrder: 2,
    },
    {
      id: createId(),
      slug: "billing",
      label: "Billing",
      color: "green",
      sortOrder: 3,
    },
    {
      id: createId(),
      slug: "general_query",
      label: "General Query",
      color: "slate",
      sortOrder: 4,
    },
  ];

  const priorities = [
    {
      id: createId(),
      slug: "low",
      label: "Low",
      color: "slate",
      sortOrder: 0,
      isDefault: false,
    },
    {
      id: createId(),
      slug: "normal",
      label: "Normal",
      color: "blue",
      sortOrder: 1,
      isDefault: true,
    },
    {
      id: createId(),
      slug: "high",
      label: "High",
      color: "amber",
      sortOrder: 2,
      isDefault: false,
    },
    {
      id: createId(),
      slug: "urgent",
      label: "Urgent",
      color: "red",
      sortOrder: 3,
      isDefault: false,
    },
  ];

  // One unscoped (Any priority / Any category) fallback policy, so a fresh
  // install has working SLA display immediately. Admins can add scoped
  // overrides and adjust these targets at /admin/ticket-config.
  // const slaPolicy = {
  //   id: DEFAULT_SLA_POLICY_ID,
  //   name: "Default SLA",
  //   priority: null,
  //   category: null,
  //   firstResponseMinutes: 60,
  //   nextResponseMinutes: 240,
  //   resolutionMinutes: 1440,
  //   isDefault: true,
  //   sortOrder: 0,
  // };

  await db.insert(ticketStatuses).values(statuses).onConflictDoNothing();
  await db.insert(ticketCategories).values(categories).onConflictDoNothing();
  await db.insert(ticketPriorities).values(priorities).onConflictDoNothing();
  // await db.insert(slaPolicies).values(slaPolicy).onConflictDoNothing();

  return {
    statuses: statuses.length,
    categories: categories.length,
    priorities: priorities.length,
    // slaPolicies: 1,
  };
}
