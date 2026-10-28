// Client-safe (no DB imports) — shared by the settings API, the admin form,
// and the merge/split/link routes. Stored on `platform_settings`.

export const TICKET_ACTION_SETTING_KEYS = [
  "ticketMergeEnabled",
  "ticketMergeNotificationsEnabled",
  "ticketMergeCustomerEmailEnabled",
  "ticketSplitEnabled",
  "ticketSplitNotificationsEnabled",
  "ticketLinkEnabled",
  "ticketLinkNotificationsEnabled",
] as const;

export type TicketActionSettingKey =
  (typeof TICKET_ACTION_SETTING_KEYS)[number];
export type TicketActionSettings = Record<TicketActionSettingKey, boolean>;

/** Everything on — a fresh install (no settings row) behaves as before the
 * switches existed. */
export const DEFAULT_TICKET_ACTION_SETTINGS: TicketActionSettings = {
  ticketMergeEnabled: true,
  ticketMergeNotificationsEnabled: true,
  ticketMergeCustomerEmailEnabled: true,
  ticketSplitEnabled: true,
  ticketSplitNotificationsEnabled: true,
  ticketLinkEnabled: true,
  ticketLinkNotificationsEnabled: true,
};

/** The ticket-action switches from a settings row, defaulting missing ones. */
export function pickTicketActionSettings(
  row: Partial<Record<TicketActionSettingKey, boolean | null>> | undefined
): TicketActionSettings {
  const result = { ...DEFAULT_TICKET_ACTION_SETTINGS };
  for (const key of TICKET_ACTION_SETTING_KEYS) {
    const value = row?.[key];
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

/** 403 message when an agent tries an action an admin switched off. */
export const TICKET_ACTION_DISABLED_MESSAGES = {
  merge: "Merging tickets is turned off by an admin.",
  split: "Splitting replies is turned off by an admin.",
  link: "Linking tickets is turned off by an admin.",
} as const;
