import { describe, expect, it } from "vitest";
import { verifyFileSignature } from "@/lib/file-access";
import { groupCustomerAttachments } from "@/lib/tickets/customer-attachments";

const NOW = Date.UTC(2026, 9, 28, 10, 30);

const rows = [
  { id: "a-desc", commentId: null, storageKey: "tickets/t1/desc.png" },
  { id: "a-pub", commentId: "c-public", storageKey: "tickets/t1/pub.pdf" },
  { id: "a-int", commentId: "c-internal", storageKey: "tickets/t1/int.pdf" },
];

function valid(url: string, key: string, nowMs: number) {
  const u = new URL(url, "http://localhost");
  return verifyFileSignature(
    key,
    u.searchParams.get("exp"),
    u.searchParams.get("sig"),
    nowMs
  );
}

describe("groupCustomerAttachments", () => {
  it("links description and public-comment files only", () => {
    const { ticketLevel, byComment } = groupCustomerAttachments(
      rows,
      new Set(["c-public"]),
      NOW
    );
    expect(ticketLevel.map((a) => a.id)).toEqual(["a-desc"]);
    expect([...byComment.keys()]).toEqual(["c-public"]);
    expect(byComment.get("c-public")?.map((a) => a.id)).toEqual(["a-pub"]);
    expect(byComment.has("c-internal")).toBe(false);
  });

  it("never mints a link for an internal note's attachment", () => {
    const result = groupCustomerAttachments(rows, new Set(["c-public"]), NOW);
    const everything = JSON.stringify({
      ticketLevel: result.ticketLevel,
      byComment: [...result.byComment.entries()],
    });
    expect(everything).not.toContain("int.pdf");
    expect(everything).not.toContain("a-int");
  });

  it("mints links that verify for their own key", () => {
    const { ticketLevel, byComment } = groupCustomerAttachments(
      rows,
      new Set(["c-public"]),
      NOW
    );
    expect(valid(ticketLevel[0].url, "tickets/t1/desc.png", NOW)).toBe(true);
    const pub = byComment.get("c-public")?.[0];
    expect(pub && valid(pub.url, "tickets/t1/pub.pdf", NOW)).toBe(true);
    expect(pub && valid(pub.url, "tickets/t1/int.pdf", NOW)).toBe(false);
  });

  it("gives a later render fresh links that work after the old ones expire", () => {
    const first = groupCustomerAttachments(rows, new Set(), NOW).ticketLevel[0];
    const later = NOW + 3 * 60 * 60 * 1000;
    const again = groupCustomerAttachments(rows, new Set(), later)
      .ticketLevel[0];
    expect(again.url).not.toBe(first.url);
    expect(valid(first.url, "tickets/t1/desc.png", later)).toBe(false);
    expect(valid(again.url, "tickets/t1/desc.png", later)).toBe(true);
  });
});
