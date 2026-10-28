import { describe, expect, it } from "vitest";
import { resolveShowSlaAndOverduePref } from "@/lib/sla-display-pref";

// The ticket list's SLA column (app/(agent)/tickets/_components/ticket-row.tsx)
// delegates to this resolver to decide whether to render the SLA/overdue
// badges alongside the waiting-time badge.

describe("resolveShowSlaAndOverduePref", () => {
  it("defaults to true (SLA/overdue shown) when the agent has no saved preference row yet", () => {
    // Existing users/installs predating this preference must see unchanged
    // behavior — SLA/overdue information stays visible until turned off.
    expect(resolveShowSlaAndOverduePref(undefined)).toBe(true);
  });

  it("respects a saved true value", () => {
    expect(resolveShowSlaAndOverduePref({ showSlaAndOverdue: true })).toBe(
      true
    );
  });

  it("respects a saved false value", () => {
    expect(resolveShowSlaAndOverduePref({ showSlaAndOverdue: false })).toBe(
      false
    );
  });
});
