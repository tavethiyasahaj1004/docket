import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real lib/storage.ts runs for each driver; only its backends are faked:
// the local disk (node:fs/promises) and files-sdk's s3/r2 adapters.
const mocks = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  backendReads: [] as string[],
  driver: "local" as "local" | "s3" | "r2",
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("@/lib/integration-settings", () => ({
  getStorageSettings: () => {
    if (mocks.driver === "s3") {
      return Promise.resolve({
        driver: "s3",
        bucket: "b",
        region: "eu-west-1",
      });
    }
    if (mocks.driver === "r2") {
      return Promise.resolve({ driver: "r2", bucket: "b", accountId: "acc" });
    }
    return Promise.resolve({ driver: "local" });
  },
}));

vi.mock("node:fs/promises", () => {
  const uploads = path.join(process.cwd(), "uploads");
  const readFile = (p: string) => {
    const key = path.relative(uploads, p).split(path.sep).join("/");
    mocks.backendReads.push(`local:${key}`);
    const buf = mocks.files.get(key);
    return buf
      ? Promise.resolve(buf)
      : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  };
  const noop = () => Promise.resolve();
  return {
    default: { readFile, writeFile: noop, mkdir: noop, unlink: noop },
  };
});

vi.mock("files-sdk", () => ({
  Files: class {
    adapter: { kind: string };
    constructor(opts: { adapter: { kind: string } }) {
      this.adapter = opts.adapter;
    }
    download(key: string) {
      mocks.backendReads.push(`${this.adapter.kind}:${key}`);
      const buf = mocks.files.get(key);
      return buf
        ? Promise.resolve(new Blob([new Uint8Array(buf)]))
        : Promise.reject(new Error("NoSuchKey"));
    }
  },
}));
vi.mock("files-sdk/s3", () => ({ s3: () => ({ kind: "s3" }) }));
vi.mock("files-sdk/r2", () => ({ r2: () => ({ kind: "r2" }) }));

import { GET } from "@/app/api/files/[...key]/route";
import { signFileUrl } from "@/lib/file-access";

const TICKET_KEY = "tickets/t1/abc123.png";
const MISSING_KEY = "tickets/t1/missing.png";
const BRANDING_KEY = "branding/logo-x.png";
const BYTES = Buffer.from("png-bytes");
const NOT_FOUND_BODY = JSON.stringify({ error: "File not found" });

const at = (h: number, m = 0, s = 0, ms = 0) =>
  Date.UTC(2026, 9, 28, h, m, s, ms);

function request(url: string) {
  const u = new URL(url, "http://localhost");
  const segments = u.pathname
    .replace(/^\/api\/files\//, "")
    .split("/")
    .map(decodeURIComponent);
  return GET(new NextRequest(u, { headers: { Cookie: "session=x" } }), {
    params: Promise.resolve({ key: segments }),
  });
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.text()).toBe(NOT_FOUND_BODY);
}

const asStaff = (role: string, banned = false) =>
  mocks.getSession.mockResolvedValue({
    user: { id: "u1", role, banned },
    session: { id: "s1" },
  });

