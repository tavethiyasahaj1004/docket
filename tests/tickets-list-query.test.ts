import { describe, expect, it } from "vitest";
import {
  parseTicketListSort,
  parseTicketView,
  ticketMatchesView,
} from "@/lib/tickets-list-query";

const OPEN_SLUGS = ["open", "in_progress"];

describe("parseTicketView", () => {
  it("recognizes the awaiting tab", () => {
    expect(parseTicketView({ view: "awaiting" })).toBe("awaiting");
  });

  it("recognizes the open tab", () => {
    expect(parseTicketView({ view: "open" })).toBe("open");
  });

  it("returns null when unset — the unrestricted default list", () => {
    expect(parseTicketView({})).toBeNull();
  });

  it("returns null for an unrecognized value", () => {
    expect(parseTicketView({ view: "closed" })).toBeNull();
  });
});

describe("ticketMatchesView — All Open Tickets", () => {
  it("includes a ticket in a non-closed status", () => {
    expect(
      ticketMatchesView(
        "open",
        { status: "open", awaitingReply: false },
        OPEN_SLUGS
      )
    ).toBe(true);
  });

  it("includes a non-closed ticket regardless of awaitingReply", () => {
    expect(
      ticketMatchesView(
        "open",
        { status: "in_progress", awaitingReply: false },
        OPEN_SLUGS
      )
    ).toBe(true);
  });

  it("excludes a closed/resolved ticket", () => {
    expect(
      ticketMatchesView(
        "open",
        { status: "closed", awaitingReply: false },
        OPEN_SLUGS
      )
    ).toBe(false);
  });
});

describe("ticketMatchesView — Awaiting Our Reply", () => {
  it("includes an open ticket currently awaiting an agent reply", () => {
    expect(
      ticketMatchesView(
        "awaiting",
        { status: "open", awaitingReply: true },
        OPEN_SLUGS
      )
    ).toBe(true);
  });

  it("excludes an open ticket not awaiting a reply (awaiting the customer instead)", () => {
    expect(
      ticketMatchesView(
        "awaiting",
        { status: "open", awaitingReply: false },
        OPEN_SLUGS
      )
    ).toBe(false);
  });

  it("excludes a closed ticket even if awaitingReply is stale-true", () => {
    // A generic status-change route only sets closedAt, not awaitingReply —
    // so a closed ticket can retain awaitingReply = true. It must still be
    // excluded from this view.
    expect(
      ticketMatchesView(
        "awaiting",
        { status: "closed", awaitingReply: true },
        OPEN_SLUGS
      )
    ).toBe(false);
  });

  it("a ticket that moves from awaiting our reply to awaiting the customer disappears from this view", () => {
    const beforeReply = { status: "open", awaitingReply: true };
    const afterReply = { status: "open", awaitingReply: false };
    expect(ticketMatchesView("awaiting", beforeReply, OPEN_SLUGS)).toBe(true);
    expect(ticketMatchesView("awaiting", afterReply, OPEN_SLUGS)).toBe(false);
    // ...but it's still open, so it remains in the other view.
    expect(ticketMatchesView("open", afterReply, OPEN_SLUGS)).toBe(true);
  });
});

describe("parseTicketListSort", () => {
  it("defaults to updatedAt/desc when unset", () => {
    expect(parseTicketListSort({})).toEqual({
      sortKey: "updatedAt",
      sortOrder: "desc",
    });
  });

  it("recognizes the id sort key", () => {
    expect(parseTicketListSort({ sort: "id", order: "asc" })).toEqual({
      sortKey: "id",
      sortOrder: "asc",
    });
  });

  it("recognizes the waitingTime sort key", () => {
    expect(parseTicketListSort({ sort: "waitingTime", order: "asc" })).toEqual({
      sortKey: "waitingTime",
      sortOrder: "asc",
    });
  });

  it("falls back to updatedAt for an unrecognized sort value", () => {
    expect(parseTicketListSort({ sort: "customer" })).toEqual({
      sortKey: "updatedAt",
      sortOrder: "desc",
    });
  });

  it("falls back to desc for an unrecognized order value", () => {
    expect(
      parseTicketListSort({ sort: "waitingTime", order: "sideways" })
    ).toEqual({
      sortKey: "waitingTime",
      sortOrder: "desc",
    });
  });
});
