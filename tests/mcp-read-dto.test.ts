import { describe, expect, it } from "vitest";
import { FORBIDDEN_OUTPUT_PATTERNS } from "@/lib/mcp/dto";
import {
  ACTIVITY_METADATA_ALLOWLIST,
  buildConfigLabels,
  toActivityItemDto,
  toActivityMetadata,
  toAttachmentDto,
  toBodyDto,
  toMessageItemDto,
  toTicketSummaryDto,
} from "@/lib/mcp/read-dto";

const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

describe("toBodyDto", () => {
  it("flattens Tiptap JSON and never returns the raw document", () => {
    const dto = toBodyDto(doc("Hello there"), 2000);
    expect(dto).toEqual({
      body: "Hello there",
      truncated: false,
      fullLength: 11,
    });
    expect(JSON.stringify(dto)).not.toContain('"type":"doc"');
  });

  it("passes legacy plain text through", () => {
    expect(toBodyDto("just text", 2000).body).toBe("just text");
  });

  it("cuts at maxChars and reports the full length", () => {
    const dto = toBodyDto(doc("a".repeat(500)), 200);
    expect(dto.body).toHaveLength(200);
    expect(dto).toMatchObject({ truncated: true, fullLength: 500 });
  });

  it("does not truncate a body of exactly maxChars", () => {
    const dto = toBodyDto("b".repeat(200), 200);
    expect(dto).toMatchObject({ truncated: false, fullLength: 200 });
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(199)}\u{1F600}tail`;
    const dto = toBodyDto(text, 200);
    expect(dto.body).toBe("a".repeat(199));
    expect(dto.truncated).toBe(true);
    // No lone surrogate survives.
    expect(dto.body).not.toMatch(/[\ud800-\udfff]/);
  });

  it("handles an empty body", () => {
    expect(toBodyDto("", 200)).toEqual({
      body: "",
      truncated: false,
      fullLength: 0,
    });
  });
});

describe("toActivityMetadata", () => {
  it("keeps only allowlisted keys per action", () => {
    expect(
      toActivityMetadata("status_changed", {
        from: "open",
        to: "closed",
        email: "x@y.test",
        token: "secret",
      })
    ).toEqual({ from: "open", to: "closed" });
    expect(
      toActivityMetadata("custom_field_changed", {
        field: "Plan",
        from: "free",
        to: "pro",
      })
    ).toEqual({ field: "Plan" });
    expect(
      toActivityMetadata("tag_added", { tag: "vip", url: "https://x/?token=1" })
    ).toEqual({ tag: "vip" });
    expect(
      toActivityMetadata("ticket_linked", {
        type: "blocks",
        direction: "outgoing",
        ticketNumber: 7,
        body: "no",
      })
    ).toEqual({ type: "blocks", direction: "outgoing", ticketNumber: 7 });
  });

  it("drops everything for actions without an allowlist entry", () => {
    expect(toActivityMetadata("comment_added", { body: "x" })).toBeNull();
    expect(toActivityMetadata("something_new", { a: 1 })).toBeNull();
    expect(toActivityMetadata("constructor", { a: 1 })).toBeNull();
    expect(toActivityMetadata("__proto__", { a: 1 })).toBeNull();
  });

  it("ignores non-scalar and missing values and non-object metadata", () => {
    expect(
      toActivityMetadata("assigned", { agentId: { nested: true } })
    ).toBeNull();
    expect(toActivityMetadata("assigned", null)).toBeNull();
    expect(toActivityMetadata("assigned", "text")).toBeNull();
    expect(toActivityMetadata("assigned", { agentId: "u1" })).toEqual({
      agentId: "u1",
    });
  });

  it("caps long values", () => {
    const out = toActivityMetadata("tag_added", { tag: "t".repeat(500) });
    expect(out?.tag).toHaveLength(200);
  });

  it("allowlists no key that could carry contact details, secrets or bodies", () => {
    const banned = /mail|token|secret|body|content|url|key|password|note/i;
    for (const keys of Object.values(ACTIVITY_METADATA_ALLOWLIST)) {
      for (const key of keys) {
        expect(key).not.toMatch(banned);
      }
    }
  });
});

const labels = buildConfigLabels({
  statuses: [
    { slug: "open", label: "Open", isClosedState: false },
    { slug: "closed", label: "Closed", isClosedState: true },
  ],
  priorities: [{ slug: "high", label: "High" }],
  categories: [{ slug: "bug", label: "Bug" }],
});

describe("DTO outputs carry no forbidden field", () => {
  const summary = toTicketSummaryDto(
    {
      id: "t1",
      ticketNumber: 12,
      subject: "Hello",
      status: "closed",
      priority: "high",
      category: "bug",
      customerId: "c1",
      customerName: "Ann",
      assignedAgentId: "u1",
      assigneeName: "Alice",
      awaitingReply: false,
      pendingReplies: 0,
      tags: ["vip"],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      closedAt: new Date("2026-01-03T00:00:00Z"),
      // Fields a careless spread would leak: they are not in the input type.
      ...({
        customerToken: "tok",
        customerEmail: "ann@example.test",
        storageKey: "k",
        apiKeyId: "ak",
        description: doc("body"),
      } as object),
    },
    labels,
    "https://docket.example.test/"
  );

  it("shapes a summary from named fields only", () => {
    expect(summary).toEqual({
      id: "t1",
      number: 12,
      subject: "Hello",
      status: { slug: "closed", label: "Closed", isClosed: true },
      priority: { slug: "high", label: "High" },
      category: { slug: "bug", label: "Bug" },
      customer: { id: "c1", name: "Ann" },
      assignee: { id: "u1", name: "Alice" },
      awaitingReply: false,
      pendingReplies: 0,
      tags: ["vip"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: "2026-01-03T00:00:00.000Z",
      agentUrl: "https://docket.example.test/tickets/12",
    });
  });

  it("scans clean for every forbidden pattern", () => {
    const attachment = toAttachmentDto({
      id: "a1",
      filename: "f.pdf",
      mimeType: "application/pdf",
      fileSize: 5,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      ...({ storageKey: "tickets/x/y.pdf" } as object),
    });
    const message = toMessageItemDto(
      {
        id: "c1",
        authorName: "Ann",
        authorRole: "customer",
        content: doc("hi"),
        isInternal: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        ...({ authorId: "u9" } as object),
      },
      [
        {
          id: "a1",
          filename: "f.pdf",
          mimeType: "application/pdf",
          fileSize: 5,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          ...({ storageKey: "tickets/x/y.pdf" } as object),
        },
      ],
      2000
    );
    const activity = toActivityItemDto({
      id: "x1",
      action: "status_changed",
      actorName: "Alice",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      metadata: { from: "a", to: "b", email: "e@x.test" },
    });
    const text = JSON.stringify({ summary, attachment, message, activity });
    for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
      if (typeof pattern === "string") {
        expect(text).not.toContain(pattern);
      } else {
        expect(text).not.toMatch(pattern);
      }
    }
    expect(text).not.toContain("tickets/x/y.pdf");
    expect(text).not.toContain("e@x.test");
    expect(text).not.toContain("ann@example.test");
    expect(Object.keys(attachment).sort()).toEqual([
      "createdAt",
      "fileSize",
      "filename",
      "id",
      "mimeType",
    ]);
  });

  it("labels messages public or internal", () => {
    const base = {
      id: "c1",
      authorName: "A",
      authorRole: "agent",
      content: "x",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(
      toMessageItemDto({ ...base, isInternal: true }, [], 200).visibility
    ).toBe("internal");
    expect(
      toMessageItemDto({ ...base, isInternal: false }, [], 200).visibility
    ).toBe("public");
  });

  it("falls back to the slug when config no longer has a label", () => {
    const dto = toTicketSummaryDto(
      {
        id: "t",
        ticketNumber: 1,
        subject: "s",
        status: "gone",
        priority: "gone",
        category: "gone",
        customerId: "c",
        customerName: "n",
        assignedAgentId: null,
        assigneeName: null,
        awaitingReply: false,
        pendingReplies: 0,
        tags: [],
        createdAt: new Date(0),
        updatedAt: new Date(0),
        closedAt: null,
      },
      labels,
      "http://localhost:3000"
    );
    expect(dto.status).toEqual({
      slug: "gone",
      label: "gone",
      isClosed: false,
    });
    expect(dto.assignee).toBeNull();
    expect(dto.closedAt).toBeNull();
  });
});