beforeEach(() => {
  mocks.files.clear();
  mocks.files.set(TICKET_KEY, BYTES);
  mocks.files.set(BRANDING_KEY, BYTES);
  mocks.backendReads = [];
  mocks.getSession.mockReset().mockResolvedValue(null);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(10, 30));
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  "local",
  "s3",
  "r2",
] as const)("/api/files on the %s driver", (driver) => {
  beforeEach(() => {
    mocks.driver = driver;
  });

  it("serves a valid signed link, cacheable privately", async () => {
    const res = await request(signFileUrl(TICKET_KEY));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(mocks.backendReads).toEqual([`${driver}:${TICKET_KEY}`]);
  });

  it("refuses a signed link from the end of the next clock hour", async () => {
    vi.setSystemTime(at(10, 59));
    const url = signFileUrl(TICKET_KEY);
    vi.setSystemTime(at(11, 59, 59, 999));
    expect((await request(url)).status).toBe(200);
    vi.setSystemTime(at(12, 0, 0, 0));
    await expectNotFound(await request(url));
  });

  it("refuses an expired link without touching storage", async () => {
    const url = signFileUrl(TICKET_KEY);
    vi.setSystemTime(at(14));
    mocks.backendReads = [];
    await expectNotFound(await request(url));
    expect(mocks.backendReads).toEqual([]);
  });

  it("refuses a tampered signature", async () => {
    const url = signFileUrl(TICKET_KEY).replace(
      /sig=(.)/,
      (_m, c) => `sig=${c === "A" ? "B" : "A"}`
    );
    await expectNotFound(await request(url));
    expect(mocks.backendReads).toEqual([]);
  });

  it("refuses a link signed for another file", async () => {
    const other = signFileUrl("tickets/t1/other.png");
    const query = other.slice(other.indexOf("?"));
    await expectNotFound(await request(`/api/files/${TICKET_KEY}${query}`));
  });

  it("refuses an unsigned ticket file without a session", async () => {
    await expectNotFound(await request(`/api/files/${TICKET_KEY}`));
    expect(mocks.backendReads).toEqual([]);
  });

  it.each([
    "agent",
    "admin",
  ])("serves an unsigned ticket file to a signed-in %s, not cached", async (role) => {
    asStaff(role);
    const res = await request(`/api/files/${TICKET_KEY}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("falls back to the session when a signature is invalid", async () => {
    asStaff("agent");
    const res = await request(`/api/files/${TICKET_KEY}?exp=1&sig=bad`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["a non-staff (user-role) session", () => asStaff("user")],
    ["an empty role", () => asStaff("")],
    ["a banned agent", () => asStaff("agent", true)],
    ["a banned admin", () => asStaff("admin", true)],
    [
      "a failing session lookup",
      () => mocks.getSession.mockRejectedValue(new Error("db down")),
    ],
  ])("refuses an unsigned ticket file for %s", async (_label, setup) => {
    setup();
    await expectNotFound(await request(`/api/files/${TICKET_KEY}`));
    expect(mocks.backendReads).toEqual([]);
  });

  it("answers a missing file exactly like a refusal", async () => {
    const refused = await request(`/api/files/${MISSING_KEY}`);
    const signedMissing = await request(signFileUrl(MISSING_KEY));
    asStaff("agent");
    const staffMissing = await request(`/api/files/${MISSING_KEY}`);
    for (const res of [refused, signedMissing, staffMissing]) {
      await expectNotFound(res);
    }
  });

  it("serves branding files publicly, with no session lookup", async () => {
    const res = await request(`/api/files/${BRANDING_KEY}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("answers a missing branding file with the same 404", async () => {
    await expectNotFound(await request("/api/files/branding/none.png"));
  });

  it.each([
    [["tickets", "..", "..", "etc", "passwd"]],
    [["branding", "..", "tickets", "t1", "abc123.png"]],
    [["tickets", "t1", "..", "..", "..", "secret"]],
    [["tickets", "t1/../../x", "y"]],
    [["tickets", "t1", "..\\..\\x"]],
    [["tickets", "", "abc123.png"]],
    [["uploads", "abc123.png"]],
    [["tickets"]],
  ])("refuses the malformed path %j before any lookup", async (segments) => {
    asStaff("admin");
    const res = await GET(
      new NextRequest("http://localhost/api/files/x", {
        headers: { Cookie: "session=x" },
      }),
      { params: Promise.resolve({ key: segments }) }
    );
    await expectNotFound(res);
    expect(mocks.backendReads).toEqual([]);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("never marks a response public", async () => {
    asStaff("agent");
    const responses = [
      await request(signFileUrl(TICKET_KEY)),
      await request(`/api/files/${TICKET_KEY}`),
      await request(`/api/files/${BRANDING_KEY}`),
    ];
    for (const res of responses) {
      expect(res.headers.get("cache-control") ?? "").not.toContain("public");
    }
  });
});
