import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICKET_ACTION_SETTINGS,
  pickTicketActionSettings,
  TICKET_ACTION_SETTING_KEYS,
} from "@/lib/ticket-actions";

describe("pickTicketActionSettings", () => {
  it("defaults everything on when there's no settings row", () => {
    expect(pickTicketActionSettings(undefined)).toEqual(
      DEFAULT_TICKET_ACTION_SETTINGS
    );
    for (const key of TICKET_ACTION_SETTING_KEYS) {
      expect(DEFAULT_TICKET_ACTION_SETTINGS[key]).toBe(true);
    }
  });

  it("keeps stored values, including false", () => {
    const picked = pickTicketActionSettings({
      ticketMergeEnabled: false,
      ticketLinkNotificationsEnabled: false,
    });
    expect(picked.ticketMergeEnabled).toBe(false);
    expect(picked.ticketLinkNotificationsEnabled).toBe(false);
    expect(picked.ticketSplitEnabled).toBe(true);
  });

  it("ignores unrelated fields and nulls", () => {
    const picked = pickTicketActionSettings({
      ticketSplitEnabled: null,
      theme: "ocean",
    } as never);
    expect(picked).toEqual(DEFAULT_TICKET_ACTION_SETTINGS);
  });
});
