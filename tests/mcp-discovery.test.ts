import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// If a stub ever touched the database, settings or env, these would throw.
vi.mock("@/lib/db", () => {
  throw new Error("the discovery stubs must not touch the database");
});
vi.mock("@/lib/settings", () => {
  throw new Error("the discovery stubs must not read settings");
});

import { GET as authServerGet } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route";
import { GET as resourceGet } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";

const EXPECTED = {
  error: "This server does not support OAuth. Use a personal access token.",
};

// The optional catch-all means Next also routes /.well-known/<doc>/<suffix>.
const SUFFIXES: string[][] = [[], ["api", "mcp"], ["api"], ["a", "b", "c"]];

function call(get: () => Response, name: string, suffix: string[]): Response {
  const url = `http://localhost:3000/.well-known/${[name, ...suffix].join("/")}`;
  const withContext = get as unknown as (r: Request, c: unknown) => Response;
  return withContext(new Request(url), {
    params: Promise.resolve({ path: suffix.length ? suffix : undefined }),
  });
}

describe("OAuth discovery stubs", () => {
  for (const [name, GET] of [
    ["oauth-protected-resource", resourceGet],
    ["oauth-authorization-server", authServerGet],
  ] as const) {
    for (const suffix of SUFFIXES) {
      it(`${name}/${suffix.join("/")} answers 404 with a fixed body`, async () => {
        const res = call(GET, name, suffix);
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(await res.json()).toEqual(EXPECTED);
      });
    }
  }

  it("answer identically for both documents", async () => {
    const a = resourceGet();
    const b = authServerGet();
    expect(await a.text()).toBe(await b.text());
    expect(a.status).toBe(b.status);
  });

  for (const file of [
    "app/.well-known/oauth-protected-resource/[[...path]]/route.ts",
    "app/.well-known/oauth-authorization-server/[[...path]]/route.ts",
  ]) {
    it(`${file} imports nothing from the app`, () => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/^\s*import\s/m);
      expect(source).not.toMatch(/from\s+["']/);
      expect(source).not.toMatch(/require\(/);
      expect(source).not.toMatch(/@\//);
      expect(source).not.toMatch(/lib\//);
    });
  }
});
