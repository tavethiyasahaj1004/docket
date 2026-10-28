import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ⚠ CLIENT COMPONENTS ONLY — formats in the runtime's local timezone; in
// server components use <LocalDateTime> from components/common/local-datetime.
export function formatDateTime(value: Date | string | null | undefined) {
  if (!value) {
    return "Never"
  }
  const date = typeof value === "string" ? new Date(value) : value
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

/** Stable keys for fixed-length placeholder loops (loading skeletons), which trip
 * `noArrayIndexKey` even though a skeleton has no data, never reorders, and is
 * replaced wholesale — so mapping real strings keeps the rule meaningful where it
 * matters. Do NOT use for data-driven lists; key those on the record's own id. */
export function skeletonKeys(count: number, prefix = "sk"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`)
}

/** First letters of the first two words, e.g. "John Doe" → "JD". */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.trim().slice(0, 2).toUpperCase()
}
