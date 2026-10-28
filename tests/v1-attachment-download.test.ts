import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// One attachment row as the route's select returns it (after the comment join).
type Row = {
  filename: string;
  storageKey: string;
  mimeType: string;
  commentId: string | null;
  commentIsInternal: boolean | null;
};

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  download: vi.fn(),
  rows: [] as unknown[],
  calls: [] as string[],
}));

vi.mock("@/lib/api-auth", () => ({ requireApiKey: mocks.requireApiKey }));
vi.mock("@/lib/storage", () => ({
  storage: { download: mocks.download, upload: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/db", () => {
  // A chainable stand-in for db.select().from().leftJoin().where().limit().
  const chain: Record<string, unknown> = {};
  for (const step of ["select", "from", "leftJoin", "where"]) {
    chain[step] = (..._args: unknown[]) => {
      mocks.calls.push(step);
      return chain;
    };
  }
  chain.limit = () => {
    mocks.calls.push("limit");
    return Promise.resolve(mocks.rows);
  };
  return { db: chain };
});

import { GET } from "@/app/api/v1/tickets/[id]/attachments/[attachmentId]/route";
import { isApiVisibleAttachment } from "@/lib/tickets/api-attachments";

const FILE = Buffer.from("file-bytes");

function row(overrides: Partial<Row>): Row {
  return {
    filename: "screenshot.png",
    storageKey: "tickets/t1/abc.png",
    mimeType: "image/png",
    commentId: null,
    commentIsInternal: null,
    ...overrides,
  };
}

function call(ticketId = "t1", attachmentId = "a1") {
  const request = new NextRequest(
    `http://localhost/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    { headers: { Authorization: "Bearer dk_live_test" } }
  );
  return GET(request, {
    params: Promise.resolve({ id: ticketId, attachmentId }),
  });
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.text()).toBe(
    JSON.stringify({ error: "Attachment not found." })
  );
}

beforeEach(() => {
  mocks.requireApiKey.mockReset().mockResolvedValue({ id: "key1" });
  mocks.download.mockReset().mockResolvedValue(FILE);
  mocks.rows = [];
  mocks.calls = [];
});

describe("isApiVisibleAttachment", () => {
  it("serves description attachments (no comment)", () => {
    expect(
      isApiVisibleAttachment({ commentId: null, commentIsInternal: null })
    ).toBe(true);
  });

  it("serves attachments on public replies", () => {
    expect(
      isApiVisibleAttachment({ commentId: "c1", commentIsInternal: false })
    ).toBe(true);
  });

  it("hides attachments on internal notes", () => {
    expect(
      isApiVisibleAttachment({ commentId: "c1", commentIsInternal: true })
    ).toBe(false);
  });

  it("hides an attachment whose comment wasn't found", () => {
    expect(
      isApiVisibleAttachment({ commentId: "c1", commentIsInternal: null })
    ).toBe(false);
  });
});

describe("GET /api/v1/tickets/:id/attachments/:attachmentId", () => {
  it("streams a public-reply attachment with the existing headers", async () => {
    mocks.rows = [row({ commentId: "c1", commentIsInternal: false })];
    const res = await call();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FILE);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="screenshot.png"'
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(mocks.download).toHaveBeenCalledWith("tickets/t1/abc.png");
  });

  it("streams a description attachment", async () => {
    mocks.rows = [row({ commentId: null, commentIsInternal: null })];
    const res = await call();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FILE);
  });

  it("answers an internal-note attachment exactly like an unknown id", async () => {
    mocks.rows = [row({ commentId: "c9", commentIsInternal: true })];
    const internal = await call();
    await expectNotFound(internal);
    expect(mocks.download).not.toHaveBeenCalled();

    mocks.rows = [];
    const unknown = await call("t1", "does-not-exist");
    await expectNotFound(unknown);
  });

  it("keeps an internal-note attachment hidden after its ticket was merged", async () => {
    // Merge re-points the attachment at the target ticket but keeps its comment,
    // so the row still carries the internal note. The path names the target.
    mocks.rows = [row({ commentId: "c9", commentIsInternal: true })];
    await expectNotFound(await call("merge-target", "a1"));
    // And under the old (source) ticket id too, which the route never checks.
    await expectNotFound(await call("merge-source", "a1"));
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("keeps a merged source's description attachment downloadable", async () => {
    // Merge turns the source's description into a public customer comment.
    mocks.rows = [row({ commentId: "desc-comment", commentIsInternal: false })];
    const res = await call("merge-target", "a1");
    expect(res.status).toBe(200);
  });

  it("looks the comment up in the same query", async () => {
    mocks.rows = [row({})];
    await call();
    expect(mocks.calls).toEqual([
      "select",
      "from",
      "leftJoin",
      "where",
      "limit",
    ]);
  });

  it("returns the API-key failure unchanged and reads nothing", async () => {
    const unauthorized = new Response(
      JSON.stringify({ error: "Invalid API key." }),
      { status: 401 }
    );
    mocks.requireApiKey.mockRejectedValue(unauthorized);
    const res = await call();
    expect(res).toBe(unauthorized);
    expect(mocks.calls).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("still reports a visible attachment missing from storage as before", async () => {
    mocks.rows = [row({ commentId: "c1", commentIsInternal: false })];
    mocks.download.mockRejectedValue(new Error("ENOENT"));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: "File not found." }));
  });
});
