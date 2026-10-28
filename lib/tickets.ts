// Color preset → Tailwind badge classes
export const COLOR_BADGE: Record<string, string> = {
  blue: "bg-sky-100 text-sky-700 border-sky-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  slate: "bg-stone-100 text-stone-600 border-stone-200",
  red: "bg-red-50 text-red-700 border-red-200",
  orange: "bg-orange-50 text-orange-700 border-orange-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  teal: "bg-teal-50 text-teal-700 border-teal-200",
  pink: "bg-pink-50 text-pink-700 border-pink-200",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

export const COLOR_OPTIONS = Object.keys(COLOR_BADGE);

// ⚠ CLIENT COMPONENTS ONLY. These format in the runtime's local timezone, which
// on the server is the SERVER's — wrong for every viewer elsewhere. Server
// components use <LocalDateTime> from components/common/local-datetime.
export function formatTicketDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTicketDateTime(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type AssignableAgent = {
  id: string;
  name: string | null;
  email: string;
};

/** Options for an assignee picker. Agent lists are filtered to active users, so a
 * ticket held by a since-deactivated agent would have no matching option and read
 * as unassigned. Appending the current assignee fixes the label; it appears only
 * while already selected, so nobody can pick a deactivated agent afresh. */
export function buildAssigneeOptions(
  agents: AssignableAgent[],
  assignedAgentId: string | null,
  assignedAgentName?: string | null
): { label: string; value: string }[] {
  const options = [
    { value: "unassigned", label: "Unassigned" },
    ...agents.map((a) => ({ value: a.id, label: a.name ?? a.email })),
  ];

  if (assignedAgentId && !agents.some((a) => a.id === assignedAgentId)) {
    options.push({
      value: assignedAgentId,
      label: `${assignedAgentName?.trim() || "Former agent"} (deactivated)`,
    });
  }

  return options;
}
