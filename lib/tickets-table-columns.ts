// Single source of truth for the /tickets table's customizable columns.
// Checkbox / "#" / Subject are pinned in the table and not part of this list.
export const CUSTOMIZABLE_COLUMNS = [
  { id: "status", label: "Status", width: "w-36" },
  { id: "category", label: "Category", width: "w-36" },
  { id: "priority", label: "Priority", width: "w-32" },
  { id: "waitingTime", label: "Waiting Time", width: "w-48" },
  { id: "customer", label: "Customer", width: "w-40" },
  { id: "assigned", label: "Assigned", width: "w-36" },
  { id: "tags", label: "Tags", width: "w-40" },
  { id: "updatedBy", label: "Updated By", width: "w-32" },
  { id: "updatedAt", label: "Updated", width: "w-28" },
] as const;

export type TicketColumnId = (typeof CUSTOMIZABLE_COLUMNS)[number]["id"];

export type ColumnPref = { id: TicketColumnId; visible: boolean };

const KNOWN_IDS = new Set<string>(CUSTOMIZABLE_COLUMNS.map((c) => c.id));

export const DEFAULT_COLUMN_PREFS: ColumnPref[] = CUSTOMIZABLE_COLUMNS.map(
  (c) => ({ id: c.id, visible: true })
);

/** Merges saved prefs with the known column set: drops unknown or malformed
 * entries, then appends any known column the saved list doesn't mention — one
 * added since the user last saved — as visible, at the end. */
export function resolveColumnPrefs(saved: unknown): ColumnPref[] {
  const result: ColumnPref[] = [];
  const seen = new Set<string>();

  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string" &&
        KNOWN_IDS.has((entry as { id: string }).id) &&
        !seen.has((entry as { id: string }).id)
      ) {
        const id = (entry as { id: TicketColumnId }).id;
        const visible = (entry as { visible?: unknown }).visible !== false;
        result.push({ id, visible });
        seen.add(id);
      }
    }
  }

  for (const col of CUSTOMIZABLE_COLUMNS) {
    if (!seen.has(col.id)) {
      result.push({ id: col.id, visible: true });
    }
  }

  return result;
}
